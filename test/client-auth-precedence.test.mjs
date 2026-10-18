import test from 'node:test';
import assert from 'node:assert/strict';
import { GrokBotClient, localCredentials } from '../src/client.mjs';

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const set = entries => { for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } };
  set(values); t.after(() => set(previous));
}

test('explicit managed authentication wins over desktop login environment settings', async t => {
  environment(t, { BOTTER_USE_APP_LOGIN: '1', GROK_BRIDGE_USE_APP_LOGIN: '1' });
  const manager = { getSession: async () => ({ accessToken: 'managed-token', selectedTeamId: 17 }) };
  const client = new GrokBotClient({ authManager: manager });
  assert.equal(client.authManager, manager);
  assert.equal(client.tokenProvider, undefined);
  const headers = await client.headers('application/json');
  assert.equal(headers.authorization, 'Bearer managed-token');
  assert.equal(headers['x-cursor-team-id'], '17');
});

test('an explicit token provider has precedence over managed and desktop authentication', async t => {
  environment(t, { BOTTER_USE_APP_LOGIN: '1', GROK_BRIDGE_USE_APP_LOGIN: '1' });
  const provider = async () => 'provided-token';
  const client = new GrokBotClient({ tokenProvider: provider,
    authManager: { getSession: () => assert.fail('Explicit provider must win.') } });
  assert.equal(client.tokenProvider, provider);
  assert.equal(await client.token(), 'provided-token');
});

test('desktop login remains opt-in and supports the legacy setting', t => {
  environment(t, { BOTTER_USE_APP_LOGIN: undefined, GROK_BRIDGE_USE_APP_LOGIN: '1' });
  assert.equal(new GrokBotClient().tokenProvider, localCredentials);
  process.env.BOTTER_USE_APP_LOGIN = '0';
  assert.equal(new GrokBotClient().tokenProvider, undefined);
  process.env.BOTTER_USE_APP_LOGIN = '1';
  delete process.env.GROK_BRIDGE_USE_APP_LOGIN;
  assert.equal(new GrokBotClient().tokenProvider, localCredentials);
});
