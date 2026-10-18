// Verified against Grok Bot 0.71.2's GrokBotService protocol and desktop uploader.
// Signed storage requests deliberately bypass the authenticated RPC client.
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { scanHistory } from './conversations.mjs';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const HARD_MAX_BYTES = 512 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024; // The desktop's server-read limit.
const BOX_MAX_BYTES = 25 * 1024 * 1024;
const BOX_VIDEO_MAX_BYTES = 200 * 1024 * 1024;
const UPLOAD_MODES = new Map([['USE_BOX', 1], ['SINGLE_PUT', 2], ['MULTIPART', 3]]);
const READ_OUTCOMES = new Map([['STORE', 1], ['NOT_IN_STORE', 2], ['NO_STORAGE', 3]]);
// Grok Bot 0.71.2's VIDEO_MIME_FROM_EXTENSION and attachment box budget.
const VIDEO_EXTENSIONS = new Set(['.m4v', '.mov', '.mp4', '.ogv', '.webm']);
const MIME_TYPES = new Map(Object.entries({
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.pdf': 'application/pdf', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.html': 'text/html',
  '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
}));

function fail(code, message) {
  const error = new Error(message);
  error.name = 'AttachmentError';
  error.code = code;
  return error;
}

function boundedInteger(value, fallback, min, max, label) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw fail('INVALID_OPTION', `${label} must be an integer between ${min} and ${max}.`);
  }
  return n;
}

function byteCount(value, label) {
  if (typeof value !== 'number' && typeof value !== 'bigint' &&
      !(typeof value === 'string' && /^\d+$/.test(value))) {
    throw fail('INVALID_RESPONSE', `The server returned an invalid ${label}.`);
  }
  return boundedInteger(value, undefined, 0, Number.MAX_SAFE_INTEGER, label);
}

function ensureNotAborted(signal) { signal?.throwIfAborted(); }

function settings(options) {
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, 0, HARD_MAX_BYTES, 'maxBytes');
  const timeoutMs = boundedInteger(options.timeoutMs, 60000, 1, 120000, 'timeoutMs');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw fail('FETCH_UNAVAILABLE', 'Node.js 20 or newer is required.');
  return { maxBytes, timeoutMs, fetchImpl, signal: options.signal };
}

async function context(client, query, options) {
  ensureNotAborted(options.signal);
  const bot = await client.resolveBot(query);
  if (typeof bot?.agentId !== 'string' || !bot.agentId) {
    throw fail('INVALID_BOT', 'The selected bot has no agent ID.');
  }
  const sessionId = options.sessionId ?? bot.viewerSessionId ?? '';
  if (typeof sessionId !== 'string' || sessionId.includes('\0')) {
    throw fail('INVALID_SESSION', 'sessionId must be a string without NUL bytes.');
  }
  return { bot: bot.name ?? bot.agentId, agentId: bot.agentId, sessionId };
}

function rpcOptions(config) { return { signal: config.signal, timeoutMs: config.timeoutMs }; }

function isEnum(value, name, number) {
  return value === number || typeof value === 'string' &&
    value.replace(/^GROK_BOT_ATTACHMENT_(?:READ_OUTCOME|UPLOAD_MODE|UPLOAD_REFUSAL)_/, '') === name;
}

function allowedUploadModes(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 ||
      value.some(mode => typeof mode !== 'string' || !UPLOAD_MODES.has(mode))) {
    throw fail('INVALID_OPTION', 'allowedModes must be a nonempty array containing SINGLE_PUT, MULTIPART, or USE_BOX.');
  }
  return new Set(value);
}

function allowedAttachmentReadOutcomes(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 ||
      value.some(outcome => typeof outcome !== 'string' || !READ_OUTCOMES.has(outcome))) {
    throw fail('INVALID_OPTION', 'allowedReadOutcomes must be a nonempty array containing STORE, NOT_IN_STORE, or NO_STORAGE.');
  }
  return new Set(value);
}

function checkRefusal(response, stage) {
  const refusal = response?.refusal;
  if (refusal !== undefined && !isEnum(refusal, 'UNSPECIFIED', 0)) {
    const value = typeof refusal === 'string' || typeof refusal === 'number' ? String(refusal) : 'unknown';
    throw fail('UPLOAD_REFUSED', `The server refused the attachment at ${stage}: ${value}.`);
  }
}

function remotePath(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\0\\\r\n]/.test(value)) {
    throw fail('INVALID_REMOTE_PATH', 'Use an absolute attachment path returned by Grok Bot.');
  }
  let parsed = value;
  if (value.startsWith('file:')) {
    let url;
    try { url = new URL(value); } catch { throw fail('INVALID_REMOTE_PATH', 'Invalid attachment file URL.'); }
    if (url.hostname || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) {
      throw fail('INVALID_REMOTE_PATH', 'Attachment file URLs must have no host, query, fragment or encoded separator.');
    }
    try { parsed = fileURLToPath(url); } catch { throw fail('INVALID_REMOTE_PATH', 'Invalid attachment file URL.'); }
  }
  if (!path.posix.isAbsolute(parsed) || parsed.split('/').includes('..') || parsed.includes('\0')) {
    throw fail('INVALID_REMOTE_PATH', 'Attachment paths must be absolute and cannot traverse parent directories.');
  }
  return path.posix.normalize(parsed);
}

function signedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_STORAGE_URL', 'The server did not return a valid signed storage URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw fail('INVALID_STORAGE_URL', 'Signed storage URLs must use HTTPS without embedded credentials or fragments.');
  }
  return url.href;
}

function requestSignal(config) {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  return config.signal ? AbortSignal.any([config.signal, timeout]) : timeout;
}

async function storageFetch(config, url, init) {
  ensureNotAborted(config.signal);
  const validatedUrl = signedUrl(url);
  try {
    return await config.fetchImpl(validatedUrl, {
      ...init, credentials: 'omit', redirect: 'error', signal: requestSignal(config),
    });
  } catch {
    ensureNotAborted(config.signal);
    // Avoid exposing signed URL query credentials in low-level network errors.
    throw fail('STORAGE_NETWORK_ERROR', 'The signed storage request failed or timed out. Retry the transfer.');
  }
}

async function cancelBody(response) { try { await response?.body?.cancel(); } catch { /* Already consumed. */ } }

function uploadHeaders(target, size) {
  if (target?.headers !== undefined && (!target.headers || typeof target.headers !== 'object' || Array.isArray(target.headers))) {
    throw fail('INVALID_RESPONSE', 'The server returned invalid signed upload headers.');
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(target?.headers ?? {})) {
    const lower = key.toLowerCase();
    if (['authorization', 'proxy-authorization', 'cookie', 'host', 'connection', 'transfer-encoding'].includes(lower)) {
      throw fail('UNSAFE_STORAGE_HEADER', 'The signed upload target requested a forbidden credential or transport header.');
    }
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw fail('INVALID_RESPONSE', 'Invalid signed upload header value.');
    if (lower === 'content-length') {
      if (value !== String(size)) throw fail('SIZE_MISMATCH', 'The signed upload target expects a different byte count.');
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function expired(value) {
  return value !== undefined && byteCount(value, 'expiry') > 0 && Number(value) <= Date.now();
}

async function put(config, target, bytes) {
  if (!target || expired(target.expiresAtMs)) {
    throw fail('UPLOAD_EXPIRED', 'The signed upload target is missing or expired. Retry the upload.');
  }
  const response = await storageFetch(config, target.url, {
    method: 'PUT', headers: uploadHeaders(target, bytes.length), body: bytes,
  });
  await cancelBody(response);
  if (!response.ok) throw fail('STORAGE_HTTP_ERROR', `Signed upload returned HTTP ${response.status}. Retry the upload.`);
}

async function readInput(filePath, maxBytes, signal) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw fail('INVALID_FILE', 'Specify a local file path.');
  const fileName = path.basename(filePath);
  if (!fileName || fileName.length > 255 || /[\\/\0\r\n]/.test(fileName)) throw fail('INVALID_FILE', 'Attachment file names must be 1–255 characters without separators.');
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) throw fail('INVALID_FILE', 'Only regular files can be uploaded.');
    if (before.size > maxBytes) throw fail('FILE_TOO_LARGE', `The file exceeds maxBytes (${maxBytes}).`);
    const bytes = Buffer.alloc(byteCount(before.size, 'file size'));
    let offset = 0;
    while (offset < bytes.length) {
      ensureNotAborted(signal);
      const { bytesRead } = await handle.read(bytes, offset, Math.min(CHUNK_BYTES, bytes.length - offset), offset);
      if (!bytesRead) throw fail('FILE_CHANGED', 'The local file changed while being read. Retry with a stable file.');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw fail('FILE_CHANGED', 'The local file changed while being read. Retry with a stable file.');
    }
    return { fileName, bytes };
  } catch (error) {
    if (error.code === 'ELOOP') throw fail('INVALID_FILE', 'Upload a regular file, not a symbolic link.');
    throw error;
  } finally { await handle?.close(); }
}

function gatewayResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('INVALID_RESPONSE', 'The gateway returned an invalid upload response.');
  }
  return value;
}

/** Use only a caller-supplied, already authorized gateway. The installed desktop
 * uploader uses 4 MiB uploadAttachmentChunk calls and reads committedPath from
 * the final response. uploadAttachment is the single-body route and returns
 * path. Neither route accepts a session ID or MIME type in this API version.
 * Writes are never retried or switched to another route after an uncertain call.
 */
async function uploadBox(gatewayClient, ctx, fileName, bytes, mimeType, sha256, config) {
  const boxLimit = VIDEO_EXTENSIONS.has(path.extname(fileName).toLowerCase())
    ? BOX_VIDEO_MAX_BYTES : BOX_MAX_BYTES;
  if (bytes.length === 0) throw fail('EMPTY_FILE', 'The desktop gateway does not accept empty attachments.');
  if (bytes.length > boxLimit) {
    throw fail('FILE_TOO_LARGE', `The attachment exceeds the desktop gateway limit (${boxLimit} bytes for this file type).`);
  }
  let response;
  let attachmentPath;
  let mode;
  if (bytes.length <= CHUNK_BYTES) {
    ensureNotAborted(config.signal);
    mode = 'gateway-single';
    response = gatewayResponse(await gatewayClient.rpcGateway('uploadAttachment', {
      agentId: ctx.agentId, filename: fileName, bytesBase64: bytes.toString('base64'),
    }, rpcOptions(config)));
    attachmentPath = remotePath(response.path);
  } else {
    mode = 'gateway-chunks';
    const uploadId = randomUUID();
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      ensureNotAborted(config.signal);
      const part = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length));
      response = gatewayResponse(await gatewayClient.rpcGateway('uploadAttachmentChunk', {
        agentId: ctx.agentId, uploadId, filename: fileName, offset,
        totalSize: bytes.length, bytesBase64: part.toString('base64'),
      }, rpcOptions(config)));
      const isLast = offset + part.length === bytes.length;
      if (response.committedPath !== undefined && response.committedPath !== null) {
        if (!isLast) throw fail('SIZE_MISMATCH', 'The gateway committed the attachment before receiving all bytes.');
        attachmentPath = remotePath(response.committedPath);
      } else if (isLast) {
        throw fail('INCOMPLETE_UPLOAD', 'The gateway accepted the final chunk without returning a committed attachment path. The write was not retried.');
      }
    }
  }
  return { ...response, ...ctx, kind: 'box', mode, path: attachmentPath,
    fileName, sizeBytes: bytes.length, contentType: mimeType, sha256 };
}

/** Upload and finalize an attachment without sending a chat message.
 * Returns { bot, agentId, sessionId, kind: 'store' | 'box', mode, path, alias?,
 * fileName, sizeBytes, contentType, sha256 }. mimeType is fallback metadata;
 * the signed target and server response determine the stored content type.
 * Defaults to a 64 MiB local cap; maxBytes may be raised to at most 512 MiB.
 * options.gatewayClient explicitly enables the desktop gateway only when the
 * server responds USE_BOX. It never discovers, connects, or wakes a computer.
 * options.allowedModes may restrict uploads to a nonempty subset of SINGLE_PUT,
 * MULTIPART, and USE_BOX. Omission retains all supported library modes. A server
 * selection outside the allowlist is aborted before attachment bytes are sent.
 */
export async function uploadAttachment(client, botQuery, filePath, options = {}) {
  const config = settings(options);
  const allowedModes = allowedUploadModes(options.allowedModes);
  if (options.gatewayClient !== undefined && typeof options.gatewayClient?.rpcGateway !== 'function') {
    throw fail('INVALID_OPTION', 'gatewayClient must be an existing authorized gateway adapter.');
  }
  const ctx = await context(client, botQuery, options);
  const { fileName, bytes } = await readInput(filePath, config.maxBytes, config.signal);
  const mimeType = options.mimeType ?? MIME_TYPES.get(path.extname(fileName).toLowerCase()) ?? 'application/octet-stream';
  if (typeof mimeType !== 'string' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mimeType)) {
    throw fail('INVALID_OPTION', 'mimeType must be a MIME type without parameters.');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let uploadToken;
  try {
    const begin = await client.rpc('BeginGrokBotAttachmentUpload', {
      agentId: ctx.agentId, sessionId: ctx.sessionId, fileName,
      sizeBytes: String(bytes.length), supportsStoreAttachmentRefs: true,
      supportsMultipart: allowedModes === undefined || allowedModes.has('MULTIPART'), sha256Hex: sha256,
    }, rpcOptions(config));
    checkRefusal(begin, 'begin');
    uploadToken = begin.uploadToken || undefined;
    const selectedMode = [...UPLOAD_MODES].find(([name, number]) => isEnum(begin.mode, name, number))?.[0];
    if (allowedModes && selectedMode && !allowedModes.has(selectedMode)) {
      throw fail('UPLOAD_MODE_NOT_ALLOWED', `The server selected ${selectedMode}, which is outside allowedModes (${[...allowedModes].join(', ')}). No attachment bytes were sent.`);
    }
    if (isEnum(begin.mode, 'USE_BOX', 1)) {
      if (!options.gatewayClient) {
        throw fail('BOX_UPLOAD_REQUIRED', `This bot requires a desktop gateway upload${begin.useBoxReason ? ` (${begin.useBoxReason})` : ''}. Supply an existing authorized gatewayClient to use it.`);
      }
      return await uploadBox(options.gatewayClient, ctx, fileName, bytes, mimeType, sha256, config);
    }
    if (isEnum(begin.mode, 'REFUSED', 4)) throw fail('UPLOAD_REFUSED', 'The server refused this attachment.');
    if (!uploadToken) throw fail('INVALID_RESPONSE', 'The server did not return an upload token.');
    if (expired(begin.sessionExpiresAtMs)) throw fail('UPLOAD_EXPIRED', 'The upload session expired before transfer. Retry the upload.');
    let mode;
    if (isEnum(begin.mode, 'SINGLE_PUT', 2)) {
      mode = 'single-put';
      let target = begin.put;
      if (!target || expired(target.expiresAtMs)) {
        const refreshed = await client.rpc('PresignGrokBotAttachmentUploadParts', { uploadToken, parts: [] }, rpcOptions(config));
        checkRefusal(refreshed, 'presign');
        target = refreshed.put;
      }
      await put(config, target, bytes);
    } else if (isEnum(begin.mode, 'MULTIPART', 3)) {
      mode = 'multipart';
      const partSize = byteCount(begin.partSizeBytes, 'multipart size');
      const partCount = byteCount(begin.partCount, 'multipart count');
      if (!partSize || !partCount || partCount > 10000 || partCount !== Math.ceil(bytes.length / partSize)) {
        throw fail('INVALID_RESPONSE', 'The server returned an inconsistent multipart layout.');
      }
      for (let partNumber = 1; partNumber <= partCount; partNumber++) {
        ensureNotAborted(config.signal);
        const offset = (partNumber - 1) * partSize;
        const partBytes = bytes.subarray(offset, Math.min(offset + partSize, bytes.length));
        const signed = await client.rpc('PresignGrokBotAttachmentUploadParts', {
          uploadToken, parts: [{ partNumber, checksumSha256: createHash('sha256').update(partBytes).digest('base64') }],
        }, rpcOptions(config));
        checkRefusal(signed, 'presign');
        const parts = (signed.parts ?? []).filter(part => part.partNumber === partNumber);
        if (parts.length !== 1 || !parts[0].target) throw fail('INVALID_RESPONSE', 'The server omitted a unique multipart upload target.');
        const part = parts[0];
        if (part.offsetBytes !== undefined && byteCount(part.offsetBytes, 'part offset') !== offset ||
            part.sizeBytes !== undefined && byteCount(part.sizeBytes, 'part size') !== partBytes.length) {
          throw fail('SIZE_MISMATCH', 'The signed multipart target disagrees with the local part boundaries.');
        }
        await put(config, part.target, partBytes);
      }
    } else {
      throw fail('UNSUPPORTED_UPLOAD_MODE', 'The server returned an unsupported upload mode. Update the bridge before uploading.');
    }
    ensureNotAborted(config.signal);
    const complete = await client.rpc('CompleteGrokBotAttachmentUpload', { uploadToken }, rpcOptions(config));
    checkRefusal(complete, 'complete');
    const alias = remotePath(complete.alias);
    if (complete.sizeBytes !== undefined && byteCount(complete.sizeBytes, 'completed size') !== bytes.length) {
      throw fail('SIZE_MISMATCH', 'The finalized attachment size differs from the local file.');
    }
    uploadToken = undefined;
    return { ...complete, ...ctx, kind: 'store', mode, path: alias, alias,
      fileName: complete.fileName || fileName, sizeBytes: bytes.length,
      contentType: complete.contentType || mimeType, sha256 };
  } catch (error) {
    if (uploadToken) {
      try { await client.rpc('AbortGrokBotAttachmentUpload', { uploadToken }, { timeoutMs: 10000 }); }
      catch { error.cleanupFailed = true; }
    }
    throw error;
  }
}

async function writeBytes(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw fail('WRITE_FAILED', 'The destination stopped accepting bytes.');
    offset += bytesWritten;
  }
}

function decodeBytes(data, requested) {
  if (data === undefined || data === '') return Buffer.alloc(0);
  if (data instanceof Uint8Array) {
    if (data.length > requested) throw fail('SIZE_MISMATCH', 'The server returned more bytes than requested.');
    return Buffer.from(data);
  }
  if (typeof data !== 'string' || data.length > Math.ceil(requested / 3) * 4 ||
      data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) {
    throw fail('INVALID_RESPONSE', 'The attachment chunk contains invalid or oversized base64 data.');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > requested || bytes.toString('base64') !== data) throw fail('INVALID_RESPONSE', 'The attachment chunk has invalid base64 encoding.');
  return bytes;
}

async function downloadStore(config, read, handle, digest) {
  const totalSize = byteCount(read.sizeBytes ?? 0, 'attachment size');
  if (totalSize > config.maxBytes) throw fail('FILE_TOO_LARGE', `The attachment exceeds maxBytes (${config.maxBytes}).`);
  if (expired(read.expiresAtMs)) throw fail('DOWNLOAD_EXPIRED', 'The signed attachment URL expired. Retry the download.');
  const response = await storageFetch(config, read.url, { method: 'GET', headers: {} });
  if (response.status !== 200) {
    await cancelBody(response);
    throw fail('STORAGE_HTTP_ERROR', `Signed download returned HTTP ${response.status}. Retry the download.`);
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && byteCount(declared, 'Content-Length') !== totalSize) {
    await cancelBody(response);
    throw fail('SIZE_MISMATCH', 'Storage Content-Length differs from the resolved attachment size.');
  }
  let received = 0;
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        ensureNotAborted(config.signal);
        const bytes = Buffer.from(chunk);
        received += bytes.length;
        if (received > totalSize || received > config.maxBytes) throw fail('SIZE_MISMATCH', 'The signed download exceeded its declared size.');
        digest.update(bytes);
        await writeBytes(handle, bytes);
      }
    }
  } catch (error) { await cancelBody(response); throw error; }
  if (received !== totalSize) throw fail('SIZE_MISMATCH', 'The signed download ended before the declared byte count.');
  return { sizeBytes: received, contentType: read.contentType || 'application/octet-stream', via: 'store' };
}

async function downloadChunks(client, config, ctx, attachmentPath, handle, digest) {
  let offset = 0;
  let totalSize;
  do {
    ensureNotAborted(config.signal);
    const result = await client.rpc('ReadGrokBotAgentAttachmentChunk', {
      path: attachmentPath, offset: String(offset), length: CHUNK_BYTES, sessionId: ctx.sessionId,
    }, rpcOptions(config));
    const observedSize = byteCount(result.totalSize ?? 0, 'attachment size');
    if (observedSize > config.maxBytes) throw fail('FILE_TOO_LARGE', `The attachment exceeds maxBytes (${config.maxBytes}).`);
    if (totalSize !== undefined && observedSize !== totalSize) throw fail('FILE_CHANGED', 'The remote attachment changed during download.');
    totalSize = observedSize;
    const bytes = decodeBytes(result.data, CHUNK_BYTES);
    const expected = Math.min(CHUNK_BYTES, Math.max(0, totalSize - offset));
    if (bytes.length !== expected) throw fail('SIZE_MISMATCH', `The server returned ${bytes.length} bytes for a ${expected}-byte attachment chunk.`);
    digest.update(bytes);
    await writeBytes(handle, bytes);
    offset += bytes.length;
  } while (offset < totalSize);
  return { sizeBytes: totalSize, contentType: MIME_TYPES.get(path.posix.extname(attachmentPath).toLowerCase()) ?? 'application/octet-stream', via: 'server-chunks' };
}

/** Download a known Grok Bot attachment path. Local writes are atomic and refuse
 * existing destinations unless overwrite:true. Returns { bot, agentId, sessionId,
 * remotePath, destination, sizeBytes, contentType, via, sha256 }.
 * options.allowedReadOutcomes may restrict server outcomes to STORE,
 * NOT_IN_STORE, or NO_STORAGE. An omitted policy permits all supported outcomes;
 * a disallowed selection fails before downloading bytes or publishing a file.
 */
export async function downloadAttachment(client, botQuery, attachmentPath, destination, options = {}) {
  const config = settings(options);
  const allowedReadOutcomes = allowedAttachmentReadOutcomes(options.allowedReadOutcomes);
  const ctx = await context(client, botQuery, options);
  const normalizedPath = remotePath(attachmentPath);
  if (typeof destination !== 'string' || !destination || destination.includes('\0')) throw fail('INVALID_DESTINATION', 'Specify a local destination file.');
  const target = path.resolve(destination);
  let existing;
  try { existing = await fs.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && (!options.overwrite || !existing.isFile())) {
    throw fail('DESTINATION_EXISTS', 'The destination exists. Choose another path or explicitly set overwrite:true for a regular file.');
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.grok-${randomUUID()}.partial`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    const resolved = await client.rpc('ResolveGrokBotAttachmentReads', {
      agentId: ctx.agentId, sessionId: ctx.sessionId, paths: [normalizedPath],
    }, rpcOptions(config));
    const reads = (resolved.reads ?? []).filter(read => read.path === normalizedPath);
    if (reads.length !== 1) throw fail('INVALID_RESPONSE', 'The server did not resolve this exact attachment path.');
    const read = reads[0];
    const selectedOutcome = [...READ_OUTCOMES].find(([name, number]) => isEnum(read.outcome, name, number))?.[0];
    if (allowedReadOutcomes && selectedOutcome && !allowedReadOutcomes.has(selectedOutcome)) {
      throw fail('READ_OUTCOME_NOT_ALLOWED', `The server selected ${selectedOutcome}, which is outside allowedReadOutcomes (${[...allowedReadOutcomes].join(', ')}). No attachment bytes were downloaded.`);
    }
    const digest = createHash('sha256');
    let metadata;
    if (isEnum(read.outcome, 'STORE', 1)) metadata = await downloadStore(config, read, handle, digest);
    else if (isEnum(read.outcome, 'NOT_IN_STORE', 2) || isEnum(read.outcome, 'NO_STORAGE', 3)) {
      metadata = await downloadChunks(client, config, ctx, normalizedPath, handle, digest);
    } else throw fail('UNSUPPORTED_READ_OUTCOME', 'The server returned an unsupported attachment read outcome.');
    ensureNotAborted(config.signal);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.overwrite) await fs.rename(temporary, target);
    else await fs.link(temporary, target); // Atomic no-clobber even if a file appeared during the download.
    return { ...ctx, remotePath: normalizedPath, destination: target, ...metadata, sha256: digest.digest('hex') };
  } catch (error) {
    if (error.code === 'EEXIST') throw fail('DESTINATION_EXISTS', 'The destination appeared during download; it was not overwritten.');
    throw error;
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

/** List the protocol's agent files, not every file on its computer. Pagination is
 * capped; a remaining nextPageToken means more files exist. This API is unavailable
 * for some bot/runtime types. It has no session filter in the verified protocol.
 */
export async function listArtifacts(client, botQuery, options = {}) {
  const config = settings(options);
  const ctx = await context(client, botQuery, options);
  const maxPages = boundedInteger(options.maxPages, 20, 1, 100, 'maxPages');
  if (options.pageToken !== undefined && typeof options.pageToken !== 'string') throw fail('INVALID_OPTION', 'pageToken must be a string.');
  if (options.sessionId !== undefined) throw fail('UNSUPPORTED_OPTION', 'Agent file listing is not session-scoped; omit sessionId.');
  const files = [];
  let pageToken = options.pageToken ?? '';
  let totalBytes = 0;
  let canEdit = false;
  let response = {};
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    ensureNotAborted(config.signal);
    if (seen.has(pageToken)) throw fail('INVALID_RESPONSE', 'The server repeated an agent file page token.');
    seen.add(pageToken);
    let result;
    try {
      result = await client.rpc('ListGrokBotAgentFiles', { agentId: ctx.agentId, pageToken }, rpcOptions(config));
    } catch (error) {
      if (/failed.?precondition|unimplemented/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
        throw fail('ARTIFACT_LIST_UNAVAILABLE', 'Agent file listing is unavailable for this bot/runtime. Known conversation attachment paths may still be downloaded.');
      }
      throw error;
    }
    if (!Array.isArray(result.files ?? [])) throw fail('INVALID_RESPONSE', 'The server returned an invalid file list.');
    response = result;
    if (files.length + (result.files?.length ?? 0) > 10000) throw fail('FILE_LIST_TOO_LARGE', 'Agent file listing exceeds the 10,000-file cap; request individual pages.');
    for (const file of result.files ?? []) {
      files.push({ ...file, path: remotePath(file.path), sizeBytes: byteCount(file.sizeBytes ?? 0, 'file size') });
    }
    totalBytes = byteCount(result.totalBytes ?? 0, 'total file size');
    canEdit = result.canEdit === true;
    pageToken = result.nextPageToken ?? '';
    if (typeof pageToken !== 'string') throw fail('INVALID_RESPONSE', 'The server returned an invalid file page token.');
    if (!pageToken) break;
  }
  return { ...response, bot: ctx.bot, agentId: ctx.agentId, scope: 'agent-files', files, totalBytes, canEdit,
    nextPageToken: pageToken || null, complete: !pageToken };
}

/** Discover file references in the selected conversation's persisted transcript.
 * These are observed references, not a filesystem listing or proof of availability.
 * `complete` describes history pagination; `inspectionComplete` also accounts for
 * omitted message bodies and bounded recursive inspection.
 * All scanHistory options are forwarded, including sessionId, beforeSeq,
 * generation, unreadBoundaryMs, pageSize, maxPages, and signal. Returned scan
 * metadata is preserved; entries contains the discovered reference inventory.
 */
export async function listArtifactReferences(client, botQuery, options = {}) {
  const scan = await scanHistory(client, botQuery, options);
  const found = new Map();
  let nodes = 0;
  let truncated = false;
  const MAX_NODES = 200000;
  const MAX_DEPTH = 64;
  const MAX_TEXT = 2 * 1024 * 1024;
  const pathField = /^(?:path|paths|file_?paths?|attachment_?paths?|asset_?paths?|image_?paths?)$/i;
  const collectionField = /^(?:attachments?|images?|files?|assets?)$/i;
  const add = (value, row, source, field) => {
    let normalized;
    try { normalized = remotePath(value); } catch { return; }
    const reference = { entryId: row.entryId, seq: row.seq, kind: row.kind,
      timestampMs: row.timestampMs, source, field };
    let item = found.get(normalized);
    if (!item) {
      item = { path: normalized, ...reference, references: [] };
      found.set(normalized, item);
    }
    if (!item.references.some(old => old.entryId === reference.entryId && old.seq === reference.seq && old.field === field)) {
      item.references.push(reference);
    }
  };
  const inspectString = (value, row, key, field, inCollection) => {
    if (pathField.test(key) || inCollection && (collectionField.test(key) || /^(?:url|uri|src|source|file)$/i.test(key))) {
      add(value, row, 'path-field', field);
    }
    if (value.startsWith('file:')) add(value, row, 'file-url', field);
    if (value.length > MAX_TEXT) truncated = true;
    const text = value.slice(0, MAX_TEXT);
    // Markdown destinations only: titles/labels are never treated as paths.
    const links = /!?\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))(?:\s+["'][^\r\n]*?["'])?\s*\)/g;
    for (const match of text.matchAll(links)) add(match[1] ?? match[2], row, 'markdown-link', field);
    // Explicit file: references can also occur in prose and tool results.
    for (const match of text.matchAll(/file:\/\/\/[^\s<>"'`\])]+/g)) add(match[0], row, 'file-url', field);
  };
  const walk = (value, row, key = '', field = '', inCollection = false, depth = 0) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) { truncated = true; return; }
    if (typeof value === 'string') { inspectString(value, row, key, field, inCollection); return; }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (nodes >= MAX_NODES) { truncated = true; break; }
        walk(value[i], row, key, `${field}[${i}]`, inCollection || collectionField.test(key), depth + 1);
      }
      return;
    }
    inCollection ||= collectionField.test(value.type ?? '') || collectionField.test(value.kind ?? '');
    for (const [childKey, child] of Object.entries(value)) {
      if (nodes >= MAX_NODES) { truncated = true; break; }
      const childField = field ? `${field}.${childKey}` : childKey;
      walk(child, row, childKey, childField, inCollection || collectionField.test(childKey), depth + 1);
    }
  };
  for (const row of scan.entries) {
    ensureNotAborted(options.signal);
    walk(row.entry, row);
  }
  const entries = [...found.values()];
  const unavailableEntries = scan.entries.filter(row => row.bodyUnavailable).length;
  const { entries: scannedEntries, ...scanMetadata } = scan;
  return { ...scanMetadata, bot: scan.bot, agentId: scan.agentId, sessionId: scan.sessionId,
    scope: 'transcript-references', generation: scan.generation, pages: scan.pages,
    complete: scan.complete, nextBeforeSeq: scan.nextBeforeSeq, entriesScanned: scannedEntries.length,
    inspectionComplete: !truncated && unavailableEntries === 0, inspectionTruncated: truncated,
    unavailableEntries, referenceCount: entries.reduce((n, item) => n + item.references.length, 0), entries,
    note: 'File references observed in this conversation only; files may have moved or been deleted. This is not a filesystem listing.' };
}
