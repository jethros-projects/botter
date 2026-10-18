import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntry, selectThread, scanHistory, watchBots, sendMessage, waitForReply } from '../src/conversations.mjs';

const raw = (seq, entry, update = seq) => ({ seq: String(seq), updatedSeq: String(update), entryId: entry.id,
  entryKind: entry.kind, body: Buffer.from(JSON.stringify(entry)).toString('base64') });
const bot = { name: 'Test', agentId: 'a', viewerSessionId: '' };

test('thread follows reply chains and request IDs but excludes unrelated turns', () => {
  const rows = [
    { id: 'u1', kind: 'message', requestId: 'r1' },
    { id: 's1', kind: 'send-message', requestId: 'r1' },
    { id: 'u2', kind: 'message', replyTo: 's1', requestId: 'r2' },
    { id: 's2', kind: 'send-message', requestId: 'r2' },
    { id: 'u3', kind: 'message', requestId: 'other' },
  ].map((entry, i) => decodeEntry(raw(i + 1, entry)));
  assert.deepEqual(selectThread(rows, 'u1').entries.map(x => x.entryId), ['u1', 's1', 'u2', 's2']);
  assert.equal(selectThread(rows, 'missing').found, false);
});

test('attachment batches resolve to the user message and retain request-linked tool branches', () => {
  const rows = [
    { seq: '1', entryId: 'attachment', kind: 'user-attachment', entry: { clientNonce: 'message-id', batchId: 'message-id' } },
    { seq: '2', entryId: 'user', kind: 'message', entry: { role: 'user', clientNonce: 'message-id', batchId: 'message-id', requestId: 'request' } },
    { seq: '3', entryId: 'tool', kind: 'tool-call', entry: { requestId: 'request' } },
    { seq: '4', entryId: 'reply', kind: 'send-message', text: 'done', entry: { requestId: 'request' } },
    { seq: '5', entryId: 'other', kind: 'send-message', text: 'unrelated', entry: { requestId: 'other' } },
  ];
  const result = selectThread(rows, 'message-id');
  assert.equal(result.rootEntryId, 'user');
  assert.deepEqual(result.entries.map(row => row.entryId), ['attachment', 'user', 'tool', 'reply']);
  assert.equal(selectThread(rows, 'attachment').rootEntryId, 'attachment');
  assert.deepEqual(selectThread(rows, 'attachment').entries.map(row => row.entryId), ['attachment', 'user', 'tool', 'reply']);
});

test('reply wait prioritizes echo identity over an earlier attachment sharing the nonce', async () => {
  const encode = entry => Buffer.from(JSON.stringify(entry)).toString('base64');
  const entries = [
    { seq: '1', entryId: 'attachment', entryKind: 'user-attachment', body: encode({ id: 'attachment', clientNonce: 'nonce', batchId: 'nonce' }) },
    { seq: '2', entryId: 'user', entryKind: 'message', body: encode({ id: 'user', role: 'user', clientNonce: 'nonce', batchId: 'nonce', requestId: 'request' }) },
    { seq: '3', entryId: 'other', entryKind: 'send-message', body: encode({ id: 'other', message: { content: 'wrong' }, requestId: 'other' }) },
    { seq: '4', entryId: 'reply', entryKind: 'send-message', body: encode({ id: 'reply', message: { content: 'right' }, requestId: 'request' }) },
  ];
  const client = { resolveBot: async value => value, rpc: async () => ({ entries, generation: 0 }) };
  for (const status of [{ echoEntryId: 'user' }, undefined]) {
    const result = await waitForReply(client, { agentId: 'agent', messageId: 'nonce', sessionId: '', status }, { timeoutMs: 50 });
    assert.equal(result.replyPending, false);
    assert.deepEqual(result.replies.map(row => row.entryId), ['reply']);
  }
});
test('bounded scan reports incomplete and catches a non-advancing cursor', async () => {
  const client = { resolveBot: async () => bot, rpc: async () => ({ entries: [raw(12, { id: 'x' })] }) };
  const result = await scanHistory(client, 'Test', { maxPages: 1 });
  assert.equal(result.complete, false); assert.equal(result.nextBeforeSeq, '12');
  await assert.rejects(scanHistory(client, 'Test', { maxPages: 3 }), /did not advance/);
});
test('watch suppresses replay duplicates and saves cursor after delivery', async () => {
  let saved;
  const row = raw(2, { id: 'm2', kind: 'message', content: 'hello' }, 3);
  const client = {
    resolveBot: async () => bot, accountFingerprint: async () => 'account',
    rpc: async () => ({ entries: [], generation: 0 }),
    async *stream() { yield { rows: { agentId: 'a', entries: [row] } }; yield { rows: { agentId: 'a', replay: true, entries: [row] } }; },
  };
  const output = await Array.fromAsync(watchBots(client, ['Test'], { reconnect: false, onCursor: state => { saved = state; } }));
  assert.equal(output.length, 1); assert.equal(output[0].text, 'hello');
  assert.equal(saved.cursors[0].afterUpdatedSeq, '3');
});
test('watch rejects cross-account resume state', async () => {
  const client = { resolveBot: async () => bot, accountFingerprint: async () => 'current' };
  await assert.rejects(async () => { for await (const unused of watchBots(client, ['Test'], { resume: { version: 1, account: 'other' } })) {} }, /another account/);
});
test('send validates forks before mutation and returns accepted send when receipt lookup fails', async () => {
  const calls = [];
  const client = { resolveBot: async () => bot, rpc: async (name, body) => {
    calls.push([name, body]);
    if (name === 'GetGrokBotSendStatus') throw new Error('temporary status failure');
    return { delivery: 'ACCEPTED_TEMPORAL' };
  } };
  await assert.rejects(sendMessage(client, 'Test', 'x', { isFork: true }), /requires/);
  assert.equal(calls.length, 0);
  const result = await sendMessage(client, 'Test', 'x', { replyToId: 'm1' });
  assert.equal(calls[0][1].replyToId, 'm1'); assert.equal(result.statusError, 'temporary status failure');
});

test('reply wait pages back to a root outside the newest 200 entries', async () => {
  let calls = 0;
  const client = { resolveBot: async q => q, rpc: async (method, body) => {
    calls++;
    if (!body.beforeSeq) return { entries: [raw(301, { id: 'reply', kind: 'send-message', replyTo: 'root', message: { type: 'text', content: 'done' } }),
      raw(102, { id: 'tool', kind: 'tool-call' })] };
    return { entries: [raw(1, { id: 'root', kind: 'message', requestId: 'req' })] };
  } };
  const result = await waitForReply(client, { agentId: 'a', bot: 'Test', status: { echoEntryId: 'root' } }, { timeoutMs: 1000 });
  assert.equal(result.replyPending, false); assert.equal(result.replies[0].text, 'done'); assert.equal(calls, 2);
});

test('reply wait retains the root when a later page contains only newer output', async () => {
  let calls = 0;
  const client = { resolveBot: async q => q, rpc: async (method, body) => {
    calls++;
    if (calls === 1) return { entries: [raw(1, { id: 'root', kind: 'message', requestId: 'req' })] };
    if (!body.beforeSeq) return { entries: [raw(301, { id: 'reply', kind: 'send-message', requestId: 'req', message: { type: 'text', content: 'done' } }), raw(102, { id: 'tool', kind: 'tool-call' })] };
    return { entries: [] };
  } };
  const result = await waitForReply(client, { agentId: 'a', bot: 'Test', status: { echoEntryId: 'root' } }, { timeoutMs: 1000, pollMs: 1 });
  assert.equal(result.replyPending, false); assert.equal(result.replies[0].text, 'done');
});

test('reply wait returns complete structured widgets and media without inventing text', async () => {
  const messages = [
    { type: 'widget', widget: { prompt: 'Choose', options: [{ label: 'Alpha', value: 'Alpha' }, { label: 'Beta', value: 'Beta' }] } },
    { type: 'image', image: { url: 'https://example.invalid/image.png' } },
    { type: 'attachment', attachments: [{ path: '/artifact/report.pdf', name: 'report.pdf' }] },
    { type: 'audio', audio: { path: '/artifact/sound.wav' } },
  ];
  for (const message of messages) {
    const client = { resolveBot: async q => q, rpc: async () => ({ entries: [
      raw(1, { id: 'root', kind: 'message', requestId: 'request' }),
      raw(2, { id: 'reply', kind: 'send-message', requestId: 'request', message }),
      raw(3, { id: 'other', kind: 'send-message', requestId: 'different', message: { type: 'text', content: 'unrelated' } }),
    ] }) };
    const result = await waitForReply(client, { agentId: 'a', status: { echoEntryId: 'root' } }, { timeoutMs: 50 });
    assert.equal(result.replyPending, false, message.type);
    assert.deepEqual(result.replies.map(row => row.entryId), ['reply']);
    assert.equal(result.replies[0].text, null);
    assert.deepEqual(result.replies[0].entry.message, message);
  }
});

test('reply wait ignores unavailable bodies and empty or streaming publication stubs', async () => {
  let calls = 0;
  const final = { type: 'widget', widget: { prompt: 'Ready', options: [{ label: 'OK', value: 'ok' }] } };
  const client = { resolveBot: async q => q, rpc: async () => ({ entries: [
    raw(1, { id: 'root', kind: 'message', requestId: 'request' }),
    { seq: '2', entryId: 'omitted', entryKind: 'send-message', bodyOmitted: true, blobHash: 'hash' },
    raw(3, { id: 'empty-text', kind: 'send-message', requestId: 'request', message: { type: 'text', content: '' } }),
    raw(4, { id: 'empty-widget', kind: 'send-message', requestId: 'request', message: { type: 'widget', widget: {} } }),
    raw(5, { id: 'streaming', kind: 'send-message', requestId: 'request', streaming: true, message: { type: 'widget', widget: { prompt: 'Not ready' } } }),
    ...(++calls === 1 ? [] : [raw(6, { id: 'published', kind: 'send-message', requestId: 'request', message: final })]),
  ] }) };
  const result = await waitForReply(client, { agentId: 'a', status: { echoEntryId: 'root' } }, { timeoutMs: 100, pollMs: 1 });
  assert.ok(calls >= 2);
  assert.equal(result.replyPending, false);
  assert.deepEqual(result.replies.map(row => row.entryId), ['published']);
});
