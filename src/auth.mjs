import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

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

async function privateFile(filename) {
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES || info.mode & 0o077
      || process.getuid && info.uid !== process.getuid()) throw failure('Credential file must be owned by you with mode 0600.', 'auth_storage_error');
    return await handle.readFile('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code?.startsWith('auth_')) throw error;
    throw failure('Cannot safely read the credential file.', 'auth_storage_error');
  } finally { await handle?.close(); }
}

async function withFileLock(filename, fn) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const id = randomUUID(), end = Date.now() + 30000;
  for (;;) {
    try {
      const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify({ id, pid: process.pid })); await handle.close(); }
      catch (error) {
        await handle.close().catch(() => {});
        await fs.unlink(filename).catch(() => {});
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw failure('Cannot lock the credential store.', 'auth_storage_error');
      // Recover only a lock from a dead process after the maximum refresh time.
      try {
        const info = await fs.lstat(filename);
        if (info.isFile() && Date.now() - info.mtimeMs > 120000) {
          const contents = await privateFile(filename);
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
      } catch { /* A competing process may have released it. */ }
      if (Date.now() >= end) throw failure('The credential store is busy; retry shortly.', 'auth_storage_busy');
      await sleep(100);
    }
  }
  try { return await fn(); }
  finally {
    try { if (JSON.parse(await privateFile(filename)).id === id) await fs.unlink(filename); } catch { /* Preserve another owner's lock. */ }
  }
}

export function createFileCredentialStore(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new TypeError('Credential file path must be absolute.');
  return {
    kind: 'private-file',
    withLock: fn => withFileLock(`${filename}.lock`, fn),
    async read() {
      const text = await privateFile(filename);
      if (text === null) return null;
      try { return session(JSON.parse(text)); }
      catch { throw failure('The credential file is invalid.', 'auth_storage_error'); }
    },
    async write(value) {
      const data = JSON.stringify(session(value));
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await privateFile(filename); // Refuse unsafe existing destinations.
      const temp = `${filename}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        await privateFile(filename);
        await fs.rename(temp, filename);
      } finally { await fs.unlink(temp).catch(() => {}); }
    },
    async clear() { await privateFile(filename); await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); },
  };
}

export function createKeychainCredentialStore({ service = KEYCHAIN_SERVICE } = {}) {
  if (process.platform !== 'darwin') throw new Error('Keychain storage requires macOS.');
  if (!/^[A-Za-z0-9 ._-]{1,80}$/.test(service)) throw new TypeError('Invalid Keychain service name.');
  const lock = path.join(os.tmpdir(), `grok-bridge-${process.getuid()}`, `${createHash('sha256').update(service).digest('hex')}.lock`);
  const read = async () => {
    let value;
    try { value = execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', 'session', '-w'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) {
      if (error.status === 44) return null;
      throw failure('Cannot read Botter credentials from macOS Keychain.', 'auth_storage_error');
    }
    try { return session(JSON.parse(Buffer.from(value.trim(), 'base64').toString('utf8'))); }
    catch { throw failure('The Botter Keychain session is invalid.', 'auth_storage_error'); }
  };
  return {
    kind: 'macos-keychain', withLock: fn => withFileLock(lock, fn), read,
    async write(value) {
      const normalized = session(value), data = Buffer.from(JSON.stringify(normalized)).toString('base64');
      try {
        // Interactive stdin keeps tokens out of process arguments and shell history.
        execFileSync('/usr/bin/security', ['-i'], { input: `add-generic-password -U -a session -s "${service}" -w ${data}\n`, timeout: 30000, stdio: ['pipe', 'ignore', 'pipe'] });
        const saved = await read();
        if (saved?.accessToken !== normalized.accessToken || saved?.refreshToken !== normalized.refreshToken) throw new Error();
      } catch { throw failure('Cannot save Botter credentials to macOS Keychain.', 'auth_storage_error'); }
    },
    async clear() {
      try { execFileSync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', 'session'], { timeout: 30000, stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch (error) { if (error.status !== 44) throw failure('Cannot remove Botter credentials from Keychain.', 'auth_storage_error'); }
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
  const locked = fn => store.withLock ? store.withLock(fn) : fn();
  const needsRefresh = value => { const expiry = tokenExpiry(value.accessToken); return expiry === null || expiry - now() <= 300000; };
  async function refresh(force) {
    return locked(async () => {
      const value = await store.read();
      if (!value) throw failure('Sign in with botter login first.', 'auth_required');
      if (!force && !needsRefresh(value)) return { ...value, source: 'bridge' };
      let response;
      try {
        response = await fetchImpl(`${API}/oauth/token`, { method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
          body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: value.refreshToken }) });
      } catch { throw failure('Session refresh could not reach the service. Saved credentials were retained.', 'auth_refresh_failed'); }
      let result;
      try { result = await responseJson(response); }
      catch { throw failure('Session refresh returned an unreadable response. Saved credentials were retained.', 'auth_refresh_failed', response.status); }
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
      await store.write(rotated);
      return { ...rotated, source: 'bridge' };
    });
  }
  return {
    store,
    async save(value) { return locked(() => store.write(session(value))); },
    async getSession({ forceRefresh = false } = {}) {
      const value = await store.read();
      if (!value) {
        if (fallback && !forceRefresh) return { accessToken: await fallback(), source: 'app' };
        throw failure('Sign in with botter login first.', 'auth_required');
      }
      if (!forceRefresh && !needsRefresh(value)) return { ...value, source: 'bridge' };
      if (!refreshFlight) refreshFlight = refresh(forceRefresh).finally(() => { refreshFlight = undefined; });
      return refreshFlight;
    },
    async status() {
      const value = await store.read();
      if (!value) return { authenticated: false, source: 'bridge' };
      const expiry = tokenExpiry(value.accessToken);
      return { authenticated: true, source: 'bridge', storage: store.kind,
        expiresAt: expiry === null ? null : new Date(expiry).toISOString(), needsRefresh: needsRefresh(value),
        ...(value.selectedTeamId === undefined ? {} : { selectedTeamId: value.selectedTeamId }) };
    },
    async logout() { return locked(() => store.clear()); },
  };
}

let defaultManager;
export function defaultAuthManager({ fallback } = {}) {
  return defaultManager ??= createAuthManager({ fallback });
}
