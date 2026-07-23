import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import {Console, Effect, FileSystem} from 'effect';

const budgets = [
  {bytes: 1_750_000, path: 'dist/threadnote.js'},
  {bytes: 1_800_000, path: 'dist/mcp_server.js'},
  {bytes: 450_000, path: 'manager/app.js'},
];

const checkBundleSizes = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  let exceeded = false;
  for (const budget of budgets) {
    const {size} = yield* fs.stat(budget.path);
    const status = size <= budget.bytes ? 'OK' : 'OVER';
    yield* Console.log(`${status} ${budget.path}: ${size.toLocaleString()} / ${budget.bytes.toLocaleString()} bytes`);
    exceeded ||= size > budget.bytes;
  }
  if (exceeded) {
    return yield* Effect.fail(new Error('Bundle size budget exceeded.'));
  }
});

NodeRuntime.runMain(checkBundleSizes.pipe(Effect.provide(NodeServices.layer)));
