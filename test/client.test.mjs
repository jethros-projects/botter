import test from 'node:test';
import assert from 'node:assert/strict';
import { GrokBotClient, encodeConnectFrame, decodeConnectFrames, ApiError } from '../src/client.mjs';

test('Connect frames survive arbitrary network chunk boundaries', async () => {
  const data = Buffer.concat([encodeConnectFrame({ connected: {} }), encodeConnectFrame({ rows: { entries: [] } })]);
  async function* chunks() { for (let i = 0; i < data.length; i += 3) yield data.subarray(i, i + 3); }
  assert.deepEqual(await Array.fromAsync(decodeConnectFrames(chunks())), [{ connected: {} }, { rows: { entries: [] } }]);
});
test('Connect rejects truncated frames and server error trailers', async () => {
  async function* truncated() { yield encodeConnectFrame({ rows: {} }).subarray(0, 7); }
  await assert.rejects(async () => { for await (const unused of decodeConnectFrames(truncated())) {} }, /Truncated/);
  const trailer = encodeConnectFrame({ error: { code: 'permission_denied', message: 'no access' } }); trailer[0] = 2;
  async function* error() { yield trailer; }
  await assert.rejects(async () => { for await (const unused of decodeConnectFrames(error())) {} }, { name: 'ApiError', code: 'permission_denied' });
});
test('Connect rejects declared oversized frames before waiting for body', async () => {
  const frame = Buffer.alloc(5); frame.writeUInt32BE(30 * 1024 * 1024, 1);
  async function* chunks() { yield frame; }
  await assert.rejects(async () => { for await (const unused of decodeConnectFrames(chunks())) {} }, /size limit/);
});
test('RPC is fixed to known origin and never retries writes', async () => {
  let attempts = 0;
  const c = new GrokBotClient({ version: 'test', tokenProvider: () => 'secret', fetchImpl: async (url, init) => {
    attempts++;
    assert.equal(url, 'https://api2.cursor.sh/aiserver.v1.GrokBotService/SendGrokBotUserMessage');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer secret');
    return new Response(JSON.stringify({ code: 'unavailable', message: 'try later' }), { status: 503 });
  } });
  await assert.rejects(c.rpc('SendGrokBotUserMessage', {}), ApiError);
  assert.equal(attempts, 1);
  await assert.rejects(c.rpc('../../steal', {}), /Invalid/);
  assert.equal(attempts, 1);
});
test('bot ambiguity is explicit', async () => {
  const c = new GrokBotClient({ version: 'test' });
  c.listBots = async () => [{ name: 'Same', agentId: 'a' }, { name: 'same', agentId: 'b' }];
  await assert.rejects(c.resolveBot('same'), /Ambiguous/);
});

test('managed authentication is checked on each request and retains selected team', async () => {
  let calls = 0;
  const tokens = [];
  const client = new GrokBotClient({
    authManager: { getSession: async () => ({ accessToken: `token-${++calls}`, selectedTeamId: 17 }) },
    fetchImpl: async (_url, init) => {
      tokens.push(init.headers.authorization);
      assert.equal(init.headers['x-cursor-team-id'], '17');
      return new Response('{}');
    },
  });
  await client.rpc('ListGrokBotAgents', {});
  await client.rpc('ListGrokBotAgents', {});
  assert.deepEqual(tokens, ['Bearer token-1', 'Bearer token-2']);
});
