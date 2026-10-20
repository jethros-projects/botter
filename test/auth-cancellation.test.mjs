import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { keychainCommand } from '../src/keychain.mjs';
import { createAuthManager, createFileCredentialStore, createKeychainCredentialStore } from '../src/auth.mjs';
import { createClient } from '../src/index.mjs';

const credentials = { accessToken: 'fixture-access-secret', refreshToken: 'fixture-refresh-secret' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function processes(run = () => {}) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null)); return true; };
    const input = [], call = { file, args, options, child };
    child.stdin.on('data', chunk => input.push(chunk));
    child.stdin.on('finish', () => { call.input = Buffer.concat(input).toString('utf8'); run(call); });
    calls.push(call); return child;
  };
  return { calls, spawnImpl };
}
const finish = (call, code = 0, output = '') => { call.child.stdout.end(output); call.child.stderr.end(); call.child.emit('close', code); };

test('Keychain commands keep credentials in stdin and bound captured output', async () => {
  const success = processes(call => finish(call, 0, 'saved'));
  assert.equal(await keychainCommand(['-i'], { input: credentials.refreshToken, spawnImpl: success.spawnImpl }), 'saved');
  assert.deepEqual(success.calls[0].args, ['-i']); assert.equal(success.calls[0].file, '/usr/bin/security');
  assert.equal(success.calls[0].input, credentials.refreshToken);
  assert.equal(JSON.stringify(success.calls[0].options).includes(credentials.refreshToken), false);
  for (const stream of ['stdout', 'stderr']) {
    const excessive = processes(call => call.child[stream].write(Buffer.alloc(128 * 1024 + 1, 'x')));
    await assert.rejects(keychainCommand(['find-generic-password'], { spawnImpl: excessive.spawnImpl }), { code: 'auth_storage_error' });
    assert.equal(excessive.calls[0].child.killed, true);
  }
});

test('Keychain subprocess cancellation is asynchronous and kills only its child', async () => {
  const fixture = processes(), controller = new AbortController();
  const request = keychainCommand(['find-generic-password'], { signal: controller.signal, spawnImpl: fixture.spawnImpl });
  await tick(); controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(fixture.calls[0].child.killed, true);
  const preaborted = processes();
  await assert.rejects(keychainCommand([], { signal: controller.signal, spawnImpl: preaborted.spawnImpl }), { name: 'AbortError' });
  assert.equal(preaborted.calls.length, 0);
});

test('Keychain process failures discard private output and retain missing-item status', async () => {
  const fixture = processes(call => {
    call.child.stderr.write(credentials.refreshToken);
    finish(call, 44, credentials.accessToken);
  });
  await assert.rejects(keychainCommand(['find-generic-password'], { spawnImpl: fixture.spawnImpl }), error => {
    assert.equal(error.exitCode, 44); assert.equal(error.code, 'auth_storage_error');
    assert.equal(JSON.stringify(error).includes('fixture-'), false);
    assert.equal(error.message.includes('fixture-'), false); return true;
  });
});

test('Keychain store preserves private interactive writes and verifies readback', { skip: process.platform !== 'darwin' }, async () => {
  const encoded = Buffer.from(JSON.stringify(credentials)).toString('base64');
  const fixture = processes(call => finish(call, 0, call.args[0] === 'find-generic-password' ? encoded : ''));
  const store = createKeychainCredentialStore({ service: 'Botter Test Fixture', spawnImpl: fixture.spawnImpl });
  await store.write(credentials);
  assert.deepEqual(fixture.calls[0].args, ['-i']);
  assert.ok(fixture.calls[0].input.includes(encoded));
  assert.ok(!fixture.calls.some(call => JSON.stringify(call.args).includes(encoded)));
  assert.equal((await store.read()).refreshToken, credentials.refreshToken);
  const missing = processes(call => finish(call, 44));
  const missingStore = createKeychainCredentialStore({ spawnImpl: missing.spawnImpl });
  assert.equal(await missingStore.read(), null); await missingStore.clear();
});

test('canonical auth deadline cancels a stalled Keychain read without blocking the host', { skip: process.platform !== 'darwin' }, async () => {
  const fixture = processes();
  const store = createKeychainCredentialStore({ spawnImpl: fixture.spawnImpl });
  const client = createClient({ authManager: createAuthManager({ store }) });
  try {
    await assert.rejects(client.auth.status({ timeoutMs: 10 }), { code: 'TIMEOUT' });
    assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0].child.killed, true);
  } finally { await client.close(); }
});

test('cancelled queued credential mutation never writes after acquiring a late lock', async () => {
  let release, writes = 0;
  const gate = new Promise(resolve => { release = resolve; }), controller = new AbortController();
  const auth = createAuthManager({ store: {
    withLock: fn => gate.then(fn), read: async () => credentials, write: async () => { writes++; }, clear: async () => {},
  } });
  const saving = auth.save(credentials, { signal: controller.signal }); controller.abort();
  await assert.rejects(saving, { name: 'AbortError' }); release(); await tick();
  assert.equal(writes, 0);
});

test('file lock waits observe cancellation and leave the active owner intact', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'botter-auth-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'credentials.json'), store = createFileCredentialStore(filename);
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const owner = store.withLock(async () => { entered(); await held; }); await ready;
  const controller = new AbortController(), waiting = store.withLock(() => assert.fail('Cancelled waiter must not run.'), { signal: controller.signal });
  await tick(); controller.abort(); await assert.rejects(waiting, { name: 'AbortError' });
  assert.ok(await stat(filename + '.lock'));
  release(); await owner;
  await assert.rejects(stat(filename + '.lock'), { code: 'ENOENT' });
  await assert.rejects(stat(filename), { code: 'ENOENT' });
});

test('cancelled credential reads and fallbacks settle without allowing late persistence', async () => {
  for (const phase of ['read', 'fallback']) {
    let observed;
    const controller = new AbortController();
    const auth = createAuthManager({ store: {
      read: async options => { observed = options.signal; return phase === 'read' ? new Promise(() => {}) : null; },
      write: async () => assert.fail('Reads must not persist credentials.'), clear: async () => {},
    }, fallback: async options => { observed = options.signal; return new Promise(() => {}); } });
    const request = auth.getSession({ signal: controller.signal }); await tick(); controller.abort();
    await assert.rejects(request, { name: 'AbortError' }); assert.equal(observed, controller.signal);
  }
});
