import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from './effect-layer.js';
import {existsSync, writeFileSync} from '@threadnote/testing/node-fs';
import {Effect} from 'effect';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

const [repository, home, releaseGate, marker] = process.argv.slice(2);
if (!repository || !home || !releaseGate || !marker) {
  throw TestError.make({message: 'Expected repository, home, release gate, and marker arguments.'});
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
