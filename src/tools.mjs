import { randomUUID } from 'node:crypto';

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
}

function jsonObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new TypeError(`${label} must be an explicit JSON object.`);
  const seen = new Set();
  function visit(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') throw new TypeError(`${label} must contain only JSON values.`);
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError(`${label} must contain only plain JSON objects.`);
    }
    if (seen.has(item)) throw new TypeError(`${label} cannot contain circular references.`);
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError(`${label} cannot contain symbol keys.`);
    seen.add(item);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(item, i)) throw new TypeError(`${label} cannot contain sparse arrays.`);
        visit(item[i]);
      }
    } else {
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!('value' in descriptor)) throw new TypeError(`${label} cannot contain accessor properties.`);
        visit(descriptor.value);
      }
    }
    seen.delete(item);
  }
  visit(value);
  return JSON.parse(JSON.stringify(value));
}

function rpcOptions(options, timeoutMs = 60000) {
  return { service: 'DashboardService', timeoutMs: options.timeoutMs ?? timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}) };
}

async function scopeFields(client, options, { includeAgent = false } = {}) {
  const fields = {};
  let agentId = options.agentId;
  if (agentId !== undefined) nonempty(agentId, 'agentId');
  if (options.agent !== undefined) {
    const bot = await client.resolveBot(options.agent);
    const resolved = nonempty(bot?.agentId, 'agentId');
    if (agentId !== undefined && agentId !== resolved) throw new Error('agent and agentId refer to different bots.');
    agentId = resolved;
  }
  if (options.mcpConfigJson !== undefined) {
    if (typeof options.mcpConfigJson !== 'string') throw new TypeError('mcpConfigJson must be a JSON string.');
    let config;
    try { config = JSON.parse(options.mcpConfigJson); } catch { throw new TypeError('mcpConfigJson must be valid JSON.'); }
    jsonObject(config, 'mcpConfigJson');
    fields.mcpConfigJson = options.mcpConfigJson;
  }
  if (options.grokBotPluginScope !== undefined) {
    const scope = jsonObject(options.grokBotPluginScope, 'grokBotPluginScope');
    if (Object.keys(scope).some(key => !['agentId', 'sessionKind'].includes(key))) throw new TypeError('Unknown grokBotPluginScope field.');
    nonempty(scope.agentId, 'grokBotPluginScope.agentId');
    nonempty(scope.sessionKind, 'grokBotPluginScope.sessionKind');
    if (agentId !== undefined && agentId !== scope.agentId) throw new Error('Plugin scope and agentId refer to different bots.');
    agentId = scope.agentId;
    fields.grokBotPluginScope = scope;
  }
  if (includeAgent) fields.agentId = agentId ?? '';
  return fields;
}

function normalizeTool(tool) {
  const result = { ...tool };
  for (const [jsonKey, target] of [['inputSchemaJson', 'inputSchema'], ['outputSchemaJson', 'outputSchema'],
    ['annotationsJson', 'annotations'], ['metaJson', '_meta']]) {
    if (result[target] === undefined && typeof tool[jsonKey] === 'string' && tool[jsonKey]) {
      try { result[target] = JSON.parse(tool[jsonKey]); } catch { /* Preserve unparseable source unchanged. */ }
    }
  }
  return result;
}

/** Discover tools while preserving exact server/account identifiers and server status. */
export async function listTools(client, options = {}) {
  if (options.server !== undefined && options.serverIdentifiers !== undefined) throw new TypeError('Specify server or serverIdentifiers, not both.');
  const servers = options.serverIdentifiers ?? (options.server === undefined ? [] : [options.server]);
  if (!Array.isArray(servers)) throw new TypeError('serverIdentifiers must be an array.');
  for (const server of servers) nonempty(server, 'serverIdentifier');
  const body = { serverIdentifiers: [...new Set(servers)], ...await scopeFields(client, options) };
  const response = await client.rpc('ListSandMcpTools', body, rpcOptions(options, 30000));
  return { ...response, servers: (response.servers ?? []).map(server => ({ ...server,
    tools: (server.tools ?? []).map(normalizeTool) })) };
}

/**
 * Execute exactly one explicitly selected server/tool call. No discovery, fallback, or retry.
 * Pass the catalog entry's `name` (e.g. cursor-github-get_me), not its unqualified `toolName`.
 * ExecuteSandMcpToolRequest.args is google.protobuf.Struct, not agent.v1.McpArgs.
 */
export async function callTool(client, server, tool, args, options = {}) {
  for (const key of ['skipApproval', 'smartModeApproval', 'smartModeApprovalOnly', 'argumentsRepaired']) {
    if (Object.hasOwn(options, key)) throw new TypeError(`${key} is not supported by this execution API.`);
  }
  const serverIdentifier = nonempty(server, 'server');
  const toolName = nonempty(tool, 'tool');
  const safeArgs = jsonObject(args, 'args');
  const toolCallId = nonempty(options.toolCallId ?? randomUUID(), 'toolCallId');
  const body = { serverIdentifier, toolName, args: safeArgs, toolCallId,
    ...await scopeFields(client, options, { includeAgent: true }) };
  for (const key of ['turnId', 'modelName']) {
    if (options[key] !== undefined) {
      if (typeof options[key] !== 'string') throw new TypeError(`${key} must be a string.`);
      body[key] = options[key];
    }
  }
  if (options.eventSequence !== undefined) {
    const value = options.eventSequence;
    if (!(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
      throw new TypeError('eventSequence must be a nonnegative int64 value.');
    }
    if (BigInt(value) > 9223372036854775807n) throw new TypeError('eventSequence exceeds int64.');
    body.eventSequence = String(value);
  }
  if (options.mcpAnalyticsReportedByCaller !== undefined) {
    if (typeof options.mcpAnalyticsReportedByCaller !== 'boolean') throw new TypeError('mcpAnalyticsReportedByCaller must be a boolean.');
    body.mcpAnalyticsReportedByCaller = options.mcpAnalyticsReportedByCaller;
  }
  return client.rpc('ExecuteSandMcpTool', body, rpcOptions(options));
}

export async function readToolResource(client, server, uri, options = {}) {
  return client.rpc('ReadSandMcpResource', {
    serverIdentifier: nonempty(server, 'server'), uri: nonempty(uri, 'uri'),
    ...await scopeFields(client, options, { includeAgent: true }),
  }, rpcOptions(options));
}
