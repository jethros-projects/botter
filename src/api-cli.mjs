import { UsageError } from './errors.mjs';
import fs from 'node:fs';
import { resolveApiMethod, validateApiRequest, getSchema } from './schema.mjs';
import { apiMethodSupport, assertApiMethodSupported, assertApiRequestSupported, supportedApiMethods } from './support.mjs';

const MAX_INPUT = 16 * 1024 * 1024;
const own = (o, k) => Object.hasOwn(o, k);
const kebab = text => text.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
const emit = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const HELP = `Botter — native backend API

api list [--service SERVICE] [--search TEXT]
api schema SERVICE.METHOD [--recursive]
api SERVICE.METHOD [--json JSON | --json-file FILE|-] [--FIELD VALUE ...]
    [--service SERVICE] [--timeout-ms 30000] [--duration SECONDS]
api call SERVICE.METHOD ...
api stream SERVICE.METHOD ... [--input-ndjson FILE|-]

Only operations listed by api list are executable. The full audited schema is
available as reference through api schema, with each operation's support status.
Supported names accept PascalCase, camelCase and kebab-case aliases.
Only the request fields and modes recorded in each method's verification are enabled.
Fields use their JSON name or --kebab-case name. Strings
are literal; arrays, objects, booleans and numbers use JSON. Integer64 values
can be decimal strings. --json-file - reads standard input. No write is retried.
Server streaming emits NDJSON. Bidirectional methods accept NDJSON request
frames via --input-ndjson (one request object per line) and emit NDJSON replies.
Schema availability does not enable execution or confer server permissions.
Unverified operations are rejected before authentication or network access.`;

function readJSON(value, label) {
  if (Buffer.byteLength(value) > MAX_INPUT) throw new UsageError(`${label} exceeds 16 MiB.`);
  try { return JSON.parse(value); } catch { throw new UsageError(`${label} must contain valid JSON.`); }
}
async function fileJSON(file, signal) {
  const stream = file === '-' ? process.stdin : fs.createReadStream(file, { signal });
  const abort = () => stream.destroy(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const chunks = []; let length = 0;
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_INPUT) throw new UsageError('JSON input exceeds 16 MiB.');
      chunks.push(bytes);
    }
    return readJSON(Buffer.concat(chunks).toString('utf8'), 'JSON input');
  } finally { signal.removeEventListener('abort', abort); if (file !== '-') stream.destroy(); }
}
function parseFlags(args) {
  const out = Object.create(null), positions = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { positions.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { positions.push(arg); continue; }
    const at = arg.indexOf('='), key = arg.slice(2, at < 0 ? undefined : at);
    if (!key || own(out, key)) throw new UsageError(`Invalid or repeated option: --${key}`);
    if (['help', 'recursive'].includes(key)) {
      if (at >= 0) throw new UsageError(`--${key} takes no value.`);
      out[key] = true; continue;
    }
    const value = at >= 0 ? arg.slice(at + 1) : args[++i];
    if (value === undefined || at < 0 && value.startsWith('--')) throw new UsageError(`Missing value for --${key}.`);
    out[key] = value;
  }
  return { flags: out, positions };
}
function integer(value, fallback, max, label) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max)
    throw new UsageError(`${label} must be an integer from 1 to ${max}.`);
  return Number(value);
}
function assertOnly(flags, allowed) {
  for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new UsageError(`Unknown option: --${key}`);
}
function fieldValue(field, value) {
  if (field.repeated || field.kind === 'message' || field.kind === 'map') return readJSON(value, `--${kebab(field.jsonName)}`);
  if (field.kind === 'enum' || field.type === 'string' || field.type === 'bytes') return value;
  if (['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64'].includes(field.type)) return value;
  if (['float', 'double'].includes(field.type) && ['NaN', 'Infinity', '-Infinity'].includes(value)) return value;
  return readJSON(value, `--${kebab(field.jsonName)}`);
}
async function requestBody(method, flags, signal) {
  if (own(flags, 'json') && own(flags, 'json-file')) throw new UsageError('Use --json or --json-file, not both.');
  const body = own(flags, 'json') ? readJSON(flags.json, '--json') : own(flags, 'json-file') ? await fileJSON(flags['json-file'], signal) : {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UsageError('An API request must be a JSON object.');
  const reserved = new Set(['json', 'json-file', 'service', 'timeout-ms', 'duration', 'input-ndjson', 'help']);
  for (const [key, value] of Object.entries(flags)) {
    if (reserved.has(key)) continue;
    const field = method.inputFields.find(f => [f.jsonName, f.protoName, kebab(f.jsonName)].includes(key));
    if (!field) throw new UsageError(`Unknown request field --${key} for ${method.name}; inspect api schema.`);
    if (own(body, field.jsonName) || own(body, field.protoName)) throw new UsageError(`Request field ${field.jsonName} was supplied twice.`);
    body[field.jsonName] = fieldValue(field, value);
  }
  return assertApiRequestSupported(method, validateApiRequest(method, body));
}
function recursiveSchema(method) {
  const schema = getSchema(), messages = {}, enums = {}, queue = [method.inputType, method.outputType];
  while (queue.length) {
    const name = queue.pop();
    if (messages[name] || enums[name]) continue;
    if (schema.enums[name]) { enums[name] = schema.enums[name]; continue; }
    const msg = schema.messages[name];
    if (!msg) continue;
    messages[name] = msg;
    for (const f of msg.fields) if (f.kind === 'message' || f.kind === 'enum') queue.push(f.type);
    else if (f.kind === 'map' && ['message', 'enum'].includes(f.valueKind)) queue.push(f.valueType);
  }
  return { method, messages, enums };
}
async function* frames(file, method, signal) {
  const stream = file === '-' ? process.stdin : fs.createReadStream(file, { signal });
  const abort = () => stream.destroy(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    let lineNo = 0, pending = [], length = 0;
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline;
        length += end - start;
        if (length > MAX_INPUT) throw new UsageError(`NDJSON line ${lineNo + 1} exceeds 16 MiB.`);
        pending.push(bytes.subarray(start, end));
        if (newline < 0) break;
        const line = Buffer.concat(pending, length).toString('utf8');
        lineNo++;
        if (line.trim()) yield assertApiRequestSupported(method, validateApiRequest(method, readJSON(line, `NDJSON line ${lineNo}`)));
        pending = []; length = 0; start = newline + 1;
      }
    }
    if (length) {
      const line = Buffer.concat(pending, length).toString('utf8');
      if (line.trim()) yield assertApiRequestSupported(method, validateApiRequest(method, readJSON(line, `NDJSON line ${lineNo + 1}`)));
    }
  } finally { signal.removeEventListener('abort', abort); if (file !== '-') stream.destroy(); }
}

/** Schema-backed CLI access restricted to successfully live-verified methods. */
export async function runApiCli(argv, client, { print = emit, writeFrame = value => console.log(JSON.stringify(value)) } = {}) {
  if (argv[0] !== 'api') return false;
  const args = argv.slice(1);
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) { print(HELP); return true; }
  const { flags, positions } = parseFlags(args);
  const action = positions.shift();
  if (action === 'list') {
    if (positions.length) throw new UsageError('api list takes no positional arguments.');
    assertOnly(flags, ['service', 'search']);
    print(supportedApiMethods({ service: flags.service, search: flags.search }).map(method => ({ ...method, ...apiMethodSupport(method) }))); return true;
  }
  if (action === 'schema') {
    if (positions.length !== 1) throw new UsageError('Use api schema SERVICE.METHOD.');
    assertOnly(flags, ['service', 'recursive']);
    const method = resolveApiMethod(positions[0], { service: flags.service });
    const described = { ...method, ...apiMethodSupport(method) };
    print(flags.recursive ? recursiveSchema(described) : described); return true;
  }
  const target = ['call', 'stream'].includes(action) ? positions.shift() : action;
  if (!target || positions.length) throw new UsageError('Specify exactly one API method.');
  const method = resolveApiMethod(target, { service: flags.service });
  if (flags.help) { print({ method: { ...method, ...apiMethodSupport(method) }, usage: HELP }); return true; }
  assertApiMethodSupported(method);
  if (action === 'stream' && method.streaming === 'unary') throw new UsageError(`${method.name} is unary; use api call.`);
  if (own(flags, 'input-ndjson') && !flags['input-ndjson']) throw new UsageError('--input-ndjson requires a nonempty file path or -.');
  if (own(flags, 'input-ndjson') && method.streaming !== 'bidirectional' && method.streaming !== 'client') throw new UsageError('--input-ndjson requires a client/bidirectional streaming method.');
  if (own(flags, 'input-ndjson') && Object.keys(flags).some(k => !['service', 'timeout-ms', 'duration', 'input-ndjson'].includes(k))) throw new UsageError('NDJSON streaming cannot also take request fields or --json.');
  const timeoutMs = integer(flags['timeout-ms'], 30000, 3600000, '--timeout-ms');
  const duration = integer(flags.duration, undefined, 86400, '--duration');
  if (duration && method.streaming === 'unary') throw new UsageError('--duration applies only to streaming methods.');
  const controller = new AbortController();
  let interrupted, durationEnded = false;
  const interrupt = signal => { interrupted = signal; controller.abort(); };
  const onSigint = () => interrupt('SIGINT'), onSigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', onSigint); process.once('SIGTERM', onSigterm);
  const timer = duration ? setTimeout(() => { durationEnded = true; controller.abort(); }, duration * 1000) : null;
  try {
    const options = { service: method.serviceName ?? method.service.replace(/^aiserver\.v1\./, ''), timeoutMs, signal: controller.signal };
    if (method.streaming === 'unary') {
      const input = await requestBody(method, flags, controller.signal);
      print(await client.rpc(method.name, input, options));
    }
    else if (method.streaming === 'server') {
      const input = await requestBody(method, flags, controller.signal);
      for await (const response of client.stream(method.name, input, options)) writeFrame(response);
    } else {
      let body;
      if (own(flags, 'input-ndjson')) body = frames(flags['input-ndjson'], method, controller.signal);
      else {
        const input = await requestBody(method, flags, controller.signal);
        body = (async function* () { yield input; })();
      }
      for await (const response of client.duplex(method.name, body, options)) writeFrame(response);
    }
    if (interrupted) controller.signal.throwIfAborted();
  } catch (error) {
    if (interrupted) {
      const cancellation = new Error(`API operation interrupted by ${interrupted}; the request was not retried.`);
      cancellation.name = 'AbortError'; cancellation.code = 'operation_cancelled'; cancellation.signal = interrupted;
      throw cancellation;
    }
    if (!durationEnded) throw error;
  }
  finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    process.removeListener('SIGINT', onSigint); process.removeListener('SIGTERM', onSigterm);
  }
  return true;
}
