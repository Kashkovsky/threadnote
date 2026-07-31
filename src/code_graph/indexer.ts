import {Clock, Context, Crypto, Effect, FileSystem, Layer, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {CommandExecutor} from '../effect/command.js';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {SystemInfo} from '../effect/system.js';
import {createPackageAttributor, createResolutionAttributor, extractRepositoryFileFacts} from './extractor.js';
import {inventoryRepository, worktreeOverlayState, type CodeGraphInventoryOptions} from './inventory.js';
import {
  BUILTIN_LANGUAGE_PACK_REGISTRY,
  CodeGraphLanguagePackRegistry,
  type CodeGraphLanguagePackRegistryShape,
} from './languages/registry.js';
import {codeGraphLayout} from './layout.js';
import {codeGraphMaintenanceIntentActive, withCodeGraphMaintenanceRegistration} from './maintenance_gate.js';
import {repositoryWorktreeIds, resolveRepositoryIdentity} from './repository.js';
import {CodeGraphStore, type CodeGraphStoreShape} from './store.js';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  type CodeGraphFileFacts,
  type CodeGraphIndexSummary,
  type CodeGraphInventoryFile,
  type CodeGraphProgress,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from './types.js';
import type {CodeGraphInventory} from './inventory.js';
import type {CodeGraphLayout} from './layout.js';
import {
  CodeGraphEmbeddingIndex,
  type CodeGraphEmbeddingIndexShape,
  type CodeGraphEmbeddingStatus,
} from './embedding.js';
import {TreeSitterRuntime, type TreeSitterRuntimeShape} from './tree_sitter/runtime.js';
import {createWorkspaceAttributor} from './workspace.js';

export interface CodeGraphIndexOptions extends CodeGraphInventoryOptions {
  readonly cwd: string;
  readonly force?: boolean;
  readonly threadnoteHome: string;
}

export interface CodeGraphCommitLease {
  readonly leaseToken: string;
  readonly snapshot: CodeGraphSnapshot;
}

export interface CodeGraphIndexerShape {
  readonly ensureCommit: (
    options: Omit<CodeGraphIndexOptions, 'force' | 'includeOverlay'> & {readonly commit: string},
  ) => Effect.Effect<CodeGraphCommitLease, unknown>;
  readonly index: (options: CodeGraphIndexOptions) => Effect.Effect<CodeGraphIndexSummary, unknown>;
}

export class CodeGraphIndexer extends Context.Service<CodeGraphIndexer, CodeGraphIndexerShape>()(
  'threadnote/codeGraph/CodeGraphIndexer',
) {
  static readonly layer = Layer.effect(
    CodeGraphIndexer,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const embedding = yield* CodeGraphEmbeddingIndex;
      const languagePacks = yield* CodeGraphLanguagePackRegistry;
      const treeSitter = yield* TreeSitterRuntime;
      const command = yield* CommandExecutor;
      const crypto = yield* Crypto.Crypto;
      const system = yield* SystemInfo;
      const index = (options: CodeGraphIndexOptions, attempt = 0): Effect.Effect<CodeGraphIndexSummary, unknown> =>
        Effect.gen(function* () {
          const initialIdentity = yield* resolveRepositoryIdentity(options.cwd);
          const layout = codeGraphLayout(
            path,
            options.threadnoteHome,
            initialIdentity.checkoutId,
            initialIdentity.worktreeId,
          );
          yield* withCodeGraphMaintenanceRegistration(
            options.threadnoteHome,
            Effect.gen(function* () {
              if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                return yield* Effect.fail(new Error('Code graph repository root is a symbolic link.'));
              }
              yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true, mode: 0o700});
              yield* options.onProgress?.({phase: 'registering'}) ?? Effect.void;
            }),
          );
          return yield* withExclusiveFileLock(
            fs,
            layout.lockPath,
            {
              ...CODE_GRAPH_LOCK_OPTIONS,
              onContention: () =>
                (options.onProgress?.({phase: 'waiting'}) ?? Effect.void).pipe(Effect.catch(() => Effect.void)),
            },
            Effect.gen(function* () {
              if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                return yield* Effect.fail(new Error('Code graph repository root is a symbolic link.'));
              }
              if (!(yield* fs.exists(layout.repositoryRoot))) {
                return yield* Effect.fail(new RepositoryRegistrationLost());
              }
              if (yield* codeGraphMaintenanceIntentActive(options.threadnoteHome)) {
                return yield* Effect.fail(new RepositoryMaintenanceInterrupted());
              }
              return yield* store.withSession(
                layout.databasePath,
                Effect.gen(function* () {
                  yield* store.initialize(layout.databasePath);
                  const startedAt = yield* Clock.currentTimeMillis;
                  const identity = yield* resolveRepositoryIdentity(options.cwd);
                  if (identity.repositoryId !== initialIdentity.repositoryId) {
                    return yield* Effect.fail(
                      new Error('Repository identity changed while waiting for the graph lock.'),
                    );
                  }
                  const activeWorktreeIds = yield* repositoryWorktreeIds(identity);
                  const cachedCommittedFileKeys = options.force
                    ? new Set<string>()
                    : yield* cachedFileKeys(store, layout.databasePath, languagePacks);
                  const inventory = yield* inventoryRepository(identity, {
                    ...options,
                    cachedCommittedFileKeys,
                    languagePacks,
                    onContentBatch: cacheContentBatch(store, layout.databasePath, languagePacks, treeSitter),
                  });
                  const extractorSet = extractorSetIdentity(inventory.files, languagePacks);
                  const logicalSnapshotId = snapshotIdentity(identity, inventory.dirty, extractorSet, inventory.files);
                  const forceGeneration = options.force
                    ? (yield* crypto.randomUUIDv4).replaceAll('-', '').slice(0, 16)
                    : undefined;
                  const snapshotId = forcedSnapshotIdentity(logicalSnapshotId, forceGeneration);
                  const existing = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
                  if (!options.force && existing?.id === snapshotId) {
                    yield* store.reconcileWorktrees(layout.databasePath, activeWorktreeIds);
                    const diagnostics: string[] = [];
                    const vectorCheck = yield* embedding
                      .check(options.threadnoteHome, layout, existing.id)
                      .pipe(
                        Effect.catch(cause =>
                          Effect.succeed({reason: messageOf(cause), state: 'unavailable'} as const),
                        ),
                      );
                    const symbols =
                      vectorCheck.state === 'ready'
                        ? []
                        : embeddingSymbolSource(store, layout.databasePath, existing.id);
                    const repaired = yield* embedding
                      .ensure(options.threadnoteHome, layout, existing, symbols, {
                        activeWorktreeIds,
                        onProgress: options.onProgress,
                      })
                      .pipe(
                        Effect.catch(cause =>
                          Effect.succeed({
                            embedded: 0,
                            ready: false,
                            reason: messageOf(cause),
                            reused: 0,
                          } satisfies CodeGraphEmbeddingStatus),
                        ),
                      );
                    if (!repaired.ready) {
                      diagnostics.push(`Vector graph retrieval unavailable: ${repaired.reason ?? 'unknown reason'}`);
                    }
                    return {
                      diagnostics,
                      durationMs: (yield* Clock.currentTimeMillis) - startedAt,
                      identity,
                      reusedFiles: inventory.files.length - inventory.parsedFiles,
                      skippedFiles: inventory.skipped,
                      snapshot: existing,
                    };
                  }
                  const baseSnapshot = inventory.dirty
                    ? yield* ensureCommittedBase({
                        activeWorktreeIds,
                        embedding,
                        force: options.force === true,
                        forceGeneration,
                        fs,
                        identity,
                        inventory,
                        languagePacks,
                        layout,
                        onProgress: options.onProgress,
                        startedAt,
                        store,
                        threadnoteHome: options.threadnoteHome,
                      })
                    : undefined;
                  const building: CodeGraphSnapshot = {
                    baseSnapshotId: baseSnapshot?.id,
                    commit: identity.headCommit,
                    dirty: inventory.dirty,
                    edgeCount: 0,
                    extractorSet,
                    fileCount: 0,
                    id: snapshotId,
                    overlayFingerprint: inventory.overlayFingerprint,
                    repositoryId: identity.repositoryId,
                    state: 'building',
                    symbolCount: 0,
                    worktreeId: identity.worktreeId,
                  };
                  yield* store.markBuilding(layout.databasePath, identity, building);
                  return yield* buildAndActivate({
                    activeWorktreeIds,
                    activatePointer: true,
                    building,
                    existing,
                    embedding,
                    ensureVectors: true,
                    force: options.force === true,
                    fs,
                    identity,
                    inventory,
                    languagePacks,
                    layout,
                    onProgress: options.onProgress,
                    startedAt,
                    store,
                    threadnoteHome: options.threadnoteHome,
                  }).pipe(
                    Effect.catch(cause =>
                      store
                        .markFailed(layout.databasePath, snapshotId, messageOf(cause))
                        .pipe(Effect.andThen(Effect.fail(cause))),
                    ),
                  );
                }).pipe(
                  Effect.onError(() =>
                    store.pruneCachedFacts(layout.databasePath).pipe(Effect.catch(() => Effect.void)),
                  ),
                ),
              );
            }),
          );
        }).pipe(
          Effect.provideService(CommandExecutor, command),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
          Effect.catchIf(
            cause => cause instanceof WorktreeChangedDuringIndex && attempt === 0,
            () => index(options, attempt + 1),
          ),
        );
      const ensureCommit = (
        options: Omit<CodeGraphIndexOptions, 'force' | 'includeOverlay'> & {readonly commit: string},
      ) =>
        Effect.gen(function* () {
          const initialIdentity = yield* resolveRepositoryIdentity(options.cwd);
          const layout = codeGraphLayout(
            path,
            options.threadnoteHome,
            initialIdentity.checkoutId,
            initialIdentity.worktreeId,
          );
          yield* withCodeGraphMaintenanceRegistration(
            options.threadnoteHome,
            Effect.gen(function* () {
              if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                return yield* Effect.fail(new Error('Code graph repository root is a symbolic link.'));
              }
              yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true, mode: 0o700});
            }),
          );
          return yield* withExclusiveFileLock(
            fs,
            layout.lockPath,
            {
              ...CODE_GRAPH_LOCK_OPTIONS,
              onContention: () =>
                (options.onProgress?.({phase: 'waiting'}) ?? Effect.void).pipe(Effect.catch(() => Effect.void)),
            },
            Effect.gen(function* () {
              if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                return yield* Effect.fail(new Error('Code graph repository root is a symbolic link.'));
              }
              if (!(yield* fs.exists(layout.repositoryRoot))) {
                return yield* Effect.fail(new RepositoryRegistrationLost());
              }
              if (yield* codeGraphMaintenanceIntentActive(options.threadnoteHome)) {
                return yield* Effect.fail(new RepositoryMaintenanceInterrupted());
              }
              return yield* store.withSession(
                layout.databasePath,
                Effect.gen(function* () {
                  yield* store.initialize(layout.databasePath);
                  const currentIdentity = yield* resolveRepositoryIdentity(options.cwd);
                  if (
                    currentIdentity.repositoryId !== initialIdentity.repositoryId ||
                    currentIdentity.worktreeId !== initialIdentity.worktreeId
                  ) {
                    return yield* Effect.fail(
                      new Error('Repository identity changed while waiting for the graph lock.'),
                    );
                  }
                  const identity = {...currentIdentity, headCommit: options.commit};
                  const activeWorktreeIds = yield* repositoryWorktreeIds(currentIdentity);
                  const cachedCommittedFileKeys = yield* cachedFileKeys(store, layout.databasePath, languagePacks);
                  const inventory = yield* inventoryRepository(identity, {
                    ...options,
                    cachedCommittedFileKeys,
                    includeOverlay: false,
                    languagePacks,
                    onContentBatch: cacheContentBatch(store, layout.databasePath, languagePacks, treeSitter),
                  });
                  const snapshot = yield* ensureCommittedBase({
                    activeWorktreeIds,
                    embedding,
                    force: false,
                    fs,
                    identity,
                    inventory,
                    languagePacks,
                    layout,
                    onProgress: options.onProgress,
                    startedAt: yield* Clock.currentTimeMillis,
                    store,
                    threadnoteHome: options.threadnoteHome,
                  });
                  const leaseToken = yield* store.acquireSnapshotLease(layout.databasePath, snapshot.id, 2 * 60_000);
                  return {leaseToken, snapshot} satisfies CodeGraphCommitLease;
                }).pipe(
                  Effect.onError(() =>
                    store.pruneCachedFacts(layout.databasePath).pipe(Effect.catch(() => Effect.void)),
                  ),
                ),
              );
            }),
          );
        }).pipe(
          Effect.provideService(CommandExecutor, command),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
        );
      return CodeGraphIndexer.of({
        ensureCommit,
        index: options => index(options),
      });
    }),
  );
}

const ensureCommittedBase = Effect.fn('codeGraph.ensureCommittedBase')(function* (input: {
  readonly activeWorktreeIds: ReadonlySet<string>;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly force: boolean;
  readonly forceGeneration?: string;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly inventory: CodeGraphInventory;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly layout: CodeGraphLayout;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly startedAt: number;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
}) {
  const cleanInventory: CodeGraphInventory = {
    committedFiles: input.inventory.committedFiles,
    committedParsedFiles: input.inventory.committedParsedFiles,
    dirty: false,
    files: input.inventory.committedFiles,
    parsedFiles: input.inventory.committedParsedFiles,
    skipped: input.inventory.skipped,
  };
  const extractorSet = extractorSetIdentity(cleanInventory.files, input.languagePacks);
  const snapshotId = forcedSnapshotIdentity(
    snapshotIdentity(input.identity, false, extractorSet, cleanInventory.files),
    input.forceGeneration,
  );
  const existing = yield* input.store.readySnapshotById(input.layout.databasePath, snapshotId);
  if (existing) return existing;
  const building: CodeGraphSnapshot = {
    commit: input.identity.headCommit,
    dirty: false,
    edgeCount: 0,
    extractorSet,
    fileCount: 0,
    id: snapshotId,
    repositoryId: input.identity.repositoryId,
    state: 'building',
    symbolCount: 0,
    worktreeId: input.identity.worktreeId,
  };
  yield* input.store.markBuilding(input.layout.databasePath, input.identity, building);
  const summary = yield* buildAndActivate({
    ...input,
    activatePointer: false,
    building,
    ensureVectors: false,
    existing: undefined,
    inventory: cleanInventory,
  }).pipe(
    Effect.catch(cause =>
      input.store
        .markFailed(input.layout.databasePath, snapshotId, messageOf(cause))
        .pipe(Effect.andThen(Effect.fail(cause))),
    ),
  );
  return summary.snapshot;
});

const buildAndActivate = Effect.fn('codeGraph.buildAndActivate')(function* (input: {
  readonly activeWorktreeIds: ReadonlySet<string>;
  readonly activatePointer: boolean;
  readonly building: CodeGraphSnapshot;
  readonly existing?: CodeGraphSnapshot;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly ensureVectors: boolean;
  readonly force: boolean;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly inventory: CodeGraphInventory;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly layout: CodeGraphLayout;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly startedAt: number;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
}) {
  const workspace = yield* input.languagePacks.discoverWorkspace(input.inventory.files);
  const attributePackages = createPackageAttributor(input.inventory.files);
  const attributeWorkspace = createWorkspaceAttributor(workspace);
  const attributeResolution = createResolutionAttributor(input.inventory.files);
  const attributeFacts = (facts: readonly CodeGraphFileFacts[]) =>
    attributeResolution(attributeWorkspace(attributePackages(facts)));
  const extractionDiagnostics: string[] = [...workspace.diagnostics];
  let materializedFiles = 0;
  const reusedFiles = input.inventory.files.length - input.inventory.parsedFiles;
  yield* input.onProgress?.({
    completed: materializedFiles,
    phase: 'materializing',
    reused: reusedFiles,
    total: input.inventory.files.length,
    unit: 'files',
  }) ?? Effect.void;
  yield* input.store.prepareActivation(input.layout.databasePath, input.inventory.files);
  for (const files of factMaterializationBatches(input.inventory.files)) {
    const cached = yield* loadCachedFacts(input.store, input.layout.databasePath, files, input.languagePacks);
    if (files.some(file => !cached.has(file.path))) {
      return yield* Effect.fail(
        new Error('A cached code graph fact disappeared during indexing; retry with a full rebuild.'),
      );
    }
    const facts = attributeFacts(files.map(file => cached.get(file.path)!));
    if (extractionDiagnostics.length < 100) {
      extractionDiagnostics.push(
        ...facts.flatMap(file => file.diagnostics).slice(0, 100 - extractionDiagnostics.length),
      );
    }
    yield* input.store.stageActivationFacts(
      input.layout.databasePath,
      uniqueById(facts.flatMap(file => file.symbols)),
      facts.flatMap(file => file.edges),
      facts.flatMap(file => file.references ?? []),
    );
    materializedFiles += files.length;
    yield* input.onProgress?.({
      completed: materializedFiles,
      phase: 'materializing',
      reused: reusedFiles,
      total: input.inventory.files.length,
      unit: 'files',
    }) ?? Effect.void;
  }
  yield* input.store.resolveStagedReferences(input.layout.databasePath);
  const stagedCounts = yield* input.store.stagedFactCounts(input.layout.databasePath);
  yield* input.onProgress?.({
    edges: stagedCounts.edges,
    phase: 'resolving',
    symbols: stagedCounts.symbols,
  }) ?? Effect.void;

  const completedAt = new Date().toISOString();
  const ready: CodeGraphSnapshot = {
    ...input.building,
    completedAt,
    edgeCount: stagedCounts.edges,
    fileCount: input.inventory.files.length,
    state: 'ready',
    symbolCount: stagedCounts.symbols,
  };
  yield* verifyIndexInput(input.identity, input.inventory, input.activatePointer);
  yield* input.onProgress?.({phase: 'activating', snapshotId: ready.id}) ?? Effect.void;
  yield* input.store.activateStaged(
    input.layout.databasePath,
    input.identity,
    ready,
    input.languagePacks.cacheIdentities,
    input.activatePointer,
  );
  yield* verifyIndexInput(input.identity, input.inventory, input.activatePointer);
  if (input.activatePointer) {
    yield* input.store.promote(input.layout.databasePath, input.identity, ready.id, input.activeWorktreeIds);
  }
  const embedding = input.ensureVectors
    ? yield* input.embedding
        .ensure(
          input.threadnoteHome,
          input.layout,
          ready,
          embeddingSymbolSource(input.store, input.layout.databasePath, ready.id),
          {
            activeWorktreeIds: input.activeWorktreeIds,
            force: input.force,
            onProgress: input.onProgress,
          },
        )
        .pipe(
          Effect.catch(cause =>
            Effect.succeed({
              embedded: 0,
              ready: false,
              reason: messageOf(cause),
              reused: 0,
            } satisfies CodeGraphEmbeddingStatus),
          ),
        )
    : ({embedded: 0, ready: true, reused: 0} satisfies CodeGraphEmbeddingStatus);
  if (input.activatePointer) {
    yield* input.fs.remove(input.layout.staleMarkerPath, {force: true}).pipe(Effect.catch(() => Effect.void));
  }
  return {
    diagnostics: [
      ...extractionDiagnostics,
      ...(embedding.ready ? [] : [`Vector graph retrieval unavailable: ${embedding.reason ?? 'unknown reason'}`]),
    ].slice(0, 100),
    durationMs: (yield* Clock.currentTimeMillis) - input.startedAt,
    identity: input.identity,
    reusedFiles: input.inventory.files.length - input.inventory.parsedFiles,
    skippedFiles: input.inventory.skipped,
    snapshot: ready,
  } satisfies CodeGraphIndexSummary;
});

function cacheContentBatch(
  store: CodeGraphStoreShape,
  databasePath: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  treeSitter: TreeSitterRuntimeShape,
) {
  return (files: Parameters<typeof extractRepositoryFileFacts>[0]) =>
    Effect.forEach(files, file => languagePacks.extractFile(file), {concurrency: 1}).pipe(
      Effect.provideService(TreeSitterRuntime, treeSitter),
      Effect.flatMap(facts => {
        const factsByPath = new Map(facts.map(file => [file.path, file]));
        return Effect.forEach(
          groupFilesByCacheIdentity(files, languagePacks),
          group =>
            store.cacheFacts(
              databasePath,
              group.files,
              group.files.map(file => factsByPath.get(file.path)!),
              group.cacheIdentity,
            ),
          {concurrency: 1, discard: true},
        );
      }),
    );
}

const verifyIndexInput = Effect.fn('codeGraph.verifyIndexInput')(function* (
  identity: RepositoryIdentity,
  inventory: CodeGraphInventory,
  verifyOverlay: boolean,
) {
  const verifiedIdentity = yield* resolveRepositoryIdentity(identity.repoRoot);
  if (
    verifiedIdentity.repositoryId !== identity.repositoryId ||
    verifiedIdentity.worktreeId !== identity.worktreeId ||
    (verifyOverlay && verifiedIdentity.headCommit !== identity.headCommit)
  ) {
    return yield* Effect.fail(new WorktreeChangedDuringIndex());
  }
  if (!verifyOverlay) return;
  const verifiedOverlay = yield* worktreeOverlayState(verifiedIdentity);
  if (verifiedOverlay.dirty !== inventory.dirty || verifiedOverlay.fingerprint !== inventory.overlayFingerprint) {
    return yield* Effect.fail(new WorktreeChangedDuringIndex());
  }
});

class WorktreeChangedDuringIndex extends Error {
  override readonly name = 'WorktreeChangedDuringIndex';

  constructor() {
    super('Worktree files changed during code graph indexing; retry the operation.');
  }
}

class RepositoryRegistrationLost extends Error {
  override readonly name = 'RepositoryRegistrationLost';
}

class RepositoryMaintenanceInterrupted extends Error {
  override readonly name = 'RepositoryMaintenanceInterrupted';

  constructor() {
    super('Code graph indexing was superseded by repair or purge; retry the operation.');
  }
}

export function extractorSetIdentity(
  files: readonly {readonly contentHash: string; readonly path: string}[],
  languagePacks: CodeGraphLanguagePackRegistryShape = BUILTIN_LANGUAGE_PACK_REGISTRY,
): string {
  const context = files
    .filter(file => languagePacks.isResolutionContext(file.path))
    .map(file => `${file.path}\0${file.contentHash}`)
    .sort()
    .join('\n');
  const activePacks = languagePacks.activeCacheIdentities(files.map(file => file.path)).join('\n');
  return sha256HexSync(
    `${CODE_GRAPH_EXTRACTOR_SET_VERSION}\nactive-language-packs:\n${activePacks}\nignore-policy:3\nresolution-context:\n${context}`,
  );
}

export function parserCacheIdentity(): string {
  const identity = BUILTIN_LANGUAGE_PACK_REGISTRY.cacheIdentityForPath('source.ts');
  return identity._tag === 'Some' ? identity.value : sha256HexSync(`${CODE_GRAPH_EXTRACTOR_SET_VERSION}:typescript`);
}

export function snapshotIdentity(
  identity: {
    readonly headCommit: string;
    readonly repositoryId: string;
    readonly worktreeId: string;
  },
  dirty: boolean,
  extractorSet: string,
  files: readonly {readonly contentHash: string; readonly path: string; readonly source: string}[],
): string {
  const inventory = files
    .map(file => `${file.path}\0${file.contentHash}\0${file.source}`)
    .sort()
    .join('\n');
  return `cgsn_${sha256HexSync(
    `snapshot-v1\n${identity.repositoryId}\n${dirty ? identity.worktreeId : 'shared-commit'}\n${identity.headCommit}\n${dirty ? 'dirty' : 'clean'}\n${extractorSet}\n${inventory}`,
  ).slice(0, 40)}`;
}

function forcedSnapshotIdentity(logicalSnapshotId: string, forceGeneration: string | undefined): string {
  return forceGeneration ? `${logicalSnapshotId}-full-${forceGeneration}` : logicalSnapshotId;
}

function embeddingSymbolSource(store: CodeGraphStoreShape, databasePath: string, snapshotId: string) {
  return {
    count: store.countEmbeddingSymbols(databasePath, snapshotId),
    loadPage: (cursor: Parameters<CodeGraphStoreShape['loadSymbolPage']>[2], limit: number) =>
      store.loadEmbeddingSymbolPage(databasePath, snapshotId, cursor, limit),
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const CODE_GRAPH_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: Number.POSITIVE_INFINITY,
} as const;

const FACT_MATERIALIZATION_BATCH_FILES = 128;
const FACT_MATERIALIZATION_BATCH_SOURCE_BYTES = 16 * 1_048_576;

function factMaterializationBatches<T extends {readonly size: number}>(
  values: readonly T[],
): readonly (readonly T[])[] {
  const output: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 0;
  for (const value of values) {
    if (
      batch.length > 0 &&
      (batch.length >= FACT_MATERIALIZATION_BATCH_FILES ||
        batchBytes + value.size > FACT_MATERIALIZATION_BATCH_SOURCE_BYTES)
    ) {
      output.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(value);
    batchBytes += value.size;
  }
  if (batch.length > 0) output.push(batch);
  return output;
}

function uniqueById<T extends {readonly id: string}>(values: readonly T[]): readonly T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    if (!unique.has(value.id)) unique.set(value.id, value);
  }
  return [...unique.values()];
}

function cachedFileKeys(
  store: CodeGraphStoreShape,
  databasePath: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): Effect.Effect<ReadonlySet<string>, unknown> {
  return Effect.forEach(
    languagePacks.cacheIdentities,
    identity => store.cachedCommittedFileKeys(databasePath, identity),
    {concurrency: 1},
  ).pipe(Effect.map(sets => new Set(sets.flatMap(set => [...set]))));
}

function loadCachedFacts(
  store: CodeGraphStoreShape,
  databasePath: string,
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): Effect.Effect<ReadonlyMap<string, CodeGraphFileFacts>, unknown> {
  return Effect.forEach(
    groupFilesByCacheIdentity(files, languagePacks),
    group => store.loadCachedFacts(databasePath, group.files, group.cacheIdentity),
    {concurrency: 1},
  ).pipe(
    Effect.map(groups => {
      const output = new Map<string, CodeGraphFileFacts>();
      for (const group of groups) {
        for (const [path, facts] of group) output.set(path, facts);
      }
      return output;
    }),
  );
}

function groupFilesByCacheIdentity<T extends {readonly path: string}>(
  files: readonly T[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): readonly {readonly cacheIdentity: string; readonly files: readonly T[]}[] {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const matched = languagePacks.cacheIdentityForPath(file.path);
    const identity = matched._tag === 'Some' ? matched.value : 'unmatched';
    const group = groups.get(identity);
    if (group) group.push(file);
    else groups.set(identity, [file]);
  }
  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cacheIdentity, groupedFiles]) => ({cacheIdentity, files: groupedFiles}));
}
