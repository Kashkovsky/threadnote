import {stat} from 'node:fs/promises';

const budgets = [
  {bytes: 1_700_000, path: 'dist/threadnote.js'},
  {bytes: 1_800_000, path: 'dist/mcp_server.js'},
  {bytes: 450_000, path: 'manager/app.js'},
];

let exceeded = false;
for (const budget of budgets) {
  const {size} = await stat(budget.path);
  const status = size <= budget.bytes ? 'OK' : 'OVER';
  console.log(`${status} ${budget.path}: ${size.toLocaleString()} / ${budget.bytes.toLocaleString()} bytes`);
  exceeded ||= size > budget.bytes;
}

if (exceeded) {
  process.exitCode = 1;
}
