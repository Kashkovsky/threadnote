import ts from 'typescript-compiler';
import {Clock, Context, Crypto, Effect, FileSystem, Layer, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {CommandExecutor} from '../effect/command.js';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {SystemInfo} from '../effect/system.js';
import {extractRepositoryFileFacts, refreshPackageAttribution, resolveExtractedRepositoryFacts} from './extractor.js';
import {inventoryRepository, worktreeOverlayState, type CodeGraphInventoryOptions} from './inventory.js';
import {codeGraphLayout} from './layout.js';
import {codeGraphMaintenanceIntentActive, withCodeGraphMaintenanceRegistration} from './maintenance_gate.js';
import {repositoryWorktreeIds, resolveRepositoryIdentity} from './repository.js';
import {CodeGraphStore, type CodeGraphStoreShape} from './store.js';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  CodeGraphBudgetExceeded,
  DEFAULT_CODE_GRAPH_BUDGETS,
  type CodeGraphIndexSummary,
  type CodeGraphBudgets,
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
            CODE_GRAPH_LOCK_OPTIONS,
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
                  const parserCache = parserCacheIdentity();
                  const cachedCommittedFileKeys = options.force
                    ? new Set<string>()
                    : yield* store.cachedCommittedFileKeys(layout.databasePath, parserCache);
                  const inventory = yield* inventoryRepository(identity, {
                    ...options,
                    cachedCommittedFileKeys,
                    onContentBatch: cacheContentBatch(store, layout.databasePath, parserCache, options.budgets),
                  });
                  const extractorSet = extractorSetIdentity(inventory.files);
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
                      vectorCheck.state === 'ready' ? [] : yield* store.loadSymbols(layout.databasePath, existing.id);
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
                        layout,
                        onProgress: options.onProgress,
                        startedAt,
                        store,
                        threadnoteHome: options.threadnoteHome,
                        budgets: options.budgets,
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
                    layout,
                    onProgress: options.onProgress,
                    startedAt,
                    store,
                    threadnoteHome: options.threadnoteHome,
                    budgets: options.budgets,
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
            CODE_GRAPH_LOCK_OPTIONS,
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
                  const parserCache = parserCacheIdentity();
                  const cachedCommittedFileKeys = yield* store.cachedCommittedFileKeys(
                    layout.databasePath,
                    parserCache,
                  );
                  const inventory = yield* inventoryRepository(identity, {
                    ...options,
                    cachedCommittedFileKeys,
                    includeOverlay: false,
                    onContentBatch: cacheContentBatch(store, layout.databasePath, parserCache, options.budgets),
                  });
                  const snapshot = yield* ensureCommittedBase({
                    activeWorktreeIds,
                    budgets: options.budgets,
                    embedding,
                    force: false,
                    fs,
                    identity,
                    inventory,
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
  readonly budgets?: Partial<CodeGraphBudgets>;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly force: boolean;
  readonly forceGeneration?: string;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly inventory: CodeGraphInventory;
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
  const extractorSet = extractorSetIdentity(cleanInventory.files);
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
  readonly budgets?: Partial<CodeGraphBudgets>;
  readonly existing?: CodeGraphSnapshot;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly ensureVectors: boolean;
  readonly force: boolean;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly inventory: CodeGraphInventory;
  readonly layout: CodeGraphLayout;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly startedAt: number;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
}) {
  const budgets = {...DEFAULT_CODE_GRAPH_BUDGETS, ...input.budgets};
  const parserCache = parserCacheIdentity();
  const cachedCounts = yield* input.store.cachedFactCounts(
    input.layout.databasePath,
    input.inventory.files,
    parserCache,
  );
  if (cachedCounts.files !== input.inventory.files.length) {
    return yield* Effect.fail(
      new Error('A cached code graph fact disappeared during indexing; retry with a full rebuild.'),
    );
  }
  assertFactCounts(cachedCounts, budgets, 'before cache materialization');
  const cached = yield* input.store.loadCachedFacts(input.layout.databasePath, input.inventory.files, parserCache);
  if (input.inventory.files.some(file => file.content === undefined && !cached.has(file.path))) {
    return yield* Effect.fail(
      new Error('A cached code graph fact disappeared during indexing; retry with a full rebuild.'),
    );
  }
  const rawFacts = refreshPackageAttribution(
    input.inventory.files.map(file => cached.get(file.path)!),
    input.inventory.files,
  );
  assertRawFactBudgets(rawFacts, budgets);
  yield* input.onProgress?.({
    completed: input.inventory.files.length,
    phase: 'parsing',
    reused: input.inventory.files.length - input.inventory.parsedFiles,
    total: input.inventory.files.length,
  }) ?? Effect.void;
  const facts = resolveExtractedRepositoryFacts(rawFacts, input.inventory.files);
  const {edges, symbols} = collectValidatedFacts(facts, budgets);
  const extractionDiagnostics = facts.flatMap(file => file.diagnostics).slice(0, 100);
  yield* input.onProgress?.({edges: edges.length, phase: 'resolving', symbols: symbols.length}) ?? Effect.void;

  const completedAt = new Date().toISOString();
  const ready: CodeGraphSnapshot = {
    ...input.building,
    completedAt,
    edgeCount: new Set(edges.map(edge => edge.id)).size,
    fileCount: input.inventory.files.length,
    state: 'ready',
    symbolCount: new Set(symbols.map(symbol => symbol.id)).size,
  };
  yield* verifyIndexInput(input.identity, input.inventory, input.activatePointer);
  yield* input.onProgress?.({phase: 'activating', snapshotId: ready.id}) ?? Effect.void;
  yield* input.store.activate(
    input.layout.databasePath,
    input.identity,
    ready,
    input.inventory.files,
    symbols,
    edges,
    parserCache,
    input.activatePointer,
  );
  yield* verifyIndexInput(input.identity, input.inventory, input.activatePointer);
  if (input.activatePointer) {
    yield* input.store.promote(input.layout.databasePath, input.identity, ready.id, input.activeWorktreeIds);
  }
  const embedding = input.ensureVectors
    ? yield* input.embedding
        .ensure(input.threadnoteHome, input.layout, ready, symbols, {
          activeWorktreeIds: input.activeWorktreeIds,
          force: input.force,
          onProgress: input.onProgress,
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
  parserCache: string,
  budgetOverrides: Partial<CodeGraphBudgets> | undefined,
) {
  const budgets = {...DEFAULT_CODE_GRAPH_BUDGETS, ...budgetOverrides};
  const countsBySource = {
    commit: {edges: 0, symbols: 0},
    worktree: {edges: 0, symbols: 0},
  };
  return (files: Parameters<typeof extractRepositoryFileFacts>[0]) =>
    Effect.sync(() => {
      const facts = extractRepositoryFileFacts(files, undefined, budgetOverrides);
      const source = files[0]?.source ?? 'commit';
      const counts = countsBySource[source];
      counts.edges += facts.reduce((total, file) => total + file.edges.length, 0);
      counts.symbols += facts.reduce((total, file) => total + file.symbols.length, 0);
      assertFactCounts(counts, budgets, `while extracting ${source} files`);
      return facts;
    }).pipe(Effect.flatMap(facts => store.cacheFacts(databasePath, files, facts, parserCache)));
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

export function extractorSetIdentity(files: readonly {readonly contentHash: string; readonly path: string}[]): string {
  const context = files
    .filter(file => /(?:^|\/)(?:package|tsconfig)\.json$|(?:^|\/)go\.mod$/i.test(file.path))
    .map(file => `${file.path}\0${file.contentHash}`)
    .sort()
    .join('\n');
  return sha256HexSync(`parser:${parserCacheIdentity()}\nignore-policy:3\nresolution-context:\n${context}`);
}

export function parserCacheIdentity(): string {
  return sha256HexSync(`${CODE_GRAPH_EXTRACTOR_SET_VERSION}\ntypescript:${ts.version}\nparse-policy:1`);
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

function collectValidatedFacts(
  facts: readonly ReturnType<typeof extractRepositoryFileFacts>[number][],
  budgets: Pick<CodeGraphBudgets, 'maximumEdges' | 'maximumSymbols'>,
) {
  const symbols = [];
  const edges = [];
  const symbolIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const file of facts) {
    for (const symbol of file.symbols) {
      if (symbolIds.has(symbol.id)) continue;
      symbolIds.add(symbol.id);
      symbols.push(symbol);
      if (symbols.length > budgets.maximumSymbols) {
        throw new CodeGraphBudgetExceeded(`Code graph exceeds ${budgets.maximumSymbols} symbols.`);
      }
    }
    for (const edge of file.edges) {
      if (edgeIds.has(edge.id)) continue;
      edgeIds.add(edge.id);
      edges.push(edge);
      if (edges.length > budgets.maximumEdges) {
        throw new CodeGraphBudgetExceeded(`Code graph exceeds ${budgets.maximumEdges} edges.`);
      }
    }
  }
  for (const edge of edges) {
    if (edge.sourceId && !symbolIds.has(edge.sourceId)) {
      throw new Error(`Code graph edge ${edge.id} has a missing source.`);
    }
    if (edge.targetId && !symbolIds.has(edge.targetId)) {
      throw new Error(`Code graph edge ${edge.id} has a missing target.`);
    }
  }
  return {edges, symbols};
}

function assertRawFactBudgets(
  facts: readonly ReturnType<typeof extractRepositoryFileFacts>[number][],
  budgets: Pick<CodeGraphBudgets, 'maximumEdges' | 'maximumSymbols'>,
): void {
  let edges = 0;
  let symbols = 0;
  for (const file of facts) {
    edges += file.edges.length;
    symbols += file.symbols.length;
    if (symbols > budgets.maximumSymbols) {
      throw new CodeGraphBudgetExceeded(`Code graph exceeds ${budgets.maximumSymbols} raw symbols before resolution.`);
    }
    if (edges > budgets.maximumEdges) {
      throw new CodeGraphBudgetExceeded(`Code graph exceeds ${budgets.maximumEdges} raw edges before resolution.`);
    }
  }
}

function assertFactCounts(
  counts: {readonly edges: number; readonly symbols: number},
  budgets: Pick<CodeGraphBudgets, 'maximumEdges' | 'maximumSymbols'>,
  phase: string,
): void {
  if (counts.symbols > budgets.maximumSymbols) {
    throw new CodeGraphBudgetExceeded(`Code graph exceeds ${budgets.maximumSymbols} raw symbols ${phase}.`);
  }
  if (counts.edges > budgets.maximumEdges) {
    throw new CodeGraphBudgetExceeded(`Code graph exceeds ${budgets.maximumEdges} raw edges ${phase}.`);
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const CODE_GRAPH_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: 10 * 60_000,
} as const;
