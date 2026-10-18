import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGatewayClient, gatewayMethods, gatewayMethodSchemas,
  getGatewayMethodSchema, gatewayCapabilities,
} from '../src/gateway.mjs';
import { runGatewayCli } from '../src/gateway-cli.mjs';
import { supportedGatewayMethods } from '../src/support.mjs';

const forbiddenClient = () => ({ rpc: async () => {
  assert.fail('Offline validation must not connect to a computer.');
} });
const outputText = output => output.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n');

async function withLocalGateway(run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, method: request.method, headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ accepted: true, extraResponse: { retained: ['nested', 3] } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const directory = await mkdtemp(join(tmpdir(), 'grok-gateway-coverage-'));
  const descriptor = { baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test-gateway-token',
    headers: { 'x-route-id': 'test-route' } };
  const descriptorFile = join(directory, 'gateway descriptor.json');
  await writeFile(descriptorFile, JSON.stringify(descriptor), { mode: 0o600 });
  try { await run({ directory, descriptor, descriptorFile, requests }); }
  finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test('gateway inventory exposes every declared method with inspectable schema metadata', () => {
  assert.equal(gatewayMethods.length, 172);
  assert.equal(new Set(gatewayMethods).size, 172);
  assert.equal(gatewayMethodSchemas.length, 172);
  for (const method of gatewayMethods) {
    assert.match(method, /^[A-Za-z][A-Za-z0-9]*$/);
    const schema = getGatewayMethodSchema(method);
    assert(schema && typeof schema === 'object', `Missing schema for ${method}`);
    assert(gatewayMethodSchemas.includes(schema), `Schema lookup for ${method} must use the inventory`);
    assert(JSON.stringify(schema).includes(method), `Schema for ${method} must identify its method`);
  }
});

test('all 172 declared gateway routes dispatch once and retain complete nested request and response values', async () => {
  const requests = [];
  const args = { id: 'test-bot', nestedFutureOption: { tuple: [null, false, 0, 'literal $(not-a-command)'],
    deeply: { unknownField: 'retained' } }, empty: {} };
  const expected = { accepted: true, futureResponse: { nested: [1, { retained: true }] } };
  const gateway = createGatewayClient({ baseUrl: 'https://gateway.example', token: 'test-token',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return Response.json(expected);
    } });
  for (const method of gatewayMethods) assert.deepEqual(await gateway.rpcGateway(method, args), expected);
  assert.equal(requests.length, 172);
  assert.deepEqual(requests.map(request => request.url), gatewayMethods.map(method => `https://gateway.example/api/${method}`));
  for (const { init } of requests) {
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(init.body), args);
  }
});

test('expanded gateway coverage distinguishes inventory from historical live verification', () => {
  assert.equal(gatewayCapabilities.liveVerified, false);
  assert.deepEqual(new Set(gatewayCapabilities.implemented), new Set(gatewayMethods));
  const historicallyVerified = gatewayCapabilities.liveVerifiedMethods ?? [];
  assert(historicallyVerified.length < gatewayMethods.length);
  for (const method of historicallyVerified) assert(gatewayMethods.includes(method));
});

test('gateway CLI lists only supported methods and describes references entirely offline', async () => {
  const output = [];
  const print = value => output.push(value);
  assert.equal(await runGatewayCli(['other-command'], forbiddenClient(), { print }), false);
  assert.deepEqual(output, []);
  assert.equal(await runGatewayCli(['gateway-api'], forbiddenClient(), { print }), true);
  assert(outputText(output).includes('gateway-api'));
  output.length = 0;
  assert.equal(await runGatewayCli(['gateway-api', 'list'], forbiddenClient(), { print }), true);
  assert.deepEqual(output[0].methods, supportedGatewayMethods());
  assert.equal(output[0].count, supportedGatewayMethods().length);
  assert.equal(output[0].referenceCount, gatewayMethods.length);
  output.length = 0;
  assert.equal(await runGatewayCli(['gateway-api', 'schema', gatewayMethods[0]], forbiddenClient(), { print }), true);
  assert(outputText(output).includes(gatewayMethods[0]));
  assert.equal(output[0].supported, supportedGatewayMethods().includes(gatewayMethods[0]));
});

test('unverified gateway methods fail before descriptor reads or account connection', async () => {
  const methods = gatewayMethods.filter(method => !supportedGatewayMethods().includes(method));
  assert.ok(methods.length > 0);
  const forbidden = new Proxy({}, { get() { assert.fail('Unavailable gateway calls must never connect.'); } });
  for (const method of methods) for (const connection of [['--connect'], ['--gateway', '/missing/descriptor.json']]) {
    await assert.rejects(runGatewayCli(['gateway-api', method, ...connection, '--args-file', '/missing/arguments.json'], forbidden),
      { name: 'UnsupportedOperationError', code: 'operation_not_live_verified' });
  }
});

test('gateway CLI validates missing and unsupported methods before connecting', async () => {
  for (const argv of [
    ['gateway-api', 'schema'],
    ['gateway-api', 'schema', 'notAGatewayMethod'],
    ['gateway-api', 'notAGatewayMethod', '--connect'],
    ['gateway-api', '../getAgentThread', '--connect'],
  ]) await assert.rejects(runGatewayCli(argv, forbiddenClient(), { print() {} }));
});

test('gateway CLI rejects ambiguous or malformed options without connecting', async () => {
  for (const tail of [
    ['--unknown', 'value'],
    ['--args'],
    ['--gateway'],
    ['--timeout'],
    ['--connect', '--timeout', 'NaN'],
    ['--connect', '--timeout', '0'],
    ['--connect', '--timeout', '300001'],
    ['--connect', '--args', '{}', '--args', '{}'],
    ['--connect', '--args-file', 'one.json', '--args-file', 'two.json'],
    ['--gateway', 'one.json', '--gateway', 'two.json'],
    ['--connect', '--connect'],
    ['--connect', '--args', '{}', '--args-file', 'args.json'],
    ['--gateway', 'descriptor.json', '--connect'],
    ['unexpected-positional'],
  ]) await assert.rejects(runGatewayCli(['gateway-api', 'getAgentThread', ...tail], forbiddenClient(), { print() {} }),
    `Accepted invalid options: ${JSON.stringify(tail)}`);
});

test('gateway CLI requires an explicit connection and validates object JSON before side effects', async () => {
  await assert.rejects(runGatewayCli(['gateway-api', 'getAgentThread', '--args', '{}'], forbiddenClient(), { print() {} }));
  for (const args of ['[]', 'null', '"text"', '17', 'true', '{not-json']) {
    await assert.rejects(runGatewayCli(['gateway-api', 'getAgentThread', '--args', args, '--connect'],
      forbiddenClient(), { print() {} }));
  }
});

test('gateway CLI uses an explicit descriptor file and preserves the raw object response', async () => {
  await withLocalGateway(async ({ descriptorFile, requests }) => {
    const output = [];
    const args = { id: 'bot', futureInput: { values: [false, 0, null, 'unchanged'] } };
    assert.equal(await runGatewayCli(['gateway-api', 'getAgentThread', '--args', JSON.stringify(args),
      '--gateway', descriptorFile, '--timeout', '1000'], forbiddenClient(), { print: value => output.push(value) }), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/api/getAgentThread');
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].headers.authorization, 'Bearer test-gateway-token');
    assert.equal(requests[0].headers['x-route-id'], 'test-route');
    assert.deepEqual(requests[0].body, args);
    assert(outputText(output).includes('extraResponse'));
    assert(outputText(output).includes('retained'));
  });
});

test('gateway CLI reads JSON argument files and sends an empty object when args are omitted', async () => {
  await withLocalGateway(async ({ directory, descriptorFile, requests }) => {
    const argsFile = join(directory, 'literal arguments.json');
    const args = { id: 'bot', nested: { text: '`no-shell` $(no-shell)' } };
    await writeFile(argsFile, JSON.stringify(args), { mode: 0o600 });
    assert.equal(await runGatewayCli(['gateway-api', 'getAgentThread', '--args-file', argsFile,
      '--gateway', descriptorFile], forbiddenClient(), { print() {} }), true);
    assert.equal(await runGatewayCli(['gateway-api', 'listAgents', '--gateway', descriptorFile],
      forbiddenClient(), { print() {} }), true);
    assert.deepEqual(requests.map(request => request.body), [args, {}]);
  });
});

test('gateway CLI rejects invalid argument files before an explicit connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grok-gateway-invalid-'));
  const argsFile = join(directory, 'invalid.json');
  try {
    for (const content of ['[]', 'null', 'false', '"value"', '2', '{invalid-json']) {
      await writeFile(argsFile, content);
      await assert.rejects(runGatewayCli(['gateway-api', 'getAgentThread', '--args-file', argsFile, '--connect'],
        forbiddenClient(), { print() {} }));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('gateway CLI resolves a connection only when --connect is explicitly supplied', async () => {
  await withLocalGateway(async ({ descriptor, requests }) => {
    const accountCalls = [];
    const client = { rpc: async (...args) => {
      accountCalls.push(args);
      return { gatewayUrl: descriptor.baseUrl, gatewayToken: descriptor.token, networkToken: 'test-network-token' };
    } };
    assert.equal(await runGatewayCli(['gateway-api', 'listAgents', '--connect', '--timeout', '1000'], client,
      { print() {} }), true);
    assert.equal(accountCalls.length, 1);
    assert.equal(accountCalls[0][0], 'EnsureSandBox');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/api/listAgents');
    assert.equal(requests[0].headers['x-anyrun-network-token'], 'test-network-token');
  });
});
