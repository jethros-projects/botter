import test from 'node:test';
import assert from 'node:assert/strict';
import * as f from '../src/features.mjs';
import { readTranscriptUpdates, scanHistory, watchBots } from '../src/conversations.mjs';

const bot = { agentId: 'agent-a', id: 'legacy-a', name: 'Alpha', viewerSessionId: 'session-a' };
function mock() {
  const calls = [];
  return { calls, resolveBot: async value => typeof value === 'object' ? value : bot,
    listBots: async () => [bot, { agentId: 'agent-b' }],
    rpc: async (method, body, options) => { calls.push({ method, body, options }); return { ok: true }; } };
}

test('stop, prior-send status and account statuses use exact scoped requests', async () => {
  const c = mock();
  await f.stopRun(c, 'Alpha', { reason: 'User asked to stop', sessionId: 'chosen' });
  await f.getSendStatus(c, 'Alpha', 'message');
  await f.getBotStatuses(c, 'all');
  assert.deepEqual(c.calls.map(x => [x.method, x.body]), [
    ['InterruptGrokBotAgentRun', { agentId: 'agent-a', reason: 'User asked to stop', sessionId: 'chosen' }],
    ['GetGrokBotSendStatus', { agentId: 'agent-a', messageId: 'message', sessionId: 'session-a' }],
    ['ListGrokBotAgentStatuses', { agentIds: ['agent-a', 'agent-b'] }],
  ]);
});
test('task helpers distinguish agent tasks from session tasks and preserve false', async () => {
  const c = mock();
  await f.listBotTasks(c, 'Alpha', { includeRecentlyDone: false });
  await f.listBotTasks(c, 'Alpha', { sessionId: '' });
  await f.listBotTodos(c, 'Alpha'); await f.listBotSubagents(c, 'Alpha');
  await f.markTaskDone(c, 'Alpha', 'task'); await f.markTaskRead(c, 'Alpha', 'task', 'entry');
  await f.setTaskPinned(c, 'Alpha', 'task', false);
  await f.dismissTask(c, 'Alpha', 'task'); await f.markTasksSeen(c, 'Alpha', ['task']);
  assert.deepEqual(c.calls[0].body, { agentId: 'agent-a', includeRecentlyDone: false });
  assert.deepEqual(c.calls[1].body, { agentId: 'agent-a', sessionId: '' });
  assert.equal(c.calls[1].method, 'ListGrokBotTasks');
  assert.deepEqual(c.calls[6].body, { agentId: 'agent-a', taskId: 'task', pinned: false });
  assert.deepEqual(c.calls[8].body, { agentId: 'agent-a', sessionId: 'session-a', taskIds: ['task'] });
  await assert.rejects(f.listBotTasks(c, 'Alpha', { sessionId: '', includeRecentlyDone: true }), /does not apply/);
});
test('bot CRUD distinguishes server record IDs for update from UUIDs for delete/main', async () => {
  const c = mock();
  await f.createBot(c, { name: 'New', harness: 'TEMPORAL' });
  assert.match(c.calls[0].body.agentId, /^[a-f0-9-]{36}$/);
  assert.equal(c.calls[0].body.harness, 'GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL');
  await f.updateBot(c, 'Alpha', { name: 'Renamed', description: '' });
  assert.deepEqual(c.calls[1].body, { id: 'legacy-a', name: 'Renamed', description: '', partialUpdate: true });
  await f.deleteBot(c, 'Alpha'); await f.setMainBot(c, 'Alpha');
  assert.deepEqual(c.calls.slice(2).map(x => [x.method, x.body]), [
    ['DeleteGrokBotAgent', { id: 'agent-a' }], ['SetGrokBotMainAgent', { agentId: 'agent-a' }],
  ]);
  const before = c.calls.length;
  await assert.rejects(f.updateBot(c, 'Alpha', { id: 'other' }), /override/);
  const missingServerId = { ...c, resolveBot: async () => ({ agentId: 'agent-a' }) };
  await assert.rejects(f.updateBot(missingServerId, 'Alpha', { name: 'Renamed' }), /server record id/);
  await assert.rejects(f.createBot(c, { name: 'New', madeUp: true }), /unknown field/i);
  assert.equal(c.calls.length, before);
});
test('client state and runtime settings reject unknown fields and preserve explicit false', async () => {
  const c = mock();
  await f.setBotClientState(c, 'Alpha', { markUnread: true, notificationsEnabled: false });
  await f.getRuntimeSettings(c);
  await f.updateRuntimeSettings(c, { hasSeenOnboarding: false });
  assert.deepEqual(c.calls[0].body, { agentId: 'agent-a', markUnread: true, notificationsEnabled: false });
  assert.deepEqual(c.calls[2].body, { hasSeenOnboarding: false });
  await assert.rejects(f.setBotClientState(c, 'Alpha', { markRead: true, markUnread: true }), /both/);
  await assert.rejects(f.updateRuntimeSettings(c, { unsupported: true }), /unknown field/i);
});
test('skills and room people use exact field types and reject identity overrides', async () => {
  const c = mock();
  await f.listBotSkills(c, 'Alpha');
  await f.writeBotSkill(c, 'Alpha', { name: 'review', description: '', content: '# Steps' });
  await f.writeBotSkill(c, 'Alpha', { name: 'review', content: '# New' }, { update: true });
  await f.removeBotSkill(c, 'Alpha', 'review');
  assert.equal(c.calls[2].method, 'UpdateGrokBotAgentSkill');
  assert.deepEqual(c.calls[1].body, { agentId: 'agent-a', name: 'review', description: '', content: '# Steps' });
  await f.changeRoomPeople(c, { ...bot, kind: 'ROOM' }, [123], { remove: true });
  assert.deepEqual(c.calls[4].body, { agentId: 'agent-a', userIds: [123] });
  assert.equal(c.calls[4].method, 'RemoveGrokBotRoomPeople');
  await assert.rejects(f.changeRoomPeople(c, bot, [123]), /not a room/);
  await assert.rejects(f.changeRoomPeople(c, { ...bot, kind: 'ROOM' }, [2147483648]), /int32/);
  await assert.rejects(f.writeBotSkill(c, 'Alpha', { agentId: 'other', name: 'x', content: 'x' }), /override/);
});
test('feature mutations propagate uncertain failures without retry', async () => {
  const c = mock(), failure = new Error('uncertain');
  c.rpc = async () => { c.calls.push(1); throw failure; };
  await assert.rejects(f.deleteBot(c, 'Alpha'), error => error === failure);
  assert.equal(c.calls.length, 1);
});
test('bounded transcript updates preserve unconsumed events for the next cursor', async () => {
  const c = mock();
  const body = value => Buffer.from(JSON.stringify({ id: `entry-${value}`, content: String(value) })).toString('base64');
  c.stream = async function* (_method, request) {
    assert.equal(request.cursors[0].afterUpdatedSeq, '3');
    yield { connected: {} };
    yield { rows: { agentId: 'agent-a', sessionId: 'session-a', generation: 2, entries: [
      { seq: '4', updatedSeq: '4', body: body(4) }, { seq: '5', updatedSeq: '6', body: body(5) },
    ], deletes: [{ entryId: 'deleted', updatedSeq: '5' }] } };
  };
  const result = await readTranscriptUpdates(c, 'Alpha', { generation: 2, afterUpdatedSeq: '3', maxEvents: 2 });
  assert.deepEqual(result.events.map(e => [e.type, e.updatedSeq]), [['entry', '4'], ['delete', '5']]);
  assert.deepEqual(result.cursor, { generation: 2, afterUpdatedSeq: '5' });
  assert.equal(result.truncated, true);
});
test('scan forwards requested generation on every page and rejects unsafe integer cursors', async () => {
  const c = mock();
  c.rpc = async (method, body) => { c.calls.push({ method, body }); return { generation: 4, entries: c.calls.length === 1 ? [{ seq: '7' }] : [] }; };
  await scanHistory(c, 'Alpha', { generation: 4, beforeSeq: '8', unreadBoundaryMs: '123', pageSize: 1 });
  assert.equal(c.calls[0].body.beforeSeq, '8');
  assert.equal(c.calls[1].body.beforeSeq, '7');
  assert.equal(c.calls[1].body.generation, 4);
  assert.equal(c.calls[1].body.unreadBoundaryMs, '123');
  await assert.rejects(scanHistory(c, 'Alpha', { beforeSeq: Number.MAX_SAFE_INTEGER + 1 }), /decimal strings/);
});
test('watch can deliver rows from explicitly included unlisted agents', async () => {
  const c = mock(); c.accountFingerprint = async () => 'account';
  c.rpc = async () => ({ generation: 0, entries: [] });
  c.stream = async function* (_method, request) {
    assert.equal(request.includeUnlistedAgents, true);
    assert.equal(request.inlineBodyMaxBytes, 100);
    yield { rows: { agentId: 'unlisted', sessionId: 'other', generation: 1, entries: [{ seq: '1', updatedSeq: '1' }] } };
  };
  const rows = await Array.fromAsync(watchBots(c, ['Alpha'], { includeUnlistedAgents: true, inlineBodyMaxBytes: 100, reconnect: false }));
  assert.equal(rows.length, 1); assert.equal(rows[0].agentId, 'unlisted');
});
