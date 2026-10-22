import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertSupportedNode } from '../src/runtime.mjs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const policy = '^22.23.4 || ^24.22.1 || ^26.12.1';
const valid = ['22.23.4', '22.23.5', '22.24.0', '24.22.1', '24.22.2', '24.23.0', '26.12.1', '26.12.2', '26.13.0'];
const invalid = ['18.20.8', '20.20.0', '21.7.3', '22.0.0', '22.23.3', '23.11.1', '24.0.0', '24.21.99', '24.22.0', '25.0.0', '25.99.99', '26.0.0', '26.11.99', '26.12.0', '27.0.0', '28.0.0', '99.0.0', '24.22.1\n', '24.22.1\r\n', '24.22.1-rc.1', '24.22.1+custom', 'v24.22.1', '024.22.1', '24.22', '24.999999999999999999999.1', '24.22.999999999999999999999', '24.22.1\nprivate-value', '', null, 24];
const unsupported = error => {
  assert.equal(error.code, 'UNSUPPORTED_NODE_VERSION');
  assert.match(error.message, /22\.23\.4\+, 24\.22\.1\+, or 26\.12\.1\+/);
  assert.match(error.message, /Upgrade Node\.js: https:\/\/nodejs\.org\/en\/download/);
  return true;
};

test('runtime policy permits patched supported lines and rejects vulnerable, EOL and unreviewed versions', () => {
  assert.equal(packageJson.engines.node, policy);
  for (const version of valid) assert.doesNotThrow(() => assertSupportedNode(version), version);
  for (const version of invalid) assert.throws(() => assertSupportedNode(version), unsupported, String(version));
  assert.throws(() => assertSupportedNode('24.22.1\nprivate-value'), error => {
    assert.match(error.message, /Found Node\.js unknown\./);
    assert(!error.message.includes('private-value'));
    return true;
  });
});

function child(version, arguments_) {
  // Simulate only the reported version; never emulate vulnerable TLS or codecs.
  // Public filesystem/network/process hooks also make an early I/O regression fail.
  const preload = `
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    Object.defineProperty(process.versions, 'node', {value: ${JSON.stringify(version)}});
    const blocked = () => { throw new Error('Unexpected credential, network or subprocess access.'); };
    const schema = ${JSON.stringify(new URL('../schema/', import.meta.url).href)};
    const metadata = ${JSON.stringify(new URL('../package.json', import.meta.url).href)};
    const readFileSync = fs.readFileSync;
    fs.readFileSync = (file, ...options) => (String(file).endsWith('.mjs') || String(file).startsWith(schema) || String(file) === metadata) ? readFileSync(file, ...options) : blocked();
    childProcess.execFileSync = blocked;
    childProcess.spawn = blocked;
    globalThis.fetch = blocked;
    syncBuiltinESMExports();
  `;
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, ...arguments_], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '' },
  });
}

test('patched release floors permit offline SDK construction and CLI discovery', () => {
  const entryUrl = new URL('../src/index.mjs', import.meta.url).href;
  const cli = new URL('../bin/botter.mjs', import.meta.url);
  const script = `const {createClient} = await import(${JSON.stringify(entryUrl)}); const client = createClient(); console.log(JSON.stringify(client.capabilities())); await client.close();`;
  for (const version of ['22.23.4', '24.22.1', '26.12.1']) {
    const sdk = child(version, ['--input-type=module', '-e', script]);
    assert.equal(sdk.status, 0, sdk.stderr);
    assert.equal(sdk.stderr, '');
    assert.equal(JSON.parse(sdk.stdout).send, true);
    const help = child(version, [cli.pathname, '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stderr, '');
    assert.match(help.stdout, /Usage: botter/);
  }
});

for (const entry of ['index', 'advanced', 'core']) {
  test(`${entry} SDK entrypoint rejects vulnerable Node before reading credentials or networking`, () => {
    const entryUrl = new URL(`../src/${entry}.mjs`, import.meta.url).href;
    const script = `try { await import(${JSON.stringify(entryUrl)}); process.exitCode = 99; } catch (error) { console.log(JSON.stringify({code:error.code,message:error.message})); }`;
    for (const version of ['22.23.3', '24.22.0', '26.12.0', '25.0.0', '28.0.0']) {
      const result = child(version, ['--input-type=module', '-e', script]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      unsupported(JSON.parse(result.stdout));
    }
  });
}

test('unsupported CLI fails concisely before command discovery, credentials or networking', () => {
  const cli = new URL('../bin/botter.mjs', import.meta.url);
  for (const version of ['22.23.3', '24.22.0', '26.12.0', '25.0.0', '28.0.0']) {
    for (const argument of ['--help', '--version', 'auth-status']) {
      const result = child(version, [cli.pathname, argument]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      const error = JSON.parse(result.stderr);
      assert.deepEqual(Object.keys(error).sort(), ['code', 'error']);
      unsupported({ code: error.code, message: error.error });
      assert(!/\n\s+at |file:\/\/|\/(?:Users|home)\//.test(result.stderr));
    }
  }
});
