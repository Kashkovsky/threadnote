import {Effect, FileSystem} from 'effect';

export function makeIdempotentFixtureTempDirectoryScoped(fs: FileSystem.FileSystem, prefix: string) {
  return Effect.acquireRelease(fs.makeTempDirectory({prefix}), root =>
    fs.remove(root, {force: true, recursive: true}).pipe(Effect.orDie),
  );
}
