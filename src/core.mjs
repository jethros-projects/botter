// Shared runtime for clients and integrations. CLI parsing and process startup
// stay in command adapters. Retained for integrations written before 0.8;
// new applications should use the primary typed SDK instead.
export { createClient, sessionFor } from './client.mjs';
export { createAuthManager, beginLogin, pollLogin } from './auth.mjs';
export { history, sendMessage, watchBots, readTranscriptUpdates } from './conversations.mjs';
export { listRoutines } from './routines.mjs';
export { uploadAttachment, downloadAttachment } from './attachments.mjs';
