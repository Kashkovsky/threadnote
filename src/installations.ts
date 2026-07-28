import {Clock, Console, Crypto, Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from './effect/file_lock.js';
import {SystemInfo, type SystemInfoShape} from './effect/system.js';
import {compareVersions} from './utils.js';

const THREADNOTE_COMMAND = 'threadnote';
const ACTIVE_RELEASE_FILE = 'active-release.json';
const RETAINED_RELEASE_COUNT = 2;
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INSTALLATION_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 60_000,
  waitTimeoutMilliseconds: 10 * 60_000,
} as const;
const PROCESS_LEASE_HEARTBEAT_MILLISECONDS = 30_000;

interface ActiveRelease {
  readonly releaseRoot: string;
  readonly version: string;
}

interface ProcessLease {
  readonly processId: number;
  readonly processStartIdentity?: string;
  readonly token: string;
  readonly version: string;
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

export const activateStandaloneRelease = Effect.fn('installations.activateRelease')(function* (
  releaseRoot: string,
  dryRun: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = installationRoot(path, system);
  const release = yield* readValidatedRelease(fs, path, releaseRoot, root);
  if (!release) return;
  if (dryRun) {
    yield* Console.log(`Would mark standalone Threadnote ${release.version} as active.`);
    return;
  }
  const crypto = yield* Crypto.Crypto;
  const operationId = `${system.processId}-${yield* crypto.randomUUIDv4}`;
  yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  const activePath = path.join(root, ACTIVE_RELEASE_FILE);
  const backupPath = path.join(root, `.active-release.${operationId}.previous.json`);
  const temporaryPath = path.join(root, `.active-release.${operationId}.tmp.json`);
  yield* fs.remove(temporaryPath, {force: true});
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(release, undefined, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  const activeExists = yield* fs.exists(activePath);
  yield* fs.remove(backupPath, {force: true});
  if (activeExists) yield* fs.rename(activePath, backupPath);
  yield* fs
    .rename(temporaryPath, activePath)
    .pipe(
      Effect.catch(error =>
        activeExists ? fs.rename(backupPath, activePath).pipe(Effect.andThen(Effect.fail(error))) : Effect.fail(error),
      ),
    );
  yield* fs.remove(backupPath, {force: true});
});

export const activeInstalledVersion = Effect.fn('installations.activeVersion')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = installationRoot(path, system);
  const active = yield* readActiveRelease(fs, path.join(root, ACTIVE_RELEASE_FILE));
  if (!active) return undefined;
  const validated = yield* readValidatedRelease(fs, path, active.releaseRoot, root);
  if (validated?.version === active.version) return active.version;
  return undefined;
});

export const pruneStandaloneReleases = Effect.fn('installations.pruneReleases')(function* (
  activeReleaseRoot: string,
  dryRun: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = installationRoot(path, system);
  const expectedActive = yield* readValidatedRelease(fs, path, activeReleaseRoot, root);
  if (!expectedActive) return;
  const activePath = path.join(root, ACTIVE_RELEASE_FILE);
  const activePointerExists = yield* fs.exists(activePath);
  const activePointer = yield* readActiveRelease(fs, activePath);
  if (activePointerExists && !activePointer) {
    yield* Console.warn('WARN skipping release pruning because the active release pointer is invalid.');
    return;
  }
  const currentActive = activePointer
    ? yield* readValidatedRelease(fs, path, activePointer.releaseRoot, root)
    : undefined;
  if (activePointer && currentActive?.version !== activePointer.version) {
    yield* Console.warn('WARN skipping release pruning because the active release pointer is not valid.');
    return;
  }
  if (currentActive && currentActive.releaseRoot !== expectedActive.releaseRoot) {
    yield* Console.warn(
      `WARN skipping stale release pruning for ${expectedActive.version}; ${currentActive.version} is now active.`,
    );
    return;
  }
  const active = currentActive ?? expectedActive;
  const versionsRoot = path.join(root, 'versions');
  if (!(yield* fs.exists(versionsRoot))) return;
  const releases = (yield* Effect.forEach(yield* fs.readDirectory(versionsRoot), name =>
    readValidatedRelease(fs, path, path.join(versionsRoot, name), root),
  )).filter((release): release is ActiveRelease => release !== undefined);
  const keep = new Set<string>([active.version]);
  const running = yield* readValidatedRelease(fs, path, path.dirname(system.executablePath), root);
  if (running) keep.add(running.version);
  for (const version of yield* liveReleaseLeaseVersions(fs, path, root, system)) keep.add(version);
  for (const release of releases.sort((left, right) => compareVersions(right.version, left.version))) {
    if (keep.size >= RETAINED_RELEASE_COUNT) break;
    keep.add(release.version);
  }
  for (const release of releases) {
    if (keep.has(release.version)) continue;
    if (dryRun) {
      yield* Console.log(`Would remove superseded standalone release: ${release.releaseRoot}`);
    } else {
      yield* fs.remove(release.releaseRoot, {recursive: true}).pipe(
        Effect.tap(() => Console.log(`Removed superseded standalone release: ${release.releaseRoot}`)),
        Effect.catch(cause =>
          Console.warn(`WARN could not remove superseded standalone release ${release.releaseRoot}: ${String(cause)}`),
        ),
      );
    }
  }
});

export function withStandaloneInstallationLock<A, E, R>(effect: Effect.Effect<A, E, R>, dryRun = false) {
  if (dryRun) return effect;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const lockPath = path.join(installationRoot(path, system), '.installation.lock');
    return yield* withExclusiveFileLock(fs, lockPath, INSTALLATION_LOCK_OPTIONS, effect);
  });
}

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

function readActiveRelease(fs: FileSystem.FileSystem, file: string) {
  return fs.readFileString(file).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => {
          const value = JSON.parse(content) as unknown;
          if (
            typeof value !== 'object' ||
            value === null ||
            !('releaseRoot' in value) ||
            !('version' in value) ||
            typeof value.releaseRoot !== 'string' ||
            typeof value.version !== 'string'
          ) {
            return undefined;
          }
          return {releaseRoot: value.releaseRoot, version: value.version} satisfies ActiveRelease;
        },
        catch: () => undefined,
      }),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

function readValidatedRelease(fs: FileSystem.FileSystem, path: Path.Path, releaseRoot: string, installRoot: string) {
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
            !RELEASE_VERSION_PATTERN.test(value.version)
          ) {
            return undefined;
          }
          const expectedRoot = path.resolve(path.join(installRoot, 'versions', value.version));
          const resolvedRoot = path.resolve(releaseRoot);
          return expectedRoot === resolvedRoot
            ? ({releaseRoot: resolvedRoot, version: value.version} satisfies ActiveRelease)
            : undefined;
        },
        catch: () => undefined,
      }),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

const liveReleaseLeaseVersions = Effect.fn('installations.liveLeaseVersions')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  installRoot: string,
  system: SystemInfoShape,
) {
  const leasesRoot = path.join(installRoot, 'leases');
  if (!(yield* fs.exists(leasesRoot))) return [] as readonly string[];
  const live = new Set<string>();
  for (const version of yield* fs.readDirectory(leasesRoot)) {
    if (!RELEASE_VERSION_PATTERN.test(version)) continue;
    const versionRoot = path.join(leasesRoot, version);
    for (const name of yield* fs.readDirectory(versionRoot).pipe(Effect.catch(() => Effect.succeed([])))) {
      const processId = Number(/^([1-9]\d*)\.json$/.exec(name)?.[1]);
      const leasePath = path.join(versionRoot, name);
      const lease = yield* readProcessLease(fs, leasePath);
      const processIsRunning =
        lease?.processId === processId &&
        lease.version === version &&
        Number.isSafeInteger(processId) &&
        processId > 0 &&
        system.isProcessRunning(processId);
      const currentProcessIdentity =
        processIsRunning && lease?.processStartIdentity ? yield* system.processStartIdentity(processId) : undefined;
      const identityMatches =
        !lease?.processStartIdentity ||
        currentProcessIdentity === undefined ||
        currentProcessIdentity === lease.processStartIdentity;
      if (processIsRunning && identityMatches) {
        live.add(version);
      } else {
        yield* fs.remove(leasePath, {force: true}).pipe(Effect.catch(() => Effect.void));
      }
    }
  }
  return [...live];
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
  return readProcessLease(fs, leasePath).pipe(Effect.map(lease => lease?.token));
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
        !RELEASE_VERSION_PATTERN.test(value.version) ||
        ('processStartIdentity' in value &&
          value.processStartIdentity !== undefined &&
          typeof value.processStartIdentity !== 'string')
      ) {
        return undefined;
      }
      return {
        processId: value.processId,
        processStartIdentity:
          'processStartIdentity' in value ? (value.processStartIdentity as string | undefined) : undefined,
        token: value.token,
        version: value.version,
      } satisfies ProcessLease;
    }),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}
