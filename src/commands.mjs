import { UsageError } from './errors.mjs';
import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const specs = {
  login: { 'no-open': 'b', timeout: 'n' }, 'auth-status': {}, 'auth-refresh': {}, logout: {},
  list: { full: 'b' }, rooms: {}, capabilities: {},
  history: { before: 's', limit: 'n' },
  search: { query: 's', pages: 'n', 'page-size': 'n', before: 's', limit: 'n', since: 's', until: 's' },
  thread: { pages: 'n', 'page-size': 'n', before: 's', gateway: 's', connect: 'b' },
  watch: { duration: 'n' },
  updates: { 'after-updated-seq': 's', 'timeout-ms': 'n', 'max-events': 'n' },
  send: { text: 's', file: 's', wait: 'n', attach: 'r', attachments: 's', 'attachments-file': 's', 'message-id': 's' },
  upload: { 'max-bytes': 'n' },
  download: { out: 's', 'max-bytes': 'n', overwrite: 'b' }, artifacts: { pages: 'n' },
  'artifact-refs': { pages: 'n', 'page-size': 'n', before: 's' },
  handoff: { text: 's', file: 's', 'message-id': 's' },
  'room-create': { members: 's', description: 's', id: 's' }, 'room-members': { members: 's' },
  routines: { 'time-zone': 's' }, 'routine-enable': { 'time-zone': 's' }, 'routine-disable': { 'time-zone': 's' },
  'routine-delete': { 'time-zone': 's' },
  'routine-create': { spec: 's', 'via-bot': 'b', wait: 'n', 'time-zone': 's', 'message-id': 's' },
  'gateway-status': { wake: 'b' }, 'gateway-connect': { out: 's' },
  'webhook-key': { out: 's', 'time-zone': 's' }, 'webhook-fire': { credentials: 's', json: 's', data: 's' },
  tools: { summary: 'b' },
  'tool-call': { args: 's', 'args-file': 's' },
  stop: { reason: 's' }, 'send-status': {}, status: {},
  'bot-create': { json: 's', spec: 's', id: 's', description: 's', title: 's', harness: 's' },
  'bot-update': { json: 's', spec: 's' }, 'bot-delete': {}, 'bot-main': {},
  'mark-read': {}, 'mark-unread': {}, 'bot-state': { json: 's', spec: 's' },
  settings: {}, 'settings-update': { json: 's', spec: 's' },
};

const usage = {
  login: '', 'auth-status': '', 'auth-refresh': '', logout: '', list: '', history: 'BOT',
  search: 'BOT|all', thread: 'BOT ROOT_MESSAGE_ID', watch: 'BOT', updates: 'BOT', send: 'BOT', upload: 'BOT FILE',
  download: 'BOT REMOTE_PATH', artifacts: 'BOT', 'artifact-refs': 'BOT', handoff: 'FROM_BOT TO_BOT', rooms: '',
  'room-create': 'NAME', 'room-members': 'ROOM',
  routines: 'BOT', 'routine-enable': 'BOT ROUTINE_ID', 'routine-disable': 'BOT ROUTINE_ID', 'routine-delete': 'BOT ROUTINE_ID',
  'routine-create': 'BOT',
  'gateway-status': '', 'gateway-connect': '', 'webhook-key': 'BOT ROUTINE_ID', 'webhook-fire': '',
  tools: '', 'tool-call': 'SERVER CATALOG_NAME', capabilities: '',
  stop: 'BOT', 'send-status': 'BOT MESSAGE_ID', status: '[BOT|all]',
  'bot-create': 'NAME', 'bot-update': 'BOT', 'bot-delete': 'BOT', 'bot-main': 'BOT', 'mark-read': 'BOT', 'mark-unread': 'BOT',
  'bot-state': 'BOT', settings: '', 'settings-update': '',
};
const descriptions = {
  "login": "Sign in with your browser",
  "auth-status": "Inspect saved authentication",
  "auth-refresh": "Refresh your saved session",
  "logout": "Remove saved credentials",
  "list": "List your bots",
  "history": "Read recent messages",
  "search": "Search messages",
  "thread": "Read a message and its replies",
  "watch": "Stream new messages",
  "updates": "Read transcript updates",
  "send": "Send a message",
  "upload": "Upload a local file",
  "download": "Save a remote file",
  "artifacts": "List shared files",
  "artifact-refs": "Scan shared file references",
  "handoff": "Send a bot-to-bot message",
  "rooms": "List bot rooms",
  "room-create": "Create a room",
  "room-members": "Replace a room’s bot members",
  "routines": "List a bot’s routines",
  "routine-enable": "Enable a routine",
  "routine-disable": "Disable a routine",
  "routine-delete": "Delete a routine",
  "routine-create": "Ask a bot to create a webhook routine",
  "gateway-status": "Inspect the computer gateway",
  "gateway-connect": "Save a private gateway connection",
  "webhook-key": "Provision and save a private webhook key",
  "webhook-fire": "Trigger a webhook",
  "tools": "List connected tools",
  "tool-call": "Call a connected tool",
  "capabilities": "Inspect supported operations",
  "stop": "Stop a running bot",
  "send-status": "Inspect message delivery",
  "status": "Inspect bot status",
  "bot-create": "Create a bot",
  "bot-update": "Update a bot’s profile",
  "bot-delete": "Delete a bot",
  "bot-main": "Select your primary bot",
  "mark-read": "Mark a bot as read",
  "mark-unread": "Mark a bot as unread",
  "bot-state": "Update notification preferences",
  "settings": "Read account settings",
  "settings-update": "Update pinned bots"
};
const notes = {
  "login": "Uses the official browser sign-in. --timeout is 1–600 seconds (default: 300).",
  "send": "Supply exactly one of --text or --file. --attach is repeatable.\n--attachments/--attachments-file accepts [{\"path\":\"/remote/path\",\"name\":\"file.txt\"}].\n--wait is seconds, up to 3600; a correlated reply may be a progress message.\n--message-id accepts a UUID. Writes are never retried.",
  "handoff": "Supply exactly one of --text or --file. Writes are never retried.",
  "search": "Supply --query. Use all to search every owned bot.",
  "watch": "Streams NDJSON for one bot. --duration is 1–86400 seconds; Ctrl-C stops watching.",
  "updates": "--timeout-ms is milliseconds. --after-updated-seq preserves 64-bit precision.",
  "thread": "--gateway reads a saved descriptor; --connect resolves a gateway and may wake the computer.",
  "upload": "Files are limited to 5 MiB. Uses single-PUT storage; no gateway fallback.",
  "download": "Supply --out. Files are limited to 5 MiB; existing destinations require --overwrite.",
  "room-create": "Supply --members with at least one comma-separated bot name or ID.",
  "room-members": "Supply --members with at least one comma-separated bot name or ID. Replaces the member list.",
  "routine-create": "Supply --spec FILE and --via-bot. Only webhook triggers are supported.\nThe bot receives a creation request; the result is checked in the server catalog.",
  "gateway-connect": "Supply --out. Creates a new mode-0600 file without printing credentials.\nThis explicitly connects to the computer and may wake it.",
  "webhook-key": "Supply --out. Provisions a key and creates a new mode-0600 file without printing it.",
  "webhook-fire": "Supply --credentials FILE. Payload uses --json or --data FILE.",
  "tool-call": "Supply --args JSON or --args-file FILE. Each connected tool has its own permissions and effects.",
  "bot-create": "Only the temporal runtime is supported. --json and --spec FILE are mutually exclusive.",
  "bot-update": "Supply --json or --spec FILE. Only description, title and partialUpdate are supported.",
  "bot-state": "Supply --json or --spec FILE. Fields: notificationsEnabled, notifyOnUpdatesEnabled.",
  "settings-update": "Supply --json or --spec FILE. Only pinnedAgents is supported."
};
const examples = {
  "login": "botter login",
  "list": "botter list",
  "history": "botter history Alpha --limit 20",
  "send": "botter send Alpha --text \"Hello\" --wait 30",
  "search": "botter search all --query \"deployment\"",
  "watch": "botter watch Alpha --duration 60",
  "download": "botter download Alpha /remote/file.txt --out ./file.txt"
};

const optionLabel = (name, kind) => `--${name}${kind === 'b' ? '' : kind === 'n' ? ' NUMBER' : ' VALUE'}${kind === 'r' ? ' (repeatable)' : ''}`;
const synopsis = command => [command, usage[command], ...Object.entries(specs[command]).map(([name, kind]) => `[${optionLabel(name, kind)}]`)].filter(Boolean).join(' ');

export const HELP = `Botter ${VERSION} — your Grok Bot, from the terminal

Usage: botter <command> [options]

Start here:
  login                 Sign in with your browser
  list                  List your bots
  history BOT           Read recent messages
  send BOT --text TEXT  Send a message
  watch BOT             Stream new messages

Explore:
  help COMMAND          Show a command’s options and examples
  help --all            List every command and option
  api --help            Inspect the native backend API
  gateway-api --help    Inspect the computer gateway API

Commands return JSON; watch and API streams return NDJSON.
Use botter --version to print the version.`;

export const FULL_HELP = `Botter ${VERSION} — all commands

Usage: botter <command> [options]

${Object.keys(specs).map(command => `${synopsis(command)}\n  ${descriptions[command]}`).join('\n\n')}

api --help              Native backend RPC methods and schemas
gateway-api --help      Computer gateway methods and schemas

Use botter help COMMAND for details. Commands return JSON; streams return NDJSON.
BOT accepts a name or ID. Writes are never automatically retried.
BOTTER_AUTH_FILE selects private credentials; GROK_BRIDGE_AUTH_FILE remains supported.`;

export function commandHelp(command) {
  if (!Object.hasOwn(specs, command)) throw new UsageError(`Unknown command: ${command}. Use botter help --all.`);
  const options = Object.entries(specs[command]);
  return [`Botter ${VERSION} — ${descriptions[command]}`, '',
    `Usage: botter ${[command, usage[command], options.length ? '[options]' : ''].filter(Boolean).join(' ')}`,
    ...(options.length ? ['', 'Options:', ...options.map(([name, kind]) => `  ${optionLabel(name, kind)}`)] : []),
    ...(notes[command] ? ['', notes[command]] : []),
    ...(examples[command] ? ['', `Example: ${examples[command]}`] : []),
    '', 'Use botter help --all to explore all commands.'].join('\n');
}
