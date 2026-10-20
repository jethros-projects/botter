import { randomUUID } from 'node:crypto';

const ROOM_KINDS = new Set([2, 'ROOM', 'GROK_BOT_AGENT_KIND_ROOM']);

function textValue(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
}

function rpcOptions(options, defaultTimeout = 30000) {
  return { ...(options.signal ? { signal: options.signal } : {}), timeoutMs: options.timeoutMs ?? defaultTimeout };
}

function assertManageable(bot, operation) {
  if (bot.viewerIsOwner === false && bot.viewerCanManage === false) {
    throw new Error(`The current account cannot ${operation} for ${bot.name || bot.agentId}.`);
  }
}

export function isRoom(bot) {
  return ROOM_KINDS.has(bot?.kind);
}

async function requireCapabilities(client, names, options) {
  const response = await client.rpc('GetGrokBotRuntimeCapabilities', {}, rpcOptions(options));
  const missing = names.filter(name => response.capabilities?.[name] !== true);
  if (missing.length) throw new Error(`The current Grok Bot account does not report these required capabilities: ${missing.join(', ')}.`);
}

async function resolveIndividual(client, ref, label) {
  const bot = await client.resolveBot(ref);
  textValue(bot?.agentId, `${label} agentId`);
  if (isRoom(bot)) throw new Error(`${label} must be an individual bot, not a room.`);
  return bot;
}

async function resolveMembers(client, refs) {
  if (!Array.isArray(refs)) throw new TypeError('members must be an array of bot names or IDs.');
  const members = [];
  for (const ref of refs) members.push((await resolveIndividual(client, ref, 'Room member')).agentId);
  if (new Set(members).size !== members.length) throw new Error('Room members must be unique.');
  return members;
}

function integerString(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= 9223372036854775807n) return value;
  throw new TypeError(`${label} must be a nonnegative int64 value.`);
}

/** Send as a selected accessible bot. Backend ownership and delivery checks remain authoritative. */
export async function sendBotMessage(client, fromBot, toBot, text, options = {}) {
  textValue(text, 'text');
  const messageId = textValue(options.messageId ?? randomUUID(), 'messageId');
  const sentAtMs = integerString(options.sentAtMs ?? Date.now(), 'sentAtMs');
  if (options.replyToId !== undefined) textValue(options.replyToId, 'replyToId');
  const from = await resolveIndividual(client, fromBot, 'Sender');
  const to = await resolveIndividual(client, toBot, 'Recipient');
  if (from.agentId === to.agentId) throw new Error('Choose different sender and recipient bots.');
  assertManageable(from, 'send messages');
  await requireCapabilities(client, ['agentMessagingEnabled'], options);
  const response = await client.rpc('SendGrokBotAgentMessage', {
    fromAgentId: from.agentId, toAgentId: to.agentId, messageId, text, sentAtMs,
    ...(options.replyToId !== undefined ? { replyToId: options.replyToId } : {}),
  }, rpcOptions(options));
  return { ...response, messageId };
}

export async function listRooms(client) {
  return (await client.listBots()).filter(isRoom);
}

/** Create a server-hosted room with a stable caller-supplied identity when provided. Never retries. */
export async function createRoom(client, options = {}) {
  const name = textValue(options.name, 'name');
  if (options.members !== undefined && options.memberAgentIds !== undefined) {
    throw new TypeError('Specify members or memberAgentIds, not both.');
  }
  if (options.description !== undefined && typeof options.description !== 'string') throw new TypeError('description must be a string.');
  if (options.agentId !== undefined && options.clientNonce !== undefined && options.agentId !== options.clientNonce) {
    throw new Error('agentId and clientNonce must identify the same room.');
  }
  const agentId = textValue(options.agentId ?? options.clientNonce ?? randomUUID(), 'agentId');
  const inputHumans = options.humanMemberUserIds ?? [];
  if (!Array.isArray(inputHumans)) throw new TypeError('humanMemberUserIds must be an array.');
  const humans = inputHumans.map(id => typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id);
  if (humans.some(id => !Number.isInteger(id) || id <= 0 || id > 2147483647)) {
    throw new TypeError('humanMemberUserIds must be an array of positive int32 user IDs.');
  }
  if (new Set(humans).size !== humans.length) throw new Error('Human room members must be unique.');
  const members = await resolveMembers(client, options.members ?? options.memberAgentIds ?? []);
  if (members.length + humans.length === 0) throw new Error('A room needs at least one bot or human member.');
  await requireCapabilities(client, ['serverRoomsEnabled', 'temporalCreationEnabled',
    'durableIdentityEnabled', 'durableIdentityWritesEnabled'], options);
  const response = await client.rpc('CreateGrokBotRoom', {
    agentId, name, description: options.description ?? '', memberAgentIds: members,
    ...(humans.length ? { humanMemberUserIds: [...humans] } : {}),
  }, rpcOptions(options, 45000));
  if (response.agent?.agentId !== agentId || !isRoom(response.agent)) {
    throw new Error(`Room creation returned an unexpected identity or kind. The request may have succeeded; inspect the roster before retrying. Requested room ID: ${agentId}`);
  }
  return response.agent;
}

/** Replace the complete bot membership list. Human membership is a separate server operation. */
export async function setRoomMembers(client, room, members, options = {}) {
  if (Array.isArray(members) && members.length === 0) {
    throw new TypeError('Supply at least one bot member; this helper cannot verify the human membership required for an empty bot list.');
  }
  const target = await client.resolveBot(room);
  textValue(target?.agentId, 'Room agentId');
  if (!isRoom(target)) throw new Error('The selected bot is not a room.');
  assertManageable(target, 'change room members');
  const memberAgentIds = await resolveMembers(client, members);
  await requireCapabilities(client, ['serverRoomsEnabled'], options);
  const response = await client.rpc('SetGrokBotRoomMembers', { agentId: target.agentId, memberAgentIds }, rpcOptions(options));
  if (response.agent?.agentId !== target.agentId || !isRoom(response.agent)) {
    throw new Error('Room membership returned an unexpected identity or kind. Inspect the roster before retrying.');
  }
  return response.agent;
}
