import {Effect, FileSystem, Path, Predicate} from 'effect';

let cachedVersion: string | undefined;

export function isStandaloneThreadnoteBuild(): boolean {
  return typeof THREADNOTE_STANDALONE !== 'undefined' && THREADNOTE_STANDALONE;
}

export const getThreadnoteVersion = Effect.fn('version.getThreadnoteVersion')(function* () {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  if (typeof THREADNOTE_VERSION !== 'undefined') {
    cachedVersion = THREADNOTE_VERSION;
    return cachedVersion;
  }
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const modulePath = yield* pathService.fromFileUrl(new URL(import.meta.url));
  const packageJsonPath = pathService.join(pathService.dirname(modulePath), '..', '..', 'package.json');
  cachedVersion = yield* fs.readFileString(packageJsonPath).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: (): unknown => JSON.parse(content),
        catch: () => undefined,
      }),
    ),
    Effect.map(packageVersion),
    Effect.catch(() => Effect.succeed('unknown')),
  );
  return cachedVersion;
});

function packageVersion(value: unknown): string {
  if (!Predicate.isObject(value)) return 'unknown';
  const version = value.version;
  return typeof version === 'string' && version.length > 0 ? version : 'unknown';
}
