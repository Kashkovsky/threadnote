import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Path} from 'effect';

const clean = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(path.resolve(import.meta.dirname, '..', 'dist'), {force: true, recursive: true});
});

BunRuntime.runMain(clean.pipe(Effect.provide(BunServices.layer)));
