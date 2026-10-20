import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.mjs';

const bot = { agentId: 'bot-1', name: 'Example', harness: 'temporal' };
const routine = { automationId: 'server-routine', recordJson: JSON.stringify({
  id: 'routine-1', name: 'Example', prompt: 'Example', trigger: { type: 'webhook' }, isEnabled: true, createdAt: 10,
}) };

const cases = [
  { name: 'gateway-connect', args: [], method: 'EnsureSandBox', response: {
    gatewayUrl: 'https://computer.example', gatewayToken: 'private-gateway-token',
  }, expected: { baseUrl: 'https://computer.example', token: 'private-gateway-token' } },
  { name: 'webhook-key', args: ['Example', 'routine-1'], method: 'CreateAutomationWebhookApiKey',
    response: { apiKey: 'private-webhook-key' }, expected: {
      agentId: 'bot-1', automationId: 'routine-1', serverAutomationId: 'server-routine',
      url: 'https://api2.cursor.sh/automations/webhook/server-routine', key: 'private-webhook-key',
    } },
];

test('private CLI outputs reserve the destination before credentials and clean up failed requests', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-private-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const originalLog = console.log, printed = [];
  console.log = value => printed.push(value);
  t.after(() => { console.log = originalLog; });

  for (const entry of cases) {
    const filename = path.join(directory, `${entry.name}.json`);
    const args = [entry.name, ...entry.args, '--out', filename];
    let calls = 0;
    const client = { resolveBot: async () => bot, rpc: async method => {
      assert.equal(fs.statSync(filename).mode & 0o777, 0o600, 'file reserved privately before request');
      if (method === 'ListGrokBotAgentAutomations') return { automations: [routine] };
      assert.equal(method, entry.method);
      calls++;
      return entry.response;
    } };
    await main(args, client);
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), entry.expected);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(printed.at(-1)), { saved: filename, mode: '0600' });
    assert.ok(!printed.at(-1).includes(entry.expected.token ?? entry.expected.key), 'credential not printed');

    await assert.rejects(main(args, client), { code: 'EEXIST' });
    assert.equal(calls, 1, 'existing destination blocks credential provisioning');
    fs.unlinkSync(filename);

    let failedCalls = 0;
    await assert.rejects(main(args, { ...client, rpc: async () => {
      failedCalls++;
      throw new Error('connection dropped');
    } }), /operation failed/);
    assert.equal(failedCalls, 1, 'uncertain request is not retried');
    assert.equal(fs.existsSync(filename), false, 'failed output removed');
  }
});
