import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../src/core.mjs';
import * as legacy from '../src/advanced.mjs';

const exports = ['beginLogin', 'createAuthManager', 'createClient', 'downloadAttachment',
  'history', 'listRoutines', 'pollLogin', 'readTranscriptUpdates', 'sendMessage',
  'sessionFor', 'uploadAttachment', 'watchBots'];

test('shared runtime exposes existing implementations without wrappers or removed legacy exports', () => {
  assert.deepEqual(Object.keys(core).sort(), exports);
  for (const name of exports) {
    assert.equal(typeof core[name], 'function', name);
    assert.equal(core[name], legacy[name], name);
  }
  for (const name of ['connectGateway', 'createRoutine', 'validateRoutineSpec', 'getSchema', 'searchHistory']) {
    assert.equal(typeof legacy[name], 'function', `legacy ${name}`);
  }
});

test('shared runtime dependency graph contains no CLI or process entrypoint', () => {
  const pending = [new URL('../src/core.mjs', import.meta.url)], seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file.href)) continue;
    seen.add(file.href);
    assert.ok(!/(?:^|\/)(?:[^/]*-)?cli(?:-[^/]*)?\.mjs$/.test(file.pathname), file.pathname);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.\.?\/[^'"]+\.mjs)['"]/g)) {
      pending.push(new URL(match[1], file));
    }
  }
  assert.ok(seen.size > 5, 'followed runtime dependencies');
});
