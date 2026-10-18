# botter

A small, scriptable CLI for Grok Bot: read conversations, send messages, manage bots, and work with files and routines.

Botter is an unofficial client for Cursor's native Grok Bot APIs. It uses internal interfaces whose availability and permissions are controlled by the service. An account with access to Grok Bot is required.

## Install from source

Requires Node.js 22 or newer. From this checkout:

```sh
npm ci
npm link
botter --version
botter --help
```

The package is named `botter-cli`. These instructions install the local source; they do not assume a published npm release. To run without linking, use `node bin/botter.mjs` in place of `botter`.

## Start here

```sh
botter login
botter auth-status
botter list
botter history BOT --limit 20
botter search BOT --query 'release notes'
```

Replace `BOT` with the bot identifier returned by `list`. Commands produce JSON; `watch` and API streams produce newline-delimited JSON, one event per line. `--version` (or `-v`) prints the version. Exit status is 0 for success, 1 for an operation failure or required transcript resync, and 2 for invalid usage. Errors are JSON on stderr.

Sending a message changes the conversation and can start work on the bot:

```sh
botter send BOT --text 'Summarize the release notes' --wait 30
```

`watch` streams until Ctrl-C; `--duration` limits it to 1–86400 seconds. If `watch` emits `resyncRequired` or `cursorTooOld`, or `updates` returns `resyncRequired: true`, it exits with status 1. Reload `history` and start a fresh watch or update cursor; the old checkpoint cannot safely continue.

`--wait` waits for a reply correlated to this message. That reply may be a progress update; it does not mean all background work has finished. Writes are never automatically retried.

## Find a command

```sh
botter --help
botter help --all
botter help send
botter history --help
botter api --help
botter gateway-api --help
```

The default help covers everyday tasks. `help --all` shows the complete command and flag reference. Every command accepts `--help` without signing in or making a request.

| Task | Commands |
| --- | --- |
| Sign in | `login`, `auth-status`, `auth-refresh`, `logout` |
| Read conversations | `list`, `history`, `search`, `thread`, `watch`, `updates` |
| Send and follow work | `send`, `send-status`, `status`, `stop`, `handoff` |
| Work with files | `upload`, `download`, `artifacts`, `artifact-refs` |
| Manage bots and rooms | `bot-create`, `bot-update`, `bot-delete`, `bot-main`, `rooms`, `room-create`, `room-members` |
| Manage routines | `routines`, `routine-create`, `routine-enable`, `routine-disable`, `routine-delete` |
| Inspect integrations | `tools`, `capabilities`, `gateway-status` |

For example, `upload` writes a file to a bot, while `download` writes a local file and requires an explicit destination:

```sh
botter upload BOT ./notes.txt
botter download BOT /remote/path/notes.txt --out ./downloaded-notes.txt
```

File transfers support verified storage paths up to 5 MiB. Uploads use a single PUT; downloads refuse to overwrite an existing file unless you pass `--overwrite`.

## Authentication

`botter login` uses the provider's browser sign-in flow. On macOS, botter stores its session in Keychain. Other platforms use a private file at `~/.config/grok-bot-bridge/auth.json`.

Set `BOTTER_AUTH_FILE` to choose a credential file. The older `GROK_BRIDGE_AUTH_FILE` variable remains supported; `BOTTER_AUTH_FILE` takes precedence when both are set. Credential files must be owned by you and private to your user. Existing Keychain storage and the native macOS login adapter retain their original identifiers for compatibility.

`auth-status` reports session metadata without printing credentials. `logout` removes botter's stored session. Keep credential files, webhook keys, account output, and downloaded private content out of source control.

## API access

The native backend and computer gateway have a larger reference schema than the executable CLI supports. Inspect them offline:

```sh
botter api list
botter api schema GrokBotService.ListGrokBotAgents
botter gateway-api list
```

Only operations enabled by the [support manifest](schema/verified-support.json) can execute. Unsupported operations fail before reading request files, credentials, or the network. A method appearing in a reference schema does not make it supported.

See [API coverage](API-COVERAGE.md) for the supported scope and its restrictions.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
```

The checks run offline regression tests, validate the support manifest, and install the actual package tarball in an isolated temporary directory. They do not sign in, verify current account permissions, or mutate live resources.

See [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md). Licensed under [MIT](LICENSE).
