#!/usr/bin/env node

void import('../dist/mcp_server.js').catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
