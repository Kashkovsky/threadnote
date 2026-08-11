import {TestError} from './test-error.js';
import {provideTestLayer} from './effect-layer.js';
import {Effect} from 'effect';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

const [repository, home, marker, transactionMode] = process.argv.slice(2);
if (!repository || !home || !marker) {
  throw new TestError('Expected repository, Threadnote home, and marker arguments.');
}
if (transactionMode !== undefined && transactionMode !== 'single') {
  throw new TestError('Transaction mode must be omitted or single.');
}

let paused = false;
await Effect.runPromise(
  Effect.gen(function* () {
    const indexer = yield* CodeGraphIndexer;
    yield* indexer.index({
      cwd: repository,
      incrementalOverlay: false,
      ...(transactionMode === 'single' ? {persistentMaterializationTransactionBatchLimit: 1 as const} : {}),
      onProgress: progress => {
        if (paused || progress.phase !== 'materializing' || progress.activity?.stage !== 'committing') {
          return Effect.void;
        }
        const metrics = progress.metrics;
        if (metrics === undefined) return Effect.void;
        const reachedInterruptionPoint =
          transactionMode === 'single'
            ? metrics.batchesCompleted >= 1
            : metrics.batchesCompleted === 0 && progress.activity.batchCompleted >= 1;
        if (!reachedInterruptionPoint) {
          return Effect.void;
        }
        paused = true;
        return Effect.promise(async () => {
          await Bun.write(
            marker,
            JSON.stringify({
              batchCompleted: progress.activity!.batchCompleted,
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
  }).pipe(provideTestLayer(ApplicationLayer)),
);
