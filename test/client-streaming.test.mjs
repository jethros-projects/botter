import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex, Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { connect as connectHttp2, createServer } from 'node:http2';
import { ApiError, GrokBotClient, decodeConnectFrames, encodeConnectFrame } from '../src/client.mjs';

const collect = source => Array.fromAsync(source);
const terminal = value => { const result = encodeConnectFrame(value ?? {}); result[0] = 2; return result; };
const response = (...frames) => new Response(Buffer.concat(frames), { headers: { 'content-type': 'application/connect+json' } });
async function* chunks(...values) { yield* values; }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function fakeHttp2({ onFrame, onFinish, onOpen } = {}) {
  const state = { connections: 0, frames: [], sessionClosed: false, requestClosed: false };
  state.connect = origin => {
    assert.equal(origin, 'https://api2.cursor.sh');
    state.connections++;
    const session = new EventEmitter();
    session.destroy = () => { state.sessionClosed = true; state.wire?.destroy(); };
    session.request = (headers, options) => {
      state.headers = headers;
      assert.deepEqual(options, { endStream: false });
      const wire = new Duplex({
        read() {},
        write(frame, _encoding, done) {
          state.frames.push(Buffer.from(frame));
          try { onFrame?.(state, wire); done(); } catch (error) { done(error); }
        },
        final(done) { try { onFinish?.(state, wire); done(); } catch (error) { done(error); } },
      });
      state.wire = wire;
      wire.close = () => { state.requestClosed = true; wire.destroy(); };
      state.sendHeaders = (values = {}) => wire.emit('response', { ':status': 200,
        'content-type': 'application/connect+json', ...values });
      queueMicrotask(() => onOpen?.(state, wire));
      return wire;
    };
    return session;
  };
  return state;
}

test('duplex uses HTTP/2 by default and uploads every message without request trailers', async () => {
  const mock = fakeHttp2({ onFinish(state, wire) {
    state.sendHeaders({ 'x-request-id': 'request-1' });
    wire.push(encodeConnectFrame({ text: 'hello' })); wire.push(terminal()); wire.push(null);
  } });
  const client = new GrokBotClient({ tokenProvider: () => 'test-token', http2Connect: mock.connect,
    fetchImpl: () => assert.fail('HTTP/2 must not silently fall back to fetch.') });
  const input = [{ config: { language: 'en' } }, { audio: 'AQID' }, { audio: 'BAUG' }];
  assert.deepEqual(await collect(client.duplex('StreamStt', input, { service: 'AiService' })), [{ text: 'hello' }]);
  assert.equal(mock.headers[':path'], '/aiserver.v1.AiService/StreamStt');
  assert.equal(mock.headers.authorization, 'Bearer test-token');
  assert.equal(mock.headers['content-type'], 'application/connect+json');
  assert.equal(mock.headers['connect-timeout-ms'], '30000');
  assert.deepEqual(await collect(decodeConnectFrames(chunks(...mock.frames))), input);
  assert.ok(mock.frames.every(frame => frame[0] === 0));
  assert.equal(mock.connections, 1);
  assert.equal(mock.sessionClosed, true);
});

test('HTTP/2 yields responses before the input producer finishes', async () => {
  const release = deferred();
  const mock = fakeHttp2({ onFrame(state, wire) {
    if (state.frames.length === 1) { state.sendHeaders(); wire.push(encodeConnectFrame({ partial: 'first' })); }
  }, onFinish(_state, wire) { wire.push(terminal()); wire.push(null); } });
  async function* input() { yield { audio: 'one' }; await release.promise; yield { audio: 'two' }; }
  const client = new GrokBotClient({ tokenProvider: () => 'token', http2Connect: mock.connect });
  const stream = client.duplex('StreamStt', input(), { service: 'AiService', timeoutMs: 1000 });
  assert.deepEqual(await stream.next(), { value: { partial: 'first' }, done: false });
  assert.equal(mock.frames.length, 1);
  release.resolve();
  assert.deepEqual(await stream.next(), { value: undefined, done: true });
  assert.equal(mock.frames.length, 2);
});

test('native HTTP/2 carries concurrent messages against a local protocol server', async () => {
  const server = createServer();
  const release = deferred(), received = [];
  const handlerErrors = [];
  server.on('stream', (stream, headers) => {
    (async () => {
      assert.equal(headers[':path'], '/aiserver.v1.AiService/StreamStt');
      stream.respond({ ':status': 200, 'content-type': 'application/connect+json' });
      for await (const input of decodeConnectFrames(stream)) {
        received.push(input);
        stream.write(encodeConnectFrame({ partial: input.audio }));
      }
      stream.end(terminal());
    })().catch(error => { handlerErrors.push(error); stream.destroy(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = new GrokBotClient({ tokenProvider: () => 'synthetic-test-token', http2Connect: origin => {
      assert.equal(origin, 'https://api2.cursor.sh');
      return connectHttp2(`http://127.0.0.1:${port}`);
    } });
    async function* input() { yield { audio: 'first' }; await release.promise; yield { audio: 'second' }; }
    const iterator = client.duplex('StreamStt', input(), { service: 'AiService', timeoutMs: 2000 });
    assert.deepEqual(await iterator.next(), { value: { partial: 'first' }, done: false });
    assert.deepEqual(received, [{ audio: 'first' }]);
    release.resolve();
    assert.deepEqual(await iterator.next(), { value: { partial: 'second' }, done: false });
    assert.equal((await iterator.next()).done, true);
    assert.deepEqual(received, [{ audio: 'first' }, { audio: 'second' }]);
    assert.deepEqual(handlerErrors, []);
  } finally {
    release.resolve();
    await new Promise(resolve => server.close(resolve));
  }
});

test('HTTP/2 respects upload backpressure before advancing the input producer', async () => {
  const written = [], firstWrite = deferred();
  let wire;
  const client = new GrokBotClient({ tokenProvider: () => 'token', http2Connect: () => {
    const session = new EventEmitter();
    session.destroy = () => wire.destroy();
    session.request = () => {
      wire = new Readable({ read() {} });
      wire.write = frame => { written.push(frame); firstWrite.resolve(); return written.length !== 1; };
      wire.end = () => {
        wire.emit('response', { ':status': 200 }); wire.push(terminal()); wire.push(null);
      };
      wire.close = () => wire.destroy();
      return wire;
    };
    return session;
  } });
  let produced = 0;
  async function* input() { produced++; yield { audio: 'one' }; produced++; yield { audio: 'two' }; }
  const task = collect(client.duplex('StreamStt', input(), { service: 'AiService' }));
  await firstWrite.promise;
  assert.equal(produced, 1);
  wire.emit('drain');
  assert.deepEqual(await task, []);
  assert.equal(produced, 2);
});

test('explicit fetch transport sends an async framed body with duplex half', async () => {
  let attempts = 0;
  const client = new GrokBotClient({ tokenProvider: () => 'token', fetchImpl: async (url, init) => {
    attempts++;
    assert.equal(url, 'https://api2.cursor.sh/aiserver.v1.AiService/StreamStt');
    assert.equal(init.duplex, 'half');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(await collect(decodeConnectFrames(init.body)), [{ audio: 'A' }, { audio: 'B' }]);
    return response(encodeConnectFrame({ transcript: 'words' }), terminal());
  } });
  assert.deepEqual(await collect(client.duplex('StreamStt', [{ audio: 'A' }, { audio: 'B' }],
    { service: 'AiService', transport: 'fetch' })), [{ transcript: 'words' }]);
  assert.equal(attempts, 1);
});

test('HTTP/2 errors and Connect trailer errors never retry and hide credentials', async () => {
  const mock = fakeHttp2({ onFinish(state, wire) {
    state.sendHeaders({ 'x-request-id': 'r-3' });
    wire.push(terminal({ error: { code: 'permission_denied', message: 'Denied Bearer very-secret-token',
      details: [{ accessToken: 'very-secret-token', reason: 'scope' }] } })); wire.push(null);
  } });
  const client = new GrokBotClient({ tokenProvider: () => 'very-secret-token', http2Connect: mock.connect });
  await assert.rejects(collect(client.duplex('StreamStt', [], { service: 'AiService' })), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'permission_denied');
    assert.equal(error.requestId, 'r-3');
    assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /very-secret-token/);
    return true;
  });
  assert.equal(mock.connections, 1);
  assert.equal(mock.requestClosed, true);
});

test('HTTP/2 non-success responses preserve status and do not fall back', async () => {
  const mock = fakeHttp2({ onFinish(state, wire) {
    state.sendHeaders({ ':status': 503 });
    wire.push(JSON.stringify({ code: 'unavailable', message: 'Please retry later.' })); wire.push(null);
  } });
  const client = new GrokBotClient({ tokenProvider: () => 'token', http2Connect: mock.connect });
  await assert.rejects(collect(client.duplex('StreamStt', [], { service: 'AiService' })),
    { name: 'ApiError', status: 503, code: 'unavailable' });
  assert.equal(mock.connections, 1);
});

test('cancellation interrupts a blocked HTTP/2 input producer and destroys transport', async () => {
  const inputEntered = deferred(); let returned = false;
  const producer = {
    [Symbol.asyncIterator]() { return this; },
    next() { inputEntered.resolve(); return new Promise(() => {}); },
    return() { returned = true; return { done: true }; },
  };
  const mock = fakeHttp2();
  const client = new GrokBotClient({ tokenProvider: () => 'token', http2Connect: mock.connect });
  const controller = new AbortController();
  const task = collect(client.duplex('StreamStt', producer, { service: 'AiService', signal: controller.signal }));
  await inputEntered.promise;
  controller.abort();
  await assert.rejects(task, { name: 'AbortError' });
  await Promise.resolve();
  assert.equal(returned, true);
  assert.equal(mock.requestClosed, true);
  assert.equal(mock.sessionClosed, true);
});

test('whole-call duplex deadline interrupts a blocked response', async () => {
  const mock = fakeHttp2({ onFinish(state) { state.sendHeaders(); } });
  const client = new GrokBotClient({ tokenProvider: () => 'token', http2Connect: mock.connect });
  await assert.rejects(collect(client.duplex('StreamStt', [], { service: 'AiService', timeoutMs: 15 })), { name: 'TimeoutError' });
  assert.equal(mock.sessionClosed, true);
});

test('consumer early return stops a pending producer and closes HTTP/2', async () => {
  const mock = fakeHttp2({ onFrame(state, wire) {
    state.sendHeaders(); wire.push(encodeConnectFrame({ partial: true }));
  } });
  async function* input() { yield { audio: 'one' }; await new Promise(() => {}); }
  const client = new GrokBotClient({ tokenProvider: () => 'token', http2Connect: mock.connect });
  for await (const value of client.duplex('StreamStt', input(), { service: 'AiService' })) {
    assert.equal(value.partial, true); break;
  }
  assert.equal(mock.requestClosed, true);
  assert.equal(mock.sessionClosed, true);
});

test('an oversized request frame fails without sending the frame or retrying', async () => {
  const mock = fakeHttp2();
  const client = new GrokBotClient({ tokenProvider: () => 'token', http2Connect: mock.connect });
  await assert.rejects(collect(client.duplex('StreamStt', [{ audio: 'x'.repeat(100) }],
    { service: 'AiService', maxFrameBytes: 20 })), /request exceeds the frame limit/);
  assert.equal(mock.frames.length, 0);
  assert.equal(mock.connections, 1);
  assert.equal(mock.sessionClosed, true);
});

test('source exceptions cancel HTTP/2 and preserve sanitized error messages', async () => {
  const mock = fakeHttp2();
  async function* input() { throw new Error('invalid token-source: my-secret'); }
  const client = new GrokBotClient({ tokenProvider: () => 'my-secret', http2Connect: mock.connect });
  await assert.rejects(collect(client.duplex('StreamStt', input(), { service: 'AiService' })), /invalid token-source: \[REDACTED\]/);
  assert.equal(mock.sessionClosed, true);
});

test('streaming validates routing, options and cancellation before opening a connection', async () => {
  const mock = fakeHttp2();
  const client = new GrokBotClient({ tokenProvider: () => 'token', http2Connect: mock.connect });
  for (const [method, options, pattern] of [
    ['../../steal', {}, /Invalid API/], ['StreamStt', { service: 'Other' }, /Invalid API/],
    ['StreamStt', { transport: 'other' }, /transport/], ['StreamStt', { timeoutMs: -1 }, /Timeout/],
    ['StreamStt', { maxFrameBytes: 0 }, /Frame limit/],
  ]) await assert.rejects(collect(client.duplex(method, [], options)), pattern);
  await assert.rejects(collect(client.duplex('StreamStt', [], { signal: AbortSignal.abort() })), { name: 'AbortError' });
  assert.equal(mock.connections, 0);
});

test('real stream calls reject EOF without an end-stream marker', async () => {
  const client = new GrokBotClient({ tokenProvider: () => 'token', fetchImpl: async () => response(encodeConnectFrame({ row: true })) });
  await assert.rejects(collect(client.stream('StreamGrokBotMessages', {})), /without an end-stream frame/);
  await assert.rejects(collect(client.duplex('StreamStt', [], { transport: 'fetch' })), /without an end-stream frame/);
});

test('decoder rejects bytes after terminal frame across network chunks', async () => {
  await assert.rejects(collect(decodeConnectFrames(chunks(terminal(), encodeConnectFrame({ unexpected: true })))), /after the Connect end-stream/);
  assert.deepEqual(await collect(decodeConnectFrames(chunks(terminal()), { requireEndStream: true })), []);
});

test('decoder validates terminal errors, metadata, reserved flags, and JSON objects', async () => {
  for (const value of [{ error: null }, { error: {} }, { error: { code: null } }, { metadata: { value: 'not-an-array' } }])
    await assert.rejects(collect(decodeConnectFrames(chunks(terminal(value)))), /Invalid .*end-stream/);
  const reserved = Buffer.alloc(5); reserved[0] = 4;
  await assert.rejects(collect(decodeConnectFrames(chunks(reserved))), /Unsupported Connect frame flags/);
  await assert.rejects(collect(decodeConnectFrames(chunks(encodeConnectFrame([])))), /Invalid JSON message/);
});

test('decoder accepts gzip data and trailer frames and bounds decompression', async () => {
  const compressed = (value, flags = 1) => {
    const bytes = gzipSync(JSON.stringify(value)); const header = Buffer.alloc(5);
    header[0] = flags; header.writeUInt32BE(bytes.length, 1); return Buffer.concat([header, bytes]);
  };
  assert.deepEqual(await collect(decodeConnectFrames(chunks(compressed({ text: 'hello' }), compressed({}, 3)),
    { encoding: 'gzip', requireEndStream: true })), [{ text: 'hello' }]);
  await assert.rejects(collect(decodeConnectFrames(chunks(compressed({ text: 'x'.repeat(4096) })),
    { encoding: 'gzip', maxFrameBytes: 100 })), /oversized compressed/);
  await assert.rejects(collect(decodeConnectFrames(chunks(compressed({ text: 'hello' })))), /Unsupported Connect response compression/);
});

test('decoder supports one-byte network fragments and rejects truncated empty data', async () => {
  const bytes = Buffer.concat([encodeConnectFrame({ one: 1 }), terminal()]);
  assert.deepEqual(await collect(decodeConnectFrames(chunks(...Array.from(bytes, byte => Buffer.from([byte]))),
    { requireEndStream: true })), [{ one: 1 }]);
  await assert.rejects(collect(decodeConnectFrames(chunks(Buffer.from([0, 0, 0, 0])))), /Truncated/);
});

test('HTTP RPC errors redact tokens and sensitive structured details', async () => {
  const client = new GrokBotClient({ tokenProvider: () => 'plain-secret', fetchImpl: async () => new Response(JSON.stringify({
    code: 'permission_denied', message: 'plain-secret failed', details: [{ refreshToken: 'other-secret' }],
  }), { status: 403 }) });
  await assert.rejects(client.rpc('ListGrokBotAgents'), error => {
    assert.equal(error.message, '[REDACTED] failed');
    assert.equal(error.details[0].refreshToken, '[REDACTED]');
    return true;
  });
});
