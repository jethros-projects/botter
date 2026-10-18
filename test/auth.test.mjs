import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginLogin, pollLogin, createFileCredentialStore, createAuthManager } from '../src/auth.mjs';

const NOW = 1_800_000_000_000;
const ACCESS_SECRET = 'fixture-access-secret';
const REFRESH_SECRET = 'fixture-refresh-secret';
const CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const jwt = seconds => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: 'fixture-account', exp: seconds })).toString('base64url')}.fixture`;
const fresh = () => ({ accessToken: jwt(NOW / 1000 + 3600), refreshToken: REFRESH_SECRET, selectedTeamId: 42 });
const expired = () => ({ accessToken: jwt(NOW / 1000 - 60), refreshToken: REFRESH_SECRET, selectedTeamId: 42 });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function memoryStore(initial = null) {
  let value = initial && structuredClone(initial), tail = Promise.resolve();
  return {
    read: async () => value && structuredClone(value),
    write: async next => { value = structuredClone(next); },
    clear: async () => { value = null; },
    withLock: async fn => {
      const work = tail.then(fn); tail = work.catch(() => {}); return work;
    },
  };
}

async function privateFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-bridge-auth-'));
  await fs.chmod(dir, 0o700);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, filename: path.join(dir, 'credentials.json') };
}

function assertSecretFree(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(ACCESS_SECRET), false);
  assert.equal(text.includes(REFRESH_SECRET), false);
}

test('login uses a unique PKCE challenge and a browser flow without an app callback', () => {
  const first = beginLogin(), second = beginLogin();
  const url = new URL(first.loginUrl);
  assert.equal(url.origin, 'https://cursor.com');
  assert.equal(url.pathname, '/loginDeepControl');
  assert.equal(url.searchParams.get('mode'), 'login');
  assert.equal(url.searchParams.get('redirectTarget'), 'cli');
  assert.equal(url.searchParams.get('supportsSelectedTeamLogin'), 'true');
  assert.equal(url.searchParams.get('uuid'), first.uuid);
  assert.match(first.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(Buffer.from(first.verifier, 'base64url').length, 32);
  assert.equal(url.searchParams.get('challenge'), createHash('sha256').update(first.verifier).digest('base64url'));
  assert.equal(url.searchParams.has('verifier'), false);
  assert.notEqual(first.uuid, second.uuid);
  assert.notEqual(first.verifier, second.verifier);
});

test('login polling waits through pending responses and preserves selected team', async () => {
  const flow = beginLogin(); let count = 0;
  const result = await pollLogin(flow, { pollMs: 1, timeoutMs: 2000, fetchImpl: async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api2.cursor.sh');
    assert.equal(url.pathname, '/auth/poll');
    assert.equal(url.searchParams.get('uuid'), flow.uuid);
    assert.equal(url.searchParams.get('verifier'), flow.verifier);
    assert.equal(init.redirect, 'error');
    return ++count === 1 ? json({}, 404) : json({ accessToken: ACCESS_SECRET, refreshToken: REFRESH_SECRET, selectedTeamId: 42 });
  } });
  assert.equal(count, 2);
  assert.equal(result.accessToken, ACCESS_SECRET);
  assert.equal(result.refreshToken, REFRESH_SECRET);
  assert.equal(result.selectedTeamId, 42);
});

test('login policy denial fails immediately without exposing returned secrets', async () => {
  let count = 0;
  await assert.rejects(pollLogin(beginLogin(), { pollMs: 1, timeoutMs: 1000, fetchImpl: async () => {
    count++;
    return json({ error: 'sign_in_policy_violation', detail: `${ACCESS_SECRET} ${REFRESH_SECRET}` }, 403);
  } }), error => { assertSecretFree(error.message); return true; });
  assert.equal(count, 1);
});

test('login polling rejects malformed success payloads without exposing them', async () => {
  await assert.rejects(pollLogin(beginLogin(), { pollMs: 1, timeoutMs: 1000,
    fetchImpl: async () => json({ accessToken: ACCESS_SECRET, debug: REFRESH_SECRET }) }),
  error => { assertSecretFree(error.message); return true; });
});

test('login polling cancellation does not issue a request', async () => {
  const controller = new AbortController(); controller.abort(); let count = 0;
  await assert.rejects(pollLogin(beginLogin(), { signal: controller.signal,
    fetchImpl: async () => { count++; return json({}); } }));
  assert.equal(count, 0);
});

test('unexpired saved login is usable without refreshing or a desktop fallback', async () => {
  const store = memoryStore(fresh()); let fetched = 0, fallback = 0;
  const auth = createAuthManager({ store, now: () => NOW,
    fetchImpl: async () => { fetched++; throw new Error('unexpected request'); },
    fallback: async () => { fallback++; throw new Error('unexpected fallback'); },
  });
  const result = await auth.getSession();
  assert.equal(result.accessToken, fresh().accessToken);
  assert.equal(result.source, 'bridge');
  assert.equal(fetched, 0); assert.equal(fallback, 0);
});

test('opaque saved tokens refresh because their remaining lifetime cannot be verified', async () => {
  const replacement = jwt(NOW / 1000 + 7200);
  let requests = 0;
  const auth = createAuthManager({ store: memoryStore({ accessToken: ACCESS_SECRET, refreshToken: REFRESH_SECRET }),
    now: () => NOW, fetchImpl: async () => { requests++; return json({ access_token: replacement }); } });
  assert.equal((await auth.getSession()).accessToken, replacement);
  assert.equal(requests, 1);
});

test('refresh uses the account endpoint and atomically saves rotated tokens with selected team', async () => {
  const store = memoryStore(expired()); const replacement = jwt(NOW / 1000 + 7200);
  const auth = createAuthManager({ store, now: () => NOW, fetchImpl: async (input, init) => {
    assert.equal(new URL(input).href, 'https://api2.cursor.sh/oauth/token');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(init.body), { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: REFRESH_SECRET });
    assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    return json({ access_token: replacement, refresh_token: 'rotated-fixture-refresh' });
  } });
  const session = await auth.getSession();
  assert.equal(session.accessToken, replacement);
  assert.equal(session.refreshToken, 'rotated-fixture-refresh');
  assert.equal(session.selectedTeamId, 42);
  assert.equal((await store.read()).refreshToken, 'rotated-fixture-refresh');
});

test('refresh preserves the existing refresh token when the server omits a replacement', async () => {
  const store = memoryStore(expired());
  const auth = createAuthManager({ store, now: () => NOW,
    fetchImpl: async () => json({ access_token: jwt(NOW / 1000 + 3600) }) });
  const session = await auth.getSession();
  assert.equal(session.refreshToken, REFRESH_SECRET);
  assert.equal((await store.read()).selectedTeamId, 42);
});

test('a token nearing expiry refreshes before the next API request', async () => {
  let count = 0;
  const auth = createAuthManager({ store: memoryStore({ ...fresh(), accessToken: jwt(NOW / 1000 + 299) }), now: () => NOW,
    fetchImpl: async () => { count++; return json({ access_token: jwt(NOW / 1000 + 3600) }); } });
  await auth.getSession(); assert.equal(count, 1);
});

test('concurrent session requests perform one token rotation', async () => {
  let count = 0; const store = memoryStore(expired());
  const auth = createAuthManager({ store, now: () => NOW, fetchImpl: async () => {
    count++; await new Promise(resolve => setTimeout(resolve, 10));
    return json({ access_token: jwt(NOW / 1000 + 3600), refresh_token: 'new-fixture-refresh' });
  } });
  const results = await Promise.all(Array.from({ length: 8 }, () => auth.getSession()));
  assert.equal(count, 1);
  assert.equal(new Set(results.map(result => result.refreshToken)).size, 1);
});

test('HTTP and transport refresh errors preserve saved credentials and redact secrets', async () => {
  for (const fetchImpl of [
    async () => json({ message: `${ACCESS_SECRET} ${REFRESH_SECRET}` }, 503),
    async () => { throw new Error(`failed request ${ACCESS_SECRET} ${REFRESH_SECRET}`); },
  ]) {
    const initial = expired(), store = memoryStore(initial);
    const auth = createAuthManager({ store, now: () => NOW, fetchImpl });
    await assert.rejects(auth.getSession(), error => { assertSecretFree(error.message); return true; });
    assert.deepEqual(await store.read(), initial);
  }
});

test('malformed refresh success does not replace usable stored recovery credentials', async () => {
  const initial = expired(), store = memoryStore(initial);
  const auth = createAuthManager({ store, now: () => NOW,
    fetchImpl: async () => json({ refresh_token: 'rotated-but-unusable', detail: ACCESS_SECRET }) });
  await assert.rejects(auth.getSession(), error => { assertSecretFree(error.message); return true; });
  assert.deepEqual(await store.read(), initial);
});

test('status reports expiry without exposing or refreshing credentials', async () => {
  let fetched = 0;
  const auth = createAuthManager({ store: memoryStore({ accessToken: ACCESS_SECRET, refreshToken: REFRESH_SECRET, selectedTeamId: 42 }),
    now: () => NOW, fetchImpl: async () => { fetched++; throw new Error('unexpected request'); } });
  const status = await auth.status();
  assert.equal(status.authenticated, true); assert.equal(status.source, 'bridge');
  assert.equal(status.selectedTeamId, 42); assertSecretFree(status); assert.equal(fetched, 0);
  const staleAuth = createAuthManager({ store: memoryStore(expired()), now: () => NOW });
  assert.equal((await staleAuth.status()).needsRefresh, true);
});

test('saved login and logout work without invoking desktop authentication', async () => {
  const store = memoryStore(); let fallback = 0;
  const auth = createAuthManager({ store, now: () => NOW,
    fallback: async () => { fallback++; return 'desktop-fixture'; } });
  await auth.save(fresh());
  assert.equal((await auth.getSession()).source, 'bridge');
  assert.equal(fallback, 0);
  await auth.logout();
  assert.equal(await store.read(), null);
});

test('credential files are private, round trip, and clear cleanly', async t => {
  const { filename } = await privateFixture(t), store = createFileCredentialStore(filename);
  assert.equal(await store.read(), null);
  await store.write(fresh());
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  assert.equal((await store.read()).refreshToken, REFRESH_SECRET);
  await store.clear(); assert.equal(await store.read(), null);
});

test('credential store rejects symlink reads and writes', async t => {
  const { dir, filename } = await privateFixture(t), target = path.join(dir, 'target.json');
  await fs.writeFile(target, JSON.stringify(fresh()), { mode: 0o600 });
  await fs.symlink(target, filename);
  const store = createFileCredentialStore(filename);
  await assert.rejects(async () => store.read());
  await assert.rejects(async () => store.write(fresh()));
  assert.equal((await fs.lstat(filename)).isSymbolicLink(), true);
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).refreshToken, REFRESH_SECRET);
});

test('credential store refuses group-readable existing files', async t => {
  const { filename } = await privateFixture(t);
  await fs.writeFile(filename, JSON.stringify(fresh()), { mode: 0o644 }); await fs.chmod(filename, 0o644);
  const store = createFileCredentialStore(filename);
  await assert.rejects(async () => store.read());
  await assert.rejects(async () => store.write(fresh()));
});

test('credential file lock serializes writers across store instances', async t => {
  const { filename } = await privateFixture(t), one = createFileCredentialStore(filename), two = createFileCredentialStore(filename);
  const trace = [];
  await Promise.all([
    one.withLock(async () => { trace.push('one-start'); await new Promise(resolve => setTimeout(resolve, 20)); trace.push('one-end'); }),
    two.withLock(async () => { trace.push('two-start'); trace.push('two-end'); }),
  ]);
  assert.ok(trace.join(',') === 'one-start,one-end,two-start,two-end' || trace.join(',') === 'two-start,two-end,one-start,one-end');
});


test('personal account login ignores an empty optional team selection', async () => {
  const result = await pollLogin(beginLogin(), { pollMs: 1, timeoutMs: 1000,
    fetchImpl: async () => json({ accessToken: ACCESS_SECRET, refreshToken: REFRESH_SECRET, selectedTeamId: null }) });
  assert.equal(result.selectedTeamId, undefined);
  assert.equal(result.accessToken, ACCESS_SECRET);
});


test('failed lock initialization closes and removes the partial lock', async t => {
  const { filename } = await privateFixture(t), store = createFileCredentialStore(filename);
  const original = fs.open;
  let closed = false, failed = false;
  fs.open = async (...args) => {
    const handle = await original(...args);
    if (args[0] === filename + '.lock' && !failed) {
      failed = true;
      return { writeFile: async () => { throw Object.assign(new Error('disk full'), {code:'ENOSPC'}); },
        close: async () => { closed = true; await handle.close(); } };
    }
    return handle;
  };
  try { await assert.rejects(store.withLock(async () => {}), {code:'auth_storage_error'}); }
  finally { fs.open = original; }
  assert.equal(closed, true);
  await assert.rejects(fs.stat(filename + '.lock'), {code:'ENOENT'});
  assert.equal(await store.withLock(async () => 'recovered'), 'recovered');
});

test('an abandoned incomplete lock can be recovered after its timeout', async t => {
  const { filename } = await privateFixture(t), store = createFileCredentialStore(filename);
  await fs.writeFile(filename + '.lock', '', {mode:0o600});
  const old = new Date(Date.now() - 180000);
  await fs.utimes(filename + '.lock', old, old);
  assert.equal(await store.withLock(async () => 'recovered'), 'recovered');
});
