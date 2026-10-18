import fs from 'node:fs';

const catalog = JSON.parse(fs.readFileSync(new URL('../schema/api-schema.json', import.meta.url), 'utf8'));
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
freeze(catalog);
const methods = Object.freeze(catalog.services.flatMap(service => service.methods));
const normalize = value => String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();
const serviceKey = value => normalize(value).replace(/^aiserverv1/, '').replace(/service$/, '');
const serviceMatches = (method, service) => serviceKey(method.serviceName) === serviceKey(service);
const shortName = method => normalize(method.name);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

export class ApiSchemaError extends TypeError {
  constructor(path, detail) { super(`${path}: ${detail}`); this.name = 'ApiSchemaError'; this.path = path; }
}
const fail = (path, detail) => { throw new ApiSchemaError(path, detail); };

export function getSchema() { return catalog; }

export function listApiMethods({ service, search } = {}) {
  const needle = search == null ? '' : normalize(search);
  return methods.filter(method => (service == null || serviceMatches(method, service))
    && (!needle || normalize(`${method.service} ${method.name} ${method.alias} ${method.inputType} ${method.outputType}`).includes(needle)));
}

export function resolveApiMethod(name, { service } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new ApiSchemaError('method', 'provide an API method name');
  let methodName = name.trim();
  const slash = methodName.lastIndexOf('/');
  const dot = methodName.lastIndexOf('.');
  const split = Math.max(slash, dot);
  if (split >= 0) {
    const qualifiedService = methodName.slice(0, split).replace(/^\//, '');
    if (service != null && serviceKey(service) !== serviceKey(qualifiedService)) throw new ApiSchemaError('method', 'qualified service conflicts with the service option');
    service = qualifiedService;
    methodName = methodName.slice(split + 1);
  }
  const matches = methods.filter(method => shortName(method) === normalize(methodName)
    && (service == null || serviceMatches(method, service)));
  if (!matches.length) throw new ApiSchemaError('method', `unknown API method ${name}${service == null ? '' : ` in ${service}`}`);
  if (matches.length === 1) return matches[0];
  const preferred = matches.find(method => method.serviceName === 'GrokBotService');
  if (preferred) return preferred;
  throw new ApiSchemaError('method', `ambiguous API method ${name}; specify its service`);
}

const int64 = new Set(['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64']);
const unsigned = new Set(['uint64', 'fixed64', 'uint32', 'fixed32']);
const int32 = new Set(['int32', 'uint32', 'sint32', 'fixed32', 'sfixed32']);
const wrappers = {
  'google.protobuf.DoubleValue': 'double', 'google.protobuf.FloatValue': 'float',
  'google.protobuf.Int64Value': 'int64', 'google.protobuf.UInt64Value': 'uint64',
  'google.protobuf.Int32Value': 'int32', 'google.protobuf.UInt32Value': 'uint32',
  'google.protobuf.BoolValue': 'bool', 'google.protobuf.StringValue': 'string', 'google.protobuf.BytesValue': 'bytes',
};

function integer(value, path) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail(path, 'expected a safe integer number or an exact integer string');
    return BigInt(value);
  }
  if (typeof value !== 'string' || value.length > 1000) fail(path, 'expected an integer');
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) fail(path, 'expected an integer');
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) fail(path, 'integer is outside the supported range');
  let digits = match[2] + (match[3] ?? '');
  const shift = exponent - (match[3]?.length ?? 0);
  if (shift < 0) {
    if (-shift >= digits.length) {
      if (/[^0]/.test(digits)) fail(path, 'expected an integer without a fractional part');
      digits = '0';
    } else {
      if (/[^0]/.test(digits.slice(shift))) fail(path, 'expected an integer without a fractional part');
      digits = digits.slice(0, shift);
    }
  } else digits += '0'.repeat(shift);
  return BigInt(`${match[1] === '-' ? '-' : ''}${digits || '0'}`);
}
function scalar(type, value, path) {
  if (int64.has(type) || int32.has(type)) {
    const parsed = integer(value, path), bits = int64.has(type) ? 64n : 32n;
    const min = unsigned.has(type) ? 0n : -(1n << (bits - 1n));
    const max = unsigned.has(type) ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n;
    if (parsed < min || parsed > max) fail(path, `integer is outside ${type} range`);
    return int64.has(type) ? parsed.toString() : Number(parsed);
  }
  if (type === 'double' || type === 'float') {
    if (['NaN', 'Infinity', '-Infinity'].includes(value)) return value;
    const number = typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) fail(path, `expected ${type} number`);
    if (type === 'float' && Math.abs(number) > 3.4028234663852886e38) fail(path, 'number is outside float range');
    return number;
  }
  if (type === 'bool') { if (typeof value !== 'boolean') fail(path, 'expected boolean'); return value; }
  if (type === 'string') { if (typeof value !== 'string') fail(path, 'expected string'); return value; }
  if (type === 'bytes') {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(value) || value.replace(/=+$/, '').length % 4 === 1
      || (value.includes('=') && value.length % 4 !== 0)) fail(path, 'expected a valid base64 or base64url string');
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64');
  }
  fail(path, `unsupported scalar type ${type}`);
}
function enumValue(type, value, path) {
  if (type === 'google.protobuf.NullValue' && value === null) return null;
  const definition = catalog.enums[type];
  if (!definition) fail(path, `missing enum schema ${type}`);
  if (typeof value === 'string') {
    const found = definition.values.find(entry => entry.name === value || entry.localName === value);
    if (found) return found.name;
    if (!/^-?\d+$/.test(value)) fail(path, `unknown ${type} enum name`);
  }
  const number = scalar('int32', value, path);
  return definition.values.find(entry => entry.no === number)?.name ?? number;
}
function fraction(nanos) {
  const significant = nanos.replace(/0+$/, '');
  return significant ? `.${significant.padEnd(Math.ceil(significant.length / 3) * 3, '0')}` : '';
}
function timestamp(value, path) {
  if (typeof value !== 'string') fail(path, 'expected an RFC 3339 timestamp string');
  const match = /^(\d{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?([Zz]|[+-][0-9]{2}:[0-9]{2})$/.exec(value);
  if (!match) fail(path, 'expected an RFC 3339 timestamp with at most nine fractional digits');
  const [, year, month, day, hour, minute, second, nanos = '', zone] = match;
  const y = Number(year), mo = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > days[mo - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) fail(path, 'invalid timestamp date or time');
  const base = new Date(0); base.setUTCFullYear(y, mo - 1, d); base.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  if (!/^[Zz]$/.test(zone)) {
    const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4));
    if (hours > 23 || minutes > 59) fail(path, 'invalid timestamp offset');
    base.setTime(base.getTime() - (zone[0] === '+' ? 1 : -1) * (hours * 60 + minutes) * 60000);
  }
  if (base.getUTCFullYear() < 1 || base.getUTCFullYear() > 9999) fail(path, 'timestamp is outside year 0001–9999');
  return `${base.toISOString().slice(0, 19)}${fraction(nanos.padEnd(9, '0'))}Z`;
}
function duration(value, path) {
  if (typeof value !== 'string') fail(path, 'expected a duration string ending in s');
  const match = /^(-?)(\d+)(?:\.(\d{1,9}))?s$/.exec(value);
  if (!match) fail(path, 'expected a duration string with at most nine fractional digits');
  const seconds = BigInt(match[2]), nanos = (match[3] ?? '').padEnd(9, '0');
  if (seconds > 315576000000n) fail(path, 'duration is outside the protobuf range');
  const negative = match[1] && (seconds !== 0n || /[^0]/.test(nanos));
  return `${negative ? '-' : ''}${seconds}${fraction(nanos)}s`;
}
function enter(value, path, active, operation) {
  if (active.has(value)) fail(path, 'cyclic objects are not JSON');
  active.add(value);
  try { return operation(); } finally { active.delete(value); }
}
function jsonValue(value, path, active) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(path, 'JSON numbers must be finite'); return value; }
  if (Array.isArray(value)) return enter(value, path, active, () => Array.from(value, (entry, index) => jsonValue(entry, `${path}[${index}]`, active)));
  if (!isObject(value)) fail(path, 'expected a JSON value');
  return enter(value, path, active, () => {
    const output = {};
    for (const [key, entry] of Object.entries(value)) put(output, key, jsonValue(entry, `${path}.${key}`, active));
    return output;
  });
}
const fieldIndexes = new Map();
function fieldIndex(definition) {
  if (!fieldIndexes.has(definition.typeName)) {
    const index = new Map();
    for (const field of definition.fields) for (const name of [field.protoName, field.jsonName, field.localName]) index.set(name, field);
    fieldIndexes.set(definition.typeName, index);
  }
  return fieldIndexes.get(definition.typeName);
}
function typed(kind, type, value, path, active) {
  if (kind === 'scalar') return scalar(type, value, path);
  if (kind === 'enum') return enumValue(type, value, path);
  if (kind === 'message') return message(type, value, path, active);
  fail(path, `unsupported field kind ${kind}`);
}
function mapKey(type, value, path) {
  if (type === 'string') return value;
  if (type === 'bool') { if (value !== 'true' && value !== 'false') fail(path, 'expected a true or false map key'); return value; }
  return String(scalar(type, value, path));
}
function fieldValue(field, value, path, active) {
  // ProtoJSON accepts null for any field as an unset value. Keep it explicit
  // instead of silently losing a caller-provided property.
  if (value === null) return null;
  if (field.kind === 'map') {
    if (!isObject(value)) fail(path, 'expected a map object');
    return enter(value, path, active, () => {
      const output = {};
      for (const [key, entry] of Object.entries(value)) {
        const canonicalKey = mapKey(field.keyType, key, `${path}[key]`);
        if (Object.hasOwn(output, canonicalKey)) fail(path, 'duplicate canonical map key');
        if (entry === null && field.valueType !== 'google.protobuf.Value' && field.valueType !== 'google.protobuf.NullValue') fail(`${path}.${key}`, 'null map values are not supported for this type');
        put(output, canonicalKey, typed(field.valueKind, field.valueType, entry, `${path}.${key}`, active));
      }
      return output;
    });
  }
  if (field.repeated) {
    if (!Array.isArray(value)) fail(path, 'expected an array');
    return enter(value, path, active, () => Array.from(value, (entry, index) => {
      if (entry === null && field.type !== 'google.protobuf.Value' && field.type !== 'google.protobuf.NullValue') fail(`${path}[${index}]`, 'null array entries are not supported for this type');
      return typed(field.kind, field.type, entry, `${path}[${index}]`, active);
    }));
  }
  return typed(field.kind, field.type, value, path, active);
}
function message(type, value, path, active) {
  if (type === 'google.protobuf.Value') return jsonValue(value, path, active);
  if (type === 'google.protobuf.Struct') { if (!isObject(value)) fail(path, 'expected a JSON object for Struct'); return jsonValue(value, path, active); }
  if (type === 'google.protobuf.ListValue') { if (!Array.isArray(value)) fail(path, 'expected a JSON array for ListValue'); return jsonValue(value, path, active); }
  if (wrappers[type]) return value === null ? null : scalar(wrappers[type], value, path);
  if (type === 'google.protobuf.Timestamp') return timestamp(value, path);
  if (type === 'google.protobuf.Duration') return duration(value, path);
  if (type === 'google.protobuf.FieldMask') {
    if (typeof value !== 'string' || (value && !value.split(',').every(part => /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(part)))) fail(path, 'expected a comma-separated field mask string');
    return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }
  if (!isObject(value)) fail(path, `expected an object for ${type}`);
  if (type === 'google.protobuf.Any') {
    return enter(value, path, active, () => {
      const typeUrl = value['@type'];
      if (typeof typeUrl !== 'string' || !typeUrl.includes('/')) fail(path, 'Any requires an @type URL');
      const embedded = typeUrl.slice(typeUrl.lastIndexOf('/') + 1);
      if (!catalog.messages[embedded] && !wrappers[embedded] && !['google.protobuf.Any', 'google.protobuf.Timestamp', 'google.protobuf.Duration', 'google.protobuf.FieldMask'].includes(embedded)) fail(path, `unknown Any message type ${embedded}`);
      const native = embedded.startsWith('google.protobuf.') && embedded !== 'google.protobuf.Empty';
      let normalized;
      if (native) {
        if (Object.keys(value).some(key => key !== '@type' && key !== 'value') || !Object.hasOwn(value, 'value')) fail(path, 'well-known Any messages require only @type and value');
        normalized = { value: message(embedded, value.value, `${path}.value`, active) };
      } else {
        const body = {};
        for (const [key, entry] of Object.entries(value)) if (key !== '@type') put(body, key, entry);
        normalized = message(embedded, body, path, active);
      }
      return { '@type': typeUrl, ...normalized };
    });
  }
  const definition = catalog.messages[type];
  if (!definition) fail(path, `missing message schema ${type}`);
  return enter(value, path, active, () => {
    const output = {}, seen = new Set(), oneofs = new Map(), index = fieldIndex(definition);
    for (const [name, entry] of Object.entries(value)) {
      const field = index.get(name);
      if (!field) fail(`${path}.${name}`, `unknown field for ${type}`);
      if (seen.has(field.number)) fail(`${path}.${name}`, 'duplicate field supplied using different aliases');
      seen.add(field.number);
      if (field.oneof && entry !== null) {
        if (oneofs.has(field.oneof)) fail(`${path}.${name}`, `oneof ${field.oneof} conflicts with ${oneofs.get(field.oneof)}`);
        oneofs.set(field.oneof, name);
      }
      put(output, field.jsonName, fieldValue(field, entry, `${path}.${field.jsonName}`, active));
    }
    for (const field of definition.fields) if (field.required && !seen.has(field.number)) fail(`${path}.${field.jsonName}`, 'required field is missing');
    return output;
  });
}

export function validateApiRequest(method, input = {}) {
  const descriptor = typeof method === 'string' ? resolveApiMethod(method) : method;
  if (!descriptor || typeof descriptor.inputType !== 'string') throw new ApiSchemaError('method', 'expected a resolved API method descriptor');
  return message(descriptor.inputType, input, `${descriptor.serviceName ?? descriptor.service ?? 'API'}.${descriptor.name ?? descriptor.inputType}`, new WeakSet());
}
