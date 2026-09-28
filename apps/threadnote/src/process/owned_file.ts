import {Effect, type FileSystem} from 'effect';

export function linkMissingProcessFile(fs: FileSystem.FileSystem, source: string, file: string) {
  return fs.link(source, file).pipe(
    Effect.as(true),
    Effect.catchIf(
      error => error.reason._tag === 'AlreadyExists',
      () => Effect.succeed(false),
    ),
  );
}

export function createMissingProcessFile(fs: FileSystem.FileSystem, file: string, temporary: string, content: string) {
  return Effect.gen(function* () {
    yield* fs.writeFileString(temporary, content, {mode: 0o600});
    // Exclusive open exposes an empty record before writing; link publishes the complete inode.
    return yield* linkMissingProcessFile(fs, temporary, file);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
}
