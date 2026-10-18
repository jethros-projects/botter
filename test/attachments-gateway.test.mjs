import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { uploadAttachment } from '../src/attachments.mjs';

const CHUNK_BYTES = 4 * 1024 * 1024;
const BOX_MAX_BYTES = 25 * 1024 * 1024;
const remotePath = '/home/box/agent-data/agents/test-agent/attachments/example.bin';
const bot = { agentId: 'test-agent', name: 'Test Bot', viewerSessionId: 'test-session' };

async function sourceFile(t, bytes, name = 'example.bin') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-gateway-upload-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, name);
  await fs.writeFile(filename, bytes);
  return filename;
}

function clientFor(begin = { mode: 'GROK_BOT_ATTACHMENT_UPLOAD_MODE_USE_BOX' }) {
  const calls = [];
  return {
    calls,
    async resolveBot() { return bot; },
    async rpc(method, args, options) {
      calls.push({ method, args, options });
      assert.equal(method, 'BeginGrokBotAttachmentUpload');
      return begin;
    },
  };
}

function gatewayFor(handler) {
  const calls = [];
  return {
    calls,
    async rpcGateway(method, args, options) {
      calls.push({ method, args, options });
      return handler(method, args, options);
    },
  };
}

test('USE_BOX is opt-in and a malformed gateway is rejected before any remote call', async t => {
  const source = await sourceFile(t, 'hello');
  const client = clientFor();
  await assert.rejects(uploadAttachment(client, 'Test Bot', source), { code: 'BOX_UPLOAD_REQUIRED' });
  assert.equal(client.calls.length, 1);
  const unused = clientFor();
  for (const gatewayClient of [null, {}, { rpcGateway: true }]) {
    await assert.rejects(uploadAttachment(unused, 'Test Bot', source, { gatewayClient }), { code: 'INVALID_OPTION' });
  }
  assert.equal(unused.calls.length, 0);
});

test('small box upload uses the exact single-body gateway schema and preserves result metadata', async t => {
  const bytes = Buffer.from('hello');
  const source = await sourceFile(t, bytes, 'hello.txt');
  const client = clientFor();
  const controller = new AbortController();
  const gatewayClient = gatewayFor((method, args, options) => {
    assert.equal(method, 'uploadAttachment');
    assert.deepEqual(args, { agentId: bot.agentId, filename: 'hello.txt', bytesBase64: bytes.toString('base64') });
    assert.equal(options.signal, controller.signal);
    assert.equal(options.timeoutMs, 1234);
    return { path: remotePath, gatewayTrace: 'preserved' };
  });
  const result = await uploadAttachment(client, 'Test Bot', source, {
    gatewayClient, sessionId: 'other-session', signal: controller.signal, timeoutMs: 1234,
    fetchImpl: () => assert.fail('box upload must not use signed storage'),
  });
  assert.equal(result.path, remotePath);
  assert.equal(result.kind, 'box');
  assert.equal(result.mode, 'gateway-single');
  assert.equal(result.sessionId, 'other-session');
  assert.equal(result.fileName, 'hello.txt');
  assert.equal(result.contentType, 'text/plain');
  assert.equal(result.sizeBytes, bytes.length);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.gatewayTrace, 'preserved');
  assert.equal(gatewayClient.calls.length, 1);
  assert.equal(client.calls.length, 1);
});

test('box chunk upload sends every byte exactly once with numeric offsets and one stable UUID', async t => {
  const bytes = Buffer.alloc(CHUNK_BYTES * 2 + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const source = await sourceFile(t, bytes);
  const received = [];
  const gatewayClient = gatewayFor((method, args) => {
    assert.equal(method, 'uploadAttachmentChunk');
    assert.deepEqual(Object.keys(args).sort(), ['agentId', 'bytesBase64', 'filename', 'offset', 'totalSize', 'uploadId']);
    assert.equal(args.agentId, bot.agentId);
    assert.equal(args.filename, 'example.bin');
    assert.equal(typeof args.offset, 'number');
    assert.equal(args.totalSize, bytes.length);
    assert.match(args.uploadId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
    const part = Buffer.from(args.bytesBase64, 'base64');
    assert.equal(part.length, Math.min(CHUNK_BYTES, bytes.length - args.offset));
    assert.deepEqual(part, bytes.subarray(args.offset, args.offset + part.length));
    received.push(part);
    return args.offset + part.length === bytes.length
      ? { committedPath: remotePath, finalMetadata: true } : { committedPath: null };
  });
  const client = clientFor({ mode: 1 });
  const result = await uploadAttachment(client, 'Test Bot', source, { gatewayClient });
  assert.deepEqual(gatewayClient.calls.map(call => call.args.offset), [0, CHUNK_BYTES, CHUNK_BYTES * 2]);
  assert.equal(new Set(gatewayClient.calls.map(call => call.args.uploadId)).size, 1);
  assert.deepEqual(Buffer.concat(received), bytes);
  assert.equal(result.mode, 'gateway-chunks');
  assert.equal(result.committedPath, remotePath);
  assert.equal(result.finalMetadata, true);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(client.calls.length, 1);
});

test('a 4 MiB box upload fits a single request and larger ones use chunks', async t => {
  const source = await sourceFile(t, Buffer.alloc(CHUNK_BYTES));
  const gatewayClient = gatewayFor(method => {
    assert.equal(method, 'uploadAttachment');
    return { path: remotePath };
  });
  await uploadAttachment(clientFor(), 'Test Bot', source, { gatewayClient });
  assert.equal(gatewayClient.calls.length, 1);
});

test('box file limits match desktop filename classification and no empty upload is attempted', async t => {
  const empty = await sourceFile(t, '', 'empty.txt');
  const overLimit = await sourceFile(t, Buffer.alloc(BOX_MAX_BYTES + 1), 'oversized.txt');
  const video = path.join(path.dirname(overLimit), 'movie.MP4');
  await fs.rename(overLimit, video);
  const gatewayClient = gatewayFor((_method, args) => {
    const part = Buffer.from(args.bytesBase64, 'base64');
    return args.offset + part.length === args.totalSize ? { committedPath: remotePath } : {};
  });
  await assert.rejects(uploadAttachment(clientFor(), 'Test Bot', empty, { gatewayClient }), { code: 'EMPTY_FILE' });
  assert.equal(gatewayClient.calls.length, 0);
  // The same bytes are accepted by the desktop's larger video allowance.
  await uploadAttachment(clientFor(), 'Test Bot', video, { gatewayClient });
  assert.equal(gatewayClient.calls.length, Math.ceil((BOX_MAX_BYTES + 1) / CHUNK_BYTES));
  await fs.rename(video, overLimit);
  const refusedGateway = gatewayFor(() => assert.fail('oversize text must not reach gateway'));
  await assert.rejects(uploadAttachment(clientFor(), 'Test Bot', overLimit, { gatewayClient: refusedGateway }), { code: 'FILE_TOO_LARGE' });
  assert.equal(refusedGateway.calls.length, 0);
});

test('the local cap and server refusals take priority over gateway access', async t => {
  const source = await sourceFile(t, 'hello');
  const gatewayClient = gatewayFor(() => assert.fail('gateway must not be used'));
  const local = clientFor();
  await assert.rejects(uploadAttachment(local, 'Test Bot', source, { gatewayClient, maxBytes: 4 }), { code: 'FILE_TOO_LARGE' });
  assert.equal(local.calls.length, 0);
  for (const begin of [{ mode: 4 }, { mode: 1, refusal: 1 }]) {
    const client = clientFor(begin);
    await assert.rejects(uploadAttachment(client, 'Test Bot', source, { gatewayClient }), { code: 'UPLOAD_REFUSED' });
    assert.equal(client.calls.length, 1);
  }
});

test('a supplied gateway is not called for a signed-store upload', async t => {
  const source = await sourceFile(t, 'hello');
  const calls = [];
  const client = {
    async resolveBot() { return bot; },
    async rpc(method) {
      calls.push(method);
      if (method === 'BeginGrokBotAttachmentUpload') return {
        mode: 2, uploadToken: 'token', put: { url: 'https://storage.example/upload' },
      };
      assert.equal(method, 'CompleteGrokBotAttachmentUpload');
      return { alias: remotePath, sizeBytes: '5', extraMetadata: 'preserved' };
    },
  };
  const result = await uploadAttachment(client, 'Test Bot', source, {
    gatewayClient: gatewayFor(() => assert.fail('store must not use gateway')),
    fetchImpl: async () => new Response(null),
  });
  assert.equal(result.kind, 'store');
  assert.equal(result.extraMetadata, 'preserved');
  assert.deepEqual(calls, ['BeginGrokBotAttachmentUpload', 'CompleteGrokBotAttachmentUpload']);
});

test('invalid single gateway results are rejected without retrying or changing transports', async t => {
  const source = await sourceFile(t, 'hello');
  for (const result of [null, [], 'path', {}, { path: '../relative' }, { path: 'https://example.com/file' }]) {
    const gatewayClient = gatewayFor(() => result);
    const client = clientFor();
    await assert.rejects(uploadAttachment(client, 'Test Bot', source, { gatewayClient }));
    assert.equal(gatewayClient.calls.length, 1);
    assert.equal(client.calls.length, 1);
  }
});

test('premature, absent, and unsafe chunk commit paths stop the transfer without a write retry', async t => {
  const source = await sourceFile(t, Buffer.alloc(CHUNK_BYTES + 1));
  for (const [handler, code, count] of [
    [() => ({ committedPath: remotePath }), 'SIZE_MISMATCH', 1],
    [() => ({}), 'INCOMPLETE_UPLOAD', 2],
    [(_method, args) => args.offset ? { committedPath: '/tmp/../escape' } : {}, 'INVALID_REMOTE_PATH', 2],
  ]) {
    const gatewayClient = gatewayFor(handler);
    const client = clientFor();
    await assert.rejects(uploadAttachment(client, 'Test Bot', source, { gatewayClient }), { code });
    assert.equal(gatewayClient.calls.length, count);
    assert.equal(client.calls.length, 1);
  }
});

test('gateway errors and cancellation never repeat an uncertain write', async t => {
  const source = await sourceFile(t, Buffer.alloc(CHUNK_BYTES + 1));
  const failure = new Error('transport disconnected after write');
  const gatewayClient = gatewayFor(() => { throw failure; });
  const client = clientFor();
  await assert.rejects(uploadAttachment(client, 'Test Bot', source, { gatewayClient }), error => error === failure);
  assert.equal(gatewayClient.calls.length, 1);
  assert.equal(client.calls.length, 1);
  const controller = new AbortController();
  const canceledGateway = gatewayFor(() => { controller.abort(); return {}; });
  await assert.rejects(uploadAttachment(clientFor(), 'Test Bot', source, { gatewayClient: canceledGateway,
    signal: controller.signal }), { name: 'AbortError' });
  assert.equal(canceledGateway.calls.length, 1);
});
