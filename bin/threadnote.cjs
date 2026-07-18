#!/usr/bin/env node

void import('../dist/threadnote.js').catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
