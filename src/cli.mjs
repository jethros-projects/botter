import { UsageError } from './errors.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as api from './index.mjs';
import * as features from './features.mjs';
import { runApiCli } from './api-cli.mjs';
import { runGatewayCli } from './gateway-cli.mjs';
import { getVerifiedSupport } from './support.mjs';
import { VERSION, HELP, FULL_HELP, commandHelp, specs } from './commands.mjs';

export { HELP, FULL_HELP, commandHelp, specs } from './commands.mjs';


export function parseOptions(args, spec) {
  const options = {}, positionals = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (!token.startsWith('--')) {
      if (token.startsWith('-') && token !== '-') throw new UsageError(`Unknown option: ${token}`);
      positionals.push(token); continue;
    }
    const equal = token.indexOf('='), key = token.slice(2, equal === -1 ? undefined : equal);
    if (!Object.hasOwn(spec, key)) throw new UsageError(`Unknown option: --${key}`);
    const type = spec[key];
    if (type !== 'r' && Object.hasOwn(options, key)) throw new UsageError(`Repeated option: --${key}`);
    if (type === 'b') {
      if (equal !== -1) throw new UsageError(`--${key} does not take a value.`);
      options[key] = true; continue;
    }
    const value = equal !== -1 ? token.slice(equal + 1) : args[++i];
    if (value === undefined || equal === -1 && value.startsWith('--')) throw new UsageError(`Missing value for --${key}`);
    if (type === 'n') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new UsageError(`--${key} must be a nonnegative integer.`);
      options[key] = Number(value);
    } else if (type === 'r') (options[key] ??= []).push(value);
    else options[key] = value;
  }
  return { options, positionals };
}
function requestsHelp(args, spec) {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') break;
    if (['--help', '-h'].includes(token)) return true;
    if (token.startsWith('--') && !token.includes('=') && spec[token.slice(2)] && spec[token.slice(2)] !== 'b') i++;
  }
  return false;
}

const print = value => console.log(JSON.stringify(value, null, 2));
function count(args, expected) { if (args.length !== expected) throw new UsageError(`Expected ${expected} positional argument(s). Use --help.`); }
function prompt(o) {
  if ((o.text === undefined) === (o.file === undefined)) throw new UsageError('Use exactly one of --text and --file.');
  return o.file === undefined ? o.text : fs.readFileSync(o.file, 'utf8');
}
function jsonInput(o, inline, file, fallback) {
  if (o[inline] !== undefined && o[file] !== undefined) throw new UsageError(`Use --${inline} or --${file}, not both.`);
  if (o[inline] === undefined && o[file] === undefined) {
    if (fallback !== undefined) return fallback;
    throw new UsageError(`Supply --${inline} or --${file}.`);
  }
  try { return JSON.parse(o[file] === undefined ? o[inline] : fs.readFileSync(o[file], 'utf8')); }
  catch { throw new UsageError('Input must contain valid JSON.'); }
}
async function writePrivateJson(filename, value) {
  const destination = path.resolve(filename);
  const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  let written = false;
  try {
    fs.writeFileSync(fd, `${JSON.stringify(await value())}\n`);
    written = true;
    return { saved: destination, mode: '0600' };
  } finally {
    fs.closeSync(fd);
    if (!written) fs.unlinkSync(destination);
  }
}
function members(value, { allowEmpty = false } = {}) {
  const result = value?.split(',').map(x => x.trim()).filter(Boolean);
  if (!result || !allowEmpty && !result.length) throw new UsageError('Supply --members with comma-separated bot names or IDs.');
  return result;
}
function onlyFields(value, fields, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new UsageError(`${label} must be a JSON object.`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new UsageError(`${label}.${key} is not an exposed, verified field.`);
  return value;
}
function scanOptions(o) {
  return { maxPages: o.pages, pageSize: o['page-size'], beforeSeq: o.before };
}
export function deliveryAccepted(value, kind = 'user') {
  const accepted = kind === 'agent' ? ['DELIVERED_TEMPORAL', 'DELIVERED_BOX', 'DUPLICATE'] : ['ACCEPTED_BOX', 'ACCEPTED_TEMPORAL', 'DUPLICATE'];
  return [1, 2, 3].includes(value) || typeof value === 'string' && accepted.some(name => value === name || value.endsWith(`_${name}`));
}
function userSendFailed(result) {
  const status = result.status?.status;
  return !deliveryAccepted(result.delivery?.delivery) || status === 3 || typeof status === 'string' && /(?:^|_)REJECTED$/.test(status);
}
async function gateway(value, client, connect) {
  if (value && connect) throw new UsageError('Use --gateway or --connect, not both.');
  if (connect) return api.connectGateway(client);
  if (!value) throw new UsageError('Supply --gateway with a descriptor file, or --connect to resolve the live gateway.');
  let descriptor;
  try { descriptor = JSON.parse(fs.readFileSync(value, 'utf8')); }
  catch { throw new UsageError('Could not read the gateway descriptor JSON file.'); }
  return api.createGatewayClient(descriptor);
}

async function openLoginUrl(url) {
  const run = promisify(execFile);
  if (process.platform === 'darwin') return run('/usr/bin/open', [url], { timeout: 10000 });
  if (process.platform === 'win32') return run('rundll32.exe', ['url.dll,FileProtocolHandler', url], { timeout: 10000 });
  return run('xdg-open', [url], { timeout: 10000 });
}

export async function main(argv = process.argv.slice(2), client) {
  const [command, ...rest] = argv;
  if (!command) { console.log(HELP); return; }
  if (command === '--help-all') {
    if (rest.length) throw new UsageError('Use botter --help-all without other arguments.');
    console.log(FULL_HELP); return;
  }
  if (['help', '--help', '-h'].includes(command)) {
    if (!rest.length) { console.log(HELP); return; }
    if (rest.length !== 1) throw new UsageError('Use botter help COMMAND or botter help --all.');
    if (rest[0] === '--all') { console.log(FULL_HELP); return; }
    if (await runApiCli([rest[0], '--help'], undefined)) return;
    if (await runGatewayCli([rest[0], '--help'], undefined)) return;
    console.log(commandHelp(rest[0])); return;
  }
  if (['--version', '-v', '-V'].includes(command)) {
    if (rest.length) throw new UsageError('Use botter --version without other arguments.');
    console.log(VERSION); return;
  }
  if (Object.hasOwn(specs, command) && requestsHelp(rest, specs[command])) {
    console.log(commandHelp(command)); return;
  }
  if (!Object.hasOwn(specs, command) && !['api', 'gateway-api'].includes(command)) {
    throw new UsageError(`Unknown command: ${command}. Use botter help --all.`);
  }
  client ??= api.createClient();
  if (await runApiCli(argv, client)) return;
  if (await runGatewayCli(argv, client)) return;
  const { options: o, positionals: p } = parseOptions(rest, specs[command]);
  switch (command) {
    case 'login': {
      count(p, 0);
      const seconds = o.timeout ?? 300;
      if (seconds < 1 || seconds > 600) throw new UsageError('--timeout must be 1–600 seconds.');
      const manager = client.authManager ?? api.defaultAuthManager();
      const flow = api.beginLogin();
      print({ loginUrl: flow.loginUrl, message: 'Sign in on the official Cursor website. This command waits for completion.' });
      if (!o['no-open']) await openLoginUrl(flow.loginUrl).catch(() => console.error('Open the displayed login URL in your browser.'));
      const controller = new AbortController(), interrupt = () => controller.abort();
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      try {
        const value = await api.pollLogin(flow, { signal: controller.signal, timeoutMs: seconds * 1000 });
        // Verify the fresh session against the bot API before storing it.
        const probe = api.createClient({ authManager: { getSession: async () => value }, version: client.version });
        const bots = await probe.listBots();
        await manager.save(value);
        return print({ ...await manager.status(), bots: bots.length });
      } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
    }
    case 'auth-status': count(p, 0); return print(await (client.authManager ?? api.defaultAuthManager()).status());
    case 'auth-refresh': {
      count(p, 0); const manager = client.authManager ?? api.defaultAuthManager();
      await manager.getSession({ forceRefresh: true }); return print(await manager.status());
    }
    case 'logout': {
      count(p, 0); await (client.authManager ?? api.defaultAuthManager()).logout();
      return print({ authenticated: false, cleared: 'botter-local-session' });
    }
    case 'list': {
      count(p, 0);
      const bots = await client.listBots();
      return print(o.full ? bots : bots.map(b => ({ name: b.name, agentId: b.agentId, id: b.id, kind: b.kind, harness: b.harness })));
    }
    case 'history': count(p, 1); return print(await api.history(client, p[0], { limit: o.limit, beforeSeq: o.before }));
    case 'thread': count(p, 2); return print(await api.readThread(client, p[0], p[1], { ...scanOptions(o),
      gatewayClient: o.gateway || o.connect ? await gateway(o.gateway, client, o.connect) : undefined }));
    case 'search': {
      count(p, 1); const bots = p[0] === 'all' ? await client.listBots() : [await client.resolveBot(p[0])];
      const result = [];
      for (const bot of bots) result.push(await api.searchHistory(client, bot, o.query, { ...scanOptions(o), limit: o.limit, since: o.since, until: o.until }));
      return print(p[0] === 'all' ? result : result[0]);
    }
    case 'watch': {
      count(p, 1);
      if (o.duration !== undefined && (o.duration < 1 || o.duration > 86400)) throw new UsageError('--duration must be 1–86400 seconds.');
      if (p[0] === 'all') throw new UsageError('watch currently supports one explicitly selected bot.');
      const bots = [p[0]];
      const controller = new AbortController(), interrupt = () => controller.abort();
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      const timer = o.duration ? setTimeout(interrupt, o.duration * 1000) : null;
      try {
        for await (const event of api.watchBots(client, bots, { signal: controller.signal })) {
          console.log(JSON.stringify(event));
          if (['resyncRequired', 'cursorTooOld'].includes(event.type)) { process.exitCode = 1; return; }
        }
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
      return;
    }
    case 'updates': {
      count(p, 1);
      const bot = await client.resolveBot(p[0]);
      const generation = (await api.history(client, bot, { limit: 1 })).generation;
      const result = await api.readTranscriptUpdates(client, bot, {
        generation, afterUpdatedSeq: o['after-updated-seq'], timeoutMs: o['timeout-ms'], maxEvents: o['max-events'] });
      if (result.resyncRequired) process.exitCode = 1;
      return print(result);
    }
    case 'send': {
      count(p, 1); const text = prompt(o), messageId = o['message-id'] ?? randomUUID();
      if (o.wait !== undefined && o.wait > 3600) throw new UsageError('--wait cannot exceed 3600 seconds.');
      const attachments = jsonInput(o, 'attachments', 'attachments-file', []);
      if (!Array.isArray(attachments) || attachments.some(a => !a || typeof a.path !== 'string' || !a.path || typeof a.name !== 'string' || !a.name)) throw new UsageError('Attachments must be an array of {path,name} objects.');
      if (!text.trim() && !o.attach?.length && !attachments.length) throw new UsageError('Message is empty.');
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(messageId)) throw new UsageError('--message-id must be a UUID.');
      const bot = await client.resolveBot(p[0]);
      console.error(JSON.stringify({ sending: true, bot: bot.name, messageId }));
      for (const file of o.attach ?? []) { const result = await api.uploadAttachment(client, bot, file, { maxBytes: 5 * 1024 * 1024, allowedModes: ['SINGLE_PUT'] }); attachments.push({ path: result.path, name: result.fileName }); }
      let result = await api.sendMessage(client, bot, text, { messageId, attachments });
      if (userSendFailed(result)) { print(result); process.exitCode = 1; return; }
      if (o.wait) result = await api.waitForReply(client, result, { timeoutMs: o.wait * 1000 });
      return print(result);
    }
    case 'upload': {
      count(p, 2);
      const maxBytes = o['max-bytes'] ?? 5 * 1024 * 1024;
      if (maxBytes > 5 * 1024 * 1024) throw new UsageError('Verified CLI uploads are limited to 5 MiB.');
      return print(await api.uploadAttachment(client, p[0], p[1], { maxBytes, allowedModes: ['SINGLE_PUT'] }));
    }
    case 'download': {
      count(p, 2); if (!o.out) throw new UsageError('Supply --out.');
      const maxBytes = o['max-bytes'] ?? 5 * 1024 * 1024;
      if (maxBytes > 5 * 1024 * 1024) throw new UsageError('Verified CLI downloads are limited to 5 MiB.');
      return print(await api.downloadAttachment(client, p[0], p[1], o.out, { maxBytes, overwrite: o.overwrite, allowedReadOutcomes: ['STORE'] }));
    }
    case 'artifacts': count(p, 1); return print(await api.listArtifactReferences(client, p[0], { maxPages: o.pages }));
    case 'artifact-refs': count(p, 1); return print(await api.listArtifactReferences(client, p[0], scanOptions(o)));
    case 'handoff': {
      count(p, 2); const messageId = o['message-id'] ?? randomUUID();
      console.error(JSON.stringify({ sending: true, from: p[0], to: p[1], messageId }));
      const result = await api.sendBotMessage(client, p[0], p[1], prompt(o), { messageId });
      print(result);
      if (!deliveryAccepted(result.delivery, 'agent')) process.exitCode = 1;
      return;
    }
    case 'rooms': count(p, 0); return print(await api.listRooms(client));
    case 'room-create': count(p, 1); return print(await api.createRoom(client, { name: p[0], members: members(o.members), description: o.description, agentId: o.id }));
    case 'room-members': count(p, 1); return print(await api.setRoomMembers(client, p[0], members(o.members)));
    case 'routines': count(p, 1); return print(await api.listRoutines(client, { bot: p[0], timeZone: o['time-zone'] }));
    case 'routine-enable': case 'routine-disable': count(p, 2); return print(await api.setRoutineEnabled(client, p[0], p[1], command === 'routine-enable', { timeZone: o['time-zone'] }));
    case 'routine-delete': count(p, 2); return print(await api.deleteRoutine(client, p[0], p[1], { timeZone: o['time-zone'] }));
    case 'routine-create': {
      count(p, 1); if (!o.spec) throw new UsageError('Supply --spec with the native routine spec JSON file.');
      if (!o['via-bot']) throw new UsageError('Only verified server creation is exposed. Supply --via-bot.');
      const spec = JSON.parse(fs.readFileSync(o.spec, 'utf8'));
      if (spec?.trigger?.type !== 'webhook') throw new UsageError('Only the verified webhook routine trigger is exposed.');
      return print(await api.requestRoutineCreation(client, p[0], spec, { timeoutMs: o.wait === undefined ? undefined : o.wait * 1000, timeZone: o['time-zone'], messageId: o['message-id'] }));
    }
    case 'gateway-status': count(p, 0); return print(await api.gatewayStatus(client, { wake: o.wake ?? false }));
    case 'gateway-connect': {
      count(p, 0); if (!o.out) throw new UsageError('Supply --out to save the connection securely.');
      return print(await writePrivateJson(o.out, () => api.resolveGatewayDescriptor(client)));
    }
    case 'webhook-key': {
      count(p, 2); if (!o.out) throw new UsageError('Supply --out to save the credential securely.');
      return print(await writePrivateJson(o.out, () => api.getWebhookCredential(client, p[0], p[1], { timeZone: o['time-zone'] })));
    }
    case 'webhook-fire': count(p, 0); if (!o.credentials) throw new UsageError('Supply --credentials.'); return print(await api.fireWebhook({ ...JSON.parse(fs.readFileSync(o.credentials, 'utf8')), payload: jsonInput(o, 'json', 'data', {}) }));
    case 'tools': {
      count(p, 0); const catalog = await api.listTools(client);
      return print(o.summary ? { servers: catalog.servers.map(s => ({ server: s.serverIdentifier, status: s.status, tools: s.tools.length })), totalTools: catalog.servers.reduce((n, s) => n + s.tools.length, 0) } : catalog);
    }
    case 'tool-call': { count(p, 2); const result = await api.callTool(client, p[0], p[1], jsonInput(o, 'args', 'args-file')); print(result); if (result.result && !result.result.success) process.exitCode = 1; return; }
    case 'capabilities': {
      count(p, 0);
      const support = getVerifiedSupport();
      return print({
        serverRuntime: (await client.rpc('GetGrokBotRuntimeCapabilities', {})).capabilities,
        cli: { verifiedAt: support.verifiedAt,
          commands: support.commands.map(entry => entry.name),
          backend: support.backend.map(entry => entry.id),
          gateway: support.gateway.map(entry => entry.method),
          routines: { creation: 'webhook-via-bot', list: 'per-bot', directBoxMutations: false },
          attachments: { maxBytes: 5 * 1024 * 1024, upload: ['SINGLE_PUT'], download: ['STORE'] } },
      });
    }
    case 'stop': count(p, 1); return print(await features.stopRun(client, p[0], { reason: o.reason }));
    case 'send-status': count(p, 2); return print(await features.getSendStatus(client, p[0], p[1]));
    case 'status': if (p.length > 1) throw new UsageError('status takes at most one bot.'); return print(await features.getBotStatuses(client, p[0]));
    case 'bot-create': {
      count(p, 1); const spec = jsonInput(o, 'json', 'spec', {});
      onlyFields(spec, ['name', 'agentId', 'harness', 'description', 'title', 'kickstartRequested', 'introductionSuppressed', 'createIntent', 'createCaller', 'createdAutomatically'], 'Bot spec');
      const harness = o.harness ?? spec.harness ?? 'temporal';
      if (![2, 'temporal', 'TEMPORAL', 'GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL'].includes(harness)) throw new UsageError('Only temporal bot creation is verified and exposed.');
      const fields = { name: p[0], ...(o.id === undefined ? {} : { agentId: o.id }),
        ...(o.description === undefined ? {} : { description: o.description }), ...(o.title === undefined ? {} : { title: o.title }),
        ...(o.harness === undefined && spec.harness !== undefined ? {} : { harness: 'GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL' }) };
      for (const [key, value] of Object.entries(fields)) if (key !== 'harness' && spec[key] !== undefined && spec[key] !== value) throw new UsageError(`Bot spec conflicts with ${key}.`);
      return print(await features.createBot(client, { ...spec, ...fields }));
    }
    case 'bot-update': {
      count(p, 1); const patch = onlyFields(jsonInput(o, 'json', 'spec'), ['description', 'title', 'partialUpdate'], 'Bot update');
      if (patch.partialUpdate === false) throw new UsageError('Only partial bot profile updates are verified.');
      return print(await features.updateBot(client, p[0], patch));
    }
    case 'bot-delete': count(p, 1); return print(await features.deleteBot(client, p[0]));
    case 'bot-main': count(p, 1); return print(await features.setMainBot(client, p[0]));
    case 'mark-read': case 'mark-unread': count(p, 1); return print(await features.setBotClientState(client, p[0], command === 'mark-read' ? { markRead: true } : { markUnread: true }));
    case 'bot-state': count(p, 1); return print(await features.setBotClientState(client, p[0], onlyFields(jsonInput(o, 'json', 'spec'), ['notificationsEnabled', 'notifyOnUpdatesEnabled'], 'Bot state')));
    case 'settings': count(p, 0); return print(await features.getRuntimeSettings(client));
    case 'settings-update': count(p, 0); return print(await features.updateRuntimeSettings(client, onlyFields(jsonInput(o, 'json', 'spec'), ['pinnedAgents'], 'Settings update')));
  }
}
