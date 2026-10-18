import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { sessionFor, ApiError } from './client.mjs';

const uint = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Sequence numbers outside safe integer range must be decimal strings.');
  const text = String(value ?? '0');
  if (!/^\d+$/.test(text) || BigInt(text) > 18446744073709551615n) throw new Error('Expected a uint64 sequence number.');
  return text;
};
const compare = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const maxSeq = (a, b) => compare(uint(a), uint(b)) >= 0 ? uint(a) : uint(b);
const bounded = (value, fallback, min, max, name) => {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return number;
};

export function entryText(entry) {
  if (typeof entry?.content === 'string') return entry.content;
  if (typeof entry?.message?.content === 'string') return entry.message.content;
  return null;
}
export function decodeEntry(row) {
  let entry = null;
  if (row.body) {
    try { entry = JSON.parse(Buffer.from(row.body, 'base64').toString('utf8')); } catch {}
  }
  return {
    seq: uint(row.seq), updatedSeq: uint(row.updatedSeq ?? row.seq),
    entryId: row.entryId ?? entry?.id ?? null, kind: row.entryKind ?? entry?.kind ?? null,
    text: entryText(entry), timestampMs: entry?.timestampMs ?? null, entry,
    ...(row.bodyOmitted || (!row.body && row.blobHash) ? { bodyUnavailable: true, blobHash: row.blobHash } : {}),
  };
}

export async function listThreads(client, botQuery) {
  const bot = await client.resolveBot(botQuery);
  const result = await client.rpc('ListGrokBotAgentSessions', { agentId: bot.agentId });
  return { bot: bot.name, agentId: bot.agentId, defaultSessionId: sessionFor(bot), sessions: result.sessions ?? [] };
}

export async function history(client, botQuery, { limit = 50, sessionId, beforeSeq, generation, unreadBoundaryMs, signal } = {}) {
  const bot = await client.resolveBot(botQuery);
  bounded(limit, 50, 1, 200, 'limit');
  if (generation !== undefined) bounded(generation, 0, 0, 4294967295, 'generation');
  if (unreadBoundaryMs !== undefined && (typeof unreadBoundaryMs === 'number' && !Number.isSafeInteger(unreadBoundaryMs)
    || !/^-?\d+$/.test(String(unreadBoundaryMs))
    || BigInt(unreadBoundaryMs) < -9223372036854775808n || BigInt(unreadBoundaryMs) > 9223372036854775807n)) {
    throw new TypeError('unreadBoundaryMs must be an int64 value.');
  }
  const result = await client.rpc('ListGrokBotTranscriptEntries', {
    agentId: bot.agentId, sessionId: sessionFor(bot, sessionId), limit,
    ...(beforeSeq === undefined ? {} : { beforeSeq: uint(beforeSeq) }),
    ...(generation === undefined ? {} : { generation }),
    ...(unreadBoundaryMs === undefined ? {} : { unreadBoundaryMs: String(unreadBoundaryMs) }),
  }, { signal });
  const entries = (result.entries ?? []).map(decodeEntry).sort((a, b) => compare(a.seq, b.seq));
  return { bot: bot.name, agentId: bot.agentId, sessionId: sessionFor(bot, sessionId),
    generation: result.generation ?? 0, nextBeforeSeq: entries[0]?.seq ?? null, entries };
}

export async function scanHistory(client, botQuery, { maxPages = 20, pageSize = 100, sessionId, signal,
  beforeSeq: initialBeforeSeq, generation: expectedGeneration, unreadBoundaryMs } = {}) {
  const bot = await client.resolveBot(botQuery);
  bounded(maxPages, 20, 1, 1000, 'maxPages'); bounded(pageSize, 100, 1, 200, 'pageSize');
  let beforeSeq = initialBeforeSeq, generation = expectedGeneration, exhausted = false, pages = 0;
  const all = new Map();
  for (; pages < maxPages; pages++) {
    const page = await history(client, bot, { limit: pageSize, sessionId, beforeSeq, generation, unreadBoundaryMs, signal });
    if (generation !== undefined && generation !== page.generation) throw new Error('Conversation was reset while reading. Retry the scan.');
    generation = page.generation;
    for (const row of page.entries) all.set(row.seq, row);
    if (page.entries.length === 0) { exhausted = true; pages++; break; }
    if (beforeSeq !== undefined && compare(page.nextBeforeSeq, beforeSeq) >= 0) throw new Error('History cursor did not advance.');
    beforeSeq = page.nextBeforeSeq;
  }
  return { bot: bot.name, agentId: bot.agentId, sessionId: sessionFor(bot, sessionId), generation,
    pages, complete: exhausted, nextBeforeSeq: exhausted ? null : beforeSeq,
    entries: [...all.values()].sort((a, b) => compare(a.seq, b.seq)) };
}

function findRoot(entries, rootId) {
  if (!rootId) return undefined;
  const exact = entries.find(row => row.entryId === rootId);
  if (exact) return exact;
  const candidates = entries.filter(row => row.entry?.clientNonce === rootId || row.entry?.batchId === rootId);
  // Attachments precede the user message and share its nonce. The message owns
  // the requestId which links the actual replies and tool branches.
  return candidates.find(row => row.kind === 'message' && row.entry?.role === 'user')
    ?? candidates.find(row => row.kind === 'message') ?? candidates[0];
}
function receiptRoot(entries, receipt) {
  return findRoot(entries, receipt.status?.echoEntryId) ?? findRoot(entries, receipt.messageId);
}
function hasPublishedReply(row) {
  if (row.kind !== 'send-message' || row.bodyUnavailable || !row.entry
    || row.entry.streaming === true || row.entry.isStreaming === true) return false;
  const message = row.entry.message;
  if (message?.streaming === true || message?.isStreaming === true) return false;
  if (typeof row.text === 'string' && row.text.trim()) return true;
  if (!message || typeof message !== 'object' || typeof message.type !== 'string' || message.type === 'text') return false;
  // Native public replies also contain widgets, attachments and media. Preserve
  // their structured body; only require actual payload beyond discriminator/
  // metadata fields. Empty or still-streaming placeholders are not replies.
  const metadata = new Set(['type', 'id', 'streaming', 'isStreaming', 'timestampMs', 'requestId', 'clientNonce', 'batchId', 'channel']);
  const populated = (value, depth = 0) => {
    if (depth > 24 || value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.some(item => populated(item, depth + 1));
    if (typeof value === 'object') return Object.entries(value).some(([key, item]) => !metadata.has(key) && populated(item, depth + 1));
    return false;
  };
  return Object.entries(message).some(([key, value]) => !metadata.has(key) && populated(value));
}
export function selectThread(entries, rootId) {
  const root = findRoot(entries, rootId);
  if (!root) return { found: false, entries: [] };
  const selected = new Set([root.entryId]);
  const requests = new Set(root.entry?.requestId ? [root.entry.requestId] : []);
  const batches = new Set([root.entry?.clientNonce, root.entry?.batchId].filter(Boolean));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of entries) {
      if (selected.has(row.entryId)) continue;
      // Persisted transcript records use replyTo, whereas the send API uses replyToId.
      if (selected.has(row.entry?.replyTo) || (row.entry?.requestId && requests.has(row.entry.requestId))
        || (row.entry?.clientNonce && batches.has(row.entry.clientNonce)) || (row.entry?.batchId && batches.has(row.entry.batchId))) {
        selected.add(row.entryId);
        if (row.entry?.requestId) requests.add(row.entry.requestId);
        if (row.entry?.clientNonce) batches.add(row.entry.clientNonce);
        if (row.entry?.batchId) batches.add(row.entry.batchId);
        changed = true;
      }
    }
  }
  return { found: true, rootEntryId: root.entryId, entries: entries.filter(row => selected.has(row.entryId)) };
}

export async function readThread(client, botQuery, rootId, options = {}) {
  if (typeof rootId !== 'string' || !rootId) throw new Error('Specify a root message ID.');
  if (options.gatewayClient) {
    const bot = await client.resolveBot(botQuery);
    return { bot: bot.name, agentId: bot.agentId, rootId, source: 'gateway',
      thread: await options.gatewayClient.rpcGateway('getAgentThread', { id: bot.agentId, rootId }, { signal: options.signal }) };
  }
  const scan = await scanHistory(client, botQuery, options);
  const thread = selectThread(scan.entries, rootId);
  return { ...scan, ...thread, rootId, complete: scan.complete,
    note: 'Thread reconstructed from persisted replyTo links and request IDs; complete describes the history scan.' };
}

export async function conversationOutline(client, botQuery, { gatewayClient, signal } = {}) {
  if (!gatewayClient) throw new Error('Native conversation outlines require an existing authenticated gateway connection.');
  const bot = await client.resolveBot(botQuery);
  return gatewayClient.rpcGateway('getConversationOutline', { id: bot.agentId }, { signal });
}

export async function searchHistory(client, botQuery, query, { since, until, limit = 100, ...options } = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('Search query cannot be empty.');
  bounded(limit, 100, 1, 10000, 'limit');
  const parseTime = value => {
    if (value === undefined) return undefined;
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error('Invalid search date; use an ISO date or timestamp.');
    return parsed;
  };
  const from = parseTime(since), to = parseTime(until);
  if (from !== undefined && to !== undefined && from > to) throw new Error('since must not be after until.');
  const scan = await scanHistory(client, botQuery, options);
  const matches = scan.entries.filter(row => row.text?.toLocaleLowerCase().includes(query.toLocaleLowerCase())
    && (from === undefined || row.timestampMs !== null && row.timestampMs >= from)
    && (to === undefined || row.timestampMs !== null && row.timestampMs <= to));
  return { ...scan, query, totalMatchesInScan: matches.length, matchesTruncated: matches.length > limit,
    entries: matches.slice(-limit) };
}

export async function sendMessage(client, botQuery, text, { sessionId, messageId = randomUUID(), replyToId,
  isFork = false, richText, attachments = [], taskId, signal } = {}) {
  if (typeof text !== 'string' || (!text.trim() && attachments.length === 0)) throw new Error('Message is empty.');
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(messageId)) throw new Error('messageId must be a UUID.');
  if (replyToId !== undefined && (typeof replyToId !== 'string' || !replyToId)) throw new Error('replyToId must be a nonempty message ID.');
  if (isFork && !replyToId) throw new Error('A fork requires replyToId.');
  if (!Array.isArray(attachments) || attachments.some(a => !a || typeof a.path !== 'string' || !a.path || typeof a.name !== 'string' || !a.name)) throw new Error('Attachments require path and name.');
  const bot = await client.resolveBot(botQuery);
  const session = sessionFor(bot, sessionId);
  const delivery = await client.rpc('SendGrokBotUserMessage', {
    agentId: bot.agentId, sessionId: session, messageId, text, sentAtMs: String(Date.now()),
    source: 'DESKTOP', initiator: 'USER', sendSource: 'CHAT',
    ...(replyToId === undefined ? {} : { replyToId }), ...(isFork ? { isFork } : {}),
    ...(richText === undefined ? {} : { richText }), ...(taskId === undefined ? {} : { taskId }),
    attachmentPaths: attachments.map(a => a.path), attachmentNames: attachments.map(a => a.name),
  }, { signal });
  // If status lookup fails, do not obscure the accepted send or repeat it automatically.
  let status, statusError;
  try { status = await client.rpc('GetGrokBotSendStatus', { agentId: bot.agentId, sessionId: session, messageId }, { signal }); }
  catch (error) { statusError = error.message; }
  return { bot: bot.name, agentId: bot.agentId, sessionId: session, messageId, delivery, status, statusError };
}

export async function waitForReply(client, receipt, { timeoutMs = 60000, signal, pollMs = 1500, maxPages = 20 } = {}) {
  const deadline = Date.now() + bounded(timeoutMs, 60000, 1, 3600000, 'timeoutMs');
  bounded(pollMs, 1500, 1, 60000, 'pollMs');
  bounded(maxPages, 20, 1, 1000, 'maxPages');
  const timer = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timer]) : timer;
  const bot = { agentId: receipt.agentId, name: receipt.bot, viewerSessionId: receipt.sessionId };
  let retained = [], checkpoint, generation;
  try {
    while (Date.now() < deadline) {
      requestSignal.throwIfAborted();
      let beforeSeq, covered = false;
      const batch = [];
      for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
        const page = await history(client, bot, { limit: 200, sessionId: receipt.sessionId, beforeSeq, signal: requestSignal });
        if (generation !== undefined && generation !== page.generation) throw new Error('Conversation reset while waiting for the reply.');
        generation = page.generation;
        batch.push(...page.entries);
        const root = receiptRoot(batch, receipt);
        const boundary = checkpoint ?? root?.seq;
        const newestTime = Math.max(0, ...page.entries.map(row => row.timestampMs ?? 0));
        // A just-accepted send can precede its transcript echo. Older pages cannot contain it.
        const echoPending = !checkpoint && !root && Number(receipt.status?.acceptedAtMs) > newestTime;
        if (!page.entries.length || echoPending || boundary !== undefined && compare(page.nextBeforeSeq, boundary) <= 0) { covered = true; break; }
        if (beforeSeq !== undefined && compare(page.nextBeforeSeq, beforeSeq) >= 0) throw new Error('Reply history cursor did not advance.');
        beforeSeq = page.nextBeforeSeq;
      }
      if (!covered) throw new Error('Reply tracking exceeded its history page limit; increase maxPages or inspect the thread.');
      const combined = [...new Map([...retained, ...batch].map(row => [row.seq, row])).values()].sort((a, b) => compare(a.seq, b.seq));
      const own = receiptRoot(combined, receipt);
      if (own) {
        const linked = selectThread(combined, own.entryId).entries;
        const replies = linked.filter(row => compare(row.seq, own.seq) > 0 && hasPublishedReply(row));
        if (replies.length) return { ...receipt, replies, replyPending: false };
        retained = linked;
        checkpoint = batch.reduce((max, row) => maxSeq(max, row.seq), checkpoint ?? own.seq);
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), undefined, { signal: requestSignal });
    }
  } catch (error) { if (!timer.aborted || signal?.aborted) throw error; }
  return { ...receipt, replies: [], replyPending: true };
}

const cursorKey = (agentId, sessionId) => `${agentId}\u0000${sessionId}`;
const transcriptChanges = data => [
  ...(data.entries ?? []).map(row => ({ type: 'entry', updatedSeq: uint(row.updatedSeq ?? row.seq), row })),
  ...(data.deletes ?? []).map(row => ({ type: 'delete', updatedSeq: uint(row.updatedSeq), row })),
].sort((a, b) => compare(a.updatedSeq, b.updatedSeq));

async function transcriptEntry(client, bot, row, { sessionId, generation, signal }) {
  const entry = decodeEntry(row);
  if (!entry.bodyUnavailable) return entry;
  const nextSeq = BigInt(entry.seq) + 1n;
  const page = await history(client, bot, { sessionId, generation, limit: 1, signal,
    ...(nextSeq > 18446744073709551615n ? {} : { beforeSeq: nextSeq.toString() }) });
  if (page.generation !== generation) return undefined;
  // History may have advanced while hydration was in flight. Substituting that
  // newer body here would put it before older edits still queued in the stream.
  return page.entries.find(row => compare(row.seq, entry.seq) === 0
    && compare(row.updatedSeq, entry.updatedSeq) === 0
    && (!entry.entryId || row.entryId === entry.entryId) && row.entry && !row.bodyUnavailable);
}

function transcriptResync(agentId, sessionId, generation, afterUpdatedSeq, row) {
  return { type: 'resyncRequired', reason: 'body_unavailable', agentId, sessionId, generation,
    entryId: row.entryId ?? null, seq: uint(row.seq), updatedSeq: uint(row.updatedSeq ?? row.seq),
    cursor: { generation, afterUpdatedSeq },
    message: 'Reload conversation history before starting a new watch.' };
}

/** Read a bounded slice of the native update stream, then resume on the next poll.
 * The protocol has no replay-complete frame. A deadline is therefore only a
 * transport boundary; the returned cursor acknowledges applied rows, never the
 * newer sequence numbers observed by an unrelated history request.
 * A resyncRequired result requires reloading history before further polling.
 */
export async function readTranscriptUpdates(client, botQuery, { generation, afterUpdatedSeq = '0',
  sessionId, signal, timeoutMs = 1500, maxEvents = 2000 } = {}) {
  bounded(timeoutMs, 1500, 50, 10000, 'timeoutMs');
  bounded(maxEvents, 2000, 1, 10000, 'maxEvents');
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('generation must be a nonnegative integer.');
  const bot = await client.resolveBot(botQuery), session = sessionFor(bot, sessionId);
  let cursor = uint(afterUpdatedSeq), connected = false, truncated = false, resyncRequired = false;
  const events = [], deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    outer: for await (const frame of client.stream('WatchGrokBotTranscripts', {
      cursors: [{ agentId: bot.agentId, sessionId: session, generation, afterUpdatedSeq: cursor }],
      inlineBodyMaxBytes: 4 * 1024 * 1024,
    }, { signal: combined })) {
      const [type, data] = Object.entries(frame)[0] ?? [];
      if (type === 'connected') { connected = true; continue; }
      if (!data || data.agentId !== bot.agentId || (data.sessionId ?? '') !== session) continue;
      if (type === 'cursorTooOld' || type === 'cleared') {
        events.push({ type, ...data }); resyncRequired = true; break;
      }
      if (type !== 'rows') continue;
      connected = true;
      const nextGeneration = data.generation ?? 0;
      if (nextGeneration !== generation) {
        if (nextGeneration < generation) continue;
        events.push({ type: 'cleared', agentId: bot.agentId, sessionId: session, newGeneration: nextGeneration });
        resyncRequired = true; break;
      }
      // Entries and deletes share one updated-sequence ordering. Never advance
      // across an omitted body or a partially consumed batch.
      for (const change of transcriptChanges(data)) {
        if (compare(change.updatedSeq, cursor) <= 0) continue;
        if (events.length >= maxEvents) { truncated = true; break outer; }
        let entry;
        if (change.type === 'entry') {
          entry = await transcriptEntry(client, bot, change.row, { sessionId: session, generation, signal: combined });
          if (!entry) {
            events.push(transcriptResync(bot.agentId, session, generation, cursor, change.row));
            resyncRequired = true; truncated = true; break outer;
          }
        }
        events.push({ type: change.type, agentId: bot.agentId, sessionId: session, generation,
          ...(entry ?? change.row) });
        cursor = change.updatedSeq;
      }
    }
  } catch (error) {
    if (signal?.aborted || !deadline.signal.aborted || !connected) throw error;
  } finally { clearTimeout(timer); deadline.abort(); }
  return { events, cursor: { generation, afterUpdatedSeq: cursor }, truncated, resyncRequired };
}

/** Deliver transcript changes until cancelled or a terminal resyncRequired event.
 * An unavailable historical version cannot safely be acknowledged or retried
 * forever. Reload history and start a fresh watch after that terminal event.
 */
export async function* watchBots(client, queries, { sessionId, fromStart = false, resume,
  signal, reconnect = true, onCursor, initialBackoffMs = 500, includeUnlistedAgents,
  inlineBodyMaxBytes = 4 * 1024 * 1024 } = {}) {
  if (!Array.isArray(queries) || queries.length === 0) throw new Error('Select at least one bot to watch.');
  bounded(inlineBodyMaxBytes, 4 * 1024 * 1024, 0, 16 * 1024 * 1024, 'inlineBodyMaxBytes');
  if (includeUnlistedAgents !== undefined && typeof includeUnlistedAgents !== 'boolean') throw new TypeError('includeUnlistedAgents must be a boolean.');
  const bots = await Promise.all(queries.map(q => client.resolveBot(q)));
  const fingerprint = await client.accountFingerprint();
  if (resume && (resume.version !== 1 || resume.account !== fingerprint)) throw new Error('Cursor file belongs to another account or version.');
  const cursors = new Map();
  for (const bot of bots) {
    const session = sessionFor(bot, sessionId), key = cursorKey(bot.agentId, session);
    if (cursors.has(key)) continue;
    const saved = resume?.cursors?.find(c => c.agentId === bot.agentId && c.sessionId === session);
    if (saved) cursors.set(key, { agentId: bot.agentId, sessionId: session, generation: saved.generation ?? 0, afterUpdatedSeq: uint(saved.afterUpdatedSeq) });
    else {
      const snapshot = await history(client, bot, { limit: 1, sessionId: session, signal });
      cursors.set(key, { agentId: bot.agentId, sessionId: session, generation: snapshot.generation,
        afterUpdatedSeq: fromStart ? '0' : snapshot.entries.reduce((max, row) => maxSeq(max, row.updatedSeq), '0') });
    }
  }
  const state = () => ({ version: 1, account: fingerprint, cursors: [...cursors.values()].map(c => ({ ...c })) });
  let backoff = initialBackoffMs;
  while (!signal?.aborted) {
    try {
      let resync = false;
      for await (const frame of client.stream('WatchGrokBotTranscripts', { cursors: [...cursors.values()], inlineBodyMaxBytes,
        ...(includeUnlistedAgents === undefined ? {} : { includeUnlistedAgents }) }, { signal })) {
        backoff = initialBackoffMs;
        const [type, data] = Object.entries(frame)[0] ?? [];
        if (!type) continue;
        if (type === 'rows') {
          const key = cursorKey(data.agentId, data.sessionId ?? '');
          let cursor = cursors.get(key);
          if (!cursor && includeUnlistedAgents && typeof data.agentId === 'string') {
            cursor = { agentId: data.agentId, sessionId: data.sessionId ?? '', generation: data.generation ?? 0, afterUpdatedSeq: '0' };
            cursors.set(key, cursor);
          }
          if (!cursor) continue;
          const generation = data.generation ?? 0;
          if (generation < cursor.generation) continue;
          if (generation !== cursor.generation) {
            cursor.generation = generation; cursor.afterUpdatedSeq = '0';
          }
          for (const change of transcriptChanges(data)) {
            if (compare(change.updatedSeq, cursor.afterUpdatedSeq) <= 0) continue;
            let entry;
            if (change.type === 'entry') {
              entry = await transcriptEntry(client, { agentId: cursor.agentId }, change.row,
                { sessionId: cursor.sessionId, generation, signal });
              if (!entry) {
                yield transcriptResync(cursor.agentId, cursor.sessionId, generation, cursor.afterUpdatedSeq, change.row);
                return;
              }
            }
            yield { type: change.type, agentId: data.agentId, sessionId: cursor.sessionId, generation,
              ...(change.type === 'entry' ? { replay: data.replay ?? false } : {}), ...(entry ?? change.row) };
            cursor.afterUpdatedSeq = change.updatedSeq;
            await onCursor?.(state());
          }
          continue;
        } else if (type === 'cleared' || type === 'cursorTooOld') {
          const cursor = cursors.get(cursorKey(data.agentId, data.sessionId ?? ''));
          if (cursor) {
            const generation = data.newGeneration ?? data.generation ?? 0;
            if (generation < cursor.generation) continue;
            cursor.generation = generation; cursor.afterUpdatedSeq = '0';
          }
          yield { type, ...data };
          if (type === 'cursorTooOld') resync = true;
        } else yield { type, ...data };
        await onCursor?.(state());
        if (resync) break;
      }
      if (!reconnect) return;
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ApiError && (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)
        || ['unauthenticated', 'permission_denied', 'invalid_argument'].includes(error.code))) throw error;
      if (!reconnect) throw error;
      yield { type: 'reconnecting', message: error.message, delayMs: backoff };
    }
    try { await sleep(backoff, undefined, { signal }); } catch (error) { if (signal?.aborted) return; throw error; }
    backoff = Math.min(15000, backoff * 2);
  }
}
