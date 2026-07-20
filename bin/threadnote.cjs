#!/usr/bin/env node

void import('../dist/threadnote.js').catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
