import {Clock, Console, Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {syncDirectoryBestEffort, syncWritableFile} from './effect/file_durability.js';
import {withExclusiveFileLock} from './effect/file_lock.js';
import {SystemInfo, type SystemInfoShape} from './effect/system.js';
import {compareVersions} from './utils.js';

const THREADNOTE_COMMAND = 'threadnote';
const ACTIVE_RELEASE_FILE = 'active-release.json';
const ACTIVE_RELEASE_BACKUP_FILE = 'active-release.previous.json';
const ACTIVE_RELEASE_JOURNAL_FILE = 'active-release.promotion.json';
const PROMOTION_JOURNAL_VERSION = 1 as const;
const RETAINED_RELEASE_COUNT = 2;
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INSTALLATION_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 60_000,
  waitTimeoutMilliseconds: 10 * 60_000,
} as const;
const PROCESS_LEASE_HEARTBEAT_MILLISECONDS = 30_000;
const PROCESS_LEASE_DIAGNOSTIC_SCAN_LIMIT = 1_024;

interface ActiveRelease {
  readonly releaseRoot: string;
  readonly version: string;
}

interface ActiveReleasePromotion {
  readonly activePath: string;
  readonly backupPath: string;
  readonly temporaryPath: string;
  readonly version: typeof PROMOTION_JOURNAL_VERSION;
}

interface ReleaseDirectoryPromotion {
  readonly backupRoot: string;
  readonly releaseRoot: string;
  readonly stagedRoot: string;
  readonly version: typeof PROMOTION_JOURNAL_VERSION;
}

export type StandalonePromotionStep =
  | 'active-journaled'
  | 'active-previous-backed-up'
  | 'active-promoted'
  | 'release-journaled'
  | 'release-previous-backed-up'
  | 'release-promoted';

export interface StandalonePromotionFaultInjection {
  readonly afterStep?: (step: StandalonePromotionStep) => Effect.Effect<void, unknown>;
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
 * leave the installation module.
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

export const activateStandaloneRelease = Effect.fn('installations.activateRelease')(function* (
  releaseRoot: string,
  dryRun: boolean,
  faultInjection: StandalonePromotionFaultInjection = {},
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
  yield* recoverActiveReleasePromotion(fs, path, root);
  const crypto = yield* Crypto.Crypto;
  const operationId = `${system.processId}-${yield* crypto.randomUUIDv4}`;
  yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  const activePath = path.join(root, ACTIVE_RELEASE_FILE);
  const backupPath = path.join(root, ACTIVE_RELEASE_BACKUP_FILE);
  const journalPath = path.join(root, ACTIVE_RELEASE_JOURNAL_FILE);
  const temporaryPath = path.join(root, `.active-release.${operationId}.next.json`);
  yield* fs.remove(temporaryPath, {force: true});
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(release, undefined, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  yield* syncWritableFile(fs, temporaryPath);
  yield* writePrivateJsonAtomically(fs, path, journalPath, {
    activePath,
    backupPath,
    temporaryPath,
    version: PROMOTION_JOURNAL_VERSION,
  } satisfies ActiveReleasePromotion);
  yield* faultInjection.afterStep?.('active-journaled') ?? Effect.void;
  const activeExists = yield* fs.exists(activePath);
  yield* fs.remove(backupPath, {force: true});
  if (activeExists) {
    yield* fs.rename(activePath, backupPath);
    yield* syncDirectoryBestEffort(fs, root);
  }
  yield* faultInjection.afterStep?.('active-previous-backed-up') ?? Effect.void;
  yield* fs
    .rename(temporaryPath, activePath)
    .pipe(
      Effect.catch(error => recoverActiveReleasePromotion(fs, path, root).pipe(Effect.andThen(Effect.fail(error)))),
    );
  yield* syncDirectoryBestEffort(fs, root);
  yield* faultInjection.afterStep?.('active-promoted') ?? Effect.void;
  yield* fs.remove(backupPath, {force: true});
  yield* fs.remove(journalPath, {force: true});
  yield* syncDirectoryBestEffort(fs, root);
});

export const promoteStandaloneReleaseDirectory = Effect.fn('installations.promoteReleaseDirectory')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  stagedRoot: string,
  releaseRoot: string,
  processId: number,
  faultInjection: StandalonePromotionFaultInjection = {},
) {
  const resolvedReleaseRoot = path.resolve(releaseRoot);
  const versionsRoot = path.dirname(resolvedReleaseRoot);
  const releaseName = path.basename(resolvedReleaseRoot);
  if (!RELEASE_VERSION_PATTERN.test(releaseName)) {
    return yield* Effect.fail(new Error(`Cannot promote an invalid standalone release path: ${releaseRoot}`));
  }
  const resolvedStagedRoot = path.resolve(stagedRoot);
  if (!isStandaloneStagingPath(path, versionsRoot, releaseName, resolvedStagedRoot)) {
    return yield* Effect.fail(
      new Error(`Standalone release staging path is not recognized within ${versionsRoot}: ${stagedRoot}`),
    );
  }
  yield* recoverStandaloneReleasePromotion(fs, path, resolvedReleaseRoot);
  const backupRoot = releasePromotionBackupPath(path, resolvedReleaseRoot);
  const journalPath = releasePromotionJournalPath(path, resolvedReleaseRoot);
  yield* fs.remove(backupRoot, {force: true, recursive: true});
  yield* writePrivateJsonAtomically(fs, path, journalPath, {
    backupRoot,
    releaseRoot: resolvedReleaseRoot,
    stagedRoot: resolvedStagedRoot,
    version: PROMOTION_JOURNAL_VERSION,
  } satisfies ReleaseDirectoryPromotion);
  yield* faultInjection.afterStep?.('release-journaled') ?? Effect.void;
  if (yield* fs.exists(resolvedReleaseRoot)) {
    yield* fs.rename(resolvedReleaseRoot, backupRoot);
    yield* syncDirectoryBestEffort(fs, versionsRoot);
  }
  yield* faultInjection.afterStep?.('release-previous-backed-up') ?? Effect.void;
  yield* fs
    .rename(resolvedStagedRoot, resolvedReleaseRoot)
    .pipe(
      Effect.catch(error =>
        recoverStandaloneReleasePromotion(fs, path, resolvedReleaseRoot).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
  yield* syncDirectoryBestEffort(fs, versionsRoot);
  yield* faultInjection.afterStep?.('release-promoted') ?? Effect.void;
  yield* fs.remove(backupRoot, {force: true, recursive: true});
  yield* fs.remove(journalPath, {force: true});
  yield* syncDirectoryBestEffort(fs, versionsRoot);
  void processId;
});

export const recoverStandaloneReleasePromotion = Effect.fn('installations.recoverReleasePromotion')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  releaseRoot: string,
) {
  const resolvedReleaseRoot = path.resolve(releaseRoot);
  const journalPath = releasePromotionJournalPath(path, resolvedReleaseRoot);
  const journalExists = yield* fs.exists(journalPath);
  const promotion = journalExists
    ? yield* readReleaseDirectoryPromotion(fs, path, journalPath, resolvedReleaseRoot)
    : undefined;
  const backupRoot = releasePromotionBackupPath(path, resolvedReleaseRoot);
  const bootstrapStagedRoot = path.join(
    path.dirname(resolvedReleaseRoot),
    `.${path.basename(resolvedReleaseRoot)}.bootstrap.staging`,
  );
  const releaseExists = yield* fs.exists(resolvedReleaseRoot);
  const backupExists = yield* fs.exists(backupRoot);
  const bootstrapStagingExists = yield* fs.exists(bootstrapStagedRoot);
  if (!releaseExists && backupExists) {
    yield* fs.rename(backupRoot, resolvedReleaseRoot);
  } else if (releaseExists && backupExists) {
    yield* fs.remove(backupRoot, {force: true, recursive: true});
  }
  if (promotion) {
    yield* fs.remove(standaloneStagingCleanupRoot(path, path.dirname(resolvedReleaseRoot), promotion.stagedRoot), {
      force: true,
      recursive: true,
    });
  }
  if (bootstrapStagingExists && promotion?.stagedRoot !== bootstrapStagedRoot) {
    yield* fs.remove(bootstrapStagedRoot, {force: true, recursive: true});
  }
  if (journalExists) yield* fs.remove(journalPath, {force: true});
  if (!journalExists && !backupExists && !bootstrapStagingExists) return false;
  yield* syncDirectoryBestEffort(fs, path.dirname(resolvedReleaseRoot));
  return true;
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
    const root = installationRoot(path, system);
    const lockPath = path.join(root, '.installation.lock');
    return yield* withExclusiveFileLock(
      fs,
      lockPath,
      INSTALLATION_LOCK_OPTIONS,
      recoverStandaloneInstallationState(fs, path, root).pipe(Effect.andThen(effect)),
    );
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

const recoverStandaloneInstallationState = Effect.fn('installations.recoverState')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) {
  yield* recoverActiveReleasePromotion(fs, path, root);
  for (const name of yield* fs.readDirectory(root)) {
    if (/^\.active-release\.[0-9]+-[0-9a-f-]+\.next\.json$/i.test(name)) {
      yield* fs.remove(path.join(root, name), {force: true});
    }
  }
  const versionsRoot = path.join(root, 'versions');
  if (!(yield* fs.exists(versionsRoot))) return;
  const names = (yield* fs.readDirectory(versionsRoot)).sort();
  for (const name of names) {
    const match = /^\.([0-9A-Za-z.-]+)\.(?:promotion(?:\.json|-backup)|bootstrap\.staging)$/.exec(name);
    const version = match?.[1];
    if (!version || !RELEASE_VERSION_PATTERN.test(version)) continue;
    yield* recoverStandaloneReleasePromotion(fs, path, path.join(versionsRoot, version));
  }
  for (const name of names) {
    if (/^\.threadnote-update-[0-9A-Za-z._-]+$/.test(name)) {
      yield* fs.remove(path.join(versionsRoot, name), {force: true, recursive: true});
    }
  }
});

const recoverActiveReleasePromotion = Effect.fn('installations.recoverActiveReleasePromotion')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) {
  const journalPath = path.join(root, ACTIVE_RELEASE_JOURNAL_FILE);
  const journalExists = yield* fs.exists(journalPath);
  const promotion = journalExists ? yield* readActiveReleasePromotion(fs, path, root, journalPath) : undefined;
  const activePath = path.join(root, ACTIVE_RELEASE_FILE);
  const backupPath = path.join(root, ACTIVE_RELEASE_BACKUP_FILE);
  const activeExists = yield* fs.exists(activePath);
  const backupExists = yield* fs.exists(backupPath);
  if (!activeExists && backupExists) {
    yield* fs.rename(backupPath, activePath);
  } else if (activeExists && backupExists) {
    yield* fs.remove(backupPath, {force: true});
  }
  if (promotion) yield* fs.remove(promotion.temporaryPath, {force: true});
  if (journalExists) yield* fs.remove(journalPath, {force: true});
  if (!journalExists && !backupExists) return false;
  yield* syncDirectoryBestEffort(fs, root);
  return true;
});

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

const readActiveReleasePromotion = Effect.fn('installations.readActiveReleasePromotion')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  journalPath: string,
) {
  const value = yield* parsePromotionJournal(fs, journalPath);
  const activePath = path.join(root, ACTIVE_RELEASE_FILE);
  const backupPath = path.join(root, ACTIVE_RELEASE_BACKUP_FILE);
  if (
    value.version !== PROMOTION_JOURNAL_VERSION ||
    value.activePath !== activePath ||
    value.backupPath !== backupPath ||
    typeof value.temporaryPath !== 'string' ||
    path.dirname(value.temporaryPath) !== root ||
    !/^\.active-release\.[0-9]+-[0-9a-f-]+\.next\.json$/i.test(path.basename(value.temporaryPath))
  ) {
    return yield* Effect.fail(new Error(`Active release promotion journal is invalid: ${journalPath}`));
  }
  return {
    activePath,
    backupPath,
    temporaryPath: value.temporaryPath,
    version: PROMOTION_JOURNAL_VERSION,
  } satisfies ActiveReleasePromotion;
});

const readReleaseDirectoryPromotion = Effect.fn('installations.readReleaseDirectoryPromotion')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  journalPath: string,
  releaseRoot: string,
) {
  const value = yield* parsePromotionJournal(fs, journalPath);
  const versionsRoot = path.dirname(releaseRoot);
  const backupRoot = releasePromotionBackupPath(path, releaseRoot);
  const journalReleaseRoot = typeof value.releaseRoot === 'string' ? path.resolve(value.releaseRoot) : undefined;
  const journalBackupRoot = typeof value.backupRoot === 'string' ? path.resolve(value.backupRoot) : undefined;
  const journalStagedRoot = typeof value.stagedRoot === 'string' ? path.resolve(value.stagedRoot) : undefined;
  const journalVersionsRoot = journalReleaseRoot ? path.dirname(journalReleaseRoot) : undefined;
  const rootsReferToSameDirectory =
    journalVersionsRoot === undefined
      ? false
      : yield* Effect.all([fs.realPath(versionsRoot), fs.realPath(journalVersionsRoot)]).pipe(
          Effect.map(([expected, observed]) => expected === observed),
          Effect.catch(() => Effect.succeed(false)),
        );
  const rebasedStagedRoot =
    journalVersionsRoot && journalStagedRoot
      ? path.resolve(versionsRoot, path.relative(journalVersionsRoot, journalStagedRoot))
      : undefined;
  if (
    value.version !== PROMOTION_JOURNAL_VERSION ||
    !rootsReferToSameDirectory ||
    journalReleaseRoot !== path.join(journalVersionsRoot!, path.basename(releaseRoot)) ||
    journalBackupRoot !== path.join(journalVersionsRoot!, path.basename(backupRoot)) ||
    rebasedStagedRoot === undefined ||
    !isStandaloneStagingPath(path, versionsRoot, path.basename(releaseRoot), rebasedStagedRoot)
  ) {
    return yield* Effect.fail(new Error(`Standalone release promotion journal is invalid: ${journalPath}`));
  }
  return {
    backupRoot,
    releaseRoot,
    stagedRoot: rebasedStagedRoot,
    version: PROMOTION_JOURNAL_VERSION,
  } satisfies ReleaseDirectoryPromotion;
});

const parsePromotionJournal = Effect.fn('installations.parsePromotionJournal')(function* (
  fs: FileSystem.FileSystem,
  journalPath: string,
) {
  const content = yield* fs.readFileString(journalPath);
  return yield* Effect.try({
    try: () => {
      const value = JSON.parse(content) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('expected a JSON object');
      }
      return value as Record<string, unknown>;
    },
    catch: cause => new Error(`Could not parse promotion journal ${journalPath}.`, {cause}),
  });
});

function releasePromotionBackupPath(path: Path.Path, releaseRoot: string): string {
  return path.join(path.dirname(releaseRoot), `.${path.basename(releaseRoot)}.promotion-backup`);
}

function releasePromotionJournalPath(path: Path.Path, releaseRoot: string): string {
  return path.join(path.dirname(releaseRoot), `.${path.basename(releaseRoot)}.promotion.json`);
}

function isContainedPath(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isStandaloneStagingPath(
  path: Path.Path,
  versionsRoot: string,
  releaseName: string,
  candidate: string,
): boolean {
  if (!isContainedPath(path, versionsRoot, candidate)) return false;
  const segments = path.relative(versionsRoot, candidate).split(path.sep);
  if (
    segments.length === 2 &&
    segments[1] === 'release' &&
    /^\.threadnote-update-[0-9A-Za-z._-]+$/.test(segments[0] ?? '')
  ) {
    return true;
  }
  return (
    segments.length === 1 &&
    new RegExp(`^\\.${escapeRegExp(releaseName)}\\.[0-9A-Za-z._-]+\\.staging$`).test(segments[0] ?? '')
  );
}

function standaloneStagingCleanupRoot(path: Path.Path, versionsRoot: string, stagedRoot: string): string {
  const segments = path.relative(versionsRoot, stagedRoot).split(path.sep);
  return segments.length === 2 && segments[1] === 'release' ? path.dirname(stagedRoot) : stagedRoot;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const writePrivateJsonAtomically = Effect.fn('installations.writePrivateJsonAtomically')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
  value: unknown,
) {
  const crypto = yield* Crypto.Crypto;
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${yield* crypto.randomUUIDv4}.tmp`);
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, `${JSON.stringify(value, undefined, 2)}\n`, {flag: 'wx', mode: 0o600});
    yield* syncWritableFile(fs, temporary);
    yield* fs.rename(temporary, target);
    yield* syncDirectoryBestEffort(fs, directory);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.catch(() => Effect.void))));
});

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

const liveReleaseLeaseVersions = Effect.fn('installations.liveLeaseVersions')(function* (
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
    if (!RELEASE_VERSION_PATTERN.test(version)) continue;
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
        !RELEASE_VERSION_PATTERN.test(value.version) ||
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
