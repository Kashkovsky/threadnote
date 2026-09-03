import {Effect, FileSystem, Option, Path, PlatformError, Predicate} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {runtimeTextDirectoryNamePage} from '../effect/system.js';
import {parseCodeGraphBuildStatus, type CodeGraphBuildStatus} from './build_status.js';
import {codeGraphRepositoryRoot} from './layout.js';
import type {CodeGraphRemovedViewCleanupPageResult} from './removed_view_cleanup.js';

export const CODE_GRAPH_REMOVED_VIEW_BUILD_STATUS_LIMIT = 10_000;
export const CODE_GRAPH_REMOVED_VIEW_BUILD_DIRECTORY_ENTRY_LIMIT = CODE_GRAPH_REMOVED_VIEW_BUILD_STATUS_LIMIT * 2 + 2;
/** Primary reads plus two status and two context rechecks remain below 2 MiB. */
export const CODE_GRAPH_REMOVED_VIEW_BUILD_STATUS_PAGE_LIMIT = 29;

const STATUS_DIRECTORY = 'build-status';
const STATUS_FILE_BYTES_LIMIT = 64 * 1_024;
const MANAGER_CONTEXT_FILE_BYTES_LIMIT = 8 * 1_024;
const INVALID_SIDECAR_RETRY_MILLISECONDS = 30_000;
const IO_RETRY_MILLISECONDS = 1_000;
const HASH_ID = /^[0-9a-f]{64}$/u;
const SNAPSHOT_ID = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u;
const BUILD_STATUS_FILE = /^([0-9a-f-]{16,64})\.json$/u;
const BUILD_ID = /^[0-9a-f-]{16,64}$/u;
const BUILD_DIGEST = /^[0-9a-f]{64}$/u;
const BUILD_SCAN_DIGEST_SEED = sha256HexSync('threadnote-code-graph-build-cleanup-scan-v1');

export interface CodeGraphRemovedViewBuildCleanupOptions {
  /** @internal Deterministic replacement seam before either exact sidecar is removed. */
  readonly beforeFinalStatusObservation?: () => Effect.Effect<void, unknown>;
  /** @internal Deterministic interruption seam after context removal and before status removal. */
  readonly afterManagerContextRemoval?: () => Effect.Effect<void, unknown>;
}

/** @internal Pure boundary used to pin the 10k status plus paired-context inventory contract. */
export function codeGraphRemovedViewBuildStatusInventory(page: {
  readonly names: readonly string[];
  readonly overflow: boolean;
}): readonly string[] | undefined {
  if (page.overflow || page.names.length > CODE_GRAPH_REMOVED_VIEW_BUILD_DIRECTORY_ENTRY_LIMIT) return undefined;
  const statusNames = page.names.filter(name => BUILD_STATUS_FILE.test(name)).sort();
  return statusNames.length <= CODE_GRAPH_REMOVED_VIEW_BUILD_STATUS_LIMIT ? statusNames : undefined;
}

/** Exact parser boundary shared with the durable cleanup queue worker. */
export function isCodeGraphRemovedViewBuildStatusCursor(cursor: string): boolean {
  return parseBuildStatusCursor(cursor) !== undefined;
}

interface ObservedBuildSidecar {
  readonly content: string;
  readonly file: string;
  readonly identity: string;
  readonly info: FileSystem.File.Info;
}

interface BuildStatusCandidate extends ObservedBuildSidecar {
  readonly status: CodeGraphBuildStatus;
}

type BuildStatusCursor =
  | {readonly mode: 'reset'}
  | {readonly afterBuildId: string; readonly digest: string; readonly mode: 'scan'}
  | {
      readonly afterBuildId?: string;
      readonly digest: string;
      readonly expectedDigest: string;
      readonly mode: 'verify';
    };

class InvalidBuildSidecarError extends Error {
  readonly _tag = 'InvalidBuildSidecarError' as const;
}

/**
 * Remove at most one exact terminal status for the tombstoned snapshot.
 * Other history is observation-only, including failed records without an
 * exact result snapshot and all queued/running records.
 */
export const cleanupCodeGraphRemovedViewBuildStatusUnit = Effect.fn('codeGraph.cleanupRemovedViewBuildStatusUnit')(
  function* (
    threadnoteHome: string,
    checkoutId: string,
    worktreeId: string,
    expectedSnapshotId: string,
    cursorToken?: string,
    options: CodeGraphRemovedViewBuildCleanupOptions = {},
  ) {
    if (
      !HASH_ID.test(checkoutId) ||
      !HASH_ID.test(worktreeId) ||
      !SNAPSHOT_ID.test(expectedSnapshotId) ||
      (cursorToken !== undefined && !isCodeGraphRemovedViewBuildStatusCursor(cursorToken))
    ) {
      return invalidSidecarResult();
    }

    return yield* cleanupBuildStatusUnit(
      threadnoteHome,
      checkoutId,
      worktreeId,
      expectedSnapshotId,
      cursorToken,
      options,
    ).pipe(Effect.catch(cause => Effect.succeed(classifyFailure(cause))));
  },
);

const cleanupBuildStatusUnit = Effect.fn('codeGraph.cleanupRemovedViewBuildStatusUnitUnsafe')(function* (
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
  expectedSnapshotId: string,
  cursorToken: string | undefined,
  options: CodeGraphRemovedViewBuildCleanupOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* inspectBuildStatusDirectory(fs, path, threadnoteHome, checkoutId, worktreeId);
  if (directory === undefined) return {state: 'complete'} as const satisfies CodeGraphRemovedViewCleanupPageResult;

  const page = yield* runtimeTextDirectoryNamePage(directory, CODE_GRAPH_REMOVED_VIEW_BUILD_DIRECTORY_ENTRY_LIMIT).pipe(
    Effect.mapError(error =>
      error instanceof TypeError
        ? new InvalidBuildSidecarError('Build status inventory contains a non-text name.')
        : error,
    ),
  );
  const statusNames = codeGraphRemovedViewBuildStatusInventory(page);
  if (statusNames === undefined) {
    return yield* Effect.fail(new InvalidBuildSidecarError('Build status inventory exceeded its status limit.'));
  }

  const parsedCursor = cursorToken === undefined ? undefined : parseBuildStatusCursor(cursorToken);
  const scan =
    parsedCursor === undefined || parsedCursor.mode === 'reset'
      ? {afterBuildId: undefined, digest: BUILD_SCAN_DIGEST_SEED, mode: 'scan' as const}
      : parsedCursor;
  if (scan.afterBuildId !== undefined && !statusNames.includes(`${scan.afterBuildId}.json`)) {
    return {
      cursorToken: buildResetCursor(cursorToken ?? '', 'missing-page-anchor'),
      state: 'progress',
    } as const satisfies CodeGraphRemovedViewCleanupPageResult;
  }
  const remainingNames = statusNames.filter(name => {
    if (scan.afterBuildId === undefined) return true;
    return name > `${scan.afterBuildId}.json`;
  });
  const pageNames = remainingNames.slice(0, CODE_GRAPH_REMOVED_VIEW_BUILD_STATUS_PAGE_LIMIT);
  let digest = scan.digest;

  let candidate: BuildStatusCandidate | undefined;
  for (const name of pageNames) {
    const observed = yield* readBuildStatusCandidate(fs, path, path.join(directory, name), checkoutId, worktreeId);
    if (observed === undefined) {
      return yield* Effect.fail(new InvalidBuildSidecarError('Build status disappeared during its bounded page.'));
    }
    digest = nextBuildStatusScanDigest(digest, observed);
    if (
      (observed.status.state === 'completed' || observed.status.state === 'failed') &&
      observed.status.result?.snapshotId === expectedSnapshotId
    ) {
      candidate = observed;
      break;
    }
  }
  if (candidate === undefined) {
    const hasMore = remainingNames.length > pageNames.length;
    const lastBuildId = pageNames.at(-1)?.slice(0, -5);
    if (hasMore) {
      if (lastBuildId === undefined) {
        return yield* Effect.fail(new InvalidBuildSidecarError('Build status page cursor is unavailable.'));
      }
      return scan.mode === 'scan'
        ? ({cursorToken: buildScanCursor(lastBuildId, digest), state: 'progress'} as const)
        : ({
            cursorToken: buildVerificationCursor(scan.expectedDigest, lastBuildId, digest),
            state: 'progress',
          } as const);
    }
    if (scan.mode === 'verify') {
      return digest === scan.expectedDigest
        ? ({state: 'complete'} as const satisfies CodeGraphRemovedViewCleanupPageResult)
        : ({cursorToken: buildResetCursor(scan.expectedDigest, digest), state: 'progress'} as const);
    }
    if (statusNames.length === 0) {
      return {state: 'complete'} as const satisfies CodeGraphRemovedViewCleanupPageResult;
    }
    return {
      cursorToken: buildVerificationCursor(digest, undefined, BUILD_SCAN_DIGEST_SEED),
      state: 'progress',
    } as const satisfies CodeGraphRemovedViewCleanupPageResult;
  }

  const contextFile = path.join(directory, `${candidate.status.buildId}.manager-context`);
  const initialContext = yield* readManagerContextCandidate(fs, contextFile, candidate.status.buildId);
  yield* options.beforeFinalStatusObservation?.() ?? Effect.void;
  const finalStatus = yield* readBuildStatusCandidate(fs, path, candidate.file, checkoutId, worktreeId);
  const finalContext = yield* readManagerContextCandidate(fs, contextFile, candidate.status.buildId);
  if (
    finalStatus === undefined ||
    !sameObservedSidecar(candidate, finalStatus) ||
    finalStatus.status.state !== candidate.status.state ||
    finalStatus.status.result?.snapshotId !== expectedSnapshotId ||
    !sameOptionalObservedSidecar(initialContext, finalContext)
  ) {
    return yield* Effect.fail(new InvalidBuildSidecarError('Build status authority changed.'));
  }

  if (finalContext !== undefined) yield* fs.remove(contextFile, {force: false});
  yield* options.afterManagerContextRemoval?.() ?? Effect.void;
  const ownedStatus = yield* readBuildStatusCandidate(fs, path, candidate.file, checkoutId, worktreeId);
  if (
    ownedStatus === undefined ||
    !sameObservedSidecar(candidate, ownedStatus) ||
    ownedStatus.status.result?.snapshotId !== expectedSnapshotId
  ) {
    return yield* Effect.fail(new InvalidBuildSidecarError('Build status changed before removal.'));
  }
  yield* fs.remove(candidate.file, {force: false});
  return {
    cursorToken: buildResetCursor(cursorToken ?? '', candidate.status.buildId, candidate.identity),
    state: 'progress',
  } as const satisfies CodeGraphRemovedViewCleanupPageResult;
});

const inspectBuildStatusDirectory = Effect.fn('codeGraph.inspectRemovedViewBuildStatusDirectory')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
) {
  if ((yield* optionalDirectory(fs, threadnoteHome)) === undefined) return undefined;
  const canonicalHome = yield* fs.realPath(threadnoteHome);
  const repositoryRoot = codeGraphRepositoryRoot(path, threadnoteHome, checkoutId);
  const repository = yield* optionalDirectory(fs, repositoryRoot);
  if (repository === undefined) return undefined;
  const canonicalRepository = yield* fs.realPath(repositoryRoot);
  if (canonicalRepository !== path.join(canonicalHome, 'indexes', 'code-graph', 'repositories', checkoutId)) {
    return yield* Effect.fail(new InvalidBuildSidecarError('Build status repository escaped containment.'));
  }

  const statusRoot = path.join(repositoryRoot, STATUS_DIRECTORY);
  if ((yield* optionalDirectory(fs, statusRoot)) === undefined) return undefined;
  const canonicalStatusRoot = yield* fs.realPath(statusRoot);
  if (canonicalStatusRoot !== path.join(canonicalRepository, STATUS_DIRECTORY)) {
    return yield* Effect.fail(new InvalidBuildSidecarError('Build status root escaped containment.'));
  }

  const directory = path.join(statusRoot, worktreeId);
  if ((yield* optionalDirectory(fs, directory)) === undefined) return undefined;
  const canonicalDirectory = yield* fs.realPath(directory);
  if (canonicalDirectory !== path.join(canonicalStatusRoot, worktreeId)) {
    return yield* Effect.fail(new InvalidBuildSidecarError('Build status worktree escaped containment.'));
  }
  return canonicalDirectory;
});

const readBuildStatusCandidate = Effect.fn('codeGraph.readRemovedViewBuildStatusCandidate')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
  checkoutId: string,
  worktreeId: string,
) {
  const observed = yield* readObservedSidecar(fs, file, STATUS_FILE_BYTES_LIMIT);
  if (observed === undefined) return undefined;
  const parsed = yield* Effect.try({
    try: () => parseCodeGraphBuildStatus(JSON.parse(observed.content)),
    catch: () => new InvalidBuildSidecarError('Build status manifest is invalid.'),
  });
  if (
    parsed === undefined ||
    parsed.identity.checkoutId !== checkoutId ||
    parsed.identity.worktreeId !== worktreeId ||
    path.basename(file) !== `${parsed.buildId}.json`
  ) {
    return yield* Effect.fail(new InvalidBuildSidecarError('Build status manifest is invalid.'));
  }
  return {...observed, status: parsed} satisfies BuildStatusCandidate;
});

const readManagerContextCandidate = Effect.fn('codeGraph.readRemovedViewManagerContextCandidate')(function* (
  fs: FileSystem.FileSystem,
  file: string,
  buildId: string,
) {
  const observed = yield* readObservedSidecar(fs, file, MANAGER_CONTEXT_FILE_BYTES_LIMIT);
  if (observed === undefined) return undefined;
  const valid = yield* Effect.try({
    try: () => {
      const value: unknown = JSON.parse(observed.content);
      return (
        Predicate.isObject(value) &&
        value.schemaVersion === 1 &&
        value.buildId === buildId &&
        typeof value.worktreePath === 'string' &&
        value.worktreePath.length > 0 &&
        new TextEncoder().encode(value.worktreePath).byteLength <= 4_096 &&
        !value.worktreePath.includes('\0')
      );
    },
    catch: () => new InvalidBuildSidecarError('Build manager context is invalid.'),
  });
  if (!valid) return yield* Effect.fail(new InvalidBuildSidecarError('Build manager context is invalid.'));
  return observed;
});

const readObservedSidecar = Effect.fn('codeGraph.readRemovedViewBuildSidecar')(function* (
  fs: FileSystem.FileSystem,
  file: string,
  bytesLimit: number,
) {
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
    return yield* Effect.fail(new InvalidBuildSidecarError('Build sidecar is a symbolic link.'));
  }
  const pathInfo = yield* optionalFileInfo(fs, file);
  if (pathInfo === undefined) return undefined;
  if (pathInfo.type !== 'File' || Number(pathInfo.size) > bytesLimit || (pathInfo.mode & 0o077) !== 0) {
    return yield* Effect.fail(new InvalidBuildSidecarError('Build sidecar is not a bounded regular file.'));
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* fs.open(file, {flag: 'r'});
      const openedBefore = yield* opened.stat;
      const pathOpened = yield* fs.stat(file);
      if (!sameObservedFileInfo(pathInfo, openedBefore) || !sameObservedFileInfo(pathInfo, pathOpened)) {
        return yield* Effect.fail(new InvalidBuildSidecarError('Build sidecar changed while opening.'));
      }

      const bytes = new Uint8Array(bytesLimit + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = Number(yield* opened.read(bytes.subarray(offset)));
        if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - offset) {
          return yield* Effect.fail(new InvalidBuildSidecarError('Build sidecar returned an invalid read size.'));
        }
        if (count === 0) break;
        offset += count;
      }
      const openedAfter = yield* opened.stat;
      const pathAfter = yield* fs.stat(file);
      if (
        !sameObservedFileInfo(pathInfo, openedAfter) ||
        !sameObservedFileInfo(pathInfo, pathAfter) ||
        offset > bytesLimit ||
        BigInt(offset) !== pathInfo.size
      ) {
        return yield* Effect.fail(new InvalidBuildSidecarError('Build sidecar changed during bounded read.'));
      }
      const content = yield* Effect.try({
        try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, offset)),
        catch: () => new InvalidBuildSidecarError('Build sidecar is not valid UTF-8.'),
      });
      return {
        content,
        file,
        identity: sidecarIdentity(pathInfo, sha256HexSync(content)),
        info: pathInfo,
      } satisfies ObservedBuildSidecar;
    }),
  );
});

function sameObservedSidecar(left: ObservedBuildSidecar, right: ObservedBuildSidecar): boolean {
  return (
    left.file === right.file &&
    left.content === right.content &&
    left.identity === right.identity &&
    sameObservedFileInfo(left.info, right.info)
  );
}

function parseBuildStatusCursor(cursor: string): BuildStatusCursor | undefined {
  const fields = cursor.split(':');
  if (fields[0] !== 'bs1') return undefined;
  if (
    fields.length === 4 &&
    fields[1] === 'r' &&
    BUILD_DIGEST.test(fields[2]) &&
    validBuildCursorSeal(fields.slice(0, -1), fields[3])
  ) {
    return {mode: 'reset'};
  }
  if (
    fields.length === 5 &&
    fields[1] === 's' &&
    BUILD_ID.test(fields[2]) &&
    BUILD_DIGEST.test(fields[3]) &&
    validBuildCursorSeal(fields.slice(0, -1), fields[4])
  ) {
    return {afterBuildId: fields[2], digest: fields[3], mode: 'scan'};
  }
  if (
    fields.length === 6 &&
    fields[1] === 'v' &&
    BUILD_DIGEST.test(fields[2]) &&
    (fields[3] === '-' || BUILD_ID.test(fields[3])) &&
    BUILD_DIGEST.test(fields[4]) &&
    validBuildCursorSeal(fields.slice(0, -1), fields[5])
  ) {
    return {
      ...(fields[3] === '-' ? {} : {afterBuildId: fields[3]}),
      digest: fields[4],
      expectedDigest: fields[2],
      mode: 'verify',
    };
  }
  return undefined;
}

function nextBuildStatusScanDigest(digest: string, observed: BuildStatusCandidate): string {
  return sha256HexSync(
    ['threadnote-code-graph-build-cleanup-page-v1', digest, observed.status.buildId, observed.identity].join('\0'),
  );
}

function buildScanCursor(buildId: string, digest: string): string {
  return sealedBuildCursor(['bs1', 's', buildId, digest]);
}

function buildVerificationCursor(expectedDigest: string, afterBuildId: string | undefined, digest: string): string {
  return sealedBuildCursor(['bs1', 'v', expectedDigest, afterBuildId ?? '-', digest]);
}

function buildResetCursor(...identity: readonly string[]): string {
  return sealedBuildCursor([
    'bs1',
    'r',
    sha256HexSync(['threadnote-code-graph-build-cleanup-reset-v1', ...identity].join('\0')),
  ]);
}

function sealedBuildCursor(fields: readonly string[]): string {
  return [...fields, buildCursorSeal(fields)].join(':');
}

function validBuildCursorSeal(fields: readonly string[], seal: string): boolean {
  return BUILD_DIGEST.test(seal) && seal === buildCursorSeal(fields);
}

function buildCursorSeal(fields: readonly string[]): string {
  return sha256HexSync(['threadnote-code-graph-build-cleanup-cursor-v1', ...fields].join('\0'));
}

function sameOptionalObservedSidecar(
  left: ObservedBuildSidecar | undefined,
  right: ObservedBuildSidecar | undefined,
): boolean {
  return left === undefined ? right === undefined : right !== undefined && sameObservedSidecar(left, right);
}

function sameObservedFileInfo(left: FileSystem.File.Info, right: FileSystem.File.Info): boolean {
  return (
    left.type === 'File' &&
    right.type === 'File' &&
    left.dev === right.dev &&
    Option.getOrUndefined(left.ino) === Option.getOrUndefined(right.ino) &&
    left.size === right.size &&
    left.mode === right.mode &&
    Option.getOrUndefined(left.mtime)?.getTime() === Option.getOrUndefined(right.mtime)?.getTime()
  );
}

function sidecarIdentity(info: FileSystem.File.Info, contentDigest: string): string {
  return sha256HexSync(
    [
      'threadnote-code-graph-build-cleanup-file-v1',
      contentDigest,
      String(info.dev),
      String(Option.getOrUndefined(info.ino)),
      String(info.size),
      String(info.mode),
      String(Option.getOrUndefined(info.mtime)?.getTime()),
    ].join('\0'),
  );
}

function optionalDirectory(fs: FileSystem.FileSystem, directory: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
      return yield* Effect.fail(new InvalidBuildSidecarError('Build status directory is a symbolic link.'));
    }
    const info = yield* optionalFileInfo(fs, directory);
    if (info === undefined) return undefined;
    if (info.type !== 'Directory') {
      return yield* Effect.fail(new InvalidBuildSidecarError('Build status directory is not a directory.'));
    }
    return info;
  });
}

function optionalFileInfo(fs: FileSystem.FileSystem, file: string) {
  return fs.stat(file).pipe(
    Effect.map(info => info as FileSystem.File.Info | undefined),
    Effect.catch(error =>
      error instanceof PlatformError.PlatformError && error.reason._tag === 'NotFound'
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );
}

function classifyFailure(cause: unknown): CodeGraphRemovedViewCleanupPageResult {
  if (cause instanceof InvalidBuildSidecarError) return invalidSidecarResult();
  if (cause instanceof PlatformError.PlatformError && cause.reason._tag === 'PermissionDenied') {
    return {blockedCode: 'permission-denied', retryAfterMilliseconds: 30_000, state: 'deferred'};
  }
  return {blockedCode: 'io-error', retryAfterMilliseconds: IO_RETRY_MILLISECONDS, state: 'deferred'};
}

function invalidSidecarResult(): CodeGraphRemovedViewCleanupPageResult {
  return {
    blockedCode: 'invalid-sidecar',
    retryAfterMilliseconds: INVALID_SIDECAR_RETRY_MILLISECONDS,
    state: 'deferred',
  };
}
