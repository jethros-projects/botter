import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 128 * 1024;
const storageError = (message = 'The macOS Keychain command failed.') => Object.assign(new Error(message), { code: 'auth_storage_error' });

/** Keep credentials in private pipes, with cancellable, bounded process I/O. */
export async function keychainCommand(args, { input, signal, spawnImpl = spawn } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child, settled = false, outputBytes = 0, errorBytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) {
        try { child?.stdin?.destroy(); child?.kill('SIGKILL'); } catch {}
        reject(error);
      } else resolve(value);
    };
    const abort = () => finish(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => {
      const error = storageError('The macOS Keychain command timed out.');
      error.name = 'TimeoutError'; finish(error);
    }, 30_000);
    try { child = spawnImpl('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { finish(storageError()); return; }
    child.once('error', () => finish(signal?.aborted ? signal.reason : storageError()));
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) finish(storageError('The macOS Keychain response exceeded its size limit.'));
      else if (!settled) chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      errorBytes += chunk.length;
      if (errorBytes > MAX_OUTPUT_BYTES) finish(storageError());
    });
    child.stdout.on('error', () => finish(storageError()));
    child.stderr.on('error', () => finish(storageError()));
    // An early process exit can close stdin before end(); its exit code remains
    // authoritative (notably Keychain's 44 for a missing item).
    child.stdin.on('error', () => {});
    child.once('close', code => {
      if (code !== 0) { const error = storageError(); error.exitCode = code; finish(error); }
      else finish(undefined, Buffer.concat(chunks).toString('utf8'));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { child.stdin.end(input); } catch { finish(storageError()); }
  });
}
