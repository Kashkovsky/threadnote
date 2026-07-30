import {Effect, FileSystem} from 'effect';

export function syncWritableFile(fs: FileSystem.FileSystem, target: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      // Windows requires a writable handle for FlushFileBuffers, which backs fsync.
      const file = yield* fs.open(target, {flag: 'r+'});
      yield* file.sync;
    }),
  );
}

export function syncDirectoryBestEffort(fs: FileSystem.FileSystem, directory: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(directory, {flag: 'r'});
      yield* handle.sync;
    }),
  ).pipe(Effect.catch(() => Effect.void));
}
