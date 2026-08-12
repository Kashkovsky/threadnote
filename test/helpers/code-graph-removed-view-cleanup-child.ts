import {provideTestLayer} from './effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer} from 'effect';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {SystemInfo} from '../../src/effect/system.js';

const [databasePath, nowText, markerPath] = process.argv.slice(2);
const validPath = (value: string | undefined) => value !== undefined && value.length > 0 && !value.includes('\0');
if (!validPath(databasePath) || !validPath(markerPath) || !/^[0-9]+$/u.test(nowText ?? '')) {
  process.stderr.write('invalid removed-view-cleanup child arguments\n');
  process.exit(2);
}

const now = Number(nowText);
if (!Number.isSafeInteger(now)) {
  process.stderr.write('invalid removed-view-cleanup child time\n');
  process.exit(2);
}

const childLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(Layer.merge(BunServices.layer, SystemInfo.layer)));

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const store = yield* CodeGraphStore;
  const claimed = yield* store.claimRemovedViewCleanupCandidates(databasePath!, now, 32, {
    waitTimeoutMilliseconds: 30_000,
  });
  const marker = JSON.stringify({
    event: 'claim-committed',
    processId: process.pid,
    revisions: claimed.map(entry => entry.revision),
    worktreeIds: claimed.map(entry => entry.worktreeId),
  });
  yield* fs.writeFileString(markerPath!, marker, {flag: 'wx', mode: 0o600});
  process.stdout.write(`${marker}\n`);
  // A pending Effect alone does not retain Bun's event loop. Keep a live,
  // bounded timer handle until the parent exercises post-commit SIGKILL.
  for (;;) yield* Effect.sleep(60_000);
}).pipe(provideTestLayer(childLayer));

Effect.runPromise(program).catch(cause => {
  process.stderr.write(`removed-view-cleanup child failed: ${cause instanceof Error ? cause.name : 'unknown'}\n`);
  process.exitCode = 1;
});
