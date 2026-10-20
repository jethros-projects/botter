import { createClient, BotterClient, BotterError, createAuthManager, beginLogin,
  type ClientOptions, type SendInput, type Message, type WatchEvent,
  type Subscription, type ErrorCode } from '@jethros-projects/botter';
import { createClient as createNativeClient, sessionFor } from '@jethros-projects/botter/advanced';
import { createClient as createLegacyClient, history as nativeHistory } from '@jethros-projects/botter/core';
import metadata from '@jethros-projects/botter/package.json' with { type: 'json' };

const options: ClientOptions = { tokenProvider: async () => 'host-controlled-token', maxBufferEvents: 64 };
const client: BotterClient = createClient(options);
const input: SendInput = { botId: 'bot', text: 'Hello', attachments: [{ path: './notes.md', name: 'Notes', mimeType: 'text/markdown' }], wait: false };
const result = await client.send(input, { timeoutMs: 1000 });
const messageId: string = result.messageId;
const messages: Message[] = (await client.history({ botId: 'bot', beforeSeq: '9007199254740999' })).messages;
const stamp: string | null | undefined = messages[0]?.createdAt;
const sub: Subscription<WatchEvent> = await client.watch({ botId: 'bot' });
for await (const event of sub) if (event.type === 'entry') { const text: string | null = event.message.text; void text; }
await sub.cancel(); await sub.done;
const error = new BotterError('Example', { code: 'ABORTED', receipt: { messageId: 'stable-id' } });
const code: ErrorCode = error.code;
const native = createNativeClient(options);
await nativeHistory(native, 'bot', { beforeSeq: '9007199254740999' });
const legacy = createLegacyClient();
const session: string = sessionFor({ viewerSessionId: '' });
const auth = createAuthManager(); const flow = beginLogin();
void [metadata.name, messageId, stamp, code, legacy, session, auth, flow];
// @ts-expect-error A bot target is required.
await client.send({ text: 'Hello' });
// @ts-expect-error Native sequence precision is preserved as decimal strings.
await client.history({ botId: 'bot', beforeSeq: 9007199254740999 });
// @ts-expect-error Text cannot be numeric.
await client.send({ botId: 'bot', text: 123 });
// @ts-expect-error Unsupported native write variants are absent from the managed API.
await client.send({ botId: 'bot', text: 'Hello', isFork: true });
// @ts-expect-error Remote attachment references require an explicit name.
await client.send({ botId: 'bot', text: '', attachments: [{ remotePath: '/store/a' }] });
// @ts-expect-error Request options do not silently accept native options.
await client.history({ botId: 'bot' }, { service: 'GrokBotService' });
// @ts-expect-error The root does not expose arbitrary protocol RPCs.
await client.rpc('UnverifiedMethod', {});
await client.download({ botId: 'bot', path: '/store/notes', output: './notes' });
// @ts-expect-error A local output is required.
await client.download({ botId: 'bot', path: '/store/notes' });
await client.close();
