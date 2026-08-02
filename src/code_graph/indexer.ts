import {Clock, Context, Crypto, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {CommandExecutor} from '../effect/command.js';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {SystemInfo} from '../effect/system.js';
import {withThreadnoteProcessActivity} from '../process_diagnostics.js';
import {createRepositoryFactAttributor, extractRepositoryFileFacts} from './extractor.js';
import {
  budgetCachedCodeGraphFacts,
  cachedCodeGraphFactBytes,
  CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
  finalCodeGraphFactBatches,
  serializeBoundedCodeGraphFact,
  type BoundedCodeGraphFact,
} from './fact_budget.js';
import {
  inventoryRepository,
  worktreeOverlayState,
  type CodeGraphContentBatchContext,
  type CodeGraphInventoryOptions,
} from './inventory.js';
import {
  BUILTIN_LANGUAGE_PACK_REGISTRY,
  CodeGraphLanguagePackRegistry,
  packDerivationIdentity,
  type CodeGraphLanguagePackRegistryShape,
} from './languages/registry.js';
import {codeGraphLayout, codeGraphRequestBuildLockPath, codeGraphSnapshotBuildLockPath} from './layout.js';
import {codeGraphMaintenanceIntentActive, withCodeGraphMaintenanceRegistration} from './maintenance_gate.js';
import {compareCodeUnits} from './ordering.js';
import {repositoryWorktreeIds, resolveRepositoryIdentity} from './repository.js';
import {
  CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
  CodeGraphStore,
  type CodeGraphRetiredSnapshotCleanupProgress,
  type CodeGraphReusableReexport,
  type CodeGraphReusableReexportSeed,
  type CodeGraphStagingProgress,
  type CodeGraphStoreShape,
  type CodeGraphSqliteWriterSettings,
  type CodeGraphSqliteWriterTuning,
} from './store.js';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  type CodeGraphEdge,
  type CodeGraphFileFacts,
  type CodeGraphIndexSummary,
  type CodeGraphInventoryFile,
  type CodeGraphMaterializationActivity,
  type CodeGraphMaterializationMetrics,
  type CodeGraphMaterializationRows,
  type CodeGraphOverlayFallbackReason,
  type CodeGraphProgress,
  type CodeGraphReference,
  type CodeGraphRelation,
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
import {makeCodeGraphBuildReporter, readCodeGraphBuildStatuses} from './build_status.js';
import type {CodeGraphWorkspace} from './languages/types.js';
import {CodeGraphParserPool, type CodeGraphParserPoolShape, type CodeGraphParserResult} from './parser_worker.js';

export {
  budgetCachedCodeGraphFacts,
  cachedCodeGraphFactBytes,
  cachedCodeGraphFactByteUpperBound,
  CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
  compactCachedFileRelationships,
  finalCodeGraphFactBatches,
} from './fact_budget.js';

export interface CodeGraphIndexOptions extends CodeGraphInventoryOptions {
  readonly cwd: string;
  readonly force?: boolean;
  /** Internal benchmark/correctness escape hatch; normal indexing keeps this enabled. */
  readonly incrementalOverlay?: boolean;
  /** @internal Records read-back PRAGMA values for controlled benchmark evidence. */
  readonly onSqliteWriterConfigured?: (settings: CodeGraphSqliteWriterSettings) => Effect.Effect<void, never>;
  /** @internal Benchmark-only SQLite writer candidate; normal indexing leaves this unset. */
  readonly sqliteWriterTuning?: CodeGraphSqliteWriterTuning;
  readonly threadnoteHome: string;
}

interface CommittedBaseResult {
  readonly diagnostics: readonly string[];
  readonly leaseToken: Option.Option<string>;
  readonly snapshot: CodeGraphSnapshot;
  readonly stagingReusable: boolean;
}

type IncrementalOverlayAssessment =
  | {
      readonly facts: readonly CodeGraphFileFacts[];
      readonly files: readonly CodeGraphInventoryFile[];
      readonly mode: 'eligible';
      readonly reuse: 'persisted-base' | 'staged-base';
    }
  | {
      readonly mode: 'fallback';
      readonly reason: CodeGraphOverlayFallbackReason;
    };

type IncrementalOverlayPreassessment =
  | {
      readonly committedWorkspace: CodeGraphWorkspace;
      readonly facts: readonly CodeGraphFileFacts[];
      readonly files: readonly CodeGraphInventoryFile[];
      readonly mode: 'compatible';
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
      const parserPool = yield* CodeGraphParserPool;
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
            const requestedOverlay = request.force ? undefined : yield* worktreeOverlayState(initialIdentity);
            const requestKey = requestedOverlay
              ? codeGraphBuildRequestKey(initialIdentity, requestedOverlay, languagePacks, request.incrementalOverlay)
              : undefined;
            const reporter = yield* withCodeGraphMaintenanceRegistration(
              request.threadnoteHome,
              Effect.gen(function* () {
                if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                  return yield* Effect.fail(new Error('Code graph repository root is a symbolic link.'));
                }
                yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true, mode: 0o700});
                const reporter = yield* makeCodeGraphBuildReporter(
                  initialIdentity,
                  layout,
                  requestKey ? {key: requestKey} : undefined,
                );
                yield* request.onProgress?.({phase: 'registering'}) ?? Effect.void;
                return reporter;
              }),
            );
            yield* Effect.forkScoped(reporter.heartbeat);
            const options: CodeGraphIndexOptions = {
              ...request,
              onProgress: progress =>
                reporter.progress(progress).pipe(Effect.andThen(request.onProgress?.(progress) ?? Effect.void)),
            };
            return yield* withCodeGraphProcessLock(
              fs,
              layout.lockPath,
              () =>
                (options.onProgress?.({phase: 'waiting', reason: 'repository-lock'}) ?? Effect.void).pipe(
                  Effect.catch(() => Effect.void),
                ),
              'index-repository',
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
                const build = store
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
                      if (identity.headCommit !== initialIdentity.headCommit) {
                        return yield* Effect.fail(new WorktreeChangedDuringIndex());
                      }
                      const activeWorktreeIds = yield* repositoryWorktreeIds(identity);
                      if (requestKey && requestedOverlay) {
                        const currentOverlay = yield* worktreeOverlayState(identity);
                        if (!sameOverlayState(currentOverlay, requestedOverlay)) {
                          return yield* Effect.fail(new WorktreeChangedDuringIndex());
                        }
                        const completedByOwner = yield* completedConcurrentSnapshot(
                          store,
                          layout,
                          identity,
                          currentOverlay,
                          requestKey,
                          options.incrementalOverlay === false,
                        );
                        if (completedByOwner) {
                          yield* store.retireIncompleteWorktreeSnapshots(
                            layout.databasePath,
                            identity.repositoryId,
                            identity.worktreeId,
                            new Set(),
                            retiredSnapshotCleanupReporter(options.onProgress),
                            activeWorktreeIds,
                          );
                          const analysisSummaryBackfilled = yield* prepareReadyAnalysisSummary({
                            databasePath: layout.databasePath,
                            onProgress: options.onProgress,
                            snapshotId: completedByOwner.id,
                            store,
                          });
                          yield* store.promote(layout.databasePath, identity, completedByOwner.id, activeWorktreeIds);
                          return yield* reuseReadySnapshot({
                            activeWorktreeIds,
                            analysisSummaryBackfilled,
                            analysisSummaryPrepared: true,
                            embedding,
                            identity,
                            layout,
                            onProgress: options.onProgress,
                            reusedFiles: completedByOwner.fileCount,
                            skippedFiles: 0,
                            snapshot: completedByOwner,
                            startedAt,
                            store,
                            threadnoteHome: options.threadnoteHome,
                            totalFiles: completedByOwner.fileCount,
                          });
                        }
                      }
                      const cachedCommittedFileKeys = options.force
                        ? new Set<string>()
                        : yield* cachedFileKeys(store, layout.databasePath, languagePacks);
                      const inventory = yield* inventoryRepository(identity, {
                        ...options,
                        cachedCommittedFileKeys,
                        languagePacks,
                        onContentBatch: cacheContentBatch({
                          databasePath: layout.databasePath,
                          languagePacks,
                          onProgress: options.onProgress,
                          parserPool,
                          store,
                          threadnoteHome: options.threadnoteHome,
                          treeSitter,
                        }),
                      }).pipe(Effect.ensuring(parserPool.trimIdle()));
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
                      const forcedSnapshotId = forcedSnapshotIdentity(logicalSnapshotId, forceGeneration);
                      const directSnapshotId = directFullSnapshotIdentity(logicalSnapshotId);
                      const resumedForcedBuild = options.force
                        ? yield* store.resumableForcedBuild(layout.databasePath, logicalSnapshotId)
                        : undefined;
                      const readyCandidateIds = inventory.dirty
                        ? options.incrementalOverlay === false
                          ? [directSnapshotId]
                          : [logicalSnapshotId, directSnapshotId]
                        : [logicalSnapshotId];
                      const existing = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
                      const reusableReady = !options.force
                        ? existing && readyCandidateIds.includes(existing.id)
                          ? existing
                          : yield* firstReadySnapshotById(store, layout.databasePath, readyCandidateIds)
                        : undefined;
                      // A ready candidate wins this request. Do not preserve an
                      // interrupted logical/direct sibling that cannot be used on
                      // the early-return path: a repository-sized persistent build
                      // would otherwise remain reachable forever unless the user
                      // explicitly selected that other materialization mode again.
                      const retainedSnapshotIds = reusableReady
                        ? new Set<string>()
                        : options.force
                          ? new Set([resumedForcedBuild?.id ?? forcedSnapshotId])
                          : inventory.dirty
                            ? new Set(readyCandidateIds)
                            : new Set([logicalSnapshotId]);
                      yield* store.retireIncompleteWorktreeSnapshots(
                        layout.databasePath,
                        identity.repositoryId,
                        identity.worktreeId,
                        retainedSnapshotIds,
                        retiredSnapshotCleanupReporter(options.onProgress),
                        activeWorktreeIds,
                      );
                      if (reusableReady) {
                        let analysisSummaryBackfilled = false;
                        let analysisSummaryPrepared = false;
                        if (existing?.id !== reusableReady.id) {
                          analysisSummaryBackfilled = yield* prepareReadyAnalysisSummary({
                            databasePath: layout.databasePath,
                            onProgress: options.onProgress,
                            snapshotId: reusableReady.id,
                            store,
                          });
                          analysisSummaryPrepared = true;
                          yield* store.promote(layout.databasePath, identity, reusableReady.id, activeWorktreeIds);
                        }
                        return yield* reuseReadySnapshot({
                          activeWorktreeIds,
                          analysisSummaryBackfilled,
                          analysisSummaryPrepared,
                          embedding,
                          identity,
                          layout,
                          onProgress: options.onProgress,
                          reusedFiles: inventory.files.length - inventory.parsedFiles,
                          skippedFiles: inventory.skipped,
                          snapshot: reusableReady,
                          startedAt,
                          store,
                          threadnoteHome: options.threadnoteHome,
                          totalFiles: inventory.files.length,
                        });
                      }
                      if (!inventory.dirty) {
                        return yield* buildOwnedCleanSnapshot({
                          activeWorktreeIds,
                          embedding,
                          existing,
                          fallbackSnapshotId: forcedSnapshotId,
                          force: options.force === true,
                          fs,
                          identity,
                          inventory,
                          languagePacks,
                          layout,
                          logicalSnapshotId,
                          onProgress: options.onProgress,
                          startedAt,
                          store,
                          threadnoteHome: options.threadnoteHome,
                        });
                      }
                      const canAttemptIncrementalOverlay =
                        inventory.dirty && options.incrementalOverlay !== false && options.force !== true;
                      const resumableDirectBuild =
                        inventory.dirty && !options.force
                          ? yield* store.resumableBuildById(layout.databasePath, directSnapshotId)
                          : undefined;
                      const workspace = yield* languagePacks.discoverWorkspace(inventory.files);
                      let committedBase: CommittedBaseResult | undefined;
                      let incrementalAssessment: IncrementalOverlayAssessment | undefined;
                      let incrementalPrepared = false;
                      let building: CodeGraphSnapshot;
                      let persistentOwnerToken: string | undefined;
                      if (resumedForcedBuild) {
                        building = resumedForcedBuild;
                        incrementalAssessment = {mode: 'fallback', reason: 'forced-full-rebuild'};
                        persistentOwnerToken = yield* store.claimPersistentBuild(
                          layout.databasePath,
                          identity,
                          building,
                        );
                      } else if (resumableDirectBuild) {
                        building = resumableDirectBuild;
                        incrementalAssessment = {
                          mode: 'fallback',
                          reason: options.incrementalOverlay === false ? 'disabled' : 'staging-unavailable',
                        };
                        persistentOwnerToken = yield* store.claimPersistentBuild(
                          layout.databasePath,
                          identity,
                          building,
                        );
                      } else if (!inventory.dirty && !options.force) {
                        building = {
                          commit: identity.headCommit,
                          dirty: false,
                          edgeCount: 0,
                          extractorSet,
                          fileCount: 0,
                          id: logicalSnapshotId,
                          repositoryId: identity.repositoryId,
                          state: 'building',
                          symbolCount: 0,
                          worktreeId: identity.worktreeId,
                        };
                        persistentOwnerToken = yield* store.claimPersistentBuild(
                          layout.databasePath,
                          identity,
                          building,
                        );
                      } else if (!canAttemptIncrementalOverlay) {
                        building = {
                          commit: identity.headCommit,
                          dirty: inventory.dirty,
                          edgeCount: 0,
                          extractorSet,
                          fileCount: 0,
                          id: options.force ? forcedSnapshotId : directSnapshotId,
                          overlayFingerprint: inventory.overlayFingerprint,
                          repositoryId: identity.repositoryId,
                          state: 'building',
                          symbolCount: 0,
                          worktreeId: identity.worktreeId,
                        };
                        incrementalAssessment = {
                          mode: 'fallback',
                          reason: options.force ? 'forced-full-rebuild' : 'disabled',
                        };
                        persistentOwnerToken = yield* store.claimPersistentBuild(
                          layout.databasePath,
                          identity,
                          building,
                        );
                      } else {
                        const preassessment = yield* assessIncrementalOverlayCompatibility(
                          {extractorSet, inventory, languagePacks, layout, store},
                          workspace,
                        );
                        let incrementalBuilding: CodeGraphSnapshot | undefined;
                        if (preassessment.mode === 'fallback') {
                          incrementalAssessment = preassessment;
                        } else {
                          committedBase = yield* ensureCommittedBase({
                            activeWorktreeIds,
                            embedding,
                            force: false,
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
                          });
                          incrementalBuilding = {
                            baseSnapshotId: committedBase.snapshot.id,
                            commit: identity.headCommit,
                            dirty: inventory.dirty,
                            edgeCount: 0,
                            extractorSet,
                            fileCount: 0,
                            id: logicalSnapshotId,
                            overlayFingerprint: inventory.overlayFingerprint,
                            repositoryId: identity.repositoryId,
                            state: 'building',
                            symbolCount: 0,
                            worktreeId: identity.worktreeId,
                          };
                          incrementalAssessment = yield* assessIncrementalOverlay(
                            {
                              building: incrementalBuilding,
                              committedBase,
                              force: false,
                              incrementalOverlayEnabled: true,
                              inventory,
                              languagePacks,
                              layout,
                              store,
                            },
                            workspace,
                            preassessment,
                          );
                        }
                        if (incrementalAssessment.mode === 'eligible') {
                          if (committedBase === undefined) {
                            return yield* Effect.fail(
                              new Error('Incremental code graph preparation requires a committed base snapshot.'),
                            );
                          }
                          const incrementalReusedFiles = inventory.files.length - incrementalAssessment.files.length;
                          yield* options.onProgress?.({
                            completed: 0,
                            phase: 'materializing',
                            reused: incrementalReusedFiles,
                            total: incrementalAssessment.files.length,
                            unit: 'files',
                          }) ?? Effect.void;
                          incrementalPrepared =
                            incrementalAssessment.reuse === 'persisted-base'
                              ? yield* store.preparePersistedIncrementalActivation(
                                  layout.databasePath,
                                  committedBase.snapshot.id,
                                  incrementalAssessment.files,
                                  incrementalAssessment.facts,
                                )
                              : yield* store.replaceStagedModifiedFiles(
                                  layout.databasePath,
                                  committedBase.snapshot.id,
                                  incrementalAssessment.files,
                                  incrementalAssessment.facts,
                                );
                          if (!incrementalPrepared) {
                            incrementalAssessment = {mode: 'fallback', reason: 'staging-identity-mismatch'};
                          }
                        }
                        if (incrementalPrepared && incrementalBuilding !== undefined) {
                          building = incrementalBuilding;
                          yield* store.markBuilding(layout.databasePath, identity, building);
                        } else {
                          building = {
                            commit: identity.headCommit,
                            dirty: inventory.dirty,
                            edgeCount: 0,
                            extractorSet,
                            fileCount: 0,
                            id: directSnapshotId,
                            overlayFingerprint: inventory.overlayFingerprint,
                            repositoryId: identity.repositoryId,
                            state: 'building',
                            symbolCount: 0,
                            worktreeId: identity.worktreeId,
                          };
                          committedBase = undefined;
                          persistentOwnerToken = yield* store.claimPersistentBuild(
                            layout.databasePath,
                            identity,
                            building,
                          );
                        }
                      }
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
                        incrementalAssessment,
                        incrementalOverlayEnabled: options.incrementalOverlay !== false,
                        incrementalPrepared,
                        languagePacks,
                        layout,
                        onProgress: options.onProgress,
                        persistentOwnerToken,
                        startedAt,
                        store,
                        threadnoteHome: options.threadnoteHome,
                        workspace,
                      }).pipe(
                        Effect.catch(cause =>
                          store
                            .markFailed(layout.databasePath, building.id, messageOf(cause), persistentOwnerToken)
                            .pipe(Effect.andThen(Effect.fail(cause))),
                        ),
                      );
                    }),
                    writerSessionOptions(layout, options),
                  )
                  .pipe(
                    Effect.tap(summary => reporter.complete(summary)),
                    Effect.tapError(cause => reporter.fail(cause)),
                  );
                return yield* withSharedCleanRequestGate({
                  checkoutId: initialIdentity.checkoutId,
                  effect: build,
                  fs,
                  onProgress: options.onProgress,
                  path,
                  requestKey,
                  requestedOverlay,
                  threadnoteHome: options.threadnoteHome,
                });
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
            const reporter = yield* withCodeGraphMaintenanceRegistration(
              request.threadnoteHome,
              Effect.gen(function* () {
                if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                  return yield* Effect.fail(new Error('Code graph repository root is a symbolic link.'));
                }
                yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true, mode: 0o700});
                return yield* makeCodeGraphBuildReporter({...initialIdentity, headCommit: request.commit}, layout);
              }),
            );
            yield* Effect.forkScoped(reporter.heartbeat);
            const options = {
              ...request,
              onProgress: (progress: CodeGraphProgress) =>
                reporter.progress(progress).pipe(Effect.andThen(request.onProgress?.(progress) ?? Effect.void)),
            };
            return yield* withCodeGraphProcessLock(
              fs,
              layout.lockPath,
              () =>
                (options.onProgress?.({phase: 'waiting', reason: 'repository-lock'}) ?? Effect.void).pipe(
                  Effect.catch(() => Effect.void),
                ),
              'ensure-commit',
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
                        onContentBatch: cacheContentBatch({
                          databasePath: layout.databasePath,
                          languagePacks,
                          onProgress: options.onProgress,
                          parserPool,
                          store,
                          threadnoteHome: options.threadnoteHome,
                          treeSitter,
                        }),
                      }).pipe(Effect.ensuring(parserPool.trimIdle()));
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
                    }),
                    writerSessionOptions(layout, options),
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

function withCodeGraphProcessLock<A, E, R>(
  fs: FileSystem.FileSystem,
  lockPath: string,
  onContention: () => Effect.Effect<void>,
  builderOperation: string,
  effect: Effect.Effect<A, E, R>,
) {
  return withThreadnoteProcessActivity(
    'graph-waiter',
    'repository-lock',
    withExclusiveFileLock(
      fs,
      lockPath,
      {...CODE_GRAPH_LOCK_OPTIONS, onContention},
      withThreadnoteProcessActivity('graph-builder', builderOperation, effect),
    ),
  );
}

function writerSessionOptions(layout: CodeGraphLayout, options: CodeGraphIndexOptions) {
  return {
    cleanupCompletedBuildRows: true,
    ...(options.onSqliteWriterConfigured ? {onSqliteWriterConfigured: options.onSqliteWriterConfigured} : {}),
    onWriterContention: () =>
      (options.onProgress?.({phase: 'waiting', reason: 'database-writer'}) ?? Effect.void).pipe(
        Effect.catch(() => Effect.void),
      ),
    ...(options.sqliteWriterTuning ? {sqliteWriterTuning: options.sqliteWriterTuning} : {}),
    writerLockPath: layout.databaseWriteLockPath,
  } as const;
}

function retiredSnapshotCleanupReporter(onProgress: CodeGraphIndexOptions['onProgress']) {
  return (progress: CodeGraphRetiredSnapshotCleanupProgress) =>
    (
      onProgress?.({
        completed: progress.snapshotsCompleted,
        pagesCompleted: progress.pagesCompleted,
        phase: 'reclaiming',
        rowsDeleted: progress.rowsDeleted,
        total: progress.snapshotsTotal,
        unit: 'snapshots',
      }) ?? Effect.void
    ).pipe(Effect.catch(() => Effect.void));
}

function withSharedCleanRequestGate<A, E, R>(input: {
  readonly checkoutId: string;
  readonly effect: Effect.Effect<A, E, R>;
  readonly fs: FileSystem.FileSystem;
  readonly onProgress: CodeGraphIndexOptions['onProgress'];
  readonly path: Path.Path;
  readonly requestedOverlay: {readonly dirty: boolean; readonly fingerprint?: string} | undefined;
  readonly requestKey: string | undefined;
  readonly threadnoteHome: string;
}) {
  if (!input.requestKey || input.requestedOverlay?.dirty !== false) return input.effect;
  return withExclusiveFileLock(
    input.fs,
    codeGraphRequestBuildLockPath(input.path, input.threadnoteHome, input.checkoutId, input.requestKey),
    {
      ...CODE_GRAPH_LOCK_OPTIONS,
      onContention: () =>
        (input.onProgress?.({phase: 'waiting', reason: 'request-lock'}) ?? Effect.void).pipe(
          Effect.catch(() => Effect.void),
        ),
    },
    input.effect,
  );
}

const completedConcurrentSnapshot = Effect.fn('codeGraph.completedConcurrentSnapshot')(function* (
  store: CodeGraphStoreShape,
  layout: CodeGraphLayout,
  identity: RepositoryIdentity,
  overlay: {readonly dirty: boolean; readonly fingerprint?: string},
  requestKey: string,
  requireDirectFull: boolean,
) {
  const statuses = yield* readCodeGraphBuildStatuses(layout);
  const completed = statuses.find(
    status => status.state === 'completed' && status.request?.key === requestKey && status.result?.snapshotId,
  );
  if (!completed?.result?.snapshotId) return undefined;
  const ready = yield* store.readySnapshotById(layout.databasePath, completed.result.snapshotId);
  if (
    !ready ||
    ready.commit !== identity.headCommit ||
    ready.dirty !== overlay.dirty ||
    (overlay.dirty && ready.overlayFingerprint !== overlay.fingerprint) ||
    (overlay.dirty && requireDirectFull && (ready.baseSnapshotId !== undefined || !ready.id.endsWith('-direct')))
  ) {
    return undefined;
  }
  return ready;
});

const prepareReadyAnalysisSummary = Effect.fn('codeGraph.prepareReadyAnalysisSummary')(function* (input: {
  readonly databasePath: string;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly snapshotId: string;
  readonly store: CodeGraphStoreShape;
}) {
  yield* input.onProgress?.({
    phase: 'activating',
    snapshotId: input.snapshotId,
    subphase: 'summarizing-analysis',
  }) ?? Effect.void;
  const backfilled =
    typeof input.store.ensureAnalysisSummary === 'function'
      ? yield* input.store.ensureAnalysisSummary(input.databasePath, input.snapshotId)
      : false;
  yield* input.onProgress?.({phase: 'activating', snapshotId: input.snapshotId, subphase: 'complete'}) ?? Effect.void;
  return backfilled;
});

const reuseReadySnapshot = Effect.fn('codeGraph.reuseReadySnapshot')(function* (input: {
  readonly activeWorktreeIds: ReadonlySet<string>;
  readonly analysisSummaryBackfilled?: boolean;
  readonly analysisSummaryPrepared?: boolean;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly identity: RepositoryIdentity;
  readonly layout: CodeGraphLayout;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly reusedFiles: number;
  readonly skippedFiles: number;
  readonly snapshot: CodeGraphSnapshot;
  readonly startedAt: number;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
  readonly totalFiles: number;
}) {
  const analysisSummaryBackfilled = input.analysisSummaryPrepared
    ? input.analysisSummaryBackfilled === true
    : yield* prepareReadyAnalysisSummary({
        databasePath: input.layout.databasePath,
        onProgress: input.onProgress,
        snapshotId: input.snapshot.id,
        store: input.store,
      });
  yield* input.store.reconcileWorktrees(input.layout.databasePath, input.activeWorktreeIds);
  const diagnostics: string[] = analysisSummaryBackfilled
    ? ['Built the persisted whole-graph analysis summary for this reused snapshot.']
    : [];
  const vectorCheck = yield* input.embedding
    .check(input.threadnoteHome, input.layout, input.snapshot.id)
    .pipe(Effect.catch(cause => Effect.succeed({reason: messageOf(cause), state: 'unavailable'} as const)));
  const symbols =
    vectorCheck.state === 'ready'
      ? []
      : embeddingSymbolSource(input.store, input.layout.databasePath, input.snapshot.id);
  const repaired = yield* input.embedding
    .ensure(input.threadnoteHome, input.layout, input.snapshot, symbols, {
      activeWorktreeIds: input.activeWorktreeIds,
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
    );
  if (!repaired.ready) {
    diagnostics.push(`Vector graph retrieval unavailable: ${repaired.reason ?? 'unknown reason'}`);
  }
  return {
    diagnostics,
    durationMs: (yield* Clock.currentTimeMillis) - input.startedAt,
    identity: input.identity,
    materialization: {
      mode: 'reused-snapshot',
      stagedFiles: 0,
      totalFiles: input.totalFiles,
    },
    reusedFiles: input.reusedFiles,
    skippedFiles: input.skippedFiles,
    snapshot: input.snapshot,
  } satisfies CodeGraphIndexSummary;
});

function codeGraphBuildRequestKey(
  identity: Pick<RepositoryIdentity, 'checkoutId' | 'headCommit' | 'repositoryId' | 'worktreeId'>,
  overlay: {readonly dirty: boolean; readonly fingerprint?: string},
  languagePacks: CodeGraphLanguagePackRegistryShape,
  incrementalOverlay: boolean | undefined,
): string {
  const parserIdentities = languagePacks.cacheIdentities.join('\n');
  const derivationIdentities = languagePacks.packs.map(packDerivationIdentity).sort(compareCodeUnits).join('\n');
  return sha256HexSync(
    [
      'code-graph-build-request-v2',
      CODE_GRAPH_EXTRACTOR_SET_VERSION,
      identity.repositoryId,
      identity.checkoutId,
      overlay.dirty ? identity.worktreeId : 'shared-commit',
      identity.headCommit,
      overlay.dirty ? (overlay.fingerprint ?? 'dirty-without-fingerprint') : 'clean',
      overlay.dirty && incrementalOverlay === false ? 'direct-full' : 'default',
      'ignore-policy:3',
      parserIdentities,
      derivationIdentities,
    ].join('\n'),
  );
}

function sameOverlayState(
  left: {readonly dirty: boolean; readonly fingerprint?: string},
  right: {readonly dirty: boolean; readonly fingerprint?: string},
): boolean {
  return left.dirty === right.dirty && (!left.dirty || left.fingerprint === right.fingerprint);
}

const buildOwnedCleanSnapshot = Effect.fn('codeGraph.buildOwnedCleanSnapshot')(function* (input: {
  readonly activeWorktreeIds: ReadonlySet<string>;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly existing: CodeGraphSnapshot | undefined;
  readonly fallbackSnapshotId: string;
  readonly force: boolean;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly inventory: CodeGraphInventory;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly layout: CodeGraphLayout;
  readonly logicalSnapshotId: string;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly startedAt: number;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
}) {
  return yield* withExclusiveFileLock(
    input.fs,
    codeGraphSnapshotBuildLockPath(
      yield* Path.Path,
      input.threadnoteHome,
      input.identity.checkoutId,
      input.logicalSnapshotId,
    ),
    {
      ...CODE_GRAPH_LOCK_OPTIONS,
      onContention: () =>
        (input.onProgress?.({phase: 'waiting', reason: 'snapshot-build'}) ?? Effect.void).pipe(
          Effect.catch(() => Effect.void),
        ),
    },
    Effect.gen(function* () {
      if (!input.force) {
        const ready = yield* input.store.readySnapshotById(input.layout.databasePath, input.logicalSnapshotId);
        if (ready) {
          let analysisSummaryBackfilled = false;
          let analysisSummaryPrepared = false;
          if (input.existing?.id !== ready.id) {
            analysisSummaryBackfilled = yield* prepareReadyAnalysisSummary({
              databasePath: input.layout.databasePath,
              onProgress: input.onProgress,
              snapshotId: ready.id,
              store: input.store,
            });
            analysisSummaryPrepared = true;
            yield* input.store.promote(input.layout.databasePath, input.identity, ready.id, input.activeWorktreeIds);
          }
          return yield* reuseReadySnapshot({
            activeWorktreeIds: input.activeWorktreeIds,
            analysisSummaryBackfilled,
            analysisSummaryPrepared,
            embedding: input.embedding,
            identity: input.identity,
            layout: input.layout,
            onProgress: input.onProgress,
            reusedFiles: input.inventory.files.length - input.inventory.parsedFiles,
            skippedFiles: input.inventory.skipped,
            snapshot: ready,
            startedAt: input.startedAt,
            store: input.store,
            threadnoteHome: input.threadnoteHome,
            totalFiles: input.inventory.files.length,
          });
        }
      }
      const resumed = input.force
        ? yield* input.store.resumableForcedBuild(input.layout.databasePath, input.logicalSnapshotId)
        : undefined;
      const building: CodeGraphSnapshot = resumed ?? {
        commit: input.identity.headCommit,
        dirty: false,
        edgeCount: 0,
        extractorSet: extractorSetIdentity(input.inventory.files, input.languagePacks),
        fileCount: 0,
        id: input.fallbackSnapshotId,
        repositoryId: input.identity.repositoryId,
        state: 'building',
        symbolCount: 0,
        worktreeId: input.identity.worktreeId,
      };
      const ownerToken = yield* input.store.claimPersistentBuild(input.layout.databasePath, input.identity, building);
      return yield* buildAndActivate({
        activeWorktreeIds: input.activeWorktreeIds,
        activatePointer: true,
        building,
        embedding: input.embedding,
        ensureVectors: true,
        existing: input.existing,
        force: input.force,
        fs: input.fs,
        identity: input.identity,
        inventory: input.inventory,
        languagePacks: input.languagePacks,
        layout: input.layout,
        onProgress: input.onProgress,
        persistentOwnerToken: ownerToken,
        startedAt: input.startedAt,
        store: input.store,
        threadnoteHome: input.threadnoteHome,
      }).pipe(
        Effect.catch(cause =>
          input.store
            .markFailed(input.layout.databasePath, building.id, messageOf(cause), ownerToken)
            .pipe(Effect.andThen(Effect.fail(cause))),
        ),
      );
    }),
  );
});

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
  readonly persistentOwnerToken?: string;
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
  const logicalSnapshotId = snapshotIdentity(input.identity, false, extractorSet, cleanInventory.files);
  const snapshotId = forcedSnapshotIdentity(logicalSnapshotId, input.forceGeneration);
  const existing = yield* input.store.readySnapshotById(input.layout.databasePath, snapshotId);
  if (existing) {
    const lease = yield* input.store
      .acquireSnapshotLease(input.layout.databasePath, existing.id, CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS)
      .pipe(Effect.option);
    if (Option.isSome(lease)) {
      const leaseToken = yield* Effect.acquireRelease(Effect.succeed(lease.value), token =>
        input.store.releaseSnapshotLease(input.layout.databasePath, token).pipe(Effect.catch(() => Effect.void)),
      );
      return {
        diagnostics: [],
        leaseToken: Option.some(leaseToken),
        snapshot: existing,
        stagingReusable: false,
      } satisfies CommittedBaseResult;
    }
  }
  const summary = yield* withExclusiveFileLock(
    input.fs,
    codeGraphSnapshotBuildLockPath(
      yield* Path.Path,
      input.threadnoteHome,
      input.identity.checkoutId,
      logicalSnapshotId,
    ),
    {
      ...CODE_GRAPH_LOCK_OPTIONS,
      onContention: () =>
        (input.onProgress?.({phase: 'waiting', reason: 'snapshot-build'}) ?? Effect.void).pipe(
          Effect.catch(() => Effect.void),
        ),
    },
    Effect.gen(function* () {
      if (!input.force) {
        const ready = yield* input.store.readySnapshotById(input.layout.databasePath, logicalSnapshotId);
        if (ready) {
          return {
            diagnostics: [],
            durationMs: (yield* Clock.currentTimeMillis) - input.startedAt,
            identity: input.identity,
            materialization: {mode: 'reused-snapshot', stagedFiles: 0, totalFiles: cleanInventory.files.length},
            reusedFiles: cleanInventory.files.length - cleanInventory.parsedFiles,
            skippedFiles: cleanInventory.skipped,
            snapshot: ready,
          } satisfies CodeGraphIndexSummary;
        }
      }
      const resumed = input.force
        ? yield* input.store.resumableForcedBuild(input.layout.databasePath, logicalSnapshotId)
        : undefined;
      const building: CodeGraphSnapshot = resumed ?? {
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
      const ownerToken = yield* input.store.claimPersistentBuild(input.layout.databasePath, input.identity, building);
      return yield* buildAndActivate({
        ...input,
        activatePointer: false,
        building,
        ensureVectors: false,
        existing: undefined,
        inventory: cleanInventory,
        persistentOwnerToken: ownerToken,
      }).pipe(
        Effect.catch(cause =>
          input.store
            .markFailed(input.layout.databasePath, building.id, messageOf(cause), ownerToken)
            .pipe(Effect.andThen(Effect.fail(cause))),
        ),
      );
    }),
  );
  return {
    diagnostics: summary.diagnostics,
    leaseToken: Option.none(),
    snapshot: summary.snapshot,
    // Clean builds now materialize directly into a durable `building`
    // snapshot. Dirty overlays reuse the ready persisted base instead of a
    // connection-private full staging graph.
    stagingReusable: false,
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
  readonly incrementalAssessment?: IncrementalOverlayAssessment;
  readonly incrementalOverlayEnabled?: boolean;
  readonly incrementalPrepared?: boolean;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly layout: CodeGraphLayout;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly persistentOwnerToken?: string;
  readonly startedAt: number;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
  readonly workspace?: CodeGraphWorkspace;
}) {
  const workspace = input.workspace ?? (yield* input.languagePacks.discoverWorkspace(input.inventory.files));
  const attributeFacts = createCachedCodeGraphFactsAttributor(input.inventory.files, workspace);
  const extractionDiagnostics: string[] = [...workspace.diagnostics];
  let materializedFiles = 0;
  const reusedFiles = input.inventory.files.length - input.inventory.parsedFiles;
  const incrementalAssessment =
    input.incrementalAssessment ??
    (input.inventory.dirty ? yield* assessIncrementalOverlay(input, workspace) : undefined);
  let fallbackReason: CodeGraphOverlayFallbackReason | undefined =
    incrementalAssessment?.mode === 'fallback' ? incrementalAssessment.reason : undefined;
  let incrementalApplied = false;
  if (incrementalAssessment?.mode === 'eligible') {
    const incrementalReusedFiles = input.inventory.files.length - incrementalAssessment.files.length;
    if (input.incrementalPrepared !== true) {
      yield* input.onProgress?.({
        completed: 0,
        phase: 'materializing',
        reused: incrementalReusedFiles,
        total: incrementalAssessment.files.length,
        unit: 'files',
      }) ?? Effect.void;
    }
    incrementalApplied =
      input.incrementalPrepared === true
        ? true
        : incrementalAssessment.reuse === 'persisted-base'
          ? yield* input.store.preparePersistedIncrementalActivation(
              input.layout.databasePath,
              input.committedBase!.snapshot.id,
              incrementalAssessment.files,
              incrementalAssessment.facts,
            )
          : yield* input.store.replaceStagedModifiedFiles(
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
    const sourceBytesTotal = input.inventory.files.reduce((total, file) => total + file.size, 0);
    const cachedMetadata = yield* cachedFactsMetadata(
      input.store,
      input.layout.databasePath,
      input.inventory.files,
      input.languagePacks,
    );
    if (cachedMetadata.files !== input.inventory.files.length) {
      return yield* Effect.fail(
        new Error('Cached code graph facts are incomplete during materialization planning; retry with a full rebuild.'),
      );
    }
    const batches = factMaterializationBatches(input.inventory.files, cachedMetadata.bytesByPath);
    const cachedFactBytesTotal = cachedMetadata.bytes;
    const directPersistentMaterialization = input.persistentOwnerToken !== undefined;
    const storageEstimate = estimatedMaterializationStorageBytes(
      cachedFactBytesTotal,
      sourceBytesTotal,
      directPersistentMaterialization ? 'direct-persistent' : 'temporary-staged',
      'cached-fact-bytes',
    );
    const system = yield* SystemInfo;
    const [durableAvailableBytes, temporaryAvailableBytes, durableFilesystem, temporaryFilesystem] = yield* Effect.all(
      [
        system.availableDiskBytes(input.layout.repositoryRoot).pipe(Effect.catch(() => Effect.succeed(undefined))),
        system.availableDiskBytes(system.tempDirectory).pipe(Effect.catch(() => Effect.succeed(undefined))),
        input.fs.stat(input.layout.repositoryRoot).pipe(
          Effect.map(info => info.dev),
          Effect.option,
        ),
        input.fs.stat(system.tempDirectory).pipe(
          Effect.map(info => info.dev),
          Effect.option,
        ),
      ] as const,
      {concurrency: 'unbounded'},
    );
    const filesystemsShared =
      Option.isSome(durableFilesystem) && Option.isSome(temporaryFilesystem)
        ? durableFilesystem.value === temporaryFilesystem.value
        : undefined;
    const storagePlan = materializationStoragePlan(storageEstimate, {
      durableAvailableBytes,
      filesystemsShared,
      temporaryAvailableBytes,
    });
    let batchesCompleted = 0;
    // Final attribution may expand one cached-fact batch into multiple bounded
    // write transactions. Until each source batch is decoded, this is a lower
    // bound that converges monotonically to the exact finalized receipt count.
    let batchesTotal = batches.length;
    let sourceBytesCompleted = 0;
    let loadingMilliseconds = 0;
    let attributionMilliseconds = 0;
    let transactionMilliseconds = 0;
    let cachedFactBytesCompleted = 0;
    let factsBytesCompleted = 0;
    let durableDatabaseBytes = 0;
    let durableDatabaseHighWaterBytes = 0;
    const storageAtStart = yield* materializationStorageFiles(input.fs, input.layout.databasePath);
    let durableDatabaseFileBytes = storageAtStart.databaseBytes;
    let durableDatabaseFileHighWaterBytes = storageAtStart.databaseBytes;
    const durableDatabaseStartBytes = storageAtStart.databaseBytes;
    let durableDatabaseGrowthBytes = 0;
    let durableDatabaseGrowthHighWaterBytes = 0;
    let durableFilesystemBytes = storageAtStart.totalBytes;
    let durableFilesystemHighWaterBytes = storageAtStart.totalBytes;
    let durableJournalBytes = storageAtStart.journalBytes;
    let durableJournalHighWaterBytes = storageAtStart.journalBytes;
    let durableSharedMemoryBytes = storageAtStart.sharedMemoryBytes;
    let durableSharedMemoryHighWaterBytes = storageAtStart.sharedMemoryBytes;
    let durableWalBytes = storageAtStart.walBytes;
    let durableWalHighWaterBytes = storageAtStart.walBytes;
    let lastStorageFileSampleAt = Number.NEGATIVE_INFINITY;
    let temporaryDatabaseBytes = 0;
    let temporaryDatabaseHighWaterBytes = 0;
    let materializedRows: CodeGraphMaterializationRows = {};
    const stageMilliseconds: Partial<Record<CodeGraphMaterializationActivity['stage'], number>> = {};
    const metrics = (finalFactsBytesTotal?: number): CodeGraphMaterializationMetrics => ({
      attributionMilliseconds,
      batchesCompleted,
      batchesTotal,
      cachedFactBytesCompleted,
      cachedFactBytesTotal,
      factsBytesCompleted,
      ...(finalFactsBytesTotal === undefined ? {} : {factsBytesTotal: finalFactsBytesTotal}),
      loadingMilliseconds,
      rows: materializedRows,
      sourceBytesCompleted,
      sourceBytesTotal,
      stageMilliseconds: {...stageMilliseconds},
      storage: {
        ...storagePlan,
        durableDatabaseBytes,
        durableDatabaseFileBytes,
        durableDatabaseFileHighWaterBytes,
        durableDatabaseGrowthBytes,
        durableDatabaseGrowthHighWaterBytes,
        durableDatabaseHighWaterBytes,
        durableDatabaseStartBytes,
        durableFilesystemBytes,
        durableFilesystemHighWaterBytes,
        durableJournalBytes,
        durableJournalHighWaterBytes,
        durableSharedMemoryBytes,
        durableSharedMemoryHighWaterBytes,
        durableWalBytes,
        durableWalHighWaterBytes,
        temporaryDatabaseBytes,
        temporaryDatabaseHighWaterBytes,
      },
      transactionMilliseconds,
    });
    const refreshStorageFiles = (force = false) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (!force && now - lastStorageFileSampleAt < 1_000) return;
        const current = yield* materializationStorageFiles(input.fs, input.layout.databasePath);
        durableDatabaseFileBytes = current.databaseBytes;
        durableDatabaseFileHighWaterBytes = Math.max(durableDatabaseFileHighWaterBytes, current.databaseBytes);
        durableDatabaseGrowthBytes = Math.max(0, current.databaseBytes - durableDatabaseStartBytes);
        durableDatabaseGrowthHighWaterBytes = Math.max(durableDatabaseGrowthHighWaterBytes, durableDatabaseGrowthBytes);
        durableFilesystemBytes = current.totalBytes;
        durableFilesystemHighWaterBytes = Math.max(durableFilesystemHighWaterBytes, current.totalBytes);
        durableJournalBytes = current.journalBytes;
        durableJournalHighWaterBytes = Math.max(durableJournalHighWaterBytes, current.journalBytes);
        durableSharedMemoryBytes = current.sharedMemoryBytes;
        durableSharedMemoryHighWaterBytes = Math.max(durableSharedMemoryHighWaterBytes, current.sharedMemoryBytes);
        durableWalBytes = current.walBytes;
        durableWalHighWaterBytes = Math.max(durableWalHighWaterBytes, current.walBytes);
        lastStorageFileSampleAt = now;
      });
    const storageShortfalls = materializationStorageShortfalls(storagePlan);
    if (storageShortfalls.length > 0) {
      extractionDiagnostics.push(
        `Available ${storageShortfalls.join(' and ')} disk space is below the heuristic materialization estimate; ` +
          'indexing will continue while reporting actual TEMP database usage.',
      );
    }
    yield* input.onProgress?.({
      completed: materializedFiles,
      metrics: metrics(),
      phase: 'materializing',
      reused: reusedFiles,
      total: input.inventory.files.length,
      unit: 'files',
    }) ?? Effect.void;
    yield* input.store.prepareActivation(
      input.layout.databasePath,
      input.inventory.files,
      directPersistentMaterialization ? input.building.id : undefined,
      undefined,
      input.persistentOwnerToken,
    );
    yield* input.store.stageWorkspaceCatalog(input.layout.databasePath, workspace);
    let persistentBatchCursor = 0;
    for (const files of batches) {
      const sourceBytes = files.reduce((total, file) => total + file.size, 0);
      yield* input.onProgress?.({
        activity: {
          batchCompleted: batchesCompleted,
          batchTotal: batchesTotal,
          sourceBytes,
          stage: 'loading-cache',
        },
        completed: materializedFiles,
        metrics: metrics(),
        phase: 'materializing',
        reused: reusedFiles,
        total: input.inventory.files.length,
        unit: 'files',
      }) ?? Effect.void;
      const loadingStartedAt = yield* Clock.currentTimeMillis;
      const cached = yield* loadCachedFacts(input.store, input.layout.databasePath, files, input.languagePacks);
      const batchLoadingMilliseconds = (yield* Clock.currentTimeMillis) - loadingStartedAt;
      loadingMilliseconds += batchLoadingMilliseconds;
      stageMilliseconds['loading-cache'] = loadingMilliseconds;
      if (files.some(file => !cached.facts.has(file.path))) {
        return yield* Effect.fail(
          new Error('A cached code graph fact disappeared during indexing; retry with a full rebuild.'),
        );
      }
      yield* input.onProgress?.({
        activity: {
          batchCompleted: batchesCompleted,
          batchTotal: batchesTotal,
          cachedFactBytes: cached.bytes,
          elapsedMilliseconds: batchLoadingMilliseconds,
          sourceBytes,
          stage: 'attributing',
        },
        completed: materializedFiles,
        metrics: metrics(),
        phase: 'materializing',
        reused: reusedFiles,
        total: input.inventory.files.length,
        unit: 'files',
      }) ?? Effect.void;
      const attributionStartedAt = yield* Clock.currentTimeMillis;
      const facts = attributeFacts(
        files.map(file => input.languagePacks.postprocessFile(file, cached.facts.get(file.path)!)),
      );
      const batchAttributionMilliseconds = (yield* Clock.currentTimeMillis) - attributionStartedAt;
      attributionMilliseconds += batchAttributionMilliseconds;
      stageMilliseconds.attributing = attributionMilliseconds;
      const finalBatches = finalCodeGraphFactBatches(facts);
      batchesTotal += Math.max(0, finalBatches.length - 1);
      if (extractionDiagnostics.length < 100) {
        extractionDiagnostics.push(
          ...finalBatches
            .flatMap(batch => batch.flatMap(value => value.facts.diagnostics))
            .slice(0, 100 - extractionDiagnostics.length),
        );
      }
      const filesByPath = new Map(files.map(file => [file.path, file]));
      for (let finalBatchIndex = 0; finalBatchIndex < finalBatches.length; finalBatchIndex += 1) {
        const finalBatch = finalBatches[finalBatchIndex]!;
        const finalFacts = finalBatch.map(value => value.facts);
        const batchFinalFactBytes = finalBatch.reduce((total, value) => total + value.bytes, 0);
        const batchFiles = finalFacts.map(fact => filesByPath.get(fact.path)!);
        const batchSourceBytes = batchFiles.reduce((total, file) => total + file.size, 0);
        const batchCachedFactBytes = batchFiles.reduce(
          (total, file) => total + (cached.bytesByPath.get(file.path) ?? 0),
          0,
        );
        const symbols = uniqueById(finalFacts.flatMap(file => file.symbols));
        const relationships = deduplicateMaterializationRelationships(
          finalFacts.flatMap(file => file.edges),
          finalFacts.flatMap(file => file.references ?? []),
        );
        const edges = relationships.edges;
        const references = relationships.references;
        let rows = materializationRows(symbols, edges.length, references, {
          edges: relationships.duplicateEdges,
          references: relationships.duplicateReferences,
        });
        yield* input.onProgress?.({
          activity: {
            batchCompleted: batchesCompleted,
            batchTotal: batchesTotal,
            cachedFactBytes: batchCachedFactBytes,
            elapsedMilliseconds: finalBatchIndex === 0 ? batchAttributionMilliseconds : 0,
            factsBytes: batchFinalFactBytes,
            rows,
            sourceBytes: batchSourceBytes,
            stage: 'writing-facts',
          },
          completed: materializedFiles,
          metrics: metrics(),
          phase: 'materializing',
          reused: reusedFiles,
          total: input.inventory.files.length,
          unit: 'files',
        }) ?? Effect.void;
        const transactionStartedAt = yield* Clock.currentTimeMillis;
        const persistentBatchIndex = persistentBatchCursor;
        const batchStageMilliseconds = new Map<string, number>();
        yield* input.store.stageActivationFacts(
          input.layout.databasePath,
          symbols,
          edges,
          references,
          progress => {
            if (progress.temporaryDatabaseBytes !== undefined) {
              temporaryDatabaseBytes = progress.temporaryDatabaseBytes;
              temporaryDatabaseHighWaterBytes = Math.max(
                temporaryDatabaseHighWaterBytes,
                progress.temporaryDatabaseBytes,
              );
            }
            if (progress.durableDatabaseBytes !== undefined) {
              durableDatabaseBytes = progress.durableDatabaseBytes;
              durableDatabaseHighWaterBytes = Math.max(durableDatabaseHighWaterBytes, progress.durableDatabaseBytes);
            }
            const activityStage = materializationStagingStage(progress);
            const timingKey = progress.stage === 'committed' ? 'committing' : progress.stage;
            const previousStageMilliseconds = batchStageMilliseconds.get(timingKey) ?? 0;
            const currentStageMilliseconds = progress.stageElapsedMilliseconds ?? 0;
            const stageDeltaMilliseconds = Math.max(0, currentStageMilliseconds - previousStageMilliseconds);
            batchStageMilliseconds.set(timingKey, currentStageMilliseconds);
            stageMilliseconds[activityStage] = (stageMilliseconds[activityStage] ?? 0) + stageDeltaMilliseconds;
            rows = materializationRowsWithStoreProgress(rows, progress);
            return refreshStorageFiles(progress.stage === 'committed').pipe(
              Effect.andThen(
                input.onProgress?.({
                  activity: {
                    batchCompleted: persistentBatchIndex,
                    batchTotal: batchesTotal,
                    cachedFactBytes: batchCachedFactBytes,
                    elapsedMilliseconds: progress.elapsedMilliseconds,
                    factsBytes: batchFinalFactBytes,
                    rows,
                    sourceBytes: batchSourceBytes,
                    stage: activityStage,
                    stageElapsedMilliseconds: currentStageMilliseconds,
                    transactionMilliseconds: progress.elapsedMilliseconds,
                  },
                  completed: materializedFiles,
                  metrics: metrics(),
                  phase: 'materializing',
                  reused: reusedFiles,
                  total: input.inventory.files.length,
                  unit: 'files',
                }) ?? Effect.void,
              ),
              Effect.catch(() => Effect.void),
            );
          },
          persistentBatchIndex,
        );
        const batchTransactionMilliseconds = (yield* Clock.currentTimeMillis) - transactionStartedAt;
        transactionMilliseconds += batchTransactionMilliseconds;
        materializedFiles += batchFiles.length;
        batchesCompleted += 1;
        persistentBatchCursor += 1;
        sourceBytesCompleted += batchSourceBytes;
        cachedFactBytesCompleted += batchCachedFactBytes;
        factsBytesCompleted += batchFinalFactBytes;
        materializedRows = addMaterializationRows(materializedRows, rows);
        yield* input.onProgress?.({
          activity: {
            batchCompleted: persistentBatchIndex,
            batchTotal: batchesTotal,
            cachedFactBytes: batchCachedFactBytes,
            elapsedMilliseconds:
              (finalBatchIndex === 0 ? batchLoadingMilliseconds + batchAttributionMilliseconds : 0) +
              batchTransactionMilliseconds,
            factsBytes: batchFinalFactBytes,
            rows,
            sourceBytes: batchSourceBytes,
            stage: 'committing',
            transactionMilliseconds: batchTransactionMilliseconds,
          },
          completed: materializedFiles,
          metrics: metrics(),
          phase: 'materializing',
          reused: reusedFiles,
          total: input.inventory.files.length,
          unit: 'files',
        }) ?? Effect.void;
      }
    }
    batchesTotal = persistentBatchCursor;
    if (directPersistentMaterialization) {
      yield* input.store.finalizePersistentMaterializationPlan(input.layout.databasePath, persistentBatchCursor);
    }
    yield* input.onProgress?.({
      completed: materializedFiles,
      metrics: metrics(factsBytesCompleted),
      phase: 'materializing',
      reused: reusedFiles,
      total: input.inventory.files.length,
      unit: 'files',
    }) ?? Effect.void;
  }
  yield* input.onProgress?.({phase: 'resolving', subphase: 'references'}) ?? Effect.void;
  const resolution = yield* input.store.resolveStagedReferences(input.layout.databasePath, activity =>
    (
      input.onProgress?.({
        activity,
        phase: 'resolving',
        subphase: 'references',
      }) ?? Effect.void
    ).pipe(
      Effect.catch(() => Effect.void),
      Effect.andThen(Effect.yieldNow),
    ),
  );
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
  const activatedReady = yield* Effect.gen(function* () {
    const activationLease = yield* Effect.acquireRelease(
      input.store.activateStaged(
        input.layout.databasePath,
        input.identity,
        ready,
        !ready.dirty
          ? {
              fileSetFingerprint: reusableBaseFileSetFingerprint(input.inventory.files),
              workspaceFingerprint: workspace.fingerprint,
            }
          : undefined,
        CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS,
        activity =>
          (
            input.onProgress?.({
              activity,
              phase: 'activating',
              snapshotId: ready.id,
            }) ?? Effect.void
          ).pipe(Effect.catch(() => Effect.void)),
      ),
      lease =>
        Option.match(lease, {
          onNone: () => Effect.void,
          onSome: token =>
            input.store.releaseSnapshotLease(input.layout.databasePath, token).pipe(Effect.catch(() => Effect.void)),
        }),
    );
    const activated = yield* input.store.readySnapshotById(input.layout.databasePath, ready.id);
    if (!activated) {
      return yield* Effect.fail(new Error('Activated code graph snapshot could not be read back from its store.'));
    }
    yield* verifyIndexInput(input.identity, input.inventory, input.activatePointer);
    if (input.activatePointer) {
      yield* input.onProgress?.({phase: 'activating', snapshotId: activated.id, subphase: 'promoting'}) ?? Effect.void;
      // Progress callbacks are user-controlled effects and may yield long enough for
      // the worktree to change. Revalidate on both sides of pointer promotion so a
      // mutation observed in this window triggers the bounded retry.
      yield* verifyIndexInput(input.identity, input.inventory, input.activatePointer);
      yield* input.store.promote(input.layout.databasePath, input.identity, activated.id, input.activeWorktreeIds);
      yield* verifyIndexInput(input.identity, input.inventory, input.activatePointer);
      if (Option.isSome(activationLease)) {
        yield* input.store.releaseSnapshotLease(input.layout.databasePath, activationLease.value);
      }
    }
    if (input.committedBase && Option.isSome(input.committedBase.leaseToken)) {
      yield* input.store.releaseSnapshotLease(input.layout.databasePath, input.committedBase.leaseToken.value);
    }
    yield* input.onProgress?.({phase: 'activating', snapshotId: activated.id, subphase: 'complete'}) ?? Effect.void;
    return activated;
  });
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
              ? incrementalAssessment?.mode === 'eligible' && incrementalAssessment.reuse === 'persisted-base'
                ? `Dirty overlay reused persisted clean base for ${materializedFiles.toLocaleString()} modified file(s).`
                : `Dirty overlay reused clean staging for ${materializedFiles.toLocaleString()} modified file(s).`
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
  suppliedPreassessment?: IncrementalOverlayPreassessment,
) {
  if (input.incrementalOverlayEnabled === false) {
    return {mode: 'fallback', reason: 'disabled'} satisfies IncrementalOverlayAssessment;
  }
  if (input.force) return {mode: 'fallback', reason: 'forced-full-rebuild'} satisfies IncrementalOverlayAssessment;
  const preassessment =
    suppliedPreassessment ??
    (yield* assessIncrementalOverlayCompatibility(
      {
        extractorSet: input.building.extractorSet,
        inventory: input.inventory,
        languagePacks: input.languagePacks,
        layout: input.layout,
        store: input.store,
      },
      workspace,
    ));
  if (preassessment.mode === 'fallback') return preassessment;
  if (!input.committedBase)
    return {mode: 'fallback', reason: 'staging-unavailable'} satisfies IncrementalOverlayAssessment;
  if (input.building.extractorSet !== input.committedBase.snapshot.extractorSet) {
    return {mode: 'fallback', reason: 'extractor-context-changed'} satisfies IncrementalOverlayAssessment;
  }
  let reuse: 'persisted-base' | 'staged-base' = 'staged-base';
  if (!input.committedBase.stagingReusable) {
    const receipt = yield* input.store.reusableBaseReceipt(input.layout.databasePath, input.committedBase.snapshot.id);
    if (
      !receipt ||
      receipt.formatVersion !== CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION ||
      receipt.resolutionSurfaceVersion !== 1 ||
      receipt.workspaceFingerprint !== preassessment.committedWorkspace.fingerprint ||
      receipt.fileSetFingerprint !== reusableBaseFileSetFingerprint(input.inventory.committedFiles)
    ) {
      return {mode: 'fallback', reason: 'staging-unavailable'} satisfies IncrementalOverlayAssessment;
    }
    reuse = 'persisted-base';
  }
  let reusableFacts = preassessment.facts;
  if (reuse === 'persisted-base') {
    const seeds = reusableReexportSeeds(preassessment.facts);
    if (seeds.length > 0) {
      const reexports = yield* input.store.reusableReexports(
        input.layout.databasePath,
        input.committedBase.snapshot.id,
        seeds,
      );
      if (reexports === undefined) {
        return {mode: 'fallback', reason: 'staging-unavailable'} satisfies IncrementalOverlayAssessment;
      }
      reusableFacts = enrichPersistedTypeScriptReexports(preassessment.facts, reexports);
    }
  }
  const finalBatches = finalCodeGraphFactBatches(reusableFacts);
  if (finalBatches.length !== 1) {
    return {mode: 'fallback', reason: 'fact-budget-expanded'} satisfies IncrementalOverlayAssessment;
  }
  return {
    facts: finalBatches[0]!.map(value => value.facts),
    files: preassessment.files,
    mode: 'eligible',
    reuse,
  } satisfies IncrementalOverlayAssessment;
});

const assessIncrementalOverlayCompatibility = Effect.fn('codeGraph.assessIncrementalOverlayCompatibility')(function* (
  input: {
    readonly extractorSet: string;
    readonly inventory: CodeGraphInventory;
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
    readonly layout: CodeGraphLayout;
    readonly store: CodeGraphStoreShape;
  },
  workspace: CodeGraphWorkspace,
) {
  if (input.extractorSet !== extractorSetIdentity(input.inventory.committedFiles, input.languagePacks)) {
    return {mode: 'fallback', reason: 'extractor-context-changed'} satisfies IncrementalOverlayPreassessment;
  }
  const committedWorkspace = yield* input.languagePacks.discoverWorkspace(input.inventory.committedFiles);
  if (committedWorkspace.fingerprint !== workspace.fingerprint) {
    return {mode: 'fallback', reason: 'workspace-changed'} satisfies IncrementalOverlayPreassessment;
  }
  const committedByPath = new Map(input.inventory.committedFiles.map(file => [file.path, file]));
  const effectiveByPath = new Map(input.inventory.files.map(file => [file.path, file]));
  if (
    committedByPath.size !== effectiveByPath.size ||
    [...committedByPath].some(([path]) => !effectiveByPath.has(path))
  ) {
    return {mode: 'fallback', reason: 'file-set-changed'} satisfies IncrementalOverlayPreassessment;
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
    return {mode: 'fallback', reason: 'no-materialized-changes'} satisfies IncrementalOverlayPreassessment;
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
    committedFiles.some(file => !committedCache.facts.has(file.path)) ||
    modifiedFiles.some(file => !effectiveCache.facts.has(file.path))
  ) {
    return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
  }
  const committedFacts = attributeInventoryFacts(
    input.inventory.committedFiles,
    committedWorkspace,
    committedFiles.map(file => input.languagePacks.postprocessFile(file, committedCache.facts.get(file.path)!)),
  );
  const effectiveFacts = attributeInventoryFacts(
    input.inventory.files,
    workspace,
    modifiedFiles.map(file => input.languagePacks.postprocessFile(file, effectiveCache.facts.get(file.path)!)),
  );
  if (hasDynamicAliases(committedFacts) || hasDynamicAliases(effectiveFacts)) {
    return {mode: 'fallback', reason: 'dynamic-aliases'} satisfies IncrementalOverlayPreassessment;
  }
  const committedFactsByPath = new Map(committedFacts.map(file => [file.path, file]));
  if (
    effectiveFacts.some(file => {
      const committed = committedFactsByPath.get(file.path);
      return !committed || !hasSameCodeGraphResolutionSurface(committed.symbols, file.symbols);
    })
  ) {
    return {mode: 'fallback', reason: 'resolution-surface-changed'} satisfies IncrementalOverlayPreassessment;
  }
  if (finalCodeGraphFactBatches(effectiveFacts).length !== 1) {
    return {mode: 'fallback', reason: 'fact-budget-expanded'} satisfies IncrementalOverlayPreassessment;
  }
  return {
    committedWorkspace,
    facts: effectiveFacts,
    files: modifiedFiles,
    mode: 'compatible',
  } satisfies IncrementalOverlayPreassessment;
});

function reusableReexportSeeds(facts: readonly CodeGraphFileFacts[]): readonly CodeGraphReusableReexportSeed[] {
  const seeds = facts.flatMap(file =>
    (file.references ?? []).flatMap(reference =>
      reference.resolutionDomain === 'typescript'
        ? reference.lookupTiers.flatMap(tier => tier.flatMap(parseTypeScriptPathNameLookupKey))
        : [],
    ),
  );
  return uniqueByKey(seeds, seed => `${seed.path}\0${seed.name}`);
}

function enrichPersistedTypeScriptReexports(
  facts: readonly CodeGraphFileFacts[],
  reexports: readonly CodeGraphReusableReexport[],
): readonly CodeGraphFileFacts[] {
  if (reexports.length === 0) return facts;
  const provenance = new Map<string, CodeGraphReusableReexport[]>();
  for (const reexport of reexports) {
    const key = `${reexport.sourcePath}\0${reexport.localName}`;
    const values = provenance.get(key) ?? [];
    values.push(reexport);
    provenance.set(key, values);
  }
  return facts.map(file => {
    if (!file.references) return file;
    return {
      ...file,
      references: file.references.map(reference => enrichPersistedTypeScriptReference(reference, provenance)),
    };
  });
}

function enrichPersistedTypeScriptReference(
  reference: CodeGraphReference,
  provenance: ReadonlyMap<string, readonly CodeGraphReusableReexport[]>,
): CodeGraphReference {
  if (
    reference.resolutionDomain !== 'typescript' ||
    !['calls', 'constructs', 'exports', 'extends', 'implements', 'overrides', 'references'].includes(reference.relation)
  ) {
    return reference;
  }
  const parsedTargets = uniqueByKey(
    reference.lookupTiers.flatMap(tier => tier.flatMap(parseTypeScriptPathNameLookupKey)),
    target => `${target.path}\0${target.name}`,
  );
  if (!parsedTargets.some(target => provenance.has(`${target.path}\0${target.name}`))) return reference;
  const targets = uniqueByKey(
    parsedTargets.flatMap(target => terminalPersistedReexportTargets(target, provenance)),
    target => `${target.path}\0${target.name}`,
  );
  if (targets.length === 0) return reference;
  const generated = typeScriptLookupTiersForTargets(targets, reference.relation, reference.arity);
  const nonPathKeys = reference.lookupTiers.map(tier =>
    tier.filter(key => parseTypeScriptPathNameLookupKey(key).length === 0),
  );
  const tierCount = Math.max(generated.length, nonPathKeys.length);
  return {
    ...reference,
    lookupTiers: Array.from({length: tierCount}, (_, index) => [
      ...(generated[index] ?? []),
      ...(nonPathKeys[index] ?? []),
    ]).filter(tier => tier.length > 0),
  };
}

function terminalPersistedReexportTargets(
  target: CodeGraphReusableReexportSeed,
  provenance: ReadonlyMap<string, readonly CodeGraphReusableReexport[]>,
  visited: ReadonlySet<string> = new Set(),
): readonly CodeGraphReusableReexportSeed[] {
  const key = `${target.path}\0${target.name}`;
  if (visited.has(key)) return [];
  const next = provenance.get(key) ?? [];
  if (next.length === 0) return [target];
  const nextVisited = new Set(visited);
  nextVisited.add(key);
  const terminals = next.flatMap(reexport =>
    terminalPersistedReexportTargets({name: reexport.importedName, path: reexport.targetPath}, provenance, nextVisited),
  );
  return terminals.length > 0 ? terminals : [target];
}

function typeScriptLookupTiersForTargets(
  targets: readonly CodeGraphReusableReexportSeed[],
  relation: CodeGraphRelation,
  arity?: number,
): readonly (readonly string[])[] {
  const perTarget = targets.map(target => {
    const base = `typescript:path:${encodeURIComponent(target.path)}:name:${encodeURIComponent(target.name)}`;
    return (relation === 'calls' || relation === 'constructs') && arity !== undefined
      ? [[`${base}:implementation`], [`${base}:arity:${arity}`], [base]]
      : [[`${base}:merge-canonical`], [base]];
  });
  const tierCount = Math.max(0, ...perTarget.map(tiers => tiers.length));
  return Array.from({length: tierCount}, (_, index) =>
    uniqueStrings(perTarget.flatMap(tiers => tiers[index] ?? [])),
  ).filter(tier => tier.length > 0);
}

function parseTypeScriptPathNameLookupKey(value: string): readonly CodeGraphReusableReexportSeed[] {
  const match =
    /^typescript:(?:[^:]+:)?path:([^:]+):name:([^:]+)(?::(?:arity:\d+|implementation|merge-canonical))?$/.exec(value);
  if (!match) return [];
  try {
    return [{name: decodeURIComponent(match[2]!), path: decodeURIComponent(match[1]!)}];
  } catch {
    return [];
  }
}

function uniqueByKey<A>(values: readonly A[], keyOf: (value: A) => string): readonly A[] {
  const output = new Map<string, A>();
  for (const value of values) {
    const key = keyOf(value);
    if (!output.has(key)) output.set(key, value);
  }
  return [...output.values()];
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function reusableBaseFileSetFingerprint(files: readonly CodeGraphInventoryFile[]): string {
  return sha256HexSync(
    `reusable-base-file-set-v1\n${files
      .map(file => `${file.path}\0${file.language}\0${file.mode}`)
      .sort(compareCodeUnits)
      .join('\n')}`,
  );
}

function attributeInventoryFacts(
  files: readonly CodeGraphInventoryFile[],
  workspace: CodeGraphWorkspace,
  facts: readonly CodeGraphFileFacts[],
): readonly CodeGraphFileFacts[] {
  return deriveCachedCodeGraphFacts(files, workspace, facts);
}

/**
 * Rehydrates parser-only cached facts into the current repository derivation.
 * Resolution must precede workspace scoping because raw parser references can
 * intentionally defer their lookup tiers until the whole file set is known.
 */
export function deriveCachedCodeGraphFacts(
  files: readonly CodeGraphInventoryFile[],
  workspace: CodeGraphWorkspace,
  facts: readonly CodeGraphFileFacts[],
): readonly CodeGraphFileFacts[] {
  return createCachedCodeGraphFactsAttributor(files, workspace)(facts);
}

export function createCachedCodeGraphFactsAttributor(
  files: readonly CodeGraphInventoryFile[],
  workspace: CodeGraphWorkspace,
): (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[] {
  const attributeRepositoryFacts = createRepositoryFactAttributor(files);
  const attributeWorkspace = createWorkspaceAttributor(workspace);
  return facts => attributeWorkspace(attributeRepositoryFacts(facts));
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
  // Signature, content, documentation, and spans are replaced with the changed file's facts but do not affect
  // cross-file endpoint resolution. The current resolver's complete lookup contract is serialized below.
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
    case 'fact-budget-expanded':
      return 'final attributed facts exceeded one bounded incremental transaction';
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

function cacheContentBatch(options: {
  readonly databasePath: string;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly parserPool: CodeGraphParserPoolShape;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
  readonly treeSitter: TreeSitterRuntimeShape;
}) {
  const windowSize = Math.max(1, options.parserPool.capacity * 2);
  let extractionMilliseconds = 0;
  let persistenceMilliseconds = 0;
  let readingMilliseconds = 0;
  return (files: Parameters<typeof extractRepositoryFileFacts>[0], context: CodeGraphContentBatchContext) =>
    Effect.gen(function* () {
      readingMilliseconds += context.readingMilliseconds;
      const cumulativeContext = {...context, readingMilliseconds};
      let extracted = 0;
      for (const window of chunkValues(files, windowSize)) {
        let windowCompleted = 0;
        const results = yield* Effect.forEach(
          window,
          file =>
            Effect.gen(function* () {
              yield* emitContentProgress(
                options.onProgress,
                cumulativeContext,
                {
                  batchCompleted: extracted,
                  batchTotal: files.length,
                  bytes: file.size,
                  language: file.language,
                  path: file.path,
                  stage: 'extracting',
                },
                extractionMilliseconds,
                persistenceMilliseconds,
              );
              const parsed = yield* extractParserFacts(file, options);
              const cacheFact = serializeBoundedCodeGraphFact(parsed.facts);
              const result = {
                ...parsed,
                cacheFact,
                facts: cacheFact.facts,
              } satisfies CodeGraphParserResult & {readonly cacheFact: BoundedCodeGraphFact};
              windowCompleted += 1;
              yield* emitContentProgress(
                options.onProgress,
                cumulativeContext,
                {
                  batchCompleted: extracted + windowCompleted,
                  batchTotal: files.length,
                  bytes: file.size,
                  degraded: result.degraded,
                  factsBytes: result.cacheFact.bytes,
                  language: file.language,
                  parseMilliseconds: result.parseMilliseconds,
                  path: file.path,
                  relations: result.facts.edges.length,
                  stage: 'extracting',
                  symbols: result.facts.symbols.length,
                },
                extractionMilliseconds + result.parseMilliseconds,
                persistenceMilliseconds,
              );
              return {file, result};
            }),
          {concurrency: options.parserPool.capacity},
        );
        extractionMilliseconds += results.reduce((total, result) => total + result.result.parseMilliseconds, 0);
        const resultsByPath = new Map(results.map(result => [result.file.path, result.result]));
        for (const group of groupFilesByCacheIdentity(window, options.languagePacks)) {
          const representative = group.files[0]!;
          yield* emitContentProgress(
            options.onProgress,
            cumulativeContext,
            {
              batchCompleted: extracted,
              batchTotal: files.length,
              bytes: group.files.reduce((total, file) => total + file.size, 0),
              factsBytes: group.files.reduce((total, file) => total + resultsByPath.get(file.path)!.cacheFact.bytes, 0),
              language: representative.language,
              path: representative.path,
              stage: 'persisting',
            },
            extractionMilliseconds,
            persistenceMilliseconds,
          );
          const startedAt = performance.now();
          const durableFiles = group.files.filter(file => !resultsByPath.get(file.path)!.degraded);
          const degradedFiles = group.files.filter(file => resultsByPath.get(file.path)!.degraded);
          if (durableFiles.length > 0) {
            yield* options.store.cacheFacts(
              options.databasePath,
              durableFiles,
              durableFiles.map(file => resultsByPath.get(file.path)!.cacheFact),
              group.cacheIdentity,
            );
          }
          if (degradedFiles.length > 0) {
            // The current snapshot remains usable, but the ordinary active
            // cache identity deliberately stays absent so the next build
            // retries transient worker failures without requiring --full.
            yield* options.store.cacheFacts(
              options.databasePath,
              degradedFiles,
              degradedFiles.map(file => resultsByPath.get(file.path)!.cacheFact),
              degradedParserCacheIdentity(group.cacheIdentity),
            );
          }
          const elapsed = Math.max(0, performance.now() - startedAt);
          persistenceMilliseconds += elapsed;
          extracted += group.files.length;
          yield* emitContentProgress(
            options.onProgress,
            cumulativeContext,
            {
              batchCompleted: extracted,
              batchTotal: files.length,
              bytes: group.files.reduce((total, file) => total + file.size, 0),
              factsBytes: group.files.reduce((total, file) => total + resultsByPath.get(file.path)!.cacheFact.bytes, 0),
              language: representative.language,
              path: representative.path,
              persistMilliseconds: elapsed,
              relations: group.files.reduce(
                (total, file) => total + resultsByPath.get(file.path)!.facts.edges.length,
                0,
              ),
              stage: 'persisting',
              symbols: group.files.reduce(
                (total, file) => total + resultsByPath.get(file.path)!.facts.symbols.length,
                0,
              ),
            },
            extractionMilliseconds,
            persistenceMilliseconds,
          );
        }
      }
    });
}

function extractParserFacts(
  file: CodeGraphInventoryFile,
  options: {
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
    readonly parserPool: CodeGraphParserPoolShape;
    readonly threadnoteHome: string;
    readonly treeSitter: TreeSitterRuntimeShape;
  },
): Effect.Effect<CodeGraphParserResult, unknown> {
  if (file.bytes === undefined) return options.parserPool.extract(file, options.threadnoteHome);
  return Effect.gen(function* () {
    const startedAt = performance.now();
    const facts = yield* options.languagePacks
      .extractRawFile(file)
      .pipe(Effect.provideService(TreeSitterRuntime, options.treeSitter));
    return {
      degraded: false,
      facts,
      parseMilliseconds: Math.max(0, performance.now() - startedAt),
    };
  });
}

function emitContentProgress(
  onProgress: ((progress: CodeGraphProgress) => Effect.Effect<void, unknown>) | undefined,
  context: CodeGraphContentBatchContext,
  activity: NonNullable<Extract<CodeGraphProgress, {readonly phase: 'scanning'}>['activity']>,
  extractionMilliseconds: number,
  persistenceMilliseconds: number,
) {
  return (
    onProgress?.({
      ...context.progress,
      activity,
      timings: {
        extractionMilliseconds,
        persistenceMilliseconds,
        readingMilliseconds: context.readingMilliseconds,
      },
    }) ?? Effect.void
  );
}

function chunkValues<A>(values: readonly A[], size: number): readonly (readonly A[])[] {
  const chunks: A[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function degradedParserCacheIdentity(activeIdentity: string): string {
  return sha256HexSync(`code-graph-parser-degraded-v1\n${activeIdentity}`);
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
  const paths = files.map(file => file.path);
  const activeParsers = languagePacks.activeCacheIdentities(paths).join('\n');
  const activeDerivations = languagePacks.activeDerivationIdentities(paths).join('\n');
  return sha256HexSync(
    `${CODE_GRAPH_EXTRACTOR_SET_VERSION}\nactive-parser-packs:\n${activeParsers}\nactive-derivations:\n${activeDerivations}\nignore-policy:3\nresolution-context:\n${context}`,
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

export function directFullSnapshotIdentity(logicalSnapshotId: string): string {
  if (!/^cgsn_[0-9a-f]{40}$/.test(logicalSnapshotId)) {
    throw new Error('Logical snapshot identity is invalid.');
  }
  return `${logicalSnapshotId}-direct`;
}

function forcedSnapshotIdentity(logicalSnapshotId: string, forceGeneration: string | undefined): string {
  return forceGeneration ? `${logicalSnapshotId}-full-${forceGeneration}` : logicalSnapshotId;
}

const firstReadySnapshotById = Effect.fn('codeGraph.firstReadySnapshotById')(function* (
  store: CodeGraphStoreShape,
  databasePath: string,
  snapshotIds: readonly string[],
) {
  for (const snapshotId of snapshotIds) {
    const ready = yield* store.readySnapshotById(databasePath, snapshotId);
    if (ready) return ready;
  }
  return undefined;
});

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

const CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS = 10 * 60_000;
const FACT_MATERIALIZATION_BATCH_FILES = 128;
const FACT_MATERIALIZATION_BATCH_SOURCE_BYTES = 16 * 1_048_576;
const FACT_MATERIALIZATION_BATCH_CACHED_FACT_BYTES = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM;
// Conservative, warning-only planning factors informed by beta.30's observed
// production-shaped live amplification. They cover indexed TEMP rows, the durable candidate
// plus WAL, rollback/subjournals, and one concurrent worktree/repository build.
// Actual high-water telemetry remains authoritative and should recalibrate
// these factors as retained release evidence grows.
const FACT_MATERIALIZATION_TEMP_FACT_AMPLIFICATION_HEURISTIC = 5;
const FACT_MATERIALIZATION_DURABLE_FACT_AMPLIFICATION_HEURISTIC = 5;
const FACT_MATERIALIZATION_JOURNAL_FACT_AMPLIFICATION_HEURISTIC = 3;
const FACT_MATERIALIZATION_TEMP_MINIMUM_ESTIMATE_BYTES = 512 * 1_048_576;
const FACT_MATERIALIZATION_DIRECT_TEMP_ESTIMATE_BYTES = 16 * 1_048_576;
const FACT_MATERIALIZATION_DURABLE_MINIMUM_ESTIMATE_BYTES = 512 * 1_048_576;
const FACT_MATERIALIZATION_JOURNAL_MINIMUM_ESTIMATE_BYTES = 256 * 1_048_576;

export function estimatedMaterializationStorageBytes(
  factBytes: number | undefined,
  sourceBytes: number,
  materializationMode: 'direct-persistent' | 'temporary-staged' = 'temporary-staged',
  estimateBasis: 'cached-fact-bytes' | 'final-fact-bytes' = 'cached-fact-bytes',
) {
  const basisBytes = factBytes ?? sourceBytes;
  const estimatedTemporaryDatabaseBytes =
    materializationMode === 'direct-persistent'
      ? FACT_MATERIALIZATION_DIRECT_TEMP_ESTIMATE_BYTES
      : Math.max(
          FACT_MATERIALIZATION_TEMP_MINIMUM_ESTIMATE_BYTES,
          saturatingMultiply(basisBytes, FACT_MATERIALIZATION_TEMP_FACT_AMPLIFICATION_HEURISTIC),
        );
  const estimatedDurableSnapshotBytes = Math.max(
    FACT_MATERIALIZATION_DURABLE_MINIMUM_ESTIMATE_BYTES,
    saturatingMultiply(basisBytes, FACT_MATERIALIZATION_DURABLE_FACT_AMPLIFICATION_HEURISTIC),
  );
  const estimatedJournalBytes = Math.max(
    FACT_MATERIALIZATION_JOURNAL_MINIMUM_ESTIMATE_BYTES,
    saturatingMultiply(basisBytes, FACT_MATERIALIZATION_JOURNAL_FACT_AMPLIFICATION_HEURISTIC),
  );
  const estimatedConcurrentBuildBytes = saturatingAdd(
    estimatedTemporaryDatabaseBytes,
    estimatedDurableSnapshotBytes,
    estimatedJournalBytes,
  );
  return {
    estimateBasis: factBytes === undefined ? ('source-bytes-fallback' as const) : estimateBasis,
    estimatedConcurrentBuildBytes,
    estimatedDurableSnapshotBytes,
    estimatedJournalBytes,
    estimatedRequiredBytes: saturatingAdd(estimatedConcurrentBuildBytes, estimatedConcurrentBuildBytes),
    estimatedTemporaryDatabaseBytes,
    materializationMode,
  };
}

export interface MaterializationStorageAvailability {
  readonly durableAvailableBytes?: number;
  readonly filesystemsShared?: boolean;
  readonly temporaryAvailableBytes?: number;
}

export type MaterializationStoragePlan = ReturnType<typeof estimatedMaterializationStorageBytes> &
  MaterializationStorageAvailability & {
    readonly availableBytes?: number;
    readonly estimatedDurableFilesystemRequiredBytes: number;
    readonly estimatedTemporaryFilesystemRequiredBytes: number;
  };

/**
 * Plans warning-only materialization headroom for SQLite's durable and TEMP
 * filesystems. A second complete allowance covers one concurrent worktree or
 * repository build without imposing a repository-size rejection.
 */
export function materializationStoragePlan(
  estimate: ReturnType<typeof estimatedMaterializationStorageBytes>,
  availability: MaterializationStorageAvailability,
): MaterializationStoragePlan {
  const estimatedDurableFilesystemRequiredBytes = saturatingMultiply(
    estimate.materializationMode === 'direct-persistent'
      ? saturatingAdd(estimate.estimatedDurableSnapshotBytes, estimate.estimatedJournalBytes)
      : estimate.estimatedDurableSnapshotBytes,
    2,
  );
  const estimatedTemporaryFilesystemRequiredBytes = saturatingMultiply(
    estimate.materializationMode === 'direct-persistent'
      ? estimate.estimatedTemporaryDatabaseBytes
      : saturatingAdd(estimate.estimatedTemporaryDatabaseBytes, estimate.estimatedJournalBytes),
    2,
  );
  const sharedAvailableBytes =
    availability.filesystemsShared === true
      ? minimumDefined(availability.durableAvailableBytes, availability.temporaryAvailableBytes)
      : undefined;
  return {
    ...estimate,
    ...availability,
    ...(sharedAvailableBytes === undefined ? {} : {availableBytes: sharedAvailableBytes}),
    estimatedDurableFilesystemRequiredBytes,
    estimatedTemporaryFilesystemRequiredBytes,
  };
}

export function materializationStorageShortfalls(storage: {
  readonly availableBytes?: number;
  readonly durableAvailableBytes?: number;
  readonly estimatedDurableFilesystemRequiredBytes?: number;
  readonly estimatedRequiredBytes?: number;
  readonly estimatedTemporaryFilesystemRequiredBytes?: number;
  readonly filesystemsShared?: boolean;
  readonly temporaryAvailableBytes?: number;
}): readonly ('durable' | 'shared' | 'temporary')[] {
  if (storage.filesystemsShared === true) {
    return storage.availableBytes !== undefined &&
      storage.estimatedRequiredBytes !== undefined &&
      storage.availableBytes < storage.estimatedRequiredBytes
      ? ['shared']
      : [];
  }
  const shortfalls: ('durable' | 'temporary')[] = [];
  if (
    storage.durableAvailableBytes !== undefined &&
    storage.estimatedDurableFilesystemRequiredBytes !== undefined &&
    storage.durableAvailableBytes < storage.estimatedDurableFilesystemRequiredBytes
  ) {
    shortfalls.push('durable');
  }
  if (
    storage.temporaryAvailableBytes !== undefined &&
    storage.estimatedTemporaryFilesystemRequiredBytes !== undefined &&
    storage.temporaryAvailableBytes < storage.estimatedTemporaryFilesystemRequiredBytes
  ) {
    shortfalls.push('temporary');
  }
  return shortfalls;
}

function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function saturatingMultiply(value: number, multiplier: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value * multiplier);
}

function saturatingAdd(...values: readonly number[]): number {
  return values.reduce((total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + value), 0);
}

export function factMaterializationBatches<T extends {readonly path: string; readonly size: number}>(
  values: readonly T[],
  cachedFactBytesByPath: ReadonlyMap<string, number> = new Map(),
): readonly (readonly T[])[] {
  const output: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 0;
  let batchFactBytes = 0;
  for (const value of values) {
    // Current-version cache writes and materialization reads both apply the
    // same per-file compactor. Clamp defensive metadata from an unexpected
    // legacy/corrupt row to that in-memory materialization ceiling, so there
    // is no oversized-singleton exception in the batch planner.
    const factBytes = Math.min(
      CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
      Math.max(0, cachedFactBytesByPath.get(value.path) ?? 0),
    );
    if (
      batch.length > 0 &&
      (batch.length >= FACT_MATERIALIZATION_BATCH_FILES ||
        batchBytes + value.size > FACT_MATERIALIZATION_BATCH_SOURCE_BYTES ||
        batchFactBytes + factBytes > FACT_MATERIALIZATION_BATCH_CACHED_FACT_BYTES)
    ) {
      output.push(batch);
      batch = [];
      batchBytes = 0;
      batchFactBytes = 0;
    }
    batch.push(value);
    batchBytes += value.size;
    batchFactBytes += factBytes;
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

/**
 * Extraction may encounter the same relationship repeatedly at one call site
 * or through overlapping language-pack derivations. The storage layer keeps
 * strict INSERT semantics; collapse those logical duplicates deterministically
 * before they reach its primary-key boundary.
 */
export function deduplicateMaterializationRelationships(
  edges: readonly CodeGraphEdge[],
  references: readonly CodeGraphReference[],
): {
  readonly duplicateEdges: number;
  readonly duplicateReferences: number;
  readonly edges: readonly CodeGraphEdge[];
  readonly references: readonly CodeGraphReference[];
} {
  const edgeById = new Map<string, CodeGraphEdge>();
  for (const edge of edges) {
    if (!edgeById.has(edge.id)) edgeById.set(edge.id, edge);
  }
  const referenceByEdgeId = new Map<string, CodeGraphReference>();
  for (const reference of references) {
    // Reference attribution has historically been last-wins for one logical
    // edge. Preserve that contract for older, uncompacted cache rows while
    // edges retain their first stable evidence occurrence.
    referenceByEdgeId.set(reference.edgeId, reference);
  }
  return {
    duplicateEdges: edges.length - edgeById.size,
    duplicateReferences: references.length - referenceByEdgeId.size,
    edges: [...edgeById.values()],
    references: [...referenceByEdgeId.values()],
  };
}

function materializationRows(
  symbols: readonly CodeGraphSymbol[],
  edges: number,
  references: readonly CodeGraphReference[],
  deduplicated: {readonly edges: number; readonly references: number},
): CodeGraphMaterializationRows {
  return {
    deduplicatedEdges: deduplicated.edges,
    deduplicatedReferences: deduplicated.references,
    edges,
    lookupKeys: symbols.reduce((total, symbol) => total + (symbol.lookupKeys?.length ?? 0), 0),
    referenceCandidates: references.reduce(
      (total, reference) => total + reference.lookupTiers.reduce((tierTotal, tier) => tierTotal + tier.length, 0),
      0,
    ),
    references: references.length,
    symbols: symbols.length,
  };
}

export function addMaterializationRows(
  left: CodeGraphMaterializationRows,
  right: CodeGraphMaterializationRows,
): CodeGraphMaterializationRows {
  return {
    deduplicatedEdges: (left.deduplicatedEdges ?? 0) + (right.deduplicatedEdges ?? 0),
    deduplicatedReferences: (left.deduplicatedReferences ?? 0) + (right.deduplicatedReferences ?? 0),
    edges: (left.edges ?? 0) + (right.edges ?? 0),
    lookupKeys: (left.lookupKeys ?? 0) + (right.lookupKeys ?? 0),
    referenceCandidates: (left.referenceCandidates ?? 0) + (right.referenceCandidates ?? 0),
    references: (left.references ?? 0) + (right.references ?? 0),
    reexports: (left.reexports ?? 0) + (right.reexports ?? 0),
    symbols: (left.symbols ?? 0) + (right.symbols ?? 0),
    terms: (left.terms ?? 0) + (right.terms ?? 0),
  };
}

export function materializationRowsWithStoreProgress(
  rows: CodeGraphMaterializationRows,
  progress: CodeGraphStagingProgress,
): CodeGraphMaterializationRows {
  // Store observers emit a zero-row stage boundary before the first bounded
  // statement. Keep the batch estimate at that boundary; replacing it with
  // zero made the CLI claim that a non-empty batch contained no symbols or
  // lookup keys. Positive observations monotonically replace estimates with
  // the rows actually accepted by SQLite.
  if (progress.rowsCompleted === 0) return rows;
  switch (progress.stage) {
    case 'symbols':
      return {...rows, symbols: progress.rowsCompleted};
    case 'lookup-keys':
      return {...rows, lookupKeys: progress.rowsCompleted};
    case 'terms':
      return {...rows, terms: progress.rowsCompleted};
    case 'edges':
      return {...rows, edges: progress.rowsCompleted};
    case 'references':
      return {...rows, references: progress.rowsCompleted};
    case 'reference-candidates':
      return {...rows, referenceCandidates: progress.rowsCompleted};
    case 'reexports':
      return {...rows, reexports: progress.rowsCompleted};
    case 'analysis':
    case 'receipt':
    case 'validating':
    case 'committing':
    case 'committed':
      return rows;
  }
}

interface MaterializationStorageFiles {
  readonly databaseBytes: number;
  readonly journalBytes: number;
  readonly sharedMemoryBytes: number;
  readonly totalBytes: number;
  readonly walBytes: number;
}

function materializationStorageFiles(
  fs: FileSystem.FileSystem,
  databasePath: string,
): Effect.Effect<MaterializationStorageFiles, never> {
  const bytes = (file: string) =>
    fs.stat(file).pipe(
      Effect.map(info => Math.min(Number(info.size), Number.MAX_SAFE_INTEGER)),
      Effect.catch(() => Effect.succeed(0)),
    );
  return Effect.all(
    [bytes(databasePath), bytes(`${databasePath}-journal`), bytes(`${databasePath}-shm`), bytes(`${databasePath}-wal`)],
    {concurrency: 4},
  ).pipe(
    Effect.map(([databaseBytes, journalBytes, sharedMemoryBytes, walBytes]) => ({
      databaseBytes,
      journalBytes,
      sharedMemoryBytes,
      totalBytes: databaseBytes + journalBytes + sharedMemoryBytes + walBytes,
      walBytes,
    })),
  );
}

function materializationStagingStage(
  progress: CodeGraphStagingProgress,
): NonNullable<Extract<CodeGraphProgress, {readonly phase: 'materializing'}>['activity']>['stage'] {
  switch (progress.stage) {
    case 'validating':
      return 'preparing-rows';
    case 'symbols':
      return 'writing-symbols';
    case 'lookup-keys':
      return 'writing-lookups';
    case 'terms':
      return 'writing-terms';
    case 'edges':
      return 'writing-edges';
    case 'reference-candidates':
      return 'writing-candidates';
    case 'references':
    case 'reexports':
      return 'writing-references';
    case 'analysis':
      return 'writing-analysis';
    case 'receipt':
      return 'writing-receipt';
    case 'committing':
    case 'committed':
      return 'committing';
  }
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
): Effect.Effect<
  {
    readonly bytes: number;
    readonly bytesByPath: ReadonlyMap<string, number>;
    readonly facts: ReadonlyMap<string, CodeGraphFileFacts>;
  },
  unknown
> {
  return Effect.forEach(
    groupFilesByCacheIdentity(files, languagePacks),
    group =>
      Effect.gen(function* () {
        const active = yield* store.loadCachedFacts(databasePath, group.files, group.cacheIdentity);
        const missing = group.files.filter(file => !active.facts.has(file.path));
        if (missing.length === 0) return active;
        const degraded = yield* store.loadCachedFacts(
          databasePath,
          missing,
          degradedParserCacheIdentity(group.cacheIdentity),
        );
        return {
          bytes: active.bytes + degraded.bytes,
          bytesByPath: new Map([...(active.bytesByPath ?? []), ...(degraded.bytesByPath ?? [])]),
          facts: new Map([...active.facts, ...degraded.facts]),
        };
      }),
    {concurrency: 1},
  ).pipe(
    Effect.map(groups => {
      const output = new Map<string, CodeGraphFileFacts>();
      const bytesByPath = new Map<string, number>();
      let bytes = 0;
      for (const group of groups) {
        for (const [path, facts] of group.facts) {
          const persistedBytes = group.bytesByPath?.get(path);
          if (persistedBytes !== undefined && persistedBytes <= CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM) {
            output.set(path, facts);
            bytesByPath.set(path, persistedBytes);
            bytes += persistedBytes;
            continue;
          }
          const budgeted = budgetCachedCodeGraphFacts(facts);
          const budgetedBytes = cachedCodeGraphFactBytes(budgeted);
          output.set(path, budgeted);
          bytesByPath.set(path, budgetedBytes);
          bytes += budgetedBytes;
        }
      }
      return {bytes, bytesByPath, facts: output};
    }),
  );
}

function cachedFactsMetadata(
  store: CodeGraphStoreShape,
  databasePath: string,
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): Effect.Effect<
  {readonly bytes: number; readonly bytesByPath: ReadonlyMap<string, number>; readonly files: number},
  unknown
> {
  return Effect.forEach(
    groupFilesByCacheIdentity(files, languagePacks),
    group =>
      Effect.gen(function* () {
        const active = yield* store.loadCachedFacts(databasePath, group.files, group.cacheIdentity, {decode: false});
        const activeKeys = active.keys ?? new Set(active.facts.keys());
        const missing = group.files.filter(file => !activeKeys.has(file.path));
        if (missing.length === 0)
          return {bytes: active.bytes, bytesByPath: active.bytesByPath ?? new Map(), keys: activeKeys};
        const degraded = yield* store.loadCachedFacts(
          databasePath,
          missing,
          degradedParserCacheIdentity(group.cacheIdentity),
          {decode: false},
        );
        const degradedKeys = degraded.keys ?? new Set(degraded.facts.keys());
        return {
          bytes: active.bytes + degraded.bytes,
          bytesByPath: new Map([...(active.bytesByPath ?? []), ...(degraded.bytesByPath ?? [])]),
          keys: new Set([...activeKeys, ...degradedKeys]),
        };
      }),
    {concurrency: 1},
  ).pipe(
    Effect.map(groups => {
      const bytesByPath = new Map(
        groups
          .flatMap(group => [...group.bytesByPath])
          .map(([path, bytes]) => [path, Math.min(bytes, CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM)] as const),
      );
      return {
        bytes: [...bytesByPath.values()].reduce((total, bytes) => total + bytes, 0),
        bytesByPath,
        files: new Set(groups.flatMap(group => [...group.keys])).size,
      };
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
