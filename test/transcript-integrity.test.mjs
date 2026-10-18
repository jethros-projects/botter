import test from 'node:test';
import assert from 'node:assert/strict';
import { readTranscriptUpdates, watchBots } from '../src/conversations.mjs';

const bot = { agentId: 'agent', name: 'Example', viewerSessionId: 'session' };
const row = (seq, updatedSeq, content = `update ${updatedSeq}`) => ({
  seq: String(seq), updatedSeq: String(updatedSeq), entryId: `entry-${seq}`, entryKind: 'message',
  body: Buffer.from(JSON.stringify({ id: `entry-${seq}`, kind: 'message', content })).toString('base64'),
});
const omitted = (seq, updatedSeq) => ({ ...row(seq, updatedSeq), body: undefined, bodyOmitted: true, blobHash: 'hash' });
const frame = (entries, deletes = [], generation = 1) => ({
  rows: { agentId: bot.agentId, sessionId: bot.viewerSessionId, generation, entries, deletes },
});
const resume = afterUpdatedSeq => ({ version: 1, account: 'account', cursors: [{
  agentId: bot.agentId, sessionId: bot.viewerSessionId, generation: 1, afterUpdatedSeq,
}] });
const client = overrides => ({
  resolveBot: async value => typeof value === 'object' ? value : bot,
  accountFingerprint: async () => 'account',
  rpc: async () => ({ generation: 1, entries: [] }),
  ...overrides,
});

test('watch hydrates omitted bodies and delivers entries and deletions in update order', async () => {
  const checkpoints = [], calls = [];
  const c = client({
    rpc: async (method, request) => {
      calls.push({ method, request });
      return { generation: 1, entries: [row(1, 10)] };
    },
    async *stream() {
      yield frame([row(2, 12), omitted(1, 10)], [{ entryId: 'entry-3', updatedSeq: '11' }]);
      yield frame([row(2, 12)], [{ entryId: 'entry-3', updatedSeq: '11' }]);
    },
  });
  const events = await Array.fromAsync(watchBots(c, [bot], { reconnect: false, resume: resume('9'),
    onCursor: state => checkpoints.push(state.cursors[0].afterUpdatedSeq) }));
  assert.deepEqual(events.map(event => [event.type, event.updatedSeq]), [['entry', '10'], ['delete', '11'], ['entry', '12']]);
  assert.equal(events[0].text, 'update 10');
  assert.equal(events[0].bodyUnavailable, undefined);
  assert.deepEqual(calls, [{ method: 'ListGrokBotTranscriptEntries', request: {
    agentId: bot.agentId, sessionId: bot.viewerSessionId, limit: 1, beforeSeq: '2', generation: 1,
  } }]);
  assert.equal(checkpoints.at(-1), '12');
});

test('watch requests resynchronization before unavailable bodies and keeps the last delivered checkpoint', async () => {
  const events = [], checkpoints = [];
  const c = client({ async *stream() {
    yield frame([row(1, 10), omitted(2, 11)], [{ entryId: 'entry-3', updatedSeq: '12' }]);
  } });
  for await (const event of watchBots(c, [bot], { reconnect: false, resume: resume('9'),
    onCursor: state => checkpoints.push(state.cursors[0].afterUpdatedSeq) })) events.push(event);
  assert.deepEqual(events.map(event => [event.type, event.updatedSeq]), [['entry', '10'], ['resyncRequired', '11']]);
  assert.equal(events.at(-1).reason, 'body_unavailable');
  assert.deepEqual(events.at(-1).cursor, { generation: 1, afterUpdatedSeq: '10' });
  assert.equal(checkpoints.at(-1), '10');
});

test('bounded reads leave unavailable bodies and later deletions unacknowledged', async () => {
  const c = client({ async *stream() {
    yield frame([row(1, 10), omitted(2, 11)], [{ entryId: 'entry-3', updatedSeq: '12' }]);
  } });
  const result = await readTranscriptUpdates(c, bot, { generation: 1, afterUpdatedSeq: '9' });
  assert.deepEqual(result.events.map(event => [event.type, event.updatedSeq]), [['entry', '10'], ['resyncRequired', '11']]);
  assert.deepEqual(result.cursor, { generation: 1, afterUpdatedSeq: '10' });
  assert.equal(result.truncated, true);
  assert.equal(result.resyncRequired, true);
});

test('hydration cannot substitute a different update, entry, or conversation generation', async t => {
  for (const [name, page] of [
    ['newer update', { generation: 1, entries: [row(1, 20)] }],
    ['older update', { generation: 1, entries: [row(1, 8)] }],
    ['different entry', { generation: 1, entries: [{ ...row(1, 10), entryId: 'different' }] }],
    ['new generation', { generation: 2, entries: [row(1, 10)] }],
  ]) await t.test(name, async () => {
    const c = client({ rpc: async () => page, async *stream() { yield frame([omitted(1, 10)]); } });
    const result = await readTranscriptUpdates(c, bot, { generation: 1, afterUpdatedSeq: '9' });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, 'resyncRequired');
    assert.equal(result.cursor.afterUpdatedSeq, '9');
    assert.equal(result.truncated, true);
    assert.equal(result.resyncRequired, true);
  });
});

test('watch terminates on changed hydration versions even when automatic reconnect is enabled', { timeout: 1000 }, async t => {
  const requests = [], checkpoints = [];
  let hydrations = 0;
  const c = client({
    rpc: async () => { hydrations++; return { generation: 1, entries: [row(1, 20, 'latest')] }; },
    async *stream(_method, request) {
      requests.push(request.cursors.map(cursor => ({ ...cursor })));
      yield frame([omitted(1, 10), row(1, 20, 'latest')], [{ entryId: 'entry-2', updatedSeq: '11' }]);
    },
  });
  const events = await Array.fromAsync(watchBots(c, [bot], { resume: resume('9'), reconnect: true, initialBackoffMs: 1, signal: t.signal,
    onCursor: state => checkpoints.push(state.cursors[0].afterUpdatedSeq) }));
  assert.deepEqual(requests.map(cursors => cursors[0].afterUpdatedSeq), ['9']);
  assert.equal(hydrations, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'resyncRequired');
  assert.deepEqual(events[0].cursor, { generation: 1, afterUpdatedSeq: '9' });
  assert.match(events[0].message, /Reload conversation history/);
  assert.deepEqual(checkpoints, []);
});

test('watch ignores delayed rows and reset events from an older generation', async () => {
  const c = client({ async *stream() {
    yield frame([row(1, 10)]);
    yield frame([row(2, 100)], [], 0);
    yield { cleared: { agentId: bot.agentId, sessionId: bot.viewerSessionId, newGeneration: 0 } };
    yield { cursorTooOld: { agentId: bot.agentId, sessionId: bot.viewerSessionId, generation: 0 } };
    yield frame([row(3, 11)]);
  } });
  const events = await Array.fromAsync(watchBots(c, [bot], { resume: resume('9'), reconnect: false }));
  assert.deepEqual(events.map(event => event.updatedSeq), ['10', '11']);
});

test('hydration supports the final uint64 sequence without overflowing its history cursor', async () => {
  const seq = '18446744073709551615', requests = [];
  const c = client({
    rpc: async (_method, request) => { requests.push(request); return { generation: 1, entries: [row(seq, seq)] }; },
    async *stream() { yield frame([omitted(seq, seq)]); },
  });
  const result = await readTranscriptUpdates(c, bot, { generation: 1, afterUpdatedSeq: '0' });
  assert.equal(result.events[0].seq, seq);
  assert.equal(result.cursor.afterUpdatedSeq, seq);
  assert.equal(requests[0].beforeSeq, undefined);
});
