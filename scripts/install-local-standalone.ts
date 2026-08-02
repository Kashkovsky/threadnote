import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Crypto, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {commandLauncherPath, installCommandShim, renderCommandShim} from '../src/command-shim.js';
import {CommandExecutor, runCommandEffect} from '../src/effect/command.js';
import {captureConsole} from '../src/effect/console.js';
import {sha256FileHex} from '../src/effect/digest.js';
import {SystemInfo, type SystemInfoShape} from '../src/effect/system.js';
import {
  activateStandaloneRelease,
  installationRoot,
  promoteStandaloneReleaseDirectory,
  pruneStandaloneReleases,
  readLiveStandaloneProcessLeases,
  withStandaloneInstallationLock,
} from '../src/installations.js';
import {terminateSupersededStandaloneProcesses} from '../src/standalone_process_lease.js';
import {scriptArguments} from './effect/script.js';
import {
  DEVELOPMENT_INSTALL_RECEIPT_VERSION,
  developmentBuildVersion,
  readDevelopmentReleaseEvidence,
  readManagedDevelopmentRuntimeEvidence,
  stageAndValidateDevelopmentRelease,
  type DevelopmentInstallReceiptV1,
  type DevelopmentRuntimeEvidence,
} from './development-runtime.js';

const ROOT_URL = new URL('..', import.meta.url);
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const COMMAND_TIMEOUT_MILLISECONDS = 30 * 60_000;
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
  readonly terminateSuperseded: boolean;
}

export interface LocalStandaloneInstallResult extends DevelopmentRuntimeEvidence {
  readonly active: true;
  readonly cleanupComplete: boolean;
  readonly doctorVerified: true;
  readonly launchersVerified: true;
  readonly remainingSupersededProcesses: number;
  readonly reused: boolean;
  readonly terminatedSupersededProcesses: number;
}

export interface LocalStandaloneActivationInput {
  readonly commit: string;
  readonly executableName: string;
  readonly releaseRoot: string;
  readonly reused: boolean;
  readonly stagedRoot: Option.Option<string>;
  readonly terminateSuperseded: boolean;
  readonly version: string;
}

export function parseLocalStandaloneInstallArguments(arguments_: readonly string[]): LocalStandaloneInstallOptions {
  let json = false;
  let terminateSuperseded = false;
  for (const argument of arguments_) {
    if (argument === '--') continue;
    if (argument === '--json') json = true;
    else if (argument === '--terminate-superseded') terminateSuperseded = true;
    else throw new Error(`Unknown local standalone install option: ${argument}`);
  }
  return {json, terminateSuperseded};
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
  const installRoot = installationRoot(path, system);
  const releaseRoot = path.join(installRoot, 'versions', version);
  const executableName = system.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
  const releaseExists = yield* fs.exists(releaseRoot);
  const stagedRoot = releaseExists
    ? Option.none<string>()
    : Option.some(
        yield* buildAndStageDevelopmentRelease({
          commit,
          executableName,
          json: options.json,
          releaseRoot,
          sourceRoot,
          version,
        }),
      );
  const activation = activateLocalStandaloneRelease({
    commit,
    executableName,
    releaseRoot,
    reused: releaseExists,
    stagedRoot,
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
    yield* Console.log(
      result.remainingSupersededProcesses === 0
        ? 'No superseded Threadnote processes remain.'
        : `${result.remainingSupersededProcesses} superseded Threadnote process(es) remain; rerun with --terminate-superseded.`,
    );
    if (!result.cleanupComplete) {
      yield* Console.log('Managed cleanup is incomplete; rerun the exact-HEAD installer after active work finishes.');
    }
  }
  return result;
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
  const installRoot = installationRoot(path, system);
  const executable = path.join(input.releaseRoot, input.executableName);
  const criticalSection = Effect.gen(function* () {
    let reused = input.reused;
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
      }
    }
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

    const snapshots = yield* Effect.all([
      captureFileSnapshot(fs, yield* commandLauncherPath('cli'), 0o755),
      captureFileSnapshot(fs, yield* commandLauncherPath('mcp'), 0o755),
      captureFileSnapshot(fs, path.join(installRoot, 'active-release.json'), 0o600),
    ]);
    const activeEvidence = yield* Effect.gen(function* () {
      yield* activateStandaloneRelease(input.releaseRoot, false);
      const evidence = yield* readManagedDevelopmentRuntimeEvidence(input.commit);
      yield* installCommandShim(false, input.releaseRoot);
      yield* verifyLaunchers(fs, input.releaseRoot);
      return evidence;
    }).pipe(
      Effect.onError(() => restoreFileSnapshots(fs, path, system, snapshots).pipe(Effect.catch(() => Effect.void))),
    );

    let terminatedSupersededProcesses = 0;
    const unresolvedProcessIds = new Set<number>();
    if (input.terminateSuperseded) {
      // Revalidate the pointer immediately before signaling. The installation
      // lock prevents it from changing until retirement and pruning finish.
      yield* readManagedDevelopmentRuntimeEvidence(input.commit);
      const termination = yield* terminateSupersededStandaloneProcesses(input.version);
      terminatedSupersededProcesses = termination.signaled.length;
      for (const lease of [...termination.skippedUnverified, ...termination.remaining]) {
        unresolvedProcessIds.add(lease.processId);
      }
    }
    const live = yield* readLiveStandaloneProcessLeases();
    for (const lease of live.leases) {
      if (lease.version !== input.version) unresolvedProcessIds.add(lease.processId);
    }
    const pruningSucceeded = yield* pruneStandaloneReleases(input.releaseRoot, false).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    return {
      ...activeEvidence,
      active: true,
      cleanupComplete: !live.truncated && unresolvedProcessIds.size === 0 && pruningSucceeded,
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
  readonly mode: number;
}

const captureFileSnapshot = Effect.fn('developmentInstall.captureFileSnapshot')(function* (
  fs: FileSystem.FileSystem,
  file: string,
  mode: number,
) {
  const [exists, link, content] = yield* Effect.all([
    fs.exists(file),
    fs.readLink(file).pipe(Effect.option),
    fs.readFileString(file).pipe(Effect.option),
  ]);
  if (Option.isSome(link) || (exists && Option.isNone(content))) {
    return yield* Effect.fail(new Error('A managed installation file cannot be safely snapshotted for rollback.'));
  }
  return {content, file, mode} satisfies LocalFileSnapshot;
});

const restoreFileSnapshots = Effect.fn('developmentInstall.restoreFileSnapshots')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  snapshots: readonly LocalFileSnapshot[],
) {
  for (const snapshot of snapshots) {
    if (Option.isNone(snapshot.content)) {
      yield* fs.remove(snapshot.file, {force: true});
      continue;
    }
    yield* fs.makeDirectory(path.dirname(snapshot.file), {recursive: true, mode: 0o700});
    const content = snapshot.content.value;
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
  }
});

const buildAndStageDevelopmentRelease = Effect.fn('developmentInstall.buildAndStage')(function* (input: {
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
  if (!input.json) yield* Console.log(`Building standalone Threadnote from ${input.commit.slice(0, 12)}.`);
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
  const [executableSha256, releaseMetadataSha256, versionResult] = yield* Effect.all(
    [
      sha256FileHex(executable),
      sha256FileHex(releaseMetadataPath),
      runCommandEffect(executable, ['--version'], {maxOutputBytes: 16 * 1024, timeoutMs: 30_000}),
    ],
    {concurrency: 3},
  );
  if (versionResult.stdout.trim() !== `threadnote v${input.version}`) {
    return yield* Effect.fail(new Error('The compiled development executable reported the wrong version.'));
  }
  const receipt: DevelopmentInstallReceiptV1 = {
    builtAt: new Date().toISOString(),
    executableSha256,
    releaseMetadataSha256,
    runtime: releaseMetadata.runtime,
    schemaVersion: DEVELOPMENT_INSTALL_RECEIPT_VERSION,
    sourceCommit: input.commit,
    sourceDirty: false,
    target: releaseMetadata.target,
    version: input.version,
  };
  const crypto = yield* Crypto.Crypto;
  const versionsRoot = path.dirname(input.releaseRoot);
  const stagedRoot = path.join(versionsRoot, `.${input.version}.${yield* crypto.randomUUIDv4}.staging`);
  yield* fs.makeDirectory(versionsRoot, {recursive: true, mode: 0o700});
  return yield* stageAndValidateDevelopmentRelease({
    distributionRoot,
    executableName: input.executableName,
    expectedSourceCommit: input.commit,
    receipt,
    stagedRoot,
  });
});

const verifyLaunchers = Effect.fn('developmentInstall.verifyLaunchers')(function* (
  fs: FileSystem.FileSystem,
  releaseRoot: string,
) {
  for (const mode of ['cli', 'mcp'] as const) {
    const [launcher, expected] = yield* Effect.all([commandLauncherPath(mode), renderCommandShim(releaseRoot, mode)]);
    const actual = yield* fs.readFileString(launcher);
    if (actual !== expected) {
      return yield* Effect.fail(new Error(`The managed ${mode} launcher did not activate the development release.`));
    }
  }
});

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
