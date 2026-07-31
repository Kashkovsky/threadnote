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
import {compareCodeUnits} from './ordering.js';
import {repositoryWorktreeIds, resolveRepositoryIdentity} from './repository.js';
import {CodeGraphStore, type CodeGraphStoreShape} from './store.js';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  type CodeGraphFileFacts,
  type CodeGraphIndexSummary,
  type CodeGraphInventoryFile,
  type CodeGraphOverlayFallbackReason,
  type CodeGraphProgress,
  type CodeGraphSnapshot,
  type CodeGraphSymbol,
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
import {makeCodeGraphBuildReporter} from './build_status.js';
import type {CodeGraphWorkspace} from './languages/types.js';

export interface CodeGraphIndexOptions extends CodeGraphInventoryOptions {
  readonly cwd: string;
  readonly force?: boolean;
  /** Internal benchmark/correctness escape hatch; normal indexing keeps this enabled. */
  readonly incrementalOverlay?: boolean;
  readonly threadnoteHome: string;
}

interface CommittedBaseResult {
  readonly diagnostics: readonly string[];
  readonly snapshot: CodeGraphSnapshot;
  readonly stagingReusable: boolean;
}

type IncrementalOverlayAssessment =
  | {
      readonly facts: readonly CodeGraphFileFacts[];
      readonly files: readonly CodeGraphInventoryFile[];
      readonly mode: 'eligible';
    }
  | {
      readonly mode: 'fallback';
      readonly reason: CodeGraphOverlayFallbackReason;
    };

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
      const index = (request: CodeGraphIndexOptions, attempt = 0): Effect.Effect<CodeGraphIndexSummary, unknown> =>
        Effect.scoped(
          Effect.gen(function* () {
            const initialIdentity = yield* resolveRepositoryIdentity(request.cwd);
            const layout = codeGraphLayout(
              path,
              request.threadnoteHome,
              initialIdentity.checkoutId,
              initialIdentity.worktreeId,
            );
            yield* withCodeGraphMaintenanceRegistration(
              request.threadnoteHome,
              Effect.gen(function* () {
                if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                  return yield* Effect.fail(new Error('Code graph repository root is a symbolic link.'));
                }
                yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true, mode: 0o700});
                yield* request.onProgress?.({phase: 'registering'}) ?? Effect.void;
              }),
            );
            const reporter = yield* makeCodeGraphBuildReporter(initialIdentity, layout);
            yield* Effect.forkScoped(reporter.heartbeat);
            const options: CodeGraphIndexOptions = {
              ...request,
              onProgress: progress =>
                reporter.progress(progress).pipe(Effect.andThen(request.onProgress?.(progress) ?? Effect.void)),
            };
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
                return yield* store
                  .withSession(
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
                      const logicalSnapshotId = snapshotIdentity(
                        identity,
                        inventory.dirty,
                        extractorSet,
                        inventory.files,
                      );
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
                          diagnostics.push(
                            `Vector graph retrieval unavailable: ${repaired.reason ?? 'unknown reason'}`,
                          );
                        }
                        return {
                          diagnostics,
                          durationMs: (yield* Clock.currentTimeMillis) - startedAt,
                          identity,
                          materialization: {
                            mode: 'reused-snapshot',
                            stagedFiles: 0,
                            totalFiles: inventory.files.length,
                          },
                          reusedFiles: inventory.files.length - inventory.parsedFiles,
                          skippedFiles: inventory.skipped,
                          snapshot: existing,
                        } satisfies CodeGraphIndexSummary;
                      }
                      const committedBase = inventory.dirty
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
                        baseSnapshotId: committedBase?.snapshot.id,
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
                        committedBase,
                        incrementalOverlayEnabled: options.incrementalOverlay !== false,
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
                  )
                  .pipe(
                    Effect.tap(summary => reporter.complete(summary)),
                    Effect.tapError(cause => reporter.fail(cause)),
                  );
              }),
            );
          }),
        ).pipe(
          Effect.provideService(CommandExecutor, command),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
          Effect.catchIf(
            cause => cause instanceof WorktreeChangedDuringIndex && attempt === 0,
            () => index(request, attempt + 1),
          ),
        );
      const ensureCommit = (
        request: Omit<CodeGraphIndexOptions, 'force' | 'includeOverlay'> & {readonly commit: string},
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const initialIdentity = yield* resolveRepositoryIdentity(request.cwd);
            const layout = codeGraphLayout(
              path,
              request.threadnoteHome,
              initialIdentity.checkoutId,
              initialIdentity.worktreeId,
            );
            yield* withCodeGraphMaintenanceRegistration(
              request.threadnoteHome,
              Effect.gen(function* () {
                if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                  return yield* Effect.fail(new Error('Code graph repository root is a symbolic link.'));
                }
                yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true, mode: 0o700});
              }),
            );
            const reporter = yield* makeCodeGraphBuildReporter(
              {...initialIdentity, headCommit: request.commit},
              layout,
            );
            yield* Effect.forkScoped(reporter.heartbeat);
            const options = {
              ...request,
              onProgress: (progress: CodeGraphProgress) =>
                reporter.progress(progress).pipe(Effect.andThen(request.onProgress?.(progress) ?? Effect.void)),
            };
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
                return yield* store
                  .withSession(
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
                      const committedBase = yield* ensureCommittedBase({
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
                      const snapshot = committedBase.snapshot;
                      const leaseToken = yield* store.acquireSnapshotLease(
                        layout.databasePath,
                        snapshot.id,
                        2 * 60_000,
                      );
                      return {leaseToken, snapshot} satisfies CodeGraphCommitLease;
                    }).pipe(
                      Effect.onError(() =>
                        store.pruneCachedFacts(layout.databasePath).pipe(Effect.catch(() => Effect.void)),
                      ),
                    ),
                  )
                  .pipe(
                    Effect.tap(lease => reporter.completeSnapshot(lease.snapshot)),
                    Effect.tapError(cause => reporter.fail(cause)),
                  );
              }),
            );
          }),
        ).pipe(
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
  if (existing) return {diagnostics: [], snapshot: existing, stagingReusable: false} satisfies CommittedBaseResult;
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
  return {
    diagnostics: summary.diagnostics,
    snapshot: summary.snapshot,
    stagingReusable: true,
  } satisfies CommittedBaseResult;
});

const buildAndActivate = Effect.fn('codeGraph.buildAndActivate')(function* (input: {
  readonly activeWorktreeIds: ReadonlySet<string>;
  readonly activatePointer: boolean;
  readonly building: CodeGraphSnapshot;
  readonly committedBase?: CommittedBaseResult;
  readonly existing?: CodeGraphSnapshot;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly ensureVectors: boolean;
  readonly force: boolean;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly inventory: CodeGraphInventory;
  readonly incrementalOverlayEnabled?: boolean;
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
  const incrementalAssessment = input.inventory.dirty ? yield* assessIncrementalOverlay(input, workspace) : undefined;
  let fallbackReason: CodeGraphOverlayFallbackReason | undefined =
    incrementalAssessment?.mode === 'fallback' ? incrementalAssessment.reason : undefined;
  let incrementalApplied = false;
  if (incrementalAssessment?.mode === 'eligible') {
    const incrementalReusedFiles = input.inventory.files.length - incrementalAssessment.files.length;
    yield* input.onProgress?.({
      completed: 0,
      phase: 'materializing',
      reused: incrementalReusedFiles,
      total: incrementalAssessment.files.length,
      unit: 'files',
    }) ?? Effect.void;
    incrementalApplied = yield* input.store.replaceStagedModifiedFiles(
      input.layout.databasePath,
      input.committedBase!.snapshot.id,
      incrementalAssessment.files,
      incrementalAssessment.facts,
    );
    if (incrementalApplied) {
      materializedFiles = incrementalAssessment.files.length;
      for (const diagnostic of [
        ...input.committedBase!.diagnostics,
        ...incrementalAssessment.facts.flatMap(file => file.diagnostics),
      ]) {
        if (extractionDiagnostics.length >= 100) break;
        if (!extractionDiagnostics.includes(diagnostic)) extractionDiagnostics.push(diagnostic);
      }
      yield* input.onProgress?.({
        completed: materializedFiles,
        phase: 'materializing',
        reused: incrementalReusedFiles,
        total: incrementalAssessment.files.length,
        unit: 'files',
      }) ?? Effect.void;
    } else {
      fallbackReason = 'staging-identity-mismatch';
    }
  }
  if (!incrementalApplied) {
    yield* input.onProgress?.({
      completed: materializedFiles,
      phase: 'materializing',
      reused: reusedFiles,
      total: input.inventory.files.length,
      unit: 'files',
    }) ?? Effect.void;
    yield* input.store.prepareActivation(input.layout.databasePath, input.inventory.files);
    yield* input.store.stageWorkspaceCatalog(input.layout.databasePath, workspace);
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
  }
  yield* input.onProgress?.({phase: 'resolving', subphase: 'references'}) ?? Effect.void;
  const resolution = yield* input.store.resolveStagedReferences(input.layout.databasePath);
  const stagedCounts = yield* input.store.stagedFactCounts(input.layout.databasePath);
  yield* input.onProgress?.({
    edges: stagedCounts.edges,
    phase: 'resolving',
    resolved: resolution.resolved,
    subphase: 'complete',
    symbols: stagedCounts.symbols,
  }) ?? Effect.void;

  const ready: CodeGraphSnapshot = {
    ...input.building,
    edgeCount: stagedCounts.edges,
    fileCount: input.inventory.files.length,
    state: 'ready',
    symbolCount: stagedCounts.symbols,
  };
  yield* input.onProgress?.({phase: 'activating', snapshotId: ready.id, subphase: 'validating-input'}) ?? Effect.void;
  yield* verifyIndexInput(input.identity, input.inventory, input.activatePointer);
  yield* input.onProgress?.({
    phase: 'activating',
    snapshotId: ready.id,
    subphase: 'writing-and-checkpointing',
  }) ?? Effect.void;
  yield* input.store.activateStaged(
    input.layout.databasePath,
    input.identity,
    ready,
    input.languagePacks.cacheIdentities,
    input.activatePointer,
  );
  const activatedReady = yield* input.store.readySnapshotById(input.layout.databasePath, ready.id);
  if (!activatedReady) {
    return yield* Effect.fail(new Error('Activated code graph snapshot could not be read back from its store.'));
  }
  yield* verifyIndexInput(input.identity, input.inventory, input.activatePointer);
  if (input.activatePointer) {
    yield* input.onProgress?.({phase: 'activating', snapshotId: activatedReady.id, subphase: 'promoting'}) ??
      Effect.void;
    // Progress callbacks are user-controlled effects and may yield long enough for
    // the worktree to change. Revalidate on both sides of pointer promotion so a
    // mutation observed in this window triggers the bounded retry.
    yield* verifyIndexInput(input.identity, input.inventory, input.activatePointer);
    yield* input.store.promote(input.layout.databasePath, input.identity, activatedReady.id, input.activeWorktreeIds);
    yield* verifyIndexInput(input.identity, input.inventory, input.activatePointer);
  }
  yield* input.onProgress?.({phase: 'activating', snapshotId: activatedReady.id, subphase: 'complete'}) ?? Effect.void;
  const embedding = input.ensureVectors
    ? yield* input.embedding
        .ensure(
          input.threadnoteHome,
          input.layout,
          activatedReady,
          embeddingSymbolSource(input.store, input.layout.databasePath, activatedReady.id),
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
      ...(input.inventory.dirty
        ? [
            incrementalApplied
              ? `Dirty overlay reused clean staging for ${materializedFiles.toLocaleString()} modified file(s).`
              : `Dirty overlay used full materialization: ${overlayFallbackDescription(fallbackReason ?? 'staging-unavailable')}.`,
          ]
        : []),
      ...(embedding.ready ? [] : [`Vector graph retrieval unavailable: ${embedding.reason ?? 'unknown reason'}`]),
    ].slice(0, 100),
    durationMs: (yield* Clock.currentTimeMillis) - input.startedAt,
    identity: input.identity,
    materialization: {
      ...(fallbackReason ? {fallbackReason} : {}),
      mode: incrementalApplied ? 'incremental-overlay' : 'full',
      stagedFiles: materializedFiles,
      totalFiles: input.inventory.files.length,
    },
    reusedFiles: input.inventory.files.length - input.inventory.parsedFiles,
    skippedFiles: input.inventory.skipped,
    snapshot: activatedReady,
  } satisfies CodeGraphIndexSummary;
});

const assessIncrementalOverlay = Effect.fn('codeGraph.assessIncrementalOverlay')(function* (
  input: {
    readonly building: CodeGraphSnapshot;
    readonly committedBase?: CommittedBaseResult;
    readonly force: boolean;
    readonly incrementalOverlayEnabled?: boolean;
    readonly inventory: CodeGraphInventory;
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
    readonly layout: CodeGraphLayout;
    readonly store: CodeGraphStoreShape;
  },
  workspace: CodeGraphWorkspace,
) {
  if (input.incrementalOverlayEnabled === false) {
    return {mode: 'fallback', reason: 'disabled'} satisfies IncrementalOverlayAssessment;
  }
  if (input.force) return {mode: 'fallback', reason: 'forced-full-rebuild'} satisfies IncrementalOverlayAssessment;
  if (!input.committedBase?.stagingReusable) {
    return {mode: 'fallback', reason: 'staging-unavailable'} satisfies IncrementalOverlayAssessment;
  }
  if (input.building.extractorSet !== input.committedBase.snapshot.extractorSet) {
    return {mode: 'fallback', reason: 'extractor-context-changed'} satisfies IncrementalOverlayAssessment;
  }
  const committedWorkspace = yield* input.languagePacks.discoverWorkspace(input.inventory.committedFiles);
  if (committedWorkspace.fingerprint !== workspace.fingerprint) {
    return {mode: 'fallback', reason: 'workspace-changed'} satisfies IncrementalOverlayAssessment;
  }
  const committedByPath = new Map(input.inventory.committedFiles.map(file => [file.path, file]));
  const effectiveByPath = new Map(input.inventory.files.map(file => [file.path, file]));
  if (
    committedByPath.size !== effectiveByPath.size ||
    [...committedByPath].some(([path]) => !effectiveByPath.has(path))
  ) {
    return {mode: 'fallback', reason: 'file-set-changed'} satisfies IncrementalOverlayAssessment;
  }
  const modifiedFiles = input.inventory.files.filter(file => {
    const committed = committedByPath.get(file.path)!;
    return (
      committed.contentHash !== file.contentHash ||
      committed.language !== file.language ||
      committed.mode !== file.mode ||
      committed.size !== file.size ||
      committed.source !== file.source
    );
  });
  if (modifiedFiles.length === 0) {
    return {mode: 'fallback', reason: 'no-materialized-changes'} satisfies IncrementalOverlayAssessment;
  }
  const committedFiles = modifiedFiles.map(file => committedByPath.get(file.path)!);
  const [committedCache, effectiveCache] = yield* Effect.all(
    [
      loadCachedFacts(input.store, input.layout.databasePath, committedFiles, input.languagePacks),
      loadCachedFacts(input.store, input.layout.databasePath, modifiedFiles, input.languagePacks),
    ],
    {concurrency: 1},
  );
  if (
    committedFiles.some(file => !committedCache.has(file.path)) ||
    modifiedFiles.some(file => !effectiveCache.has(file.path))
  ) {
    return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayAssessment;
  }
  const committedFacts = attributeInventoryFacts(
    input.inventory.committedFiles,
    committedWorkspace,
    committedFiles.map(file => committedCache.get(file.path)!),
  );
  const effectiveFacts = attributeInventoryFacts(
    input.inventory.files,
    workspace,
    modifiedFiles.map(file => effectiveCache.get(file.path)!),
  );
  if (hasDynamicAliases(committedFacts) || hasDynamicAliases(effectiveFacts)) {
    return {mode: 'fallback', reason: 'dynamic-aliases'} satisfies IncrementalOverlayAssessment;
  }
  const committedFactsByPath = new Map(committedFacts.map(file => [file.path, file]));
  if (
    effectiveFacts.some(file => {
      const committed = committedFactsByPath.get(file.path);
      return !committed || !hasSameCodeGraphResolutionSurface(committed.symbols, file.symbols);
    })
  ) {
    return {mode: 'fallback', reason: 'resolution-surface-changed'} satisfies IncrementalOverlayAssessment;
  }
  return {facts: effectiveFacts, files: modifiedFiles, mode: 'eligible'} satisfies IncrementalOverlayAssessment;
});

function attributeInventoryFacts(
  files: readonly CodeGraphInventoryFile[],
  workspace: CodeGraphWorkspace,
  facts: readonly CodeGraphFileFacts[],
): readonly CodeGraphFileFacts[] {
  return createResolutionAttributor(files)(createWorkspaceAttributor(workspace)(createPackageAttributor(files)(facts)));
}

function hasDynamicAliases(facts: readonly CodeGraphFileFacts[]): boolean {
  return facts.some(file => file.references?.some(reference => (reference.aliasLookupKeys?.length ?? 0) > 0) === true);
}

export function hasSameCodeGraphResolutionSurface(
  left: readonly CodeGraphSymbol[],
  right: readonly CodeGraphSymbol[],
): boolean {
  if (left.length !== right.length) return false;
  const leftById = new Map<string, string>();
  for (const symbol of left) {
    if (leftById.has(symbol.id)) return false;
    leftById.set(symbol.id, symbolResolutionSurface(symbol));
  }
  const rightIds = new Set<string>();
  for (const symbol of right) {
    if (rightIds.has(symbol.id)) return false;
    rightIds.add(symbol.id);
    if (leftById.get(symbol.id) !== symbolResolutionSurface(symbol)) return false;
  }
  return true;
}

function symbolResolutionSurface(symbol: CodeGraphSymbol): string {
  return JSON.stringify({
    arity: symbol.arity,
    exported: symbol.exported,
    id: symbol.id,
    kind: symbol.kind,
    language: symbol.language,
    lookupKeys: symbol.lookupKeys ?? [],
    name: symbol.name,
    packageName: symbol.packageName,
    path: symbol.path,
    qualifiedName: symbol.qualifiedName,
    resolutionDomain: symbol.resolutionDomain,
    resolutionScopeId: symbol.resolutionScopeId,
    signature: symbol.signature,
  });
}

function overlayFallbackDescription(reason: CodeGraphOverlayFallbackReason): string {
  switch (reason) {
    case 'cache-incomplete':
      return 'cached facts were incomplete';
    case 'disabled':
      return 'incremental overlay reuse was disabled';
    case 'dynamic-aliases':
      return 'changed files participate in dynamic alias resolution';
    case 'extractor-context-changed':
      return 'resolution context changed';
    case 'file-set-changed':
      return 'eligible files were added or deleted';
    case 'forced-full-rebuild':
      return 'a full rebuild was requested';
    case 'no-materialized-changes':
      return 'no graph-eligible file content changed';
    case 'resolution-surface-changed':
      return 'a declaration or lookup surface changed';
    case 'staging-identity-mismatch':
      return 'the reusable staging identity was not current';
    case 'staging-unavailable':
      return 'the compatible clean staging generation was unavailable';
    case 'workspace-changed':
      return 'workspace attribution changed';
  }
}

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
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([cacheIdentity, groupedFiles]) => ({cacheIdentity, files: groupedFiles}));
}
