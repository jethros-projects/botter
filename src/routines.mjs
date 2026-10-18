// Native routine controls verified against Grok Bot 0.71.2's bundled protocol.
// A routine's record.id is its local ID; the enclosing automationId is the
// server ID. Controls use the former; webhook credential provisioning uses the latter.
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { sendMessage } from './conversations.mjs';

const DEFAULT_BACKEND = 'https://api2.cursor.sh';
const DEFAULT_TIMEOUT = 20_000;
const MAX_WEBHOOK_BYTES = 1024 * 1024;

function computerOwned(bot) {
  return bot.harness === 'box';
}
function requireComputerOwned(bot) {
  if (!computerOwned(bot)) {
    const error = new Error(bot.harness === 'temporal'
      ? 'This bot is server-owned. Use requestRoutineCreation or routine-create --via-bot for native creation. Gateway creation would create a separate local routine.'
      : 'The bot runtime is unknown; gateway routine mutations require a verified box runtime.');
    error.code = bot.harness === 'temporal' ? 'server_owned_routine' : 'unknown_bot_runtime'; throw error;
  }
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string.`);
  return value;
}

function callOptions({ signal, timeoutMs = DEFAULT_TIMEOUT, timeZone } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new RangeError('timeoutMs must be an integer from 1 to 300000.');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
  if (timeZone !== undefined) {
    text(timeZone, 'timeZone');
    try { new Intl.DateTimeFormat('en', { timeZone }); }
    catch { throw new RangeError('timeZone must be a valid IANA time zone.'); }
  }
  return { signal, timeoutMs };
}

function zoneBody(options) {
  return options.timeZone === undefined ? {} : { timeZone: options.timeZone };
}

function protocolError(message) {
  const error = new Error(message);
  error.code = 'invalid_routine_response';
  return error;
}

async function resolve(client, bot) {
  let resolved = await client.resolveBot(bot);
  text(resolved?.agentId, 'bot.agentId');
  // Raw objects bypass resolveBot's account lookup. Refresh their ownership so
  // stale or caller-supplied harness metadata cannot select the wrong store.
  if (typeof bot === 'object' && typeof client.listBots === 'function') {
    resolved = (await client.listBots()).find(candidate => candidate.agentId === resolved.agentId);
    if (!resolved) throw new Error('Bot is not in the current account.');
  }
  return resolved;
}

function decodeRows(rows, bot) {
  if (!Array.isArray(rows)) throw protocolError('Routine response is missing its automations array.');
  return rows.map(row => {
    let record;
    try { record = JSON.parse(row.recordJson); }
    catch { throw protocolError('Routine response contains an unreadable record.'); }
    if (!record || Array.isArray(record) || typeof record !== 'object'
      || typeof record.id !== 'string' || !record.id
      || typeof record.name !== 'string' || typeof record.prompt !== 'string'
      || !record.trigger || Array.isArray(record.trigger) || typeof record.trigger !== 'object'
      || typeof record.isEnabled !== 'boolean' || typeof record.createdAt !== 'number'
      || !Number.isFinite(record.createdAt) || typeof row.automationId !== 'string') {
      throw protocolError('Routine response contains an invalid record.');
    }
    return { ...record, agentId: bot.agentId, botName: bot.name ?? '', serverAutomationId: row.automationId };
  }).sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.createdAt - b.createdAt);
}

async function listForBot(client, bot, options) {
  if (computerOwned(bot, options)) {
    return gatewayRows(await gateway(options).rpcGateway('getAgentAutomations', { id: bot.agentId }, callOptions(options)), bot);
  }
  const response = await client.rpc('ListGrokBotAgentAutomations', {
    agentId: bot.agentId, ...zoneBody(options),
  }, callOptions(options));
  return decodeRows(response.automations ?? [], bot);
}

/** List one bot's routines, or account routines when bot is omitted.
 * Unavailable groups are represented explicitly so they are never silently lost.
 */
export async function listRoutines(client, options = {}) {
  callOptions(options);
  if (options.bot !== undefined) return listForBot(client, await resolve(client, options.bot), options);
  const bots = await client.listBots();
  const byId = new Map(bots.map(bot => [bot.agentId, bot]));
  const response = await client.rpc('ListGrokBotAccountAutomations', {
    agentIds: [...byId.keys()], ...zoneBody(options),
  }, callOptions(options));
  if (!Array.isArray(response.agents)) throw protocolError('Account routine response is missing its agents array.');
  const routines = [];
  for (const group of response.agents) {
    if (!group || typeof group.agentId !== 'string' || !byId.has(group.agentId)) {
      throw protocolError('Account routine response contains an unknown bot.');
    }
    const bot = byId.get(group.agentId);
    const rows = group.automations ?? [];
    if (!Array.isArray(rows) || (group.unavailable || group.readIndividually) && rows.length
      || group.unavailable && group.readIndividually) {
      throw protocolError('Account routine response contains contradictory availability flags.');
    }
    if (group.unavailable) routines.push({ agentId: bot.agentId, botName: bot.name ?? '', unavailable: true });
    else if (group.readIndividually) routines.push(...await listForBot(client, bot, options));
    else routines.push(...decodeRows(rows, bot));
  }
  return routines;
}

/** Enable/disable a routine by its record.id. Performs one write, never retries. */
export async function setRoutineEnabled(client, bot, id, enabled, options = {}) {
  text(id, 'routine id');
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
  const rpcOptions = callOptions(options);
  const resolved = await resolve(client, bot);
  if (computerOwned(resolved, options)) {
    return gatewayRows(await gateway(options).rpcGateway('setAgentAutomationEnabled', {
      id: resolved.agentId, automationId: id, isEnabled: enabled,
    }, rpcOptions), resolved);
  }
  const response = await client.rpc('SetGrokBotAgentAutomationEnabled', {
    agentId: resolved.agentId, automationId: id, isEnabled: enabled, ...zoneBody(options),
  }, rpcOptions);
  return decodeRows(response.automations ?? [], resolved);
}

function hasWebhook(trigger) {
  return trigger.type === 'webhook'
    || trigger.type === 'group' && Array.isArray(trigger.listeners)
      && trigger.listeners.some(listener => listener && listener.type === 'webhook');
}

function backendOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/') throw new TypeError('backendUrl must be an HTTPS origin.');
  return url.origin;
}

/** Provision a NEW webhook key after confirming the routine has a webhook trigger.
 * This is a mutation, not a secret read. The library returns the key to its caller
 * and never logs or persists it. Do not call as part of listing/inspection.
 */
export async function getWebhookCredential(client, bot, id, options = {}) {
  text(id, 'routine id');
  const rpcOptions = callOptions(options);
  const origin = backendOrigin(options.backendUrl ?? client.baseUrl ?? DEFAULT_BACKEND);
  const resolved = await resolve(client, bot);
  const routines = await listForBot(client, resolved, options);
  const matches = routines.filter(routine => routine.id === id);
  if (matches.length !== 1) throw new Error(matches.length ? 'Routine ID is ambiguous.' : 'Routine not found.');
  const routine = matches[0];
  if (!hasWebhook(routine.trigger)) throw new Error('Routine is not webhook-triggered.');
  if (computerOwned(resolved, options)) {
    const transport = gateway(options);
    const attempts = options.provisionAttempts ?? 15;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 30) throw new Error('provisionAttempts must be 1–30.');
    for (let i = 0; i < attempts; i++) {
      const result = await transport.rpcGateway('getAutomationWebhookCredential', { id: resolved.agentId, automationId: id }, rpcOptions);
      if (typeof result?.url !== 'string' || !result.url || result.key !== null && typeof result.key !== 'string') throw protocolError('Invalid gateway webhook credential response.');
      if (result.key) return { ...result, agentId: resolved.agentId, automationId: id, source: 'gateway' };
      if (i + 1 < attempts) await new Promise((resolve, reject) => {
        const timer = setTimeout(done, options.provisionPollMs ?? 2000);
        function done() { options.signal?.removeEventListener('abort', abort); resolve(); }
        function abort() { clearTimeout(timer); reject(options.signal.reason); }
        if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error('Gateway webhook credential is still provisioning. Retry credential lookup later.');
  }
  text(routine.serverAutomationId, 'server routine id');
  const response = await client.rpc('CreateAutomationWebhookApiKey', {
    automationId: routine.serverAutomationId,
  }, { ...rpcOptions, service: 'DashboardService' });
  if (typeof response.apiKey !== 'string' || !response.apiKey) {
    throw protocolError('Webhook provisioning returned no API key.');
  }
  return {
    agentId: resolved.agentId, automationId: id, serverAutomationId: routine.serverAutomationId,
    url: new URL(`/automations/webhook/${encodeURIComponent(routine.serverAutomationId)}`, origin).toString(),
    key: response.apiKey,
  };
}

export async function deleteRoutine(client, bot, id, options = {}) {
  text(id, 'routine id'); const resolved = await resolve(client, bot);
  if (computerOwned(resolved, options)) return gatewayRows(await gateway(options).rpcGateway('deleteAgentAutomation',
    { id: resolved.agentId, automationId: id }, callOptions(options)), resolved);
  const response = await client.rpc('DeleteGrokBotAgentAutomation', { agentId: resolved.agentId, automationId: id, ...zoneBody(options) }, callOptions(options));
  return decodeRows(response.automations ?? [], resolved);
}

/** Trigger a native webhook once. Uses only its dedicated key, never app login headers. */
export async function fireWebhook({ url, key, payload = {}, signal, timeoutMs = DEFAULT_TIMEOUT,
  fetchImpl = globalThis.fetch } = {}) {
  const options = callOptions({ signal, timeoutMs });
  const endpoint = new URL(text(url, 'url'));
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search
    || endpoint.hash || !/^\/automations\/webhook\/[^/]+$/.test(endpoint.pathname)) {
    throw new TypeError('url must be an HTTPS native routine webhook URL without credentials, query, or fragment.');
  }
  text(key, 'key');
  if (/[\r\n]/.test(key)) throw new TypeError('key must not contain line breaks.');
  const body = JSON.stringify(payload);
  if (body === undefined) throw new TypeError('payload must be JSON serializable.');
  if (Buffer.byteLength(body) > MAX_WEBHOOK_BYTES) throw new RangeError('Webhook payload exceeds 1 MiB.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
  const requestSignal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
    : AbortSignal.timeout(options.timeoutMs);
  const response = await fetchImpl(endpoint.toString(), {
    method: 'POST', redirect: 'error', signal: requestSignal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body,
  });
  if (!response.ok) {
    await response.body?.cancel();
    // Error bodies may echo credentials or payloads; do not expose them.
    const error = new Error(`Routine webhook failed (HTTP ${response.status}); it was not retried.`);
    error.status = response.status;
    throw error;
  }
  const responseText = await response.text();
  if (Buffer.byteLength(responseText) > MAX_WEBHOOK_BYTES) throw new RangeError('Webhook response exceeds 1 MiB.');
  let result;
  try { result = responseText ? JSON.parse(responseText) : null; }
  catch { result = responseText; }
  return { status: response.status, result };
}

const GITHUB_EVENTS = ['pr-opened', 'pr-pushed', 'pr-merged', 'pr-closed', 'review-requested',
  'review-approved', 'review-changes-requested', 'review-commented', 'pr-comment',
  'inline-review-comment', 'review-thread-resolved', 'review-thread-unresolved', 'issue-assigned', 'ci-passed', 'ci-failed'];
const ORIGIN_EVENTS = GITHUB_EVENTS.filter(event => event !== 'pr-closed' && event !== 'issue-assigned');
const SENTRY_EVENTS = ['issueCreated', 'issueResolved', 'issueAssigned', 'issueArchived', 'issueUnresolved', 'issueAny'];
const PAGERDUTY_EVENTS = ['incidentTriggered', 'incidentAcknowledged', 'incidentResolved', 'incidentEscalated', 'incidentAny'];

function fieldString(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  return value;
}
function fieldBoolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
  return value;
}
function fieldNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number.`);
  return value;
}
const optional = validate => ({ optional: true, validate });
const oneOf = values => (value, label) => {
  if (!values.includes(value)) throw new TypeError(`${label} has an unsupported value.`);
  return value;
};
const arrayOf = validate => (value, label) => {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value.map((entry, index) => validate(entry, `${label}[${index}]`));
};
const strings = arrayOf(fieldString);

function shape(value, fields, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be an object.`);
  for (const name of Object.keys(value)) {
    if (!Object.hasOwn(fields, name)) throw new TypeError(`${label}.${name} is not a supported field.`);
  }
  const result = {};
  for (const [name, definition] of Object.entries(fields)) {
    if (definition.optional && value[name] === undefined) continue;
    result[name] = (definition.validate ?? definition)(value[name], `${label}.${name}`);
  }
  return result;
}

function slackMatch(value, label) {
  const variants = {
    mention: { kind: oneOf(['mention']) },
    keyword: { kind: oneOf(['keyword']), keyword: text },
    message: { kind: oneOf(['message']) },
    reaction: { kind: oneOf(['reaction']), emoji: optional(strings), bySelf: optional(fieldBoolean) },
  };
  const fields = Object.hasOwn(variants, value?.kind) ? variants[value.kind] : undefined;
  if (!fields) throw new TypeError(`${label}.kind has an unsupported value.`);
  return shape(value, fields, label);
}

function linearEvent(value, label) {
  const variants = {
    issueCreated: { case: oneOf(['issueCreated']) },
    statusChanged: { case: oneOf(['statusChanged']), statusIds: strings },
    endOfCycle: { case: oneOf(['endOfCycle']), cycleIds: strings },
  };
  const fields = Object.hasOwn(variants, value?.case) ? variants[value.case] : undefined;
  if (!fields) throw new TypeError(`${label}.case has an unsupported value.`);
  return shape(value, fields, label);
}

function trigger(value, label = 'spec.trigger', grouped = false) {
  const type = value?.type;
  if (type === 'group') {
    if (grouped) throw new TypeError('Nested trigger groups are not supported.');
    const parsed = shape(value, { type: oneOf(['group']), listeners: arrayOf((entry, entryLabel) => trigger(entry, entryLabel, true)) }, label);
    if (parsed.listeners.length < 2) throw new TypeError('A trigger group must have at least two listeners.');
    return parsed;
  }
  const variants = {
    webhook: {},
    cron: { schedule: text, firesAt: optional(fieldString), window: optional((entry, entryLabel) => shape(entry,
      { earlyMinutes: fieldNumber, lateMinutes: fieldNumber }, entryLabel)), timing: optional(oneOf(['exact', 'flexible'])) },
    email: { inbox: text, from: optional(strings), requireAuthPass: optional(fieldBoolean) },
    slack: { channel: text, match: slackMatch },
    github: { repo: text, events: arrayOf(oneOf(GITHUB_EVENTS)), pr: optional(fieldNumber), userAllowlist: optional(strings), ciBranch: optional(fieldString) },
    origin: { repo: text, events: arrayOf(oneOf(ORIGIN_EVENTS)), pr: optional(fieldNumber), userAllowlist: optional(strings) },
    microsoftTeams: { tenantId: fieldString, teamIds: strings, channelIds: strings, messageContains: fieldString,
      messageContainsIsRegex: fieldBoolean, blockUnauthenticatedTeamsUsers: fieldBoolean },
    linear: { event: linearEvent, projectIds: strings, teamIds: strings },
    sentry: { event: (entry, entryLabel) => shape(entry, { case: oneOf(SENTRY_EVENTS) }, entryLabel), projectIds: strings },
    pagerduty: { event: (entry, entryLabel) => shape(entry, { case: oneOf(PAGERDUTY_EVENTS) }, entryLabel), serviceIds: strings },
  };
  const fields = Object.hasOwn(variants, type) ? variants[type] : undefined;
  if (!fields) throw new TypeError(`${label}.type has an unsupported value.`);
  return shape(value, { type: oneOf([type]), ...fields }, label);
}

/** Validate and copy the exact native automation spec shape declared by 0.71.2. */
export function validateRoutineSpec(spec) {
  return shape(spec, { name: text, prompt: text, trigger, isEnabled: optional(fieldBoolean) }, 'spec');
}

function gateway(options) {
  if (!options.gatewayClient || typeof options.gatewayClient.rpcGateway !== 'function') {
    const error = new Error('This operation needs an existing authenticated Grok Bot gateway descriptor. Supply options.gatewayClient from createGatewayClient; no computer is started automatically.');
    error.code = 'gateway_required';
    throw error;
  }
  return options.gatewayClient;
}

function gatewayRows(rows, bot) {
  if (!Array.isArray(rows)) throw protocolError('Gateway routine response is not an array.');
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string') {
      throw protocolError('Gateway routine response contains an invalid record.');
    }
    return { ...row, agentId: bot.agentId, botName: bot.name ?? '' };
  });
}

/** Create a routine through an explicitly supplied, running computer gateway. */
export async function createRoutine(client, bot, spec, options = {}) {
  const validated = validateRoutineSpec(spec);
  const transport = gateway(options);
  const rpcOptions = callOptions(options);
  const resolved = await resolve(client, bot);
  requireComputerOwned(resolved);
  return gatewayRows(await transport.rpcGateway('createAgentAutomation', {
    id: resolved.agentId, spec: validated,
  }, rpcOptions), resolved);
}

/** Ask a server-owned bot to create a native routine, then verify its catalog.
 * This sends one chat message, not a direct create RPC. It never resends after
 * an uncertain response. The returned receipt allows recovery by message ID.
 */
export async function requestRoutineCreation(client, bot, spec, options = {}) {
  const validated = validateRoutineSpec(spec);
  const timeoutMs = options.timeoutMs ?? 120000;
  callOptions({ ...options, timeoutMs });
  const pollMs = options.pollMs ?? 2000;
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 60000) throw new RangeError('pollMs must be 1–60000.');
  const resolved = await resolve(client, bot);
  if (resolved.harness !== 'temporal') throw new Error('Bot-mediated routine creation requires a server-owned (temporal) bot.');
  const timer = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;
  const before = await listForBot(client, resolved, { ...options, signal });
  if (before.some(routine => routine.name === validated.name)) throw new Error('A routine with that name already exists. Choose a unique name before requesting creation.');
  const message = `Create exactly one native routine with this specification: ${JSON.stringify(validated)}. Use your native routine creation tool. Do not create a cron job or a file, run the routine now, or change any existing routine. After creation, reply with its routine ID.`;
  const messageId = options.messageId ?? randomUUID();
  let receipt;
  try {
    receipt = await sendMessage(client, resolved, message, { messageId, signal });
    if (receipt.delivery?.delivery?.endsWith('REFUSED') || receipt.status?.status?.endsWith('REJECTED')) {
      throw new Error('The routine creation message was refused.');
    }
    const baseline = new Set(before.map(routine => routine.id));
    for (;;) {
      signal.throwIfAborted();
      const rows = await listForBot(client, resolved, { ...options, signal });
      const matches = rows.filter(routine => !baseline.has(routine.id) && routine.name === validated.name);
      if (matches.length > 1) throw new Error('More than one matching routine appeared; inspect the catalog before continuing.');
      if (matches.length === 1) {
        const routine = matches[0];
        // Validate the visible result, not just the bot's textual confirmation.
        const canonical = value => JSON.stringify(value, function (_key, item) {
          return item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
        });
        if (routine.prompt !== validated.prompt || canonical(routine.trigger) !== canonical(validated.trigger)
          || routine.isEnabled !== (validated.isEnabled ?? true)) {
          throw new Error('The created native routine differs from the requested specification; inspect it before triggering.');
        }
        return { source: 'bot', routine, receipt };
      }
      await sleep(pollMs, undefined, { signal });
    }
  } catch (cause) {
    const error = new Error('Native routine creation was not verified. The request was not retried; inspect the catalog and creation message before trying again.', { cause });
    error.code = 'routine_creation_unverified';
    error.messageId = messageId;
    error.reason = cause.message;
    throw error;
  }
}

/** Replace a routine's complete native spec (not a partial patch). */
export async function updateRoutine(client, bot, id, spec, options = {}) {
  text(id, 'routine id');
  const validated = validateRoutineSpec(spec);
  const transport = gateway(options);
  const rpcOptions = callOptions(options);
  const resolved = await resolve(client, bot);
  requireComputerOwned(resolved);
  return gatewayRows(await transport.rpcGateway('updateAgentAutomation', {
    id: resolved.agentId, automationId: id, spec: validated,
  }, rpcOptions), resolved);
}

/** Request one immediate native run. Never retries after an uncertain response. */
export async function runRoutineNow(client, bot, id, options = {}) {
  text(id, 'routine id');
  if (options.sessionId !== undefined) fieldString(options.sessionId, 'sessionId');
  const transport = gateway(options);
  const rpcOptions = callOptions(options);
  const resolved = await resolve(client, bot);
  requireComputerOwned(resolved);
  return transport.rpcGateway('runAgentAutomationNow', {
    id: resolved.agentId, automationId: id,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  }, rpcOptions);
}

export const routineCapabilities = Object.freeze({
  list: true, setEnabled: true, delete: true, provisionWebhookCredential: true, fireWebhook: true,
  create: true, requestServerCreation: true, update: true, runNow: true,
  gatewayRequired: ['create', 'update', 'runNow'],
  gatewayLiveVerified: false,
  limitation: 'Direct create/update/run apply to computer-owned (box) bots and have not been tested end to end on that runtime. Server-owned (temporal) bots use verified bot-mediated creation; list, enable, delete, credentials and webhook triggering use account RPCs. This account currently has only temporal bots.',
});
