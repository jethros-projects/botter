import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.mjs';

test('interrupting login verification aborts the probe before credentials are saved', async t => {
  const originalFetch = globalThis.fetch, originalLog = console.log;
  const listeners = process.listenerCount('SIGINT');
  let resolveProbe, probeSignal, saves = 0;
  const probing = new Promise(resolve => { resolveProbe = resolve; });
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
  console.log = () => {};
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.pathname === '/auth/poll') return Response.json({ accessToken: token, refreshToken: 'fixture-refresh' });
    assert(url.pathname.endsWith('/ListGrokBotAgents'));
    probeSignal = options.signal; resolveProbe();
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  t.after(() => { globalThis.fetch = originalFetch; console.log = originalLog; });
  const raw = { authManager: { save: async () => { saves++; }, status: async () => ({ authenticated: true }) } };
  const login = main(['login', '--no-open'], raw);
  const rejection = assert.rejects(login, { name: 'AbortError' });
  await probing; process.emit('SIGINT'); await rejection;
  assert.equal(probeSignal.aborted, true); assert.equal(saves, 0);
  assert.equal(process.listenerCount('SIGINT'), listeners);
});
