import test from 'node:test';
import assert from 'node:assert/strict';
import { main, parseOptions, HELP, FULL_HELP, specs } from '../src/cli.mjs';

const offline = new Proxy({}, { get() { assert.fail('Help or local validation accessed the API client'); } });
async function output(args) {
  const logged = [], original = console.log;
  console.log = value => logged.push(value);
  try { await main(args, offline); return logged.join('\n'); }
  finally { console.log = original; }
}

test('concise root help leads to complete, offline command and topic discovery', async () => {
  assert(HELP.split('\n').length <= 24);
  assert.equal(await output([]), HELP);
  assert.equal(await output(['--help']), HELP);
  assert.equal(await output(['help', '--all']), FULL_HELP);
  assert.equal(await output(['--help', '--all']), FULL_HELP);
  assert.equal(await output(['--help-all']), FULL_HELP);
  await assert.rejects(output(['--help-all', 'send']), /without other arguments/);
  for (const command of Object.keys(specs)) {
    const topic = await output(['help', command]);
    assert.match(topic, new RegExp(`Usage: botter ${command}(?:\\s|$)`));
    assert.equal(await output([command, '--help']), topic);
    assert.equal(await output([command, '-h']), topic);
  }
  for (const command of ['api', 'gateway-api']) {
    assert.match(await output(['help', command]), /^Botter/);
  }
  await assert.rejects(output(['help', 'missing']), /Unknown command.*botter help --all/);
});

test('literal values and the argument terminator never trigger command help', async () => {
  assert.deepEqual(parseOptions(['Alpha', '--text=--help'], specs.send), { positionals: ['Alpha'], options: { text: '--help' } });
  assert.deepEqual(parseOptions(['Alpha', '--text', '-h'], specs.send), { positionals: ['Alpha'], options: { text: '-h' } });
  await assert.rejects(output(['send', 'Alpha', '--text=hello', '--', '--help']), /Expected 1 positional/);
  await assert.rejects(output(['send', 'Alpha', '--text', '-h', '--message-id', 'invalid']), /UUID/);
  assert.throws(() => parseOptions(['-x'], {}), /Unknown option: -x/);
});

test('invalid send inputs and overflowing watch timers fail before network access', async () => {
  await assert.rejects(main(['send', 'Alpha', '--text', 'hello', '--wait', '3601'], offline), /3600/);
  await assert.rejects(main(['send', 'Alpha', '--text', 'hello', '--attachments', 'null'], offline), /array/);
  for (const duration of ['0', '2147484', '9007199254740991']) {
    await assert.rejects(main(['watch', 'Alpha', '--duration', duration], offline), /1–86400/);
  }
});

test('incomplete transcript recovery is visible in JSON and the process status', async () => {
  const originalLog = console.log, originalExit = process.exitCode, output = [];
  console.log = value => output.push(JSON.parse(value));
  const client = {
    resolveBot: async () => ({ agentId: 'fixture-bot', name: 'Example' }),
    accountFingerprint: async () => 'fixture-account',
    rpc: async () => ({ entries: [], generation: 1 }),
    async *stream() { yield { cursorTooOld: { agentId: 'fixture-bot', sessionId: '', generation: 1 } }; },
  };
  try {
    process.exitCode = 0;
    await main(['watch', 'Example'], client);
    assert.equal(process.exitCode, 1);
    assert.equal(output.at(-1).type, 'cursorTooOld');
    process.exitCode = 0;
    await main(['updates', 'Example'], client);
    assert.equal(process.exitCode, 1);
    assert.equal(output.at(-1).resyncRequired, true);
  } finally { console.log = originalLog; process.exitCode = originalExit; }
});
