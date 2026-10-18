import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayClient } from '../src/gateway.mjs';

test('gateway adapter uses explicit token, /api method route, isolated headers and no redirects', async () => {
  let request;
  const gateway = createGatewayClient({ baseUrl: 'https://computer.example', token: 'gateway-only',
    headers: { 'x-route-id': 'route-1' }, fetchImpl: async (url, options) => {
      request = { url, options }; return Response.json([{ id: 'routine' }]);
    } });
  assert.deepEqual(Object.keys(gateway).sort(), ['baseUrl', 'rpcGateway']);
  assert.deepEqual(await gateway.rpcGateway('createAgentAutomation', { id: 'bot', spec: {} }), [{ id: 'routine' }]);
  assert.equal(request.url, 'https://computer.example/api/createAgentAutomation');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(request.options.headers, { 'x-route-id': 'route-1', 'content-type': 'application/json', authorization: 'Bearer gateway-only' });
  assert.equal(request.options.body, '{"id":"bot","spec":{}}');
});

test('gateway adapter permits HTTP only for loopback origins', () => {
  for (const baseUrl of ['http://localhost:6080', 'http://127.0.0.1:6080', 'http://[::1]:6080']) {
    assert.ok(createGatewayClient({ baseUrl, token: 'token' }));
  }
  for (const baseUrl of ['http://computer.example', 'http://192.168.1.10:6080', 'https://user:pw@computer.example',
    'https://computer.example/api', 'https://computer.example?token=oops', 'https://computer.example/#id']) {
    assert.throws(() => createGatewayClient({ baseUrl, token: 'token' }));
  }
});

test('gateway adapter never accepts ambient authentication headers', () => {
  for (const name of ['Authorization', 'cookie', 'Proxy-Authorization', 'Host', 'Content-Type']) {
    assert.throws(() => createGatewayClient({ baseUrl: 'https://computer.example', token: 'token', headers: { [name]: 'ambient-account-secret' } }), /must not override/);
  }
  assert.throws(() => createGatewayClient({ baseUrl: 'https://computer.example' }), /gateway token/);
  assert.throws(() => createGatewayClient({ baseUrl: 'https://computer.example', token: 'a\nb' }), /gateway token/);
});

test('gateway calls reject unlisted methods and bad arguments without fetching', async () => {
  let calls = 0;
  const gateway = createGatewayClient({ baseUrl: 'https://computer.example', token: 'token', fetchImpl: async () => { calls++; } });
  await assert.rejects(gateway.rpcGateway('deleteAgent', { id: 'bot' }), /Unsupported gateway method/);
  await assert.rejects(gateway.rpcGateway('../createAgentAutomation', {}), /Unsupported gateway method/);
  await assert.rejects(gateway.rpcGateway('getAgentThread', []), /arguments must be an object/);
  await assert.rejects(gateway.rpcGateway('getAgentThread', {}, { timeoutMs: 0 }), /timeoutMs/);
  assert.equal(calls, 0);
});

test('gateway failures never retry or reveal response bodies', async () => {
  let calls = 0;
  const gateway = createGatewayClient({ baseUrl: 'https://computer.example', token: 'gateway-secret', fetchImpl: async () => {
    calls++; return new Response('gateway-secret with sensitive prompt', { status: 503 });
  } });
  await assert.rejects(gateway.rpcGateway('runAgentAutomationNow', { id: 'bot', automationId: 'routine' }), error =>
    error.status === 503 && /not retried/.test(error.message) && !error.message.includes('gateway-secret'));
  assert.equal(calls, 1);
});

test('network failures and invalid JSON are not replayed', async () => {
  let calls = 0;
  const gateway = createGatewayClient({ baseUrl: 'https://computer.example', token: 'token', fetchImpl: async () => {
    calls++; throw new Error('connection reset');
  } });
  await assert.rejects(gateway.rpcGateway('updateAgentAutomation', { id: 'bot' }), { code: 'gateway_network_error' });
  assert.equal(calls, 1);
  const invalid = createGatewayClient({ baseUrl: 'https://computer.example', token: 'token', fetchImpl: async () => new Response('{oops') });
  await assert.rejects(invalid.rpcGateway('getConversationOutline', { id: 'bot' }), { code: 'invalid_gateway_response' });
});

test('gateway respects an aborted signal before dispatch', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  const gateway = createGatewayClient({ baseUrl: 'https://computer.example', token: 'token', fetchImpl: async () => { calls++; } });
  await assert.rejects(gateway.rpcGateway('getAgentThread', { id: 'bot', rootId: 'root' }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('gateway bounds large responses before reading them', async () => {
  const gateway = createGatewayClient({ baseUrl: 'https://computer.example', token: 'token', fetchImpl: async () => new Response('[]', {
    headers: { 'content-length': String(9 * 1024 * 1024) },
  }) });
  await assert.rejects(gateway.rpcGateway('getConversationOutline', { id: 'bot' }), /exceeds 8 MiB/);
});

test('gateway validates complete plain JSON without silently changing values', async () => {
  let calls = 0;
  const gateway = createGatewayClient({ baseUrl: 'https://computer.example', token: 'token', fetchImpl: async () => {
    calls++; return Response.json({ ok: true });
  } });
  const cyclic = {}; cyclic.self = cyclic;
  const accessor = {}; let reads = 0;
  Object.defineProperty(accessor, 'secret', { enumerable: true, get() { reads++; return 'secret'; } });
  const withHidden = {}; Object.defineProperty(withHidden, 'hidden', { value: 'secret' });
  const symbolKey = { [Symbol('private')]: 'secret' };
  const withArrayProperty = []; withArrayProperty.extra = 'secret';
  for (const args of [new Date(), { value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n },
    { value: () => 1 }, { value: new Date() }, cyclic, accessor, withHidden, symbolKey,
    { value: [, 'hole'] }, { value: withArrayProperty }]) {
    await assert.rejects(gateway.rpcGateway('sendPrompt', args), /JSON|object|circular|hidden|accessors|symbol|arrays/);
  }
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('gateway argument size and nesting limits apply before dispatch', async () => {
  let calls = 0;
  const gateway = createGatewayClient({ baseUrl: 'https://computer.example', token: 'token', fetchImpl: async () => {
    calls++; return Response.json({ ok: true });
  } });
  let nested = {};
  for (let index = 0; index < 65; index++) nested = { nested };
  await assert.rejects(gateway.rpcGateway('sendPrompt', nested), /nesting limit/);
  await assert.rejects(gateway.rpcGateway('sendPrompt', { prompt: 'x'.repeat(8 * 1024 * 1024) }), /exceeds 8 MiB/);
  assert.equal(calls, 0);
});

test('gateway transport errors cannot disclose credentials or prompt text', async () => {
  let calls = 0;
  const secret = 'gateway-secret';
  const gateway = createGatewayClient({ baseUrl: 'https://computer.example', token: secret, fetchImpl: async () => {
    calls++; throw new Error(`Connection failed: ${secret} sensitive-prompt`);
  } });
  await assert.rejects(gateway.rpcGateway('sendPrompt', { text: 'sensitive-prompt' }), error =>
    error.code === 'gateway_network_error' && !/gateway-secret|sensitive-prompt/.test(error.message));
  assert.equal(calls, 1);
});

test('gateway token rejects whitespace and control characters', () => {
  for (const token of [' token', 'token ', 'two tokens', 'token\tvalue', 'token\u0000', 'token\u007f']) {
    assert.throws(() => createGatewayClient({ baseUrl: 'https://computer.example', token }), /gateway token/);
  }
});
