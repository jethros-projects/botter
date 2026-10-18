import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGatewayDescriptor, connectGateway, gatewayStatus } from '../src/connection.mjs';

const box = { gatewayUrl: 'https://computer.example', gatewayToken: 'gateway-secret', networkToken: 'routing-secret' };
test('live connection maps both independent credentials from EnsureSandBox', async () => {
  const client = { rpc: async (method, body) => {
    assert.equal(method, 'EnsureSandBox'); assert.deepEqual(body, {}); return box;
  } };
  assert.deepEqual(await resolveGatewayDescriptor(client), { baseUrl: box.gatewayUrl, token: box.gatewayToken,
    headers: { 'x-anyrun-network-token': box.networkToken } });
  assert.equal(typeof (await connectGateway(client)).rpcGateway, 'function');
});
test('status defaults to no wake and never returns credentials', async () => {
  const client = { rpc: async (method, body) => { assert.equal(body.wake, false); return box; } };
  const result = await gatewayStatus(client, { fetchImpl: async (url, init) => {
    assert.equal(url.href, 'https://computer.example/health'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers['x-anyrun-network-token'], 'routing-secret');
    assert.equal(init.headers.authorization, 'Bearer gateway-secret'); return new Response('ok');
  } });
  assert.equal(result.connected, true);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('missing credentials and unsafe origins fail before gateway requests', async () => {
  await assert.rejects(resolveGatewayDescriptor({ rpc: async () => ({}) }, { wake: false }), /No active gateway/);
  await assert.rejects(resolveGatewayDescriptor({ rpc: async () => ({ ...box, gatewayUrl: 'http://remote.example' }) }), /HTTPS/);
});
