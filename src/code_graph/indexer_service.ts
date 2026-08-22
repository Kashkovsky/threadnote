import {Clock, Context, Crypto, Effect, Exit, FileSystem, Layer, Option, Path} from 'effect';
import {CommandExecutor} from '../effect/command.js';
import {SystemInfo} from '../effect/system.js';
import {makeCodeGraphBuildReporter} from './build_status.js';
import {CODE_GRAPH_BUILDER_ADMISSION_CLASS_ENV, withCodeGraphBuilderAdmission} from './builder_admission.js';
import {isCodeGraphCapacityPause} from './disk_capacity.js';
import {CodeGraphEmbeddingIndex} from './embedding.js';
import {
  attemptReusableDirtyBase,
  buildAndActivate,
  buildOwnedCleanSnapshot,
  codeGraphBuildRequestKey,
  completedConcurrentSnapshot,
  ensureCommittedBase,
  retiredSnapshotCleanupReporter,
  reuseReadySnapshot,
  withCodeGraphProcessLock,
  withSharedCleanRequestGate,
  writerSessionOptions,
} from './indexer_build.js';
import {assessIncrementalOverlay, assessIncrementalOverlayCompatibility} from './indexer_incremental.js';
import {attemptSparseReusableOverlay} from './indexer_sparse.js';
import {
  cacheContentBatch,
  cachedFileKeys,
  codeGraphDirectPersistentCapacityProtector,
  directFullSnapshotIdentity,
  extractorSetIdentity,
  firstReadySnapshotById,
  forcedSnapshotIdentity,
  graphContentIdentity,
  messageOf,
  promoteReadySnapshotWithCapacity,
  reusableReadySnapshotForCleanCommit,
  snapshotIdentity,
} from './indexer_materialization.js';
import {
  CodeGraphIndexOperationError,
  RepositoryMaintenanceInterrupted,
  RepositoryRegistrationLost,
  sameOverlayState,
  WorktreeChangedDuringIndex,
} from './indexer_shared.js';
import type {
  CodeGraphCommitLease,
  CodeGraphIndexerShape,
  CodeGraphIndexOptions,
  CommittedBaseResult,
  DirectPersistentCapacityProtection,
  IncrementalOverlayAssessment,
  IncrementalOverlayPreassessment,
} from './indexer_types.js';
import {codeGraphIndexEnsuresVectors} from './indexer_types.js';
import {
  type CodeGraphOverlayObservation,
  inventoryRepository,
  inventoryRepositoryFromReusableCleanBase,
  worktreeBuildRequestObservation,
} from './inventory.js';
import {CodeGraphLanguagePackRegistry} from './languages/registry.js';
import {codeGraphLayout} from './layout.js';
import {runCodeGraphLifecycleOpportunity} from './lifecycle_opportunity.js';
import {resolveAndRecordCodeGraphLocalAssociation} from './local_provenance.js';
import {CodeGraphMaintenanceCoordinator} from './maintenance_coordinator.js';
import {codeGraphMaintenanceIntentActive, withCodeGraphMaintenanceRegistration} from './maintenance_gate.js';
import {CodeGraphParserPool} from './parser_worker.js';
import {repositoryIdentityMatchesExpectation, resolveRepositoryIdentity} from './repository.js';
import {CodeGraphStore} from './store.js';
import {TreeSitterRuntime} from './tree_sitter/runtime.js';
import type {CodeGraphIndexSummary, CodeGraphProgress, CodeGraphSnapshot} from './types.js';
import {
  makeCodeGraphBuildAnonymousTelemetryReporter,
  type CodeGraphBuildAnonymousTelemetryReporter,
  withCodeGraphBuildAnonymousTelemetry,
} from './anonymous_telemetry.js';

export class CodeGraphIndexer extends Context.Service<CodeGraphIndexer, CodeGraphIndexerShape>()(
  'threadnote/codeGraph/CodeGraphIndexer',
) {
  static readonly layer = Layer.effect(
    CodeGraphIndexer,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const maintenance = yield* CodeGraphMaintenanceCoordinator;
      const embedding = yield* CodeGraphEmbeddingIndex;
      const languagePacks = yield* CodeGraphLanguagePackRegistry;
      const treeSitter = yield* TreeSitterRuntime;
      const parserPool = yield* CodeGraphParserPool;
      const command = yield* CommandExecutor;
      const crypto = yield* Crypto.Crypto;
      const system = yield* SystemInfo;
      const indexAttempt = (
        request: CodeGraphIndexOptions,
        anonymousTelemetry: CodeGraphBuildAnonymousTelemetryReporter,
        attempt = 0,
      ): Effect.Effect<CodeGraphIndexSummary, unknown> =>
        Effect.scoped(
          Effect.gen(function* () {
            const initialIdentity = yield* resolveRepositoryIdentity(request.cwd);
            if (
              request.expectedIdentity &&
              !repositoryIdentityMatchesExpectation(initialIdentity, request.expectedIdentity)
            ) {
              return yield* Effect.fail(
                new CodeGraphIndexOperationError('Repository identity does not match the requested graph target.'),
              );
            }
            const layout = codeGraphLayout(
              path,
              request.threadnoteHome,
              initialIdentity.checkoutId,
              initialIdentity.worktreeId,
            );
            const requestedBuildRequest = yield* worktreeBuildRequestObservation(
              initialIdentity,
              request.threadnoteHome,
            );
            const requestedOverlay = requestedBuildRequest.state;
            yield* anonymousTelemetry.observeOverlay(requestedOverlay.dirty);
            const requestKey = request.force
              ? undefined
              : codeGraphBuildRequestKey(initialIdentity, requestedOverlay, languagePacks, request.incrementalOverlay);
            const reporter = yield* withCodeGraphMaintenanceRegistration(
              request.threadnoteHome,
              Effect.gen(function* () {
                if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                  return yield* Effect.fail(
                    new CodeGraphIndexOperationError('Code graph repository root is a symbolic link.'),
                  );
                }
                yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true, mode: 0o700});
                const reporter = yield* makeCodeGraphBuildReporter(
                  initialIdentity,
                  layout,
                  requestKey ? {key: requestKey} : undefined,
                );
                yield* anonymousTelemetry
                  .progress({phase: 'registering'})
                  .pipe(Effect.andThen(request.onProgress?.({phase: 'registering'}) ?? Effect.void));
                return reporter;
              }),
            );
            yield* Effect.forkScoped(reporter.heartbeat);
            const options: CodeGraphIndexOptions = {
              ...request,
              onProgress: progress =>
                anonymousTelemetry
                  .progress(progress)
                  .pipe(
                    Effect.andThen(reporter.progress(progress)),
                    Effect.andThen(request.onProgress?.(progress) ?? Effect.void),
                  ),
            };
            const capacityProtection: DirectPersistentCapacityProtection = {
              availableDiskBytes:
                options.diskCapacityAvailableBytes ?? ((target: string) => system.availableDiskBytes(target)),
              crypto,
              maintenance,
              path,
              system,
              temporaryDirectory: system.tempDirectory,
              walAutoCheckpointPages: options.sqliteWriterTuning?.walAutoCheckpointPages ?? 1_000,
            };
            const ensureVectors = codeGraphIndexEnsuresVectors(options);
            const repositoryBuild = withCodeGraphProcessLock(
              fs,
              layout.lockPath,
              () =>
                (options.onProgress?.({phase: 'waiting', reason: 'repository-lock'}) ?? Effect.void).pipe(
                  Effect.catch(() => Effect.void),
                ),
              'index-repository',
              Effect.gen(function* () {
                if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                  return yield* Effect.fail(
                    new CodeGraphIndexOperationError('Code graph repository root is a symbolic link.'),
                  );
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
                      const startedAt = yield* Clock.currentTimeMillis;
                      const {identity} = yield* resolveAndRecordCodeGraphLocalAssociation(
                        options.threadnoteHome,
                        options.cwd,
                        {
                          validateIdentity: identity => {
                            if (!repositoryIdentityMatchesExpectation(identity, initialIdentity)) {
                              return Effect.fail(
                                new CodeGraphIndexOperationError(
                                  'Repository identity changed while waiting for the graph lock.',
                                ),
                              );
                            }
                            if (
                              options.expectedIdentity &&
                              !repositoryIdentityMatchesExpectation(identity, options.expectedIdentity)
                            ) {
                              return Effect.fail(
                                new CodeGraphIndexOperationError(
                                  'Repository identity does not match the requested graph target.',
                                ),
                              );
                            }
                            return identity.headCommit === initialIdentity.headCommit
                              ? Effect.void
                              : Effect.fail(new WorktreeChangedDuringIndex());
                          },
                        },
                      );
                      yield* store.initialize(layout.databasePath);
                      let inventoryOverlayObservation: CodeGraphOverlayObservation;
                      {
                        const currentBuildRequest = yield* worktreeBuildRequestObservation(
                          identity,
                          options.threadnoteHome,
                        );
                        const currentOverlay = currentBuildRequest.state;
                        if (!sameOverlayState(currentOverlay, requestedOverlay)) {
                          return yield* Effect.fail(new WorktreeChangedDuringIndex());
                        }
                        inventoryOverlayObservation = currentBuildRequest.overlay;
                        if (requestKey) {
                          const completedByOwner = yield* completedConcurrentSnapshot(
                            store,
                            layout,
                            identity,
                            currentOverlay,
                            requestKey,
                            options.incrementalOverlay === false,
                          );
                          if (completedByOwner) {
                            // An isolated builder exits as soon as it returns this shared result.
                            // Drain superseded persistent rows before that scope closes so a
                            // high-churn worktree cannot accumulate one full graph per request.
                            yield* store.retireIncompleteWorktreeSnapshots(
                              layout.databasePath,
                              identity.repositoryId,
                              identity.worktreeId,
                              new Set(),
                              retiredSnapshotCleanupReporter(options.onProgress),
                              {cleanupMode: 'required'},
                            );
                            yield* promoteReadySnapshotWithCapacity(
                              {
                                capacityProtection,
                                fs,
                                identity,
                                layout,
                                onProgress: options.onProgress,
                                store,
                                threadnoteHome: options.threadnoteHome,
                              },
                              completedByOwner.id,
                            );
                            return yield* reuseReadySnapshot({
                              embedding,
                              ensureVectors,
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
                      }
                      const cacheCoalescer = cacheContentBatch({
                        databasePath: layout.databasePath,
                        languagePacks,
                        onProgress: options.onProgress,
                        parserPool,
                        persistentCapacityProtector: codeGraphDirectPersistentCapacityProtector({
                          capacityProtection,
                          fs,
                          identity,
                          layout,
                          onProgress: options.onProgress,
                          threadnoteHome: options.threadnoteHome,
                        }),
                        store,
                        threadnoteHome: options.threadnoteHome,
                        treeSitter,
                      });
                      const sparseOverlay = yield* attemptSparseReusableOverlay({
                        anonymousTelemetry,
                        cacheCoalescer,
                        capacityProtection,
                        embedding,
                        ensureVectors,
                        fs,
                        identity,
                        languagePacks,
                        layout,
                        observation: inventoryOverlayObservation,
                        options,
                        requestedOverlay,
                        startedAt,
                        store,
                      }).pipe(Effect.ensuring(cacheCoalescer.discard.pipe(Effect.andThen(parserPool.trimIdle))));
                      if (Option.isSome(sparseOverlay)) return sparseOverlay.value;
                      const inventory = yield* Effect.gen(function* () {
                        const changedPathCount =
                          inventoryOverlayObservation.changedPaths.length +
                          inventoryOverlayObservation.deletedPaths.length;
                        const reusableInventoryBase =
                          !options.force &&
                          options.incrementalOverlay !== false &&
                          changedPathCount > 0 &&
                          changedPathCount <= 200
                            ? yield* store.reusableCleanBaseForCommit(
                                layout.databasePath,
                                identity.repositoryId,
                                identity.headCommit,
                              )
                            : undefined;
                        if (reusableInventoryBase !== undefined) {
                          const targetedCachedFileKeys = yield* cachedFileKeys(
                            store,
                            layout.databasePath,
                            languagePacks,
                            options.onProgress,
                            inventoryOverlayObservation.files,
                          );
                          const reusedInventory = yield* inventoryRepositoryFromReusableCleanBase(
                            identity,
                            reusableInventoryBase,
                            {
                              ...options,
                              cachedCommittedFileKeys: targetedCachedFileKeys,
                              includeOpaqueCorpusAssets: ensureVectors,
                              languagePacks,
                              overlayObservation: inventoryOverlayObservation,
                              onContentBatch: cacheCoalescer.onContentBatch,
                              onOverlayStart: () => cacheCoalescer.beginOverlayExtraction,
                            },
                          );
                          if (Option.isSome(reusedInventory)) return reusedInventory.value;
                        }
                        const cachedCommittedFileKeys = options.force
                          ? new Set<string>()
                          : yield* cachedFileKeys(store, layout.databasePath, languagePacks, options.onProgress);
                        return yield* inventoryRepository(identity, {
                          ...options,
                          cachedCommittedFileKeys,
                          includeOpaqueCorpusAssets: ensureVectors,
                          languagePacks,
                          overlayObservation: inventoryOverlayObservation,
                          onContentBatch: cacheCoalescer.onContentBatch,
                          onOverlayStart: () => cacheCoalescer.beginOverlayExtraction,
                        });
                      }).pipe(
                        Effect.tap(() => cacheCoalescer.flush),
                        Effect.ensuring(cacheCoalescer.discard.pipe(Effect.andThen(parserPool.trimIdle))),
                      );
                      yield* anonymousTelemetry.observeInventory(inventory);
                      yield* anonymousTelemetry.observeExtractedFactBytes(yield* cacheCoalescer.extractedFactBytes);
                      // Inventory and extraction build large, short-lived maps and Git payloads. Reclaim them before
                      // the SQLite activation phase so their heap high-water does not overlap the writer page cache.
                      yield* Effect.sync(() => {
                        Bun.gc(true);
                        Bun.shrink();
                      });
                      yield* Effect.yieldNow;
                      const extractorSet = extractorSetIdentity(inventory.files, languagePacks);
                      const graphContentId = graphContentIdentity(extractorSet, inventory.files);
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
                      const reusableExisting = existing
                        ? yield* store.currentLexicalReadySnapshotById(layout.databasePath, existing.id)
                        : undefined;
                      const reusableReadyById = !options.force
                        ? reusableExisting && readyCandidateIds.includes(reusableExisting.id)
                          ? reusableExisting
                          : yield* firstReadySnapshotById(store, layout.databasePath, readyCandidateIds)
                        : undefined;
                      // Exact cgsn_* can miss when inventory source/provenance differs slightly
                      // from the shared clean row while graph content is identical. Prefer promote
                      // of a HEAD-matching clean ready snapshot over rematerializing.
                      const reusableReady =
                        reusableReadyById ??
                        (!options.force && !inventory.dirty
                          ? yield* reusableReadySnapshotForCleanCommit({
                              databasePath: layout.databasePath,
                              extractorSet,
                              graphContentId,
                              headCommit: identity.headCommit,
                              repositoryId: identity.repositoryId,
                              store,
                            })
                          : undefined);
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
                      // Apply storage backpressure before another repository-sized materialization.
                      // Detached cleanup is cancelled with short-lived CLI graph builders and cannot
                      // keep pace with repeated WorktreeChangedDuringIndex failures.
                      yield* store.retireIncompleteWorktreeSnapshots(
                        layout.databasePath,
                        identity.repositoryId,
                        identity.worktreeId,
                        retainedSnapshotIds,
                        retiredSnapshotCleanupReporter(options.onProgress),
                        {cleanupMode: 'required'},
                      );
                      if (reusableReady) {
                        if (existing?.id !== reusableReady.id) {
                          yield* promoteReadySnapshotWithCapacity(
                            {
                              capacityProtection,
                              fs,
                              identity,
                              layout,
                              onProgress: options.onProgress,
                              store,
                              threadnoteHome: options.threadnoteHome,
                            },
                            reusableReady.id,
                          );
                        }
                        return yield* reuseReadySnapshot({
                          embedding,
                          ensureVectors,
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
                          buildOwner: reporter.ownerIdentity,
                          capacityProtection,
                          embedding,
                          ensureVectors,
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
                          persistentMaterializationTransactionBatchLimit:
                            options.persistentMaterializationTransactionBatchLimit,
                          requestedOverlay,
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
                      let workspace = inventory.workspace ?? (yield* languagePacks.discoverWorkspace(inventory.files));
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
                          {logicalSnapshotId, owner: reporter.ownerIdentity},
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
                          {logicalSnapshotId, owner: reporter.ownerIdentity},
                        );
                      } else if (!inventory.dirty && !options.force) {
                        building = {
                          commit: identity.headCommit,
                          dirty: false,
                          edgeCount: 0,
                          extractorSet,
                          fileCount: 0,
                          graphContentId,
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
                          {logicalSnapshotId, owner: reporter.ownerIdentity},
                        );
                      } else if (!canAttemptIncrementalOverlay) {
                        building = {
                          commit: identity.headCommit,
                          dirty: inventory.dirty,
                          edgeCount: 0,
                          extractorSet,
                          fileCount: 0,
                          graphContentId,
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
                          {logicalSnapshotId, owner: reporter.ownerIdentity},
                        );
                      } else {
                        const reusableDirtyBase = yield* attemptReusableDirtyBase(
                          {
                            extractorSet,
                            identity,
                            inventory,
                            languagePacks,
                            layout,
                            persistentCapacityProtector: codeGraphDirectPersistentCapacityProtector({
                              capacityProtection,
                              fs,
                              identity,
                              layout,
                              onProgress: options.onProgress,
                              threadnoteHome: options.threadnoteHome,
                            }),
                            store,
                          },
                          workspace,
                        );
                        let preassessment: IncrementalOverlayPreassessment;
                        let incrementalBuilding: CodeGraphSnapshot | undefined;
                        if (Option.isSome(reusableDirtyBase)) {
                          committedBase = reusableDirtyBase.value.committedBase;
                          preassessment = reusableDirtyBase.value.preassessment;
                        } else {
                          preassessment = yield* assessIncrementalOverlayCompatibility(
                            {extractorSet, inventory, languagePacks, layout, store},
                            workspace,
                          );
                          if (preassessment.mode === 'compatible') {
                            committedBase = yield* ensureCommittedBase({
                              buildOwner: reporter.ownerIdentity,
                              capacityProtection,
                              embedding,
                              existing,
                              force: false,
                              forceGeneration,
                              fs,
                              identity,
                              inventory,
                              languagePacks,
                              layout,
                              onProgress: options.onProgress,
                              persistentMaterializationTransactionBatchLimit:
                                options.persistentMaterializationTransactionBatchLimit,
                              requestedOverlay,
                              startedAt,
                              store,
                              threadnoteHome: options.threadnoteHome,
                            });
                          }
                        }
                        if (preassessment.mode === 'fallback') {
                          incrementalAssessment = preassessment;
                        } else {
                          incrementalBuilding = {
                            baseSnapshotId: committedBase!.snapshot.id,
                            commit: identity.headCommit,
                            dirty: inventory.dirty,
                            edgeCount: 0,
                            extractorSet,
                            fileCount: 0,
                            graphContentId,
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
                              committedBase: committedBase!,
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
                              new CodeGraphIndexOperationError(
                                'Incremental code graph preparation requires a committed base snapshot.',
                              ),
                            );
                          }
                          const incrementalReusedFiles = inventory.files.length - incrementalAssessment.files.length;
                          const incrementalCapacityProtector = codeGraphDirectPersistentCapacityProtector({
                            capacityProtection,
                            fs,
                            identity,
                            layout,
                            onProgress: options.onProgress,
                            threadnoteHome: options.threadnoteHome,
                          });
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
                                  {
                                    deletedPaths: incrementalAssessment.deletedPaths,
                                    resolutionClosure: incrementalAssessment.resolutionClosure,
                                  },
                                  incrementalCapacityProtector,
                                )
                              : yield* store.replaceStagedModifiedFiles(
                                  layout.databasePath,
                                  committedBase.snapshot.id,
                                  incrementalAssessment.files,
                                  incrementalAssessment.facts,
                                  incrementalCapacityProtector,
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
                            graphContentId,
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
                            {logicalSnapshotId, owner: reporter.ownerIdentity},
                          );
                        }
                      }
                      if (incrementalPrepared) {
                        // The prepared delta already contains attributed facts
                        // and a staged workspace catalog. Retaining thousands
                        // of project/dependency objects through activation only
                        // makes one-file overlays overlap full-workspace memory
                        // with SQLite's effective-graph scans.
                        workspace = {
                          diagnostics: workspace.diagnostics,
                          fingerprint: workspace.fingerprint,
                          projects: [],
                          workspaces: [],
                        };
                      }
                      return yield* buildAndActivate({
                        activatePointer: true,
                        building,
                        capacityProtection,
                        existing,
                        embedding,
                        ensureVectors,
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
                        persistentMaterializationTransactionBatchLimit:
                          options.persistentMaterializationTransactionBatchLimit,
                        persistentOwnerToken,
                        requestedOverlay,
                        startedAt,
                        store,
                        threadnoteHome: options.threadnoteHome,
                        workspace,
                      }).pipe(
                        Effect.catch(cause =>
                          persistentOwnerToken !== undefined && isCodeGraphCapacityPause(cause)
                            ? Effect.fail(cause)
                            : store
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
            const summary = yield* withCodeGraphBuilderAdmission(
              {
                admissionClass: codeGraphBuilderAdmissionClass(options, system.environment()),
                onWaiting: (options.onProgress?.({phase: 'waiting', reason: 'home-builder-cap'}) ?? Effect.void).pipe(
                  Effect.catch(() => Effect.void),
                ),
                threadnoteHome: options.threadnoteHome,
              },
              repositoryBuild,
            ).pipe(
              Effect.ensuring(
                runCodeGraphLifecycleOpportunity({
                  maintenance,
                  opportunity: 'index-completion',
                  targets: [
                    {anchorIdentity: initialIdentity, checkoutId: layout.checkoutId, databasePath: layout.databasePath},
                  ],
                  threadnoteHome: request.threadnoteHome,
                }).pipe(Effect.ignore),
              ),
            );
            return summary;
          }),
        ).pipe(
          Effect.provideService(CommandExecutor, command),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
          Effect.catchIf(
            cause => cause instanceof WorktreeChangedDuringIndex && attempt === 0,
            () => indexAttempt(request, anonymousTelemetry, attempt + 1),
          ),
        );
      const index = (request: CodeGraphIndexOptions) =>
        Effect.flatMap(
          makeCodeGraphBuildAnonymousTelemetryReporter(
            system.environment().THREADNOTE_MCP_BROKER_CHILD === '1' ? 'mcp' : 'cli',
          ),
          anonymousTelemetry =>
            withCodeGraphBuildAnonymousTelemetry(anonymousTelemetry, indexAttempt(request, anonymousTelemetry)),
        );
      const ensureCommitWithSummary = (
        request: Omit<CodeGraphIndexOptions, 'force' | 'includeOverlay'> & {readonly commit: string},
        anonymousTelemetry: CodeGraphBuildAnonymousTelemetryReporter,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const initialIdentity = yield* resolveRepositoryIdentity(request.cwd);
            if (
              request.expectedIdentity &&
              !repositoryIdentityMatchesExpectation(initialIdentity, request.expectedIdentity)
            ) {
              return yield* Effect.fail(
                new CodeGraphIndexOperationError('Repository identity does not match the requested graph target.'),
              );
            }
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
                  return yield* Effect.fail(
                    new CodeGraphIndexOperationError('Code graph repository root is a symbolic link.'),
                  );
                }
                yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true, mode: 0o700});
                return yield* makeCodeGraphBuildReporter({...initialIdentity, headCommit: request.commit}, layout);
              }),
            );
            yield* Effect.forkScoped(reporter.heartbeat);
            const options = {
              ...request,
              onProgress: (progress: CodeGraphProgress) =>
                anonymousTelemetry
                  .progress(progress)
                  .pipe(
                    Effect.andThen(reporter.progress(progress)),
                    Effect.andThen(request.onProgress?.(progress) ?? Effect.void),
                  ),
            };
            const capacityProtection: DirectPersistentCapacityProtection = {
              availableDiskBytes:
                options.diskCapacityAvailableBytes ?? ((target: string) => system.availableDiskBytes(target)),
              crypto,
              maintenance,
              path,
              system,
              temporaryDirectory: system.tempDirectory,
              walAutoCheckpointPages: options.sqliteWriterTuning?.walAutoCheckpointPages ?? 1_000,
            };
            const commitBuild = withCodeGraphProcessLock(
              fs,
              layout.lockPath,
              () =>
                (options.onProgress?.({phase: 'waiting', reason: 'repository-lock'}) ?? Effect.void).pipe(
                  Effect.catch(() => Effect.void),
                ),
              'ensure-commit',
              Effect.gen(function* () {
                if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                  return yield* Effect.fail(
                    new CodeGraphIndexOperationError('Code graph repository root is a symbolic link.'),
                  );
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
                      const {identity: currentIdentity} = yield* resolveAndRecordCodeGraphLocalAssociation(
                        options.threadnoteHome,
                        options.cwd,
                        {
                          validateIdentity: identity => {
                            if (!repositoryIdentityMatchesExpectation(identity, initialIdentity)) {
                              return Effect.fail(
                                new CodeGraphIndexOperationError(
                                  'Repository identity changed while waiting for the graph lock.',
                                ),
                              );
                            }
                            if (
                              options.expectedIdentity &&
                              !repositoryIdentityMatchesExpectation(identity, options.expectedIdentity)
                            ) {
                              return Effect.fail(
                                new CodeGraphIndexOperationError(
                                  'Repository identity does not match the requested graph target.',
                                ),
                              );
                            }
                            return Effect.void;
                          },
                        },
                      );
                      yield* store.initialize(layout.databasePath);
                      const identity = {...currentIdentity, headCommit: options.commit};
                      const cachedCommittedFileKeys = yield* cachedFileKeys(
                        store,
                        layout.databasePath,
                        languagePacks,
                        options.onProgress,
                      );
                      const cacheCoalescer = cacheContentBatch({
                        databasePath: layout.databasePath,
                        languagePacks,
                        onProgress: options.onProgress,
                        parserPool,
                        persistentCapacityProtector: codeGraphDirectPersistentCapacityProtector({
                          capacityProtection,
                          fs,
                          identity,
                          layout,
                          onProgress: options.onProgress,
                          threadnoteHome: options.threadnoteHome,
                        }),
                        store,
                        threadnoteHome: options.threadnoteHome,
                        treeSitter,
                      });
                      const inventory = yield* inventoryRepository(identity, {
                        ...options,
                        cachedCommittedFileKeys,
                        includeOverlay: false,
                        languagePacks,
                        onContentBatch: cacheCoalescer.onContentBatch,
                      }).pipe(
                        Effect.tap(() => cacheCoalescer.flush),
                        Effect.ensuring(cacheCoalescer.discard.pipe(Effect.andThen(parserPool.trimIdle))),
                      );
                      yield* anonymousTelemetry.observeInventory(inventory);
                      yield* anonymousTelemetry.observeExtractedFactBytes(yield* cacheCoalescer.extractedFactBytes);
                      const committedBase = yield* ensureCommittedBase({
                        buildOwner: reporter.ownerIdentity,
                        capacityProtection,
                        embedding,
                        force: false,
                        fs,
                        identity,
                        inventory,
                        languagePacks,
                        layout,
                        onProgress: options.onProgress,
                        persistentMaterializationTransactionBatchLimit:
                          options.persistentMaterializationTransactionBatchLimit,
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
                      return {
                        lease: {leaseToken, snapshot} satisfies CodeGraphCommitLease,
                        summary: committedBase.summary,
                      };
                    }),
                    writerSessionOptions(layout, options),
                  )
                  .pipe(
                    Effect.tap(result => reporter.completeSnapshot(result.lease.snapshot)),
                    Effect.tapError(cause => reporter.fail(cause)),
                  );
              }),
            );
            const lease = yield* withCodeGraphBuilderAdmission(
              {
                admissionClass: codeGraphBuilderAdmissionClass(options, system.environment()),
                onWaiting: (options.onProgress?.({phase: 'waiting', reason: 'home-builder-cap'}) ?? Effect.void).pipe(
                  Effect.catch(() => Effect.void),
                ),
                threadnoteHome: options.threadnoteHome,
              },
              commitBuild,
            ).pipe(
              Effect.ensuring(
                runCodeGraphLifecycleOpportunity({
                  maintenance,
                  opportunity: 'index-completion',
                  targets: [
                    {anchorIdentity: initialIdentity, checkoutId: layout.checkoutId, databasePath: layout.databasePath},
                  ],
                  threadnoteHome: request.threadnoteHome,
                }).pipe(Effect.ignore),
              ),
            );
            return lease;
          }),
        ).pipe(
          Effect.provideService(CommandExecutor, command),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
        );
      const ensureCommit = (
        request: Omit<CodeGraphIndexOptions, 'force' | 'includeOverlay'> & {readonly commit: string},
      ) =>
        Effect.flatMap(
          makeCodeGraphBuildAnonymousTelemetryReporter(
            system.environment().THREADNOTE_MCP_BROKER_CHILD === '1' ? 'mcp' : 'cli',
          ),
          anonymousTelemetry =>
            ensureCommitWithSummary(request, anonymousTelemetry).pipe(
              Effect.onExit(exit =>
                anonymousTelemetry.terminal(
                  Exit.isSuccess(exit) ? Exit.succeed(exit.value.summary) : Exit.failCause(exit.cause),
                ),
              ),
              Effect.map(result => result.lease),
            ),
        );
      return CodeGraphIndexer.of({
        ensureCommit,
        index,
      });
    }),
  );
}

function codeGraphBuilderAdmissionClass(
  options: Pick<CodeGraphIndexOptions, 'admissionClass'>,
  environment: Readonly<Record<string, string | undefined>>,
) {
  if (options.admissionClass) return options.admissionClass;
  return environment[CODE_GRAPH_BUILDER_ADMISSION_CLASS_ENV] === 'background'
    ? ('background' as const)
    : ('current-required' as const);
}
