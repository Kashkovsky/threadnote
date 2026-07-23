import {NodeRuntime, NodeServices} from '@effect/platform-node';
import {Effect, FileSystem, Path} from 'effect';

const clean = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(path.resolve(import.meta.dirname, '..', 'dist'), {force: true, recursive: true});
});

NodeRuntime.runMain(clean.pipe(Effect.provide(NodeServices.layer)));
