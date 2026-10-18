import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runApiCli } from '../src/api-cli.mjs';
import { getSchema, listApiMethods, validateApiRequest } from '../src/schema.mjs';
import { apiMethodSupport, supportedApiMethods } from '../src/support.mjs';

function sampleField(field) {
  const schema = getSchema();
  if (field.repeated) return [];
  if (field.kind === 'map') return {};
  if (field.kind === 'message') return field.type === 'google.protobuf.Value' ? { value: ['literal', false, 1] } : {};
  if (field.kind === 'enum') return schema.enums[field.type].values[0].name;
  if (field.type === 'string') return 'literal --value $untouched';
  if (field.type === 'bytes') return 'AQID';
  if (field.type === 'bool') return false;
  if (field.type.endsWith('64')) return '1234567890123456789';
  if (['float', 'double'].includes(field.type)) return 1.25;
  return 12;
}
function verifiedInput(method) {
  const { verification } = apiMethodSupport(method), input = {};
  for (const name of verification.requiredRequestFields ?? []) {
    input[name] = verification.allowedFieldValues?.[name]?.[0] ?? verification.minIntegerFields?.[name]
      ?? verification.maxIntegerFields?.[name] ?? sampleField(method.inputFields.find(field => field.jsonName === name));
  }
  for (const name of verification.nonEmptyArrayFields ?? []) input[name] = ['test-owned-member'];
  return input;
}

test('every live-supported CLI operation routes to its own service and streaming transport', async () => {
  const calls = [], output = [];
  const client = {
    async rpc(name, body, options) { calls.push(['unary', name, body, options.service]); return { ok: true }; },
    async *stream(name, body, options) { calls.push(['server', name, body, options.service]); yield { ok: true }; },
    async *duplex(name, source, options) { const bodies = []; for await (const b of source) bodies.push(b); calls.push(['bidirectional', name, bodies[0], options.service]); yield { ok: true }; },
  };
  for (const method of supportedApiMethods()) {
    const input = verifiedInput(method);
    const handled = await runApiCli(['api', `${method.serviceName}.${method.alias}`, '--json', JSON.stringify(input)], client, {
      print: value => output.push(value), writeFrame: value => output.push(value),
    });
    assert.equal(handled, true);
    assert.deepEqual(calls.at(-1), [method.streaming, method.name, validateApiRequest(method, input), method.serviceName]);
  }
  assert.ok(calls.length > 0);
  assert.equal(calls.length, supportedApiMethods().length);
  assert.equal(output.length, supportedApiMethods().length);
  assert.equal(await runApiCli(['list'], client), false);
});

test('catalog/schema inspection is offline and recursive schema includes referenced messages', async () => {
  let value;
  const offline = new Proxy({}, { get() { throw new Error('network client accessed'); } });
  await runApiCli(['api', 'list', '--service', 'GrokBotService'], offline, { print: x => value = x });
  assert.equal(value.length, supportedApiMethods({ service: 'GrokBotService' }).length);
  assert.ok(value.every(method => method.supported === true));
  await runApiCli(['api', 'schema', 'UpdateGrokBotAgentAccess', '--recursive'], offline, { print: x => value = x });
  assert.equal(value.method.name, 'UpdateGrokBotAgentAccess');
  assert.ok(Object.keys(value.messages).length > 1);
});

test('named fields preserve explicit defaults, precision, aliases and nested JSON', async () => {
  let body;
  const client = { async rpc(name, input) { body = input; return {}; } };
  await runApiCli(['api', 'SendGrokBotUserMessage', '--agent-id', 'agent', '--text=--literal', '--sent-at-ms', '9223372036854775807', '--attachment-paths', '["a"]', '--json', '{"source":1}'], client, { print() {} });
  assert.equal(body.agentId, 'agent');
  assert.equal(body.text, '--literal');
  assert.equal(body.sentAtMs, '9223372036854775807');
  assert.deepEqual(body.attachmentPaths, ['a']);
});

test('invalid methods, unknown fields, duplicates and conflicting inputs fail before network', async () => {
  let requests = 0;
  const client = { async rpc() { requests++; } };
  const inputs = [
    ['api', 'WrongMethod'], ['api', 'ListGrokBotAgents', '--unknown', '1'],
    ['api', 'ListGrokBotAgents', '--include-team-agents', 'false', '--json', '{"includeTeamAgents":true}'],
    ['api', 'ListGrokBotAgents', '--json', '{}', '--json-file', 'missing.json'],
    ['api', 'ListGrokBotAgents', '--timeout-ms', '0'],
    ['api', 'ListGrokBotAgents', '--input-ndjson', '-'],
    ['api', 'stream', 'ListGrokBotAgents'],
  ];
  for (const input of inputs) await assert.rejects(runApiCli(input, client, { print() {} }));
  assert.equal(requests, 0);
});

test('bidirectional CLI forwards every NDJSON request object with protobuf JSON validation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-api-cli-'));
  try {
    const file = path.join(dir, 'audio.ndjson');
    fs.writeFileSync(file, '{"audio":{"pcm16":"aGVsbG8="}}\r\n\r\n{"audio":{"pcm16":"d29ybGQ="}}');
    let requests;
    const output = [];
    const client = { async *duplex(name, source, options) { assert.equal(name, 'StreamStt'); assert.equal(options.service, 'AiService'); requests = []; for await (const request of source) requests.push(request); yield { text: 'hello world' }; } };
    await runApiCli(['api', 'AiService.StreamStt', '--input-ndjson', file], client, { writeFrame: r => output.push(r) });
    assert.deepEqual(requests, [{ audio: { pcm16: 'aGVsbG8=' } }, { audio: { pcm16: 'd29ybGQ=' } }]);
    assert.deepEqual(output, [{ text: 'hello world' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every supported named request field reaches its transport with the same validated value', async () => {
  let observed, checked = 0;
  const client = {
    async rpc(_name, body) { observed = body; return {}; },
    async *stream(_name, body) { observed = body; yield {}; },
    async *duplex(_name, source) { for await (const body of source) observed = body; yield {}; },
  };
  for (const method of supportedApiMethods()) for (const field of method.inputFields) {
    const { verification } = apiMethodSupport(method);
    if (verification.allowedRequestFields && !verification.allowedRequestFields.includes(field.jsonName)) continue;
    let value = verification.allowedFieldValues?.[field.jsonName]?.[0] ?? sampleField(field);
    if (verification.nonEmptyArrayFields?.includes(field.jsonName)) value = ['test-owned-member'];
    if (verification.maxIntegerFields?.[field.jsonName]) value = verification.maxIntegerFields[field.jsonName];
    const argument = field.repeated || ['map', 'message'].includes(field.kind) ? JSON.stringify(value) : String(value);
    const baseline = verifiedInput(method);
    delete baseline[field.jsonName];
    const expected = validateApiRequest(method, { ...baseline, [field.jsonName]: value });
    const option = field.jsonName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    observed = undefined;
    await runApiCli(['api', `${method.serviceName}.${method.name}`, '--json', JSON.stringify(baseline), `--${option}`, argument], client, { print() {}, writeFrame() {} });
    assert.deepEqual(observed, expected, `${method.serviceName}.${method.name}.${field.jsonName}`);
    checked++;
  }
  assert.equal(checked, supportedApiMethods().reduce((count, method) => count + method.inputFields.filter(field => {
    const { verification } = apiMethodSupport(method);
    return !verification.allowedRequestFields || verification.allowedRequestFields.includes(field.jsonName);
  }).length, 0));
});

test('unverified request fields and modes cannot bypass support through raw JSON or aliases', async () => {
  const forbidden = new Proxy({}, { get() { assert.fail('Unverified request shapes must fail before client access.'); } });
  for (const method of supportedApiMethods()) {
    const { verification } = apiMethodSupport(method);
    const rejects = [];
    if (verification.allowedRequestFields) for (const field of method.inputFields) {
      if (!verification.allowedRequestFields.includes(field.jsonName)) rejects.push({ ...verifiedInput(method), [field.protoName]: sampleField(field) });
    }
    for (const field of verification.requiredRequestFields ?? []) {
      rejects.push({ ...verifiedInput(method), [field]: null });
      const omitted = verifiedInput(method); delete omitted[field]; rejects.push(omitted);
    }
    for (const field of verification.nonEmptyArrayFields ?? []) {
      rejects.push({ ...verifiedInput(method), [field]: [] }, { ...verifiedInput(method), [field]: null });
      const omitted = verifiedInput(method); delete omitted[field]; rejects.push(omitted);
    }
    for (const [field, allowed] of Object.entries(verification.allowedFieldValues ?? {})) {
      const definition = method.inputFields.find(value => value.jsonName === field);
      const alternatives = definition.kind === 'enum' ? getSchema().enums[definition.type].values.map(value => value.name)
        : definition.type === 'bool' ? [true, false] : [];
      for (const value of alternatives.filter(value => !allowed.includes(value))) rejects.push({ ...verifiedInput(method), [field]: value });
      rejects.push({ ...verifiedInput(method), [field]: null });
    }
    for (const [field, maximum] of Object.entries(verification.maxIntegerFields ?? {})) rejects.push({ ...verifiedInput(method), [field]: (BigInt(maximum) + 1n).toString() });
    for (const [field, minimum] of Object.entries(verification.minIntegerFields ?? {})) rejects.push({ ...verifiedInput(method), [field]: (BigInt(minimum) - 1n).toString() });
    for (const group of verification.mutuallyExclusiveTrueFields ?? []) rejects.push({ ...verifiedInput(method), ...Object.fromEntries(group.map(field => [field, true])) });
    for (const input of rejects) {
      await assert.rejects(runApiCli(['api', `${method.serviceName}.${method.name}`, '--json', JSON.stringify(input)], forbidden),
        { name: 'UnsupportedOperationError', code: 'request_not_live_verified' });
    }
  }
  await assert.rejects(runApiCli(['api', 'CreateGrokBotAgent', '--harness', 'BOX'], forbidden), { code: 'request_not_live_verified' });
  await assert.rejects(runApiCli(['api', 'CreateGrokBotAgent', '--harness', '1'], forbidden), { code: 'request_not_live_verified' });
});

test('request-mode constraints compare canonical aliases and preserve permitted false values', async () => {
  const forbidden = new Proxy({}, { get() { assert.fail('Invalid canonical modes must not access the client.'); } });
  await assert.rejects(runApiCli(['api', 'GrokBotService.UpdateGrokBotAgent', '--json', '{"partial_update":false}'], forbidden),
    { code: 'request_not_live_verified' });
  await assert.rejects(runApiCli(['api', 'GrokBotService.BeginGrokBotAttachmentUpload', '--json',
    '{"supports_multipart":false,"supports_store_attachment_refs":true,"size_bytes":"5.242881e6"}'], forbidden),
  { code: 'request_not_live_verified' });
  await assert.rejects(runApiCli(['api', 'SetGrokBotAgentClientState', '--json', '{"mark_read":true,"mark_unread":true}'], forbidden),
    { code: 'request_not_live_verified' });
  let actual;
  const client = { async rpc(_method, body) { actual = body; return {}; } };
  await runApiCli(['api', 'GrokBotService.BeginGrokBotAttachmentUpload', '--json',
    '{"supports_multipart":false,"supports_store_attachment_refs":true,"size_bytes":"5.242880e6"}'], client, { print() {} });
  assert.deepEqual(actual, { supportsMultipart: false, supportsStoreAttachmentRefs: true, sizeBytes: '5242880' });
});

test('nested values, prototype keys and duplicate aliases cannot circumvent request-mode checks', async () => {
  const forbidden = new Proxy({}, { get() { assert.fail('Malformed nested requests must fail before client access.'); } });
  for (const [method, json] of [
    ['CreateGrokBotAgent', '{"harness":"TEMPORAL","__proto__":{"harness":"BOX"}}'],
    ['CreateGrokBotAgent', '{"harness":{"value":"TEMPORAL"}}'],
    ['UpdateGrokBotUserRuntimeSettings', '{"pinnedAgents":[{"hiddenFromSidebar":true}]}'],
    ['SetGrokBotAgentClientState', '{"markRead":{"value":true}}'],
    ['BeginGrokBotAttachmentUpload', '{"supports_multipart":false,"supportsMultipart":true}'],
  ]) await assert.rejects(runApiCli(['api', method, '--json', json], forbidden), { name: 'ApiSchemaError' });
});

test('unverified reference methods never dispatch or read input files through any CLI alias', async () => {
  const unavailable = listApiMethods().filter(method => !apiMethodSupport(method).supported);
  assert.ok(unavailable.length > 0);
  const forbidden = new Proxy({}, { get() { assert.fail('Unavailable operations must fail before client access.'); } });
  for (const method of unavailable) {
    await assert.rejects(runApiCli(['api', `${method.serviceName}.${method.name}`, '--json-file', '/missing/input.json'], forbidden),
      { name: 'UnsupportedOperationError', code: 'operation_not_live_verified' });
  }
  const method = unavailable[0];
  for (const args of [
    ['call', `${method.serviceName}.${method.alias}`],
    ['stream', `/${method.service}/${method.name}`],
    [method.name, '--service', method.serviceName],
  ]) await assert.rejects(runApiCli(['api', ...args, '--json', '{}'], forbidden), { code: 'operation_not_live_verified' });
});

test('unverified methods remain inspectable as explicitly unsupported references', async () => {
  const method = listApiMethods().find(entry => !apiMethodSupport(entry).supported);
  const forbidden = new Proxy({}, { get() { assert.fail('Schema inspection must remain offline.'); } });
  let output;
  await runApiCli(['api', 'schema', `${method.serviceName}.${method.name}`], forbidden, { print: value => output = value });
  assert.equal(output.supported, false);
  assert.equal(typeof output.reason, 'string');
  assert.ok(output.reason.length > 0);
  await runApiCli(['api', 'schema', `${method.serviceName}.${method.name}`, '--recursive'], forbidden, { print: value => output = value });
  assert.equal(output.method.supported, false);
  assert.ok(output.messages[method.inputType]);
});

test('invalid single bidirectional input is rejected before calling its transport', async () => {
  let calls = 0;
  const client = { async *duplex() { calls++; yield {}; } };
  for (const args of [
    ['--bad-field', 'value'], ['--json', '{'], ['--audio', '"bad audio object"'],
    ['--json', '{}', '--json-file', '/missing/input.json'], ['--input-ndjson='],
  ]) await assert.rejects(runApiCli(['api', 'AiService.StreamStt', ...args], client, { writeFrame() {} }));
  assert.equal(calls, 0);
});

test('floating point flags accept ProtoJSON special numeric values', async () => {
  let observed;
  const client = { async rpc(_name, body) { observed = body; return {}; } };
  for (const value of ['NaN', 'Infinity', '-Infinity']) {
    await runApiCli(['api', 'AiService.TextToSpeech', '--speed', value], client, { print() {} });
    assert.equal(observed.speed, value);
  }
});

test('SIGINT and SIGTERM cancellations are errors and restore process listeners', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const before = process.listenerCount(signal), output = [];
    const client = { async rpc(_name, _body, options) { process.emit(signal); options.signal.throwIfAborted(); } };
    await assert.rejects(runApiCli(['api', 'SendGrokBotUserMessage', '--agent-id', 'test'], client,
      { print: value => output.push(value) }), { name: 'AbortError', code: 'operation_cancelled', signal });
    assert.equal(process.listenerCount(signal), before);
    assert.deepEqual(output, []);
  }
});

test('JSON and NDJSON file limits apply while reading, before collecting unbounded input', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-api-bounded-'));
  const file = path.join(dir, 'too-large.json');
  const descriptor = fs.openSync(file, 'w');
  fs.ftruncateSync(descriptor, 16 * 1024 * 1024 + 1); fs.closeSync(descriptor);
  try {
    let calls = 0;
    await assert.rejects(runApiCli(['api', 'ListGrokBotAgents', '--json-file', file],
      { async rpc() { calls++; } }, { print() {} }), /exceeds 16 MiB/);
    assert.equal(calls, 0);
    await assert.rejects(runApiCli(['api', 'AiService.StreamStt', '--input-ndjson', file],
      { async *duplex(_name, source) { for await (const value of source) yield value; } }, { writeFrame() {} }), /NDJSON line 1 exceeds 16 MiB/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('JSON standard input is capped before it reaches the API client', () => {
  const module = new URL('../src/api-cli.mjs', import.meta.url).href;
  const script = `import { runApiCli } from ${JSON.stringify(module)};
    try { await runApiCli(['api','ListGrokBotAgents','--json-file','-'], { async rpc() { console.log('unexpected request'); } }); }
    catch (error) { console.log(error.message); process.exitCode = 1; }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    input: Buffer.alloc(16 * 1024 * 1024 + 1, 32), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /JSON input exceeds 16 MiB/);
  assert.doesNotMatch(result.stdout, /unexpected request/);
});
