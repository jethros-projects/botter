import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listApiMethods, getSchema } from '../src/schema.mjs';
import { gatewayMethods } from '../src/gateway.mjs';
import { runApiCli } from '../src/api-cli.mjs';
import { runGatewayCli } from '../src/gateway-cli.mjs';
import { main, specs } from '../src/cli.mjs';
import { getVerifiedSupport, apiMethodSupport, gatewayMethodSupport } from '../src/support.mjs';

// A packaging check, not a substitute for live tests. Each reference operation
// must be explicitly enabled or fail before files, credentials or network.
const support = getVerifiedSupport();
const offline = new Proxy({}, { get() { throw new Error('Unexpected network or credential access'); } });
let blockedBackend = 0, blockedGateway = 0;
for (const method of listApiMethods()) {
  if (apiMethodSupport(method).supported) continue;
  await assert.rejects(runApiCli(['api', `${method.serviceName}.${method.name}`, '--json-file', '/__not_read__'], offline),
    error => error.code === 'operation_not_live_verified');
  blockedBackend++;
}
for (const method of gatewayMethods) {
  if (gatewayMethodSupport(method).supported) continue;
  await assert.rejects(runGatewayCli(['gateway-api', method, '--gateway', '/__not_read__'], offline),
    error => error.code === 'operation_not_live_verified');
  blockedGateway++;
}
for (const command of ['public-api', 'relay', 'task-done', 'skill-add', 'routine-update', 'routine-run', 'resource', 'outline']) {
  await assert.rejects(main([command], offline));
}
assert.deepEqual(Object.keys(specs).sort(), support.commands.map(entry => entry.name).sort());
let apiList, gatewayList;
await runApiCli(['api', 'list'], offline, { print: value => { apiList = value; } });
await runGatewayCli(['gateway-api', 'list'], offline, { print: value => { gatewayList = value; } });
assert.equal(apiList.length, support.backend.length);
assert.equal(gatewayList.count, support.gateway.length);
assert.ok(apiList.every(method => method.supported === true));
const schema = getSchema();
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
console.log(JSON.stringify({
  cliVersion: pkg.version,
  verifiedAt: support.verifiedAt,
  reference: { backend: listApiMethods().length, gateway: gatewayMethods.length, messages: Object.keys(schema.messages).length, enums: Object.keys(schema.enums).length },
  enabled: { backend: support.backend.length, gateway: support.gateway.length, convenienceCommands: support.commands.length },
  blockedBeforeCredentialsOrNetwork: { backend: blockedBackend, gateway: blockedGateway },
  passed: true,
  verification: 'Offline allowlist enforcement. Live evidence is recorded separately; no claim that the full reference API works.',
}, null, 2));
