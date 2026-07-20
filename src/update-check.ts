import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Effect} from 'effect';
import {getJsonEffect} from './effect/http.js';
import {fromPromiseError} from './effect/errors.js';
import {compareVersions, isJsonObject} from './utils.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NPM_LATEST_URL = 'https://registry.npmjs.org/threadnote/latest';
const FETCH_TIMEOUT_MS = 3000;

interface UpdateCacheFile {
  readonly checkedAt: string;
  readonly latestVersion: string;
  readonly version: 1;
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
    const cached = yield* fromPromiseError(() => readUpdateCache(args.cachePath));
    if (cached && isCacheFresh(cached)) {
      return toUpdateCheckResult(args.currentVersion, cached.latestVersion);
    }
    const fresh = yield* fetchLatestVersionEffect();
    if (fresh) {
      yield* fromPromiseError(() =>
        writeUpdateCache(args.cachePath, {
          checkedAt: new Date().toISOString(),
          latestVersion: fresh,
          version: 1,
        }),
      );
      return toUpdateCheckResult(args.currentVersion, fresh);
    }
    return cached ? toUpdateCheckResult(args.currentVersion, cached.latestVersion) : undefined;
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
export function spawnDetachedAutoUpdate(): void {
  try {
    const entry = process.argv[1];
    if (typeof entry !== 'string' || entry.length === 0) {
      return;
    }
    const child = spawn(process.execPath, [entry, 'update', '--yes'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // Best-effort.
  }
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

async function readUpdateCache(cachePath: string): Promise<UpdateCacheFile | undefined> {
  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UpdateCacheFile>;
    if (parsed.version !== 1 || typeof parsed.latestVersion !== 'string' || typeof parsed.checkedAt !== 'string') {
      return undefined;
    }
    return {checkedAt: parsed.checkedAt, latestVersion: parsed.latestVersion, version: 1};
  } catch {
    return undefined;
  }
}

async function writeUpdateCache(cachePath: string, contents: UpdateCacheFile): Promise<void> {
  try {
    await mkdir(dirname(cachePath), {recursive: true});
    await writeFile(cachePath, `${JSON.stringify(contents)}\n`, {encoding: 'utf8', mode: 0o600});
  } catch {
    // Best-effort: a missing cache just means the next call refetches.
  }
}

const fetchLatestVersionEffect = Effect.fn('fetchLatestHookVersion')(() =>
  getJsonEffect(NPM_LATEST_URL, {headers: {accept: 'application/json'}, timeoutMs: FETCH_TIMEOUT_MS}).pipe(
    Effect.map(response =>
      isJsonObject(response.body) && typeof response.body.version === 'string' && response.body.version.length > 0
        ? response.body.version
        : undefined,
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  ),
);
