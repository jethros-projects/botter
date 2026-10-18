// Separate, opt-in transport for a running Grok Bot computer gateway.
// The caller supplies an existing connection descriptor. This module never
// starts a computer, discovers credentials, or falls back to account login.
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../schema/gateway-methods.json', import.meta.url), 'utf8'));
if (!Array.isArray(manifest.methods) || !manifest.methods.length
  || manifest.methods.some(method => typeof method.name !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(method.name)
    || typeof method.declaration !== 'string')
  || new Set(manifest.methods.map(method => method.name)).size !== manifest.methods.length) {
  throw new Error('Invalid bundled gateway method manifest.');
}

/** Discovered declarations are metadata, not fully resolved JSON Schemas. */
export const gatewayMethodSchemas = Object.freeze(manifest.methods.map(method => Object.freeze({
  name: method.name,
  declaration: method.declaration,
  offset: method.offset,
  source: manifest.source,
  argumentValidation: 'plain-json-object',
  typedArgumentValidation: false,
})));
export const gatewayMethods = Object.freeze(gatewayMethodSchemas.map(method => method.name));
const METHODS = new Map(gatewayMethodSchemas.map(method => [method.name, method]));

export function getGatewayMethodSchema(method) {
  if (!METHODS.has(method)) throw new TypeError('Unsupported gateway method.');
  return METHODS.get(method);
}

const RESERVED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'host', 'content-length', 'content-type', 'connection', 'transfer-encoding']);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 1_000_000;

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '[::1]'
    || /^127(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(hostname)
      && hostname.split('.').every(part => Number(part) <= 255);
}

function base(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Gateway baseUrl is required.');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TypeError('Gateway baseUrl must be an origin without credentials, path, query, or fragment.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new TypeError('Gateway requires HTTPS, or HTTP on a loopback address.');
  }
  return url.origin;
}

function timeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new RangeError('timeoutMs must be an integer from 1 to 300000.');
  }
  return value;
}

function gatewayHeaders(headers, token) {
  if (typeof token !== 'string' || !token || /[\s\u0000-\u001f\u007f]/u.test(token)) {
    throw new TypeError('An existing gateway token is required; account login is never used by this transport.');
  }
  if (headers !== undefined && (headers === null || Array.isArray(headers) || typeof headers !== 'object')) {
    throw new TypeError('Gateway headers must be an object of string values.');
  }
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) throw new TypeError(`Gateway descriptor must not override ${name}.`);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) {
      throw new TypeError('Gateway descriptor contains an invalid header.');
    }
    result[name] = value;
  }
  return { ...result, 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

/** Validate without invoking getters/toJSON or silently dropping unknown values.
 * Unknown JSON keys are deliberately retained: the bundled declarations contain
 * unresolved symbols, so the gateway remains responsible for typed validation.
 */
export function validateGatewayArguments(args) {
  if (!args || Array.isArray(args) || typeof args !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
    throw new TypeError('Gateway arguments must be an object containing plain JSON values.');
  }
  const ancestors = new WeakSet();
  let nodes = 0;
  function visit(value, depth) {
    if (++nodes > MAX_JSON_NODES) throw new RangeError('Gateway arguments exceed the JSON node limit.');
    if (depth > MAX_JSON_DEPTH) throw new RangeError('Gateway arguments exceed the JSON nesting limit of 64.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object') throw new TypeError('Gateway arguments must contain only plain JSON values.');
    if (ancestors.has(value)) throw new TypeError('Gateway arguments must not contain circular references.');
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new TypeError('Gateway arguments must contain only plain JSON objects and arrays.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) throw new TypeError('Gateway arguments must not contain symbol keys.');
    if (array && (keys.length !== value.length + 1 || keys.some(key => key !== 'length'
      && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)))) {
      throw new TypeError('Gateway argument arrays must not contain holes or custom properties.');
    }
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Gateway arguments must not contain hidden properties or accessors.');
      }
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(args, 0);
  const body = JSON.stringify(args);
  if (Buffer.byteLength(body) > MAX_BYTES) throw new RangeError('Gateway request exceeds 8 MiB.');
  return body;
}

async function cancelQuietly(body) {
  try { await body?.cancel(); } catch { /* Cancellation must not disclose transport error details. */ }
}

function responseTooLarge() {
  const error = new RangeError('Gateway response exceeds 8 MiB.');
  error.code = 'gateway_response_too_large';
  return error;
}

async function boundedText(response) {
  const declaredSize = Number(response.headers?.get('content-length'));
  if (declaredSize > MAX_BYTES) {
    await cancelQuietly(response.body);
    throw responseTooLarge();
  }
  if (!response.body?.getReader) {
    const value = await response.text();
    if (Buffer.byteLength(value) > MAX_BYTES) throw responseTooLarge();
    return value;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        try { await reader.cancel(); } catch { /* Preserve the size-limit error. */ }
        throw responseTooLarge();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

/** Create an opt-in adapter for an existing authenticated gateway descriptor.
 * Descriptor shape: {baseUrl, token, headers?}. No request is made until rpcGateway.
 * A request is issued once, including when its outcome is uncertain.
 */
export function createGatewayClient({ baseUrl, token, headers, fetchImpl = globalThis.fetch,
  timeoutMs = 30_000 } = {}) {
  const origin = base(baseUrl);
  const requestHeaders = gatewayHeaders(headers, token);
  const defaultTimeout = timeout(timeoutMs);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
  return Object.freeze({
    baseUrl: origin,
    async rpcGateway(method, args = {}, options = {}) {
      if (!METHODS.has(method)) throw new TypeError('Unsupported gateway method.');
      const body = validateGatewayArguments(args);
      const wait = timeout(options.timeoutMs ?? defaultTimeout);
      if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(wait)]) : AbortSignal.timeout(wait);
      signal.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(`${origin}/api/${method}`, {
          method: 'POST', redirect: 'error', signal, headers: { ...requestHeaders }, body,
        });
      } catch {
        // Custom fetch implementations may include credentials or request bodies
        // in exceptions. Return a bounded, credential-free diagnostic instead.
        const error = new Error(signal.aborted
          ? `Gateway ${method} request was aborted; it was not retried.`
          : `Gateway ${method} request failed before receiving a response; it was not retried.`);
        error.name = signal.aborted ? signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError' : 'Error';
        error.code = signal.aborted ? 'gateway_request_aborted' : 'gateway_network_error';
        throw error;
      }
      if (!response.ok) {
        await cancelQuietly(response.body);
        // Do not echo backend text, credentials, descriptors, or prompt contents.
        const error = new Error(`Gateway ${method} failed (HTTP ${response.status}); it was not retried.`);
        error.status = response.status;
        error.code = 'gateway_request_failed';
        throw error;
      }
      let result;
      try { result = await boundedText(response); }
      catch (cause) {
        if (cause?.code === 'gateway_response_too_large') throw cause;
        const error = new Error(`Gateway ${method} response could not be read; the request was not retried.`);
        error.code = 'gateway_response_read_failed';
        throw error;
      }
      if (!result.trim()) return null;
      try { return JSON.parse(result); }
      catch {
        const error = new Error(`Gateway ${method} returned invalid JSON.`);
        error.code = 'invalid_gateway_response';
        throw error;
      }
    },
  });
}

export const gatewayCapabilities = Object.freeze({
  implemented: gatewayMethods,
  methodCount: gatewayMethods.length,
  argumentValidation: 'plain-json-object',
  typedArgumentValidation: false,
  requiresExistingConnection: true,
  autoStartsComputer: false,
  liveVerified: false,
  liveVerifiedMethods: Object.freeze(['getConversationOutline', 'getAgentAutomations', 'deleteAgentAutomation', 'listAgents']),
  note: 'All bundled gateway declarations are routable; this does not establish server availability, permission, or successful execution. Only liveVerifiedMethods passed historical live checks. Argument expressions contain unresolved symbols, so typed validation is performed by the gateway. An empty outline for a server-owned bot does not establish access to its server transcript.',
});
