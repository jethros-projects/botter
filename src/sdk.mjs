import { GrokBotClient } from './client.mjs';
import { TranscriptSubscription } from './subscription.mjs';
import { randomUUID } from 'node:crypto';
import { history, searchHistory, sendMessage, waitForReply, watchBots } from './conversations.mjs';
import { uploadAttachment, downloadAttachment, listArtifactReferences } from './attachments.mjs';
import { resolveApiMethod, validateApiRequest } from './schema.mjs';
import { assertApiMethodSupported, assertApiRequestSupported, assertCommandSupported, getVerifiedSupport } from './support.mjs';
import { BotterError, invalid, sdkError } from './sdk-errors.mjs';

const MAX_BYTES = 5 * 1024 * 1024;
const transports = new WeakMap();
const object = (input, fields, label = 'input') => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid(`${label} must be an object.`);
  for (const key of Object.keys(input)) if (!fields.includes(key)) throw invalid(`${label}.${key} is not supported.`);
  return input;
};
const string = (value, name, empty = false) => {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0')) throw invalid(`${name} must be ${empty ? 'a' : 'a nonempty'} string.`);
};
const integer = (value, name, min, max) => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max)) throw invalid(`${name} must be an integer from ${min} to ${max}.`);
};
const fileLimit = value => { if (value !== undefined && value > MAX_BYTES) throw invalid('Verified file transfers are limited to 5 MiB.'); integer(value, 'maxBytes', 1, MAX_BYTES); };
const sequence = (value, name) => {
  if (value !== undefined && (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) > 18446744073709551615n)) throw invalid(`${name} must be a uint64 decimal string.`);
};
function target(input) { string(input.botId, 'botId'); if (input.sessionId !== undefined) string(input.sessionId, 'sessionId', true); }
function remotePath(value) { string(value, 'remotePath'); if (!value.startsWith('/') || /[\\\r\n]/.test(value) || value.split('/').includes('..')) throw invalid('Use an absolute remote attachment path without parent traversal.'); }
function request(options) {
  object(options, ['signal', 'timeoutMs'], 'options');
  integer(options.timeoutMs, 'timeoutMs', 1, 2147483647);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw invalid('signal must be an AbortSignal.');
}
function checkMethod(method, body, options, commandAdapter = false) {
  const descriptor = resolveApiMethod(`${options?.service ?? 'GrokBotService'}.${method}`);
  // These exact connection shapes were verified through the named commands;
  // the unrestricted backend method remains unavailable to raw API discovery.
  if (commandAdapter && descriptor.serviceName === 'GrokBotService' && method === 'EnsureSandBox') {
    const input = validateApiRequest(descriptor, body);
    if (Object.keys(input).length === 0) { assertCommandSupported('gateway-connect'); return input; }
    if (Object.keys(input).length === 1 && input.wake === false) { assertCommandSupported('gateway-status'); return input; }
  }
  assertApiMethodSupported(descriptor);
  return assertApiRequestSupported(descriptor, validateApiRequest(descriptor, body));
}
function race(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}
const project = value => {
  const { agentId, ...rest } = value;
  return { ...rest, ...(agentId === undefined ? {} : { botId: agentId }) };
};
const message = row => ({ ...row,
  id: row.entryId,
  role: typeof row.entry?.role === 'string' ? row.entry.role : typeof row.entry?.message?.role === 'string' ? row.entry.message.role : null,
  replyToMessageId: typeof row.entry?.replyTo === 'string' ? row.entry.replyTo : typeof row.entry?.replyToId === 'string' ? row.entry.replyToId : null,
  createdAt: Number.isFinite(Number(row.timestampMs)) && row.timestampMs !== null && Math.abs(Number(row.timestampMs)) <= 8640000000000000 ? new Date(Number(row.timestampMs)).toISOString() : null,
  streaming: row.entry?.streaming === true || row.entry?.isStreaming === true || row.entry?.message?.streaming === true || row.entry?.message?.isStreaming === true });
const page = value => ({ ...project(value), messages: value.entries.map(message) });
const accepted = value => [1, 2, 3].includes(value) || typeof value === 'string' && ['ACCEPTED_BOX', 'ACCEPTED_TEMPORAL', 'DUPLICATE'].some(name => value === name || value.endsWith(`_${name}`));


export class BotterClient {
  #transport; #owned; #closed = false; #closing; #pending = new Set(); #subscriptions = new Set(); #maxBuffer; #auth;
  constructor(options = {}) {
    object(options, ['tokenProvider', 'authManager', 'fetchImpl', 'http2Connect', 'version', 'transport', 'ownsTransport', 'maxBufferEvents'], 'options');
    integer(options.maxBufferEvents, 'maxBufferEvents', 1, 10000);
    if (options.ownsTransport !== undefined && typeof options.ownsTransport !== 'boolean') throw invalid('ownsTransport must be a boolean.');
    if (options.transport !== undefined && (!options.transport || typeof options.transport !== 'object')) throw invalid('transport must be an object implementing RawClient.');
    this.#transport = options.transport ?? new GrokBotClient(options);
    this.#owned = options.ownsTransport ?? options.transport === undefined;
    this.#maxBuffer = options.maxBufferEvents ?? 256;
    this.#auth = Object.freeze({
      status: (requestOptions = {}) => this.#run(requestOptions, async (client, signal) => {
        if (typeof this.#transport.authManager?.status === 'function') return race(this.#transport.authManager.status({ signal }), signal);
        if (typeof this.#transport.authSession === 'function' && this.#transport.tokenProvider) {
          await race(this.#transport.authSession({ signal }), signal);
          return { authenticated: true, source: 'tokenProvider' };
        }
        return { authenticated: false, source: 'host' };
      }),
      refresh: (requestOptions = {}) => this.#run(requestOptions, async (client, signal) => {
        const manager = this.#transport.authManager;
        if (typeof manager?.getSession !== 'function' || typeof manager?.status !== 'function') throw new BotterError(undefined, { code: 'UNSUPPORTED_OPERATION' });
        await race(manager.getSession({ forceRefresh: true, signal }), signal);
        return race(manager.status({ signal }), signal);
      }),
      logout: (requestOptions = {}) => this.#run(requestOptions, async (client, signal) => {
        if (typeof this.#transport.authManager?.logout !== 'function') throw new BotterError(undefined, { code: 'UNSUPPORTED_OPERATION' });
        await race(this.#transport.authManager.logout({ signal }), signal);
      }),
    });
    // Explicitly internal adapter for the CLI's provider-specific commands.
    transports.set(this, this.#context());
  }
  get auth() { return this.#auth; }
  capabilities() {
    const support = getVerifiedSupport();
    return Object.freeze({ send: true, history: true, search: true, watch: true, upload: true, download: true, artifacts: true,
      attachments: Object.freeze({ maxBytes: MAX_BYTES, uploadModes: Object.freeze(['SINGLE_PUT']), downloadOutcomes: Object.freeze(['STORE']) }),
      verifiedAt: support.verifiedAt, backend: Object.freeze(support.backend.map(entry => entry.id)) });
  }
  #assertOpen() { if (this.#closed) throw new BotterError(undefined, { code: 'CLOSED' }); }
  #operation(options = {}) {
    this.#assertOpen(); request(options);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new BotterError(undefined, { code: 'TIMEOUT' })), options.timeoutMs);
    this.#pending.add(controller);
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); this.#pending.delete(controller); };
    return { controller, signal: controller.signal, cleanup };
  }
  async #run(options, task) {
    const op = this.#operation(options);
    try { op.signal.throwIfAborted(); return await race(Promise.resolve().then(() => { op.signal.throwIfAborted(); return task(this.#context(op.signal), op.signal); }), op.signal); }
    catch (error) { throw sdkError(error, op.signal); }
    finally { op.cleanup(); }
  }
  #context(signal) {
    const raw = this.#transport;
    const owner = this;
    const context = {
      get authManager() { return raw.authManager; }, get version() { return raw.version; }, get fetch() { return raw.fetch; },
      resolveBot: async query => {
        this.#assertOpen(); signal?.throwIfAborted();
        return signal ? race(raw.resolveBot(query, { signal }), signal) : this.#run({}, (_client, operationSignal) => raw.resolveBot(query, { signal: operationSignal }));
      },
      listBots: async options => signal ? race(raw.listBots({ ...options, signal }), signal) : this.#run(options ?? {}, (_client, operationSignal) => raw.listBots({ ...options, signal: operationSignal })),
      accountFingerprint: async () => signal ? race(raw.accountFingerprint({ signal }), signal) : this.#run({}, (_client, operationSignal) => raw.accountFingerprint({ signal: operationSignal })),
      rpc: async (method, body = {}, options = {}) => {
        this.#assertOpen();
        const input = checkMethod(method, body, options, true);
        if (!signal) return this.#run({ signal: options.signal, timeoutMs: options.timeoutMs }, client => client.rpc(method, input, options));
        signal.throwIfAborted();
        try { return await race(raw.rpc(method, input, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal }), signal); }
        catch (error) { throw sdkError(error, signal); }
      },
      stream: async function* (method, body, options = {}) {
        const op = signal ? undefined : owner.#operation({ signal: options.signal, timeoutMs: options.timeoutMs });
        const combined = signal ?? op.signal;
        let iterator;
        try {
          owner.#assertOpen(); combined.throwIfAborted();
          const input = checkMethod(method, body, options);
          const source = raw.stream(method, input, { ...options, signal: options.signal ? AbortSignal.any([combined, options.signal]) : combined });
          iterator = source[Symbol.asyncIterator]();
          while (true) { const item = await race(iterator.next(), combined); if (item.done) return; yield item.value; }
        } catch (error) { throw sdkError(error, combined); }
        finally { op?.cleanup(); if (iterator) Promise.resolve().then(() => iterator.return?.()).catch(() => {}); }
      },
      duplex: async function* (method, messages, options = {}) {
        const descriptor = resolveApiMethod(`${options.service ?? 'GrokBotService'}.${method}`);
        assertApiMethodSupported(descriptor);
        const op = owner.#operation({ signal: options.signal, timeoutMs: options.timeoutMs });
        let iterator;
        try {
          op.signal.throwIfAborted();
          const validated = async function* () { for await (const body of messages) { op.signal.throwIfAborted(); yield checkMethod(method, body, options); } };
          iterator = raw.duplex(method, validated(), { ...options, signal: op.signal })[Symbol.asyncIterator]();
          while (true) { const item = await race(iterator.next(), op.signal); if (item.done) return; yield item.value; }
        } catch (error) { throw sdkError(error, op.signal); }
        finally { op.cleanup(); if (iterator) Promise.resolve().then(() => iterator.return?.()).catch(() => {}); }
      },
    };
    return context;
  }
  async listBots(options = {}) { return this.#run(options, async (client, signal) => {
    checkMethod('ListGrokBotAgents', {}, {});
    const bots = typeof this.#transport.listBots === 'function' ? await client.listBots() : (await client.rpc('ListGrokBotAgents', {})).agents ?? [];
    return bots.map(project);
  }); }
  async history(input, options = {}) {
    this.#assertOpen(); object(input, ['botId', 'sessionId', 'limit', 'beforeSeq', 'generation', 'unreadBoundaryMs']); target(input);
    integer(input.limit, 'limit', 1, 200); integer(input.generation, 'generation', 0, 4294967295); sequence(input.beforeSeq, 'beforeSeq');
    if (input.unreadBoundaryMs !== undefined && (typeof input.unreadBoundaryMs !== 'string' || !/^-?\d+$/.test(input.unreadBoundaryMs) || BigInt(input.unreadBoundaryMs) < -9223372036854775808n || BigInt(input.unreadBoundaryMs) > 9223372036854775807n)) throw invalid('unreadBoundaryMs must be an int64 decimal string.');
    return this.#run(options, async (client, signal) => page(await history(client, input.botId, { ...input, signal })));
  }
  async search(input, options = {}) {
    this.#assertOpen(); object(input, ['botId', 'sessionId', 'query', 'limit', 'pageSize', 'maxPages', 'beforeSeq', 'since', 'until']); target(input); string(input.query, 'query');
    integer(input.limit, 'limit', 1, 10000); integer(input.pageSize, 'pageSize', 1, 200); integer(input.maxPages, 'maxPages', 1, 1000); sequence(input.beforeSeq, 'beforeSeq');
    for (const name of ['since', 'until']) if (input[name] !== undefined && !Number.isFinite(typeof input[name] === 'number' ? input[name] : Date.parse(input[name]))) throw invalid(`${name} must be a timestamp or ISO date.`);
    const time = value => typeof value === 'number' ? value : Date.parse(value);
    if (input.since !== undefined && input.until !== undefined && time(input.since) > time(input.until)) throw invalid('since must not be after until.');
    return this.#run(options, async (client, signal) => page(await searchHistory(client, input.botId, input.query, { ...input, signal })));
  }
  async send(input, options = {}) {
    this.#assertOpen(); object(input, ['botId', 'sessionId', 'text', 'messageId', 'attachments', 'wait', 'waitTimeoutMs']); target(input); string(input.text, 'text', true);
    if (input.wait !== undefined && typeof input.wait !== 'boolean') throw invalid('wait must be a boolean.');
    integer(input.waitTimeoutMs, 'waitTimeoutMs', 1, 3600000);
    if (input.waitTimeoutMs !== undefined && !input.wait) throw invalid('waitTimeoutMs requires wait: true.');
    if (input.messageId !== undefined && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.messageId)) throw invalid('messageId must be a UUID.');
    if (input.attachments !== undefined && !Array.isArray(input.attachments)) throw invalid('attachments must be an array.');
    const attachments = (input.attachments ?? []).map(item => {
      if (typeof item === 'string') { string(item, 'attachment path'); return { path: item }; }
      object(item, ['path', 'name', 'mimeType', 'remotePath'], 'attachment');
      if (item.remotePath !== undefined) { remotePath(item.remotePath); string(item.name, 'name'); if (item.path !== undefined || item.mimeType !== undefined) throw invalid('Remote attachments use remotePath and name.'); }
      else { string(item.path, 'path'); if (item.name !== undefined) string(item.name, 'name'); if (item.mimeType !== undefined && !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(item.mimeType)) throw invalid('mimeType must be a MIME type without parameters.'); }
      return item;
    });
    if (!input.text.trim() && !attachments.length) throw invalid('Message is empty.');
    const messageId = input.messageId ?? randomUUID();
    let submitted = false, targetBot, receipt;
    return this.#run(options, async (client, signal) => {
      const bot = await client.resolveBot(input.botId), refs = [];
      targetBot = bot;
      if (![2, 'temporal', 'TEMPORAL', 'GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL'].includes(bot.harness)) {
        throw new BotterError('Sending is verified for temporal bots. Choose a temporal bot from listBots().', { code: 'UNSUPPORTED_OPERATION' });
      }
      for (const attachment of attachments) {
        if (attachment.remotePath !== undefined) refs.push({ path: attachment.remotePath, name: attachment.name });
        else { const value = await uploadAttachment(client, bot, attachment.path, { sessionId: input.sessionId, mimeType: attachment.mimeType, maxBytes: MAX_BYTES, allowedModes: ['SINGLE_PUT'], fetchImpl: this.#transport.fetch, signal }); refs.push({ path: value.path, name: attachment.name ?? value.fileName }); }
      }
      submitted = true;
      let result = await sendMessage(client, bot, input.text, { messageId, sessionId: input.sessionId, attachments: refs, signal,
        onDelivery: delivered => { receipt = project(delivered); } });
      receipt = project(result);
      if (input.wait && accepted(result.delivery?.delivery) && result.status?.status !== 3 && !/(?:^|_)REJECTED$/.test(String(result.status?.status ?? ''))) {
        result = await waitForReply(client, result, { timeoutMs: input.waitTimeoutMs ?? 60000, signal });
      }
      return project(result);
    }).catch(error => {
      if (submitted) {
        error.receipt ??= receipt ?? { botId: targetBot.agentId, sessionId: input.sessionId ?? targetBot.viewerSessionId ?? '', messageId };
        error.deliveryState ??= receipt && accepted(receipt.delivery?.delivery) ? 'accepted' : 'unknown';
      }
      throw error;
    });
  }
  async upload(input, options = {}) {
    this.#assertOpen(); object(input, ['botId', 'sessionId', 'path', 'name', 'mimeType', 'maxBytes']); target(input); string(input.path, 'path');
    fileLimit(input.maxBytes); if (input.name !== undefined) string(input.name, 'name');
    if (input.mimeType !== undefined && !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(input.mimeType)) throw invalid('mimeType must be a MIME type without parameters.');
    return this.#run(options, async (client, signal) => {
      const result = await uploadAttachment(client, input.botId, input.path, { ...input, maxBytes: input.maxBytes ?? MAX_BYTES, allowedModes: ['SINGLE_PUT'], fetchImpl: this.#transport.fetch, signal });
      return project({ ...result, fileName: input.name ?? result.fileName });
    });
  }
  async download(input, options = {}) {
    this.#assertOpen(); object(input, ['botId', 'sessionId', 'path', 'output', 'destination', 'maxBytes', 'overwrite']); target(input); remotePath(input.path);
    const output = input.output ?? input.destination;
    string(output, 'output');
    if (input.output !== undefined && input.destination !== undefined && input.output !== input.destination) throw invalid('output and destination must agree.');
    fileLimit(input.maxBytes); if (input.overwrite !== undefined && typeof input.overwrite !== 'boolean') throw invalid('overwrite must be a boolean.');
    return this.#run(options, async (client, signal) => {
      const result = await downloadAttachment(client, input.botId, input.path, output, { ...input, maxBytes: input.maxBytes ?? MAX_BYTES, allowedReadOutcomes: ['STORE'], fetchImpl: this.#transport.fetch, signal });
      return { ...project(result), output: result.destination };
    });
  }
  async artifacts(input, options = {}) {
    this.#assertOpen(); object(input, ['botId', 'sessionId', 'maxPages', 'pageSize', 'beforeSeq']); target(input);
    integer(input.maxPages, 'maxPages', 1, 1000); integer(input.pageSize, 'pageSize', 1, 200); sequence(input.beforeSeq, 'beforeSeq');
    return this.#run(options, async (client, signal) => project(await listArtifactReferences(client, input.botId, { ...input, signal })));
  }
  async watch(input, options = {}) {
    this.#assertOpen(); object(input, ['botId', 'sessionId', 'maxBufferEvents']); target(input); integer(input.maxBufferEvents, 'maxBufferEvents', 1, 10000);
    const op = this.#operation(options);
    try {
      op.signal.throwIfAborted();
      const client = this.#context(op.signal), bot = await race(client.resolveBot(input.botId), op.signal);
      let subscription;
      const source = watchBots(client, [bot], { sessionId: input.sessionId, signal: op.signal });
      subscription = new TranscriptSubscription(source, { normalizeEvent: event => project(event.type === 'entry' ? { ...event, message: message(event) } : event), controller: op.controller, maxBufferEvents: input.maxBufferEvents ?? this.#maxBuffer, cleanup: op.cleanup, onFinish: () => this.#subscriptions.delete(subscription) });
      this.#subscriptions.add(subscription);
      return subscription;
    } catch (error) { op.cleanup(); throw sdkError(error, op.signal); }
  }
  async close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      const error = new BotterError(undefined, { code: 'CLOSED' });
      for (const controller of this.#pending) controller.abort(error);
      await Promise.all([...this.#subscriptions].map(subscription => subscription.cancel()));
      if (this.#owned && typeof this.#transport.close === 'function') await this.#transport.close();
    })();
    return this.#closing;
  }
}

export const createClient = options => new BotterClient(options);
export function cliTransport(client) { return transports.get(client); }
