import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise the distributable in an isolated global prefix, without credentials.
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const temporary = mkdtempSync(path.join(os.tmpdir(), 'botter-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const execute = (program, args, options = {}) => execFileSync(program, args, {
  cwd: root, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], ...options,
});
try {
  const [packed] = JSON.parse(execute(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]));
  const files = new Set(packed.files.map(file => file.path));
  for (const name of ['package.json', 'bin/botter.mjs', 'src/commands.mjs', 'src/runtime.mjs', 'src/index.d.ts', 'src/advanced.d.ts', 'src/core.d.ts', 'docs/SDK.md', 'docs/security-2026-10.md', 'docs/agents.md', 'docs/live-verification.md', 'docs/releasing.md', 'docs/assets/README.md', 'docs/assets/botter-terminal.jpg', 'scripts/e2e-sdk.mjs', 'schema/verified-support.json', 'README.md', 'AGENTS.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md']) {
    assert(files.has(name), `Missing package file: ${name}`);
  }
  for (const name of files) {
    assert(/^(?:package\.json|README\.md|API-COVERAGE\.md|AGENTS\.md|CONTRIBUTING\.md|SECURITY\.md|LICENSE|routine\.example\.json|docs\/[^/]+\.md|docs\/assets\/(?:README\.md|botter-terminal\.jpg)|scripts\/e2e-sdk\.mjs|(?:bin|src|schema)\/[^/]+\.(?:mjs|json|d\.ts))$/.test(name), `Unexpected package file: ${name}`);
    const bytes = readFileSync(path.join(root, name));
    if (name === 'docs/assets/botter-terminal.jpg') {
      assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff', 'Terminal image must be JPEG');
    } else {
      assert(!/\/(?:Users|home)\//.test(bytes.toString('utf8')), `Private machine path in ${name}`);
    }
  }
  assert(packed.files.find(file => file.path === 'bin/botter.mjs').mode & 0o111, 'CLI must be executable');
  const prefix = path.join(temporary, 'install');
  execute(npm, ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, packed.filename)]);
  const installed = process.platform === 'win32' ? path.join(prefix, 'node_modules', pkg.name) : path.join(prefix, 'lib/node_modules', pkg.name);
  const entry = path.join(installed, 'bin/botter.mjs');
  const env = { ...process.env, BOTTER_AUTH_FILE: path.join(temporary, 'no-credentials.json'), BOTTER_USE_APP_LOGIN: '0', GROK_BRIDGE_USE_APP_LOGIN: '0' };
  const run = args => execute(process.execPath, [entry, ...args], { cwd: temporary, env });
  assert.equal(run(['--version']).trim(), pkg.version);
  assert.equal(run(['-v']).trim(), pkg.version);
  assert.throws(() => run(['unknown-command']), error => {
    assert.equal(error.status, 2);
    assert.equal(error.stdout, '');
    assert.equal(JSON.parse(error.stderr).code, 'usage_error');
    return true;
  });
  if (process.platform !== 'win32') {
    assert.equal(execute(path.join(prefix, 'bin/botter'), ['--version'], { cwd: temporary, env }).trim(), pkg.version);
  }
  assert.match(run(['--help']), /Usage: botter/);
  assert.match(run(['help', '--all']), /routine-create BOT/);
  assert.equal(run(['--help-all']), run(['help', '--all']));
  assert.match(run(['send', '--help']), /--attachments-file/);
  assert.match(run(['api', '--help']), /^Botter/);
  assert.match(run(['gateway-api', '--help']), /^Botter/);
  assert(JSON.parse(run(['api', 'list'])).length > 0);
  assert(JSON.parse(run(['gateway-api', 'list'])).count > 0);
  assert.equal(JSON.parse(run(['auth-status'])).authenticated, false);
  assert.equal(run(['help', 'send']), run(['send', '--help']));
  const imported = execute(process.execPath, ['--input-type=module', '-e', `import {createClient} from ${JSON.stringify(path.join(installed, 'src/index.mjs'))}; if(typeof createClient !== 'function') process.exit(1);`], { cwd: temporary, env });
  assert.equal(imported, '');
  console.log(`Package verified: ${files.size} files; isolated install, imports, help, discovery and unauthenticated status passed.`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
