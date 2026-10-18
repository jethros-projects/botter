import test from 'node:test';
import assert from 'node:assert/strict';
import { listApiMethods } from '../src/schema.mjs';
import { gatewayMethods } from '../src/gateway.mjs';
import { getVerifiedSupport, supportedApiMethods, supportedGatewayMethods, apiMethodSupport,
  assertApiMethodSupported, gatewayMethodSupport, assertGatewayMethodSupported, commandSupport } from '../src/support.mjs';

test('executable support comes only from immutable evidence-backed manifest entries', () => {
  const manifest = getVerifiedSupport();
  assert.equal(manifest.version, 1);
  assert.ok(Object.isFrozen(manifest));
  for (const kind of ['backend', 'gateway', 'commands']) {
    assert.ok(Object.isFrozen(manifest[kind]));
    for (const entry of manifest[kind]) {
      assert.ok(Object.isFrozen(entry));
      assert.equal(typeof entry.evidence, 'string');
      assert.ok(entry.evidence.length);
      assert.equal(typeof entry.scope, 'string');
      assert.ok(Object.isFrozen(entry.restrictions));
    }
  }
  assert.equal(supportedApiMethods().length, manifest.backend.length);
  assert.equal(supportedGatewayMethods().length, manifest.gateway.length);
  assert.throws(() => manifest.backend.push({ method: 'AdminDoAnything' }), TypeError);
  assert.equal(commandSupport('not-a-verified-command').supported, false);
});

test('complete discovery is reference data and cannot enable an unverified operation', () => {
  for (const method of listApiMethods()) {
    const status = apiMethodSupport(method);
    if (status.supported) assert.equal(assertApiMethodSupported(method).verification.id, `${method.service}/${method.name}`);
    else {
      assert.equal(typeof status.reason, 'string');
      assert.throws(() => assertApiMethodSupported(method), { code: 'operation_not_live_verified' });
    }
  }
  for (const method of gatewayMethods) {
    if (gatewayMethodSupport(method).supported) assert.equal(assertGatewayMethodSupported(method).verification.method, method);
    else assert.throws(() => assertGatewayMethodSupported(method), { code: 'operation_not_live_verified' });
  }
});
