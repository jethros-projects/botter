import { main } from './cli.mjs';
import { UsageError } from './errors.mjs';
import { ApiSchemaError } from './schema.mjs';

// Keep diagnostics on stderr and command results on stdout.
export async function runStandaloneCli(argv = process.argv.slice(2)) {
  try { return await main(argv); }
  catch (error) {
    const usage = error instanceof UsageError || error instanceof ApiSchemaError;
    console.error(JSON.stringify({ error: error.message, code: usage ? 'usage_error' : error.code,
      status: error.status, messageId: error.messageId, reason: error.reason }));
    process.exitCode = usage ? 2 : 1;
  }
}
