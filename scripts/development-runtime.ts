import {Effect, FileSystem, Option, Path} from 'effect';
import {runCommandEffect} from '../src/effect/command.js';
import {sha256FileHex} from '../src/effect/digest.js';
import {SystemInfo} from '../src/effect/system.js';
import {installationRoot, readLiveStandaloneProcessLeases} from '../src/installations.js';

export const DEVELOPMENT_INSTALL_RECEIPT = 'development-install.json';
export const DEVELOPMENT_INSTALL_RECEIPT_VERSION = 1 as const;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RELEASE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const DEVELOPMENT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:[0-9A-Za-z-]+\.)*local\.g([0-9a-f]{40}(?:[0-9a-f]{24})?)$/;

export interface DevelopmentInstallReceiptV1 {
  readonly builtAt: string;
  readonly executableSha256: string;
  readonly releaseMetadataSha256: string;
  readonly runtime: string;
  readonly schemaVersion: typeof DEVELOPMENT_INSTALL_RECEIPT_VERSION;
  readonly sourceCommit: string;
  readonly sourceDirty: false;
  readonly target: string;
  readonly version: string;
}

export interface DevelopmentRuntimeEvidence {
  readonly executableSha256: string;
  readonly releaseMetadataSha256: string;
  readonly runtime: string;
  readonly sourceCommit: string;
  readonly target: string;
  readonly version: string;
}

interface ActiveReleasePointer {
  readonly releaseRoot: string;
  readonly version: string;
}

interface ReleaseMetadata {
  readonly executable: string;
  readonly runtime: string;
  readonly target: string;
  readonly version: string;
}

export function developmentBuildVersion(packageVersion: string, sourceCommit: string): string {
  if (!RELEASE_VERSION_PATTERN.test(packageVersion) || !SOURCE_COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error('A local development build requires a valid package version and exact Git commit.');
  }
  if (isDevelopmentBuildVersion(packageVersion)) {
    throw new Error('The checked-in package version must not already be a local development version.');
  }
  const separator = packageVersion.includes('-') ? '.' : '-';
  const version = `${packageVersion}${separator}local.g${sourceCommit}`;
  if (!isDevelopmentBuildVersion(version)) {
    throw new Error('Could not derive a valid local development version.');
  }
  return version;
}

export function isDevelopmentBuildVersion(version: string): boolean {
  return DEVELOPMENT_VERSION_PATTERN.test(version);
}

export function developmentVersionSourceCommit(version: string): Option.Option<string> {
  return Option.fromNullishOr(DEVELOPMENT_VERSION_PATTERN.exec(version)?.[1]);
}

export function parseDevelopmentInstallReceipt(value: unknown): Option.Option<DevelopmentInstallReceiptV1> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return Option.none();
  const candidate = value as Partial<DevelopmentInstallReceiptV1>;
  return candidate.schemaVersion === DEVELOPMENT_INSTALL_RECEIPT_VERSION &&
    typeof candidate.builtAt === 'string' &&
    Number.isFinite(Date.parse(candidate.builtAt)) &&
    typeof candidate.version === 'string' &&
    isDevelopmentBuildVersion(candidate.version) &&
    typeof candidate.sourceCommit === 'string' &&
    SOURCE_COMMIT_PATTERN.test(candidate.sourceCommit) &&
    candidate.sourceDirty === false &&
    typeof candidate.executableSha256 === 'string' &&
    SHA256_PATTERN.test(candidate.executableSha256) &&
    typeof candidate.releaseMetadataSha256 === 'string' &&
    SHA256_PATTERN.test(candidate.releaseMetadataSha256) &&
    typeof candidate.runtime === 'string' &&
    candidate.runtime.length > 0 &&
    typeof candidate.target === 'string' &&
    candidate.target.length > 0
    ? Option.some(candidate as DevelopmentInstallReceiptV1)
    : Option.none();
}

export const readManagedDevelopmentRuntimeEvidence = Effect.fn('developmentRuntime.readManaged')(function* (
  expectedSourceCommit: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  if (!SOURCE_COMMIT_PATTERN.test(expectedSourceCommit)) {
    return yield* Effect.fail(new Error('Managed development runtime validation requires an exact source commit.'));
  }
  const installRoot = installationRoot(path, system);
  const active = yield* readJsonOption(fs, path.join(installRoot, 'active-release.json')).pipe(
    Effect.map(Option.flatMap(parseActiveReleasePointer)),
  );
  if (Option.isNone(active)) {
    return yield* Effect.fail(new Error('The managed Threadnote active release pointer is missing or invalid.'));
  }
  const logicalVersionsRoot = path.resolve(path.join(installRoot, 'versions'));
  const expectedReleaseRoot = path.join(logicalVersionsRoot, active.value.version);
  if (path.resolve(active.value.releaseRoot) !== path.resolve(expectedReleaseRoot)) {
    return yield* Effect.fail(new Error('The managed Threadnote active release pointer escapes the versions root.'));
  }
  const [realInstallRoot, realVersionsRoot, realReleaseRoot] = yield* Effect.all([
    fs.realPath(installRoot),
    fs.realPath(logicalVersionsRoot),
    fs.realPath(expectedReleaseRoot),
  ]);
  if (realVersionsRoot !== path.join(realInstallRoot, 'versions')) {
    return yield* Effect.fail(new Error('The managed Threadnote versions directory is not canonical.'));
  }
  if (realReleaseRoot !== path.join(realVersionsRoot, active.value.version)) {
    return yield* Effect.fail(new Error('The managed Threadnote active release is not a canonical release directory.'));
  }
  const evidence = yield* readDevelopmentReleaseEvidence(expectedReleaseRoot, expectedSourceCommit);
  if (evidence.version !== active.value.version) {
    return yield* Effect.fail(new Error('The managed Threadnote active pointer and release version do not match.'));
  }
  return evidence;
});

/**
 * Fail-closed preflight for local benchmark and host-integration harnesses.
 * It proves the active bytes came from the exact source commit and that no
 * identity-verified process remains pinned to another managed release.
 */
export const verifyManagedDevelopmentRuntimeForSource = Effect.fn('developmentRuntime.verifyForSource')(function* (
  expectedSourceCommit: string,
) {
  const evidence = yield* readManagedDevelopmentRuntimeEvidence(expectedSourceCommit);
  const live = yield* readLiveStandaloneProcessLeases();
  if (live.truncated) {
    return yield* Effect.fail(
      new Error('Managed development runtime verification could not inspect every live process lease.'),
    );
  }
  if (live.leases.some(lease => lease.version !== evidence.version)) {
    return yield* Effect.fail(
      new Error('Managed development runtime verification found a process pinned to a superseded release.'),
    );
  }
  return evidence;
});

export const readDevelopmentReleaseEvidence = Effect.fn('developmentRuntime.readRelease')(function* (
  releaseRoot: string,
  expectedSourceCommit: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const receiptValue = yield* readJsonOption(fs, path.join(releaseRoot, DEVELOPMENT_INSTALL_RECEIPT));
  const metadataValue = yield* readJsonOption(fs, path.join(releaseRoot, 'release.json'));
  const receipt = Option.flatMap(receiptValue, parseDevelopmentInstallReceipt);
  const metadata = Option.flatMap(metadataValue, parseReleaseMetadata);
  if (Option.isNone(receipt) || Option.isNone(metadata)) {
    return yield* Effect.fail(new Error('The managed development release metadata or provenance is invalid.'));
  }
  const sourceFromVersion = developmentVersionSourceCommit(receipt.value.version);
  if (
    receipt.value.sourceCommit !== expectedSourceCommit ||
    Option.getOrUndefined(sourceFromVersion) !== expectedSourceCommit ||
    metadata.value.version !== receipt.value.version ||
    metadata.value.runtime !== receipt.value.runtime ||
    metadata.value.target !== receipt.value.target
  ) {
    return yield* Effect.fail(new Error('The managed development release does not match the exact source commit.'));
  }
  const executableName = system.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
  if (metadata.value.executable !== executableName) {
    return yield* Effect.fail(new Error('The managed development release executable metadata is invalid.'));
  }
  const executable = path.join(releaseRoot, executableName);
  const [realReleaseParent, realReleaseRoot] = yield* Effect.all([
    fs.realPath(path.dirname(releaseRoot)),
    fs.realPath(releaseRoot),
  ]);
  if (realReleaseRoot !== path.join(realReleaseParent, path.basename(releaseRoot))) {
    return yield* Effect.fail(new Error('The managed development release directory is not canonical.'));
  }
  const canonicalFiles = [
    [executable, path.join(realReleaseRoot, executableName)],
    [path.join(releaseRoot, 'release.json'), path.join(realReleaseRoot, 'release.json')],
    [path.join(releaseRoot, DEVELOPMENT_INSTALL_RECEIPT), path.join(realReleaseRoot, DEVELOPMENT_INSTALL_RECEIPT)],
  ] as const;
  for (const [file, expectedRealFile] of canonicalFiles) {
    if ((yield* fs.realPath(file)) !== expectedRealFile) {
      return yield* Effect.fail(new Error('The managed development release contains a non-canonical file link.'));
    }
  }
  const [executableSha256, releaseMetadataSha256, versionResult] = yield* Effect.all(
    [
      sha256FileHex(executable),
      sha256FileHex(path.join(releaseRoot, 'release.json')),
      runCommandEffect(executable, ['--version'], {
        env: {...system.environment(), THREADNOTE_INSTALL_ROOT: installationRoot(path, system)},
        maxOutputBytes: 16 * 1024,
        timeoutMs: 30_000,
      }),
    ],
    {concurrency: 3},
  );
  if (
    executableSha256 !== receipt.value.executableSha256 ||
    releaseMetadataSha256 !== receipt.value.releaseMetadataSha256 ||
    versionResult.stdout.trim() !== `threadnote v${receipt.value.version}`
  ) {
    return yield* Effect.fail(new Error('The managed development release failed its digest or version check.'));
  }
  return {
    executableSha256,
    releaseMetadataSha256,
    runtime: receipt.value.runtime,
    sourceCommit: receipt.value.sourceCommit,
    target: receipt.value.target,
    version: receipt.value.version,
  } satisfies DevelopmentRuntimeEvidence;
});

/**
 * Copies a completed build into a disposable release directory, writes its
 * provenance receipt, and validates the exact bytes before the directory can
 * be promoted. Any failure after staging begins removes the disposable tree.
 */
export const stageAndValidateDevelopmentRelease = Effect.fn('developmentRuntime.stageRelease')(function* (input: {
  readonly distributionRoot: string;
  readonly executableName: string;
  readonly expectedSourceCommit: string;
  readonly receipt: DevelopmentInstallReceiptV1;
  readonly stagedRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const stage = Effect.gen(function* () {
    yield* fs.copy(input.distributionRoot, input.stagedRoot, {overwrite: true});
    yield* fs.writeFileString(
      path.join(input.stagedRoot, DEVELOPMENT_INSTALL_RECEIPT),
      `${JSON.stringify(input.receipt, undefined, 2)}\n`,
      {mode: 0o600},
    );
    if (system.platform !== 'win32') {
      yield* fs.chmod(path.join(input.stagedRoot, input.executableName), 0o755);
    }
    yield* readDevelopmentReleaseEvidence(input.stagedRoot, input.expectedSourceCommit).pipe(
      Effect.mapError(
        cause => new Error('The staged development release failed validation before activation.', {cause}),
      ),
    );
    return input.stagedRoot;
  });
  return yield* stage.pipe(
    Effect.onError(() =>
      fs.remove(input.stagedRoot, {force: true, recursive: true}).pipe(Effect.catch(() => Effect.void)),
    ),
  );
});

function parseActiveReleasePointer(value: unknown): Option.Option<ActiveReleasePointer> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return Option.none();
  const candidate = value as Partial<ActiveReleasePointer>;
  return typeof candidate.releaseRoot === 'string' &&
    typeof candidate.version === 'string' &&
    isDevelopmentBuildVersion(candidate.version)
    ? Option.some(candidate as ActiveReleasePointer)
    : Option.none();
}

function parseReleaseMetadata(value: unknown): Option.Option<ReleaseMetadata> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return Option.none();
  const candidate = value as Partial<ReleaseMetadata>;
  return typeof candidate.executable === 'string' &&
    typeof candidate.runtime === 'string' &&
    typeof candidate.target === 'string' &&
    typeof candidate.version === 'string' &&
    isDevelopmentBuildVersion(candidate.version)
    ? Option.some(candidate as ReleaseMetadata)
    : Option.none();
}

function readJsonOption(fs: FileSystem.FileSystem, file: string): Effect.Effect<Option.Option<unknown>> {
  return fs.readFileString(file).pipe(
    Effect.flatMap(source => Effect.try(() => JSON.parse(source) as unknown)),
    Effect.option,
  );
}
