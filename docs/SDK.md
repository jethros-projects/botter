# Botter SDK

`@jethros-projects/botter` contains the SDK and the `botter` executable. The SDK is the application boundary: it owns validation, supported-operation checks, file transfer policy, normalized errors, cancellation, and subscriptions. The CLI calls this same API.

Use **Node.js 22.23.4+, 24.22.1+, or 26.12.1+ within those release lines, and ESM**. The SDK rejects unsupported Node.js versions at import with `UNSUPPORTED_NODE_VERSION`, before credentials or network access. Upgrade Node.js itself; see [the security update](security-2026-10.md). TypeScript declarations ship with the package; no transpilation is needed at runtime. TypeScript Node projects should include `@types/node` for the optional native HTTP/2 transport injection type.

For tool-oriented discovery, bounded CLI workflows, and send reconciliation, see the [agent runbook](agents.md).

## Start with a client

Install the preview with `npm install @jethros-projects/botter@next --ignore-scripts`.
Run `botter login` once to use the CLI's saved session. Use `botter list` to choose
a temporal bot, then replace `BOT_ID` with its returned `agentId`:

```ts
import { createClient, type BotterClient } from '@jethros-projects/botter';

const client: BotterClient = createClient();
try {
  const receipt = await client.send({
    botId: 'BOT_ID',
    text: 'Summarize what we are working on.',
  });
  console.log(receipt.messageId, receipt.delivery);
} finally {
  await client.close();
}
```

Importing the package, constructing a client, and calling `capabilities()` make no network requests and do not open a browser or read stored credentials. Authentication happens when an operation needs it.

`botId` selects a provider bot. IDs are the stable choice; an unambiguous bot name also resolves. `sessionId` selects that bot's conversation session; omitting it uses the bot's current viewer session. There is no invented cross-service conversation ID.

Sends use verified temporal bots. Other or unknown runtimes fail with `UNSUPPORTED_OPERATION` before reading attachments or submitting a message; `listBots()` includes the native `harness` metadata. Reply-to, fork, rich-text, and task-ID send variants remain outside the managed API.

## The public API

| Method | Result |
| --- | --- |
| `send({ botId, text, ... }, options?)` | Message receipt with `messageId`, delivery, and optional send status |
| `history({ botId, ... }, options?)` | A history page with normalized `messages` and a native sequence cursor |
| `search({ botId, query, ... }, options?)` | Bounded history search with scan completeness and truncation information |
| `watch({ botId, ... }, options?)` | A cancellable `Subscription<WatchEvent>` |
| `listBots(options?)` | Bots with `botId` identities |
| `upload({ botId, path, ... }, options?)` | A verified single-PUT attachment receipt |
| `download({ botId, path, output, ... }, options?)` | A local file receipt with `output`; refuses overwrite by default |
| `artifacts({ botId, ... }, options?)` | File references observed in the persisted conversation |
| `auth.status(options?)`, `auth.refresh(options?)`, `auth.logout(options?)` | Explicit authentication lifecycle, with metadata-only results |
| `capabilities()` | Offline support and file-transfer restrictions |
| `close()` | Idempotent cleanup of this client's pending work and subscriptions |

Methods accept object inputs. `RequestOptions` contains `signal?: AbortSignal` and `timeoutMs?: number`. Request deadlines cover the operation, including authentication and connection waits; a watch deadline covers its subscription lifetime. The common exported types are `ClientOptions`, `RequestOptions`, `SendInput`, `SendResult`, `HistoryInput`, `HistoryPage`, `WatchInput`, `WatchEvent`, `Subscription`, `Message`, and `Capabilities`.

## Control authentication in the host

Use a token provider when your application already manages credentials:

```ts
import { createClient } from '@jethros-projects/botter';

const client = createClient({
  tokenProvider: async () => {
    const token = process.env.MY_BOT_TOKEN;
    if (!token) throw new Error('Configure the host credential first.');
    return token;
  },
});
```

Or inject an `AuthManager` implementing `getSession()`. Its optional `save()`, `status()`, and `logout()` methods remain host-controlled. The SDK's `client.auth` namespace exposes `status()`, `refresh()`, and `logout()` with request cancellation and normalized errors. It returns session metadata rather than credentials. Refresh or logout fails with `UNSUPPORTED_OPERATION` when the injected authentication dependency cannot perform it.

For the existing credential lifecycle, import `createAuthManager`, `beginLogin`, and `pollLogin` from `@jethros-projects/botter`. The host chooses when to start sign-in and how to display the returned `loginUrl`; the native service uses the official Cursor browser login flow. Keep the login verifier and returned session inside the host process. No constructor starts login. Custom credential stores are available from `@jethros-projects/botter/advanced`.

```ts
import { createClient, createAuthManager } from '@jethros-projects/botter';

const auth = createAuthManager();
const client = createClient({ authManager: auth });
const status = await client.auth.status(); // Metadata only; does not return credentials.
console.log(status.authenticated);
await client.close();              // Cleanup keeps the saved login.
```

Default credential storage remains macOS Keychain or a private file at `~/.config/grok-bot-bridge/auth.json` elsewhere. `BOTTER_AUTH_FILE` overrides the path and takes precedence over legacy `GROK_BRIDGE_AUTH_FILE`. Existing login and native adapter settings remain compatible.

## Send, then choose whether to wait

```ts
const receipt = await client.send({
  botId: 'BOT_ID',
  text: 'Read these notes and suggest three next steps.',
  attachments: ['./notes.txt'],
  wait: true,
  waitTimeoutMs: 30_000,
}, { timeoutMs: 45_000 });

if (receipt.replyPending) console.log('Accepted; a reply is still pending.');
for (const reply of receipt.replies ?? []) console.log(reply.text);
```

`wait` defaults to `false`. With `wait: true`, the SDK waits for a published reply linked to this message; reaching `waitTimeoutMs` returns `replyPending: true`. A reply can be a progress update. Acceptance, status, or a reply does not establish that all background work has finished.

Attachments may be local paths, `{ path, name?, mimeType? }`, or explicit remote references `{ remotePath, name }`. Uploads are limited to **5 MiB and SINGLE_PUT**. Unsupported storage modes fail before attachment bytes are sent. Downloads use verified store reads, require an `output` path, and publish atomically. Use `overwrite: true` only when intentionally replacing a local file. The deprecated `destination` input and result alias remains available; supplying both input names with different values fails validation.

Writes are issued once. If a send fails after dispatch, inspect a `BotterError`'s `receipt` and `deliveryState` before deciding whether to retry. An uncertain outcome can mean the service accepted the message. Supplying a stable UUID as `messageId` helps your application track that request.

## Read exact sequence cursors

```ts
const page = await client.history({ botId: 'BOT_ID', limit: 50 });
for (const message of page.messages) {
  console.log(message.createdAt, message.text, message.streaming);
}

if (page.nextBeforeSeq !== null) {
  const older = await client.history({
    botId: page.botId,
    sessionId: page.sessionId,
    beforeSeq: page.nextBeforeSeq,
    generation: page.generation,
  });
  console.log(older.messages.length);
}
```

`seq`, `updatedSeq`, and sequence cursors are decimal strings so uint64 precision is preserved. Keep the returned `generation` with a cursor. Normalized messages expose `id`, `text`, `role`, `replyToMessageId`, `createdAt`, and `streaming`; absent identity, role, reply, and time information is `null`. `createdAt` is an ISO timestamp; `streaming` describes the native message's visible streaming state. `entry` preserves structured native content. `entries` retains the original decoded transcript rows for advanced consumers.

Search scans a bounded number of history pages. `complete: false` describes an incomplete scan, while `matchesTruncated` describes the result limit. Neither means that the missing history contains no matches. Artifact discovery has separate `complete` and `inspectionComplete` fields; references are evidence from the conversation, not a filesystem inventory or proof that a file still exists.

## Follow changes and cancel cleanly

```ts
import { BotterError } from '@jethros-projects/botter';

const controller = new AbortController();
const subscription = await client.watch({
  botId: 'BOT_ID',
  maxBufferEvents: 256,
}, { signal: controller.signal });

try {
  for await (const event of subscription) {
    if (event.type === 'entry') console.log(event.message.text);
    if (event.type === 'delete') console.log('Deleted', event.entryId);
    if (event.type === 'resyncRequired' || event.type === 'cursorTooOld') {
      // Reload history, then start a fresh watch.
      break;
    }
  }
  await subscription.done;
} catch (error) {
  if (error instanceof BotterError && error.code === 'RESYNC_REQUIRED') {
    console.log('Consumer fell behind; reload history before watching again.');
  } else {
    throw error;
  }
} finally {
  await subscription.cancel();
}
```

A subscription supports one async iterator. `cancel()` is idempotent; leaving a `for await` loop cancels it. Iteration and `done` settle on cancellation, source completion, or error. The queue is bounded: overflow fails with `RESYNC_REQUIRED` instead of silently losing updates. Reconnect notifications are explicit events; terminal resync events require a new history snapshot and watch.

Await each iterator `next()` call before requesting another event; concurrent reads fail with `INVALID_ARGUMENT`. Use a `for await` loop for the usual single-consumer flow.

`subscription.cursor` is a read-only snapshot of the last transcript position yielded to your consumer: `{ botId, sessionId, generation, afterUpdatedSeq }`. It starts undefined and advances on consumed entries, deletes, and clears. Events waiting in the queue are never acknowledged early. The managed watch starts from a fresh snapshot; it does not accept a persisted resume cursor. Native resume controls remain available through the advanced API.

Call `controller.abort()` to stop a subscription from another UI action. `close()` cancels all subscriptions and pending requests, never logs out, and makes future operations fail with `CLOSED`. Injected transports stay caller-owned unless `ownsTransport: true` is explicit.

## Handle typed errors

```ts
import { BotterError, type ErrorCode } from '@jethros-projects/botter';

try {
  await client.history({ botId: 'BOT_ID' }, { timeoutMs: 10_000 });
} catch (error) {
  if (!(error instanceof BotterError)) throw error;
  const code: ErrorCode = error.code;
  console.log(code, error.status, error.requestId);
}
```

Common codes are `INVALID_ARGUMENT`, `AUTH_REQUIRED`, `AUTH_FAILED`, `UNSUPPORTED_OPERATION`, `NETWORK_ERROR`, `TIMEOUT`, `ABORTED`, `CLOSED`, `RESYNC_REQUIRED`, and `OPERATION_FAILED`. Safe provider codes may appear as `nativeCode`. Public error messages do not include authentication secrets or raw provider responses.

## Advanced APIs and migration

Before 0.8, the root was a collection of transport and native helper exports. The root now exports `createClient`, `BotterClient`, `BotterError`, and explicit authentication helpers with their public types. The former `botter-cli` source package is now `@jethros-projects/botter`; the executable remains `botter`. Move previous native helper imports to `@jethros-projects/botter/advanced`:

```ts
// Managed application API.
import { createClient } from '@jethros-projects/botter';

// Explicit native API for provider-specific integrations.
import {
  createClient as createRawClient,
  listRoutines,
  createGatewayClient,
} from '@jethros-projects/botter/advanced';
```

`@jethros-projects/botter/core` preserves its legacy exports and its raw `createClient` behavior. Native helpers keep their original positional arguments, `agentId` fields, native result payloads, and lifecycle responsibilities. The advanced transport can address native protocol methods outside the managed SDK's verified support. A bundled schema or declaration establishes neither availability nor permission; consult [API coverage](../API-COVERAGE.md) before using an advanced method.

Keep Botter in a Node host: a server, desktop main process, or local bridge. Browser and mobile interfaces call your host API. Do not bundle stored sessions, tokens, or login verifiers into renderers, public web assets, or client logs.
