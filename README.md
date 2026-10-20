<h1 align="center">botter</h1>
<p align="center"><strong>Your bot. Your app. Your terminal.</strong></p>
<p align="center">A typed Node.js SDK and CLI for Grok Bot.</p>
<p align="center">
  <a href="https://github.com/jethros-projects/botter/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-314f40?style=flat-square"></a>
  <a href="https://nodejs.org"><img alt="Node.js 22 or newer" src="https://img.shields.io/badge/Node.js-22%2B-314f40?style=flat-square"></a>
  <a href="https://github.com/jethros-projects/botter/blob/main/docs/SDK.md"><img alt="Typed SDK" src="https://img.shields.io/badge/SDK-typed-314f40?style=flat-square"></a>
</p>
<p align="center">
  <a href="https://github.com/jethros-projects/botter/blob/main/docs/SDK.md">SDK</a> ·
  <a href="https://github.com/jethros-projects/botter/blob/main/docs/commands.md">CLI reference</a> ·
  <a href="https://github.com/jethros-projects/botter/blob/main/docs/agents.md">For agents</a> ·
  <a href="https://github.com/jethros-projects/botter/blob/main/CONTRIBUTING.md">Contributing</a>
</p>

[![Botter command overview in a terminal](https://raw.githubusercontent.com/jethros-projects/botter/v0.8.1-next.0/docs/assets/botter-terminal.jpg)](https://github.com/jethros-projects/botter/blob/main/docs/commands.md)
<p align="center"><sub>Actual <code>botter --help</code> output. No account data.</sub></p>

Give your bot a task. Follow the conversation from a script. Build a desktop client, dashboard, or local assistant around the same typed API. One package provides the SDK and the CLI built on it.

### Installation

Requires **Node.js 22+** and an account with **Grok Bot access**. Install the preview from npm:

```sh
npm install --global @jethros-projects/botter@next --ignore-scripts

botter --help
```

For an application, run `npm install @jethros-projects/botter@next --ignore-scripts`. The package is `@jethros-projects/botter`; the command is `botter`. TypeScript declarations are included. No build step.

### Start a conversation

```sh
botter login
botter auth-status
botter list
botter history BOT --limit 10
botter send BOT --text "Review the release checklist and report blockers." --wait 30
```

Replace `BOT` with a temporal bot's `agentId` from `list`; the SDK calls it `botId`. Sign-in opens the official Cursor login flow used by the native service. An existing login can be checked with `botter auth-status`.

### Build your own client

```ts
import { createClient } from '@jethros-projects/botter';

const bot = createClient();

try {
  const botId = 'BOT_ID'; // A temporal bot's ID from await bot.listBots().
  const sent = await bot.send({
    botId,
    text: 'Review the release checklist and report blockers.',
  });
  const page = await bot.history({ botId, limit: 20 });

  console.log(sent.messageId, page.messages);
} finally {
  await bot.close();
}
```

The root SDK covers bot discovery, messages, history, search, watching, uploads, downloads, and artifacts. It provides typed inputs, cancellation, bounded subscriptions, and structured errors. Keep it in a trusted Node host or backend for desktop, browser, and mobile clients. See the [SDK guide](https://github.com/jethros-projects/botter/blob/main/docs/SDK.md) for streaming and credential ownership.

### Messages, files, and automation

```sh
botter send BOT --text "Suggest three next steps from these notes." --attach ./notes.txt --wait 30
botter watch BOT --duration 30
botter search BOT --query "next steps" --pages 2 --limit 10
botter artifacts BOT --pages 2
```

Supply your own `./notes.txt` before running the attachment example. Transfers support files up to **5 MiB**, using single-PUT uploads and verified store downloads. Sends return acceptance by default; a correlated reply can be a progress update. Writes are never automatically retried.

Bot administration, bot rooms, handoffs, routines, connected tools, and native audio have specialist commands or advanced APIs. Start with `botter help --all`, `botter api --help`, or `botter gateway-api --help`. The [support manifest](https://github.com/jethros-projects/botter/blob/main/schema/verified-support.json) defines the executable scope; reference schemas contain additional interfaces that are unavailable through managed operations.

### For agents

Use `botter --help` to discover commands and `botter help COMMAND` for exact arguments. Commands return JSON; watches and API streams return NDJSON. Discover target IDs, bound watches with `--duration`, and keep the message ID when reconciling an uncertain send. The [agent runbook](https://github.com/jethros-projects/botter/blob/main/docs/agents.md) covers file handling, exit codes, and recovery. Repository agents should start with [AGENTS.md](https://github.com/jethros-projects/botter/blob/main/AGENTS.md).

### Access and status

Botter is an **independent, unofficial project** using native Grok Bot interfaces. It is not affiliated with or endorsed by the service providers. Access depends on your account and the upstream service; signing in does not establish that every operation is available.

The `next` channel is a public preview. A prior packed 0.8.1 build passed real-account SDK and CLI checks for messaging, history, search, watching, and file transfers. That evidence applies to the tested build and request forms; it does not certify every advanced operation or the current preview archive. See [API coverage](https://github.com/jethros-projects/botter/blob/main/API-COVERAGE.md), [live verification](https://github.com/jethros-projects/botter/blob/main/docs/live-verification.md), and the [release guide](https://github.com/jethros-projects/botter/blob/main/docs/releasing.md).

### Documentation

| Guide | Start here for |
| --- | --- |
| [SDK](https://github.com/jethros-projects/botter/blob/main/docs/SDK.md) | Typed APIs, subscriptions, authentication, and errors |
| [CLI reference](https://github.com/jethros-projects/botter/blob/main/docs/commands.md) | Commands, flags, and input formats |
| [For agents](https://github.com/jethros-projects/botter/blob/main/docs/agents.md) | Bounded workflows and machine output |
| [API coverage](https://github.com/jethros-projects/botter/blob/main/API-COVERAGE.md) | Supported operations and service restrictions |
| [Architecture](https://github.com/jethros-projects/botter/blob/main/docs/architecture.md) | Module boundaries and implementation map |

### Contributing

```sh
npm ci --ignore-scripts
npm run check
```

Verification runs offline: regressions, support checks, strict types, and a consumer of the packed npm package. Read [Contributing](https://github.com/jethros-projects/botter/blob/main/CONTRIBUTING.md) before opening a pull request and [Security](https://github.com/jethros-projects/botter/blob/main/SECURITY.md) for private reports.

---

[MIT](https://github.com/jethros-projects/botter/blob/main/LICENSE) · Built by [Jethro](https://github.com/jethros-projects) and contributors.
