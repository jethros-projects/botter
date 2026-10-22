# Architecture

Botter is SDK-first. The typed public client owns application operations; the
CLI parses arguments, calls that client, and renders results. JavaScript modules
run directly, with declarations for TypeScript. There is no build step.

| Location | Responsibility |
| --- | --- |
| `src/runtime.mjs` | Internal security baseline checked before public SDK and CLI startup |
| `src/index.mjs`, `src/index.d.ts` | Canonical SDK exports and typed application contract |
| `src/sdk.mjs` | Input validation, support policy, orchestration, ownership, and cancellation |
| `src/sdk-errors.mjs` | Stable public error codes and safe messages |
| `src/subscription.mjs` | Bounded async subscriptions, consumed cursors, and cancellation |
| `bin/botter.mjs`, `src/cli-entry.mjs` | Executable entrypoint, diagnostics, and process exits |
| `src/cli.mjs` | Command parsing and presentation; core commands delegate to the SDK |
| `src/commands.mjs` | Command definitions, short help, and topic help |
| `src/api-cli.mjs`, `src/gateway-cli.mjs` | Explicit native API discovery and command adapters |
| `src/client.mjs` | Native Connect transport, framing, and exact uint64 decoding |
| `src/auth.mjs`, `src/keychain.mjs` | Explicit login and refresh, private credential stores, and Keychain access |
| `src/conversations.mjs`, `src/attachments.mjs` | Native transcript, message, and file workflows |
| `src/coordination.mjs`, `src/routines.mjs`, `src/tools.mjs`, `src/features.mjs` | Provider-specific operations |
| `src/gateway.mjs`, `src/connection.mjs` | Computer gateway transport and connection helpers |
| `src/advanced.mjs`, `src/advanced.d.ts` | Explicit lower-level native exports |
| `src/core.mjs`, `src/core.d.ts` | Legacy native import compatibility |
| `src/support.mjs`, `schema/verified-support.json` | Executable operation and request restrictions |
| `src/schema.mjs`, other `schema/` files | Native reference interfaces and normalization |
| `test/`, `test/types/`, `scripts/` | Offline regressions, strict consumers, and package checks |

`createClient()` returns `BotterClient`. Construction and `capabilities()` are
offline and do not read saved credentials. The SDK validates public inputs and
enforces supported request forms before dispatch. Runtime eligibility checks
may require bot discovery. Sends use temporal bots; uploads use single-PUT
storage and downloads use the verified store path, with a 5 MiB limit.

The root API normalizes names such as `botId`, `messages`, and download `output`.
The CLI preserves its established JSON shape, including native `agentId` and
transcript `entries`. Provider-specific commands use native helpers through the
same managed support checks. The explicit advanced and legacy APIs retain
native names, payloads, and lifecycle responsibilities.

Requests accept `signal` and whole-operation `timeoutMs`. A subscription has one
async consumer and a bounded event queue. Its cursor advances when events are
consumed; overflow fails with `RESYNC_REQUIRED`. `close()` ends the client's work
without logging out. Injected transports remain host-owned unless
`ownsTransport: true` is explicit. Writes are never automatically retried.

Offline tests use fake transports, synthetic responses, and temporary files.
Strict NodeNext consumer fixtures check root, advanced, and legacy declarations.
Package checks install the actual tarball into an isolated directory and verify
imports, types, and CLI behavior. TypeScript is a development dependency.

The [opt-in live harness](live-verification.md) is separate: it operates on one
disposable bot, journals exact fixture identifiers privately, and reports
deletion separately from attachment retention. Source schemas and historical
live evidence do not establish that every account can use an operation.
