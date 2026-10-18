import test from 'node:test';
import assert from 'node:assert/strict';
import { sendBotMessage, listRooms, createRoom, setRoomMembers } from '../src/coordination.mjs';

const alpha = { agentId: 'alpha-id', viewerSessionId: 'alpha-session', name: 'Alpha', kind: 'GROK_BOT_AGENT_KIND_AGENT', viewerIsOwner: true };
const beta = { agentId: 'beta-id', name: 'Beta', kind: 1 };
const room = { agentId: 'room-id', name: 'Room', kind: 'GROK_BOT_AGENT_KIND_ROOM', memberAgentIds: ['alpha-id'] };
const capabilities = { agentMessagingEnabled: true, serverRoomsEnabled: true, temporalCreationEnabled: true,
  durableIdentityEnabled: true, durableIdentityWritesEnabled: true };

function mock(overrides = {}) {
  const calls = [];
  return {
    calls,
    async listBots() { return [alpha, beta, room, { ...room, agentId: 'numeric-room', kind: 2 }]; },
    async resolveBot(ref) {
      if (typeof ref === 'object') return ref;
      const match = [alpha, beta, room].filter(bot => [bot.agentId, bot.name].includes(ref));
      if (match.length !== 1) throw new Error('Unknown or ambiguous bot.');
      return match[0];
    },
    async rpc(method, body, options) {
      calls.push({ method, body, options });
      if (overrides[method]) return overrides[method](body, options);
      if (method === 'GetGrokBotRuntimeCapabilities') return { capabilities };
      if (method === 'CreateGrokBotRoom') return { agent: { ...room, agentId: body.agentId } };
      if (method === 'SetGrokBotRoomMembers') return { agent: { ...room, memberAgentIds: body.memberAgentIds } };
      return { delivery: 'GROK_BOT_AGENT_MESSAGE_DELIVERY_DELIVERED_TEMPORAL', targetAgentId: body.toAgentId };
    },
  };
}

test('bot send uses agent IDs, int64 timestamp, explicit correlation, and preserves delivery outcome', async () => {
  const client = mock({ SendGrokBotAgentMessage: () => ({ delivery: 'GROK_BOT_AGENT_MESSAGE_DELIVERY_FORBIDDEN' }) });
  const controller = new AbortController();
  const result = await sendBotMessage(client, 'Alpha', 'Beta', 'Discuss this', {
    messageId: 'message-123', sentAtMs: 1234, replyToId: 'reply-1', signal: controller.signal, timeoutMs: 7000,
  });
  assert.deepEqual(client.calls.map(call => call.method), ['GetGrokBotRuntimeCapabilities', 'SendGrokBotAgentMessage']);
  assert.deepEqual(client.calls[1].body, { fromAgentId: 'alpha-id', toAgentId: 'beta-id',
    messageId: 'message-123', text: 'Discuss this', sentAtMs: '1234', replyToId: 'reply-1' });
  assert.equal(client.calls[1].options.signal, controller.signal);
  assert.equal(client.calls[1].options.timeoutMs, 7000);
  assert.equal(result.delivery, 'GROK_BOT_AGENT_MESSAGE_DELIVERY_FORBIDDEN');
  assert.equal(result.messageId, 'message-123');
});

test('disabled capabilities prevent a bot send', async () => {
  const client = mock({ GetGrokBotRuntimeCapabilities: () => ({ capabilities: { agentMessagingEnabled: false } }) });
  await assert.rejects(sendBotMessage(client, 'Alpha', 'Beta', 'Hello'), /agentMessagingEnabled/);
  assert.deepEqual(client.calls.map(call => call.method), ['GetGrokBotRuntimeCapabilities']);
});

test('invalid identities, ownership and malformed input never send', async () => {
  const client = mock();
  await assert.rejects(sendBotMessage(client, 'Alpha', 'Alpha', 'Hi'), /different sender/);
  await assert.rejects(sendBotMessage(client, 'Alpha', 'Room', 'Hi'), /individual bot/);
  await assert.rejects(sendBotMessage(client, { ...alpha, viewerIsOwner: false, viewerCanManage: false }, 'Beta', 'Hi'), /cannot send/);
  await assert.rejects(sendBotMessage(client, 'Unknown', 'Beta', 'Hi'), /Unknown or ambiguous/);
  await assert.rejects(sendBotMessage(client, 'Alpha', 'Beta', ''), /nonempty/);
  await assert.rejects(sendBotMessage(client, 'Alpha', 'Beta', 'Hi', { sentAtMs: Number.MAX_SAFE_INTEGER + 1 }), /int64/);
  assert.equal(client.calls.length, 0);
});

test('failed sends are not automatically retried', async () => {
  const failure = new Error('Ambiguous network timeout.');
  const client = mock({ SendGrokBotAgentMessage: () => { throw failure; } });
  await assert.rejects(sendBotMessage(client, 'Alpha', 'Beta', 'Hello'), error => error === failure);
  assert.equal(client.calls.filter(call => call.method === 'SendGrokBotAgentMessage').length, 1);
});

test('room listing recognizes protobuf enum forms without confusing ordinary agents', async () => {
  assert.deepEqual((await listRooms(mock())).map(bot => bot.agentId), ['room-id', 'numeric-room']);
});

test('room creation resolves members and retains the requested identity', async () => {
  const client = mock();
  const result = await createRoom(client, { name: 'Working group', description: 'A project',
    agentId: 'new-room', members: ['Alpha', 'beta-id'], humanMemberUserIds: ['1'] });
  assert.equal(result.agentId, 'new-room');
  assert.deepEqual(client.calls[1].body, { agentId: 'new-room', name: 'Working group', description: 'A project',
    memberAgentIds: ['alpha-id', 'beta-id'], humanMemberUserIds: [1] });
  assert.equal(client.calls[1].options.timeoutMs, 45000);
});

test('room creation rejects duplicates, no members, conflicting IDs and unavailable durable creation', async () => {
  const client = mock();
  await assert.rejects(createRoom(client, { name: 'Room', members: ['Alpha', 'alpha-id'] }), /unique/);
  await assert.rejects(createRoom(client, { name: 'Room' }), /at least one/);
  await assert.rejects(createRoom(client, { name: 'Room', agentId: 'one', clientNonce: 'two' }), /same room/);
  await assert.rejects(createRoom(client, { name: 'Room', humanMemberUserIds: ['not-a-user-id'] }), /int32/);
  await assert.rejects(createRoom(client, { name: 'Room', humanMemberUserIds: [2147483648] }), /int32/);
  await assert.rejects(createRoom(client, { name: 'Room', humanMemberUserIds: ['1', 1] }), /unique/);
  assert.equal(client.calls.length, 0);
  const disabled = mock({ GetGrokBotRuntimeCapabilities: () => ({ capabilities: { ...capabilities, durableIdentityWritesEnabled: false } }) });
  await assert.rejects(createRoom(disabled, { name: 'Room', members: ['Alpha'] }), /durableIdentityWritesEnabled/);
  assert.equal(disabled.calls.length, 1);
});

test('creation identity mismatch is surfaced without retry', async () => {
  const client = mock({ CreateGrokBotRoom: () => ({ agent: room }) });
  await assert.rejects(createRoom(client, { name: 'Room', agentId: 'new-room', members: ['Alpha'] }), /may have succeeded/);
  assert.equal(client.calls.filter(call => call.method === 'CreateGrokBotRoom').length, 1);
});

test('set members replaces bot membership and preserves a room response', async () => {
  const client = mock();
  assert.deepEqual((await setRoomMembers(client, 'Room', ['Beta'])).memberAgentIds, ['beta-id']);
  assert.deepEqual(client.calls[1].body, { agentId: 'room-id', memberAgentIds: ['beta-id'] });
  await assert.rejects(setRoomMembers(client, 'Alpha', ['Beta']), /not a room/);
  const before = client.calls.length;
  await assert.rejects(setRoomMembers(client, 'Room', []), /at least one bot/);
  assert.equal(client.calls.length, before);
});
