import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getSchema, listApiMethods, resolveApiMethod, validateApiRequest, ApiSchemaError } from '../src/schema.mjs';

const schema = getSchema();
const native = (type, value) => validateApiRequest({ name: 'TestNativeValue', inputType: `google.protobuf.${type}` }, value);

test('catalog preserves the complete audited protocol, including streaming and all references', () => {
  assert.equal(listApiMethods().length, 472);
  assert.equal(Object.keys(schema.messages).length, 2309);
  assert.equal(Object.keys(schema.enums).length, 283);
  assert.deepEqual(Object.fromEntries(schema.services.map(service => [service.exportName, service.methods.length])), {
    AgentStoreService: 6, AiService: 8, AnalyticsService: 8, BackgroundComposerService: 7,
    DashboardService: 75, GrokBotService: 313, SandBoxService: 55,
  });
  for (const method of listApiMethods()) {
    assert.ok(schema.messages[method.inputType]);
    assert.ok(schema.messages[method.outputType]);
    assert.deepEqual(validateApiRequest(method, {}), {}, `${method.serviceName}.${method.name} must not invent required proto3 fields`);
    assert.equal(resolveApiMethod(`${method.serviceName}.${method.alias}`), method);
  }
  for (const message of Object.values(schema.messages)) for (const field of message.fields) {
    const kind = field.kind === 'map' ? field.valueKind : field.kind;
    const type = field.kind === 'map' ? field.valueType : field.type;
    if (kind === 'message') assert.ok(schema.messages[type], `missing ${type}`);
    if (kind === 'enum') assert.ok(schema.enums[type], `missing ${type}`);
  }
  assert.equal(resolveApiMethod('AiService.StreamStt').streaming, 'bidirectional');
  assert.equal(resolveApiMethod('WatchGrokBotTranscripts').streaming, 'server');
  assert.ok(Object.isFrozen(schema.messages));
  assert.throws(() => { schema.services[0].methods.push({}); }, TypeError);
});

test('gateway and web catalogs retain provenance and distinct complete method sets', () => {
  const gateway = JSON.parse(fs.readFileSync(new URL('../schema/gateway-methods.json', import.meta.url)));
  const web = JSON.parse(fs.readFileSync(new URL('../schema/web-relay.json', import.meta.url)));
  assert.equal(gateway.methods.length, 172);
  assert.equal(new Set(gateway.methods.map(method => method.name)).size, 172);
  assert.ok(gateway.methods.every(method => method.declaration && Number.isInteger(method.offset)));
  assert.equal(web.methods.length, 123);
  assert.equal(web.clientMethods.length, 10);
  assert.ok(web.clientMethods.includes('bot.command'));
  assert.ok(!web.clientMethods.includes('bot.event'));
  assert.match(web.provenance.sha256, /^[a-f0-9]{64}$/);
  assert.equal(web.methods.filter(name => gateway.methods.some(method => method.name === name)).length, 97);
});

test('method lookup handles full service names, kebab/camel/Pascal aliases and duplicate defaults', () => {
  const core = resolveApiMethod('EnsureSandBox');
  assert.equal(core.serviceName, 'GrokBotService');
  assert.equal(resolveApiMethod('ensure-sand-box'), core);
  assert.equal(resolveApiMethod('ensureSandBox'), core);
  assert.equal(resolveApiMethod('/aiserver.v1.GrokBotService/EnsureSandBox'), core);
  assert.equal(resolveApiMethod('EnsureSandBox', { service: 'SandBoxService' }).serviceName, 'SandBoxService');
  assert.equal(listApiMethods({ service: 'grok-bot', search: 'transcript' }).length > 0, true);
  assert.throws(() => resolveApiMethod('not-a-real-method'), /unknown API method/);
  assert.throws(() => resolveApiMethod('SandBoxService.EnsureSandBox', { service: 'GrokBotService' }), /conflicts/);
});

test('request normalization retains explicit defaults and all advanced send fields', () => {
  const input = {
    agent_id: 'agent', message_id: 'message', text: '', sent_at_ms: '9223372036854775807',
    rich_text: '', reply_to_id: '', is_fork: false, attachment_paths: [], attachment_names: [],
    traceparent: '', enter_epoch_ms: 0, composed_at_ms: '1e3', source: 1,
    mcp_config_json: '{}', session_id: 'session', machine_id: '', one_password_app_installed: false,
    initiator: 0, task_id: '', send_source: 0,
  };
  const output = validateApiRequest('SendGrokBotUserMessage', input);
  assert.equal(Object.keys(output).length, Object.keys(input).length);
  assert.equal(output.sentAtMs, '9223372036854775807');
  assert.equal(output.enterEpochMs, '0');
  assert.equal(output.composedAtMs, '1000');
  assert.equal(output.onePasswordAppInstalled, false);
  assert.equal(output.text, '');
  assert.ok(!Object.hasOwn(input, 'agentId'));
  assert.notEqual(output, input);
});

test('unknown fields, duplicate aliases, wrong scalar types and integer overflows are rejected', () => {
  assert.throws(() => validateApiRequest('ListGrokBotAgents', { typo: true }), /unknown field/);
  assert.throws(() => validateApiRequest('ListGrokBotAgents', { includeTeamAgents: true, include_team_agents: true }), /duplicate field/);
  assert.throws(() => validateApiRequest('ListGrokBotAgents', { includeTeamAgents: 'true' }), /expected boolean/);
  assert.throws(() => validateApiRequest('ListGrokBotAgents', { role: 12 }), /expected string/);
  assert.throws(() => validateApiRequest('SendGrokBotUserMessage', { sentAtMs: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/);
  assert.throws(() => validateApiRequest('SendGrokBotUserMessage', { sentAtMs: '9223372036854775808' }), /int64 range/);
  assert.throws(() => validateApiRequest('SendGrokBotUserMessage', { sentAtMs: '1.2' }), /fractional part/);
  assert.throws(() => validateApiRequest('CreateGrokBotAgentFromTemplate', { expectedActiveVersion: -1 }), /uint32 range/);
  assert.throws(() => validateApiRequest('ListGrokBotAgents', []), ApiSchemaError);
});

test('oneofs reject conflicting alternatives and accept explicit null as unset', () => {
  assert.throws(() => validateApiRequest('UpdateGrokBotAgent', { clearAvatar: {}, avatarDataUrl: 'data:image/png;base64,AA==' }), /oneof avatarChange conflicts/);
  assert.deepEqual(validateApiRequest('UpdateGrokBotAgent', { id: 'a', clear_avatar: {}, partial_update: false }), { id: 'a', clearAvatar: {}, partialUpdate: false });
  assert.deepEqual(validateApiRequest('UpdateGrokBotAgent', { clearAvatar: null, avatarDataUrl: '' }), { clearAvatar: null, avatarDataUrl: '' });
  assert.throws(() => validateApiRequest('UpdateGrokBotAgent', { clearAvatar: { unexpected: true } }), /unknown field/);
});

test('enums canonicalize numeric and short names while preserving unknown proto3 numeric values', () => {
  const expected = 'GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL';
  assert.equal(validateApiRequest('CreateGrokBotAgent', { harness: 2 }).harness, expected);
  assert.equal(validateApiRequest('CreateGrokBotAgent', { harness: 'TEMPORAL' }).harness, expected);
  assert.equal(validateApiRequest('CreateGrokBotAgent', { harness: expected }).harness, expected);
  assert.equal(validateApiRequest('CreateGrokBotAgent', { harness: 999 }).harness, 999);
  assert.throws(() => validateApiRequest('CreateGrokBotAgent', { harness: 'MADE_UP' }), /unknown .* enum name/);
});

test('maps and repeated values preserve data without allowing prototype mutation', () => {
  const values = JSON.parse('{"name":"Ada","__proto__":"literal","constructor":"value"}');
  const output = validateApiRequest('SubmitGrokBotUserForm', { values, save_to_vault: false });
  assert.deepEqual(output.values, values);
  assert.equal(Object.getPrototypeOf(output.values), Object.prototype);
  assert.equal(Object.hasOwn(output.values, '__proto__'), true);
  assert.throws(() => validateApiRequest('SubmitGrokBotUserForm', { values: { name: 123 } }), /expected string/);
  assert.throws(() => validateApiRequest('SendGrokBotUserMessage', { attachmentPaths: 'one' }), /expected an array/);
  assert.throws(() => validateApiRequest('SendGrokBotUserMessage', { attachmentPaths: ['one', null] }), /null array entries/);
});

test('nested schemas validate recursively without dropping nested fields', () => {
  const output = validateApiRequest('UpdateGrokBotAgentAccess', { agent_id: 'agent', update: { principals: [], expected_state_token: 'token', lists_cross_tier_principals: false } });
  assert.deepEqual(output, { agentId: 'agent', update: { principals: [], expectedStateToken: 'token', listsCrossTierPrincipals: false } });
  assert.throws(() => validateApiRequest('UpdateGrokBotAgentAccess', { update: { unknown: true } }), /update.unknown/);
});

test('bytes use canonical base64 and reject invalid encodings and non-JSON buffers', () => {
  assert.equal(validateApiRequest('AiService.TranscribeAudio', { audio: '__8' }).audio, '//8=');
  assert.equal(validateApiRequest('AiService.TranscribeAudio', { audio: '' }).audio, '');
  assert.throws(() => validateApiRequest('AiService.TranscribeAudio', { audio: 'not base64!' }), /base64/);
  assert.throws(() => validateApiRequest('AiService.TranscribeAudio', { audio: Buffer.from('x') }), /base64/);
});

test('Struct, Value and ListValue use native JSON and detect non-JSON or cyclic values', () => {
  const args = { filter: { any: [true, false, null, 0, ''] }, object: {} };
  assert.deepEqual(validateApiRequest('DashboardService.ExecuteSandMcpTool', { args }), { args });
  assert.deepEqual(native('Value', [null, { field_name: true }]), [null, { field_name: true }]);
  assert.deepEqual(native('ListValue', [1, 'two']), [1, 'two']);
  assert.equal(native('Value', null), null);
  assert.throws(() => native('Struct', []), /JSON object/);
  assert.throws(() => native('Value', { value: Infinity }), /finite/);
  assert.throws(() => native('Value', { value: undefined }), /JSON value/);
  assert.throws(() => native('Value', Array(1)), /JSON value/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => native('Struct', cyclic), /cyclic/);
});

test('timestamps retain nanoseconds, normalize UTC and reject impossible dates', () => {
  assert.equal(native('Timestamp', '2026-10-18T03:04:05.123456789+02:00'), '2026-10-18T01:04:05.123456789Z');
  assert.equal(native('Timestamp', '0001-01-01T00:00:00Z'), '0001-01-01T00:00:00Z');
  assert.equal(native('Timestamp', '2024-02-29T00:00:00.1Z'), '2024-02-29T00:00:00.100Z');
  assert.throws(() => native('Timestamp', '2025-02-29T00:00:00Z'), /invalid timestamp/);
  assert.throws(() => native('Timestamp', '2026-01-01'), /RFC 3339/);
});

test('duration, wrappers and field masks use native protobuf JSON forms', () => {
  assert.equal(native('Duration', '-0.001000000s'), '-0.001s');
  assert.equal(native('Duration', '10.000s'), '10s');
  assert.throws(() => native('Duration', '315576000001s'), /range/);
  assert.equal(native('Int64Value', '1844674407370955161'), '1844674407370955161');
  assert.equal(native('UInt64Value', '18446744073709551615'), '18446744073709551615');
  assert.equal(native('BoolValue', null), null);
  assert.equal(native('FloatValue', 'NaN'), 'NaN');
  assert.throws(() => native('FloatValue', '0x10'), /number/);
  assert.equal(native('FieldMask', 'avatar_shape,settings.model_id'), 'avatarShape,settings.modelId');
});

test('Any accepts known type-url messages and well-known native values while rejecting unknown types', () => {
  assert.deepEqual(native('Any', { '@type': 'type.googleapis.com/aiserver.v1.ListGrokBotAgentsRequest', include_team_agents: true }), {
    '@type': 'type.googleapis.com/aiserver.v1.ListGrokBotAgentsRequest', includeTeamAgents: true,
  });
  assert.deepEqual(native('Any', { '@type': 'type.googleapis.com/google.protobuf.Timestamp', value: '2026-10-18T01:00:00+01:00' }), {
    '@type': 'type.googleapis.com/google.protobuf.Timestamp', value: '2026-10-18T00:00:00Z',
  });
  assert.throws(() => native('Any', { '@type': 'type.googleapis.com/not.Known' }), /unknown Any/);
  assert.throws(() => native('Any', { '@type': 'type.googleapis.com/google.protobuf.Timestamp', value: '2026-10-18T00:00:00Z', other: true }), /only @type and value/);
});
