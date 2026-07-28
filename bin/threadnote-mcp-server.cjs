#!/usr/bin/env node

require('./node-warning-filter.cjs').suppressThreadnoteSQLiteExperimentalWarning();

void import('../dist/mcp_server.js').catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
