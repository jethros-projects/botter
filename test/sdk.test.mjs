import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient, BotterClient, BotterError, createAuthManager } from '../src/index.mjs';
import { ApiError } from '../src/advanced.mjs';
import { main } from '../src/cli.mjs';
import { cliTransport } from '../src/sdk.mjs';

const bot = { agentId: 'bot-uuid', name: 'Example', viewerSessionId: 'native-session', harness: 'temporal' };
const nonce = '12345678-1234-1234-1234-123456789abc';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const row = (seq, content = 'Hello') => ({ seq, updatedSeq: seq, entryId: `message-${seq}`,
  entryKind: 'message', body: Buffer.from(JSON.stringify({ role: 'user', content, timestampMs: 1700000000000, replyTo: 'parent', streaming: false })).toString('base64') });
function transport(handler = () => ({})) {
  const calls = [];
  return { calls, async resolveBot(query, options) { calls.push({ type: 'resolve', query, options }); return typeof query === 'object' ? query : bot; },
    async listBots() { return [bot]; }, async accountFingerprint() { return 'host-account-hash'; },
    async rpc(method, body, options) { calls.push({ method, body, options }); return handler(method, body, options); },
    async *stream() {},
  };
}

test('root SDK is deliberately small and offline through construction and capabilities', async () => {
  let reads = 0;
  const raw = new Proxy({}, { get() { reads++; throw Error('credential or resource read'); } });
  const client = createClient({ transport: raw });
  assert(client instanceof BotterClient);
  assert.equal(client.capabilities().attachments.maxBytes, 5242880);
  assert.deepEqual(client.capabilities().attachments.uploadModes, ['SINGLE_PUT']);
  assert(Object.isFrozen(client.capabilities().attachments));
  assert.equal(reads, 0);
  for (const action of [
    () => client.send({ botId: 'bot', text: 'Hello', isFork: true }),
    () => client.history({ botId: 'bot', beforeSeq: 9007199254740999 }),
    () => client.upload({ botId: 'bot', path: '/missing', maxBytes: 5242881 }),
    () => client.send({ botId: 'bot', text: '', attachments: [{ remotePath: '/store/a' }] }),
    () => client.search({ botId: 'bot', query: 'word', since: '2030-01-01', until: '2020-01-01' }),
  ]) await assert.rejects(action(), { code: 'INVALID_ARGUMENT' });
  assert.equal(reads, 0);
  await client.close();
  assert.equal(reads, 0, 'caller-owned resources stay untouched');
});

test('history uses real bot/session targets and precise native sequence strings', async () => {
  const raw = transport(() => ({ entries: [row('9007199254740999'), row('9007199254740998')], generation: 4 }));
  const client = createClient({ transport: raw });
  const page = await client.history({ botId: 'Example', beforeSeq: '9007199254741000' });
  assert.equal(page.botId, bot.agentId); assert.equal(page.sessionId, 'native-session');
  assert.deepEqual(page.messages.map(message => message.seq), ['9007199254740998', '9007199254740999']);
  assert.deepEqual(page.messages[0], { ...page.entries[0], id: 'message-9007199254740998', role: 'user', replyToMessageId: 'parent', createdAt: '2023-11-14T22:13:20.000Z', streaming: false });
  assert.equal(raw.calls.find(call => call.method).body.beforeSeq, '9007199254741000');
  assert.equal('agentId' in page, false);
  await client.close();
});

test('send returns acceptance by default and preserves a receipt when status lookup fails', async () => {
  const raw = transport(method => {
    if (method === 'SendGrokBotUserMessage') return { delivery: 'ACCEPTED_TEMPORAL' };
    if (method === 'GetGrokBotSendStatus') throw Error('Bearer secret-provider-token https://storage.invalid/?token=private');
    throw Error('unexpected wait');
  });
  const client = createClient({ transport: raw });
  const result = await client.send({ botId: 'Example', text: 'Hello', messageId: nonce, attachments: [{ remotePath: '/store/notes', name: 'Notes' }] });
  assert.equal(result.botId, bot.agentId); assert.equal(result.messageId, nonce);
  assert.equal(result.statusError, 'The operation failed.'); assert.equal(result.replyPending, undefined);
  assert.deepEqual(raw.calls.filter(call => call.method).map(call => call.method), ['SendGrokBotUserMessage', 'GetGrokBotSendStatus']);
  assert.deepEqual(raw.calls.find(call => call.method === 'SendGrokBotUserMessage').body.attachmentPaths, ['/store/notes']);
  assert(!JSON.stringify(result).includes('private')); await client.close();
});

test('uncertain writes are never retried and include a generated receipt for reconciliation', async () => {
  let sends = 0;
  const client = createClient({ transport: transport(method => { if (method === 'SendGrokBotUserMessage') { sends++; throw new TypeError('network dropped token=private'); } return {}; }) });
  await assert.rejects(client.send({ botId: 'Example', text: 'Hello' }), error => {
    assert(error instanceof BotterError); assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.deliveryState, 'unknown'); assert.equal(error.receipt.botId, bot.agentId);
    assert.match(error.receipt.messageId, /^[a-f0-9-]{36}$/); assert(!error.message.includes('private')); return true;
  });
  assert.equal(sends, 1); await client.close();
});

test('cancellation while waiting retains accepted delivery and settles promptly', async () => {
  const requested = deferred();
  const raw = transport(method => {
    if (method === 'SendGrokBotUserMessage') return { delivery: 'ACCEPTED_TEMPORAL' };
    if (method === 'GetGrokBotSendStatus') return { status: 'ACCEPTED' };
    requested.resolve(); return new Promise(() => {});
  });
  const client = createClient({ transport: raw }), controller = new AbortController();
  const sending = client.send({ botId: 'Example', text: 'Hello', messageId: nonce, wait: true }, { signal: controller.signal });
  await requested.promise; controller.abort();
  await assert.rejects(sending, error => { assert.equal(error.code, 'ABORTED'); assert.equal(error.deliveryState, 'accepted'); assert.equal(error.receipt.messageId, nonce); return true; });
  await client.close();
});

test('cancellation during status lookup preserves acceptance already observed from the send', async () => {
  const requested = deferred();
  const raw = transport(method => {
    if (method === 'SendGrokBotUserMessage') return { delivery: 'ACCEPTED_TEMPORAL' };
    if (method === 'GetGrokBotSendStatus') { requested.resolve(); return new Promise(() => {}); }
    throw new Error('Unexpected request');
  });
  const client = createClient({ transport: raw }), controller = new AbortController();
  const sending = client.send({ botId: 'Example', text: 'Hello', messageId: nonce }, { signal: controller.signal });
  await requested.promise; controller.abort();
  await assert.rejects(sending, error => {
    assert.equal(error.code, 'ABORTED'); assert.equal(error.deliveryState, 'accepted');
    assert.equal(error.receipt.messageId, nonce); assert.equal(error.receipt.delivery.delivery, 'ACCEPTED_TEMPORAL'); return true;
  });
  await client.close();
});

test('request deadline cancels stalled bot resolution before mutation', async () => {
  let writes = 0;
  const raw = transport(() => { writes++; return {}; }); raw.resolveBot = async () => new Promise(() => {});
  const client = createClient({ transport: raw });
  await assert.rejects(client.send({ botId: 'Example', text: 'Hello' }, { timeoutMs: 10 }), { code: 'TIMEOUT' });
  assert.equal(writes, 0); await client.close();
});

test('close cancels auth startup and blocks late network work without logout', async () => {
  const auth = deferred(); let network = 0, logout = 0;
  const client = createClient({ authManager: { getSession: () => auth.promise, logout: async () => { logout++; } },
    fetchImpl: async () => { network++; return Response.json({ agents: [bot] }); } });
  const sending = client.send({ botId: 'Example', text: 'Hello' });
  await tick(); await client.close(); await client.close();
  await assert.rejects(sending, { code: 'CLOSED' });
  auth.resolve({ accessToken: 'private-access-token' }); await tick();
  assert.equal(network, 0); assert.equal(logout, 0);
  await assert.rejects(client.history({ botId: 'Example' }), { code: 'CLOSED' });
  await assert.rejects(client.auth.status(), { code: 'CLOSED' });
});

test('client close respects caller-owned and explicitly owned transports', async () => {
  for (const [ownsTransport, expected] of [[undefined, 0], [false, 0], [true, 1]]) {
    let closed = 0; const raw = transport(); raw.close = async () => { closed++; };
    const client = createClient({ transport: raw, ownsTransport }); await client.close(); await client.close(); assert.equal(closed, expected);
  }
});

test('CLI adapter target and account lookups receive the operation cancellation signal', async () => {
  for (const method of ['resolveBot', 'listBots', 'accountFingerprint']) {
    const raw = transport(); let signal;
    raw[method] = (...args) => {
      signal = args[method === 'resolveBot' ? 1 : 0]?.signal;
      return new Promise(() => {});
    };
    const client = createClient({ transport: raw });
    const pending = cliTransport(client)[method](...(method === 'resolveBot' ? ['Example'] : []));
    const rejection = assert.rejects(pending, { code: 'CLOSED' });
    await tick(); assert(signal instanceof AbortSignal, method);
    await client.close(); await rejection; assert.equal(signal.aborted, true, method);
  }
});

test('auth is an offline facade that reports metadata without exposing credentials', async () => {
  let reads = 0;
  const client = createClient({ authManager: { getSession: async () => ({ accessToken: 'private' }), status: async () => { reads++; return { authenticated: true, source: 'host' }; } } });
  assert.equal(reads, 0); assert.equal('getSession' in client.auth, false);
  assert.deepEqual(await client.auth.status(), { authenticated: true, source: 'host' }); assert.equal(reads, 1); await client.close();
});

test('aborted refresh never persists a late response', async () => {
  const response = deferred(); let writes = 0;
  const controller = new AbortController();
  const manager = createAuthManager({ store: { read: async () => ({ accessToken: 'expired', refreshToken: 'refresh' }), write: async () => { writes++; }, clear: async () => {} }, fetchImpl: () => response.promise });
  const refreshing = manager.getSession({ forceRefresh: true, signal: controller.signal });
  await tick(); controller.abort(); response.resolve(Response.json({ access_token: 'new-access', refresh_token: 'new-refresh' }));
  await assert.rejects(refreshing); assert.equal(writes, 0);
});

test('one cancelled auth waiter leaves a shared refresh alive for other clients', async () => {
  const response = deferred(); let writes = 0, requestSignal;
  const manager = createAuthManager({ store: { read: async () => ({ accessToken: 'expired', refreshToken: 'refresh' }), write: async () => { writes++; }, clear: async () => {} },
    fetchImpl: async (_url, options) => { requestSignal = options.signal; return response.promise; } });
  const firstController = new AbortController(), secondController = new AbortController();
  const first = manager.getSession({ signal: firstController.signal }), second = manager.getSession({ signal: secondController.signal });
  await tick(); firstController.abort(); await assert.rejects(first, { name: 'AbortError' });
  assert.equal(requestSignal.aborted, false, 'surviving caller still owns refresh');
  response.resolve(Response.json({ access_token: 'new-access', refresh_token: 'new-refresh' }));
  assert.equal((await second).accessToken, 'new-access'); assert.equal(writes, 1);
});

test('SDK attachment path rejects unverified modes before storage bytes leave the host', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'botter-sdk-upload-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'notes.txt'); await writeFile(filename, 'notes'); let storage = 0;
  const raw = transport(() => ({ mode: 'MULTIPART', uploadToken: 'private-upload-token' })); raw.fetch = async () => { storage++; throw Error('unexpected'); };
  const client = createClient({ transport: raw });
  await assert.rejects(client.send({ botId: 'Example', text: 'Read notes', attachments: [filename] }), { code: 'UNSUPPORTED_OPERATION' });
  assert.equal(storage, 0); assert.equal(raw.calls.filter(call => call.method === 'SendGrokBotUserMessage').length, 0);
  assert.equal(raw.calls.find(call => call.method === 'BeginGrokBotAttachmentUpload').body.supportsMultipart, false); await client.close();
});

test('unverified bot runtimes reject sends before attachment file reads or writes', async () => {
  const raw = transport(); raw.resolveBot = async () => ({ ...bot, harness: 'box' });
  const client = createClient({ transport: raw });
  await assert.rejects(client.send({ botId: 'Example', text: 'Hello', attachments: ['/missing-not-read'] }), { code: 'UNSUPPORTED_OPERATION' });
  assert.equal(raw.calls.length, 0); await client.close();
});

test('canonical file transfers use verified storage, normalized output, and one implementation', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'botter-sdk-files-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'notes.txt'), output = path.join(directory, 'download.txt');
  const bytes = Buffer.from('client notes'); await writeFile(filename, bytes); const storage = [];
  const raw = transport(method => {
    if (method === 'BeginGrokBotAttachmentUpload') return { mode: 'SINGLE_PUT', uploadToken: 'upload-token', put: { url: 'https://storage.example/upload' } };
    if (method === 'CompleteGrokBotAttachmentUpload') return { alias: '/store/notes.txt', sizeBytes: String(bytes.length), fileName: 'notes.txt' };
    if (method === 'ResolveGrokBotAttachmentReads') return { reads: [{ path: '/store/notes.txt', outcome: 'STORE', sizeBytes: String(bytes.length), url: 'https://storage.example/download', contentType: 'text/plain' }] };
    throw Error('Unexpected RPC');
  });
  raw.fetch = async (url, options) => {
    storage.push({ url, options });
    if (options.method === 'PUT') { assert.deepEqual(Buffer.from(options.body), bytes); return new Response(null, { status: 200 }); }
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  };
  const client = createClient({ transport: raw });
  const uploaded = await client.upload({ botId: 'Example', path: filename, name: 'Notes' });
  assert.equal(uploaded.fileName, 'Notes'); assert.equal(uploaded.mode, 'single-put');
  const downloaded = await client.download({ botId: 'Example', path: uploaded.path, output });
  assert.equal(downloaded.output, output); assert.equal(downloaded.destination, output); assert.equal(downloaded.sizeBytes, bytes.length);
  assert.deepEqual(await readFile(output), bytes); assert.equal(downloaded.sha256, uploaded.sha256);
  for (const entry of storage) assert.equal(new Headers(entry.options.headers).has('authorization'), false);
  await assert.rejects(client.download({ botId: 'Example', path: uploaded.path, output, destination: '/conflicting' }), { code: 'INVALID_ARGUMENT' });
  await client.close();
});

test('watch bounds unread events and rejects done even without an iterator', async () => {
  const raw = transport(() => ({ generation: 1, entries: [] }));
  raw.stream = async function* () { yield { rows: { agentId: bot.agentId, sessionId: 'native-session', generation: 1, entries: [row('1'), row('2'), row('3')] } }; };
  const client = createClient({ transport: raw, maxBufferEvents: 2 });
  const sub = await client.watch({ botId: 'Example' });
  await assert.rejects(sub.done, { code: 'RESYNC_REQUIRED' });
  await assert.rejects(sub[Symbol.asyncIterator]().next(), { code: 'RESYNC_REQUIRED' }); await client.close();
});

test('watch cancellation settles next/done independently of an uncooperative producer', async () => {
  const raw = transport(() => ({ generation: 1, entries: [] }));
  raw.stream = async function* () { await new Promise(() => {}); };
  const client = createClient({ transport: raw }), sub = await client.watch({ botId: 'Example' });
  const next = sub[Symbol.asyncIterator]().next(); await tick(); await sub.cancel(); await sub.done;
  assert.deepEqual(await next, { done: true, value: undefined }); await sub.cancel(); await client.close();
});

test('a subscription rejects concurrent reads and cancellation settles the pending read', async () => {
  const raw = transport(() => ({ generation: 1, entries: [] }));
  raw.stream = async function* () { await new Promise(() => {}); };
  const client = createClient({ transport: raw }), sub = await client.watch({ botId: 'Example' });
  const iterator = sub[Symbol.asyncIterator](), first = iterator.next();
  await assert.rejects(iterator.next(), { code: 'INVALID_ARGUMENT' });
  await sub.cancel();
  assert.deepEqual(await first, { done: true, value: undefined });
  await sub.done; await client.close();
});

test('watch exposes a consumed cursor and preserves transcript entry/delete ordering', async () => {
  const raw = transport(() => ({ generation: 7, entries: [] }));
  raw.stream = async function* () { yield { rows: { agentId: bot.agentId, sessionId: 'native-session', generation: 7,
    entries: [row('9007199254740999')], deletes: [{ seq: '4', updatedSeq: '9007199254741000', entryId: 'deleted' }] } }; await new Promise(() => {}); };
  const client = createClient({ transport: raw }), sub = await client.watch({ botId: 'Example' });
  await tick(); assert.equal(sub.cursor, undefined, 'queued rows are not acknowledged');
  const iterator = sub[Symbol.asyncIterator](), first = (await iterator.next()).value;
  assert.equal(first.message.id, 'message-9007199254740999'); assert.equal(first.botId, bot.agentId);
  assert.equal(sub.cursor.afterUpdatedSeq, '9007199254740999');
  assert.equal((await iterator.next()).value.type, 'delete'); assert.equal(sub.cursor.afterUpdatedSeq, '9007199254741000');
  const copy = sub.cursor; copy.afterUpdatedSeq = '0'; assert.notEqual(sub.cursor.afterUpdatedSeq, '0');
  await sub.cancel(); await client.close();
});

test('missing transcript bodies produce terminal resync without acknowledging omitted updates', async () => {
  const raw = transport(() => ({ generation: 1, entries: [] }));
  raw.stream = async function* () { yield { rows: { agentId: bot.agentId, sessionId: 'native-session', generation: 1,
    entries: [{ seq: '1', updatedSeq: '2', entryId: 'missing', bodyOmitted: true, blobHash: 'abc' }] } }; };
  const client = createClient({ transport: raw }), sub = await client.watch({ botId: 'Example' });
  await sub.done; const iterator = sub[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, 'resyncRequired'); assert.equal(sub.cursor, undefined);
  assert.equal((await iterator.next()).done, true); await client.close();
});

test('watch authentication failure is terminal and sanitized instead of reconnecting forever', async () => {
  const raw = transport(() => ({ generation: 1, entries: [] })); let attempts = 0;
  raw.stream = async function* () { attempts++; throw new ApiError('Bearer private-token', { code: 'unauthenticated', status: 401 }); };
  const client = createClient({ transport: raw }), sub = await client.watch({ botId: 'Example' });
  await assert.rejects(sub.done, error => { assert.equal(error.code, 'AUTH_REQUIRED'); assert(!error.message.includes('private')); return true; });
  assert.equal(attempts, 1); await client.close();
});

test('CLI core commands delegate to the exact primary SDK methods', async t => {
  const client = createClient({ transport: transport() }), calls = [];
  const originalLog = console.log, originalError = console.error;
  console.log = () => {}; console.error = () => {};
  t.after(async () => { console.log = originalLog; console.error = originalError; await client.close(); });
  for (const method of ['history', 'search', 'send', 'upload', 'download', 'artifacts']) {
    client[method] = async input => { calls.push({ method, input }); return { botId: bot.agentId, messages: [], entries: [], delivery: { delivery: 'ACCEPTED_TEMPORAL' } }; };
  }
  client.watch = async input => { calls.push({ method: 'watch', input }); return { done: Promise.resolve(), async cancel() {}, async *[Symbol.asyncIterator]() {} }; };
  for (const args of [ ['history', 'Example'], ['search', 'Example', '--query', 'notes'], ['send', 'Example', '--text', 'Hello'],
    ['upload', 'Example', '/local/notes'], ['download', 'Example', '/store/notes', '--out', '/local/notes'], ['artifacts', 'Example'], ['watch', 'Example'] ]) await main(args, client);
  assert.deepEqual(calls.map(call => call.method), ['history', 'search', 'send', 'upload', 'download', 'artifacts', 'watch']);
  assert.equal(calls.find(call => call.method === 'send').input.wait, false);
});
