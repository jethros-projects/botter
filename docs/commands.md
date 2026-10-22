# CLI reference

The package is `@jethros-projects/botter`; the executable is `botter`.
Use Node.js 22.23.4+, 24.22.1+, or 26.12.1+ within those release lines. Commands return JSON on stdout; watches and API streams
return NDJSON. Diagnostics and JSON errors go to stderr.

## Discover commands

```sh
botter --help
botter help send
botter help --all
botter api --help
botter gateway-api --help
```

Help and API listings work offline. `--help-all` is an alias for `help --all`.
Topic help is the source of exact arguments, flags, units, and restrictions.
There is no universal `--json` flag.

## Authenticate and choose a bot

```sh
botter login
botter auth-status
botter list
botter history BOT --limit 10
```

`login` opens the official Cursor browser flow used by the native service.
`login --no-open` displays the URL without opening it; `--timeout` accepts
1–600 seconds. `auth-refresh` explicitly refreshes a saved session; `logout`
removes Botter's saved credentials. None of the help commands starts login.

Replace `BOT` with the `agentId` returned by `list`, or an unambiguous name.
Sends require a temporal bot. The SDK calls the identifier `botId`; a bot ID and
its conversation `sessionId` select different resources.

## Messages and files

```sh
botter send BOT --text "Review the release checklist." --wait 30
botter history BOT --limit 20
botter search BOT --query "release checklist" --pages 2 --limit 10
botter watch BOT --duration 30
```

`send` requires exactly one of `--text` and `--file`. `--file` reads a local UTF-8
file; `--file -` is a file named `-`, not stdin. `--wait` is seconds, up to 3600.
It waits for a correlated public reply, which may be a progress update.

Provide your own `./notes.txt` before using these examples:

```sh
botter send BOT --text "Suggest next steps from these notes." --attach ./notes.txt --wait 30
botter upload BOT ./notes.txt
botter artifacts BOT --pages 2
botter download BOT /store/PATH_FROM_RESULT --out ./received.txt
```

Use a remote path returned by `upload` or observed by `artifacts`; the example
path is a placeholder. Transfers are limited to 5 MiB. `--attach` is repeatable.
Existing remote files use `--attachments` or `--attachments-file` with entries
shaped as `{ "path": "/store/PATH_FROM_RESULT", "name": "notes.txt" }`.
Downloads refuse overwrite unless `--overwrite` is explicit.

## Command families

| Area | Commands |
| --- | --- |
| Authentication | `login`, `auth-status`, `auth-refresh`, `logout` |
| Discovery | `list`, `capabilities`, `status` |
| Conversations | `send`, `history`, `search`, `thread`, `watch`, `updates`, `send-status`, `stop` |
| Files | `upload`, `download`, `artifacts`, `artifact-refs` |
| Bots and preferences | `bot-create`, `bot-update`, `bot-delete`, `bot-main`, `mark-read`, `mark-unread`, `bot-state`, `settings`, `settings-update` |
| Rooms and handoffs | `rooms`, `room-create`, `room-members`, `handoff` |
| Routines and webhooks | `routines`, `routine-create`, `routine-enable`, `routine-disable`, `routine-delete`, `webhook-key`, `webhook-fire` |
| Tools and gateway | `tools`, `tool-call`, `gateway-status`, `gateway-connect` |
| Native methods | `api`, `gateway-api` |

Read topic help before using administration, routines, tools, or gateway
commands. These operations have their own resource scopes and side effects.
For example, `gateway-connect` can wake the computer; `room-members` replaces
the room's bot member list. Webhook and gateway credentials are saved to new
mode-0600 files instead of printed.

CLI `capabilities` also fetches runtime flags; SDK `client.capabilities()` is
offline. Flags and schema listings do not override the executable
[support manifest](../schema/verified-support.json). See [API coverage](../API-COVERAGE.md)
for restrictions, including unavailable REST and browser-relay interfaces.

## Bounded operation and recovery

Use `--pages` to bound a history scan and `--duration` to bound a watch.
`watch --duration` accepts 1–86400 seconds; Ctrl+C also stops it. Transcript
sequence numbers and cursors are exact decimal strings; do not convert them to
JavaScript numbers. Reload history and restart after a resync event.

Writes are never automatically retried. `send --message-id UUID` supplies a
stable request identifier. Keep the returned `messageId`, inspect
`send-status BOT MESSAGE_ID`, and reconcile history before retrying an uncertain
send. A successful command need not mean the bot's background work is finished.

| Exit | Meaning |
| --- | --- |
| `0` | Command completed successfully |
| `1` | Operation failed, or transcript resync is required |
| `2` | Invalid usage |

See [the agent runbook](agents.md) for a complete read → send → follow workflow,
or [the SDK guide](SDK.md) to build a client without spawning the executable.
