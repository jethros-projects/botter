import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// This script deliberately tests the packed application API, never native helpers.
if (process.env.BOTTER_E2E_CONFIRM !== '1') {
  console.error('Live checks create one disposable bot and send synthetic messages. Set BOTTER_E2E_CONFIRM=1 to run.');
  process.exit(2);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const execute = promisify(execFile);
const runId = randomUUID();
const cleanupOnly = process.argv[2] === '--cleanup';
if (process.argv.length > 2 && (!cleanupOnly || process.argv.length !== 4)) throw new Error('Use --cleanup work/e2e/RUN_ID/journal.json, or no arguments.');
const previousJournal = cleanupOnly ? path.resolve(root, process.argv[3]) : undefined;
if (previousJournal && (!previousJournal.startsWith(`${path.join(root, 'work', 'e2e')}${path.sep}`) || path.basename(previousJournal) !== 'journal.json')) throw new Error('Cleanup requires a journal inside this checkout work/e2e directory.');
const directory = cleanupOnly ? path.dirname(previousJournal) : path.join(root, 'work', 'e2e', runId);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const journalFile = path.join(directory, 'journal.json');
const reportFile = path.join(directory, 'report.json');
const journal = cleanupOnly ? JSON.parse(await readFile(previousJournal, 'utf8'))
  : { runId, state: 'planned', botId: randomUUID(), name: `Botter SDK E2E ${runId.slice(0, 8)}`, messages: [], created: false, cleanup: 'pending' };
assert.match(journal.botId, /^[0-9a-f-]{36}$/i); assert.equal(journal.name, `Botter SDK E2E ${journal.runId.slice(0, 8)}`);
const report = { service: 'botter', startedAt: new Date().toISOString(), steps: [], cleanup: { status: 'pending', remainingFixtures: 0 } };
const shutdown = new AbortController();
const totalTimer = setTimeout(() => shutdown.abort(new DOMException('Live check deadline reached.', 'TimeoutError')), 360000);
const interrupt = () => shutdown.abort(new DOMException('Live check interrupted.', 'AbortError'));
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
let client, createClient, installed, cli, subscription, watchTask, watchSeen = false, packedFiles;

async function saveJournal() {
  const temporary = `${journalFile}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, journalFile);
}
function safeError(error) {
  return { code: typeof error?.code === 'string' && /^[\w.-]{1,80}$/.test(error.code) ? error.code : error?.name === 'AssertionError' ? 'ASSERTION_FAILED' : 'OPERATION_FAILED',
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}) };
}
async function step(name, action) {
  const started = Date.now();
  console.log(JSON.stringify({ step: name, status: 'running' }));
  try {
    const details = await action();
    const result = { name, status: 'passed', durationMs: Date.now() - started, ...details };
    report.steps.push(result); console.log(JSON.stringify(result)); return details;
  } catch (error) {
    const result = { name, status: 'failed', durationMs: Date.now() - started, ...safeError(error) };
    report.steps.push(result); console.log(JSON.stringify(result)); throw error;
  }
}
function request(timeoutMs = 30000) { return { signal: shutdown.signal, timeoutMs }; }
async function command(args, { timeoutMs = 45000, cleanup = false } = {}) {
  try {
    const result = await execute(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8', timeout: timeoutMs,
      signal: cleanup ? AbortSignal.timeout(timeoutMs) : shutdown.signal, maxBuffer: 1024 * 1024 });
    return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
  } catch (error) {
    // Never include subprocess output, command arguments, or private responses in errors.
    let code;
    try { code = JSON.parse(error.stderr).code; } catch {}
    throw Object.assign(new Error('Installed CLI check failed.'), { code: typeof code === 'string' ? code : 'CLI_FAILED' });
  }
}
async function bounded(promise, timeoutMs) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Expected event was not observed.'), { code: 'TIMEOUT' })), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function installedHash() {
  const hash = createHash('sha256');
  for (const file of packedFiles) { hash.update(file); hash.update('\0'); hash.update(await readFile(path.join(installed, file))); }
  return hash.digest('hex');
}
const echo = (page, messageId, marker) => page.messages.some(message =>
  (message.id === messageId || message.entry?.clientNonce === messageId || message.entry?.batchId === messageId)
  && message.text?.includes(marker));

try {
  await saveJournal();
  await step('freeze-package', async () => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const packed = await execute(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root, encoding: 'utf8', timeout: 60000 });
    const [archive] = JSON.parse(packed.stdout);
    const tarball = path.join(directory, archive.filename);
    await execute(npm, ['install', '--prefix', path.join(directory, 'installed'), '--ignore-scripts', '--no-audit', '--no-fund', tarball], { encoding: 'utf8', timeout: 60000 });
    installed = path.join(directory, 'installed', 'node_modules', '@jethros-projects/botter');
    cli = path.join(installed, 'bin', 'botter.mjs');
    const consumerFile = path.join(directory, 'installed', 'sdk-consumer.mjs');
    await writeFile(consumerFile, "export const sdk = await import('@jethros-projects/botter'); export const resolved = import.meta.resolve('@jethros-projects/botter');\n", { mode: 0o600 });
    const consumer = await import(pathToFileURL(consumerFile).href);
    assert.equal(fileURLToPath(consumer.resolved), path.join(installed, 'src', 'index.mjs'));
    ({ createClient } = consumer.sdk);
    packedFiles = archive.files.map(file => file.path).sort();
    report.package = { version: archive.version, packageSha256: sha256(await readFile(tarball)), sourceSha256: await installedHash(), fileCount: archive.files.length,
      rootExportResolvedFromInstalledPackage: true, runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))) };
    journal.package = report.package; await saveJournal();
    return report.package;
  });
  client = createClient();
  if (!cleanupOnly) {
  await step('sdk-auth-and-list', async () => {
    const status = await client.auth.status(request()); assert.equal(status.authenticated, true);
    const bots = await client.listBots(request()); assert(!bots.some(bot => bot.botId === journal.botId));
    return { authenticated: true, botsDiscovered: bots.length };
  });
  await step('installed-cli-auth-and-list', async () => {
    assert.equal((await command(['auth-status'])).authenticated, true);
    return { botsDiscovered: (await command(['list'])).length };
  });
  await step('create-disposable-temporal-bot', async () => {
    journal.state = 'create-dispatched'; await saveJournal();
    await command(['bot-create', journal.name, '--id', journal.botId, '--harness', 'temporal', '--description', 'Disposable Botter canonical SDK verification fixture.',
      '--json', JSON.stringify({ kickstartRequested: false, introductionSuppressed: true })]);
    const bot = (await client.listBots(request())).find(bot => bot.botId === journal.botId);
    assert(bot && bot.name === journal.name); assert([2, 'temporal', 'TEMPORAL', 'GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL'].includes(bot.harness));
    journal.created = true; journal.state = 'created'; await saveJournal(); return { disposableBotsCreated: 1 };
  });
  await step('sdk-history-and-search', async () => {
    const page = await client.history({ botId: journal.botId, limit: 10 }, request());
    assert(Array.isArray(page.messages));
    const search = await client.search({ botId: journal.botId, query: runId, maxPages: 2, pageSize: 50, limit: 10 }, request());
    assert(Array.isArray(search.messages)); return { historyMessages: page.messages.length, searchedPages: search.pages };
  });
  const bytes = Buffer.from(`Botter canonical SDK fixture ${runId}\n`, 'utf8');
  const input = path.join(directory, 'fixture.txt'), output = path.join(directory, 'download.txt');
  await writeFile(input, bytes, { mode: 0o600 });
  let uploaded;
  await step('sdk-upload-and-download', async () => {
    journal.fileSha256 = sha256(bytes); journal.fileSizeBytes = bytes.length; journal.uploadIntent = true; journal.state = 'upload-dispatched'; await saveJournal();
    uploaded = await client.upload({ botId: journal.botId, path: input, name: 'botter-e2e.txt' }, request(45000));
    journal.remotePath = uploaded.path; await saveJournal();
    const downloaded = await client.download({ botId: journal.botId, path: uploaded.path, output }, request(45000));
    assert.equal(sha256(await readFile(output)), sha256(bytes)); assert.equal(downloaded.sha256, uploaded.sha256);
    return { sizeBytes: bytes.length, sha256: downloaded.sha256 };
  });
  let connected;
  const connection = new Promise(resolve => { connected = resolve; });
  await step('sdk-watch-start', async () => {
    subscription = await client.watch({ botId: journal.botId, maxBufferEvents: 256 }, request(180000));
    watchTask = (async () => {
      for await (const event of subscription) {
        if (event.type === 'connected') connected();
        if (event.type === 'entry' && event.message.text?.includes(runId)) watchSeen = true;
        if (['resyncRequired', 'cursorTooOld'].includes(event.type)) throw Object.assign(new Error('Transcript requires resync.'), { code: 'RESYNC_REQUIRED' });
      }
    })();
    watchTask.catch(() => {});
    await bounded(Promise.race([connection, watchTask.then(() => { throw new Error('Watch ended before connection.'); })]), 30000);
    return { connected: true };
  });
  await step('sdk-send-correlated-reply-and-readback', async () => {
    const messageId = randomUUID(); journal.messages.push({ messageId, source: 'sdk', state: 'dispatch-intent' }); await saveJournal();
    const receipt = await client.send({ botId: journal.botId, messageId,
      text: `[BOTTER_E2E ${runId}] Reply with exactly ACK_${runId}. This is a disposable smoke check. Do not run tools, contact other services, or start background work.`,
      attachments: [{ remotePath: uploaded.path, name: 'botter-e2e.txt' }], wait: true, waitTimeoutMs: 90000 }, request(110000));
    journal.messages.at(-1).state = 'receipt-returned'; await saveJournal();
    assert.equal(receipt.messageId, messageId); assert.equal(receipt.replyPending, false); assert(receipt.replies?.length > 0);
    const page = await client.history({ botId: journal.botId, limit: 50 }, request()); assert(echo(page, messageId, runId));
    const search = await client.search({ botId: journal.botId, query: runId, maxPages: 2, pageSize: 50, limit: 20 }, request()); assert(search.messages.length > 0);
    return { correlatedReplies: receipt.replies.length, echoReadback: true, searchMatches: search.messages.length, taskCompletionClaimed: false };
  });
  await step('sdk-watch-observation-and-cancellation', async () => {
    assert(watchSeen); assert(subscription.cursor?.afterUpdatedSeq);
    await subscription.cancel(); await subscription.done; await watchTask; subscription = undefined;
    return { fixtureObserved: true, cancelled: true };
  });
  await step('sdk-artifact-reference-readback', async () => {
    const artifacts = await client.artifacts({ botId: journal.botId, maxPages: 2, pageSize: 100 }, request());
    assert(artifacts.entries.some(entry => entry.path === uploaded.path)); return { fixtureReferenceFound: true };
  });
  await step('installed-cli-send-and-readback', async () => {
    const messageId = randomUUID(); journal.messages.push({ messageId, source: 'cli', state: 'dispatch-intent' }); await saveJournal();
    const receipt = await command(['send', journal.botId, '--message-id', messageId, '--text', `[BOTTER_CLI_E2E ${runId}] Reply exactly CLI_ACK_${runId}. No tools or background work.`, '--wait', '45'], { timeoutMs: 65000 });
    assert.equal(receipt.messageId, messageId); journal.messages.at(-1).state = 'receipt-returned'; await saveJournal();
    const page = await command(['history', journal.botId, '--limit', '50']); assert(page.entries.some(entry => entry.text?.includes(`BOTTER_CLI_E2E ${runId}`)));
    const search = await command(['search', journal.botId, '--query', runId, '--pages', '2', '--limit', '20']); assert(search.entries.length > 0);
    return { echoReadback: true, taskCompletionClaimed: false };
  });
  await step('installed-cli-download-and-bounded-watch', async () => {
    const destination = path.join(directory, 'cli-download.txt');
    await command(['download', journal.botId, uploaded.path, '--out', destination]); assert.equal(sha256(await readFile(destination)), sha256(bytes));
    // NDJSON watch is intentionally parsed separately from ordinary CLI JSON.
    const result = await execute(process.execPath, [cli, 'watch', journal.botId, '--duration', '3'], { cwd: directory, encoding: 'utf8', timeout: 15000, signal: shutdown.signal, maxBuffer: 1024 * 1024 });
    const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { downloadHashMatched: true, watchStopped: true, watchEvents: events.length };
  });
  }
} catch (error) {
  report.failure = safeError(error); process.exitCode = 1;
} finally {
  await subscription?.cancel().catch(() => {});
  await watchTask?.catch(() => {});
  if (client) await step('sdk-close', async () => { await client.close(); await client.close(); return { idempotent: true }; }).catch(() => { process.exitCode = 1; });
  if (createClient && cli && journal.state !== 'planned') {
    const cleanupClient = createClient();
    try {
      await step('cleanup-disposable-fixture', async () => {
        const bot = (await cleanupClient.listBots({ timeoutMs: 30000 })).find(bot => bot.botId === journal.botId);
        if (bot) {
          assert.equal(bot.name, journal.name, 'Fixture ownership label must match.');
          journal.cleanup = 'delete-intent'; await saveJournal();
          await command(['bot-delete', journal.botId], { cleanup: true });
          assert(!(await cleanupClient.listBots({ timeoutMs: 30000 })).some(bot => bot.botId === journal.botId));
        }
        journal.cleanup = 'bot-removed'; report.cleanup = { status: 'passed', remainingFixtures: 0, botDeletionVerified: true,
          possibleStoredUploads: journal.uploadIntent ? 1 : 0, storedUploadSizeBytes: journal.fileSizeBytes ?? 0, uploadDeletionVerified: false };
        await saveJournal(); return report.cleanup;
      });
    } catch (error) {
      journal.cleanup = 'requires-review'; report.cleanup = { status: 'failed', remainingFixtures: 1, ...safeError(error) }; process.exitCode = 1;
    } finally { await cleanupClient.close(); }
  } else if (journal.state === 'planned') report.cleanup = { status: 'not-needed', remainingFixtures: 0, possibleStoredUploads: 0 };
  if (installed && packedFiles) await step('verify-frozen-package', async () => {
    const hash = await installedHash(); assert.equal(hash, report.package.sourceSha256);
    report.package.installedPayloadSha256After = hash;
    return { installedPayloadUnchanged: true };
  }).catch(error => { report.failure ??= safeError(error); process.exitCode = 1; });
  clearTimeout(totalTimer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  report.finishedAt = new Date().toISOString(); report.status = process.exitCode ? 'failed' : 'passed';
  journal.state = report.status; await saveJournal();
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, package: report.package, cleanup: report.cleanup, report: path.relative(root, reportFile), journal: path.relative(root, journalFile) }));
}
