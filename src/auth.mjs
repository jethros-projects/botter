import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { keychainCommand } from './keychain.mjs';

const API = 'https://api2.cursor.sh';
const CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const KEYCHAIN_SERVICE = 'Grok Bot Bridge';
const MAX_BYTES = 64 * 1024;

function failure(message, code = 'auth_failed', status) {
  return Object.assign(new Error(message), { code, ...(status === undefined ? {} : { status }) });
}
function duration(value, max = 600000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`Timeout must be 1–${max} ms.`);
  return value;
}
function waitForSession(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}
function secret(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value);
}
function session(value) {
  if (!value || !secret(value.accessToken) || !secret(value.refreshToken)) {
    throw failure('The login service returned an invalid session.', 'invalid_auth_response');
  }
  // The native client persists only a positive integer team ID; personal
  // accounts may omit it or return an empty selection.
  const selectedTeamId = Number.isSafeInteger(value.selectedTeamId) && value.selectedTeamId > 0 ? value.selectedTeamId : undefined;
  return { accessToken: value.accessToken, refreshToken: value.refreshToken,
    ...(selectedTeamId === undefined ? {} : { selectedTeamId }) };
}
export function tokenExpiry(token) {
  try {
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch { return null; }
}

/** Verifier stays in this process; only loginUrl is shown to the user. */
export function beginLogin() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const uuid = randomUUID();
  const url = new URL('https://cursor.com/loginDeepControl');
  for (const [key, value] of Object.entries({ challenge, uuid, mode: 'login', redirectTarget: 'cli', supportsSelectedTeamLogin: 'true' })) url.searchParams.set(key, value);
  return { uuid, verifier, loginUrl: url.toString() };
}

async function responseJson(response) {
  // Authentication responses must never be included in an exception or log.
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel(); throw failure('Authentication response was too large.', 'invalid_auth_response');
  }
  let body;
  try { body = await response.text(); }
  catch { throw failure('Could not read the authentication response.', 'auth_network_error'); }
  if (Buffer.byteLength(body) > MAX_BYTES) throw failure('Authentication response was too large.', 'invalid_auth_response');
  try { return JSON.parse(body); }
  catch { throw failure('Authentication returned invalid JSON.', 'invalid_auth_response'); }
}

export async function pollLogin(flow, { fetchImpl = globalThis.fetch, signal,
  timeoutMs = 300000, pollMs = 1000 } = {}) {
  duration(timeoutMs); duration(pollMs, 10000);
  if (!flow || !/^[0-9a-f-]{36}$/i.test(flow.uuid) || !/^[A-Za-z0-9_-]{43}$/.test(flow.verifier)) throw new TypeError('Invalid login flow.');
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const url = new URL('/auth/poll', API);
  url.searchParams.set('uuid', flow.uuid); url.searchParams.set('verifier', flow.verifier);
  let errors = 0, attempt = 0;
  try {
    for (;;) {
      combined.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(url.toString(), { method: 'GET', redirect: 'error',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.any([combined, AbortSignal.timeout(20000)]) });
      } catch {
        combined.throwIfAborted();
        if (++errors >= 3) throw failure('Could not reach the login service. Start a new login to retry.', 'auth_network_error');
      }
      if (response?.ok) return session(await responseJson(response));
      if (response?.status === 403) {
        await response.body?.cancel();
        throw failure('The login was denied by the account policy.', 'auth_denied', 403);
      }
      if (response) {
        await response.body?.cancel();
        if (response.status === 404) errors = 0;
        else if (++errors >= 3) throw failure('The login service could not complete sign-in. Start a new login to retry.', 'auth_poll_failed', response.status);
      }
      await sleep(Math.min(pollMs * 1.2 ** attempt++, 10000), undefined, { signal: combined });
    }
  } catch (error) {
    if (signal?.aborted) throw failure('Login cancelled.', 'auth_cancelled');
    if (timeout.aborted) throw failure('Login timed out. Start a new login when ready.', 'auth_timeout');
    throw error;
  }
}

async function privateFile(filename, { signal } = {}) {
  let handle;
  try {
    signal?.throwIfAborted();
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    signal?.throwIfAborted();
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES || info.mode & 0o077
      || process.getuid && info.uid !== process.getuid()) throw failure('Credential file must be owned by you with mode 0600.', 'auth_storage_error');
    const value = await waitForSession(handle.readFile('utf8'), signal);
    signal?.throwIfAborted(); return value;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') return null;
    if (error.code?.startsWith('auth_')) throw error;
    throw failure('Cannot safely read the credential file.', 'auth_storage_error');
  } finally { await handle?.close(); }
}

async function withFileLock(filename, fn, { signal } = {}) {
  signal?.throwIfAborted();
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  signal?.throwIfAborted();
  const id = randomUUID(), end = Date.now() + 30000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { signal?.throwIfAborted(); await handle.writeFile(JSON.stringify({ id, pid: process.pid })); await handle.close(); }
      catch (error) {
        await handle.close().catch(() => {});
        await fs.unlink(filename).catch(() => {});
        throw error;
      }
      break;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code !== 'EEXIST') throw failure('Cannot lock the credential store.', 'auth_storage_error');
      // Recover only a lock from a dead process after the maximum refresh time.
      try {
        const info = await fs.lstat(filename);
        if (info.isFile() && Date.now() - info.mtimeMs > 120000) {
          const contents = await privateFile(filename, { signal });
          let owner, stale = false;
          try { owner = JSON.parse(contents); } catch { stale = true; }
          if (!owner || typeof owner.id !== 'string' || !Number.isSafeInteger(owner.pid) || owner.pid < 1) stale = true;
          if (!stale) {
            try { process.kill(owner.pid, 0); }
            catch (cause) { if (cause.code === 'ESRCH') stale = true; }
          }
          if (stale) {
            const current = await fs.lstat(filename);
            if (current.ino === info.ino && current.mtimeMs === info.mtimeMs) { await fs.unlink(filename); continue; }
          }
        }
      } catch { signal?.throwIfAborted(); /* A competing process may have released it. */ }
      if (Date.now() >= end) throw failure('The credential store is busy; retry shortly.', 'auth_storage_busy');
      await sleep(100, undefined, { signal });
    }
  }
  try { signal?.throwIfAborted(); return await fn(); }
  finally {
    try { if (JSON.parse(await privateFile(filename)).id === id) await fs.unlink(filename); } catch { /* Preserve another owner's lock. */ }
  }
}

export function createFileCredentialStore(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new TypeError('Credential file path must be absolute.');
  return {
    kind: 'private-file',
    withLock: (fn, options) => withFileLock(`${filename}.lock`, fn, options),
    async read(options = {}) {
      const text = await privateFile(filename, options);
      if (text === null) return null;
      try { return session(JSON.parse(text)); }
      catch { throw failure('The credential file is invalid.', 'auth_storage_error'); }
    },
    async write(value, { signal } = {}) {
      signal?.throwIfAborted();
      const data = JSON.stringify(session(value));
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await privateFile(filename, { signal }); // Refuse unsafe existing destinations.
      signal?.throwIfAborted();
      const temp = `${filename}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try { signal?.throwIfAborted(); await handle.writeFile(data); signal?.throwIfAborted(); await handle.sync(); } finally { await handle.close(); }
        await privateFile(filename, { signal });
        signal?.throwIfAborted();
        await fs.rename(temp, filename);
      } finally { await fs.unlink(temp).catch(() => {}); }
    },
    async clear({ signal } = {}) { await privateFile(filename, { signal }); signal?.throwIfAborted(); await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); },
  };
}

export function createKeychainCredentialStore({ service = KEYCHAIN_SERVICE, spawnImpl } = {}) {
  if (process.platform !== 'darwin') throw new Error('Keychain storage requires macOS.');
  if (!/^[A-Za-z0-9 ._-]{1,80}$/.test(service)) throw new TypeError('Invalid Keychain service name.');
  const lock = path.join(os.tmpdir(), `grok-bridge-${process.getuid()}`, `${createHash('sha256').update(service).digest('hex')}.lock`);
  const read = async ({ signal } = {}) => {
    let value;
    try { value = await keychainCommand(['find-generic-password', '-s', service, '-a', 'session', '-w'], { signal, spawnImpl }); }
    catch (error) {
      signal?.throwIfAborted();
      if (error.exitCode === 44) return null;
      if (error.name === 'TimeoutError') throw error;
      throw failure('Cannot read Botter credentials from macOS Keychain.', 'auth_storage_error');
    }
    try { return session(JSON.parse(Buffer.from(value.trim(), 'base64').toString('utf8'))); }
    catch { throw failure('The Botter Keychain session is invalid.', 'auth_storage_error'); }
  };
  return {
    kind: 'macos-keychain', withLock: (fn, options) => withFileLock(lock, fn, options), read,
    async write(value, { signal } = {}) {
      signal?.throwIfAborted();
      const normalized = session(value), data = Buffer.from(JSON.stringify(normalized)).toString('base64');
      try {
        // Interactive stdin keeps tokens out of process arguments and shell history.
        await keychainCommand(['-i'], { input: `add-generic-password -U -a session -s "${service}" -w ${data}\n`, signal, spawnImpl });
        signal?.throwIfAborted();
        const saved = await read({ signal });
        if (saved?.accessToken !== normalized.accessToken || saved?.refreshToken !== normalized.refreshToken) throw new Error();
      } catch (error) { signal?.throwIfAborted(); if (error.name === 'TimeoutError') throw error; throw failure('Cannot save Botter credentials to macOS Keychain.', 'auth_storage_error'); }
    },
    async clear({ signal } = {}) {
      try { await keychainCommand(['delete-generic-password', '-s', service, '-a', 'session'], { signal, spawnImpl }); }
      catch (error) { signal?.throwIfAborted(); if (error.name === 'TimeoutError') throw error; if (error.exitCode !== 44) throw failure('Cannot remove Botter credentials from Keychain.', 'auth_storage_error'); }
    },
  };
}

export function defaultCredentialStore() {
  const filename = process.env.BOTTER_AUTH_FILE || process.env.GROK_BRIDGE_AUTH_FILE;
  if (filename) return createFileCredentialStore(path.resolve(filename));
  return process.platform === 'darwin' ? createKeychainCredentialStore()
    : createFileCredentialStore(path.join(os.homedir(), '.config/grok-bot-bridge/auth.json'));
}

export function createAuthManager({ store = defaultCredentialStore(), fetchImpl = globalThis.fetch,
  now = Date.now, fallback } = {}) {
  let refreshFlight;
  const locked = (fn, signal) => {
    signal?.throwIfAborted();
    const work = () => { signal?.throwIfAborted(); return fn(); };
    return waitForSession(store.withLock ? store.withLock(work, { signal }) : Promise.resolve().then(work), signal);
  };
  const read = async signal => {
    signal?.throwIfAborted();
    const value = await waitForSession(store.read({ signal }), signal);
    signal?.throwIfAborted(); return value;
  };
  const needsRefresh = value => { const expiry = tokenExpiry(value.accessToken); return expiry === null || expiry - now() <= 300000; };
  async function refresh(force, signal) {
    return locked(async () => {
      signal?.throwIfAborted();
      const value = await read(signal);
      if (!value) throw failure('Sign in with botter login first.', 'auth_required');
      if (!force && !needsRefresh(value)) return { ...value, source: 'bridge' };
      let response;
      try {
        response = await waitForSession(fetchImpl(`${API}/oauth/token`, { method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
          body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: value.refreshToken }) }), signal);
      } catch { signal?.throwIfAborted(); throw failure('Session refresh could not reach the service. Saved credentials were retained.', 'auth_refresh_failed'); }
      let result;
      try { result = await waitForSession(responseJson(response), signal); }
      catch { signal?.throwIfAborted(); throw failure('Session refresh returned an unreadable response. Saved credentials were retained.', 'auth_refresh_failed', response.status); }
      // Status codes alone do not prove revocation: gateways can return 401/403,
      // 429 or 5xx during transient failures. Only explicit provider rejection
      // ends the session, and no provider text or credential enters the error.
      if (result?.shouldLogout === true || result?.error === 'invalid_grant')
        throw failure('The session has ended. Run botter login again.', 'auth_required');
      if (!response.ok)
        throw failure('Session refresh failed. Saved credentials were retained; try again shortly.', 'auth_refresh_failed', response.status);
      let rotated;
      try {
        rotated = session({ accessToken: result?.access_token, refreshToken: result?.refresh_token ?? value.refreshToken,
          ...(value.selectedTeamId === undefined ? {} : { selectedTeamId: value.selectedTeamId }) });
      } catch { throw failure('Session refresh returned an invalid session. Saved credentials were retained.', 'auth_refresh_failed', response.status); }
      signal?.throwIfAborted();
      await waitForSession(store.write(rotated, { signal }), signal);
      signal?.throwIfAborted();
      return { ...rotated, source: 'bridge' };
    }, signal);
  }
  return {
    store,
    async save(value, { signal } = {}) {
      const normalized = session(value);
      return locked(() => store.write(normalized, { signal }), signal);
    },
    async getSession({ forceRefresh = false, signal } = {}) {
      signal?.throwIfAborted();
      const value = await read(signal);
      if (!value) {
        if (fallback && !forceRefresh) {
          const accessToken = await waitForSession(fallback({ signal }), signal);
          signal?.throwIfAborted(); return { accessToken, source: 'app' };
        }
        throw failure('Sign in with botter login first.', 'auth_required');
      }
      if (!forceRefresh && !needsRefresh(value)) return { ...value, source: 'bridge' };
      if (!refreshFlight || refreshFlight.controller.signal.aborted) {
        const flight = { controller: new AbortController(), waiters: 0 };
        flight.promise = refresh(forceRefresh, flight.controller.signal).finally(() => { if (refreshFlight === flight) refreshFlight = undefined; });
        flight.promise.catch(() => {});
        refreshFlight = flight;
      }
      // One client cancelling must not interrupt another window's refresh.
      // Abandon the shared flight only when its final waiter leaves, which also
      // fences persistence if a fetch implementation produces a late response.
      const flight = refreshFlight;
      flight.waiters++;
      try { return await waitForSession(flight.promise, signal); }
      finally { if (--flight.waiters === 0) flight.controller.abort(); }
    },
    async status({ signal } = {}) {
      const value = await read(signal);
      if (!value) return { authenticated: false, source: 'bridge' };
      const expiry = tokenExpiry(value.accessToken);
      return { authenticated: true, source: 'bridge', storage: store.kind,
        expiresAt: expiry === null ? null : new Date(expiry).toISOString(), needsRefresh: needsRefresh(value),
        ...(value.selectedTeamId === undefined ? {} : { selectedTeamId: value.selectedTeamId }) };
    },
    async logout({ signal } = {}) {
      signal?.throwIfAborted();
      return locked(() => { signal?.throwIfAborted(); return store.clear({ signal }); }, signal);
    },
  };
}

let defaultManager;
export function defaultAuthManager({ fallback } = {}) {
  return defaultManager ??= createAuthManager({ fallback });
}
