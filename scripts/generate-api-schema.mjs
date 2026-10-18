#!/usr/bin/env node
// Regenerate the checked-in catalogs from a read-only, freshly extracted audit.
// Usage: node scripts/generate-api-schema.mjs /path/to/api-audit
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const auditDir = process.argv[2];
if (!auditDir) throw new Error('Provide the api-audit directory containing the extracted inventories.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => JSON.parse(fs.readFileSync(path.join(auditDir, name), 'utf8'));
const write = (name, data) => fs.writeFileSync(path.join(root, 'schema', name), `${JSON.stringify(data, null, 2)}\n`);
const source = read('api-inventory.json');
const kebab = name => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
const services = source.services.map(service => ({
  ...service,
  methods: service.methods.map(method => ({
    ...method,
    service: service.typeName,
    serviceName: service.exportName,
    alias: kebab(method.name),
    aliases: [...new Set([method.name, method.jsName, kebab(method.name)])],
  })),
}));
const provenance = {
  observedAt: source.generatedAt,
  source: 'Installed Grok Bot desktop application; bundled protobuf descriptors extracted without live API mutation.',
  appVersion: source.version,
  asarSha256: source.asarSha256,
  protoSha256: source.protoSha256,
  bundledFile: 'dist/electron-main/proto.cjs',
  limitation: 'Client-declared methods and schemas do not prove server availability, permissions, or entitlement.',
};
write('api-schema.json', { schemaVersion: 1, provenance, services, messages: source.messages, enums: source.enums });
const gateway = read('gateway-methods.json');
write('gateway-methods.json', { ...gateway, source: 'Grok Bot.app/Contents/Resources/app.asar:dist/electron-main/main-app.cjs', provenance: { ...provenance, bundledFile: 'dist/electron-main/main-app.cjs', transport: 'Client constructs POST {baseUrl}/api/{method}; server implementation is not included in the application.' } });
const web = read('web-relay-inventory.json');
const requests = read('web-relay-request-methods.json');
const clientMethods = [...new Set(requests.map(entry => entry.method))];
write('web-relay.json', { ...web, schemaVersion: 1, methods: web.methods, clientMethods, requestMethods: clientMethods, requestEvidence: requests, provenance: { observedAt: source.generatedAt, page: web.page, sourceUrl: web.sourceUrl, sha256: web.sha256, transport: 'WebSocket /ws/bot/; JSON-RPC 2.0 bot.command carries {agentId,name,args}.', limitation: '123 client-declared allowed command names; account availability is not inferred.' } });
console.log(`Wrote ${services.reduce((n, s) => n + s.methods.length, 0)} service methods, ${Object.keys(source.messages).length} messages, ${Object.keys(source.enums).length} enums, ${gateway.methods.length} gateway methods and ${web.methods.length} web commands.`);
