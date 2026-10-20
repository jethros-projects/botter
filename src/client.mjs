import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync, randomUUID, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { connect as connectHttp2, constants as http2Constants } from 'node:http2';
import { defaultAuthManager } from './auth.mjs';

const ORIGIN = 'https://api2.cursor.sh';
const SERVICES = new Set(['GrokBotService', 'DashboardService', 'AgentStoreService',
  'AiService', 'BackgroundComposerService', 'SandBoxService', 'AnalyticsService']);
const MAX_FRAME = 16 * 1024 * 1024;

export class ApiError extends Error {
  constructor(message, { status, code, requestId, details } = {}) {
    super(message); this.name = 'ApiError';
    Object.assign(this, { status, code, requestId, details });
  }
}

export function localCredentials() {
  if (process.platform !== 'darwin') throw new Error('The local login adapter requires macOS. Supply an explicit tokenProvider on other systems.');
  let data, accounts;
  try {
    data = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library/Application Support/Grok Bot/sand-secrets.json'), 'utf8'));
    accounts = JSON.parse(data['cursor-accounts']);
  } catch { throw new Error('Cannot read Grok Bot login. Sign in through the app first.'); }
  const encrypted = accounts.accounts?.[accounts.active]?.['cursor-access-token'];
  if (!encrypted) throw new Error('No active Grok Bot login found.');
  let password;
  try {
    password = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Grok Bot Safe Storage', '-w'], {
      encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch { throw new Error('Keychain access failed or timed out. Allow the normal macOS Keychain prompt, then retry.'); }
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const bytes = Buffer.from(encrypted, 'base64');
  try {
    if (bytes.subarray(0, 3).toString() !== 'v10') throw new Error();
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
    return Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]).toString('utf8');
  } catch { throw new Error('Unsupported Grok Bot login encryption format.'); }
  finally { key.fill(0); bytes.fill(0); }
}

export function installedVersion() {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString',
      '/Applications/Grok Bot.app/Contents/Info.plist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return '0.71.2'; }
}

function frameLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FRAME) throw new Error(`Frame limit must be an integer from 1 to ${MAX_FRAME}.`);
  return value;
}

function redact(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[REDACTED]');
    return value.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(?:authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|password|cookie|set-cookie|api[_-]?key|client[_-]?secret)$/i.test(key)
      ? '[REDACTED]' : redact(item, secrets)]));
  return value;
}

function safeError(error, secrets) {
  if (!(error instanceof Error)) return new Error('Grok Bot transport failed.');
  const message = redact(error.message, secrets);
  if (error instanceof ApiError) return new ApiError(message, redact({ status: error.status, code: error.code,
    requestId: error.requestId, details: error.details }, secrets));
  const result = new Error(message); result.name = error.name;
  if (typeof error.code === 'string') result.code = error.code;
  return result;
}

function aborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

async function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    aborted(signal);
  }
  let listener;
  const cancellation = new Promise((_, reject) => {
    listener = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, cancellation]); }
  finally { signal.removeEventListener('abort', listener); }
}

async function* interruptible(source, signal) {
  const iterator = source?.[Symbol.asyncIterator]?.() ?? source?.[Symbol.iterator]?.();
  if (!iterator) throw new Error('Connect streaming input must be an iterable of JSON messages.');
  let done = false;
  try {
    while (true) {
      aborted(signal);
      const result = await abortable(Promise.resolve().then(() => iterator.next()), signal);
      if (result.done) { done = true; return; }
      yield result.value;
    }
  } finally {
    // A user-provided producer may be suspended forever in next(). Never wait on
    // return() during cancellation; still notify it and consume any rejection.
    if (!done && iterator.return) Promise.resolve().then(() => iterator.return()).catch(() => {});
  }
}

export function encodeConnectFrame(value, { maxFrameBytes = MAX_FRAME } = {}) {
  frameLimit(maxFrameBytes);
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Connect request must be a JSON value.');
  const payload = Buffer.from(json);
  if (payload.length > maxFrameBytes) throw new Error('Connect request exceeds the frame limit.');
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5); return frame;
}

export async function* decodeConnectFrames(chunks, { encoding, maxFrameBytes = MAX_FRAME,
  requireEndStream = false, signal, requestId, secrets = [] } = {}) {
  frameLimit(maxFrameBytes);
  const header = Buffer.alloc(5);
  let headerBytes = 0, body, bodyBytes = 0, ended = false;
  for await (const bytes of interruptible(chunks, signal)) {
    const chunk = Buffer.from(bytes);
    let offset = 0;
    while (offset < chunk.length) {
      if (ended) throw new Error('Data received after the Connect end-stream frame.');
      if (headerBytes < 5) {
        const count = Math.min(5 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + count); headerBytes += count; offset += count;
        if (headerBytes < 5) continue;
        if (header[0] & ~3) throw new Error('Unsupported Connect frame flags.');
        const length = header.readUInt32BE(1);
        if (length > maxFrameBytes) throw new Error('Connect response frame exceeds the size limit.');
        body = Buffer.alloc(length); bodyBytes = 0;
      }
      const count = Math.min(body.length - bodyBytes, chunk.length - offset);
      chunk.copy(body, bodyBytes, offset, offset + count); bodyBytes += count; offset += count;
      if (bodyBytes < body.length) continue;
      const flags = header[0];
      let payload = body;
      headerBytes = 0; body = undefined;
      if (flags & 1) {
        if (encoding !== 'gzip') throw new Error('Unsupported Connect response compression.');
        try { payload = gunzipSync(payload, { maxOutputLength: maxFrameBytes }); }
        catch { throw new Error('Invalid or oversized compressed Connect response frame.'); }
      }
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); }
      catch { throw new Error('Invalid JSON in Connect stream.'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON message in Connect stream.');
      if (flags & 2) {
        ended = true;
        if (Object.hasOwn(value, 'error')) {
          if (!value.error || typeof value.error !== 'object' || typeof value.error.code !== 'string' || !value.error.code)
            throw new Error('Invalid error in Connect end-stream frame.');
          const error = redact(value.error, secrets);
          throw new ApiError(error.message || 'Stream failed.', { ...error, requestId });
        }
        if (value.metadata !== undefined && (!value.metadata || typeof value.metadata !== 'object' || Array.isArray(value.metadata)
          || Object.values(value.metadata).some(values => !Array.isArray(values) || values.some(item => typeof item !== 'string'))))
          throw new Error('Invalid metadata in Connect end-stream frame.');
      } else yield value;
    }
  }
  if (headerBytes || body) throw new Error('Truncated Connect response frame.');
  if (requireEndStream && !ended) throw new Error('Connect response ended without an end-stream frame.');
}

async function readJson(response, { signal, maxBytes = MAX_FRAME } = {}) {
  if (!response.body) return response.json();
  const chunks = []; let length = 0;
  for await (const chunk of interruptible(response.body, signal)) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('API response exceeds the size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function* requestFrames(messages, options) {
  for await (const message of interruptible(messages, options.signal)) yield encodeConnectFrame(message, options);
}

function operationSignal(signal, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('Timeout must be a positive integer no greater than 2147483647 ms.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Grok Bot request timed out.', 'TimeoutError')), timeoutMs);
  return { controller, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    clear: () => clearTimeout(timer) };
}

function waitForDrain(request, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      request.off('drain', onDrain); request.off('error', onError); request.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    const onClose = () => onError(new Error('HTTP/2 request closed before the upload completed.'));
    const onAbort = () => onError(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    request.once('drain', onDrain); request.once('error', onError); request.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function http2Exchange(url, headers, messages, { connectImpl, signal, controller, maxFrameBytes }) {
  const target = new URL(url);
  const session = connectImpl(target.origin);
  let request, uploadFailure;
  let rejectHeaders;
  const response = new Promise((resolve, reject) => {
    rejectHeaders = reject;
    session.on('error', reject);
    try {
      request = session.request({ ':method': 'POST', ':path': target.pathname, ...headers }, { endStream: false });
      request.once('response', responseHeaders => {
        const status = Number(responseHeaders[':status']);
        resolve({ status, ok: status >= 200 && status < 300, body: request,
          headers: new Headers(Object.entries(responseHeaders).filter(([key]) => !key.startsWith(':'))
            .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])) });
      });
      request.on('error', reject);
      request.once('close', () => reject(new Error('HTTP/2 stream closed before response headers.')));
    } catch (error) { reject(error); }
  });
  // Consume rejection even if a synchronous failure interrupts setup below.
  response.catch(() => {});
  const cancel = () => {
    rejectHeaders(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    request?.close(http2Constants.NGHTTP2_CANCEL);
    session.destroy();
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const upload = (async () => {
    for await (const frame of requestFrames(messages, { signal, maxFrameBytes })) {
      aborted(signal);
      if (!request.write(frame)) await waitForDrain(request, signal);
    }
    aborted(signal); request.end();
  })().catch(error => {
    uploadFailure = error;
    rejectHeaders(error);
    controller.abort(error);
    throw error;
  });
  upload.catch(() => {});
  return { response, upload, get uploadFailure() { return uploadFailure; }, close() {
    signal.removeEventListener('abort', cancel);
    request?.close(http2Constants.NGHTTP2_CANCEL);
    session.destroy();
  } };
}

function endpoint(service, method) {
  if (!SERVICES.has(service) || !/^[A-Z][A-Za-z0-9]+$/.test(method)) throw new Error('Invalid API service or method.');
  return `${ORIGIN}/aiserver.v1.${service}/${method}`;
}

export class GrokBotClient {
  constructor({ tokenProvider, authManager, fetchImpl = globalThis.fetch, http2Connect = connectHttp2, version } = {}) {
    // Explicit authentication always wins over the optional desktop adapter.
    this.tokenProvider = tokenProvider ?? (authManager == null
      && (process.env.BOTTER_USE_APP_LOGIN ?? process.env.GROK_BRIDGE_USE_APP_LOGIN) === '1' ? localCredentials : undefined);
    this.authManager = authManager ?? (this.tokenProvider ? null : defaultAuthManager());
    this.fetch = fetchImpl;
    this.http2Connect = http2Connect;
    // Independent login must not need an installed app, even for version metadata.
    this.version = version ?? '0.71.2';
    this.baseUrl = ORIGIN;
  }
  async authSession(options = {}) {
    aborted(options.signal);
    const value = this.tokenProvider ? { accessToken: await this.tokenProvider(options) } : await this.authManager.getSession(options);
    aborted(options.signal);
    if (typeof value.accessToken !== 'string' || !value.accessToken.trim()) throw new Error('No access token available.');
    return value;
  }
  async token(options) { return (await this.authSession(options)).accessToken; }
  async accountFingerprint(options) {
    const token = await this.token(options); let subject;
    try { subject = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub; } catch {}
    return createHash('sha256').update(subject || token).digest('hex');
  }
  async headers(contentType, options) {
    const session = await this.authSession(options);
    return {
      'content-type': contentType, 'connect-protocol-version': '1',
      authorization: `Bearer ${session.accessToken}`, 'x-ghost-mode': 'true',
      'x-cursor-client-type': 'sand', 'x-cursor-client-version': this.version,
      'x-cursor-client-os': process.platform, 'x-cursor-client-source': 'sand-desktop',
      'x-sand-box-namespace': 'prod', 'x-request-id': randomUUID(),
      ...(session.selectedTeamId === undefined ? {} : { 'x-cursor-team-id': String(session.selectedTeamId) }),
    };
  }
  async rpc(method, body = {}, { service = 'GrokBotService', signal, timeoutMs = 30000 } = {}) {
    const url = endpoint(service, method);
    const operation = operationSignal(signal, timeoutMs);
    let secrets = [];
    try {
      aborted(operation.signal);
      const headers = await abortable(this.headers('application/json', { signal: operation.signal }), operation.signal);
      secrets = [headers.authorization.slice(7)];
      const response = await abortable(this.fetch(url, {
        method: 'POST', redirect: 'error', signal: operation.signal,
        headers, body: JSON.stringify(body),
      }), operation.signal);
      let result;
      try { result = await readJson(response, { signal: operation.signal }); }
      catch (error) {
        aborted(operation.signal);
        throw new ApiError(`Non-JSON or oversized API response (HTTP ${response.status}).`, { status: response.status });
      }
      if (!response.ok) this.throwResponse(response, result, secrets);
      return result;
    } catch (error) { throw safeError(error, secrets); }
    finally { operation.clear(); }
  }
  throwResponse(response, result, secrets = []) {
    result = redact(result && typeof result === 'object' ? result : {}, secrets);
    const inferredCode = ({ 400: 'internal', 401: 'unauthenticated', 403: 'permission_denied',
      404: 'unimplemented', 429: 'unavailable', 502: 'unavailable', 503: 'unavailable', 504: 'unavailable' })[response.status] ?? 'unknown';
    const message = response.status === 401
      ? 'Grok Bot login expired or was revoked. Run botter login again.'
      : (typeof result.message === 'string' && result.message) || `API request failed (HTTP ${response.status}).`;
    throw new ApiError(message, { status: response.status, code: typeof result.code === 'string' ? result.code : inferredCode,
      requestId: response.headers.get('x-request-id'), details: result.details });
  }
  async *stream(method, body, { service = 'GrokBotService', signal, timeoutMs = 30000, maxFrameBytes = MAX_FRAME } = {}) {
    const url = endpoint(service, method);
    const frame = encodeConnectFrame(body, { maxFrameBytes });
    const operation = operationSignal(signal, timeoutMs);
    let secrets = [];
    try {
      aborted(operation.signal);
      const headers = await abortable(this.headers('application/connect+json', { signal: operation.signal }), operation.signal);
      headers['connect-accept-encoding'] = 'gzip';
      secrets = [headers.authorization.slice(7)];
      const response = await abortable(this.fetch(url, {
        method: 'POST', redirect: 'error', signal: operation.signal, headers, body: frame,
      }), operation.signal);
      if (!response.ok) {
        let result; try { result = await readJson(response, { signal: operation.signal }); } catch { result = {}; }
        aborted(operation.signal);
        this.throwResponse(response, result, secrets);
      }
      if (!response.body) throw new Error('Connect stream has no response body.');
      // Existing server-stream calls use timeoutMs only while opening. Long-lived
      // subscriptions remain open until their caller cancels them.
      operation.clear();
      yield* decodeConnectFrames(response.body, { encoding: response.headers.get('connect-content-encoding'),
        maxFrameBytes, requireEndStream: true, signal: operation.signal, secrets, requestId: response.headers.get('x-request-id') });
    } catch (error) { throw safeError(error, secrets); }
    finally { operation.clear(); operation.controller.abort(); }
  }
  /**
   * Send and receive framed JSON messages concurrently. Native HTTP/2 is the
   * default because Connect bidirectional RPCs (for example AiService.StreamStt)
   * require it. transport:'fetch' is available for custom HTTP/2-capable fetch
   * implementations; Node's default fetch does not guarantee HTTP/2, even though
   * it accepts streaming bodies with the required duplex:'half' option.
   * timeoutMs is a deadline for the entire request, unlike stream's open timeout.
   * No transport retries or protocol fallbacks are attempted.
   */
  async *duplex(method, messages, { service = 'GrokBotService', signal, timeoutMs = 30000,
    maxFrameBytes = MAX_FRAME, transport = 'http2' } = {}) {
    const url = endpoint(service, method);
    frameLimit(maxFrameBytes);
    if (!messages || (!messages[Symbol.asyncIterator] && !messages[Symbol.iterator]))
      throw new Error('Connect streaming input must be an iterable of JSON messages.');
    if (!['http2', 'fetch'].includes(transport)) throw new Error('Streaming transport must be http2 or fetch.');
    const operation = operationSignal(signal, timeoutMs);
    let exchange, secrets = [];
    try {
      aborted(operation.signal);
      const headers = await abortable(this.headers('application/connect+json', { signal: operation.signal }), operation.signal);
      headers['connect-accept-encoding'] = 'gzip';
      headers['connect-timeout-ms'] = String(timeoutMs);
      secrets = [headers.authorization.slice(7)];
      let response;
      if (transport === 'http2') {
        exchange = http2Exchange(url, headers, messages, { connectImpl: this.http2Connect, signal: operation.signal,
          controller: operation.controller, maxFrameBytes });
        response = await abortable(exchange.response, operation.signal);
      } else {
        response = await abortable(this.fetch(url, { method: 'POST', redirect: 'error', signal: operation.signal,
          headers, duplex: 'half', body: requestFrames(messages, { signal: operation.signal, maxFrameBytes }) }), operation.signal);
      }
      if (!response.ok) {
        let result; try { result = await readJson(response, { signal: operation.signal }); } catch { result = {}; }
        aborted(operation.signal);
        this.throwResponse(response, result, secrets);
      }
      if (!response.body) throw new Error('Connect stream has no response body.');
      yield* decodeConnectFrames(response.body, { encoding: response.headers.get('connect-content-encoding'),
        maxFrameBytes, requireEndStream: true, signal: operation.signal, secrets, requestId: response.headers.get('x-request-id') });
      if (exchange?.uploadFailure) throw exchange.uploadFailure;
    } catch (error) { throw safeError(error, secrets); }
    finally { operation.clear(); operation.controller.abort(); exchange?.close(); }
  }
  async listBots(options) { return (await this.rpc('ListGrokBotAgents', {}, options)).agents ?? []; }
  async resolveBot(query, options) {
    if (query && typeof query === 'object' && typeof query.agentId === 'string' && query.agentId) return query;
    if (typeof query !== 'string' || !query.trim()) throw new Error('Specify a bot name or ID.');
    const bots = await this.listBots(options);
    const matches = bots.filter(bot => [bot.id, bot.agentId, bot.legacyAgentId].includes(query)
      || bot.name?.toLowerCase() === query.toLowerCase());
    if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous bot name; use its agent UUID.' : `Bot not found: ${query}`);
    if (!matches[0].agentId) throw new Error('Bot has no agent UUID.');
    return matches[0];
  }
}

export const createClient = options => new GrokBotClient(options);
export const sessionFor = (bot, override) => override ?? bot.viewerSessionId ?? '';
