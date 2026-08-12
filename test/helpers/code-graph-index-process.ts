import {TestError} from './test-error.js';
import {provideTestLayer} from './effect-layer.js';
import {existsSync, writeFileSync} from './node-fs.js';
import {Effect} from 'effect';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

const [repository, home, releaseGate, marker] = process.argv.slice(2);
if (!repository || !home || !releaseGate || !marker) {
  throw new TestError('Expected repository, home, release gate, and marker arguments.');
}

const summary = await Effect.runPromise(
  Effect.gen(function* () {
    const indexer = yield* CodeGraphIndexer;
    return yield* indexer.index({
      cwd: repository,
      onProgress: progress =>
        Effect.gen(function* () {
          process.stdout.write(`${JSON.stringify({progress, type: 'progress'})}\n`);
          if (progress.phase === 'waiting') writeFileSync(`${marker}.waiting`, 'waiting\n');
          if (progress.phase !== 'scanning' || existsSync(`${marker}.scanning`)) return;
          writeFileSync(`${marker}.scanning`, 'scanning\n');
          while (!existsSync(releaseGate)) yield* Effect.sleep(25);
        }),
      threadnoteHome: home,
    });
  }).pipe(provideTestLayer(ApplicationLayer)),
);

process.stdout.write(`${JSON.stringify({summary, type: 'summary'})}\n`);
