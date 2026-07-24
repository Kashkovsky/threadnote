import {Effect, FileSystem, Path} from 'effect';

let cachedVersion: string | undefined;

/**
 * Returns the threadnote package version baked into this build. The bundled
 * ESM lives under `<install>/dist/`,
 * and the package's `files:` list ships `package.json` alongside `dist/`, so a
 * relative read from this module resolves the same metadata that npm sees.
 *
 * Returns `'unknown'` if the read fails (dev runs via tsx, or a damaged
 * install). Callers should treat `'unknown'` as a signal to skip whatever they
 * were about to do — there's no actionable comparison to make.
 */
export const getThreadnoteVersion = Effect.fn('version.getThreadnoteVersion')(function* () {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const modulePath = yield* pathService.fromFileUrl(new URL(import.meta.url));
  const packageJsonPath = pathService.join(pathService.dirname(modulePath), '..', 'package.json');
  cachedVersion = yield* fs.readFileString(packageJsonPath).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => JSON.parse(content) as {readonly version?: unknown},
        catch: () => undefined,
      }),
    ),
    Effect.map(parsed =>
      parsed && typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : 'unknown',
    ),
    Effect.catch(() => Effect.succeed('unknown')),
  );
  return cachedVersion;
});
