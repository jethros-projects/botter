#!/usr/bin/env node
try {
  await import('../src/runtime.mjs');
  const { runStandaloneCli } = await import('../src/cli-entry.mjs');
  await runStandaloneCli();
} catch (error) {
  if (error.code !== 'UNSUPPORTED_NODE_VERSION') throw error;
  console.error(JSON.stringify({ error: error.message, code: error.code }));
  process.exitCode = 1;
}
