import {Effect, FileSystem, Option, Path} from 'effect';

const MAX_MIGRATION_EVIDENCE_DIRECTORIES = 256;

/**
 * Distinguishes an empty directory scaffold from migration-worthy content
 * without allowing eligibility checks to traverse an unbounded tree. Unsafe
 * entries and trees beyond the directory budget are treated conservatively as
 * material so the apply path can validate them properly.
 */
export const hasBoundedMigrationTreeContent = Effect.fn('migration.hasBoundedTreeContent')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  include: (candidate: string) => boolean = () => true,
) {
  const directories = [root];
  for (let index = 0; index < directories.length; index += 1) {
    if (index >= MAX_MIGRATION_EVIDENCE_DIRECTORIES) return true;
    const directory = directories[index]!;
    for (const name of yield* fs.readDirectory(directory)) {
      const candidate = path.join(directory, name);
      if (!include(candidate)) continue;
      if (Option.isSome(yield* fs.readLink(candidate).pipe(Effect.option))) return true;
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== 'Directory') return true;
      directories.push(candidate);
      if (directories.length > MAX_MIGRATION_EVIDENCE_DIRECTORIES) return true;
    }
  }
  return false;
});
