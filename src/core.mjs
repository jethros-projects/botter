// Shared runtime for clients and integrations. CLI parsing and process startup
// stay in the command adapters; index.mjs retains the complete legacy API.
export { createClient, sessionFor } from './client.mjs';
export { createAuthManager, beginLogin, pollLogin } from './auth.mjs';
export { history, sendMessage, watchBots, readTranscriptUpdates } from './conversations.mjs';
export { listRoutines } from './routines.mjs';
export { uploadAttachment, downloadAttachment } from './attachments.mjs';
