import {TestError} from './test-error.js';
import {provideTestLayer} from './effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Path} from 'effect';
import {startExternalSampler} from '../../scripts/benchmark-code-graph.js';

const [root, checkpointPath, readyMarker] = process.argv.slice(2);
if (!root || !checkpointPath || !readyMarker) {
  throw new TestError('Expected sampler root, checkpoint path, and ready marker.');
}

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* startExternalSampler(
      fs,
      path,
      path.join(root, 'sampler'),
      path.join(root, 'sqlite-temp'),
      path.join(root, 'not-created.sqlite'),
      checkpointPath,
      'bootstrap',
    );
    yield* fs.writeFileString(readyMarker, 'ready\n');
    return yield* Effect.never;
  }).pipe(provideTestLayer(BunServices.layer)),
);
