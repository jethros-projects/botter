import { UsageError } from './errors.mjs';
import { readFileSync } from 'node:fs';
import { connectGateway } from './connection.mjs';
import { createGatewayClient, gatewayCapabilities, gatewayMethods,
  getGatewayMethodSchema, validateGatewayArguments } from './gateway.mjs';
import { assertGatewayMethodSupported, gatewayMethodSupport, supportedGatewayMethods } from './support.mjs';

export const GATEWAY_CLI_HELP = `Botter — computer gateway API

Usage:
  gateway-api list
gateway-api schema METHOD
gateway-api METHOD [--args JSON|--args-file FILE] --gateway FILE|--connect [--timeout MS]

Only methods listed by gateway-api list are executable; each has live verification.
The full discovered schema remains available as reference with support status.
Supported methods use POST /api/METHOD once, without retries.
Arguments default to {} and must be a plain JSON object, at most 8 MiB.
--gateway reads an existing private connection descriptor.
--connect explicitly connects to the account computer and may wake it.
Method declarations are available; unresolved types are validated by the gateway.`;

const VALUE_OPTIONS = new Set(['args', 'args-file', 'gateway', 'timeout']);

function parse(argv) {
  const positionals = [], options = Object.create(null);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') { positionals.push(...argv.slice(index + 1)); break; }
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const equal = token.indexOf('=');
    const name = token.slice(2, equal < 0 ? undefined : equal);
    if (name !== 'connect' && !VALUE_OPTIONS.has(name)) throw new UsageError(`Unknown gateway-api option: --${name}`);
    if (Object.hasOwn(options, name)) throw new UsageError(`Repeated gateway-api option: --${name}`);
    if (name === 'connect') {
      if (equal >= 0) throw new UsageError('--connect does not take a value.');
      options.connect = true;
      continue;
    }
    const value = equal < 0 ? argv[++index] : token.slice(equal + 1);
    if (value === undefined || value.startsWith('--') || !value.length) throw new UsageError(`Missing value for --${name}`);
    options[name] = value;
  }
  return { positionals, options };
}

function readJsonFile(filename, kind) {
  let raw;
  try { raw = readFileSync(filename, 'utf8'); }
  catch { throw new UsageError(`Could not read the ${kind} JSON file.`); }
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new UsageError(`${kind} JSON file exceeds 8 MiB.`);
  try { return JSON.parse(raw); }
  catch { throw new UsageError(`The ${kind} file must contain valid JSON.`); }
}

/** Return false for a command owned by another dispatcher. Offline discovery
 * never opens an account connection; --connect is always explicit.
 */
export async function runGatewayCli(argv, client, { print = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) } = {}) {
  if (argv[0] !== 'gateway-api') return false;
  if (argv.length === 1 || argv.length === 2 && ['help', '--help', '-h'].includes(argv[1])) {
    print(GATEWAY_CLI_HELP);
    return true;
  }
  const { positionals, options } = parse(argv.slice(1));
  const [command] = positionals;
  if (command === 'list') {
    if (positionals.length !== 1 || Object.keys(options).length) throw new UsageError('Use gateway-api list without other arguments.');
    const methods = supportedGatewayMethods();
    print({ methods, count: methods.length, referenceCount: gatewayMethods.length, argumentValidation: gatewayCapabilities.argumentValidation,
      typedArgumentValidation: false, liveVerifiedMethods: methods });
    return true;
  }
  if (command === 'schema') {
    if (positionals.length !== 2 || Object.keys(options).length) throw new UsageError('Use gateway-api schema METHOD without other arguments.');
    print({ ...getGatewayMethodSchema(positionals[1]), ...gatewayMethodSupport(positionals[1]) });
    return true;
  }
  if (positionals.length !== 1) throw new UsageError('Use gateway-api METHOD with JSON arguments and an explicit gateway connection.');
  // Validate the method and complete payload before connecting or waking a box.
  getGatewayMethodSchema(command);
  assertGatewayMethodSupported(command);
  if (Object.hasOwn(options, 'args') && Object.hasOwn(options, 'args-file')) {
    throw new UsageError('Use --args or --args-file, not both.');
  }
  if (Object.hasOwn(options, 'gateway') === Object.hasOwn(options, 'connect')) {
    throw new UsageError('Supply exactly one of --gateway FILE and --connect.');
  }
  let timeoutMs;
  if (options.timeout !== undefined) {
    if (!/^\d+$/.test(options.timeout) || !Number.isSafeInteger(Number(options.timeout))
      || Number(options.timeout) < 1 || Number(options.timeout) > 300_000) {
      throw new UsageError('--timeout must be an integer from 1 to 300000 milliseconds.');
    }
    timeoutMs = Number(options.timeout);
  }
  let args = {};
  if (options['args-file'] !== undefined) args = readJsonFile(options['args-file'], 'arguments');
  else if (options.args !== undefined) {
    if (Buffer.byteLength(options.args) > 8 * 1024 * 1024) throw new UsageError('Gateway request exceeds 8 MiB.');
    try { args = JSON.parse(options.args); }
    catch { throw new UsageError('--args must contain valid JSON.'); }
  }
  validateGatewayArguments(args);
  let gateway;
  if (options.connect) gateway = await connectGateway(client, timeoutMs === undefined ? {} : { timeoutMs });
  else {
    const descriptor = readJsonFile(options.gateway, 'gateway descriptor');
    if (!descriptor || Array.isArray(descriptor) || typeof descriptor !== 'object') {
      throw new UsageError('Gateway descriptor must be a JSON object.');
    }
    gateway = createGatewayClient(descriptor);
  }
  print(await gateway.rpcGateway(command, args, timeoutMs === undefined ? {} : { timeoutMs }));
  return true;
}
