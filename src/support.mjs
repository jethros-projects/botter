import { readFileSync } from 'node:fs';
import { listApiMethods, resolveApiMethod } from './schema.mjs';
import { getGatewayMethodSchema } from './gateway.mjs';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
let loaded;

/** The executable CLI surface is narrower than the reference schema. This
 * bundled manifest is generated only from successful live verification. */
function support() {
  if (loaded) return loaded;
  let manifest;
  try { manifest = JSON.parse(readFileSync(new URL('../schema/verified-support.json', import.meta.url), 'utf8')); }
  catch { throw new Error('The bundled live-verification support manifest is missing or invalid. API execution is disabled.'); }
  if (manifest.version !== 1 || !Array.isArray(manifest.backend) || !Array.isArray(manifest.gateway)
    || !Array.isArray(manifest.commands) || typeof manifest.verifiedAt !== 'string')
    throw new Error('Invalid live-verification support manifest. API execution is disabled.');
  const backend = new Map(), gateway = new Map(), commands = new Map();
  const metadata = entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.evidence !== 'string' || !entry.evidence.trim()
      || typeof entry.scope !== 'string' || !Array.isArray(entry.restrictions)
      || entry.restrictions.some(value => typeof value !== 'string')) throw new Error('Invalid verification evidence in support manifest.');
  };
  for (const entry of manifest.backend) {
    metadata(entry);
    const method = resolveApiMethod(`${entry.service}.${entry.method}`);
    const key = `${method.service}/${method.name}`;
    if (entry.id !== key || backend.has(key)) throw new Error('Invalid or duplicate backend operation in support manifest.');
    const fields = new Set(method.inputFields.map(field => field.jsonName));
    for (const option of ['allowedRequestFields', 'requiredRequestFields', 'nonEmptyArrayFields']) {
      if (entry[option] !== undefined && (!Array.isArray(entry[option])
        || entry[option].some(field => !fields.has(field)) || new Set(entry[option]).size !== entry[option].length))
        throw new Error(`Invalid ${option} in support manifest.`);
    }
    if (entry.allowedFieldValues !== undefined && (!entry.allowedFieldValues || typeof entry.allowedFieldValues !== 'object'
      || Array.isArray(entry.allowedFieldValues) || Object.entries(entry.allowedFieldValues).some(([field, values]) =>
        !fields.has(field) || !Array.isArray(values) || !values.length))) throw new Error('Invalid allowedFieldValues in support manifest.');
    for (const option of ['minIntegerFields', 'maxIntegerFields']) {
      if (entry[option] !== undefined && (!entry[option] || typeof entry[option] !== 'object'
        || Array.isArray(entry[option]) || Object.entries(entry[option]).some(([field, boundary]) =>
          !fields.has(field) || !/^-?\d+$/.test(String(boundary))))) throw new Error(`Invalid ${option} in support manifest.`);
    }
    if (entry.mutuallyExclusiveTrueFields !== undefined && (!Array.isArray(entry.mutuallyExclusiveTrueFields)
      || entry.mutuallyExclusiveTrueFields.some(group => !Array.isArray(group) || group.length < 2
        || group.some(field => !fields.has(field))))) throw new Error('Invalid mutuallyExclusiveTrueFields in support manifest.');
    backend.set(key, entry);
  }
  for (const entry of manifest.gateway) {
    metadata(entry); getGatewayMethodSchema(entry.method);
    if (entry.id !== `gateway/${entry.method}` || gateway.has(entry.method)) throw new Error('Invalid or duplicate gateway operation in support manifest.');
    gateway.set(entry.method, entry);
  }
  for (const entry of manifest.commands) {
    metadata(entry);
    if (typeof entry.name !== 'string' || !entry.name || entry.id !== `cli/${entry.name}` || commands.has(entry.name))
      throw new Error('Invalid or duplicate CLI command in support manifest.');
    commands.set(entry.name, entry);
  }
  loaded = { manifest: freeze(manifest), backend, gateway, commands };
  return loaded;
}

export function getVerifiedSupport() { return support().manifest; }

function describe(entry) {
  return entry ? { supported: true, verification: entry }
    : { supported: false, reason: support().manifest.removedReason || 'This operation has not passed live verification and is unavailable in the CLI.' };
}
function requireSupported(description, operation) {
  if (!description.supported) {
    const error = new Error(`${operation} is not enabled: ${description.reason} Use schema inspection for reference.`);
    error.name = 'UnsupportedOperationError'; error.code = 'operation_not_live_verified'; error.operation = operation;
    throw error;
  }
  return description;
}

export function apiMethodSupport(method) {
  const descriptor = typeof method === 'string' ? resolveApiMethod(method) : method;
  return describe(support().backend.get(`${descriptor.service}/${descriptor.name}`));
}
export function assertApiMethodSupported(method) {
  const descriptor = typeof method === 'string' ? resolveApiMethod(method) : method;
  return requireSupported(apiMethodSupport(descriptor), `${descriptor.serviceName}.${descriptor.name}`);
}
export function supportedApiMethods(options = {}) {
  return listApiMethods(options).filter(method => apiMethodSupport(method).supported);
}

/** Enforce the request shapes/modes that have positive live proof. Call only
 * after ProtoJSON validation so aliases cannot bypass a canonical field rule. */
export function assertApiRequestSupported(method, input) {
  const descriptor = typeof method === 'string' ? resolveApiMethod(method) : method;
  const { verification } = assertApiMethodSupported(descriptor);
  const reject = detail => {
    const error = new Error(`${descriptor.serviceName}.${descriptor.name}: ${detail} This request shape has not passed live verification.`);
    error.name = 'UnsupportedOperationError'; error.code = 'request_not_live_verified';
    error.operation = `${descriptor.serviceName}.${descriptor.name}`;
    throw error;
  };
  if (verification.allowedRequestFields) {
    for (const field of Object.keys(input)) if (!verification.allowedRequestFields.includes(field)) reject(`field ${field} is not enabled.`);
  }
  for (const field of verification.requiredRequestFields ?? []) {
    if (!Object.hasOwn(input, field) || input[field] === null) reject(`field ${field} is required.`);
  }
  for (const [field, values] of Object.entries(verification.allowedFieldValues ?? {})) {
    if (Object.hasOwn(input, field) && !values.some(value => Object.is(value, input[field]))) reject(`the supplied value for ${field} is not enabled.`);
  }
  for (const field of verification.nonEmptyArrayFields ?? []) {
    if (!Array.isArray(input[field]) || !input[field].length) reject(`field ${field} must contain at least one value.`);
  }
  for (const [field, maximum] of Object.entries(verification.maxIntegerFields ?? {})) {
    if (Object.hasOwn(input, field) && input[field] !== null && BigInt(input[field]) > BigInt(maximum))
      reject(`field ${field} exceeds its verified maximum of ${maximum}.`);
  }
  for (const [field, minimum] of Object.entries(verification.minIntegerFields ?? {})) {
    if (Object.hasOwn(input, field) && input[field] !== null && BigInt(input[field]) < BigInt(minimum))
      reject(`field ${field} is below its verified minimum of ${minimum}.`);
  }
  for (const group of verification.mutuallyExclusiveTrueFields ?? []) {
    if (group.filter(field => input[field] === true).length > 1) reject(`fields ${group.join(', ')} cannot be true together.`);
  }
  return input;
}

export function gatewayMethodSupport(method) {
  getGatewayMethodSchema(method);
  return describe(support().gateway.get(method));
}
export function assertGatewayMethodSupported(method) {
  return requireSupported(gatewayMethodSupport(method), `gateway/${method}`);
}
export function supportedGatewayMethods() { return [...support().gateway.keys()]; }

export function commandSupport(name) { return describe(support().commands.get(name)); }
export function assertCommandSupported(name) { return requireSupported(commandSupport(name), `cli/${name}`); }
