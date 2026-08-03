import {existsSync, writeFileSync} from 'node:fs';
import {Effect} from 'effect';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

const [repository, home, releaseGate, marker] = process.argv.slice(2);
if (!repository || !home || !releaseGate || !marker) {
  throw new Error('Expected repository, home, release gate, and marker arguments.');
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
          if (progress.phase !== 'scanning' || progress.completed !== 0) return;
          writeFileSync(`${marker}.scanning`, 'scanning\n');
          while (!existsSync(releaseGate)) yield* Effect.sleep(25);
        }),
      threadnoteHome: home,
    });
  }).pipe(Effect.provide(ApplicationLayer)),
);

process.stdout.write(`${JSON.stringify({summary, type: 'summary'})}\n`);
