import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {runBinaryCommandEffect, runCommandEffect} from '../effect/command.js';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {codeGraphGitIndexSemanticSha256} from './git_index_semantic.js';
import type {RepositoryIdentity} from './types.js';

export const CODE_GRAPH_GIT_STATUS_CACHE_RECEIPT_VERSION = 3 as const;
// Avoid a persistent Git monitor and private-index setup for repositories
// whose ordinary status scan is already cheaper than cache initialization.
export const CODE_GRAPH_GIT_STATUS_CACHE_INDEX_BYTES_MINIMUM = 8 * 1_048_576;
export const CODE_GRAPH_GIT_STATUS_CACHE_INDEX_BYTES_MAXIMUM = 512 * 1_048_576;

const RECEIPT_BYTES_MAXIMUM = 1_024;
const SEMANTIC_INDEX_OUTPUT_BYTES_MAXIMUM = 128 * 1_048_576;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STATUS_CACHE_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: 120_000,
} as const;

export interface CodeGraphGitStatusCacheReceipt {
  readonly indexBytes: number;
  readonly sourceIndexDevice: number;
  readonly sourceIndexInode: number;
  readonly sourceIndexModifiedAtMilliseconds: number;
  readonly sourceIndexSemanticSha256?: string;
  readonly version: typeof CODE_GRAPH_GIT_STATUS_CACHE_RECEIPT_VERSION;
}

type CodeGraphGitIndexIdentity = Omit<CodeGraphGitStatusCacheReceipt, 'sourceIndexSemanticSha256' | 'version'>;

export interface CodeGraphGitStatusCacheOptions {
  readonly minimumIndexBytes?: number;
}

class CodeGraphGitStatusCacheUnavailable extends Schema.TaggedError<CodeGraphGitStatusCacheUnavailable>()(
  'CodeGraphGitStatusCacheUnavailable',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export const worktreeStatusWithPrivateCache = Effect.fn('codeGraph.worktreeStatusWithPrivateCache')(function* (
  identity: RepositoryIdentity,
  threadnoteHome: string | undefined,
  statusArguments: readonly string[],
  options: CodeGraphGitStatusCacheOptions = {},
) {
  const plain = () =>
    runCommandEffect('git', ['--no-optional-locks', '-C', identity.repoRoot, ...statusArguments], {
      maxOutputBytes: 0,
      timeoutMs: 0,
    });
  if (threadnoteHome === undefined) return yield* plain();
  return yield* acceleratedWorktreeStatus(identity, threadnoteHome, statusArguments, options).pipe(
    Effect.catch(() => plain()),
  );
});

const acceleratedWorktreeStatus = Effect.fn('codeGraph.acceleratedWorktreeStatus')(function* (
  identity: RepositoryIdentity,
  threadnoteHome: string,
  statusArguments: readonly string[],
  options: CodeGraphGitStatusCacheOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const minimumIndexBytes = options.minimumIndexBytes ?? CODE_GRAPH_GIT_STATUS_CACHE_INDEX_BYTES_MINIMUM;
  if (!Number.isSafeInteger(minimumIndexBytes) || minimumIndexBytes < 0) {
    return yield* CodeGraphGitStatusCacheUnavailable.make({message: 'Invalid private Git index threshold.'});
  }
  const resolvedIndex = (yield* runCommandEffect(
    'git',
    ['--no-optional-locks', '-C', identity.repoRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'index'],
    {maxOutputBytes: 16_384, timeoutMs: 30_000},
  )).stdout.trim();
  if (!path.isAbsolute(resolvedIndex) || /[\0\r\n]/.test(resolvedIndex)) {
    return yield* CodeGraphGitStatusCacheUnavailable.make({message: 'Git index path is unavailable.'});
  }
  if (Option.isSome(yield* fs.readLink(resolvedIndex).pipe(Effect.option))) {
    return yield* CodeGraphGitStatusCacheUnavailable.make({message: 'Git index is symbolic.'});
  }
  const sourceIdentity = codeGraphGitIndexIdentity(yield* fs.stat(resolvedIndex));
  if (
    sourceIdentity === undefined ||
    sourceIdentity.indexBytes < minimumIndexBytes ||
    sourceIdentity.indexBytes > CODE_GRAPH_GIT_STATUS_CACHE_INDEX_BYTES_MAXIMUM
  ) {
    return yield* CodeGraphGitStatusCacheUnavailable.make({message: 'Git index is outside private-cache bounds.'});
  }

  const privateHome = path.resolve(threadnoteHome);
  const cacheRoot = path.join(
    privateHome,
    'indexes',
    'code-graph',
    'repositories',
    identity.checkoutId,
    'git-status',
    identity.worktreeId,
  );
  yield* ensurePrivateCacheDirectory(fs, path, privateHome, cacheRoot);
  const lockPath = path.join(cacheRoot, '.status.lock');
  return yield* withExclusiveFileLock(
    fs,
    lockPath,
    STATUS_CACHE_LOCK_OPTIONS,
    runCachedStatus(fs, path, privateHome, identity, resolvedIndex, sourceIdentity, cacheRoot, statusArguments),
  );
});

function runCachedStatus(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  privateHome: string,
  identity: RepositoryIdentity,
  sourceIndex: string,
  sourceIdentity: CodeGraphGitIndexIdentity,
  cacheRoot: string,
  statusArguments: readonly string[],
) {
  return Effect.gen(function* () {
    yield* ensurePrivateCacheDirectory(fs, path, privateHome, cacheRoot);
    const privateIndex = path.join(cacheRoot, 'index');
    const receiptPath = path.join(cacheRoot, 'receipt-v3.json');
    const receipt = yield* readReceipt(fs, receiptPath);
    const privateIndexAvailable = yield* privateRegularFileWithinBound(fs, privateIndex);
    const metadataReusable =
      receipt !== undefined && sameCodeGraphGitIndexIdentity(receipt, sourceIdentity) && privateIndexAvailable;
    let sourceIndexSemanticSha256: string | undefined;
    let reusable = metadataReusable;
    // Git may atomically rewrite its real index for stat-cache housekeeping
    // without changing staged entries or index flags. Preserve the warmed
    // private fsmonitor index across that metadata-only churn, but fail closed
    // to initialization when the bounded semantic observation is unavailable
    // or names different staged content.
    if (!reusable && privateIndexAvailable && receipt?.sourceIndexSemanticSha256 !== undefined) {
      sourceIndexSemanticSha256 = Option.getOrUndefined(
        yield* observeSourceIndexSemanticSha256(fs, identity, sourceIndex, sourceIdentity).pipe(Effect.option),
      );
      reusable = sourceIndexSemanticSha256 === receipt.sourceIndexSemanticSha256;
    }
    if (!reusable) {
      yield* rejectSymbolicTarget(fs, receiptPath);
      yield* fs.remove(receiptPath, {force: true});
      sourceIndexSemanticSha256 ??= Option.getOrUndefined(
        yield* observeSourceIndexSemanticSha256(fs, identity, sourceIndex, sourceIdentity).pipe(Effect.option),
      );
      yield* initializePrivateIndex(fs, path, identity, sourceIndex, sourceIdentity, privateIndex);
    }

    const result = yield* runCommandEffect(
      'git',
      [
        // Keep the cache-affecting configuration explicit as well as the
        // porcelain flags. Git seeds its untracked-cache mode from config
        // before applying the command-line status options.
        '-c',
        'core.untrackedCache=true',
        '-c',
        'core.fsmonitor=true',
        '-c',
        'status.showUntrackedFiles=all',
        '-c',
        'diff.ignoreSubmodules=none',
        '-C',
        identity.repoRoot,
        ...statusArguments,
      ],
      {maxOutputBytes: 0, timeoutMs: 0, trustedGitIndexFile: privateIndex},
    ).pipe(Effect.ensuring(fs.chmod(privateIndex, 0o600).pipe(Effect.ignore)));
    const finalSourceIdentity = codeGraphGitIndexIdentity(yield* fs.stat(sourceIndex));
    if (finalSourceIdentity === undefined || !sameCodeGraphGitIndexIdentity(finalSourceIdentity, sourceIdentity)) {
      return yield* CodeGraphGitStatusCacheUnavailable.make({message: 'Git index changed during observation.'});
    }
    if (!metadataReusable) {
      yield* writeReceipt(fs, path, receiptPath, {
        ...sourceIdentity,
        ...(sourceIndexSemanticSha256 === undefined ? {} : {sourceIndexSemanticSha256}),
        version: CODE_GRAPH_GIT_STATUS_CACHE_RECEIPT_VERSION,
      });
    }
    return result;
  });
}

const observeSourceIndexSemanticSha256 = Effect.fn('codeGraph.observeSourceIndexSemanticSha256')(function* (
  fs: FileSystem.FileSystem,
  identity: RepositoryIdentity,
  sourceIndex: string,
  expectedIdentity: CodeGraphGitIndexIdentity,
) {
  const direct =
    expectedIdentity.indexBytes <= SEMANTIC_INDEX_OUTPUT_BYTES_MAXIMUM
      ? yield* fs.readFile(sourceIndex).pipe(
          Effect.map(bytes => codeGraphGitIndexSemanticSha256(bytes, identity.objectFormat)),
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;
  const semanticSha256 =
    direct ??
    sha256HexSync(
      (yield* runBinaryCommandEffect(
        'git',
        ['--no-optional-locks', '-C', identity.repoRoot, 'ls-files', '--stage', '-v', '-z'],
        {maxOutputBytes: SEMANTIC_INDEX_OUTPUT_BYTES_MAXIMUM, timeoutMs: 30_000},
      )).stdout,
    );
  const finalIdentity = codeGraphGitIndexIdentity(yield* fs.stat(sourceIndex));
  if (finalIdentity === undefined || !sameCodeGraphGitIndexIdentity(finalIdentity, expectedIdentity)) {
    return yield* CodeGraphGitStatusCacheUnavailable.make({message: 'Git index changed during semantic observation.'});
  }
  return semanticSha256;
});

function initializePrivateIndex(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  identity: RepositoryIdentity,
  sourceIndex: string,
  sourceIdentity: CodeGraphGitIndexIdentity,
  privateIndex: string,
) {
  return Effect.gen(function* () {
    const temporary = path.join(path.dirname(privateIndex), '.index.tmp');
    yield* rejectSymbolicTarget(fs, privateIndex);
    yield* rejectSymbolicTarget(fs, temporary);
    yield* fs.remove(temporary, {force: true});
    yield* fs.copyFile(sourceIndex, temporary);
    yield* fs.chmod(temporary, 0o600);
    const copied = yield* fs.stat(temporary);
    const finalSourceIdentity = codeGraphGitIndexIdentity(yield* fs.stat(sourceIndex));
    if (
      copied.type !== 'File' ||
      Number(copied.size) !== sourceIdentity.indexBytes ||
      finalSourceIdentity === undefined ||
      !sameCodeGraphGitIndexIdentity(finalSourceIdentity, sourceIdentity)
    ) {
      return yield* CodeGraphGitStatusCacheUnavailable.make({message: 'Private Git index copy is incomplete.'});
    }
    yield* fs.remove(privateIndex, {force: true});
    yield* fs.rename(temporary, privateIndex);
    yield* runCommandEffect(
      'git',
      ['-c', 'core.untrackedCache=true', '-C', identity.repoRoot, 'update-index', '--untracked-cache'],
      {maxOutputBytes: 16_384, timeoutMs: 30_000, trustedGitIndexFile: privateIndex},
    );
    yield* ensureFsmonitorDaemon(identity);
    yield* runCommandEffect(
      'git',
      ['-c', 'core.fsmonitor=true', '-C', identity.repoRoot, 'update-index', '--fsmonitor'],
      {maxOutputBytes: 16_384, timeoutMs: 30_000, trustedGitIndexFile: privateIndex},
    );
  }).pipe(
    Effect.ensuring(
      fs
        .remove(path.join(path.dirname(privateIndex), '.index.tmp'), {force: true})
        .pipe(Effect.ignore, Effect.andThen(fs.chmod(privateIndex, 0o600).pipe(Effect.ignore))),
    ),
  );
}

const fsmonitorDaemon = (identity: RepositoryIdentity, operation: 'start' | 'status') =>
  runCommandEffect('git', ['-c', 'core.fsmonitor=true', '-C', identity.repoRoot, 'fsmonitor--daemon', operation], {
    allowFailure: true,
    maxOutputBytes: 16_384,
    timeoutMs: 30_000,
  });

const ensureFsmonitorDaemon = Effect.fn('codeGraph.ensureFsmonitorDaemon')(function* (identity: RepositoryIdentity) {
  const observed = yield* fsmonitorDaemon(identity, 'status');
  if (observed.exitCode === 0) return;
  // Another process may start the repository daemon after the failed status
  // observation. Git 2.39 reports that idempotent `start` race as exit 128, so
  // stderr text is not a stable contract: re-observe the daemon instead.
  yield* fsmonitorDaemon(identity, 'start');
  const verified = yield* fsmonitorDaemon(identity, 'status');
  if (verified.exitCode !== 0) {
    return yield* CodeGraphGitStatusCacheUnavailable.make({message: 'Git fsmonitor daemon is unavailable.'});
  }
});

function ensurePrivateCacheDirectory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  privateHome: string,
  directory: string,
) {
  return Effect.gen(function* () {
    const relative = path.relative(privateHome, directory);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      return yield* CodeGraphGitStatusCacheUnavailable.make({message: 'Private Git cache directory escaped home.'});
    }
    const components = relative.split(path.sep).filter(Boolean);
    let candidate = privateHome;
    for (const component of ['', ...components]) {
      if (component) candidate = path.join(candidate, component);
      if (Option.isSome(yield* fs.readLink(candidate).pipe(Effect.option))) {
        return yield* CodeGraphGitStatusCacheUnavailable.make({message: 'Private Git cache directory is symbolic.'});
      }
      if (!(yield* fs.exists(candidate))) {
        if (!component) {
          return yield* CodeGraphGitStatusCacheUnavailable.make({message: 'Private Threadnote home is unavailable.'});
        }
        yield* fs.makeDirectory(candidate, {mode: 0o700});
      }
      const info = yield* fs.stat(candidate);
      if (info.type !== 'Directory') {
        return yield* CodeGraphGitStatusCacheUnavailable.make({message: 'Private Git cache directory is invalid.'});
      }
    }
    yield* fs.chmod(directory, 0o700);
  });
}

function privateRegularFileWithinBound(fs: FileSystem.FileSystem, file: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return false;
    const info = yield* fs.stat(file).pipe(Effect.option);
    const links = Option.isSome(info) ? Option.getOrUndefined(info.value.nlink) : undefined;
    return (
      Option.isSome(info) &&
      info.value.type === 'File' &&
      links === 1 &&
      Number(info.value.size) <= CODE_GRAPH_GIT_STATUS_CACHE_INDEX_BYTES_MAXIMUM
    );
  });
}

function rejectSymbolicTarget(fs: FileSystem.FileSystem, target: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
      return yield* CodeGraphGitStatusCacheUnavailable.make({message: 'Private Git cache target is symbolic.'});
    }
  });
}

function readReceipt(fs: FileSystem.FileSystem, receiptPath: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(receiptPath).pipe(Effect.option))) return undefined;
    const info = yield* fs.stat(receiptPath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== 'File' || Number(info.value.size) > RECEIPT_BYTES_MAXIMUM) {
      return undefined;
    }
    return parseCodeGraphGitStatusCacheReceipt(yield* fs.readFileString(receiptPath));
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function writeReceipt(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  receiptPath: string,
  receipt: CodeGraphGitStatusCacheReceipt,
) {
  const temporary = path.join(path.dirname(receiptPath), '.receipt-v3.tmp');
  const content = `${JSON.stringify(receipt)}\n`;
  return rejectSymbolicTarget(fs, receiptPath).pipe(
    Effect.andThen(rejectSymbolicTarget(fs, temporary)),
    Effect.andThen(fs.remove(temporary, {force: true})),
    Effect.andThen(fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600})),
    Effect.andThen(fs.chmod(temporary, 0o600)),
    Effect.andThen(fs.rename(temporary, receiptPath)),
    Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)),
  );
}

export function parseCodeGraphGitStatusCacheReceipt(value: string): CodeGraphGitStatusCacheReceipt | undefined {
  if (new TextEncoder().encode(value).byteLength > RECEIPT_BYTES_MAXIMUM) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Partial<CodeGraphGitStatusCacheReceipt>;
    if (
      candidate.version !== CODE_GRAPH_GIT_STATUS_CACHE_RECEIPT_VERSION ||
      !Number.isSafeInteger(candidate.indexBytes) ||
      candidate.indexBytes! < 0 ||
      candidate.indexBytes! > CODE_GRAPH_GIT_STATUS_CACHE_INDEX_BYTES_MAXIMUM ||
      !validNonNegativeSafeInteger(candidate.sourceIndexDevice) ||
      !validNonNegativeSafeInteger(candidate.sourceIndexInode) ||
      !validNonNegativeSafeInteger(candidate.sourceIndexModifiedAtMilliseconds) ||
      (candidate.sourceIndexSemanticSha256 !== undefined &&
        (typeof candidate.sourceIndexSemanticSha256 !== 'string' ||
          !SHA256_PATTERN.test(candidate.sourceIndexSemanticSha256)))
    ) {
      return undefined;
    }
    return {
      indexBytes: candidate.indexBytes!,
      sourceIndexDevice: candidate.sourceIndexDevice,
      sourceIndexInode: candidate.sourceIndexInode,
      sourceIndexModifiedAtMilliseconds: candidate.sourceIndexModifiedAtMilliseconds,
      ...(candidate.sourceIndexSemanticSha256 === undefined
        ? {}
        : {sourceIndexSemanticSha256: candidate.sourceIndexSemanticSha256}),
      version: CODE_GRAPH_GIT_STATUS_CACHE_RECEIPT_VERSION,
    };
  } catch {
    return undefined;
  }
}

function codeGraphGitIndexIdentity(info: FileSystem.File.Info): CodeGraphGitIndexIdentity | undefined {
  const indexBytes = Number(info.size);
  const sourceIndexInode = Option.getOrUndefined(info.ino);
  const modifiedAt = Option.getOrUndefined(info.mtime);
  const sourceIndexModifiedAtMilliseconds = modifiedAt?.getTime();
  if (
    info.type !== 'File' ||
    !validNonNegativeSafeInteger(indexBytes) ||
    !validNonNegativeSafeInteger(info.dev) ||
    !validNonNegativeSafeInteger(sourceIndexInode) ||
    !validNonNegativeSafeInteger(sourceIndexModifiedAtMilliseconds)
  ) {
    return undefined;
  }
  return {
    indexBytes,
    sourceIndexDevice: info.dev,
    sourceIndexInode,
    sourceIndexModifiedAtMilliseconds,
  };
}

function sameCodeGraphGitIndexIdentity(left: CodeGraphGitIndexIdentity, right: CodeGraphGitIndexIdentity): boolean {
  return (
    left.indexBytes === right.indexBytes &&
    left.sourceIndexDevice === right.sourceIndexDevice &&
    left.sourceIndexInode === right.sourceIndexInode &&
    left.sourceIndexModifiedAtMilliseconds === right.sourceIndexModifiedAtMilliseconds
  );
}

function validNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
