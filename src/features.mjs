import { randomUUID } from 'node:crypto';
import { sessionFor } from './client.mjs';
import { isRoom } from './coordination.mjs';
import { resolveApiMethod, validateApiRequest } from './schema.mjs';

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
}
function object(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new TypeError(`${label} must be a JSON object.`);
  return value;
}
async function call(client, method, body, options = {}) {
  const descriptor = resolveApiMethod(method, { service: 'GrokBotService' });
  const validated = validateApiRequest(descriptor, body);
  return client.rpc(method, validated, { ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
}
async function botId(client, bot) {
  return text((await client.resolveBot(bot)).agentId, 'agentId');
}
async function serverRecordId(client, bot) {
  return text((await client.resolveBot(bot)).id, 'bot server record id');
}

export async function stopRun(client, bot, { reason = 'Stopped by the user.', sessionId, ...options } = {}) {
  const resolved = await client.resolveBot(bot);
  return call(client, 'InterruptGrokBotAgentRun', { agentId: text(resolved.agentId, 'agentId'), reason: text(reason, 'reason'),
    sessionId: sessionFor(resolved, sessionId) }, options);
}
export async function getSendStatus(client, bot, messageId, { sessionId, ...options } = {}) {
  const resolved = await client.resolveBot(bot);
  return call(client, 'GetGrokBotSendStatus', { agentId: text(resolved.agentId, 'agentId'),
    messageId: text(messageId, 'messageId'), sessionId: sessionFor(resolved, sessionId) }, options);
}
export async function getBotStatuses(client, bot, options = {}) {
  const agentIds = bot === undefined || bot === 'all'
    ? (await client.listBots()).map(value => text(value.agentId, 'agentId')) : [await botId(client, bot)];
  return call(client, 'ListGrokBotAgentStatuses', { agentIds }, options);
}
export async function listBotTasks(client, bot, { includeRecentlyDone, sessionId, ...options } = {}) {
  const resolved = await client.resolveBot(bot), agentId = text(resolved.agentId, 'agentId');
  if (sessionId !== undefined) {
    if (includeRecentlyDone !== undefined) throw new TypeError('includeRecentlyDone does not apply to session tasks.');
    return call(client, 'ListGrokBotTasks', { agentId, sessionId }, options);
  }
  return call(client, 'ListGrokBotAgentTasks', { agentId,
    ...(includeRecentlyDone === undefined ? {} : { includeRecentlyDone }) }, options);
}
export async function listBotTodos(client, bot, options = {}) {
  return call(client, 'ListGrokBotAgentTodos', { agentId: await botId(client, bot) }, options);
}
export async function listBotSubagents(client, bot, options = {}) {
  return call(client, 'ListGrokBotSubagents', { agentId: await botId(client, bot) }, options);
}
export async function markTaskDone(client, bot, taskId, options = {}) {
  return call(client, 'MarkGrokBotAgentTaskDone', { agentId: await botId(client, bot), taskId: text(taskId, 'taskId') }, options);
}
export async function markTaskRead(client, bot, taskId, entryId, options = {}) {
  return call(client, 'MarkGrokBotAgentTaskRead', { agentId: await botId(client, bot), taskId: text(taskId, 'taskId'), entryId: text(entryId, 'entryId') }, options);
}
export async function setTaskPinned(client, bot, taskId, pinned, options = {}) {
  return call(client, 'SetGrokBotAgentTaskPinned', { agentId: await botId(client, bot), taskId: text(taskId, 'taskId'), pinned }, options);
}
export async function dismissTask(client, bot, taskId, { sessionId, ...options } = {}) {
  const resolved = await client.resolveBot(bot);
  return call(client, 'DismissGrokBotTask', { agentId: text(resolved.agentId, 'agentId'),
    sessionId: sessionFor(resolved, sessionId), taskId: text(taskId, 'taskId') }, options);
}
export async function markTasksSeen(client, bot, taskIds, { sessionId, ...options } = {}) {
  if (!Array.isArray(taskIds) || !taskIds.length) throw new TypeError('Supply at least one taskId.');
  const resolved = await client.resolveBot(bot);
  return call(client, 'MarkGrokBotTasksSeen', { agentId: text(resolved.agentId, 'agentId'),
    sessionId: sessionFor(resolved, sessionId), taskIds: taskIds.map(value => text(value, 'taskId')) }, options);
}
export async function setBotClientState(client, bot, state, options = {}) {
  const fields = object(state, 'state');
  if (Object.hasOwn(fields, 'agentId')) throw new TypeError('state must not override agentId.');
  if (fields.markRead && fields.markUnread) throw new TypeError('markRead and markUnread cannot both be true.');
  return call(client, 'SetGrokBotAgentClientState', { agentId: await botId(client, bot), ...fields }, options);
}
export async function createBot(client, spec, options = {}) {
  const fields = object(spec, 'spec');
  text(fields.name, 'name');
  return call(client, 'CreateGrokBotAgent', { ...fields, agentId: fields.agentId ?? randomUUID() }, options);
}
export async function updateBot(client, bot, patch, options = {}) {
  const fields = object(patch, 'patch');
  if (Object.hasOwn(fields, 'id')) throw new TypeError('patch must not override id.');
  // Native updateIdentity takes the roster record's serverId (GrokBotAgent.id).
  return call(client, 'UpdateGrokBotAgent', { ...fields, id: await serverRecordId(client, bot), partialUpdate: fields.partialUpdate ?? true }, options);
}
export async function deleteBot(client, bot, options = {}) {
  // Native performServerAgentAction('deleteAgent') instead passes the agent UUID.
  return call(client, 'DeleteGrokBotAgent', { id: await botId(client, bot) }, options);
}
export async function setMainBot(client, bot, options = {}) {
  return call(client, 'SetGrokBotMainAgent', { agentId: await botId(client, bot) }, options);
}
export async function getRuntimeSettings(client, options = {}) {
  return call(client, 'GetGrokBotUserRuntimeSettings', {}, options);
}
export async function updateRuntimeSettings(client, patch, options = {}) {
  return call(client, 'UpdateGrokBotUserRuntimeSettings', object(patch, 'patch'), options);
}
export async function listBotSkills(client, bot, options = {}) {
  return call(client, 'ListGrokBotAgentSkills', { agentId: await botId(client, bot) }, options);
}
export async function writeBotSkill(client, bot, skill, { update = false, ...options } = {}) {
  const fields = object(skill, 'skill');
  if (Object.hasOwn(fields, 'agentId')) throw new TypeError('skill must not override agentId.');
  text(fields.name, 'skill.name'); text(fields.content, 'skill.content');
  return call(client, update ? 'UpdateGrokBotAgentSkill' : 'AddGrokBotAgentSkill',
    { agentId: await botId(client, bot), ...fields }, options);
}
export async function removeBotSkill(client, bot, name, options = {}) {
  return call(client, 'RemoveGrokBotAgentSkill', { agentId: await botId(client, bot), name: text(name, 'skill.name') }, options);
}
export async function changeRoomPeople(client, room, userIds, { remove = false, ...options } = {}) {
  if (!Array.isArray(userIds) || !userIds.length || userIds.some(id => !Number.isInteger(id) || id <= 0 || id > 2147483647)) {
    throw new TypeError('userIds must be a nonempty array of positive int32 user IDs.');
  }
  if (new Set(userIds).size !== userIds.length) throw new TypeError('userIds must be unique.');
  const resolved = await client.resolveBot(room);
  if (!isRoom(resolved)) throw new TypeError('The selected bot is not a room.');
  return call(client, remove ? 'RemoveGrokBotRoomPeople' : 'AddGrokBotRoomPeople',
    { agentId: text(resolved.agentId, 'agentId'), userIds }, options);
}
