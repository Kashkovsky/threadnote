import {Effect} from 'effect';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

const [repository, home, marker] = process.argv.slice(2);
if (!repository || !home || !marker) {
  throw new Error('Expected repository, Threadnote home, and marker arguments.');
}

let paused = false;
await Effect.runPromise(
  Effect.gen(function* () {
    const indexer = yield* CodeGraphIndexer;
    yield* indexer.index({
      cwd: repository,
      incrementalOverlay: false,
      onProgress: progress => {
        if (paused || progress.phase !== 'materializing' || progress.activity?.stage !== 'committing') {
          return Effect.void;
        }
        const metrics = progress.metrics;
        if (metrics === undefined || metrics.batchesCompleted < 1) return Effect.void;
        paused = true;
        return Effect.promise(async () => {
          await Bun.write(
            marker,
            JSON.stringify({
              batchesCompleted: metrics.batchesCompleted,
              batchesTotal: metrics.batchesTotal,
              snapshotMode: metrics.storage?.materializationMode,
            }),
          );
          await new Promise<void>(() => {});
        });
      },
      threadnoteHome: home,
    });
  }).pipe(Effect.provide(ApplicationLayer)),
);
