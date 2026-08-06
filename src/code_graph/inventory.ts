import {Effect, FileSystem, Option, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {runBinaryCommandEffect, runCommandEffect} from '../effect/command.js';
import {SystemInfo} from '../effect/system.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY, type CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import {CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT} from './languages/corpus/policy.js';
import {isLowSignalStructuredPath} from './languages/schemas/policy.js';
import {compareCodeUnits} from './ordering.js';
import {type CodeGraphInventoryFile, type CodeGraphProgress, type RepositoryIdentity} from './types.js';

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
  readonly committedParsedFiles: number;
  readonly dirty: boolean;
  readonly files: readonly CodeGraphInventoryFile[];
  readonly overlayFingerprint?: string;
  readonly parsedFiles: number;
  readonly skipped: number;
}

export interface CodeGraphInventoryOptions {
  readonly cachedCommittedFileKeys?: ReadonlySet<string>;
  readonly includeOverlay?: boolean;
  readonly languagePacks?: CodeGraphLanguagePackRegistryShape;
  readonly onContentBatch?: (
    files: readonly CodeGraphInventoryFile[],
    context: CodeGraphContentBatchContext,
  ) => Effect.Effect<void, unknown>;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
}

export interface CodeGraphContentBatchContext {
  /** Counters remain at the last completed inventory boundary while this batch is extracted. */
  readonly progress: Extract<CodeGraphProgress, {readonly phase: 'scanning'}>;
  readonly readingMilliseconds: number;
  readonly sourceBytes: number;
}

const PRUNED_DIRECTORIES = new Set([
  'bazel-bin',
  'bazel-out',
  'bazel-testlogs',
  'build',
  'coverage',
  'deriveddata',
  'dist',
  'graphify-out',
  'node_modules',
  'out',
  'pods',
]);
const GENERATED_DIRECTORIES = new Set([
  'bazel-bin',
  'bazel-out',
  'bazel-testlogs',
  'build',
  'coverage',
  'deriveddata',
  'dist',
  'graphify-out',
  'node_modules',
  'out',
]);
const AUTHORED_DOT_DIRECTORIES = new Set(['.aspect']);
const CAT_FILE_BATCH_ENTRIES = 128;
const CAT_FILE_BATCH_BYTES = 16 * 1_048_576;
const COMPACT_RESOLUTION_CONTEXT_NAMES = new Set([
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'gradle.properties',
  'package.json',
  'package.swift',
  'pom.xml',
  'project.pbxproj',
  'settings.gradle',
  'settings.gradle.kts',
  'tsconfig.json',
]);

export const inventoryRepository = Effect.fn('codeGraph.inventoryRepository')(function* (
  identity: RepositoryIdentity,
  options: CodeGraphInventoryOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const languagePacks = options.languagePacks ?? BUILTIN_LANGUAGE_PACK_REGISTRY;
  const allTreeEntries = isZeroObjectId(identity.headCommit)
    ? []
    : parseGitTree(
        (yield* runCommandEffect('git', ['-C', identity.repoRoot, 'ls-tree', '-r', '-l', '-z', identity.headCommit], {
          maxOutputBytes: 0,
          timeoutMs: 0,
        })).stdout,
      );
  const declaredWorkspace = yield* discoverDeclaredSourceRoots(identity, allTreeEntries, languagePacks);
  const threadnoteIgnore = yield* readOptionalText(fs, path.join(identity.repoRoot, '.threadnoteignore'));
  const ignoreRules = compileThreadnoteIgnore(threadnoteIgnore);
  const acceptedByPolicy = allTreeEntries.filter(entry =>
    acceptsRepositoryPathWithRules(
      entry.path,
      ignoreRules,
      languagePacks,
      declaredWorkspace.projectRoots,
      declaredWorkspace.sourceRoots,
    ),
  );
  const ignoredByGit = yield* ignoredPaths(
    identity.repoRoot,
    acceptedByPolicy.map(entry => entry.path),
  );
  const accepted = acceptedByPolicy.filter(entry => !ignoredByGit.has(entry.path));
  const excluded = allTreeEntries.length - accepted.length;

  const committed = yield* readCommittedFiles(
    identity,
    accepted,
    excluded,
    options.cachedCommittedFileKeys ?? new Set(),
    languagePacks,
    declaredWorkspace.files,
    options.onContentBatch,
    options.onProgress,
  );
  const overlay =
    options.includeOverlay === false
      ? {
          changed: new Set<string>(),
          dirty: false,
          files: [],
          fingerprint: undefined,
          parsedPaths: new Set<string>(),
          skipped: 0,
        }
      : yield* readDirtyOverlay(
          identity,
          path,
          threadnoteIgnore,
          ignoreRules,
          options.cachedCommittedFileKeys ?? new Set(),
          languagePacks,
          declaredWorkspace.projectRoots,
          declaredWorkspace.sourceRoots,
          options.onContentBatch
            ? (files, context) =>
                options.onContentBatch!(files, {
                  ...context,
                  progress: {
                    accepted: committed.files.length,
                    completed: accepted.length,
                    excluded,
                    phase: 'scanning',
                    skipped: committed.skipped,
                    total: accepted.length,
                    unit: 'files',
                  },
                })
            : undefined,
        );
  const filesByPath = new Map(committed.files.map(file => [file.path, file]));
  for (const changed of overlay.changed) filesByPath.delete(changed);
  for (const file of overlay.files) filesByPath.set(file.path, file);
  const files = [...filesByPath.values()].sort((left, right) => compareCodeUnits(left.path, right.path));
  const parsedPaths = new Set([...committed.parsedPaths, ...overlay.parsedPaths]);
  const skipped = excluded + committed.skipped + overlay.skipped;
  return {
    committedFiles: [...committed.files].sort((left, right) => compareCodeUnits(left.path, right.path)),
    committedParsedFiles: committed.files.reduce(
      (total, file) => total + (committed.parsedPaths.has(file.path) ? 1 : 0),
      0,
    ),
    dirty: overlay.dirty,
    files,
    overlayFingerprint: overlay.fingerprint,
    parsedFiles: files.reduce((total, file) => total + (parsedPaths.has(file.path) ? 1 : 0), 0),
    skipped,
  } satisfies CodeGraphInventory;
});

export const worktreeOverlayState = Effect.fn('codeGraph.worktreeOverlayState')(function* (
  identity: RepositoryIdentity,
) {
  // Clean worktrees are overwhelmingly the common status/query path. Avoid a
  // full tree inventory and manifest hydration when Git can prove there is no
  // tracked or untracked worktree change at all.
  const porcelain = yield* runCommandEffect(
    'git',
    ['-C', identity.repoRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    {maxOutputBytes: 0, timeoutMs: 0},
  );
  if (porcelain.stdout.length === 0) return {dirty: false, fingerprint: undefined};
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const allTreeEntries = isZeroObjectId(identity.headCommit)
    ? []
    : parseGitTree(
        (yield* runCommandEffect('git', ['-C', identity.repoRoot, 'ls-tree', '-r', '-l', '-z', identity.headCommit], {
          maxOutputBytes: 0,
          timeoutMs: 0,
        })).stdout,
      );
  const declaredWorkspace = yield* discoverDeclaredSourceRoots(
    identity,
    allTreeEntries,
    BUILTIN_LANGUAGE_PACK_REGISTRY,
  );
  const threadnoteIgnore = yield* readOptionalText(fs, path.join(identity.repoRoot, '.threadnoteignore'));
  const overlay = yield* readDirtyOverlay(
    identity,
    path,
    threadnoteIgnore,
    compileThreadnoteIgnore(threadnoteIgnore),
    new Set(),
    BUILTIN_LANGUAGE_PACK_REGISTRY,
    declaredWorkspace.projectRoots,
    declaredWorkspace.sourceRoots,
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

/**
 * Resolve manifest-declared source roots before applying broad vendor/build-name pruning.
 *
 * A directory called `pods`, `build`, or `out` is usually generated, but those are also
 * legal module names. Only a checked-in workspace/build manifest can override the matching
 * directory prefix; nested generated directories remain pruned. Hidden directories and
 * node_modules never participate in this bootstrap pass.
 */
const discoverDeclaredSourceRoots = Effect.fn('codeGraph.discoverDeclaredSourceRoots')(function* (
  identity: RepositoryIdentity,
  entries: readonly GitTreeEntry[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
) {
  const contexts = entries.filter(entry => {
    if (entry.size > CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT || !languagePacks.isResolutionContext(entry.path)) {
      return false;
    }
    const directories = entry.path.split('/').slice(0, -1);
    return !directories.some(directory => directory.startsWith('.') || directory.toLowerCase() === 'node_modules');
  });
  if (contexts.length === 0) {
    return {files: new Map<string, CodeGraphInventoryFile>(), projectRoots: [], sourceRoots: []};
  }

  const files: CodeGraphInventoryFile[] = [];
  for (const batch of chunkTreeEntries(contexts)) {
    const expectedBytes = batch.reduce((total, entry) => total + entry.size, 0) + batch.length * 256;
    const result = yield* runBinaryCommandEffect('git', ['-C', identity.repoRoot, 'cat-file', '--batch'], {
      input: new TextEncoder().encode(`${batch.map(entry => entry.blobId).join('\n')}\n`),
      maxOutputBytes: expectedBytes,
      timeoutMs: 0,
    });
    const blobs = parseGitCatFileBatch(result.stdout, batch);
    for (let index = 0; index < batch.length; index += 1) {
      const entry = batch[index]!;
      const bytes = blobs[index];
      if (!bytes || appearsGitLfsPointer(bytes) || appearsBinary(bytes)) continue;
      files.push(
        retainResolutionContext(
          {
            ...inventoryFileForCommittedEntry(
              entry,
              committedContentHash(identity.objectFormat, entry.blobId),
              languagePacks,
            ),
            content: decodeUtf8(bytes),
          },
          languagePacks,
        ),
      );
    }
  }
  const workspace = yield* languagePacks.discoverWorkspace(files);
  const projectRoots = [
    ...new Set(
      workspace.projects
        .map(project => project.root)
        .map(normalizeRepositoryPath)
        .filter(root => root.length > 0 && !root.split('/').some(segment => segment === '..' || segment === '')),
    ),
  ].sort(compareCodeUnits);
  const sourceRoots = [
    ...new Set(
      workspace.projects
        .flatMap(project => project.sourceRoots)
        .map(normalizeRepositoryPath)
        .filter(root => root.length > 0 && !root.split('/').some(segment => segment === '..' || segment === '')),
    ),
  ].sort(compareCodeUnits);
  return {files: new Map(files.map(file => [file.path, file])), projectRoots, sourceRoots};
});

export function acceptsRepositoryPath(
  value: string,
  threadnoteIgnore = '',
  declaredProjectRoots: readonly string[] = [],
  declaredSourceRoots: readonly string[] = [],
): boolean {
  return acceptsRepositoryPathWithRules(
    value,
    compileThreadnoteIgnore(threadnoteIgnore),
    BUILTIN_LANGUAGE_PACK_REGISTRY,
    declaredProjectRoots,
    declaredSourceRoots,
  );
}

function acceptsRepositoryPathWithRules(
  value: string,
  ignoreRules: readonly CompiledIgnoreRule[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
  declaredProjectRoots: readonly string[] = [],
  declaredSourceRoots: readonly string[] = [],
): boolean {
  const path = normalizeRepositoryPath(value);
  if (!path || path.startsWith('/') || path.split('/').some(segment => segment === '..' || segment === '')) {
    return false;
  }
  const segments = path.split('/');
  const directories = segments.slice(0, -1);
  if (
    directories.some((directory, index) => {
      if (directory.startsWith('.') && !AUTHORED_DOT_DIRECTORIES.has(directory.toLowerCase())) return true;
      const normalizedDirectory = directory.toLowerCase();
      const bazelOutputLink = normalizedDirectory.startsWith('bazel-');
      if (!bazelOutputLink && !PRUNED_DIRECTORIES.has(normalizedDirectory)) return false;
      const prefix = directories.slice(0, index + 1).join('/');
      // A generated-looking directory is authored source only when a manifest
      // declares that directory itself (or one of its descendants) as a
      // project/source root. A broad source root must not re-include nested
      // output such as packages/app/dist or packages/app/build.
      const declaredRoots = [...declaredProjectRoots, ...declaredSourceRoots];
      if (declaredRoots.some(root => root === prefix || root.startsWith(`${prefix}/`))) return false;
      if (bazelOutputLink || GENERATED_DIRECTORIES.has(normalizedDirectory)) return true;
      return !declaredSourceRoots.some(root => prefix.startsWith(`${root}/`));
    }) ||
    isIgnoredByThreadnote(path, ignoreRules)
  ) {
    return false;
  }
  return Option.isSome(languagePacks.match(path));
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
    maxOutputBytes: 0,
    timeoutMs: 0,
  }).pipe(Effect.map(result => new Set(result.stdout.split('\0').filter(Boolean).map(normalizeRepositoryPath))));
}

const readCommittedFiles = Effect.fn('codeGraph.readCommittedFiles')(function* (
  identity: RepositoryIdentity,
  entries: readonly GitTreeEntry[],
  excluded: number,
  cachedCommittedFileKeys: ReadonlySet<string>,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  preloadedResolutionContexts: ReadonlyMap<string, CodeGraphInventoryFile>,
  onContentBatch?: CodeGraphInventoryOptions['onContentBatch'],
  onProgress?: CodeGraphInventoryOptions['onProgress'],
) {
  const files: CodeGraphInventoryFile[] = [];
  let skipped = 0;
  let completed = 0;
  const parsedPaths = new Set<string>();
  const needsContent: Array<GitTreeEntry & {readonly parse: boolean}> = [];
  const metadataOnlyContent: CodeGraphInventoryFile[] = [];
  for (const entry of entries) {
    const contentHash = committedContentHash(identity.objectFormat, entry.blobId);
    const cached = cachedCommittedFileKeys.has(cacheKey(entry.path, contentHash, languagePacks));
    const preloaded = preloadedResolutionContexts.get(entry.path);
    if (preloaded && cached) {
      files.push(preloaded);
      completed += 1;
    } else if (cached && !languagePacks.isResolutionContext(entry.path)) {
      files.push(inventoryFileForCommittedEntry(entry, contentHash, languagePacks));
      completed += 1;
    } else if (!cached && repositoryContentOmissionReason(entry.path, entry.size, languagePacks) !== undefined) {
      const metadata = {
        ...inventoryFileForCommittedEntry(entry, contentHash, languagePacks),
        contentOmittedReason: repositoryContentOmissionReason(entry.path, entry.size, languagePacks),
      } satisfies CodeGraphInventoryFile;
      metadataOnlyContent.push(metadata);
      files.push(retainResolutionContext(metadata, languagePacks));
      parsedPaths.add(entry.path);
      completed += 1;
    } else {
      needsContent.push({...entry, parse: !cached});
    }
  }
  for (let offset = 0; offset < metadataOnlyContent.length; offset += CAT_FILE_BATCH_ENTRIES) {
    const batch = metadataOnlyContent.slice(offset, offset + CAT_FILE_BATCH_ENTRIES);
    yield* onContentBatch?.(batch, {
      progress: {
        accepted: files.length,
        completed: completed - metadataOnlyContent.length + offset,
        excluded,
        phase: 'scanning',
        skipped,
        total: entries.length,
        unit: 'files',
      },
      readingMilliseconds: 0,
      sourceBytes: batch.reduce((total, file) => total + file.size, 0),
    }) ?? Effect.void;
  }
  yield* onProgress?.({
    accepted: files.length,
    completed,
    excluded,
    phase: 'scanning',
    skipped,
    total: entries.length,
    unit: 'files',
  }) ?? Effect.void;
  for (const batch of chunkTreeEntries(needsContent)) {
    const first = batch[0]!;
    const batchLanguages = new Set(
      batch.map(entry =>
        Option.match(languagePacks.match(entry.path), {onNone: () => 'text', onSome: value => value.language}),
      ),
    );
    yield* onProgress?.({
      accepted: files.length,
      activity: {
        batchCompleted: 0,
        batchTotal: batch.length,
        bytes: batch.reduce((total, entry) => total + entry.size, 0),
        language: batchLanguages.size === 1 ? [...batchLanguages][0]! : 'mixed',
        path: first.path,
        stage: 'reading',
      },
      completed,
      excluded,
      phase: 'scanning',
      skipped,
      total: entries.length,
      unit: 'files',
    }) ?? Effect.void;
    const readingStarted = performance.now();
    const expectedBytes = batch.reduce((total, entry) => total + entry.size, 0) + batch.length * 256;
    const result = yield* runBinaryCommandEffect('git', ['-C', identity.repoRoot, 'cat-file', '--batch'], {
      input: new TextEncoder().encode(`${batch.map(entry => entry.blobId).join('\n')}\n`),
      maxOutputBytes: expectedBytes,
      timeoutMs: 0,
    });
    const blobs = parseGitCatFileBatch(result.stdout, batch);
    const contentBatch: CodeGraphInventoryFile[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const entry = batch[index]!;
      const bytes = blobs[index];
      if (!bytes || appearsGitLfsPointer(bytes)) {
        skipped += 1;
        continue;
      }
      const content = appearsBinary(bytes) ? undefined : decodeUtf8(bytes);
      const acceptsBinary = acceptsBinaryContent(entry.path, languagePacks);
      if (content === undefined && !acceptsBinary) {
        skipped += 1;
        continue;
      }
      const hydrated = {
        ...inventoryFileForCommittedEntry(
          entry,
          committedContentHash(identity.objectFormat, entry.blobId),
          languagePacks,
        ),
        ...(content === undefined ? {bytes} : {content}),
      } satisfies CodeGraphInventoryFile;
      if (entry.parse) contentBatch.push(hydrated);
      const retained = retainResolutionContext(hydrated, languagePacks);
      files.push(retained);
    }
    if (contentBatch.length > 0) {
      yield* onContentBatch?.(contentBatch, {
        progress: {
          accepted: files.length,
          completed,
          excluded,
          phase: 'scanning',
          skipped,
          total: entries.length,
          unit: 'files',
        },
        readingMilliseconds: performance.now() - readingStarted,
        sourceBytes: contentBatch.reduce((total, file) => total + file.size, 0),
      }) ?? Effect.void;
    }
    for (const file of contentBatch) parsedPaths.add(file.path);
    completed += batch.length;
    yield* onProgress?.({
      accepted: files.length,
      completed,
      excluded,
      phase: 'scanning',
      skipped,
      total: entries.length,
      unit: 'files',
    }) ?? Effect.void;
  }
  return {files, parsedPaths, skipped};
});

function inventoryFileForCommittedEntry(
  entry: GitTreeEntry,
  contentHash: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): CodeGraphInventoryFile {
  const matched = languagePacks.match(entry.path);
  return {
    blobId: entry.blobId,
    contentHash,
    language: Option.match(matched, {onNone: () => 'text', onSome: value => value.language}),
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
  threadnoteIgnore: string,
  ignoreRules: readonly CompiledIgnoreRule[],
  cachedFileKeys: ReadonlySet<string>,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  declaredProjectRoots: readonly string[],
  declaredSourceRoots: readonly string[],
  onContentBatch?: CodeGraphInventoryOptions['onContentBatch'],
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
            maxOutputBytes: 0,
            timeoutMs: 0,
          },
        )).stdout,
      ]
    : yield* Effect.all(
        [
          runCommandEffect(
            'git',
            ['-C', identity.repoRoot, 'diff', '--name-status', '-z', '--find-renames', identity.headCommit, '--'],
            {maxOutputBytes: 0, timeoutMs: 0},
          ).pipe(Effect.map(result => result.stdout)),
          runCommandEffect('git', ['-C', identity.repoRoot, 'ls-files', '-z', '--others', '--exclude-standard'], {
            maxOutputBytes: 0,
            timeoutMs: 0,
          }).pipe(Effect.map(result => result.stdout)),
        ],
        {concurrency: 2},
      );
  const changes = parseNameStatus(diffOutput);
  const untracked = new Set(untrackedOutput.split('\0').filter(Boolean).map(normalizeRepositoryPath));
  for (const value of untracked) {
    changes.changed.add(value);
  }
  const overlayContextFiles: CodeGraphInventoryFile[] = [];
  for (const relative of [...changes.changed].sort()) {
    if (!languagePacks.isResolutionContext(relative)) continue;
    const directories = relative.split('/').slice(0, -1);
    if (directories.some(directory => directory.startsWith('.') || directory.toLowerCase() === 'node_modules')) {
      continue;
    }
    const opened = yield* materializeContainedStableRegularFile(
      fs,
      path,
      repositoryRoot,
      relative,
      size => size > CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT,
    ).pipe(Effect.option);
    if (opened._tag === 'None' || opened.value.bytes === undefined) continue;
    if (appearsGitLfsPointer(opened.value.bytes) || appearsBinary(opened.value.bytes)) continue;
    const matched = languagePacks.match(relative);
    overlayContextFiles.push(
      retainResolutionContext(
        {
          blobId: `worktree:${opened.value.contentHash}`,
          content: decodeUtf8(opened.value.bytes),
          contentHash: opened.value.contentHash,
          language: Option.match(matched, {onNone: () => 'text', onSome: value => value.language}),
          mode: '100644',
          path: relative,
          size: opened.value.size,
          source: 'worktree',
        },
        languagePacks,
      ),
    );
  }
  const overlayWorkspace =
    overlayContextFiles.length === 0 ? undefined : yield* languagePacks.discoverWorkspace(overlayContextFiles);
  const effectiveDeclaredProjectRoots = [
    ...new Set([...declaredProjectRoots, ...(overlayWorkspace?.projects.map(project => project.root) ?? [])]),
  ]
    .map(normalizeRepositoryPath)
    .filter(root => root.length > 0 && !root.split('/').some(segment => segment === '..' || segment === ''))
    .sort(compareCodeUnits);
  const effectiveDeclaredSourceRoots = [
    ...new Set([...declaredSourceRoots, ...(overlayWorkspace?.projects.flatMap(project => project.sourceRoots) ?? [])]),
  ]
    .map(normalizeRepositoryPath)
    .filter(root => root.length > 0 && !root.split('/').some(segment => segment === '..' || segment === ''))
    .sort(compareCodeUnits);
  const files: CodeGraphInventoryFile[] = [];
  let skipped = 0;
  const parsedPaths = new Set<string>();
  let contentBatch: CodeGraphInventoryFile[] = [];
  let contentBatchBytes = 0;
  let contentBatchReadingMilliseconds = 0;
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
  const flushContentBatch = () => {
    const current = contentBatch;
    const readingMilliseconds = contentBatchReadingMilliseconds;
    const sourceBytes = contentBatchBytes;
    contentBatch = [];
    contentBatchBytes = 0;
    contentBatchReadingMilliseconds = 0;
    for (const file of current) parsedPaths.add(file.path);
    return current.length > 0
      ? (onContentBatch?.(current, {
          progress: {
            accepted: files.length,
            completed: files.length + skipped,
            excluded: 0,
            phase: 'scanning',
            skipped,
            total: changes.changed.size,
            unit: 'files',
          },
          readingMilliseconds,
          sourceBytes,
        }) ?? Effect.void)
      : Effect.void;
  };
  for (const relative of [...changes.changed].sort()) {
    const absolute = path.resolve(identity.repoRoot, relative);
    const containment = path.relative(identity.repoRoot, absolute);
    if (
      containment === '..' ||
      containment.startsWith(`..${path.sep}`) ||
      path.isAbsolute(containment) ||
      !acceptsRepositoryPathWithRules(
        relative,
        ignoreRules,
        languagePacks,
        effectiveDeclaredProjectRoots,
        effectiveDeclaredSourceRoots,
      )
    ) {
      markSkipped(relative);
      continue;
    }
    const readingStarted = performance.now();
    const opened = yield* materializeContainedStableRegularFile(fs, path, repositoryRoot, relative, size =>
      shouldOmitRepositoryContent(relative, size, languagePacks),
    ).pipe(Effect.option);
    const readingMilliseconds = performance.now() - readingStarted;
    if (opened._tag === 'None') {
      markSkipped(relative);
      continue;
    }
    const materialized = opened.value;
    const matched = languagePacks.match(relative);
    if (materialized.bytes === undefined) {
      const contentOmittedReason = repositoryContentOmissionReason(relative, materialized.size, languagePacks);
      if (contentOmittedReason === undefined) {
        markSkipped(relative);
        continue;
      }
      const metadata = {
        blobId: `worktree:${materialized.contentHash}`,
        contentHash: materialized.contentHash,
        contentOmittedReason,
        language: Option.match(matched, {onNone: () => 'text', onSome: value => value.language}),
        mode: '100644',
        path: relative,
        size: materialized.size,
        source: 'worktree',
      } satisfies CodeGraphInventoryFile;
      if (!cachedFileKeys.has(cacheKey(relative, materialized.contentHash, languagePacks))) {
        if (contentBatch.length >= CAT_FILE_BATCH_ENTRIES) yield* flushContentBatch();
        contentBatch.push(metadata);
        contentBatchBytes += materialized.size;
        contentBatchReadingMilliseconds += readingMilliseconds;
      }
      files.push(retainResolutionContext(metadata, languagePacks));
      continue;
    }
    const bytes = materialized.bytes;
    if (appearsGitLfsPointer(bytes)) {
      markSkipped(relative);
      continue;
    }
    const content = appearsBinary(bytes) ? undefined : decodeUtf8(bytes);
    const acceptsBinary = acceptsBinaryContent(relative, languagePacks);
    if (content === undefined && !acceptsBinary) {
      markSkipped(relative);
      continue;
    }
    if (
      contentBatch.length > 0 &&
      (contentBatch.length >= CAT_FILE_BATCH_ENTRIES || contentBatchBytes + bytes.byteLength > CAT_FILE_BATCH_BYTES)
    ) {
      yield* flushContentBatch();
    }
    const contentHash = materialized.contentHash;
    const hydrated = {
      blobId: `worktree:${contentHash}`,
      ...(content === undefined ? {bytes} : {content}),
      contentHash,
      language: Option.match(matched, {onNone: () => 'text', onSome: value => value.language}),
      mode: '100644',
      path: relative,
      size: bytes.byteLength,
      source: 'worktree',
    } satisfies CodeGraphInventoryFile;
    if (!cachedFileKeys.has(cacheKey(relative, contentHash, languagePacks))) {
      contentBatch.push(hydrated);
      contentBatchBytes += bytes.byteLength;
      contentBatchReadingMilliseconds += readingMilliseconds;
    }
    const retained = retainResolutionContext(hydrated, languagePacks);
    files.push(retained);
  }
  yield* flushContentBatch();
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
    parsedPaths,
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

function chunkTreeEntries<T extends GitTreeEntry>(entries: readonly T[]): readonly (readonly T[])[] {
  const batches: T[][] = [];
  let current: T[] = [];
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

function retainResolutionContext(
  file: CodeGraphInventoryFile,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): CodeGraphInventoryFile {
  const name = file.path.split('/').at(-1)?.toLowerCase() ?? '';
  const content =
    file.content === undefined
      ? undefined
      : (compactResolutionContext(name, file.content) ??
        (languagePacks.isResolutionContext(file.path) && !COMPACT_RESOLUTION_CONTEXT_NAMES.has(name)
          ? file.content
          : undefined));
  if (content !== undefined) {
    return {...file, content};
  }
  const {bytes: _bytes, content: _content, contentOmittedReason: _contentOmittedReason, ...metadata} = file;
  return metadata;
}

function isCorpusContent(path: string, languagePacks: CodeGraphLanguagePackRegistryShape): boolean {
  return Option.match(languagePacks.match(path), {
    onNone: () => false,
    onSome: value => value.role === 'corpus',
  });
}

export function shouldOmitRepositoryContent(
  path: string,
  size: number,
  languagePacks: CodeGraphLanguagePackRegistryShape = BUILTIN_LANGUAGE_PACK_REGISTRY,
): boolean {
  return repositoryContentOmissionReason(path, size, languagePacks) !== undefined;
}

function repositoryContentOmissionReason(
  path: string,
  size: number,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): CodeGraphInventoryFile['contentOmittedReason'] {
  const match = languagePacks.match(path);
  if (Option.isNone(match)) return undefined;
  if (
    (match.value.language === 'json' || match.value.language === 'jsonc' || match.value.language === 'yaml') &&
    isLowSignalStructuredPath(path)
  ) {
    return 'metadata-only';
  }
  if (match.value.role !== 'corpus') return undefined;
  if (size > CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT) return 'size-budget';
  return match.value.language === 'image' || match.value.language === 'audio' || match.value.language === 'video'
    ? 'metadata-only'
    : undefined;
}

function acceptsBinaryContent(path: string, languagePacks: CodeGraphLanguagePackRegistryShape): boolean {
  return isCorpusContent(path, languagePacks);
}

function compactResolutionContext(name: string, content: string): string | undefined {
  if (name === 'go.mod') return compactGoModule(content);
  if (name === 'pom.xml') return compactMavenManifest(content);
  if (name === 'settings.gradle' || name === 'settings.gradle.kts') return compactGradleSettings(content);
  if (name === 'build.gradle' || name === 'build.gradle.kts') return compactGradleBuild(content);
  if (name === 'gradle.properties') return '';
  if (name === 'package.swift') return compactSwiftPackage(content);
  if (name === 'project.pbxproj') return compactXcodeProject(content);
  if (name !== 'package.json' && name !== 'tsconfig.json') return undefined;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    if (name === 'package.json') {
      const entry = packageEntryForResolution(parsed.exports, parsed.main);
      const dependencySections = Object.fromEntries(
        ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(section => {
          const value = parsed[section];
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          return [
            [
              section,
              Object.fromEntries(
                Object.entries(value as Record<string, unknown>).flatMap(([dependency, version]) =>
                  typeof version === 'string' ? [[dependency, version]] : [],
                ),
              ),
            ],
          ];
        }),
      );
      return JSON.stringify({
        ...dependencySections,
        ...(entry === undefined ? {} : {main: entry}),
        ...(typeof parsed.name === 'string' ? {name: parsed.name} : {}),
        ...(typeof parsed.packageManager === 'string' ? {packageManager: parsed.packageManager} : {}),
        ...(Array.isArray(parsed.workspaces)
          ? {workspaces: parsed.workspaces.filter((value): value is string => typeof value === 'string')}
          : parsed.workspaces && typeof parsed.workspaces === 'object'
            ? {
                workspaces: {
                  packages: Array.isArray((parsed.workspaces as Record<string, unknown>).packages)
                    ? ((parsed.workspaces as Record<string, unknown>).packages as unknown[]).filter(
                        (value): value is string => typeof value === 'string',
                      )
                    : [],
                },
              }
            : {}),
      });
    }
    const compilerOptions =
      parsed.compilerOptions && typeof parsed.compilerOptions === 'object' && !Array.isArray(parsed.compilerOptions)
        ? (parsed.compilerOptions as Record<string, unknown>)
        : {};
    const paths =
      compilerOptions.paths && typeof compilerOptions.paths === 'object' && !Array.isArray(compilerOptions.paths)
        ? Object.fromEntries(
            Object.entries(compilerOptions.paths as Record<string, unknown>).flatMap(([alias, targets]) =>
              Array.isArray(targets)
                ? [[alias, targets.filter((target): target is string => typeof target === 'string')]]
                : [],
            ),
          )
        : undefined;
    const compact: Record<string, unknown> = {
      compilerOptions: {
        ...(typeof compilerOptions.baseUrl === 'string' ? {baseUrl: compilerOptions.baseUrl} : {}),
        ...(typeof compilerOptions.outDir === 'string' ? {outDir: compilerOptions.outDir} : {}),
        ...(paths === undefined ? {} : {paths}),
      },
    };
    for (const field of ['exclude', 'files', 'include'] as const) {
      if (Object.prototype.hasOwnProperty.call(parsed, field)) {
        compact[field] = Array.isArray(parsed[field])
          ? parsed[field].filter((value): value is string => typeof value === 'string')
          : parsed[field];
      }
    }
    if (Array.isArray(parsed.references)) {
      compact.references = parsed.references.flatMap(reference =>
        reference &&
        typeof reference === 'object' &&
        !Array.isArray(reference) &&
        typeof (reference as Record<string, unknown>).path === 'string'
          ? [{path: (reference as Record<string, unknown>).path}]
          : [],
      );
    }
    return JSON.stringify(compact);
  } catch {
    return undefined;
  }
}

function compactGoModule(content: string): string {
  const output: string[] = [];
  let inRequireBlock = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (/^module\s+\S+/.test(line)) {
      output.push(line);
      continue;
    }
    if (/^require\s*\($/.test(line)) {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }
    if (inRequireBlock && /^\S+\s+v\S+/.test(line)) {
      output.push(line);
      continue;
    }
    if (/^require\s+\S+\s+v\S+/.test(line)) output.push(line);
  }
  return `${output.join('\n')}\n`;
}

function compactMavenManifest(content: string): string | undefined {
  const project = content.replace(/<parent\b[\s\S]*?<\/parent>/i, '');
  const group = compactXmlTag(project, 'groupId');
  const artifact = compactXmlTag(project, 'artifactId');
  if (!artifact) return undefined;
  const modules = compactXmlTags(content, 'module');
  const dependencies = [...content.matchAll(/<dependency\b[\s\S]*?<\/dependency>/gi)].flatMap(match => {
    const dependencyArtifact = compactXmlTag(match[0], 'artifactId');
    if (!dependencyArtifact) return [];
    const dependencyGroup = compactXmlTag(match[0], 'groupId');
    return [
      `<dependency>${dependencyGroup ? `<groupId>${dependencyGroup}</groupId>` : ''}<artifactId>${dependencyArtifact}</artifactId></dependency>`,
    ];
  });
  return [
    '<project>',
    group ? `<groupId>${group}</groupId>` : '',
    `<artifactId>${artifact}</artifactId>`,
    modules.length > 0 ? `<modules>${modules.map(module => `<module>${module}</module>`).join('')}</modules>` : '',
    dependencies.length > 0 ? `<dependencies>${dependencies.join('')}</dependencies>` : '',
    '</project>',
  ].join('');
}

function compactGradleSettings(content: string): string {
  return `${content
    .split(/\r?\n/)
    .filter(line => /\brootProject\.name\b|^\s*include\b|\.projectDir\s*=/.test(line))
    .join('\n')}\n`;
}

function compactGradleBuild(content: string): string {
  return `${content
    .split(/\r?\n/)
    .filter(line => /\bproject\s*\(/.test(line))
    .join('\n')}\n`;
}

function compactSwiftPackage(content: string): string | undefined {
  const packageName = /\bPackage\s*\(\s*name\s*:\s*"([^"]+)"/m.exec(content)?.[1];
  const starts = [...content.matchAll(/\.(target|executableTarget|testTarget)\s*\(\s*name\s*:\s*"([^"]+)"/g)];
  if (!packageName && starts.length === 0) return undefined;
  const targets = starts.map((match, index) => {
    const body = content.slice(match.index, starts[index + 1]?.index ?? content.length);
    const path = /\bpath\s*:\s*"([^"]+)"/.exec(body)?.[1];
    const dependencies = /\bdependencies\s*:\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? '';
    const names = [...dependencies.matchAll(/"([^"]+)"/g)].map(value => value[1]!);
    return `.${match[1]}(name: ${JSON.stringify(match[2])}, dependencies: [${names
      .map(name => JSON.stringify(name))
      .join(', ')}]${path ? `, path: ${JSON.stringify(path)}` : ''})`;
  });
  return `let package = Package(name: ${JSON.stringify(packageName ?? 'Package')}, targets: [${targets.join(', ')}])\n`;
}

function compactXcodeProject(content: string): string {
  const targets = [...content.matchAll(/isa\s*=\s*PBXNativeTarget;[\s\S]*?\bname\s*=\s*"?([^";\n]+)"?;/g)].map(match =>
    match[1]!.trim(),
  );
  return `${targets.map(target => `isa = PBXNativeTarget; name = ${JSON.stringify(target)};`).join('\n')}\n`;
}

function compactXmlTag(content: string, tag: string): string | undefined {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*</${tag}>`, 'i').exec(content)?.[1]?.trim();
}

function compactXmlTags(content: string, tag: string): readonly string[] {
  return [...content.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*</${tag}>`, 'gi'))].map(match =>
    match[1]!.trim(),
  );
}

function packageEntryForResolution(exportsValue: unknown, mainValue: unknown): string | undefined {
  if (exportsValue === undefined) return typeof mainValue === 'string' ? mainValue : undefined;
  const root =
    typeof exportsValue === 'object' &&
    exportsValue !== null &&
    !Array.isArray(exportsValue) &&
    Object.keys(exportsValue).some(key => key.startsWith('.'))
      ? (exportsValue as Record<string, unknown>)['.']
      : exportsValue;
  const targets = new Set(collectResolutionExportTargets(root));
  return targets.size === 1 ? [...targets][0] : undefined;
}

function collectResolutionExportTargets(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectResolutionExportTargets);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value as Record<string, unknown>).flatMap(collectResolutionExportTargets);
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

function normalizeRepositoryPath(value: string): string {
  return value.replace(/^\.\/+/, '');
}

function cacheKey(path: string, contentHash: string, languagePacks: CodeGraphLanguagePackRegistryShape): string {
  return `${path}\0${contentHash}\0${Option.getOrElse(languagePacks.cacheIdentityForPath(path), () => 'unmatched')}`;
}

function isZeroObjectId(value: string): boolean {
  return /^0{40}(?:0{24})?$/.test(value);
}

const readOptionalText = Effect.fn('codeGraph.readOptionalText')(function* (fs: FileSystem.FileSystem, target: string) {
  const opened = yield* readStableRegularFile(fs, target).pipe(Effect.option);
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
    if (pathInfoBefore.type !== 'File') {
      return yield* Effect.fail(new Error(`Refusing to read a non-regular repository file: ${target}`));
    }
    yield* interlock?.beforeOpen ?? Effect.void;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(target, {flag: 'r'});
        yield* interlock?.afterOpen ?? Effect.void;
        const openedInfoBefore = yield* file.stat;
        const openedPath = yield* openedFilePath(fs, file);
        const pathInfoOpened = yield* fs.stat(target);
        if (!sameRegularFile(pathInfoBefore, pathInfoOpened, openedInfoBefore)) {
          return yield* Effect.fail(new Error(`Repository file changed while it was opened: ${target}`));
        }
        const byteLength = Number(openedInfoBefore.size);
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
          return yield* Effect.fail(new Error(`Repository file size cannot be represented safely: ${target}`));
        }
        const bytes = new Uint8Array(byteLength);
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
  interlock?: ContainedReadInterlock,
): Effect.Effect<Uint8Array, Error, SystemInfo> {
  const target = path.join(repositoryRoot, ...relative.split('/'));
  return Effect.gen(function* () {
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalBefore = yield* fs.realPath(target);
    if (!isContainedPath(path, repositoryRoot, canonicalBefore)) {
      return yield* Effect.fail(new Error(`Repository file resolves outside its root: ${relative}`));
    }
    const opened = yield* readStableRegularFile(fs, target, interlock);
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

interface StableContainedMaterialization {
  readonly bytes?: Uint8Array;
  readonly contentHash: string;
  readonly size: number;
}

/**
 * Safely materialize a worktree file, or hash it through a fixed-size buffer when
 * policy says its content should remain metadata-only. This keeps dirty large
 * corpus artifacts from allocating their full size while preserving an exact
 * content fingerprint and the same symlink/race interlocks as ordinary reads.
 */
function materializeContainedStableRegularFile(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  relative: string,
  omitContent: (size: number) => boolean,
): Effect.Effect<StableContainedMaterialization, Error, SystemInfo> {
  const target = path.join(repositoryRoot, ...relative.split('/'));
  return Effect.gen(function* () {
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalBefore = yield* fs.realPath(target);
    if (!isContainedPath(path, repositoryRoot, canonicalBefore)) {
      return yield* Effect.fail(new Error(`Repository file resolves outside its root: ${relative}`));
    }
    const linkTarget = yield* fs.readLink(target).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
    );
    if (Option.isSome(linkTarget)) {
      return yield* Effect.fail(new Error(`Refusing to read a symbolic repository file: ${relative}`));
    }
    const pathInfoBefore = yield* fs.stat(target);
    if (pathInfoBefore.type !== 'File') {
      return yield* Effect.fail(new Error(`Refusing to read a non-regular repository file: ${relative}`));
    }
    const materialized = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(target, {flag: 'r'});
        const openedInfoBefore = yield* file.stat;
        const openedPath = yield* openedFilePath(fs, file);
        const pathInfoOpened = yield* fs.stat(target);
        if (!sameRegularFile(pathInfoBefore, pathInfoOpened, openedInfoBefore)) {
          return yield* Effect.fail(new Error(`Repository file changed while it was opened: ${relative}`));
        }
        if (Option.isSome(openedPath) && !isContainedPath(path, repositoryRoot, openedPath.value)) {
          return yield* Effect.fail(new Error(`Opened repository file is outside its root: ${relative}`));
        }
        const size = Number(openedInfoBefore.size);
        if (!Number.isSafeInteger(size) || size < 0) {
          return yield* Effect.fail(new Error(`Repository file size cannot be represented safely: ${relative}`));
        }
        const hasher = new Bun.CryptoHasher('sha256');
        const bytes = omitContent(size) ? undefined : new Uint8Array(size);
        const buffer = bytes ?? new Uint8Array(Math.min(1_048_576, Math.max(1, size)));
        let offset = 0;
        while (offset < size) {
          const view = bytes ? bytes.subarray(offset) : buffer.subarray(0, Math.min(buffer.byteLength, size - offset));
          const read = Number(yield* file.read(view));
          if (read <= 0) {
            return yield* Effect.fail(new Error(`Repository file ended while it was being read: ${relative}`));
          }
          hasher.update(view.subarray(0, read));
          offset += read;
        }
        const openedInfoAfter = yield* file.stat;
        const linkTargetAfter = yield* fs.readLink(target).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none<string>())),
        );
        const pathInfoAfter = yield* fs.stat(target);
        if (
          Option.isSome(linkTargetAfter) ||
          !sameRegularFile(pathInfoBefore, pathInfoAfter, openedInfoAfter) ||
          openedInfoBefore.size !== openedInfoAfter.size
        ) {
          return yield* Effect.fail(new Error(`Repository file changed while it was being read: ${relative}`));
        }
        return {bytes, contentHash: hasher.digest('hex'), size} satisfies StableContainedMaterialization;
      }),
    );
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalAfter = yield* fs.realPath(target);
    if (!isContainedPath(path, repositoryRoot, canonicalAfter)) {
      return yield* Effect.fail(new Error(`Repository file escaped its root while reading: ${relative}`));
    }
    return materialized;
  }).pipe(Effect.mapError(cause => new Error(`Could not safely materialize repository path ${relative}.`, {cause})));
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
