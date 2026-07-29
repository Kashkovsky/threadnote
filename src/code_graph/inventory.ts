import {Effect, FileSystem, Option, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {runBinaryCommandEffect, runCommandEffect} from '../effect/command.js';
import {SystemInfo} from '../effect/system.js';
import {
  CodeGraphBudgetExceeded,
  DEFAULT_CODE_GRAPH_BUDGETS,
  type CodeGraphBudgets,
  type CodeGraphInventoryFile,
  type CodeGraphProgress,
  type RepositoryIdentity,
} from './types.js';

interface GitTreeEntry {
  readonly blobId: string;
  readonly mode: string;
  readonly path: string;
  readonly size: number;
}

interface CompiledIgnoreRule {
  readonly ignored: boolean;
  readonly pattern: RegExp;
}

export interface CodeGraphInventory {
  readonly committedFiles: readonly CodeGraphInventoryFile[];
  readonly dirty: boolean;
  readonly files: readonly CodeGraphInventoryFile[];
  readonly overlayFingerprint?: string;
  readonly skipped: number;
}

export interface CodeGraphInventoryOptions {
  readonly budgets?: Partial<CodeGraphBudgets>;
  readonly cachedCommittedFileKeys?: ReadonlySet<string>;
  readonly includeOverlay?: boolean;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
}

const TEXT_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.md', '.mdx', '.mjs', '.mts', '.cts', '.ts', '.tsx']);
const MANIFEST_NAMES = new Set(['go.mod', 'package.json', 'tsconfig.json']);
const PRUNED_DIRECTORIES = new Set([
  'bazel-bin',
  'bazel-out',
  'build',
  'coverage',
  'deriveddata',
  'dist',
  'node_modules',
  'out',
  'pods',
]);
const CAT_FILE_BATCH_ENTRIES = 128;
const CAT_FILE_BATCH_BYTES = 16 * 1_048_576;
const THREADNOTE_IGNORE_MAX_BYTES = 256 * 1_024;

export const inventoryRepository = Effect.fn('codeGraph.inventoryRepository')(function* (
  identity: RepositoryIdentity,
  options: CodeGraphInventoryOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const budgets = {...DEFAULT_CODE_GRAPH_BUDGETS, ...options.budgets};
  const allTreeEntries = isZeroObjectId(identity.headCommit)
    ? []
    : parseGitTree(
        (yield* runCommandEffect('git', ['-C', identity.repoRoot, 'ls-tree', '-r', '-l', '-z', identity.headCommit], {
          maxOutputBytes: 64 * 1_048_576,
          timeoutMs: 120_000,
        })).stdout,
      );
  const threadnoteIgnore = yield* readOptionalText(fs, path.join(identity.repoRoot, '.threadnoteignore'));
  const ignoreRules = compileThreadnoteIgnore(threadnoteIgnore);
  const acceptedByPolicy = allTreeEntries.filter(entry =>
    acceptsRepositoryPathWithRules(entry.path, entry.size, budgets.maximumFileBytes, ignoreRules),
  );
  const ignoredByGit = yield* ignoredPaths(
    identity.repoRoot,
    acceptedByPolicy.map(entry => entry.path),
  );
  const accepted = acceptedByPolicy.filter(entry => !ignoredByGit.has(entry.path));
  assertInventoryBudgets(accepted, budgets);

  const committed = yield* readCommittedFiles(
    identity,
    accepted,
    budgets,
    options.cachedCommittedFileKeys ?? new Set(),
    options.onProgress,
  );
  const overlay =
    options.includeOverlay === false
      ? {changed: new Set<string>(), dirty: false, files: [], fingerprint: undefined, skipped: 0}
      : yield* readDirtyOverlay(identity, path, budgets, threadnoteIgnore, ignoreRules);
  const filesByPath = new Map(committed.files.map(file => [file.path, file]));
  for (const changed of overlay.changed) filesByPath.delete(changed);
  for (const file of overlay.files) filesByPath.set(file.path, file);
  const files = [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  assertInventoryBudgets(files.map(file => ({size: file.size})) as readonly Pick<GitTreeEntry, 'size'>[], budgets);
  const skipped = allTreeEntries.length - accepted.length + committed.skipped + overlay.skipped;
  yield* options.onProgress?.({
    accepted: files.length,
    phase: 'scanning',
    skipped,
    visited: files.length + skipped,
  }) ?? Effect.void;
  return {
    committedFiles: [...committed.files].sort((left, right) => left.path.localeCompare(right.path)),
    dirty: overlay.dirty,
    files,
    overlayFingerprint: overlay.fingerprint,
    skipped,
  } satisfies CodeGraphInventory;
});

export const worktreeOverlayState = Effect.fn('codeGraph.worktreeOverlayState')(function* (
  identity: RepositoryIdentity,
  options: Pick<CodeGraphInventoryOptions, 'budgets'> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const budgets = {...DEFAULT_CODE_GRAPH_BUDGETS, ...options.budgets};
  const threadnoteIgnore = yield* readOptionalText(fs, path.join(identity.repoRoot, '.threadnoteignore'));
  const overlay = yield* readDirtyOverlay(
    identity,
    path,
    budgets,
    threadnoteIgnore,
    compileThreadnoteIgnore(threadnoteIgnore),
  );
  return {dirty: overlay.dirty, fingerprint: overlay.fingerprint};
});

export function parseGitTree(output: string): readonly GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]+) +(-|\d+)\t([\s\S]+)$/.exec(record);
    if (!match || match[2] !== 'blob' || match[1] === '120000' || match[4] === '-') continue;
    const size = Number(match[4]);
    if (!Number.isSafeInteger(size) || size < 0) continue;
    entries.push({blobId: match[3]!, mode: match[1]!, path: normalizeRepositoryPath(match[5]!), size});
  }
  return entries;
}

export function acceptsRepositoryPath(
  value: string,
  size: number,
  maximumFileBytes = DEFAULT_CODE_GRAPH_BUDGETS.maximumFileBytes,
  threadnoteIgnore = '',
): boolean {
  return acceptsRepositoryPathWithRules(value, size, maximumFileBytes, compileThreadnoteIgnore(threadnoteIgnore));
}

function acceptsRepositoryPathWithRules(
  value: string,
  size: number,
  maximumFileBytes: number,
  ignoreRules: readonly CompiledIgnoreRule[],
): boolean {
  const path = normalizeRepositoryPath(value);
  if (!path || path.startsWith('/') || path.split('/').some(segment => segment === '..' || segment === '')) {
    return false;
  }
  const segments = path.split('/');
  const directories = segments.slice(0, -1);
  if (
    directories.some(directory => directory.startsWith('.') || PRUNED_DIRECTORIES.has(directory.toLowerCase())) ||
    size > maximumFileBytes ||
    isIgnoredByThreadnote(path, ignoreRules)
  ) {
    return false;
  }
  const basename = segments.at(-1)!.toLowerCase();
  const extension = basename.includes('.') ? `.${basename.split('.').at(-1)}` : '';
  return TEXT_EXTENSIONS.has(extension) || MANIFEST_NAMES.has(basename);
}

function compileThreadnoteIgnore(content: string): readonly CompiledIgnoreRule[] {
  const rules: CompiledIgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const negated = trimmed.startsWith('!');
    const pattern = normalizeRepositoryPath(negated ? trimmed.slice(1) : trimmed);
    if (!pattern) continue;
    const compiled = compileIgnorePattern(pattern);
    if (compiled) rules.push({ignored: !negated, pattern: compiled});
  }
  return rules;
}

function isIgnoredByThreadnote(path: string, rules: readonly CompiledIgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.pattern.test(path)) ignored = rule.ignored;
  }
  return ignored;
}

function compileIgnorePattern(pattern: string): RegExp | undefined {
  const directoryPattern = pattern.endsWith('/');
  const normalized = pattern.replace(/^\/+|\/+$/g, '');
  if (!normalized) return undefined;
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
    .replaceAll('\u0000', '.*');
  const prefix = normalized.includes('/') ? '^' : '(?:^|/)';
  const suffix = directoryPattern ? '(?:/|$)' : '$';
  return new RegExp(`${prefix}${escaped}${suffix}`, 'i');
}

function ignoredPaths(repoRoot: string, paths: readonly string[]) {
  if (paths.length === 0) return Effect.succeed(new Set<string>());
  const input = new TextEncoder().encode(`${paths.join('\0')}\0`);
  return runCommandEffect('git', ['-C', repoRoot, 'check-ignore', '--no-index', '-z', '--stdin'], {
    allowFailure: true,
    input,
    maxOutputBytes: 64 * 1_048_576,
    timeoutMs: 120_000,
  }).pipe(Effect.map(result => new Set(result.stdout.split('\0').filter(Boolean).map(normalizeRepositoryPath))));
}

const readCommittedFiles = Effect.fn('codeGraph.readCommittedFiles')(function* (
  identity: RepositoryIdentity,
  entries: readonly GitTreeEntry[],
  budgets: CodeGraphBudgets,
  cachedCommittedFileKeys: ReadonlySet<string>,
  onProgress?: CodeGraphInventoryOptions['onProgress'],
) {
  const files: CodeGraphInventoryFile[] = [];
  let skipped = 0;
  let completed = 0;
  const needsContent: GitTreeEntry[] = [];
  for (const entry of entries) {
    const contentHash = committedContentHash(identity.objectFormat, entry.blobId);
    if (
      cachedCommittedFileKeys.has(`${entry.path}\0${contentHash}`) &&
      !MANIFEST_NAMES.has(entry.path.split('/').at(-1)?.toLowerCase() ?? '')
    ) {
      files.push(inventoryFileForCommittedEntry(entry, contentHash));
      completed += 1;
    } else {
      needsContent.push(entry);
    }
  }
  for (const batch of chunkTreeEntries(needsContent)) {
    const result = yield* runBinaryCommandEffect('git', ['-C', identity.repoRoot, 'cat-file', '--batch'], {
      input: new TextEncoder().encode(`${batch.map(entry => entry.blobId).join('\n')}\n`),
      maxOutputBytes: Math.min(
        CAT_FILE_BATCH_BYTES + batch.length * 256,
        budgets.maximumTotalBytes + batch.length * 256,
      ),
      timeoutMs: 120_000,
    });
    const blobs = parseGitCatFileBatch(result.stdout, batch);
    for (let index = 0; index < batch.length; index += 1) {
      const entry = batch[index]!;
      const bytes = blobs[index];
      if (!bytes || appearsBinary(bytes) || appearsGitLfsPointer(bytes)) {
        skipped += 1;
        continue;
      }
      const content = decodeUtf8(bytes);
      if (content === undefined) {
        skipped += 1;
        continue;
      }
      files.push({
        ...inventoryFileForCommittedEntry(entry, committedContentHash(identity.objectFormat, entry.blobId)),
        content,
      });
    }
    completed += batch.length;
    yield* onProgress?.({
      accepted: files.length,
      phase: 'scanning',
      skipped,
      visited: completed,
    }) ?? Effect.void;
  }
  return {files, skipped};
});

function inventoryFileForCommittedEntry(entry: GitTreeEntry, contentHash: string): CodeGraphInventoryFile {
  return {
    blobId: entry.blobId,
    contentHash,
    language: languageForPath(entry.path),
    mode: entry.mode,
    path: entry.path,
    size: entry.size,
    source: 'commit',
  };
}

function committedContentHash(objectFormat: RepositoryIdentity['objectFormat'], blobId: string): string {
  return sha256HexSync(`git-object-v1\n${objectFormat}\n${blobId}`);
}

export function parseGitCatFileBatch(
  bytes: Uint8Array,
  entries: readonly Pick<GitTreeEntry, 'blobId' | 'size'>[],
): readonly Uint8Array[] {
  const output: Uint8Array[] = [];
  let offset = 0;
  for (const expected of entries) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0) throw new Error('Git cat-file batch ended before its header.');
    const header = new TextDecoder().decode(bytes.subarray(offset, newline));
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!match || match[1] !== expected.blobId) {
      throw new Error(`Git cat-file returned an unexpected object for ${expected.blobId}.`);
    }
    const size = Number(match[2]);
    const start = newline + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || size < 0 || end >= bytes.byteLength || bytes[end] !== 10) {
      throw new Error(`Git cat-file returned a truncated object for ${expected.blobId}.`);
    }
    output.push(bytes.slice(start, end));
    offset = end + 1;
  }
  if (offset !== bytes.byteLength) throw new Error('Git cat-file batch returned trailing bytes.');
  return output;
}

const readDirtyOverlay = Effect.fn('codeGraph.readDirtyOverlay')(function* (
  identity: RepositoryIdentity,
  path: Path.Path,
  budgets: CodeGraphBudgets,
  threadnoteIgnore: string,
  ignoreRules: readonly CompiledIgnoreRule[],
) {
  const fs = yield* FileSystem.FileSystem;
  const repositoryRoot = yield* fs.realPath(identity.repoRoot);
  const unborn = isZeroObjectId(identity.headCommit);
  const [diffOutput, untrackedOutput] = unborn
    ? [
        '',
        (yield* runCommandEffect(
          'git',
          ['-C', identity.repoRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
          {
            maxOutputBytes: 64 * 1_048_576,
            timeoutMs: 120_000,
          },
        )).stdout,
      ]
    : yield* Effect.all(
        [
          runCommandEffect(
            'git',
            ['-C', identity.repoRoot, 'diff', '--name-status', '-z', '--find-renames', identity.headCommit, '--'],
            {maxOutputBytes: 64 * 1_048_576, timeoutMs: 120_000},
          ).pipe(Effect.map(result => result.stdout)),
          runCommandEffect('git', ['-C', identity.repoRoot, 'ls-files', '-z', '--others', '--exclude-standard'], {
            maxOutputBytes: 64 * 1_048_576,
            timeoutMs: 120_000,
          }).pipe(Effect.map(result => result.stdout)),
        ],
        {concurrency: 2},
      );
  const changes = parseNameStatus(diffOutput);
  const untracked = new Set(untrackedOutput.split('\0').filter(Boolean).map(normalizeRepositoryPath));
  for (const value of untracked) {
    changes.changed.add(value);
  }
  const files: CodeGraphInventoryFile[] = [];
  let skipped = 0;
  let totalBytes = 0;
  const changed = new Set([...changes.deleted, ...changes.changed]);
  const skippedPaths = new Set<string>();
  const markSkipped = (relative: string) => {
    skipped += 1;
    if (
      (untracked.has(relative) || changes.added.has(relative)) &&
      (relative !== '.threadnoteignore' || threadnoteIgnore.length === 0)
    ) {
      changed.delete(relative);
      return;
    }
    skippedPaths.add(relative);
  };
  for (const relative of [...changes.changed].sort()) {
    const absolute = path.resolve(identity.repoRoot, relative);
    const containment = path.relative(identity.repoRoot, absolute);
    if (
      containment === '..' ||
      containment.startsWith(`..${path.sep}`) ||
      path.isAbsolute(containment) ||
      !acceptsRepositoryPathWithRules(relative, 0, budgets.maximumFileBytes, ignoreRules)
    ) {
      markSkipped(relative);
      continue;
    }
    const opened = yield* readContainedStableRegularFile(
      fs,
      path,
      repositoryRoot,
      relative,
      budgets.maximumFileBytes,
    ).pipe(Effect.option);
    if (opened._tag === 'None') {
      markSkipped(relative);
      continue;
    }
    const bytes = opened.value;
    if (appearsBinary(bytes) || appearsGitLfsPointer(bytes)) {
      markSkipped(relative);
      continue;
    }
    const content = decodeUtf8(bytes);
    if (content === undefined) {
      markSkipped(relative);
      continue;
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > budgets.maximumTotalBytes) {
      return yield* Effect.fail(new CodeGraphBudgetExceeded('Dirty overlay exceeds the total byte budget.'));
    }
    files.push({
      blobId: `worktree:${sha256HexSync(bytes)}`,
      content,
      contentHash: sha256HexSync(bytes),
      language: languageForPath(relative),
      mode: '100644',
      path: relative,
      size: bytes.byteLength,
      source: 'worktree',
    });
  }
  const dirty = changed.size > 0;
  return {
    changed,
    dirty,
    files,
    fingerprint: dirty
      ? sha256HexSync(
          [
            `I\0${sha256HexSync(threadnoteIgnore)}`,
            ...[...changes.deleted].sort().map(relative => `D\0${relative}`),
            ...files.map(file => `F\0${file.path}\0${file.contentHash}`).sort(),
            ...[...skippedPaths].sort().map(relative => `S\0${relative}`),
          ].join('\n'),
        )
      : undefined,
    skipped,
  };
});

export function parseNameStatus(output: string): {
  readonly added: Set<string>;
  readonly changed: Set<string>;
  readonly deleted: Set<string>;
} {
  const added = new Set<string>();
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const fields = output.split('\0');
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const first = normalizeRepositoryPath(fields[index++] ?? '');
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = normalizeRepositoryPath(fields[index++] ?? '');
      if (status.startsWith('R') && first) deleted.add(first);
      if (second) changed.add(second);
    } else if (status.startsWith('D')) {
      if (first) deleted.add(first);
    } else if (first) {
      changed.add(first);
      if (status.startsWith('A')) added.add(first);
    }
  }
  return {added, changed, deleted};
}

function chunkTreeEntries(entries: readonly GitTreeEntry[]): readonly (readonly GitTreeEntry[])[] {
  const batches: GitTreeEntry[][] = [];
  let current: GitTreeEntry[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    if (
      current.length > 0 &&
      (current.length >= CAT_FILE_BATCH_ENTRIES || currentBytes + entry.size > CAT_FILE_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entry.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function assertInventoryBudgets(entries: readonly Pick<GitTreeEntry, 'size'>[], budgets: CodeGraphBudgets): void {
  if (entries.length > budgets.maximumFiles) {
    throw new CodeGraphBudgetExceeded(
      `Repository has ${entries.length} eligible files; limit is ${budgets.maximumFiles}.`,
    );
  }
  const bytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (bytes > budgets.maximumTotalBytes) {
    throw new CodeGraphBudgetExceeded(`Repository has ${bytes} eligible bytes; limit is ${budgets.maximumTotalBytes}.`);
  }
}

function appearsBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, Math.min(bytes.byteLength, 8192)).includes(0);
}

function appearsGitLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.byteLength > 1024) return false;
  return new TextDecoder().decode(bytes).startsWith('version https://git-lfs.github.com/spec/v1\n');
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return undefined;
  }
}

function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  if (/\.tsx?$/.test(lower) || /\.(?:mts|cts)$/.test(lower)) return 'typescript';
  if (/\.(?:jsx?|mjs|cjs)$/.test(lower)) return 'javascript';
  if (/\.mdx?$/.test(lower)) return 'markdown';
  if (lower.endsWith('package.json')) return 'npm-manifest';
  if (lower.endsWith('go.mod')) return 'go-manifest';
  if (lower.endsWith('tsconfig.json')) return 'typescript-config';
  return 'text';
}

function normalizeRepositoryPath(value: string): string {
  return value.replace(/^\.\/+/, '');
}

function isZeroObjectId(value: string): boolean {
  return /^0{40}(?:0{24})?$/.test(value);
}

const readOptionalText = Effect.fn('codeGraph.readOptionalText')(function* (fs: FileSystem.FileSystem, target: string) {
  const opened = yield* readStableRegularFile(fs, target, THREADNOTE_IGNORE_MAX_BYTES).pipe(Effect.option);
  return opened._tag === 'Some' ? (decodeUtf8(opened.value.bytes) ?? '') : '';
});

interface StableRegularFile {
  readonly bytes: Uint8Array;
  readonly identity: FileSystem.File.Info;
  readonly openedPath: Option.Option<string>;
}

export interface ContainedReadInterlock {
  readonly afterOpen?: Effect.Effect<void>;
  readonly beforeOpen?: Effect.Effect<void>;
}

function readStableRegularFile(
  fs: FileSystem.FileSystem,
  target: string,
  maximumBytes: number,
  interlock?: ContainedReadInterlock,
): Effect.Effect<StableRegularFile, Error, SystemInfo> {
  return Effect.gen(function* () {
    const linkTarget = yield* fs.readLink(target).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
    );
    if (Option.isSome(linkTarget)) {
      return yield* Effect.fail(new Error(`Refusing to read a symbolic repository file: ${target}`));
    }
    const pathInfoBefore = yield* fs.stat(target);
    if (pathInfoBefore.type !== 'File' || pathInfoBefore.size > BigInt(maximumBytes)) {
      return yield* Effect.fail(new Error(`Refusing to read a non-regular or oversized repository file: ${target}`));
    }
    yield* interlock?.beforeOpen ?? Effect.void;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(target, {flag: 'r'});
        yield* interlock?.afterOpen ?? Effect.void;
        const openedInfoBefore = yield* file.stat;
        const openedPath = yield* openedFilePath(fs, file);
        const pathInfoOpened = yield* fs.stat(target);
        if (
          !sameRegularFile(pathInfoBefore, pathInfoOpened, openedInfoBefore) ||
          openedInfoBefore.size > BigInt(maximumBytes)
        ) {
          return yield* Effect.fail(new Error(`Repository file changed while it was opened: ${target}`));
        }
        const bytes = new Uint8Array(Number(openedInfoBefore.size));
        let offset = 0;
        while (offset < bytes.byteLength) {
          const read = Number(yield* file.read(bytes.subarray(offset)));
          if (read <= 0) {
            return yield* Effect.fail(new Error(`Repository file ended while it was being read: ${target}`));
          }
          offset += read;
        }
        const openedInfoAfter = yield* file.stat;
        const linkTargetAfter = yield* fs.readLink(target).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none<string>())),
        );
        if (Option.isSome(linkTargetAfter)) {
          return yield* Effect.fail(new Error(`Repository file became a symbolic link while reading: ${target}`));
        }
        const pathInfoAfter = yield* fs.stat(target);
        if (
          !sameRegularFile(pathInfoBefore, pathInfoAfter, openedInfoAfter) ||
          openedInfoBefore.size !== openedInfoAfter.size
        ) {
          return yield* Effect.fail(new Error(`Repository file changed while it was being read: ${target}`));
        }
        return {bytes, identity: openedInfoAfter, openedPath};
      }),
    );
  }).pipe(Effect.mapError(cause => new Error(`Could not safely read repository file ${target}.`, {cause})));
}

export function readContainedStableRegularFile(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  relative: string,
  maximumBytes: number,
  interlock?: ContainedReadInterlock,
): Effect.Effect<Uint8Array, Error, SystemInfo> {
  const target = path.join(repositoryRoot, ...relative.split('/'));
  return Effect.gen(function* () {
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalBefore = yield* fs.realPath(target);
    if (!isContainedPath(path, repositoryRoot, canonicalBefore)) {
      return yield* Effect.fail(new Error(`Repository file resolves outside its root: ${relative}`));
    }
    const opened = yield* readStableRegularFile(fs, target, maximumBytes, interlock);
    if (Option.isSome(opened.openedPath) && !isContainedPath(path, repositoryRoot, opened.openedPath.value)) {
      return yield* Effect.fail(new Error(`Opened repository file is outside its root: ${relative}`));
    }
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalAfter = yield* fs.realPath(target);
    const finalInfo = yield* fs.stat(target);
    if (!isContainedPath(path, repositoryRoot, canonicalAfter)) {
      return yield* Effect.fail(new Error(`Repository file escaped its root while reading: ${relative}`));
    }
    if (!sameRegularFile(opened.identity, finalInfo, opened.identity)) {
      return yield* Effect.fail(new Error(`Repository path no longer identifies the opened file: ${relative}`));
    }
    return opened.bytes;
  }).pipe(Effect.mapError(cause => new Error(`Could not safely read repository path ${relative}.`, {cause})));
}

const validateRepositoryAncestors = Effect.fn('codeGraph.validateRepositoryAncestors')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  relative: string,
) {
  let current = repositoryRoot;
  for (const segment of relative.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    const link = yield* fs.readLink(current).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
    );
    if (Option.isSome(link)) {
      return yield* Effect.fail(new Error(`Repository path has a symbolic ancestor: ${relative}`));
    }
    const canonical = yield* fs.realPath(current);
    const info = yield* fs.stat(current);
    if (info.type !== 'Directory' || !isContainedPath(path, repositoryRoot, canonical)) {
      return yield* Effect.fail(new Error(`Repository path has an unsafe ancestor: ${relative}`));
    }
  }
});

function isContainedPath(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameRegularFile(
  before: FileSystem.File.Info,
  current: FileSystem.File.Info,
  opened: FileSystem.File.Info,
): boolean {
  const beforeInode = Option.getOrUndefined(before.ino);
  const currentInode = Option.getOrUndefined(current.ino);
  const openedInode = Option.getOrUndefined(opened.ino);
  return (
    before.type === 'File' &&
    current.type === 'File' &&
    opened.type === 'File' &&
    before.dev === current.dev &&
    current.dev === opened.dev &&
    beforeInode !== undefined &&
    currentInode !== undefined &&
    openedInode !== undefined &&
    beforeInode === currentInode &&
    currentInode === openedInode
  );
}

function openedFilePath(
  fs: FileSystem.FileSystem,
  file: FileSystem.File,
): Effect.Effect<Option.Option<string>, never, SystemInfo> {
  const descriptor = (file as FileSystem.File & {readonly fd?: unknown}).fd;
  if (typeof descriptor !== 'number' || !Number.isSafeInteger(descriptor) || descriptor < 0) {
    return Effect.succeed(Option.none());
  }
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const descriptorPath =
      system.platform === 'linux'
        ? `/proc/self/fd/${descriptor}`
        : system.platform === 'darwin'
          ? `/dev/fd/${descriptor}`
          : undefined;
    if (!descriptorPath) return Option.none<string>();
    const resolved = yield* fs.realPath(descriptorPath).pipe(Effect.option);
    return Option.isSome(resolved) && resolved.value !== descriptorPath
      ? Option.some(resolved.value)
      : Option.none<string>();
  });
}
