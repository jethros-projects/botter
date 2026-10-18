import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('standalone CLI login, refresh, API use and logout never need the app', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-auth-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, 'fetch.mjs');
  const credentials = path.join(directory, 'auth.json');
  await fs.writeFile(fixture, `
    const token = n => 'header.' + Buffer.from(JSON.stringify({exp:Date.now()/1000+3600,fixture:n})).toString('base64url') + '.fixture';
    globalThis.fetch = async (input, init) => {
      const url = new URL(input);
      if (url.origin !== 'https://api2.cursor.sh') throw Error('Unexpected origin');
      if (url.pathname === '/auth/poll') return Response.json({accessToken:token(1),refreshToken:'fixture-refresh-one',selectedTeamId:12});
      if (url.pathname === '/oauth/token') {
        if (JSON.parse(init.body).refresh_token !== 'fixture-refresh-one') throw Error('Wrong refresh token');
        return Response.json({access_token:token(2),refresh_token:'fixture-refresh-two'});
      }
      if (url.pathname.endsWith('/ListGrokBotAgents')) {
        if (!init.headers.authorization?.startsWith('Bearer header.') || init.headers['x-cursor-team-id'] !== '12') throw Error('Missing managed credentials');
        return Response.json({agents:[{name:'Fixture',agentId:'fixture-id'}]});
      }
      throw Error('Unexpected endpoint');
    };
  `);
  const env = { ...process.env, GROK_BRIDGE_AUTH_FILE: path.join(directory, 'unused-legacy.json'), BOTTER_AUTH_FILE: credentials };
  delete env.GROK_BRIDGE_USE_APP_LOGIN;
  const run = (...args) => promisify(execFile)(process.execPath, ['--import', fixture,
    path.resolve(import.meta.dirname, '../bin/botter.mjs'), ...args], { env });
  assert.equal(JSON.parse((await run('auth-status')).stdout).authenticated, false);
  const login = await run('login', '--no-open');
  assert.match(login.stdout, /"authenticated": true/);
  assert.doesNotMatch(login.stdout, /fixture-refresh/);
  assert.equal((await fs.stat(credentials)).mode & 0o777, 0o600);
  await run('auth-refresh');
  assert.equal(JSON.parse(await fs.readFile(credentials)).refreshToken, 'fixture-refresh-two');
  assert.equal(JSON.parse((await run('list')).stdout)[0].name, 'Fixture');
  await run('logout');
  assert.equal(JSON.parse((await run('auth-status')).stdout).authenticated, false);
  await assert.rejects(run('list'), error => /auth_required/.test(error.stderr));
});
