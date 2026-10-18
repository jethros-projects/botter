import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { uploadAttachment, downloadAttachment, listArtifacts, listArtifactReferences } from '../src/attachments.mjs';

const alias = '/mnt/data/agents/test-agent/attachments/' + 'a'.repeat(64) + '.txt';
const bot = { agentId: 'test-agent', name: 'Test Bot', viewerSessionId: 'test-session' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const future = String(Date.now() + 3600000);
const target = { url: 'https://storage.example/upload?signature=secret', expiresAtMs: future,
  headers: { 'content-type': 'text/plain' } };

async function sandbox(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-attachments-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function mockClient(handlers) {
  const calls = [];
  return {
    calls,
    async resolveBot(query) { assert.ok(query === 'Test Bot' || query === bot); return bot; },
    async rpc(method, body, options) {
      calls.push({ method, body, options });
      assert.ok(handlers[method], `Unexpected RPC ${method}`);
      return typeof handlers[method] === 'function' ? handlers[method](body, options) : handlers[method];
    },
  };
}

function singleClient(extra = {}) {
  return mockClient({
    BeginGrokBotAttachmentUpload: { mode: 'GROK_BOT_ATTACHMENT_UPLOAD_MODE_SINGLE_PUT', uploadToken: 'upload-token', put: target },
    CompleteGrokBotAttachmentUpload: { alias, fileName: 'hello.txt', sizeBytes: '5', contentType: 'text/plain' },
    AbortGrokBotAttachmentUpload: {},
    ...extra,
  });
}

test('single PUT upload and signed download round-trip without authenticated fetch headers', async t => {
  const dir = await sandbox(t);
  const source = path.join(dir, 'hello.txt');
  const destination = path.join(dir, 'received.txt');
  await fs.writeFile(source, 'hello');
  let stored;
  const client = singleClient({
    ResolveGrokBotAttachmentReads: { reads: [{ path: alias, outcome: 'GROK_BOT_ATTACHMENT_READ_OUTCOME_STORE',
      url: 'https://storage.example/download?signature=secret', sizeBytes: '5', expiresAtMs: future, contentType: 'text/plain' }] },
  });
  const fetchImpl = async (url, init) => {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    assert.equal(new Headers(init.headers).has('cookie'), false);
    assert.ok(init.signal);
    if (init.method === 'PUT') {
      stored = Buffer.from(init.body);
      return new Response(null, { status: 200 });
    }
    return new Response(stored, { status: 200, headers: { 'content-length': '5' } });
  };
  const uploaded = await uploadAttachment(client, 'Test Bot', source, { fetchImpl });
  assert.deepEqual(uploaded, { bot: 'Test Bot', agentId: 'test-agent', sessionId: 'test-session',
    kind: 'store', mode: 'single-put', path: alias, alias, fileName: 'hello.txt', sizeBytes: 5,
    contentType: 'text/plain', sha256: hash(Buffer.from('hello')) });
  assert.deepEqual(client.calls[0].body, { agentId: 'test-agent', sessionId: 'test-session',
    fileName: 'hello.txt', sizeBytes: '5', supportsStoreAttachmentRefs: true,
    supportsMultipart: true, sha256Hex: hash(Buffer.from('hello')) });
  const downloaded = await downloadAttachment(client, 'Test Bot', uploaded.path, destination, { fetchImpl, allowedReadOutcomes: ['STORE'] });
  assert.equal(await fs.readFile(destination, 'utf8'), 'hello');
  assert.equal(downloaded.sha256, uploaded.sha256);
  assert.equal(downloaded.via, 'store');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['hello.txt', 'received.txt']);
});

test('multipart upload hashes and sends exact part bytes then finalizes once', async t => {
  const dir = await sandbox(t);
  const source = path.join(dir, 'hello.txt');
  await fs.writeFile(source, 'hello');
  const parts = [];
  const client = singleClient({
    BeginGrokBotAttachmentUpload: { mode: 3, uploadToken: 'upload-token', partCount: 3, partSizeBytes: '2' },
    PresignGrokBotAttachmentUploadParts: body => {
      const requested = body.parts[0];
      const bytes = Buffer.from('hello').subarray((requested.partNumber - 1) * 2, requested.partNumber * 2);
      assert.equal(requested.checksumSha256, createHash('sha256').update(bytes).digest('base64'));
      return { parts: [{ partNumber: requested.partNumber, offsetBytes: String((requested.partNumber - 1) * 2),
        sizeBytes: String(bytes.length), target: { ...target, url: `https://storage.example/part/${requested.partNumber}` } }] };
    },
  });
  const result = await uploadAttachment(client, 'Test Bot', source, { fetchImpl: async (url, init) => {
    parts.push(Buffer.from(init.body));
    return new Response(null, { status: 204 });
  } });
  assert.equal(Buffer.concat(parts).toString(), 'hello');
  assert.equal(result.mode, 'multipart');
  assert.equal(client.calls.filter(call => call.method === 'CompleteGrokBotAttachmentUpload').length, 1);
});

test('an expired single PUT target is refreshed using the documented empty parts request', async t => {
  const dir = await sandbox(t);
  const source = path.join(dir, 'hello.txt');
  await fs.writeFile(source, 'hello');
  const client = singleClient({
    BeginGrokBotAttachmentUpload: { mode: 2, uploadToken: 'upload-token', put: { ...target, expiresAtMs: '1' } },
    PresignGrokBotAttachmentUploadParts: body => {
      assert.deepEqual(body, { uploadToken: 'upload-token', parts: [] });
      return { put: target };
    },
  });
  await uploadAttachment(client, 'Test Bot', source, { fetchImpl: async () => new Response(null) });
  assert.equal(client.calls[1].method, 'PresignGrokBotAttachmentUploadParts');
});

test('upload enforces the local cap before any remote mutation and rejects symlinks', async t => {
  const dir = await sandbox(t);
  const source = path.join(dir, 'hello.txt');
  const link = path.join(dir, 'link.txt');
  await fs.writeFile(source, 'hello');
  await fs.symlink(source, link);
  const client = mockClient({});
  await assert.rejects(uploadAttachment(client, 'Test Bot', source, { maxBytes: 4 }), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(uploadAttachment(client, 'Test Bot', link), { code: 'INVALID_FILE' });
  assert.equal(client.calls.length, 0);
});

test('unsafe storage URLs and account credential headers are rejected and staged uploads are aborted', async t => {
  const dir = await sandbox(t);
  const source = path.join(dir, 'hello.txt');
  await fs.writeFile(source, 'hello');
  for (const [badTarget, code] of [
    [{ ...target, url: 'http://storage.example/upload' }, 'INVALID_STORAGE_URL'],
    [{ ...target, headers: { Authorization: 'account-token' } }, 'UNSAFE_STORAGE_HEADER'],
    [{ ...target, headers: { 'Content-Length': '500' } }, 'SIZE_MISMATCH'],
  ]) {
    const client = singleClient({ BeginGrokBotAttachmentUpload: { mode: 2, uploadToken: 'upload-token', put: badTarget } });
    await assert.rejects(uploadAttachment(client, 'Test Bot', source, { fetchImpl: () => assert.fail('must not fetch') }), { code });
    assert.equal(client.calls.at(-1).method, 'AbortGrokBotAttachmentUpload');
    assert.equal(client.calls.some(call => call.method === 'CompleteGrokBotAttachmentUpload'), false);
  }
});

test('malformed multipart layout fails before a PUT and aborts the upload', async t => {
  const dir = await sandbox(t);
  const source = path.join(dir, 'hello.txt');
  await fs.writeFile(source, 'hello');
  const client = singleClient({ BeginGrokBotAttachmentUpload: { mode: 3, uploadToken: 'upload-token', partCount: 2, partSizeBytes: '2' } });
  await assert.rejects(uploadAttachment(client, 'Test Bot', source, { fetchImpl: () => assert.fail('must not fetch') }), { code: 'INVALID_RESPONSE' });
  assert.equal(client.calls.at(-1).method, 'AbortGrokBotAttachmentUpload');
});

test('unsupported box upload provides an explicit error without inventing a transport', async t => {
  const dir = await sandbox(t);
  const source = path.join(dir, 'hello.txt');
  await fs.writeFile(source, 'hello');
  const client = singleClient({ BeginGrokBotAttachmentUpload: { mode: 1, useBoxReason: 'no store' } });
  await assert.rejects(uploadAttachment(client, 'Test Bot', source), { code: 'BOX_UPLOAD_REQUIRED' });
  assert.equal(client.calls.length, 1);
});

test('allowedModes SINGLE_PUT disables multipart capability and permits the verified store path', async t => {
  const dir = await sandbox(t);
  const source = path.join(dir, 'hello.txt');
  await fs.writeFile(source, 'hello');
  const client = singleClient();
  let puts = 0;
  const result = await uploadAttachment(client, 'Test Bot', source, {
    allowedModes: ['SINGLE_PUT'],
    fetchImpl: async () => { puts++; return new Response(null); },
  });
  assert.equal(client.calls[0].body.supportsMultipart, false);
  assert.equal(result.mode, 'single-put');
  assert.equal(puts, 1);
  assert.equal(client.calls.filter(call => call.method === 'CompleteGrokBotAttachmentUpload').length, 1);
});

test('strict single PUT mode aborts a multipart session before presigning or sending bytes', async t => {
  const dir = await sandbox(t);
  const source = path.join(dir, 'hello.txt');
  await fs.writeFile(source, 'hello');
  for (const mode of [3, 'MULTIPART', 'GROK_BOT_ATTACHMENT_UPLOAD_MODE_MULTIPART']) {
    const client = singleClient({ BeginGrokBotAttachmentUpload: {
      mode, uploadToken: 'unexpected-multipart', partSizeBytes: '2', partCount: 3,
    } });
    await assert.rejects(uploadAttachment(client, 'Test Bot', source, {
      allowedModes: ['SINGLE_PUT'], fetchImpl: () => assert.fail('disallowed upload must not send bytes'),
    }), { code: 'UPLOAD_MODE_NOT_ALLOWED' });
    assert.deepEqual(client.calls.map(call => call.method), ['BeginGrokBotAttachmentUpload', 'AbortGrokBotAttachmentUpload']);
    assert.deepEqual(client.calls[1].body, { uploadToken: 'unexpected-multipart' });
    assert.equal(client.calls[1].options.signal, undefined);
  }
});

test('strict single PUT mode refuses USE_BOX before calling a supplied gateway', async t => {
  const dir = await sandbox(t);
  const source = path.join(dir, 'hello.txt');
  await fs.writeFile(source, 'hello');
  const client = singleClient({ BeginGrokBotAttachmentUpload: { mode: 1 } });
  await assert.rejects(uploadAttachment(client, 'Test Bot', source, {
    allowedModes: ['SINGLE_PUT'],
    gatewayClient: { rpcGateway: () => assert.fail('disallowed mode must not reach gateway') },
  }), { code: 'UPLOAD_MODE_NOT_ALLOWED' });
  assert.equal(client.calls.length, 1);
});

test('allowedModes is validated before remote work and cleanup failure retains the rejection reason', async t => {
  const dir = await sandbox(t);
  const source = path.join(dir, 'hello.txt');
  await fs.writeFile(source, 'hello');
  const unused = mockClient({});
  for (const allowedModes of [null, [], 'SINGLE_PUT', [2], ['single-put'], ['REFUSED'], ['SINGLE_PUT', 'unexpected']]) {
    await assert.rejects(uploadAttachment(unused, 'Test Bot', source, { allowedModes }), { code: 'INVALID_OPTION' });
  }
  assert.equal(unused.calls.length, 0);
  const cleanupFails = singleClient({
    BeginGrokBotAttachmentUpload: { mode: 3, uploadToken: 'token' },
    AbortGrokBotAttachmentUpload: () => { throw new Error('cleanup failed'); },
  });
  await assert.rejects(uploadAttachment(cleanupFails, 'Test Bot', source, { allowedModes: ['SINGLE_PUT'] }),
    error => error.code === 'UPLOAD_MODE_NOT_ALLOWED' && error.cleanupFailed === true);
  assert.deepEqual(cleanupFails.calls.map(call => call.method), ['BeginGrokBotAttachmentUpload', 'AbortGrokBotAttachmentUpload']);
});

test('cancellation after staging aborts with a fresh cleanup request and never finalizes', async t => {
  const dir = await sandbox(t);
  const source = path.join(dir, 'hello.txt');
  await fs.writeFile(source, 'hello');
  const controller = new AbortController();
  const client = singleClient();
  await assert.rejects(uploadAttachment(client, 'Test Bot', source, {
    signal: controller.signal,
    fetchImpl: async () => { controller.abort(); throw new Error('aborted'); },
  }), { name: 'AbortError' });
  const cleanup = client.calls.at(-1);
  assert.equal(cleanup.method, 'AbortGrokBotAttachmentUpload');
  assert.equal(cleanup.options.signal, undefined);
  assert.equal(client.calls.some(call => call.method === 'CompleteGrokBotAttachmentUpload'), false);
});

test('storage network failures do not leak signed URL query credentials', async t => {
  const dir = await sandbox(t);
  const source = path.join(dir, 'hello.txt');
  await fs.writeFile(source, 'hello');
  const client = singleClient();
  await assert.rejects(uploadAttachment(client, 'Test Bot', source, {
    fetchImpl: async () => { throw new Error('failed request https://storage.example/?signature=secret'); },
  }), error => error.code === 'STORAGE_NETWORK_ERROR' && !error.message.includes('secret'));
});

test('download uses exact chunks after NOT_IN_STORE, validates sizes and hashes all bytes', async t => {
  const dir = await sandbox(t);
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 19, 42);
  const destination = path.join(dir, 'large.txt');
  const client = mockClient({
    ResolveGrokBotAttachmentReads: { reads: [{ path: alias, outcome: 'GROK_BOT_ATTACHMENT_READ_OUTCOME_NOT_IN_STORE' }] },
    ReadGrokBotAgentAttachmentChunk: body => {
      assert.equal(body.sessionId, 'other-session');
      const offset = Number(body.offset);
      return { totalSize: String(bytes.length), data: bytes.subarray(offset, offset + body.length).toString('base64') };
    },
  });
  const result = await downloadAttachment(client, 'Test Bot', alias, destination, { sessionId: 'other-session',
    fetchImpl: () => assert.fail('server fallback must not use storage fetch') });
  assert.equal(result.via, 'server-chunks');
  assert.equal(result.sha256, hash(bytes));
  assert.deepEqual(await fs.readFile(destination), bytes);
  assert.deepEqual(client.calls.filter(call => call.method === 'ReadGrokBotAgentAttachmentChunk').map(call => call.body.offset), ['0', '4194304']);
});

test('strict STORE downloads refuse fallback outcomes before reading chunks and remove temporary files', async t => {
  const dir = await sandbox(t);
  for (const outcome of [2, 3, 'NOT_IN_STORE', 'NO_STORAGE', 'GROK_BOT_ATTACHMENT_READ_OUTCOME_NOT_IN_STORE', 'GROK_BOT_ATTACHMENT_READ_OUTCOME_NO_STORAGE']) {
    const client = mockClient({ ResolveGrokBotAttachmentReads: { reads: [{ path: alias, outcome }] } });
    const destination = path.join(dir, 'refused.txt');
    await assert.rejects(downloadAttachment(client, 'Test Bot', alias, destination, {
      allowedReadOutcomes: ['STORE'], fetchImpl: () => assert.fail('disallowed outcome must not download bytes'),
    }), { code: 'READ_OUTCOME_NOT_ALLOWED' });
    assert.deepEqual(client.calls.map(call => call.method), ['ResolveGrokBotAttachmentReads']);
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(dir), []);
  }
});

test('download outcome policy validates before remote reads or temporary writes', async t => {
  const dir = await sandbox(t);
  const client = mockClient({});
  for (const allowedReadOutcomes of [null, [], 'STORE', [1], ['store'], ['UNSPECIFIED'], ['STORE', 'unexpected']]) {
    await assert.rejects(downloadAttachment(client, 'Test Bot', alias, path.join(dir, 'invalid.txt'), {
      allowedReadOutcomes,
    }), { code: 'INVALID_OPTION' });
  }
  assert.equal(client.calls.length, 0);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('short chunks, changing remote sizes, and malformed base64 never publish partial files', async t => {
  const dir = await sandbox(t);
  const large = Buffer.alloc(4 * 1024 * 1024);
  for (const [label, handler, code] of [
    ['short', () => ({ totalSize: '5', data: Buffer.from('x').toString('base64') }), 'SIZE_MISMATCH'],
    ['base64', () => ({ totalSize: '5', data: '@@@@' }), 'INVALID_RESPONSE'],
    ['changed', body => Number(body.offset) === 0 ? { totalSize: String(large.length + 1), data: large.toString('base64') } : { totalSize: '0', data: '' }, 'FILE_CHANGED'],
  ]) {
    const destination = path.join(dir, label);
    const client = mockClient({ ResolveGrokBotAttachmentReads: { reads: [{ path: alias, outcome: 2 }] },
      ReadGrokBotAgentAttachmentChunk: handler });
    await assert.rejects(downloadAttachment(client, 'Test Bot', alias, destination), { code });
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  }
  assert.deepEqual(await fs.readdir(dir), []);
});

test('storage downloads enforce the declared cap and actual content bounds', async t => {
  const dir = await sandbox(t);
  for (const [name, readSize, body, maxBytes, code] of [
    ['cap', '6', 'hello!', 5, 'FILE_TOO_LARGE'],
    ['short', '5', 'hell', 100, 'SIZE_MISMATCH'],
    ['long', '5', 'hello!', 100, 'SIZE_MISMATCH'],
  ]) {
    const client = mockClient({ ResolveGrokBotAttachmentReads: { reads: [{ path: alias, outcome: 1,
      url: 'https://storage.example/download', sizeBytes: readSize }] } });
    await assert.rejects(downloadAttachment(client, 'Test Bot', alias, path.join(dir, name), { maxBytes,
      fetchImpl: async () => { assert.notEqual(name, 'cap'); return new Response(body); } }), { code });
  }
  assert.deepEqual(await fs.readdir(dir), []);
});

test('existing destinations are preserved and publication refuses a racing destination', async t => {
  const dir = await sandbox(t);
  const destination = path.join(dir, 'output.txt');
  await fs.writeFile(destination, 'original');
  const noCalls = mockClient({});
  await assert.rejects(downloadAttachment(noCalls, 'Test Bot', alias, destination), { code: 'DESTINATION_EXISTS' });
  assert.equal(noCalls.calls.length, 0);
  await fs.rm(destination);
  const client = mockClient({
    ResolveGrokBotAttachmentReads: async () => {
      await fs.writeFile(destination, 'arrived');
      return { reads: [{ path: alias, outcome: 2 }] };
    },
    ReadGrokBotAgentAttachmentChunk: { totalSize: '5', data: Buffer.from('hello').toString('base64') },
  });
  await assert.rejects(downloadAttachment(client, 'Test Bot', alias, destination), { code: 'DESTINATION_EXISTS' });
  assert.equal(await fs.readFile(destination, 'utf8'), 'arrived');
  assert.deepEqual(await fs.readdir(dir), ['output.txt']);
});

test('explicit overwrite replaces a regular file only after complete download', async t => {
  const dir = await sandbox(t);
  const destination = path.join(dir, 'output.txt');
  await fs.writeFile(destination, 'original');
  const client = mockClient({ ResolveGrokBotAttachmentReads: { reads: [{ path: alias, outcome: 3 }] },
    ReadGrokBotAgentAttachmentChunk: { totalSize: '5', data: Buffer.from('hello').toString('base64') } });
  await downloadAttachment(client, 'Test Bot', alias, destination, { overwrite: true });
  assert.equal(await fs.readFile(destination, 'utf8'), 'hello');
});

test('path traversal, remote web URLs, and pre-aborted work are refused before RPC', async t => {
  const dir = await sandbox(t);
  const client = mockClient({});
  for (const remote of ['/mnt/data/../secret', 'https://example.com/file', 'file://host/etc/passwd', 'file:///tmp/%2ffile', '/tmp/a\\b']) {
    await assert.rejects(downloadAttachment(client, 'Test Bot', remote, path.join(dir, 'file')), { code: 'INVALID_REMOTE_PATH' });
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(downloadAttachment(client, 'Test Bot', alias, path.join(dir, 'file'), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(client.calls.length, 0);
});

test('agent-file listing follows verified pagination and reports a continuation cap', async () => {
  const client = mockClient({ ListGrokBotAgentFiles: body => ({
    files: [{ path: alias, name: body.pageToken || 'first.txt', sizeBytes: '5' }],
    nextPageToken: body.pageToken ? '' : 'second', totalBytes: '10', canEdit: true,
    additionalServerMetadata: 'preserved',
  }) });
  const result = await listArtifacts(client, 'Test Bot');
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].sizeBytes, 5);
  assert.equal(result.totalBytes, 10);
  assert.equal(result.complete, true);
  assert.equal(result.additionalServerMetadata, 'preserved');
  assert.deepEqual(client.calls.map(call => call.body), [
    { agentId: 'test-agent', pageToken: '' }, { agentId: 'test-agent', pageToken: 'second' },
  ]);
  const capped = await listArtifacts(client, 'Test Bot', { maxPages: 1 });
  assert.equal(capped.complete, false);
  assert.equal(capped.nextPageToken, 'second');
});

test('unavailable listing returns an actionable limitation and repeated page tokens fail', async () => {
  const unavailable = mockClient({ ListGrokBotAgentFiles: () => { const error = new Error('precondition failed'); error.code = 'failed_precondition'; throw error; } });
  await assert.rejects(listArtifacts(unavailable, 'Test Bot'), { code: 'ARTIFACT_LIST_UNAVAILABLE' });
  const repeated = mockClient({ ListGrokBotAgentFiles: { files: [], nextPageToken: 'same' } });
  await assert.rejects(listArtifacts(repeated, 'Test Bot'), { code: 'INVALID_RESPONSE' });
  await assert.rejects(listArtifacts(repeated, 'Test Bot', { sessionId: 'unsupported' }), { code: 'UNSUPPORTED_OPTION' });
});

const transcriptRow = (seq, entry) => ({ seq: String(seq), entryId: `entry-${seq}`,
  body: Buffer.from(JSON.stringify(entry)).toString('base64') });

test('transcript discovery finds nested image and attachment paths and deduplicates by normalized path', async () => {
  const imagePath = '/home/box/agent-data/agents/test-agent/attachments/image.png';
  const rows = [
    transcriptRow(1, { kind: 'send-message', message: { images: [{ url: `file://${imagePath}`, alt: '/not-an-explicit-path-field' }] } }),
    transcriptRow(2, { kind: 'message', payload: { attachments: [{ data: { file_path: alias } }], attachmentPaths: [alias] } }),
    transcriptRow(3, { kind: 'message', content: `[Download](${alias}) and ![preview](file://${imagePath})` }),
    transcriptRow(4, { kind: 'message', content: 'A file is at file:///tmp/another%20file.txt' }),
    transcriptRow(5, { kind: 'message', data: { type: 'image', src: `file://${imagePath}` } }),
  ];
  const client = mockClient({ ListGrokBotTranscriptEntries: body => ({ generation: 2, entries: body.beforeSeq ? [] : rows }) });
  const result = await listArtifactReferences(client, 'Test Bot', { pageSize: 100, maxPages: 3 });
  assert.equal(result.scope, 'transcript-references');
  assert.equal(result.complete, true);
  assert.equal(result.inspectionComplete, true);
  assert.equal(result.pages, 2);
  assert.equal(result.nextBeforeSeq, null);
  assert.equal(result.entriesScanned, 5);
  assert.deepEqual(new Set(result.entries.map(entry => entry.path)), new Set([alias, imagePath, '/tmp/another file.txt']));
  const image = result.entries.find(entry => entry.path === imagePath);
  assert.equal(image.entryId, 'entry-1');
  assert.equal(image.references.length, 3);
  assert.equal(image.field, 'message.images[0].url');
  assert.equal(result.entries.find(entry => entry.path === alias).references.length, 3);
  assert.equal(result.entries.some(entry => entry.path === '/not-an-explicit-path-field'), false);
});

test('transcript discovery rejects web URLs, relative paths and traversal destinations', async () => {
  const rows = [transcriptRow(7, {
    path: '../relative.txt', filePath: 'https://example.com/file.pdf',
    attachments: ['/safe/../traversal.txt', './relative.png', 'file://elsewhere/etc/password',
      'file:///tmp/%2fescaped.txt', 'https://storage.example/signed?secret=1'],
    content: '[web](https://example.com/file) [relative](./thing.txt) [traversal](/tmp/../x) [good](</tmp/with space.txt>)',
  })];
  const client = mockClient({ ListGrokBotTranscriptEntries: body => ({ entries: body.beforeSeq ? [] : rows }) });
  const result = await listArtifactReferences(client, 'Test Bot');
  assert.deepEqual(result.entries.map(entry => entry.path), ['/tmp/with space.txt']);
});

test('transcript discovery reports the history cursor and unavailable bodies without pretending enumeration is complete', async () => {
  const client = mockClient({ ListGrokBotTranscriptEntries: { generation: 8, entries: [
    transcriptRow(12, { filePath: '/tmp/known.txt' }),
    { seq: '13', entryId: 'entry-13', bodyOmitted: true, blobHash: 'not-fetched' },
  ] } });
  const result = await listArtifactReferences(client, 'Test Bot', { maxPages: 1, pageSize: 2 });
  assert.equal(result.complete, false);
  assert.equal(result.nextBeforeSeq, '12');
  assert.equal(result.unavailableEntries, 1);
  assert.equal(result.inspectionComplete, false);
  assert.equal(result.generation, 8);
  assert.equal(result.entries[0].path, '/tmp/known.txt');
});

test('transcript references forward the complete session and pagination options', async () => {
  const controller = new AbortController();
  const client = mockClient({ ListGrokBotTranscriptEntries: (body, options) => {
    assert.deepEqual(body, { agentId: 'test-agent', sessionId: 'other-session', limit: 10,
      beforeSeq: '21', generation: 8, unreadBoundaryMs: '12345' });
    assert.equal(options.signal, controller.signal);
    return { generation: 8, entries: [transcriptRow(20, { filePath: '/tmp/paged.txt' })] };
  } });
  const result = await listArtifactReferences(client, 'Test Bot', {
    sessionId: 'other-session', pageSize: 10, maxPages: 1, beforeSeq: '21', generation: 8,
    unreadBoundaryMs: '12345', signal: controller.signal,
  });
  assert.equal(client.calls.length, 1);
  assert.equal(result.sessionId, 'other-session');
  assert.equal(result.generation, 8);
  assert.equal(result.nextBeforeSeq, '20');
  assert.equal(result.complete, false);
  assert.equal(result.entries[0].path, '/tmp/paged.txt');
});
