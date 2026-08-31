import {Effect, FileSystem, Path, Result} from 'effect';
import {SystemInfo} from '../effect/system.js';
import {selectUpdateChannel, type UpdateChannel} from './channel.js';
import {fetchLatestVersion, releaseSource} from './index.js';
import {compareVersions} from '../utils.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

interface UpdateCacheFile {
  readonly channel: UpdateChannel;
  readonly checkedAt: string;
  readonly latestVersion: string;
  readonly version: 3;
}

export interface UpdateCheckResult {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly outdated: boolean;
}

/**
 * Looks up the latest standalone Threadnote GitHub release and compares it to
 * `currentVersion`. Caches the release response at `cachePath` for 24h so
 * subsequent calls within the same day are instant. On the first call of the
 * day the user pays a 0.5–3s network round-trip (bounded by
 * {@link FETCH_TIMEOUT_MS}); subsequent calls hit the cache.
 *
 * Returns `undefined` when the result is unactionable: the current version is
 * unknown (dev build), the network call failed and no cache is available, or
 * the release source returned malformed data. Never throws — callers can fire and
 * forget without wrapping in try/catch.
 */
export function checkForThreadnoteUpdate(args: {readonly cachePath: string; readonly currentVersion: string}) {
  if (args.currentVersion === 'unknown') {
    return Effect.succeed(undefined);
  }
  return Effect.gen(function* () {
    const channel = selectUpdateChannel(args.currentVersion);
    const cached = yield* readUpdateCache(args.cachePath);
    const channelCache = cached?.channel === channel ? cached : undefined;
    if (channelCache && isCacheFresh(channelCache)) {
      return toUpdateCheckResult(args.currentVersion, channelCache.latestVersion);
    }
    const system = yield* SystemInfo;
    const fresh = yield* fetchLatestVersion(releaseSource(system.environment()), channel).pipe(
      Effect.timeout(FETCH_TIMEOUT_MS),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (fresh) {
      yield* writeUpdateCache(args.cachePath, {
        channel,
        checkedAt: new Date().toISOString(),
        latestVersion: fresh,
        version: 3 as const,
      });
      return toUpdateCheckResult(args.currentVersion, fresh);
    }
    return channelCache ? toUpdateCheckResult(args.currentVersion, channelCache.latestVersion) : undefined;
  });
}

function toUpdateCheckResult(currentVersion: string, latestVersion: string): UpdateCheckResult {
  return {
    currentVersion,
    latestVersion,
    outdated: compareVersions(latestVersion, currentVersion) > 0,
  };
}

function isCacheFresh(cache: UpdateCacheFile): boolean {
  const checkedAt = new Date(cache.checkedAt).getTime();
  return Number.isFinite(checkedAt) && Date.now() - checkedAt < CACHE_TTL_MS;
}

const readUpdateCache = Effect.fn('updateCheck.readCache')((cachePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(cachePath);
    const parsedResult = Result.try(() => JSON.parse(raw) as Partial<UpdateCacheFile>);
    if (Result.isFailure(parsedResult)) {
      return undefined;
    }
    const parsed = parsedResult.success;
    if (
      parsed.version !== 3 ||
      (parsed.channel !== 'beta' && parsed.channel !== 'latest') ||
      typeof parsed.latestVersion !== 'string' ||
      typeof parsed.checkedAt !== 'string'
    ) {
      return undefined;
    }
    return {
      channel: parsed.channel,
      checkedAt: parsed.checkedAt,
      latestVersion: parsed.latestVersion,
      version: 3 as const,
    };
  }).pipe(Effect.catch(() => Effect.succeed(undefined))),
);

const writeUpdateCache = Effect.fn('updateCheck.writeCache')((cachePath: string, contents: UpdateCacheFile) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(cachePath), {recursive: true});
    yield* fs.writeFileString(cachePath, `${JSON.stringify(contents)}\n`, {mode: 0o600});
  }).pipe(Effect.ignore),
);
