/** Compatibility entrypoint. New applications should use @jethros-projects/botter. */
export {
  createClient, sessionFor, createAuthManager, beginLogin, pollLogin,
  history, sendMessage, watchBots, readTranscriptUpdates, listRoutines,
  uploadAttachment, downloadAttachment,
} from './advanced.js';
