import {Clock, Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {SystemInfo, type SystemInfoShape} from './effect/system.js';
import {compareVersions} from './version_compare.js';

const THREADNOTE_COMMAND = 'threadnote';
const PROCESS_LEASE_HEARTBEAT_MILLISECONDS = 30_000;
const PROCESS_LEASE_DIAGNOSTIC_SCAN_LIMIT = 1_024;
export const STANDALONE_RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface StandaloneActiveRelease {
  readonly releaseRoot: string;
  readonly version: string;
}

interface ProcessLeaseFile {
  readonly parentProcessId: Option.Option<number>;
  readonly processId: number;
  readonly processStartIdentity: Option.Option<string>;
  readonly startedAt: Option.Option<string>;
  readonly token: string;
  readonly version: string;
}

/**
 * Privacy-safe process evidence retained by standalone releases predating the
 * runtime process registry. Paths and ownership tokens intentionally never
 * leave this focused lease module.
 */
export interface StandaloneProcessLease {
  readonly parentProcessId: Option.Option<number>;
  readonly processId: number;
  readonly startedAt: Option.Option<string>;
  readonly version: string;
}

export interface StandaloneProcessLeaseDiagnostics {
  readonly leases: readonly StandaloneProcessLease[];
  readonly truncated: boolean;
}

interface ObservedStandaloneProcessLease extends StandaloneProcessLease {
  readonly identityVerified: boolean;
}

export function installationRoot(path: Path.Path, system: SystemInfoShape): string {
  const configured = system.environment().THREADNOTE_INSTALL_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const currentRoot = path.dirname(system.executablePath);
  if (path.basename(path.dirname(currentRoot)) === 'versions') {
    return path.dirname(path.dirname(currentRoot));
  }
  const localAppData = system.environment().LOCALAPPDATA;
  if (system.platform === 'win32' && localAppData) return path.join(localAppData, 'Threadnote');
  return path.join(system.homeDirectory, '.local', 'share', THREADNOTE_COMMAND);
}

/**
 * Pins the versioned standalone release for the full process lifetime. Worker
 * processes acquire their own lease so a killed parent cannot prune code that
 * a still-running child is executing.
 */
export function withStandaloneProcessLease<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      const root = installationRoot(path, system);
      const release = yield* readValidatedRelease(fs, path, path.dirname(system.executablePath), root);
      if (!release) return yield* effect;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const processStartIdentity = yield* system.processStartIdentity(system.processId);
      const leaseDirectory = path.join(root, 'leases', release.version);
      const leasePath = path.join(leaseDirectory, `${system.processId}.json`);
      yield* fs.makeDirectory(leaseDirectory, {recursive: true, mode: 0o700});
      yield* fs.writeFileString(
        leasePath,
        `${JSON.stringify(
          {
            executable: system.executablePath,
            parentProcessId: process.ppid,
            processId: system.processId,
            processStartIdentity,
            startedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
            token,
            version: release.version,
          },
          undefined,
          2,
        )}\n`,
        {mode: 0o600},
      );
      yield* Effect.addFinalizer(() => removeOwnedLease(fs, leasePath, token));
      yield* Effect.forkScoped(refreshProcessLease(fs, leasePath, token));
      return yield* effect;
    }),
  );
}

export function readValidatedRelease(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  releaseRoot: string,
  installRoot: string,
) {
  return fs.readFileString(path.join(releaseRoot, 'release.json')).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => {
          const value = JSON.parse(content) as unknown;
          if (
            typeof value !== 'object' ||
            value === null ||
            !('version' in value) ||
            typeof value.version !== 'string' ||
            !STANDALONE_RELEASE_VERSION_PATTERN.test(value.version)
          ) {
            return undefined;
          }
          const expectedRoot = path.resolve(path.join(installRoot, 'versions', value.version));
          const resolvedRoot = path.resolve(releaseRoot);
          return expectedRoot === resolvedRoot
            ? ({releaseRoot: resolvedRoot, version: value.version} satisfies StandaloneActiveRelease)
            : undefined;
        },
        catch: () => undefined,
      }),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

export const readLiveStandaloneProcessLeases = Effect.fn('installations.readLiveProcessLeases')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const scan = yield* liveStandaloneProcessLeases(
    fs,
    path,
    installationRoot(path, system),
    system,
    Option.some(PROCESS_LEASE_DIAGNOSTIC_SCAN_LIMIT),
  );
  const unique = new Map<number, StandaloneProcessLease>();
  // Pruning remains conservative when identity lookup is unavailable, but a
  // user-facing diagnostic must not label an unrelated reused PID as
  // Threadnote without a verified start identity.
  for (const lease of scan.leases
    .filter(lease => lease.identityVerified)
    .sort((left, right) => compareVersions(right.version, left.version))) {
    if (!unique.has(lease.processId)) unique.set(lease.processId, lease);
  }
  return {
    leases: [...unique.values()].sort((left, right) => left.processId - right.processId),
    truncated: scan.truncated,
  } satisfies StandaloneProcessLeaseDiagnostics;
});

export const liveReleaseLeaseVersions = Effect.fn('installations.liveLeaseVersions')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  installRoot: string,
  system: SystemInfoShape,
) {
  const scan = yield* liveStandaloneProcessLeases(fs, path, installRoot, system, Option.none());
  return [...new Set(scan.leases.map(lease => lease.version))];
});

const liveStandaloneProcessLeases = Effect.fn('installations.liveProcessLeases')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  installRoot: string,
  system: SystemInfoShape,
  scanLimit: Option.Option<number>,
) {
  const leasesRoot = path.join(installRoot, 'leases');
  if (!(yield* fs.exists(leasesRoot))) {
    return {leases: [] as readonly ObservedStandaloneProcessLease[], truncated: false};
  }
  const live: ObservedStandaloneProcessLease[] = [];
  let inspected = 0;
  let truncated = false;
  scan: for (const version of (yield* fs
    .readDirectory(leasesRoot)
    .pipe(Effect.catch(() => Effect.succeed([])))).sort()) {
    if (!STANDALONE_RELEASE_VERSION_PATTERN.test(version)) continue;
    const versionRoot = path.join(leasesRoot, version);
    for (const name of (yield* fs.readDirectory(versionRoot).pipe(Effect.catch(() => Effect.succeed([])))).sort()) {
      if (Option.isSome(scanLimit) && inspected >= scanLimit.value) {
        truncated = true;
        break scan;
      }
      inspected += 1;
      const processId = Number(/^([1-9]\d*)\.json$/.exec(name)?.[1]);
      const leasePath = path.join(versionRoot, name);
      const lease = yield* readProcessLease(fs, leasePath);
      const processIsRunning =
        Option.isSome(lease) &&
        lease.value.processId === processId &&
        lease.value.version === version &&
        Number.isSafeInteger(processId) &&
        processId > 0 &&
        system.isProcessRunning(processId);
      const currentProcessIdentity =
        processIsRunning && Option.isSome(lease) && Option.isSome(lease.value.processStartIdentity)
          ? yield* system.processStartIdentity(processId).pipe(Effect.catch(() => Effect.succeed(undefined)))
          : undefined;
      const identityMatches =
        Option.isSome(lease) &&
        (Option.isNone(lease.value.processStartIdentity) ||
          currentProcessIdentity === undefined ||
          currentProcessIdentity === lease.value.processStartIdentity.value);
      if (processIsRunning && identityMatches && Option.isSome(lease)) {
        live.push({
          identityVerified:
            Option.isSome(lease.value.processStartIdentity) &&
            currentProcessIdentity === lease.value.processStartIdentity.value,
          parentProcessId: lease.value.parentProcessId,
          processId,
          startedAt: lease.value.startedAt,
          version,
        });
      } else {
        yield* fs.remove(leasePath, {force: true}).pipe(Effect.catch(() => Effect.void));
      }
    }
  }
  return {leases: live, truncated};
});

function refreshProcessLease(fs: FileSystem.FileSystem, leasePath: string, token: string) {
  return Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(PROCESS_LEASE_HEARTBEAT_MILLISECONDS);
      const lease = yield* readLeaseToken(fs, leasePath);
      if (lease !== token) return;
      const now = new Date(yield* Clock.currentTimeMillis);
      yield* fs.utimes(leasePath, now, now);
    }
  }).pipe(Effect.catch(() => Effect.void));
}

function removeOwnedLease(fs: FileSystem.FileSystem, leasePath: string, token: string) {
  return Effect.gen(function* () {
    if ((yield* readLeaseToken(fs, leasePath)) === token) yield* fs.remove(leasePath, {force: true});
  }).pipe(Effect.catch(() => Effect.void));
}

function readLeaseToken(fs: FileSystem.FileSystem, leasePath: string) {
  return readProcessLease(fs, leasePath).pipe(
    Effect.map(Option.map(lease => lease.token)),
    Effect.map(Option.getOrUndefined),
  );
}

function readProcessLease(fs: FileSystem.FileSystem, leasePath: string) {
  return fs.readFileString(leasePath).pipe(
    Effect.map(content => {
      const value = JSON.parse(content) as unknown;
      if (
        typeof value !== 'object' ||
        value === null ||
        !('processId' in value) ||
        !('token' in value) ||
        !('version' in value) ||
        typeof value.processId !== 'number' ||
        !Number.isSafeInteger(value.processId) ||
        value.processId <= 0 ||
        typeof value.token !== 'string' ||
        typeof value.version !== 'string' ||
        !STANDALONE_RELEASE_VERSION_PATTERN.test(value.version) ||
        ('processStartIdentity' in value &&
          value.processStartIdentity !== undefined &&
          typeof value.processStartIdentity !== 'string')
      ) {
        return Option.none<ProcessLeaseFile>();
      }
      const parentProcessId =
        'parentProcessId' in value && Number.isSafeInteger(value.parentProcessId) && Number(value.parentProcessId) >= 0
          ? Option.some(Number(value.parentProcessId))
          : Option.none<number>();
      const processStartIdentity =
        'processStartIdentity' in value && typeof value.processStartIdentity === 'string'
          ? Option.some(value.processStartIdentity)
          : Option.none<string>();
      const startedAt =
        'startedAt' in value && typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))
          ? Option.some(value.startedAt)
          : Option.none<string>();
      return Option.some({
        parentProcessId,
        processId: value.processId,
        processStartIdentity,
        startedAt,
        token: value.token,
        version: value.version,
      } satisfies ProcessLeaseFile);
    }),
    Effect.catch(() => Effect.succeed(Option.none<ProcessLeaseFile>())),
  );
}
