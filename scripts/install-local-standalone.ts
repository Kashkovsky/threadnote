import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Cause, Console, Crypto, Effect, Exit, FileSystem, Layer, Option, Path} from 'effect';
import {commandLauncherPath, installCommandShim, renderCommandShim} from '../src/command-shim.js';
import {CommandExecutor, runCommandEffect} from '../src/effect/command.js';
import {captureConsole} from '../src/effect/console.js';
import {sha256FileHex, sha256Hex} from '../src/effect/digest.js';
import {SystemInfo, type SystemInfoShape} from '../src/effect/system.js';
import {
  activateStandaloneRelease,
  activeInstalledVersion,
  installationRoot,
  promoteStandaloneReleaseDirectory,
  pruneStandaloneReleases,
  withStandaloneInstallationLock,
} from '../src/installations.js';
import {
  readStandaloneProcessLeaseVerification,
  terminateSupersededStandaloneProcesses,
} from '../src/standalone_process_lease.js';
import {scriptArguments} from './effect/script.js';
import {
  DEVELOPMENT_INSTALL_RECEIPT_VERSION,
  collectDevelopmentPayloadManifest,
  developmentBuildVersion,
  developmentPayloadManifestSha256,
  isDevelopmentBuildVersion,
  prepareCanonicalDevelopmentInstallRoots,
  readDevelopmentReleaseEvidence,
  readManagedDevelopmentRuntimeEvidence,
  stageAndValidateDevelopmentRelease,
  type DevelopmentInstallReceiptV1,
  type DevelopmentRuntimeEvidence,
} from './development-runtime.js';

const ROOT_URL = new URL('..', import.meta.url);
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const COMMAND_TIMEOUT_MILLISECONDS = 30 * 60_000;
const DEVELOPMENT_RUNTIME_OWNER_FILE = 'development-runtime-owner.json';
const DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION = 1 as const;
const DEVELOPMENT_RUNTIME_OWNER_MAX_BYTES = 16 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CLEAN_GIT_STATUS_ARGUMENTS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'status.showUntrackedFiles=all',
  '-c',
  'diff.ignoreSubmodules=none',
  'status',
  '--porcelain=v1',
  '--untracked-files=all',
  '--ignore-submodules=none',
  '--no-renames',
] as const;

export interface LocalStandaloneInstallOptions {
  readonly json: boolean;
  readonly takeOverGlobalRuntime: boolean;
  readonly terminateSuperseded: boolean;
}

export interface LocalStandaloneInstallResult extends DevelopmentRuntimeEvidence {
  readonly active: true;
  readonly cleanupComplete: boolean;
  readonly cleanupIssues: readonly LocalStandaloneCleanupIssue[];
  readonly doctorVerified: true;
  readonly launchersVerified: true;
  readonly remainingSupersededProcesses: number;
  readonly reused: boolean;
  readonly terminatedSupersededProcesses: number;
}

export type LocalStandaloneCleanupIssue =
  'process-inspection' | 'process-termination' | 'release-pruning' | 'staging-removal';

export interface LocalStandaloneActivationInput {
  readonly canonicalInstallRoot: string;
  readonly canonicalVersionsRoot: string;
  readonly commit: string;
  readonly executableName: string;
  readonly releaseRoot: string;
  readonly reused: boolean;
  readonly sourceCheckoutId: string;
  readonly stagedRoot: Option.Option<string>;
  readonly takeOverGlobalRuntime: boolean;
  readonly terminateSuperseded: boolean;
  readonly version: string;
}

export interface DevelopmentRuntimeOwnerV1 {
  readonly schemaVersion: typeof DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION;
  readonly sourceCheckoutId: string;
  readonly version: string;
}

export type DevelopmentRuntimeOwnershipState = DevelopmentRuntimeOwnerV1 | 'absent' | 'invalid';

export type DevelopmentRuntimeOwnershipConflict =
  'different-source-checkout' | 'invalid-ownership-record' | 'untracked-development-activation';

export function parseLocalStandaloneInstallArguments(arguments_: readonly string[]): LocalStandaloneInstallOptions {
  let json = false;
  let takeOverGlobalRuntime = false;
  let terminateSuperseded = false;
  for (const argument of arguments_) {
    if (argument === '--') continue;
    if (argument === '--json') json = true;
    else if (argument === '--take-over-global-runtime') takeOverGlobalRuntime = true;
    else if (argument === '--terminate-superseded') terminateSuperseded = true;
    else throw new Error(`Unknown local standalone install option: ${argument}`);
  }
  return {json, takeOverGlobalRuntime, terminateSuperseded};
}

export function developmentRuntimeOwnershipConflict(
  activeVersion: string | undefined,
  owner: DevelopmentRuntimeOwnershipState,
  requestedSourceCheckoutId: string,
): DevelopmentRuntimeOwnershipConflict | undefined {
  if (activeVersion === undefined || !isDevelopmentBuildVersion(activeVersion) || owner === 'absent') return undefined;
  if (owner === 'invalid') return 'invalid-ownership-record';
  if (owner.version !== activeVersion) return 'untracked-development-activation';
  return owner.sourceCheckoutId === requestedSourceCheckoutId ? undefined : 'different-source-checkout';
}

export const installLocalStandalone = Effect.fn('developmentInstall.run')(function* (
  options: LocalStandaloneInstallOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const sourceRoot = yield* path.fromFileUrl(ROOT_URL);
  const git = Option.fromNullishOr(Bun.which('git'));
  if (Option.isNone(git))
    return yield* Effect.fail(new Error('Git is required for an exact-HEAD development install.'));
  const [sourceCommit, status] = yield* Effect.all(
    [
      runCommandEffect(git.value, ['rev-parse', 'HEAD'], {cwd: sourceRoot}),
      runCommandEffect(git.value, CLEAN_GIT_STATUS_ARGUMENTS, {cwd: sourceRoot}),
    ],
    {concurrency: 2},
  );
  const commit = sourceCommit.stdout.trim();
  if (!GIT_COMMIT_PATTERN.test(commit)) {
    return yield* Effect.fail(new Error('The Threadnote checkout did not resolve to an exact Git commit.'));
  }
  if (status.stdout.length > 0) {
    return yield* Effect.fail(new Error('Refusing a global development install from a dirty Threadnote checkout.'));
  }
  const manifest = yield* readPackageManifest(fs, path.join(sourceRoot, 'package.json'));
  const version = developmentBuildVersion(manifest.version, commit);
  const roots = yield* prepareCanonicalDevelopmentInstallRoots(installationRoot(path, system));
  const sourceCheckoutId = yield* developmentSourceCheckoutId(sourceRoot);
  yield* requireDevelopmentRuntimeOwnership(roots.installRoot, sourceCheckoutId, options.takeOverGlobalRuntime);
  const releaseRoot = path.join(roots.versionsRoot, version);
  const executableName = system.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
  const releaseExists = yield* fs.exists(releaseRoot);
  const stagedRoot = releaseExists
    ? Option.none<string>()
    : Option.some(
        yield* buildAndStageDevelopmentRelease({
          commit,
          canonicalInstallRoot: roots.installRoot,
          canonicalVersionsRoot: roots.versionsRoot,
          executableName,
          json: options.json,
          releaseRoot,
          sourceRoot,
          version,
        }),
      );
  yield* verifyCleanSourceState(sourceRoot, commit);
  const activation = activateLocalStandaloneRelease({
    canonicalInstallRoot: roots.installRoot,
    canonicalVersionsRoot: roots.versionsRoot,
    commit,
    executableName,
    releaseRoot,
    reused: releaseExists,
    sourceCheckoutId,
    stagedRoot,
    takeOverGlobalRuntime: options.takeOverGlobalRuntime,
    terminateSuperseded: options.terminateSuperseded,
    version,
  });
  const result = options.json ? (yield* captureConsole(activation)).value : yield* activation;
  if (options.json) {
    yield* Console.log(JSON.stringify(result));
  } else {
    yield* Console.log(`Installed exact-HEAD Threadnote ${result.version}.`);
    yield* Console.log(`Source commit: ${result.sourceCommit}`);
    yield* Console.log(`Executable SHA-256: ${result.executableSha256}`);
    const processStateUnknown = result.cleanupIssues.some(
      (issue: LocalStandaloneCleanupIssue) => issue === 'process-inspection' || issue === 'process-termination',
    );
    yield* Console.log(
      processStateUnknown
        ? 'Could not verify whether superseded Threadnote processes remain.'
        : result.remainingSupersededProcesses === 0
          ? 'No superseded Threadnote processes remain.'
          : `${result.remainingSupersededProcesses} superseded Threadnote process(es) remain; rerun with --terminate-superseded.`,
    );
    if (!result.cleanupComplete) {
      yield* Console.log(
        `Managed cleanup is incomplete (${result.cleanupIssues.join(', ') || 'superseded processes remain'}); ` +
          'rerun the exact-HEAD installer after active work finishes.',
      );
    }
  }
  return result;
});

const verifyCleanSourceState = Effect.fn('developmentInstall.verifyCleanSourceState')(function* (
  sourceRoot: string,
  expectedCommit: string,
) {
  const git = Option.fromNullishOr(Bun.which('git'));
  if (Option.isNone(git)) return yield* Effect.fail(new Error('Git disappeared before development activation.'));
  const [commit, status] = yield* Effect.all(
    [
      runCommandEffect(git.value, ['rev-parse', 'HEAD'], {cwd: sourceRoot}),
      runCommandEffect(git.value, CLEAN_GIT_STATUS_ARGUMENTS, {cwd: sourceRoot}),
    ],
    {concurrency: 2},
  );
  if (commit.stdout.trim() !== expectedCommit || status.stdout.length > 0) {
    return yield* Effect.fail(new Error('The Threadnote checkout changed before development activation.'));
  }
});

const developmentSourceCheckoutId = Effect.fn('developmentInstall.sourceCheckoutId')(function* (sourceRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const canonicalSourceRoot = yield* fs.realPath(sourceRoot);
  const normalizedSourceRoot =
    system.platform === 'win32' ? canonicalSourceRoot.toLocaleLowerCase('en-US') : canonicalSourceRoot;
  return yield* sha256Hex(`threadnote-development-source-checkout-v1\0${normalizedSourceRoot}`);
});

const requireDevelopmentRuntimeOwnership = Effect.fn('developmentInstall.requireRuntimeOwnership')(function* (
  installRoot: string,
  requestedSourceCheckoutId: string,
  takeOverGlobalRuntime: boolean,
) {
  if (!SHA256_PATTERN.test(requestedSourceCheckoutId)) {
    return yield* Effect.fail(new Error('The development source checkout identity is invalid.'));
  }
  const [activeVersion, owner] = yield* Effect.all([
    activeInstalledVersion(),
    readDevelopmentRuntimeOwner(installRoot),
  ]);
  const conflict = developmentRuntimeOwnershipConflict(activeVersion, owner, requestedSourceCheckoutId);
  if (conflict === undefined || takeOverGlobalRuntime) return;
  const reason =
    conflict === 'different-source-checkout'
      ? 'another source checkout owns the active global development runtime'
      : conflict === 'untracked-development-activation'
        ? 'the active global development runtime changed outside its owning installer'
        : 'the active global development runtime ownership record is invalid';
  return yield* Effect.fail(
    new Error(
      `Refusing to replace the global Threadnote runtime because ${reason}. ` +
        'Rerun with --take-over-global-runtime only after confirming the other development task has finished.',
    ),
  );
});

const readDevelopmentRuntimeOwner = Effect.fn('developmentInstall.readRuntimeOwner')(function* (installRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const file = path.join(installRoot, DEVELOPMENT_RUNTIME_OWNER_FILE);
  if (!(yield* fs.exists(file))) return 'absent';
  const [link, info] = yield* Effect.all([fs.readLink(file).pipe(Effect.option), fs.stat(file).pipe(Effect.option)]);
  if (
    Option.isSome(link) ||
    Option.isNone(info) ||
    info.value.type !== 'File' ||
    Number(info.value.size) > DEVELOPMENT_RUNTIME_OWNER_MAX_BYTES ||
    (system.platform !== 'win32' && (info.value.mode & 0o7777) !== 0o600)
  ) {
    return 'invalid';
  }
  const source = yield* fs.readFileString(file).pipe(Effect.option);
  if (Option.isNone(source)) return 'invalid';
  const value = yield* Effect.sync(() => {
    try {
      return JSON.parse(source.value) as unknown;
    } catch {
      return undefined;
    }
  });
  return value === undefined ? 'invalid' : parseDevelopmentRuntimeOwner(value);
});

function parseDevelopmentRuntimeOwner(value: unknown): DevelopmentRuntimeOwnershipState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid';
  const candidate = value as Partial<DevelopmentRuntimeOwnerV1>;
  return candidate.schemaVersion === DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION &&
    typeof candidate.sourceCheckoutId === 'string' &&
    SHA256_PATTERN.test(candidate.sourceCheckoutId) &&
    typeof candidate.version === 'string' &&
    isDevelopmentBuildVersion(candidate.version)
    ? (candidate as DevelopmentRuntimeOwnerV1)
    : 'invalid';
}

const writeDevelopmentRuntimeOwner = Effect.fn('developmentInstall.writeRuntimeOwner')(function* (
  installRoot: string,
  owner: DevelopmentRuntimeOwnerV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const file = path.join(installRoot, DEVELOPMENT_RUNTIME_OWNER_FILE);
  const temporary = path.join(installRoot, `.${DEVELOPMENT_RUNTIME_OWNER_FILE}.${yield* crypto.randomUUIDv4}.tmp`);
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, `${JSON.stringify(owner, undefined, 2)}\n`, {flag: 'wx', mode: 0o600});
    yield* fs.rename(temporary, file);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.catch(() => Effect.void))));
});

/**
 * The complete managed-release mutation is one installation-lock critical
 * section. This prevents a concurrent updater from pruning a reused release
 * before activation or becoming active while superseded processes are being
 * retired.
 */
export const activateLocalStandaloneRelease = Effect.fn('developmentInstall.activate')(function* (
  input: LocalStandaloneActivationInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const executable = path.join(input.releaseRoot, input.executableName);
  const criticalSection = Effect.gen(function* () {
    const roots = yield* requireCanonicalDevelopmentInstallRoots(
      input.canonicalInstallRoot,
      input.canonicalVersionsRoot,
      input.version,
      input.releaseRoot,
      input.stagedRoot,
    );
    const installRoot = roots.installRoot;
    yield* requireDevelopmentRuntimeOwnership(installRoot, input.sourceCheckoutId, input.takeOverGlobalRuntime);
    let reused = input.reused;
    let promotedByThisInstall = false;
    if (Option.isSome(input.stagedRoot)) {
      if (yield* fs.exists(input.releaseRoot)) {
        const concurrentEvidence = yield* readDevelopmentReleaseEvidence(input.releaseRoot, input.commit).pipe(
          Effect.mapError(
            cause => new Error('A concurrent exact-version development release is not reusable.', {cause}),
          ),
        );
        yield* requireEvidenceVersion(concurrentEvidence, input.version);
        reused = true;
      } else {
        const stagedEvidence = yield* readDevelopmentReleaseEvidence(input.stagedRoot.value, input.commit).pipe(
          Effect.mapError(cause => new Error('The staged development release changed before activation.', {cause})),
        );
        yield* requireEvidenceVersion(stagedEvidence, input.version);
        yield* promoteStandaloneReleaseDirectory(fs, path, input.stagedRoot.value, input.releaseRoot, system.processId);
        promotedByThisInstall = true;
      }
    }
    const snapshots = yield* Effect.gen(function* () {
      const releaseEvidence = yield* readDevelopmentReleaseEvidence(input.releaseRoot, input.commit).pipe(
        Effect.mapError(
          cause =>
            new Error(
              input.reused
                ? 'The existing exact-version development release is not reusable.'
                : 'The promoted development release failed validation.',
              {cause},
            ),
        ),
      );
      yield* requireEvidenceVersion(releaseEvidence, input.version);
      const doctor = yield* runCommandEffect(executable, ['doctor', '--dry-run'], {
        env: {...system.environment(), THREADNOTE_INSTALL_ROOT: installRoot},
        maxOutputBytes: 2 * 1024 * 1024,
        timeoutMs: 5 * 60_000,
      });
      if (!doctor.stdout.includes('Running Threadnote doctor checks.') || !doctor.stdout.includes('Summary:')) {
        return yield* Effect.fail(
          new Error('The installed development executable did not complete doctor verification.'),
        );
      }
      return yield* Effect.all([
        captureFileSnapshot(fs, yield* commandLauncherPath('cli'), 'CLI launcher', 0o755),
        captureFileSnapshot(fs, yield* commandLauncherPath('mcp'), 'MCP launcher', 0o755),
        captureFileSnapshot(fs, path.join(installRoot, 'active-release.json'), 'active release pointer', 0o600),
        captureFileSnapshot(
          fs,
          path.join(installRoot, DEVELOPMENT_RUNTIME_OWNER_FILE),
          'development runtime owner',
          0o600,
        ),
      ]);
    }).pipe(
      Effect.catchCause(validationCause =>
        promotedByThisInstall
          ? fs.remove(input.releaseRoot, {force: true, recursive: true}).pipe(
              Effect.matchCauseEffect({
                onFailure: cleanupCause =>
                  Effect.fail(
                    new Error('The new development release failed validation and could not be removed.', {
                      cause: new AggregateError([Cause.squash(validationCause), Cause.squash(cleanupCause)]),
                    }),
                  ),
                onSuccess: () => Effect.failCause(validationCause),
              }),
            )
          : Effect.failCause(validationCause),
      ),
    );
    const activeEvidence = yield* Effect.gen(function* () {
      yield* activateStandaloneRelease(input.releaseRoot, false);
      const evidence = yield* readManagedDevelopmentRuntimeEvidence(input.commit);
      yield* installCommandShim(false, input.releaseRoot);
      yield* verifyLaunchers(fs, input.releaseRoot, input.version);
      yield* writeDevelopmentRuntimeOwner(installRoot, {
        schemaVersion: DEVELOPMENT_RUNTIME_OWNER_SCHEMA_VERSION,
        sourceCheckoutId: input.sourceCheckoutId,
        version: input.version,
      });
      return evidence;
    }).pipe(
      Effect.catchCause(activationCause =>
        restoreFileSnapshots(fs, path, system, snapshots).pipe(
          Effect.matchCauseEffect({
            onFailure: rollbackCause =>
              Effect.fail(
                new Error('Development release activation failed and rollback was incomplete.', {
                  cause: new AggregateError([Cause.squash(activationCause), Cause.squash(rollbackCause)]),
                }),
              ),
            onSuccess: () => Effect.failCause(activationCause),
          }),
        ),
      ),
    );

    let terminatedSupersededProcesses = 0;
    const unresolvedProcessIds = new Set<number>();
    const cleanupIssues = new Set<LocalStandaloneCleanupIssue>();
    if (input.terminateSuperseded) {
      // Revalidate the pointer immediately before signaling. The installation
      // lock prevents it from changing until retirement and pruning finish.
      const activeRevalidation = yield* Effect.exit(readManagedDevelopmentRuntimeEvidence(input.commit));
      if (Exit.isFailure(activeRevalidation)) {
        cleanupIssues.add('process-termination');
      } else {
        const termination = yield* Effect.exit(terminateSupersededStandaloneProcesses(input.version));
        if (Exit.isFailure(termination)) {
          cleanupIssues.add('process-termination');
        } else {
          terminatedSupersededProcesses = termination.value.signaled.length;
          for (const lease of [...termination.value.skippedUnverified, ...termination.value.remaining]) {
            unresolvedProcessIds.add(lease.processId);
          }
        }
      }
    }
    const live = yield* Effect.exit(readStandaloneProcessLeaseVerification());
    if (Exit.isFailure(live)) {
      cleanupIssues.add('process-inspection');
    } else {
      if (live.value.truncated || live.value.unverified.length > 0) cleanupIssues.add('process-inspection');
      for (const lease of [...live.value.verified, ...live.value.unverified]) {
        if (lease.version !== input.version) unresolvedProcessIds.add(lease.processId);
      }
    }
    if (Option.isSome(input.stagedRoot)) {
      const stagedRoot = input.stagedRoot.value;
      const stagedRemoval = yield* Effect.exit(
        Effect.gen(function* () {
          if (yield* fs.exists(stagedRoot)) {
            yield* fs.remove(stagedRoot, {force: true, recursive: true});
          }
          if (yield* fs.exists(stagedRoot)) {
            return yield* Effect.fail(new Error('The development staging directory still exists after cleanup.'));
          }
        }),
      );
      if (Exit.isFailure(stagedRemoval)) cleanupIssues.add('staging-removal');
    }
    const pruning = yield* Effect.exit(pruneStandaloneReleases(input.releaseRoot, false));
    if (Exit.isFailure(pruning) || !pruning.value.complete) cleanupIssues.add('release-pruning');
    return {
      ...activeEvidence,
      active: true,
      cleanupComplete: cleanupIssues.size === 0 && unresolvedProcessIds.size === 0,
      cleanupIssues: [...cleanupIssues].sort(),
      doctorVerified: true,
      launchersVerified: true,
      remainingSupersededProcesses: unresolvedProcessIds.size,
      reused,
      terminatedSupersededProcesses,
    } satisfies LocalStandaloneInstallResult;
  });
  return yield* withStandaloneInstallationLock(criticalSection).pipe(
    Effect.ensuring(
      Option.isSome(input.stagedRoot)
        ? fs.remove(input.stagedRoot.value, {force: true, recursive: true}).pipe(Effect.catch(() => Effect.void))
        : Effect.void,
    ),
  );
});

function requireEvidenceVersion(evidence: DevelopmentRuntimeEvidence, expectedVersion: string) {
  return evidence.version === expectedVersion
    ? Effect.void
    : Effect.fail(new Error('The validated development release version does not match its activation target.'));
}

interface LocalFileSnapshot {
  readonly content: Option.Option<string>;
  readonly file: string;
  readonly label: string;
  readonly mode: number;
}

const captureFileSnapshot = Effect.fn('developmentInstall.captureFileSnapshot')(function* (
  fs: FileSystem.FileSystem,
  file: string,
  label: string,
  defaultMode: number,
) {
  const [exists, link, content, info] = yield* Effect.all([
    fs.exists(file),
    fs.readLink(file).pipe(Effect.option),
    fs.readFileString(file).pipe(Effect.option),
    fs.stat(file).pipe(Effect.option),
  ]);
  if (Option.isSome(link) || (exists && Option.isNone(content))) {
    return yield* Effect.fail(new Error('A managed installation file cannot be safely snapshotted for rollback.'));
  }
  return {
    content,
    file,
    label,
    mode: Option.isSome(info) ? info.value.mode & 0o777 : defaultMode,
  } satisfies LocalFileSnapshot;
});

const restoreFileSnapshots = Effect.fn('developmentInstall.restoreFileSnapshots')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  snapshots: readonly LocalFileSnapshot[],
) {
  const failures: Error[] = [];
  for (const snapshot of snapshots) {
    const restored = yield* Effect.exit(restoreFileSnapshot(fs, path, system, snapshot));
    if (Exit.isFailure(restored)) {
      failures.push(new Error(`Could not restore the ${snapshot.label}.`, {cause: Cause.squash(restored.cause)}));
    }
  }
  if (failures.length > 0) {
    return yield* Effect.fail(
      new AggregateError(failures, 'One or more managed installation files were not restored.'),
    );
  }
});

const restoreFileSnapshot = Effect.fn('developmentInstall.restoreFileSnapshot')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  snapshot: LocalFileSnapshot,
) {
  if (Option.isNone(snapshot.content)) {
    yield* fs.remove(snapshot.file, {force: true});
    return;
  }
  const content = snapshot.content.value;
  yield* fs.makeDirectory(path.dirname(snapshot.file), {recursive: true, mode: 0o700});
  const temporary = path.join(
    path.dirname(snapshot.file),
    `.${path.basename(snapshot.file)}.${system.processId}.rollback`,
  );
  yield* Effect.gen(function* () {
    yield* fs.remove(temporary, {force: true});
    yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: snapshot.mode});
    if (system.platform !== 'win32') yield* fs.chmod(temporary, snapshot.mode);
    yield* fs.rename(temporary, snapshot.file);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.catch(() => Effect.void))));
});

const buildAndStageDevelopmentRelease = Effect.fn('developmentInstall.buildAndStage')(function* (input: {
  readonly canonicalInstallRoot: string;
  readonly canonicalVersionsRoot: string;
  readonly commit: string;
  readonly executableName: string;
  readonly json: boolean;
  readonly releaseRoot: string;
  readonly sourceRoot: string;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  yield* requireCanonicalDevelopmentInstallRoots(
    input.canonicalInstallRoot,
    input.canonicalVersionsRoot,
    input.version,
    input.releaseRoot,
    Option.none(),
  );
  if (!input.json) yield* Console.log(`Building standalone Threadnote from ${input.commit.slice(0, 12)}.`);
  yield* runCommandEffect(system.executablePath, ['install', '--frozen-lockfile'], {
    cwd: input.sourceRoot,
    maxOutputBytes: 2 * 1024 * 1024,
    timeoutMs: COMMAND_TIMEOUT_MILLISECONDS,
  });
  yield* runCommandEffect(system.executablePath, ['run', 'build'], {
    cwd: input.sourceRoot,
    env: {...system.environment(), THREADNOTE_DEVELOPMENT_BUILD_VERSION: input.version},
    maxOutputBytes: 2 * 1024 * 1024,
    timeoutMs: COMMAND_TIMEOUT_MILLISECONDS,
  });
  const git = Option.fromNullishOr(Bun.which('git'));
  if (Option.isNone(git)) return yield* Effect.fail(new Error('Git disappeared during the development build.'));
  const [afterCommit, afterStatus] = yield* Effect.all(
    [
      runCommandEffect(git.value, ['rev-parse', 'HEAD'], {cwd: input.sourceRoot}),
      runCommandEffect(git.value, CLEAN_GIT_STATUS_ARGUMENTS, {cwd: input.sourceRoot}),
    ],
    {concurrency: 2},
  );
  if (afterCommit.stdout.trim() !== input.commit || afterStatus.stdout.length > 0) {
    return yield* Effect.fail(new Error('The Threadnote checkout changed while building the development executable.'));
  }
  const distributionRoot = path.join(input.sourceRoot, 'dist');
  const releaseMetadataPath = path.join(distributionRoot, 'release.json');
  const releaseMetadata = yield* readReleaseMetadata(fs, releaseMetadataPath);
  if (releaseMetadata.version !== input.version || releaseMetadata.executable !== input.executableName) {
    return yield* Effect.fail(new Error('The development build did not embed its exact SHA-bound version.'));
  }
  const executable = path.join(distributionRoot, input.executableName);
  const payloadManifest = yield* collectDevelopmentPayloadManifest(distributionRoot);
  const [
    executableSha256,
    payloadManifestSha256,
    releaseMetadataSha256,
    sourceLockfileSha256,
    sourcePackageManifestSha256,
    versionResult,
  ] = yield* Effect.all(
    [
      sha256FileHex(executable),
      developmentPayloadManifestSha256(payloadManifest),
      sha256FileHex(releaseMetadataPath),
      sha256FileHex(path.join(input.sourceRoot, 'bun.lock')),
      sha256FileHex(path.join(input.sourceRoot, 'package.json')),
      runCommandEffect(executable, ['--version'], {maxOutputBytes: 16 * 1024, timeoutMs: 30_000}),
    ],
    {concurrency: 6},
  );
  if (versionResult.stdout.trim() !== `threadnote v${input.version}`) {
    return yield* Effect.fail(new Error('The compiled development executable reported the wrong version.'));
  }
  const receipt: DevelopmentInstallReceiptV1 = {
    builtAt: new Date().toISOString(),
    dependencyInstallation: 'bun install --frozen-lockfile',
    executableSha256,
    payloadManifest,
    payloadManifestSha256,
    releaseMetadataSha256,
    runtime: releaseMetadata.runtime,
    schemaVersion: DEVELOPMENT_INSTALL_RECEIPT_VERSION,
    sourceCommit: input.commit,
    sourceDirty: false,
    sourceLockfileSha256,
    sourcePackageManifestSha256,
    target: releaseMetadata.target,
    version: input.version,
  };
  yield* requireCanonicalDevelopmentInstallRoots(
    input.canonicalInstallRoot,
    input.canonicalVersionsRoot,
    input.version,
    input.releaseRoot,
    Option.none(),
  );
  const crypto = yield* Crypto.Crypto;
  const stagedRoot = path.join(input.canonicalVersionsRoot, `.${input.version}.${yield* crypto.randomUUIDv4}.staging`);
  return yield* stageAndValidateDevelopmentRelease({
    distributionRoot,
    executableName: input.executableName,
    expectedSourceCommit: input.commit,
    receipt,
    stagedRoot,
    versionsRoot: input.canonicalVersionsRoot,
  });
});

const verifyLaunchers = Effect.fn('developmentInstall.verifyLaunchers')(function* (
  fs: FileSystem.FileSystem,
  releaseRoot: string,
  expectedVersion: string,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  let cliLauncher = '';
  for (const mode of ['cli', 'mcp'] as const) {
    const [launcher, expected] = yield* Effect.all([commandLauncherPath(mode), renderCommandShim(releaseRoot, mode)]);
    const actual = yield* fs.readFileString(launcher);
    if (actual !== expected) {
      return yield* Effect.fail(new Error(`The managed ${mode} launcher did not activate the development release.`));
    }
    if (system.platform !== 'win32') {
      const info = yield* fs.stat(launcher);
      if ((info.mode & 0o777) !== 0o755) yield* fs.chmod(launcher, 0o755);
      const repaired = yield* fs.stat(launcher);
      if ((repaired.mode & 0o777) !== 0o755) {
        return yield* Effect.fail(new Error(`The managed ${mode} launcher does not have safe executable mode.`));
      }
    }
    if (mode === 'cli') cliLauncher = launcher;
  }
  const version = yield* runCommandEffect(cliLauncher, ['--version'], {
    env: {...system.environment(), THREADNOTE_INSTALL_ROOT: installationRoot(path, system)},
    maxOutputBytes: 16 * 1024,
    timeoutMs: 30_000,
  });
  if (version.stdout.trim() !== `threadnote v${expectedVersion}`) {
    return yield* Effect.fail(new Error('The managed CLI launcher did not execute the activated development release.'));
  }
});

const requireCanonicalDevelopmentInstallRoots = Effect.fn('developmentInstall.requireCanonicalRoots')(function* (
  expectedInstallRoot: string,
  expectedVersionsRoot: string,
  version: string,
  releaseRoot: string,
  stagedRoot: Option.Option<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const current = yield* prepareCanonicalDevelopmentInstallRoots(installationRoot(path, system));
  if (!platformPathEquals(path, system, current.installRoot, expectedInstallRoot)) {
    return yield* Effect.fail(
      new Error('The managed Threadnote installation root changed or escaped its canonical location.'),
    );
  }
  if (!platformPathEquals(path, system, current.versionsRoot, expectedVersionsRoot)) {
    return yield* Effect.fail(
      new Error('The managed Threadnote versions root changed or escaped its canonical location.'),
    );
  }
  if (path.basename(releaseRoot) !== version) {
    return yield* Effect.fail(new Error('The development release name does not match its version.'));
  }
  const releaseParent = yield* fs.realPath(path.dirname(releaseRoot));
  if (!platformPathEquals(path, system, releaseParent, current.versionsRoot)) {
    return yield* Effect.fail(new Error('The development release parent is not the canonical versions root.'));
  }
  if (Option.isSome(stagedRoot)) {
    const name = path.basename(stagedRoot.value);
    const validName = name.startsWith(`.${version}.`) && name.endsWith('.staging');
    const stagedParent = yield* fs.realPath(path.dirname(stagedRoot.value));
    const parentMatches = platformPathEquals(path, system, stagedParent, current.versionsRoot);
    const link = yield* fs.readLink(stagedRoot.value).pipe(Effect.option);
    const info = yield* fs.stat(stagedRoot.value).pipe(Effect.option);
    const canonical = yield* fs.realPath(stagedRoot.value).pipe(Effect.option);
    if (
      !validName ||
      !parentMatches ||
      Option.isSome(link) ||
      Option.isNone(info) ||
      info.value.type !== 'Directory' ||
      Option.isNone(canonical) ||
      !platformPathEquals(path, system, canonical.value, path.join(stagedParent, name))
    ) {
      return yield* Effect.fail(new Error('The development staging directory changed or escaped before activation.'));
    }
  }
  return current;
});

function platformPathEquals(
  path: Path.Path,
  system: Pick<SystemInfoShape, 'platform'>,
  left: string,
  right: string,
): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return system.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return normalize(left) === normalize(right);
}

function readPackageManifest(fs: FileSystem.FileSystem, file: string) {
  return fs.readFileString(file).pipe(
    Effect.flatMap(source =>
      Effect.try({
        try: () => JSON.parse(source) as {readonly version?: unknown},
        catch: cause => new Error('Could not parse package.json.', {cause}),
      }),
    ),
    Effect.flatMap(manifest =>
      typeof manifest.version === 'string' && manifest.version.length > 0
        ? Effect.succeed({version: manifest.version})
        : Effect.fail(new Error('package.json does not declare a version.')),
    ),
  );
}

function readReleaseMetadata(fs: FileSystem.FileSystem, file: string) {
  return fs.readFileString(file).pipe(
    Effect.flatMap(source =>
      Effect.try({
        try: () => JSON.parse(source) as unknown,
        catch: cause => new Error('Could not parse the development release metadata.', {cause}),
      }),
    ),
    Effect.flatMap(value => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return Effect.fail(new Error('The development release metadata is invalid.'));
      }
      const candidate = value as Partial<{
        readonly executable: string;
        readonly runtime: string;
        readonly target: string;
        readonly version: string;
      }>;
      return typeof candidate.executable === 'string' &&
        typeof candidate.runtime === 'string' &&
        typeof candidate.target === 'string' &&
        typeof candidate.version === 'string'
        ? Effect.succeed(candidate as {executable: string; runtime: string; target: string; version: string})
        : Effect.fail(new Error('The development release metadata is incomplete.'));
    }),
  );
}

const systemLayer = SystemInfo.layer;
const commandLayer = CommandExecutor.layer.pipe(Layer.provide(systemLayer));
const installerLayer = Layer.merge(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));
const program = Effect.gen(function* () {
  const options = parseLocalStandaloneInstallArguments(yield* scriptArguments());
  return yield* installLocalStandalone(options);
});

if (import.meta.main) BunRuntime.runMain(program.pipe(Effect.provide(installerLayer)));
