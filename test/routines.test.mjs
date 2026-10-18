import test from 'node:test';
import assert from 'node:assert/strict';
import { listRoutines, setRoutineEnabled, getWebhookCredential, fireWebhook,
  createRoutine, updateRoutine, runRoutineNow, validateRoutineSpec, deleteRoutine, requestRoutineCreation } from '../src/routines.mjs';

const bot = { agentId: 'bot-1', name: 'Pepys', harness: 'temporal' };

test('server-owned bots cannot receive shadow gateway routines', async () => {
  let calls = 0;
  const client = { resolveBot: async () => ({ ...bot, harness: 'temporal' }) };
  const gatewayClient = { rpcGateway: async () => { calls++; } };
  const spec = { name: 'test', prompt: 'test', trigger: { type: 'webhook' } };
  for (const operation of [
    () => createRoutine(client, bot, spec, { gatewayClient }),
    () => updateRoutine(client, bot, 'id', spec, { gatewayClient }),
    () => runRoutineNow(client, bot, 'id', { gatewayClient }),
  ]) await assert.rejects(operation(), { code: 'server_owned_routine' });
  assert.equal(calls, 0);
});

test('computer-owned routines use their gateway for listing, credential polling and deletion', async () => {
  const local = { ...bot, harness: 'box' };
  let polls = 0; const methods = [];
  const client = { resolveBot: async () => local, rpc: async () => { throw new Error('Wrong routine store'); } };
  const gatewayClient = { rpcGateway: async method => {
    methods.push(method);
    if (method === 'getAutomationWebhookCredential') return { url: 'https://api2.cursor.sh/automations/webhook/test', key: ++polls === 1 ? null : 'webhook-key' };
    if (method === 'deleteAgentAutomation') return [];
    return [{ id: 'local', name: 'test', trigger: { type: 'webhook' } }];
  } };
  const options = { gatewayClient, provisionPollMs: 0 };
  assert.equal((await listRoutines(client, { ...options, bot: local }))[0].id, 'local');
  assert.equal((await getWebhookCredential(client, local, 'local', options)).key, 'webhook-key');
  await deleteRoutine(client, local, 'local', options);
  assert.equal(polls, 2); assert.ok(methods.includes('deleteAgentAutomation'));
});
const row = (changes = {}, serverId = 'server-routine-1') => ({
  automationId: serverId,
  recordJson: JSON.stringify({ id: 'local-routine-1', name: 'Daily', prompt: 'Read the report',
    trigger: { type: 'webhook' }, isEnabled: true, createdAt: 10, ...changes }),
});
const mock = (reply, harness = 'temporal') => {
  const calls = [];
  const resolved = { ...bot, harness };
  return { calls, baseUrl: 'https://api2.cursor.sh', resolveBot: async () => resolved,
    listBots: async () => [resolved],
    rpc: async (method, body, options) => { calls.push({ method, body, options }); return reply(method, body); },
  };
};

test('single-bot list preserves local and server routine IDs', async () => {
  const client = mock(() => ({ automations: [row({ nextRunAt: 20 }), row({ id: 'second', nextRunAt: 15 }, 'server-2')] }));
  const result = await listRoutines(client, { bot: 'Pepys', timeZone: 'Europe/London' });
  assert.deepEqual(result.map(value => [value.id, value.serverAutomationId]), [['second', 'server-2'], ['local-routine-1', 'server-routine-1']]);
  assert.equal(result[0].agentId, bot.agentId);
  assert.deepEqual(client.calls[0].body, { agentId: 'bot-1', timeZone: 'Europe/London' });
});

test('account list honors individual reads and explicit unavailable groups', async () => {
  const client = mock(method => method === 'ListGrokBotAccountAutomations'
    ? { agents: [{ agentId: 'bot-1', readIndividually: true }] }
    : { automations: [row()] });
  assert.equal((await listRoutines(client))[0].id, 'local-routine-1');
  assert.deepEqual(client.calls.map(call => call.method), ['ListGrokBotAccountAutomations', 'ListGrokBotAgentAutomations']);
  const unavailable = mock(() => ({ agents: [{ agentId: 'bot-1', unavailable: true }] }));
  assert.deepEqual(await listRoutines(unavailable), [{ agentId: 'bot-1', botName: 'Pepys', unavailable: true }]);
});

test('malformed routine data and contradictory account groups are reported', async () => {
  const client = mock(() => ({ automations: [{ automationId: 'server', recordJson: '{' }] }));
  await assert.rejects(listRoutines(client, { bot }), { code: 'invalid_routine_response' });
  const conflicting = mock(() => ({ agents: [{ agentId: 'bot-1', readIndividually: true, automations: [row()] }] }));
  await assert.rejects(listRoutines(conflicting), /contradictory/);
});

test('enable sends local ID and boolean once, with no retry on uncertain failure', async () => {
  const client = mock(() => { throw new Error('request timed out'); });
  await assert.rejects(setRoutineEnabled(client, bot, 'local-routine-1', false), /timed out/);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].body, { agentId: 'bot-1', automationId: 'local-routine-1', isEnabled: false });
  await assert.rejects(setRoutineEnabled(client, bot, 'local-routine-1', 'false'), /boolean/);
  assert.equal(client.calls.length, 1);
});

test('non-webhook and missing routines never provision a secret', async () => {
  const client = mock(() => ({ automations: [row({ trigger: { type: 'cron' } })] }));
  await assert.rejects(getWebhookCredential(client, bot, 'local-routine-1'), /not webhook/);
  await assert.rejects(getWebhookCredential(client, bot, 'missing'), /not found/);
  assert.equal(client.calls.filter(call => call.method === 'CreateAutomationWebhookApiKey').length, 0);
});

test('webhook credentials use server ID, DashboardService, and group trigger detection', async () => {
  const client = mock(method => method === 'ListGrokBotAgentAutomations'
    ? { automations: [row({ trigger: { type: 'group', listeners: [{ type: 'cron' }, { type: 'webhook' }] } }, 'server/id')] }
    : { apiKey: 'private-key' });
  const result = await getWebhookCredential(client, bot, 'local-routine-1');
  assert.equal(result.url, 'https://api2.cursor.sh/automations/webhook/server%2Fid');
  assert.equal(result.key, 'private-key');
  assert.deepEqual(client.calls[1].body, { automationId: 'server/id' });
  assert.equal(client.calls[1].options.service, 'DashboardService');
});

test('credential provisioning is not repeated after an uncertain outcome', async () => {
  const client = mock(method => {
    if (method === 'ListGrokBotAgentAutomations') return { automations: [row()] };
    throw new Error('connection dropped');
  });
  await assert.rejects(getWebhookCredential(client, bot, 'local-routine-1'), /connection dropped/);
  assert.equal(client.calls.filter(call => call.method === 'CreateAutomationWebhookApiKey').length, 1);
});

test('fireWebhook isolates the dedicated key, prevents redirects, serializes payload', async () => {
  let request;
  const result = await fireWebhook({ url: 'https://api2.cursor.sh/automations/webhook/id', key: 'hook-key',
    payload: { event: 'new report' }, fetchImpl: async (url, options) => {
      request = { url, options }; return new Response('{"accepted":true}', { status: 202 });
    } });
  assert.deepEqual(request.options.headers, { 'content-type': 'application/json', authorization: 'Bearer hook-key' });
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body, '{"event":"new report"}');
  assert.deepEqual(result, { status: 202, result: { accepted: true } });
});

test('fireWebhook rejects unsafe destinations and invalid inputs before fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; };
  for (const url of ['http://api2.cursor.sh/automations/webhook/id', 'https://user:pw@api2.cursor.sh/automations/webhook/id',
    'https://api2.cursor.sh/other', 'https://api2.cursor.sh/automations/webhook/id?key=oops',
    'https://api2.cursor.sh/automations/webhook/id#fragment']) {
    await assert.rejects(fireWebhook({ url, key: 'hook-key', fetchImpl }));
  }
  await assert.rejects(fireWebhook({ url: 'https://api2.cursor.sh/automations/webhook/id', key: 'key\nInjected: yes', fetchImpl }), /line breaks/);
  await assert.rejects(fireWebhook({ url: 'https://api2.cursor.sh/automations/webhook/id', key: 'key', timeoutMs: 0, fetchImpl }), /timeoutMs/);
  assert.equal(calls, 0);
});

test('fireWebhook reports status without leaking response bodies or retrying', async () => {
  let calls = 0;
  await assert.rejects(fireWebhook({ url: 'https://api2.cursor.sh/automations/webhook/id', key: 'hook-key', fetchImpl: async () => {
    calls++; return new Response('echo: hook-key and secret payload', { status: 503 });
  } }), error => error.status === 503 && !error.message.includes('hook-key') && /not retried/.test(error.message));
  assert.equal(calls, 1);
});

test('fireWebhook respects pre-aborted signals and does not mint credentials', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fireWebhook({ url: 'https://api2.cursor.sh/automations/webhook/id', key: 'key', signal: controller.signal,
    fetchImpl: async (_url, options) => { options.signal.throwIfAborted(); } }), { name: 'AbortError' });
});

test('native routine mutations route through the explicitly supplied gateway', async () => {
  const client = mock(() => { throw new Error('Backend RPC must not be called.'); }, 'box');
  const calls = [];
  const gatewayClient = { rpcGateway: async (method, args) => {
    calls.push({ method, args });
    return method === 'runAgentAutomationNow' ? null : [{ id: 'local', name: 'Webhook' }];
  } };
  const spec = { name: 'Webhook', prompt: 'Read this event', trigger: { type: 'webhook' }, isEnabled: false };
  assert.equal((await createRoutine(client, bot, spec, { gatewayClient }))[0].agentId, 'bot-1');
  await updateRoutine(client, bot, 'local', spec, { gatewayClient });
  await runRoutineNow(client, bot, 'local', { gatewayClient, sessionId: 'session-1' });
  assert.deepEqual(calls, [
    { method: 'createAgentAutomation', args: { id: 'bot-1', spec } },
    { method: 'updateAgentAutomation', args: { id: 'bot-1', automationId: 'local', spec } },
    { method: 'runAgentAutomationNow', args: { id: 'bot-1', automationId: 'local', sessionId: 'session-1' } },
  ]);
  assert.equal(client.calls.length, 0);
});

test('native routines require a gateway without starting a computer or doing a backend call', async () => {
  const client = mock(() => { throw new Error('No RPC should run.'); });
  const spec = { name: 'Job', prompt: 'Do work', trigger: { type: 'webhook' } };
  await assert.rejects(createRoutine(client, bot, spec), { code: 'gateway_required' });
  await assert.rejects(updateRoutine(client, bot, 'id', spec), { code: 'gateway_required' });
  await assert.rejects(runRoutineNow(client, bot, 'id'), { code: 'gateway_required' });
  assert.equal(client.calls.length, 0);
});

test('all declared trigger types accept their verified shapes', () => {
  const triggers = [
    { type: 'webhook' },
    { type: 'cron', schedule: '0 9 * * 1-5', firesAt: '2026-10-19T09:00:00Z', window: { earlyMinutes: 0, lateMinutes: 5 }, timing: 'flexible' },
    { type: 'email', inbox: 'default', from: ['someone@example.com'], requireAuthPass: true },
    { type: 'slack', channel: 'C123', match: { kind: 'reaction', emoji: ['eyes'], bySelf: true } },
    { type: 'slack', channel: 'C123', match: { kind: 'keyword', keyword: 'deploy' } },
    { type: 'github', repo: 'owner/repo', events: ['pr-opened', 'ci-failed'], pr: 12, userAllowlist: ['dev'], ciBranch: 'main' },
    { type: 'origin', repo: 'owner/repo', events: ['pr-merged'] },
    { type: 'microsoftTeams', tenantId: 'tenant', teamIds: ['team'], channelIds: ['channel'], messageContains: '', messageContainsIsRegex: false, blockUnauthenticatedTeamsUsers: true },
    { type: 'linear', event: { case: 'statusChanged', statusIds: ['status'] }, projectIds: [], teamIds: ['team'] },
    { type: 'linear', event: { case: 'issueCreated' }, projectIds: [], teamIds: ['team'] },
    { type: 'linear', event: { case: 'endOfCycle', cycleIds: ['cycle'] }, projectIds: [], teamIds: ['team'] },
    { type: 'sentry', event: { case: 'issueResolved' }, projectIds: ['project'] },
    { type: 'pagerduty', event: { case: 'incidentTriggered' }, serviceIds: ['service'] },
    { type: 'group', listeners: [{ type: 'webhook' }, { type: 'cron', schedule: '0 9 * * *' }] },
  ];
  for (const trigger of triggers) {
    const spec = { name: 'Job', prompt: 'Do work', trigger };
    const parsed = validateRoutineSpec(spec);
    assert.deepEqual(parsed, spec);
    assert.notEqual(parsed, spec);
    assert.notEqual(parsed.trigger, trigger);
  }
});

test('invalid trigger schemas, unknown fields and nested groups are rejected before dispatch', async () => {
  const invalidTriggers = [
    { type: 'toString' },
    { type: 'unknown' },
    { type: 'webhook', url: 'https://elsewhere.example' },
    { type: 'github', repo: 'owner/repo', events: ['invented'] },
    { type: 'origin', repo: 'owner/repo', events: ['issue-assigned'] },
    { type: 'sentry', event: { case: 'invented' }, projectIds: [] },
    { type: 'pagerduty', event: { case: 'invented' }, serviceIds: [] },
    { type: 'slack', channel: 'C123', match: { kind: 'toString' } },
    { type: 'linear', event: { case: 'toString' }, projectIds: [], teamIds: [] },
    { type: 'cron', schedule: '* * * * *', window: { earlyMinutes: NaN, lateMinutes: 1 } },
    { type: 'group', listeners: [{ type: 'webhook' }] },
    { type: 'group', listeners: [{ type: 'webhook' }, { type: 'group', listeners: [{ type: 'webhook' }, { type: 'webhook' }] }] },
  ];
  let writes = 0;
  const client = mock(() => {});
  const gatewayClient = { rpcGateway: async () => { writes++; } };
  for (const trigger of invalidTriggers) {
    await assert.rejects(createRoutine(client, bot, { name: 'Job', prompt: 'Do work', trigger }, { gatewayClient }));
  }
  assert.throws(() => validateRoutineSpec({ name: 'Job', prompt: 'Do work', trigger: { type: 'webhook' }, typo: true }), /supported field/);
  assert.equal(writes, 0);
});

test('native mutation uncertainties are not retried', async () => {
  let writes = 0;
  const client = mock(() => {}, 'box');
  const gatewayClient = { rpcGateway: async () => { writes++; throw new Error('connection reset'); } };
  await assert.rejects(createRoutine(client, bot, { name: 'Job', prompt: 'Work', trigger: { type: 'webhook' } }, { gatewayClient }), /connection reset/);
  assert.equal(writes, 1);
});


test('raw or stale bot objects cannot bypass authoritative runtime ownership', async () => {
  let calls = 0;
  const client = { resolveBot: async value => value, listBots: async () => [bot] };
  const gatewayClient = { rpcGateway: async () => { calls++; } };
  for (const value of [{ agentId: bot.agentId }, { ...bot, harness: 'box' }]) {
    await assert.rejects(createRoutine(client, value, { name: 'Test', prompt: 'Work', trigger: { type: 'webhook' } }, { gatewayClient }), { code: 'server_owned_routine' });
  }
  assert.equal(calls, 0);
});

test('server creation sends once and verifies exact specification in native catalog', async () => {
  const spec = { name: 'New native webhook', prompt: 'Read event', trigger: { type: 'webhook' }, isEnabled: true };
  let sent = false;
  const client = mock((method, body) => {
    if (method === 'ListGrokBotAgentAutomations') return { automations: sent ? [row({ ...spec, id: 'created' })] : [] };
    if (method === 'SendGrokBotUserMessage') { sent = true; assert.match(body.text, /native routine creation tool/); return {}; }
    if (method === 'GetGrokBotSendStatus') return {};
    throw new Error('Unexpected method');
  });
  const result = await requestRoutineCreation(client, bot, spec, { pollMs: 1 });
  assert.equal(result.source, 'bot');
  assert.equal(result.routine.id, 'created');
  assert.equal(client.calls.filter(call => call.method === 'SendGrokBotUserMessage').length, 1);
});

test('server creation rejects duplicate names before sending and keeps uncertain receipt ID', async () => {
  const spec = { name: 'Daily', prompt: 'Read the report', trigger: { type: 'webhook' } };
  const duplicate = mock(() => ({ automations: [row()] }));
  await assert.rejects(requestRoutineCreation(duplicate, bot, spec), /already exists/);
  assert.equal(duplicate.calls.some(call => call.method === 'SendGrokBotUserMessage'), false);
  const uncertain = mock(method => {
    if (method === 'ListGrokBotAgentAutomations') return { automations: [] };
    throw new Error('Connection dropped');
  });
  await assert.rejects(requestRoutineCreation(uncertain, bot, spec), error => error.code === 'routine_creation_unverified' && typeof error.messageId === 'string');
  assert.equal(uncertain.calls.filter(call => call.method === 'SendGrokBotUserMessage').length, 1);
});

test('server creation does not accept a textual confirmation or a different spec', async () => {
  let sent = false;
  const client = mock(method => {
    if (method === 'ListGrokBotAgentAutomations') return { automations: sent ? [row({ prompt: 'Wrong prompt' })] : [] };
    if (method === 'SendGrokBotUserMessage') { sent = true; return {}; }
    return {};
  });
  await assert.rejects(requestRoutineCreation(client, bot, { name: 'Daily', prompt: 'Correct prompt', trigger: { type: 'webhook' } }), error => error.code === 'routine_creation_unverified' && /differs/.test(error.reason));
});
