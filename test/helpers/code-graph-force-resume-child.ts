import {TestError} from './test-error.js';
import {provideTestLayer} from './effect-layer.js';
import {Effect} from 'effect';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

const [repository, home, marker] = process.argv.slice(2);
if (!repository || !home || !marker) {
  throw TestError.make({message: 'Expected repository, Threadnote home, and marker arguments.'});
}

let paused = false;
await Effect.runPromise(
  Effect.gen(function* () {
    const indexer = yield* CodeGraphIndexer;
    yield* indexer.index({
      cwd: repository,
      force: true,
      persistentMaterializationTransactionBatchLimit: 1,
      onProgress: progress => {
        if (paused || progress.phase !== 'materializing' || progress.activity?.stage !== 'committing') {
          return Effect.void;
        }
        const metrics = progress.metrics;
        if (metrics === undefined || metrics.batchesCompleted !== 1 || metrics.batchesTotal <= 1) return Effect.void;
        paused = true;
        return Effect.promise(async () => {
          await Bun.write(
            marker,
            JSON.stringify({
              batchesCompleted: metrics.batchesCompleted,
              batchTotal: metrics.batchesTotal,
              completed: progress.completed,
              factsBytesCompleted: metrics.factsBytesCompleted,
              factsBytesTotal: metrics.factsBytesTotal,
            }),
          );
          await new Promise<void>(() => {});
        });
      },
      threadnoteHome: home,
    });
  }).pipe(provideTestLayer(ApplicationLayer)),
);
