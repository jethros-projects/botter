# API coverage

Botter exposes an intentionally limited subset of the native backend and computer gateway. The [support manifest](schema/verified-support.json) is the authoritative list of executable methods, commands, scopes, and request restrictions. Reference schemas describe discovered interfaces; they are not a promise of executable support.

```sh
botter capabilities
botter api list
botter api schema GrokBotService.SendGrokBotUserMessage --recursive
botter gateway-api list
```

Unsupported operations fail before credentials, request files, or network access. JSON and named field inputs share schema normalization and support restrictions. Alternate field spellings and numeric enum aliases cannot bypass those restrictions. The implementation preserves 64-bit integer precision and never automatically retries writes.

## Supported scope

The manifest retains these workflows from prior account-specific live verification:

| Area | Scope and constraints |
| --- | --- |
| Conversations | Text and attachment sends, acknowledgements, correlated text/widget replies, persisted history, search, thread reconstruction, updates, live watch, and cancellation of an active run. |
| Files | Upload and download of verified storage paths, up to 5 MiB. Uploads use a single PUT; multipart upload and other server modes are unsupported. Downloads protect existing files unless overwrite is explicitly requested. |
| Bots | Temporal bot creation, profile updates, deletion, primary-bot changes, pinned settings, read/unread state, and notification state. |
| Rooms | Nonempty rooms containing bots. Human membership and empty membership are unsupported. |
| Handoffs | Bot-to-bot handoff with correlated receipt. |
| Routines | Webhook creation through a bot, per-bot listing, enable/disable, deletion, private webhook key files, and webhook execution. Direct box/gateway routine mutations are unsupported. |
| Connected tools | Native MCP catalog and execution transport. Each third-party tool retains its own permissions, inputs, and side effects; the transport check does not certify every tool. |
| Audio | Native transcription, speech generation, and HTTP/2 streaming speech-to-text through the enabled API methods. Prior live checks used synthetic English audio; other languages, voices, and formats are not implied. |

`send --wait` waits for a public reply correlated with the sent message. A progress reply can satisfy that condition before background work finishes. Structured widget and media replies remain available in JSON even when they have no text.

Some methods allow only specific fields. Bot state updates support notification fields, settings updates support `pinnedAgents`, bot creation supports the temporal runtime, and sends support the retained basic request forms. Consult command help and the manifest for exact restrictions.

## Unsupported interfaces

Public REST and the browser relay are unavailable in the executable CLI. Prior authenticated probes did not establish usable access. Offline reference discovery does not enable either transport.

Unverified task/todo and subagent controls, skill/secret/email writes, arbitrary resources, empty outlines, draft/computer actions, and direct box-only routine or upload paths are excluded. No flag bypasses the allowlist. Native gateway pagination or request variants that lack verified traversal remain restricted.

Authentication commands are local infrastructure, separate from feature coverage. Existing credential storage and native macOS authentication compatibility are preserved. The primary SDK and CLI share the executable support policy. Explicitly native transports and helpers remain available from `botter-cli/advanced` and the legacy `botter-cli/core` entrypoint; these raw interfaces do not advertise managed lifecycle or verified support.

## What verification means

```sh
npm test
npm run coverage:api
```

The regression suite uses offline fixtures. The coverage check verifies that unsupported reference methods are blocked before accessing credentials or the network, and that CLI commands and API listings agree with the manifest.

These checks do not make live requests or establish that an account still has access. The manifest's historical live verification establishes only the recorded method, transport, request form, and account context. It does not imply that every field, permission combination, or future service version works. Historical evidence metadata may refer to private local recordings that are not distributed with the package.

When extending support, record the tested scope and enforce its restrictions. Expand the manifest only when the added behavior has meaningful evidence; never infer support from schema size or a successful transport handshake alone.
