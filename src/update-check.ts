import {Effect, FileSystem, Path, Result} from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import {getJsonEffect} from './effect/http.js';
import {SystemInfo} from './effect/system.js';
import {selectUpdateChannel, type UpdateChannel} from './update_channel.js';
import {compareVersions, isJsonObject} from './utils.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/threadnote/';
const FETCH_TIMEOUT_MS = 3000;

interface UpdateCacheFile {
  readonly channel: UpdateChannel;
  readonly checkedAt: string;
  readonly latestVersion: string;
  readonly version: 2;
}

export interface UpdateCheckResult {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly outdated: boolean;
}

/**
 * Looks up the latest published threadnote version on npm and compares it to
 * `currentVersion`. Caches the registry response at `cachePath` for 24h so
 * subsequent calls within the same day are instant. On the first call of the
 * day the user pays a 0.5–3s network round-trip (bounded by
 * {@link FETCH_TIMEOUT_MS}); subsequent calls hit the cache.
 *
 * Returns `undefined` when the result is unactionable: the current version is
 * unknown (dev build), the network call failed and no cache is available, or
 * the registry returned malformed data. Never throws — callers can fire and
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
    const fresh = yield* fetchLatestVersionEffect(channel);
    if (fresh) {
      yield* writeUpdateCache(args.cachePath, {
        channel,
        checkedAt: new Date().toISOString(),
        latestVersion: fresh,
        version: 2 as const,
      });
      return toUpdateCheckResult(args.currentVersion, fresh);
    }
    return channelCache ? toUpdateCheckResult(args.currentVersion, channelCache.latestVersion) : undefined;
  });
}

/**
 * Spawns `threadnote update --yes` as a detached background process so the
 * current hook fire can return immediately. The child re-invokes the same
 * bundled CJS via the same node binary, inheriting nothing and writing to
 * /dev/null — its job is to swap the install in time for the next session.
 *
 * Best-effort: silently returns if the spawn fails (no node binary, permission
 * denied, etc.). The nag banner remains as the fallback signal.
 */
export const spawnDetachedAutoUpdate = Effect.fn('updateCheck.spawnDetachedAutoUpdate')(function* () {
  const system = yield* SystemInfo;
  const entry = system.processArguments[1];
  if (typeof entry !== 'string' || entry.length === 0) {
    return;
  }
  yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(system.executablePath, [entry, 'update', '--yes'], {
        detached: true,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      yield* child.unref;
    }),
  ).pipe(Effect.ignore);
});

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
      parsed.version !== 2 ||
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
      version: 2 as const,
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

const fetchLatestVersionEffect = Effect.fn('fetchLatestHookVersion')((channel: UpdateChannel) =>
  getJsonEffect(`${NPM_REGISTRY_URL}${channel}`, {
    headers: {accept: 'application/json'},
    timeoutMs: FETCH_TIMEOUT_MS,
  }).pipe(
    Effect.map(response =>
      isJsonObject(response.body) && typeof response.body.version === 'string' && response.body.version.length > 0
        ? response.body.version
        : undefined,
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  ),
);
