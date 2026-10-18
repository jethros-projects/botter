import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOptions, main, specs, HELP, FULL_HELP, deliveryAccepted } from '../src/cli.mjs';

test('CLI preserves literal message text and repeated attachment inputs', () => {
  const parsed = parseOptions(['Test', '--text', '`echo nope` $(nope)', '--attach', 'a', '--attach=b', '--wait=10'], { text: 's', attach: 'r', wait: 'n' });
  assert.deepEqual(parsed, { positionals: ['Test'], options: { text: '`echo nope` $(nope)', attach: ['a', 'b'], wait: 10 } });
});
test('CLI rejects unknown, duplicated, missing and malformed options', () => {
  assert.throws(() => parseOptions(['--whatever'], {}), /Unknown/);
  assert.throws(() => parseOptions(['--wait', '1', '--wait', '2'], { wait: 'n' }), /Repeated/);
  assert.throws(() => parseOptions(['--wait'], { wait: 'n' }), /Missing/);
  assert.throws(() => parseOptions(['--wait=NaN'], { wait: 'n' }), /integer/);
});
test('CLI requires explicit tool arguments and gateway before side effects', async () => {
  let calls = 0;
  const client = { rpc: async () => { calls++; }, resolveBot: async () => { calls++; } };
  await assert.rejects(main(['tool-call', 'server', 'tool'], client), /Supply --args/);
  await assert.rejects(main(['routine-run', 'bot', 'routine'], client), /Unknown command/);
  assert.equal(calls, 0);
});

function mock(response = {}) {
  const calls = [], bot = { name: 'Alpha', agentId: 'alpha', harness: 'temporal' };
  return { calls, async resolveBot(value) { return typeof value === 'object' ? value : { ...bot, agentId: value === 'Beta' ? 'beta' : 'alpha' }; },
    async listBots() { return [bot]; }, async rpc(method, body, options) { calls.push({ method, body, options });
      if (method === 'GetGrokBotRuntimeCapabilities') return { capabilities: { agentMessagingEnabled: true, serverRoomsEnabled: true,
        temporalCreationEnabled: true, durableIdentityEnabled: true, durableIdentityWritesEnabled: true } };
      return typeof response === 'function' ? response(method, body) : response;
    } };
}
async function run(args, client) {
  const oldLog = console.log, oldError = console.error, oldExit = process.exitCode, output = [];
  console.log = value => output.push(value); console.error = () => {}; process.exitCode = 0;
  try { await main(args, client); return { output, exitCode: process.exitCode }; }
  finally { console.log = oldLog; console.error = oldError; process.exitCode = oldExit; }
}
test('help documents every registered convenience command and flag', () => {
  for (const [command, flags] of Object.entries(specs)) {
    const line = FULL_HELP.split('\n').find(value => value === command || value.startsWith(`${command} `));
    assert.ok(line, `missing command ${command}`);
    for (const name of Object.keys(flags)) assert.ok(line.includes(`--${name}`), `missing ${command} --${name}`);
  }
});
test('registered convenience commands match the live-support manifest exactly', () => {
  const support = JSON.parse(fs.readFileSync(new URL('../schema/verified-support.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(specs).sort(), support.commands.map(value => value.name).sort());
});
test('handoff recognizes every accepted and nonaccepted delivery outcome', async () => {
  for (const [delivery, accepted] of [[1, true], [2, true], [3, true], [0, false], [4, false], [5, false], [6, false], [7, false], [8, false],
    ['GROK_BOT_AGENT_MESSAGE_DELIVERY_DUPLICATE', true], ['GROK_BOT_AGENT_MESSAGE_DELIVERY_FORBIDDEN', false], ['BOX_UNREACHABLE', false]]) {
    const c = mock({ delivery });
    const result = await run(['handoff', 'Alpha', 'Beta', '--text', 'Hello'], c);
    assert.equal(result.exitCode, accepted ? 0 : 1, String(delivery));
    assert.equal(c.calls.at(-1).body.replyToId, undefined);
    assert.match(c.calls.at(-1).body.sentAtMs, /^\d+$/);
  }
  assert.equal(deliveryAccepted('GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED'), false);
});
test('send forwards existing attachment refs without a second upload', async () => {
  const c = mock(method => method === 'SendGrokBotUserMessage' ? { delivery: 'ACCEPTED_TEMPORAL' } : { status: 'ACCEPTED' });
  const result = await run(['send', 'Alpha', '--text', '', '--attachments', '[{"path":"/store/a","name":"a.txt"}]'], c);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(c.calls.map(x => x.method), ['SendGrokBotUserMessage', 'GetGrokBotSendStatus']);
  assert.deepEqual(c.calls[0].body.attachmentPaths, ['/store/a']);
  assert.equal(c.calls[0].body.richText, undefined);
  assert.equal(c.calls[0].body.taskId, undefined);
  const refused = await run(['send', 'Alpha', '--text', 'x'], mock({ delivery: 4 }));
  assert.equal(refused.exitCode, 1);
});
test('history and scan CLI preserve tested pagination controls', async () => {
  const c = mock({ entries: [], generation: 3 });
  await run(['history', 'Alpha', '--before', '9007199254740995', '--limit', '7'], c);
  assert.deepEqual(c.calls[0].body, { agentId: 'alpha', sessionId: '', limit: 7, beforeSeq: '9007199254740995' });
  await run(['search', 'Alpha', '--query', 'x', '--before', '9', '--page-size', '12', '--pages', '1'], c);
  assert.equal(c.calls[1].body.limit, 12);
  assert.equal(c.calls[1].body.beforeSeq, '9');
  assert.equal(c.calls[1].body.generation, undefined);
});
test('room CLI permits only nonempty owned-bot membership', async () => {
  const c = mock((_method, body) => ({ agent: { agentId: body.agentId, kind: 'ROOM' } }));
  await run(['room-create', 'Bots', '--id', 'room', '--members', 'Alpha'], c);
  assert.deepEqual(c.calls.at(-1).body.humanMemberUserIds, []);
  assert.deepEqual(c.calls.at(-1).body.memberAgentIds, ['alpha']);
  c.resolveBot = async () => ({ agentId: 'room', kind: 'ROOM' });
  const before = c.calls.length;
  await assert.rejects(run(['room-members', 'Room', '--members', ''], c), /Supply --members/);
  await assert.rejects(run(['room-create', 'Bad', '--humans', '12'], c), /Unknown option/);
  assert.equal(c.calls.length, before);
});
test('tool CLI dispatches the tested default catalog context only', async () => {
  const c = mock({ result: { success: {} } });
  await run(['tool-call', 'server', 'catalog-name', '--args', '{}'], c);
  assert.deepEqual({ ...c.calls[0].body, toolCallId: '<generated>' }, { serverIdentifier: 'server', toolName: 'catalog-name', args: {}, toolCallId: '<generated>', agentId: '' });
  await assert.rejects(run(['tool-call', 's', 't', '--args', '{}', '--mcp-config', '{}'], c), /Unknown option/);
});
test('convenience commands dispatch through validated feature helpers', async () => {
  const c = mock({});
  await run(['stop', 'Alpha', '--reason', 'Stop'], c);
  await run(['send-status', 'Alpha', 'message'], c);
  await run(['mark-unread', 'Alpha'], c);
  await run(['bot-state', 'Alpha', '--json', '{"notificationsEnabled":false}'], c);
  await run(['settings-update', '--json', '{"pinnedAgents":{"agentIds":["alpha"]}}'], c);
  assert.deepEqual(c.calls.map(x => x.method), ['InterruptGrokBotAgentRun', 'GetGrokBotSendStatus', 'SetGrokBotAgentClientState',
    'SetGrokBotAgentClientState', 'UpdateGrokBotUserRuntimeSettings']);
});
test('updates uses a native snapshot for its current generation', async () => {
  const c = mock({ entries: [], generation: 6 });
  let streamRequest;
  c.stream = async function* (_method, request) { streamRequest = request; yield { connected: {} }; };
  const result = await run(['updates', 'Alpha', '--after-updated-seq', '0'], c);
  assert.equal(result.exitCode, 0);
  assert.equal(streamRequest.cursors[0].generation, 6);
  assert.equal(c.calls.length, 1);
  assert.deepEqual(c.calls[0].body, { agentId: 'alpha', sessionId: '', limit: 1 });
  assert.equal(JSON.parse(result.output[0]).cursor.generation, 6);
});

test('pruned commands and unverified variants reject before network or local input reads', async () => {
  const c = mock();
  for (const name of ['threads', 'outline', 'resource', 'tasks', 'todos', 'subagents', 'skills', 'skill-add', 'skill-update', 'skill-remove',
    'task-done', 'task-read', 'task-pin', 'task-unpin', 'task-dismiss', 'tasks-seen', 'room-add-people', 'room-remove-people', 'routine-update', 'routine-run']) {
    assert.equal(Object.hasOwn(specs, name), false);
    await assert.rejects(run([name], c), /Unknown command/);
  }
  for (const args of [
    ['send', 'Alpha', '--text', 'x', '--fork'], ['send', 'Alpha', '--text', 'x', '--session', 's'],
    ['send', 'Alpha', '--text', 'x', '--gateway', '/missing'], ['upload', 'Alpha', '/missing', '--connect'],
    ['send', 'Alpha', '--text', 'x', '--rich-text', 'x'], ['send', 'Alpha', '--text', 'x', '--task-id', 'task'],
    ['handoff', 'Alpha', 'Beta', '--text', 'x', '--reply-to', 'prior'],
    ['tools', '--server', 'other'], ['history', 'Alpha', '--generation', '3'], ['watch', 'Alpha', '--cursor-file', '/missing'],
    ['artifacts', 'Alpha', '--page-token', 'other'],
  ]) await assert.rejects(run(args, c), /Unknown option/);
  await assert.rejects(run(['watch', 'all'], c), /one explicitly/);
  await assert.rejects(run(['routine-create', 'Alpha', '--spec', '/missing'], c), /--via-bot/);
  await assert.rejects(run(['upload', 'Alpha', '/missing', '--max-bytes', '5242881'], c), /5 MiB/);
  await assert.rejects(run(['download', 'Alpha', '/missing', '--out', '/missing', '--max-bytes', '5242881'], c), /5 MiB/);
  await assert.rejects(run(['bot-create', 'Bad', '--harness', 'box'], c), /Only temporal/);
  await assert.rejects(run(['bot-state', 'Alpha', '--json', '{"hiddenFromSidebar":true}'], c), /not an exposed/);
  await assert.rejects(run(['settings-update', '--json', '{"hasSeenOnboarding":true}'], c), /not an exposed/);
  await assert.rejects(run(['bot-update', 'Alpha', '--json', '{"name":"New"}'], c), /not an exposed/);
  assert.equal(c.calls.length, 0);
});

test('routine creation rejects unverified triggers before dispatch', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-cli-verified-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'routine.json');
  fs.writeFileSync(filename, JSON.stringify({ name: 'Example', prompt: 'Example', trigger: { type: 'cron', schedule: '* * * * *' } }));
  const c = mock();
  await assert.rejects(run(['routine-create', 'Alpha', '--via-bot', '--spec', filename], c), /Only the verified webhook/);
  assert.equal(c.calls.length, 0);
});

test('routines requires a bot and only calls the verified per-bot listing', async () => {
  const c = mock({ automations: [] });
  await assert.rejects(run(['routines'], c), /Expected 1 positional/);
  assert.equal(c.calls.length, 0);
  await run(['routines', 'Alpha'], c);
  assert.deepEqual(c.calls.map(call => call.method), ['ListGrokBotAgentAutomations']);
  assert.deepEqual(c.calls[0].body, { agentId: 'alpha' });
  assert.ok(FULL_HELP.includes('routines BOT'));
  assert.ok(!FULL_HELP.includes('routines [BOT]'));
});

test('capabilities separates server flags from the verified executable CLI', async () => {
  const result = JSON.parse((await run(['capabilities'], mock())).output[0]);
  assert.equal(result.serverRuntime.durableIdentityWritesEnabled, true);
  assert.equal(result.cli.routines.directBoxMutations, false);
  assert.deepEqual(result.cli.attachments, { maxBytes: 5242880, upload: ['SINGLE_PUT'], download: ['STORE'] });
  assert.ok(!result.cli.commands.includes('routine-run'));
  assert.ok(!result.cli.backend.some(method => method.endsWith('/PutGrokBotSecret')));
  assert.ok(!result.cli.gateway.includes('sendPrompt'));
});
