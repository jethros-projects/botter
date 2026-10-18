import test from 'node:test';
import assert from 'node:assert/strict';
import { listTools, callTool, readToolResource } from '../src/tools.mjs';

function mock(response = {}) {
  const calls = [];
  return { calls, async resolveBot() { return { agentId: 'bot-id' }; },
    async rpc(method, body, options) { calls.push({ method, body, options }); return typeof response === 'function' ? response(method, body, options) : response; } };
}

test('catalog preserves scoped server rows, status and metadata and parses schema strings', async () => {
  const client = mock({ servers: [
    { serverIdentifier: 'github:account-2', rowServerIdentifier: 'github:account-2', accountLabel: 'Work', status: 'connected',
      tools: [{ name: 'github-create_issue', toolName: 'create_issue', inputSchemaJson: '{"type":"object"}', annotationsJson: '{"readOnlyHint":false}' }] },
    { serverIdentifier: 'finance', status: 'needsAuth', tools: [] },
  ] });
  const result = await listTools(client, { server: 'github:account-2' });
  assert.deepEqual(client.calls[0].body, { serverIdentifiers: ['github:account-2'] });
  assert.equal(client.calls[0].options.service, 'DashboardService');
  assert.equal(result.servers[0].serverIdentifier, 'github:account-2');
  assert.deepEqual(result.servers[0].tools[0].inputSchema, { type: 'object' });
  assert.deepEqual(result.servers[0].tools[0].annotations, { readOnlyHint: false });
  assert.equal(result.servers[1].status, 'needsAuth');
});

test('catalog handles invalid schema JSON without losing original metadata', async () => {
  const client = mock({ servers: [{ tools: [{ inputSchemaJson: 'not-json' }] }] });
  assert.equal((await listTools(client)).servers[0].tools[0].inputSchemaJson, 'not-json');
  assert.deepEqual(client.calls[0].body, { serverIdentifiers: [] });
});

test('tool call routes the exact explicit server, tool, args and caller scope', async () => {
  const client = mock({ result: { success: { content: [{ text: 'ok' }] } } });
  const controller = new AbortController();
  const result = await callTool(client, 'github:account-2', 'github-create_issue', { title: 'A', body: null, labels: ['a'] }, {
    toolCallId: 'call-1', agent: 'Alpha', grokBotPluginScope: { agentId: 'bot-id', sessionKind: 'default' },
    mcpConfigJson: '{"mcpServers":{}}', turnId: 'turn-1', eventSequence: 42, modelName: 'model',
    mcpAnalyticsReportedByCaller: false, signal: controller.signal, timeoutMs: 9000,
  });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].body, { serverIdentifier: 'github:account-2', toolName: 'github-create_issue',
    args: { title: 'A', body: null, labels: ['a'] }, toolCallId: 'call-1', agentId: 'bot-id',
    grokBotPluginScope: { agentId: 'bot-id', sessionKind: 'default' }, mcpConfigJson: '{"mcpServers":{}}',
    turnId: 'turn-1', eventSequence: '42', modelName: 'model', mcpAnalyticsReportedByCaller: false });
  assert.equal(client.calls[0].options.service, 'DashboardService');
  assert.equal(client.calls[0].options.signal, controller.signal);
  assert.equal(client.calls[0].options.timeoutMs, 9000);
  assert.equal(result.result.success.content[0].text, 'ok');
});

test('execution uses catalog name and a raw JSON Struct, without McpArgs approval fields', async () => {
  const client = mock({ result: { success: { content: [] } } });
  await callTool(client, 'cursor-github', 'cursor-github-get_me', {}, { toolCallId: 'schema-proof' });
  assert.deepEqual(client.calls[0].body, { serverIdentifier: 'cursor-github',
    toolName: 'cursor-github-get_me', args: {}, toolCallId: 'schema-proof', agentId: '' });
  await assert.rejects(callTool(client, 'cursor-github', 'cursor-github-get_me', {}, { skipApproval: true }), /not supported/);
  assert.equal(client.calls.length, 1);
});

test('tool calls reject missing arguments and non-JSON values before invoking RPC', async () => {
  const client = mock();
  const cyclic = {}; cyclic.self = cyclic;
  for (const args of [undefined, null, [], '{"x":1}', { x: undefined }, { x: NaN }, { x: Infinity }, { x: 2n }, { x: new Date() }, cyclic, { x: [, 1] }]) {
    await assert.rejects(callTool(client, 'github', 'search', args), /JSON|circular|sparse/);
  }
  await assert.rejects(callTool(client, '', 'search', {}), /server/);
  await assert.rejects(callTool(client, 'github', '', {}), /tool/);
  assert.equal(client.calls.length, 0);
});

test('caller and plugin scopes cannot contradict each other or be silently broadened', async () => {
  const client = mock();
  await assert.rejects(callTool(client, 'github', 'search', {}, { agentId: 'other', agent: 'Alpha' }), /different bots/);
  await assert.rejects(callTool(client, 'github', 'search', {}, { agentId: 'other', grokBotPluginScope: { agentId: 'bot-id', sessionKind: 'default' } }), /different bots/);
  await assert.rejects(listTools(client, { grokBotPluginScope: { agentId: 'bot-id' } }), /sessionKind/);
  await assert.rejects(listTools(client, { server: 'github', serverIdentifiers: ['gmail'] }), /not both/);
  await assert.rejects(callTool(client, 'github', 'search', {}, { mcpConfigJson: '{}' , grokBotPluginScope: { agentId: 'bot-id', sessionKind: 'default', bypass: true } }), /Unknown/);
  assert.equal(client.calls.length, 0);
});

test('empty explicit args are valid and generated tool call IDs are unique', async () => {
  const client = mock();
  await callTool(client, 'github', 'search', {});
  await callTool(client, 'github', 'search', {});
  assert.notEqual(client.calls[0].body.toolCallId, client.calls[1].body.toolCallId);
  assert.equal(client.calls[0].body.agentId, '');
  assert.deepEqual(client.calls[0].body.args, {});
});

test('MCP permission and rejection outcomes are preserved, not reported as success', async () => {
  for (const key of ['permissionDenied', 'rejected', 'error']) {
    const expected = { result: { [key]: { reason: 'Denied' } } };
    assert.deepEqual(await callTool(mock(expected), 'github', 'search', {}), expected);
  }
});

test('tool timeout or network error is propagated once without fallback or retry', async () => {
  const error = new Error('Timed out; remote application unknown.');
  const client = mock(() => { throw error; });
  await assert.rejects(callTool(client, 'github:account-2', 'create_issue', { title: 'A' }), received => received === error);
  assert.equal(client.calls.length, 1);
});

test('resource reads preserve exact server scope, URI, response error and base64 data', async () => {
  const expected = { contents: [{ uri: 'custom://repo/file', mimeType: 'image/png', blob: 'YQ==' }], error: '' };
  const client = mock(expected);
  assert.deepEqual(await readToolResource(client, 'github:account-2', 'custom://repo/file', { agentId: 'bot-id' }), expected);
  assert.deepEqual(client.calls[0].body, { serverIdentifier: 'github:account-2', uri: 'custom://repo/file', agentId: 'bot-id' });
  assert.equal(client.calls[0].options.service, 'DashboardService');
});
