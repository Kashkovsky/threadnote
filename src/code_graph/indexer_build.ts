import {Clock, Effect, FileSystem, Option, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {SystemInfo} from '../effect/system.js';
import {withThreadnoteProcessActivity} from '../process_diagnostics.js';
import type {CodeGraphBuildOwnerIdentity} from './build_owner.js';
import {readCodeGraphBuildStatuses} from './build_status.js';
import {canonicalCodeGraphMonikers} from './cross_repository/monikers.js';
import {isCodeGraphCapacityPause} from './disk_capacity.js';
import type {CodeGraphEmbeddingIndexShape, CodeGraphEmbeddingStatus} from './embedding.js';
import {finalCodeGraphFactBatches, serializeBoundedCodeGraphFact} from './fact_budget.js';
import {
  assessIncrementalOverlay,
  assessReusableCleanBaseCompatibility,
  createCachedCodeGraphFactsAttributor,
  overlayFallbackDescription,
  reusableBaseFileSetFingerprint,
} from './indexer_incremental.js';
import {
  CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS,
  CODE_GRAPH_LOCK_OPTIONS,
  PERSISTENT_MATERIALIZATION_TRANSACTION_FACT_BYTES,
  PERSISTENT_MATERIALIZATION_TRANSACTION_FILES,
  PERSISTENT_MATERIALIZATION_TRANSACTION_SOURCE_BYTES,
  addMaterializationReplayMetrics,
  addMaterializationRows,
  cachedFactsMetadata,
  codeGraphDirectPersistentCapacityProtector,
  deduplicateMaterializationRelationships,
  embeddingSymbolSource,
  emptyMaterializationReplayMetrics,
  estimatedMaterializationStorageBytes,
  extractorSetIdentity,
  extractorSetIdentityFromPackProvenance,
  factMaterializationBatches,
  forcedSnapshotIdentity,
  graphContentIdentity,
  loadCachedFacts,
  materializationRows,
  materializationRowsWithStoreProgress,
  materializationStagingStage,
  materializationStorageFiles,
  materializationStoragePlan,
  materializationStorageShortfalls,
  messageOf,
  persistentMaterializationTransactionBatches,
  promoteReadySnapshotWithCapacity,
  reusableReadySnapshotForCleanCommit,
  selectedDecodedFactBytes,
  snapshotIdentity,
  uniqueById,
  verifyIndexInput,
} from './indexer_materialization.js';
import {type PendingMaterializationBatch, secondaryIndexRestorationReporter} from './indexer_materialization_batch.js';
import {verifyCommittedIndexInput} from './indexer_input_verification.js';
import {CodeGraphIndexOperationError, codeGraphInventoryFileChanged, sameInventoryPaths} from './indexer_shared.js';
import type {
  CodeGraphIndexOptions,
  CommittedBaseResult,
  DirectPersistentCapacityProtection,
  IncrementalOverlayAssessment,
  IncrementalOverlayPreassessment,
  ReusableCleanSnapshotAttempt,
} from './indexer_types.js';
import {preferredIncrementalBaseCommitGroups} from './incremental_base_selection.js';
import type {CodeGraphInventory} from './inventory.js';
import {makeCodeGraphMaterializedShardWriteQueue} from './indexer_materialized_shard_writes.js';
import {
  codeGraphMaterializedShardCacheBatchPlan,
  codeGraphMaterializedShardCacheWriteAdmission,
} from './materialized_shard_cache_admission.js';
import {assessCodeGraphLanguagePackDelta} from './languages/provenance.js';
import {packDerivationIdentity, type CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import type {CodeGraphWorkspace} from './languages/types.js';
import {codeGraphRequestBuildLockPath, codeGraphSnapshotBuildLockPath, type CodeGraphLayout} from './layout.js';
import {compareCodeUnits} from './ordering.js';
import {MaterializationSubphaseTiming} from './materialization_subphase_timing.js';
import {
  CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION,
  materializedBatchShardDerivationIdentity,
  materializedFileShardIdentity,
  materializedShardRepositorySemanticEnvelope,
  shardDonorIds,
  type CodeGraphDirectPersistentCapacityProtector,
  type CodeGraphLanguagePackProvenance,
  type CodeGraphRetiredSnapshotCleanupProgress,
  type CodeGraphReusableCleanBase,
  type CodeGraphStagingProgress,
  type CodeGraphStoreShape,
} from './store.js';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  type CodeGraphIndexSummary,
  type CodeGraphMaterializationActivity,
  type CodeGraphMaterializationMetrics,
  type CodeGraphMaterializationRows,
  type CodeGraphOverlayFallbackReason,
  type CodeGraphProgress,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from './types.js';

export function withCodeGraphProcessLock<A, E, R>(
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

export function writerSessionOptions(layout: CodeGraphLayout, options: CodeGraphIndexOptions) {
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

export function retiredSnapshotCleanupReporter(onProgress: CodeGraphIndexOptions['onProgress']) {
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

export function withSharedCleanRequestGate<A, E, R>(input: {
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

export const completedConcurrentSnapshot = Effect.fn('codeGraph.completedConcurrentSnapshot')(function* (
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
  const ready = yield* store.currentLexicalReadySnapshotById(layout.databasePath, completed.result.snapshotId);
  if (
    !ready ||
    ready.commit !== identity.headCommit ||
    ready.dirty !== overlay.dirty ||
    (overlay.dirty && requireDirectFull && (ready.baseSnapshotId !== undefined || !ready.id.endsWith('-direct')))
  ) {
    return undefined;
  }
  return ready;
});

export const prepareReadyAnalysisSummary = Effect.fn('codeGraph.prepareReadyAnalysisSummary')(function* (input: {
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
  return yield* (
    typeof input.store.ensureAnalysisSummary === 'function'
      ? input.store.ensureAnalysisSummary(input.databasePath, input.snapshotId)
      : Effect.succeed(false)
  ).pipe(
    Effect.ensuring(
      (
        input.onProgress?.({phase: 'activating', snapshotId: input.snapshotId, subphase: 'complete'}) ?? Effect.void
      ).pipe(Effect.catch(() => Effect.void)),
    ),
  );
});

export const reuseReadySnapshot = Effect.fn('codeGraph.reuseReadySnapshot')(function* (input: {
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly ensureVectors: boolean;
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
  yield* input.onProgress?.({phase: 'activating', snapshotId: input.snapshot.id, subphase: 'structural-ready'}) ??
    Effect.void;
  let analysisSummaryFailure: string | undefined;
  const analysisSummaryBackfilled = input.snapshot.dirty
    ? yield* (
        input.onProgress?.({phase: 'activating', snapshotId: input.snapshot.id, subphase: 'complete'}) ?? Effect.void
      ).pipe(Effect.as(false))
    : yield* prepareReadyAnalysisSummary({
        databasePath: input.layout.databasePath,
        onProgress: input.onProgress,
        snapshotId: input.snapshot.id,
        store: input.store,
      }).pipe(
        Effect.catch(cause =>
          Effect.sync(() => {
            analysisSummaryFailure = messageOf(cause);
            return false;
          }),
        ),
      );
  const diagnostics: string[] = analysisSummaryBackfilled
    ? ['Built the persisted whole-graph analysis summary for this reused snapshot.']
    : analysisSummaryFailure
      ? [`Whole-graph analysis summary will be retried lazily: ${analysisSummaryFailure}`]
      : [];
  if (!input.ensureVectors) {
    const vectorCheck = yield* input.embedding
      .check(input.threadnoteHome, input.layout, input.snapshot.id)
      .pipe(Effect.catch(cause => Effect.succeed({reason: messageOf(cause), state: 'unavailable'} as const)));
    if (vectorCheck.state !== 'ready') {
      diagnostics.push(
        `Vector graph retrieval unavailable: ${vectorCheck.reason ?? 'deferred until an explicit vector refresh'}`,
      );
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
  }
  const vectorCheck = yield* input.embedding
    .check(input.threadnoteHome, input.layout, input.snapshot.id)
    .pipe(Effect.catch(cause => Effect.succeed({reason: messageOf(cause), state: 'unavailable'} as const)));
  const symbols =
    vectorCheck.state === 'ready'
      ? []
      : embeddingSymbolSource(input.store, input.layout.databasePath, input.snapshot.id);
  const repaired = yield* input.embedding
    .ensure(input.threadnoteHome, input.layout, input.snapshot, symbols, {
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

export function codeGraphBuildRequestKey(
  identity: Pick<RepositoryIdentity, 'checkoutId' | 'headCommit' | 'repositoryId' | 'worktreeId'>,
  overlay: {readonly dirty: boolean; readonly fingerprint?: string},
  languagePacks: CodeGraphLanguagePackRegistryShape,
  incrementalOverlay: boolean | undefined,
): string {
  const parserIdentities = languagePacks.cacheIdentities.join('\n');
  const derivationIdentities = languagePacks.packs.map(packDerivationIdentity).sort(compareCodeUnits).join('\n');
  return sha256HexSync(
    [
      'code-graph-build-request-v3',
      CODE_GRAPH_EXTRACTOR_SET_VERSION,
      `lexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}`,
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

export const buildOwnedCleanSnapshot = Effect.fn('codeGraph.buildOwnedCleanSnapshot')(function* (input: {
  readonly buildOwner: CodeGraphBuildOwnerIdentity;
  readonly capacityProtection: DirectPersistentCapacityProtection;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly ensureVectors: boolean;
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
  readonly persistentMaterializationTransactionBatchLimit?: 1 | 4;
  readonly requestedOverlay?: {readonly dirty: boolean; readonly fingerprint?: string};
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
      let cleanFallbackAssessment: IncrementalOverlayAssessment | undefined;
      if (!input.force) {
        const ready = yield* input.store.currentLexicalReadySnapshotById(
          input.layout.databasePath,
          input.logicalSnapshotId,
        );
        if (ready) {
          if (input.existing?.id !== ready.id) {
            yield* promoteReadySnapshotWithCapacity(input, ready.id);
          }
          return yield* reuseReadySnapshot({
            embedding: input.embedding,
            ensureVectors: input.ensureVectors,
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
        const extractorSet = extractorSetIdentity(input.inventory.files, input.languagePacks);
        const graphContentId = graphContentIdentity(extractorSet, input.inventory.files);
        const commitReady = yield* reusableReadySnapshotForCleanCommit({
          databasePath: input.layout.databasePath,
          extractorSet,
          graphContentId,
          headCommit: input.identity.headCommit,
          repositoryId: input.identity.repositoryId,
          store: input.store,
        });
        if (commitReady) {
          if (input.existing?.id !== commitReady.id) {
            yield* promoteReadySnapshotWithCapacity(input, commitReady.id);
          }
          return yield* reuseReadySnapshot({
            embedding: input.embedding,
            ensureVectors: input.ensureVectors,
            identity: input.identity,
            layout: input.layout,
            onProgress: input.onProgress,
            reusedFiles: input.inventory.files.length - input.inventory.parsedFiles,
            skippedFiles: input.inventory.skipped,
            snapshot: commitReady,
            startedAt: input.startedAt,
            store: input.store,
            threadnoteHome: input.threadnoteHome,
            totalFiles: input.inventory.files.length,
          });
        }
        const workspace =
          input.inventory.workspace ?? (yield* input.languagePacks.discoverWorkspace(input.inventory.files));
        const reused = yield* attemptReusableCleanSnapshot(input, workspace);
        if (Option.isSome(reused)) {
          if (reused.value.mode === 'complete') return reused.value.summary;
          cleanFallbackAssessment = {mode: 'fallback', reason: reused.value.reason};
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
        graphContentId: graphContentIdentity(
          extractorSetIdentity(input.inventory.files, input.languagePacks),
          input.inventory.files,
        ),
        id: input.fallbackSnapshotId,
        repositoryId: input.identity.repositoryId,
        state: 'building',
        symbolCount: 0,
        worktreeId: input.identity.worktreeId,
      };
      const ownerToken = yield* input.store.claimPersistentBuild(input.layout.databasePath, input.identity, building, {
        logicalSnapshotId: input.logicalSnapshotId,
        owner: input.buildOwner,
      });
      return yield* buildAndActivate({
        activatePointer: true,
        building,
        capacityProtection: input.capacityProtection,
        embedding: input.embedding,
        ensureVectors: input.ensureVectors,
        existing: input.existing,
        force: input.force,
        fs: input.fs,
        identity: input.identity,
        incrementalAssessment: cleanFallbackAssessment,
        inventory: input.inventory,
        languagePacks: input.languagePacks,
        layout: input.layout,
        onProgress: input.onProgress,
        persistentMaterializationTransactionBatchLimit: input.persistentMaterializationTransactionBatchLimit,
        persistentOwnerToken: ownerToken,
        requestedOverlay: input.requestedOverlay,
        startedAt: input.startedAt,
        store: input.store,
        threadnoteHome: input.threadnoteHome,
      }).pipe(
        Effect.catch(cause =>
          isCodeGraphCapacityPause(cause)
            ? Effect.fail(cause)
            : input.store
                .markFailed(input.layout.databasePath, building.id, messageOf(cause), ownerToken)
                .pipe(Effect.andThen(Effect.fail(cause))),
        ),
      );
    }),
  );
});

const attemptReusableCleanSnapshot = Effect.fn('codeGraph.attemptReusableCleanSnapshot')(function* (
  input: {
    readonly capacityProtection: DirectPersistentCapacityProtection;
    readonly embedding: CodeGraphEmbeddingIndexShape;
    readonly ensureVectors: boolean;
    readonly existing: CodeGraphSnapshot | undefined;
    readonly fs: FileSystem.FileSystem;
    readonly identity: RepositoryIdentity;
    readonly inventory: CodeGraphInventory;
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
    readonly layout: CodeGraphLayout;
    readonly logicalSnapshotId: string;
    readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
    readonly persistentMaterializationTransactionBatchLimit?: 1 | 4;
    readonly requestedOverlay?: {readonly dirty: boolean; readonly fingerprint?: string};
    readonly startedAt: number;
    readonly store: CodeGraphStoreShape;
    readonly threadnoteHome: string;
  },
  workspace: CodeGraphWorkspace,
) {
  if (!input.store.reusableCleanBase || !input.store.activateCleanSnapshotAlias) {
    return Option.none<ReusableCleanSnapshotAttempt>();
  }
  const extractorSet = extractorSetIdentity(input.inventory.files, input.languagePacks);
  const preferredCommitGroups = yield* preferredIncrementalBaseCommitGroups(
    input.identity.repoRoot,
    input.identity.headCommit,
  );
  const candidate = yield* input.store.reusableCleanBase(
    input.layout.databasePath,
    input.identity.repositoryId,
    extractorSet,
    workspace.fingerprint,
    reusableBaseFileSetFingerprint(input.inventory.files),
    graphContentIdentity(extractorSet, input.inventory.files),
    preferredCommitGroups,
    true,
  );
  if (!candidate || candidate.snapshot.id === input.logicalSnapshotId)
    return Option.none<ReusableCleanSnapshotAttempt>();
  const baseByPath = new Map(candidate.files.map(file => [file.path, file]));
  if (input.inventory.files.some(file => file.source !== 'commit')) {
    return Option.none<ReusableCleanSnapshotAttempt>();
  }
  const lease = yield* input.store
    .acquireSnapshotLease(input.layout.databasePath, candidate.snapshot.id, CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS)
    .pipe(Effect.option);
  if (Option.isNone(lease)) return Option.none<ReusableCleanSnapshotAttempt>();
  return yield* Effect.acquireUseRelease(
    Effect.succeed(lease.value),
    () =>
      Effect.gen(function* () {
        const packDelta =
          candidate.snapshot.extractorSet === extractorSet
            ? ({changedPackIds: [], mode: 'compatible'} as const)
            : assessCodeGraphLanguagePackDelta(
                candidate.receipt.packProvenance,
                input.languagePacks.activePackProvenance(input.inventory.files.map(file => file.path)),
              );
        if (
          packDelta.mode === 'fallback' ||
          (candidate.snapshot.extractorSet !== extractorSet &&
            candidate.snapshot.extractorSet !==
              extractorSetIdentityFromPackProvenance(candidate.receipt.packProvenance))
        ) {
          return Option.some<ReusableCleanSnapshotAttempt>({mode: 'fallback', reason: 'extractor-context-changed'});
        }
        const changedPackIds = new Set(packDelta.changedPackIds);
        const modifiedFiles = input.inventory.files.filter(file => {
          const base = baseByPath.get(file.path);
          return (
            !base ||
            base.contentHash !== file.contentHash ||
            base.language !== file.language ||
            base.mode !== file.mode ||
            base.size !== file.size ||
            Option.match(input.languagePacks.match(file.path), {
              onNone: () => false,
              onSome: match => changedPackIds.has(match.pack.id),
            })
          );
        });
        const currentPaths = new Set(input.inventory.files.map(file => file.path));
        const deletedPaths = candidate.files.filter(file => !currentPaths.has(file.path)).map(file => file.path);
        if (
          modifiedFiles.length === 0 &&
          deletedPaths.length === 0 &&
          candidate.snapshot.extractorSet === extractorSet
        ) {
          const alias: CodeGraphSnapshot = {
            baseSnapshotId: candidate.snapshot.id,
            commit: input.identity.headCommit,
            dirty: false,
            edgeCount: candidate.snapshot.edgeCount,
            extractorSet,
            fileCount: candidate.snapshot.fileCount,
            graphContentId: graphContentIdentity(extractorSet, input.inventory.files),
            id: input.logicalSnapshotId,
            repositoryId: input.identity.repositoryId,
            state: 'ready',
            symbolCount: candidate.snapshot.symbolCount,
            worktreeId: input.identity.worktreeId,
          };
          yield* input.onProgress?.({phase: 'activating', snapshotId: alias.id, subphase: 'validating-input'}) ??
            Effect.void;
          yield* verifyIndexInput(input.identity, true, input.threadnoteHome, input.requestedOverlay);
          yield* input.store.activateCleanSnapshotAlias!(
            input.layout.databasePath,
            input.identity,
            alias,
            candidate.snapshot.id,
          );
          yield* input.onProgress?.({phase: 'activating', snapshotId: alias.id, subphase: 'promoting'}) ?? Effect.void;
          yield* verifyCommittedIndexInput({
            databasePath: input.layout.databasePath,
            identity: input.identity,
            physicalSnapshotId: candidate.snapshot.id,
            requestedOverlay: input.requestedOverlay,
            snapshotId: alias.id,
            store: input.store,
            threadnoteHome: input.threadnoteHome,
          });
          yield* promoteReadySnapshotWithCapacity(input, alias.id);
          yield* input.onProgress?.({phase: 'activating', snapshotId: alias.id, subphase: 'promoting'}) ?? Effect.void;
          yield* verifyCommittedIndexInput({
            databasePath: input.layout.databasePath,
            identity: input.identity,
            physicalSnapshotId: candidate.snapshot.id,
            requestedOverlay: input.requestedOverlay,
            snapshotId: alias.id,
            store: input.store,
            threadnoteHome: input.threadnoteHome,
          });
          return Option.some<ReusableCleanSnapshotAttempt>({
            mode: 'complete',
            summary: yield* reuseReadySnapshot({
              embedding: input.embedding,
              ensureVectors: input.ensureVectors,
              identity: input.identity,
              layout: input.layout,
              onProgress: input.onProgress,
              reusedFiles: input.inventory.files.length,
              skippedFiles: input.inventory.skipped,
              snapshot: alias,
              startedAt: input.startedAt,
              store: input.store,
              threadnoteHome: input.threadnoteHome,
              totalFiles: input.inventory.files.length,
            }),
          });
        }
        const assessmentInput = {
          candidate,
          inventory: input.inventory,
          languagePacks: input.languagePacks,
          layout: input.layout,
          store: input.store,
        };
        const boundedAssessment = yield* assessReusableCleanBaseCompatibility(
          assessmentInput,
          workspace,
          modifiedFiles,
        );
        if (boundedAssessment.mode === 'fallback') {
          return Option.some<ReusableCleanSnapshotAttempt>(boundedAssessment);
        }
        const preassessment = boundedAssessment;
        const committedBase: CommittedBaseResult = {
          diagnostics: [],
          leaseToken: Option.none(),
          snapshot: candidate.snapshot,
          stagingReusable: false,
        };
        const building: CodeGraphSnapshot = {
          baseSnapshotId: candidate.snapshot.id,
          commit: input.identity.headCommit,
          dirty: false,
          edgeCount: 0,
          extractorSet,
          fileCount: 0,
          graphContentId: graphContentIdentity(extractorSet, input.inventory.files),
          id: input.logicalSnapshotId,
          repositoryId: input.identity.repositoryId,
          state: 'building',
          symbolCount: 0,
          worktreeId: input.identity.worktreeId,
        };
        const incrementalAssessment = yield* assessIncrementalOverlay(
          {
            building,
            committedBase,
            force: false,
            incrementalOverlayEnabled: true,
            inventory: input.inventory,
            languagePacks: input.languagePacks,
            layout: input.layout,
            store: input.store,
          },
          workspace,
          preassessment,
        );
        if (incrementalAssessment.mode === 'fallback') {
          return Option.some<ReusableCleanSnapshotAttempt>(incrementalAssessment);
        }
        yield* input.onProgress?.({
          completed: 0,
          phase: 'materializing',
          reused: input.inventory.files.length - incrementalAssessment.files.length,
          total: incrementalAssessment.files.length,
          unit: 'files',
        }) ?? Effect.void;
        const prepared = yield* input.store.preparePersistedIncrementalActivation(
          input.layout.databasePath,
          candidate.snapshot.id,
          incrementalAssessment.files,
          incrementalAssessment.facts,
          {
            deletedPaths: incrementalAssessment.deletedPaths,
            resolutionClosure: incrementalAssessment.resolutionClosure,
          },
          codeGraphDirectPersistentCapacityProtector(input),
        );
        if (!prepared) {
          return Option.some<ReusableCleanSnapshotAttempt>({mode: 'fallback', reason: 'staging-identity-mismatch'});
        }
        yield* input.store.markBuilding(input.layout.databasePath, input.identity, building);
        const summary = yield* buildAndActivate({
          activatePointer: true,
          building,
          capacityProtection: input.capacityProtection,
          committedBase,
          embedding: input.embedding,
          ensureVectors: input.ensureVectors,
          existing: input.existing,
          force: false,
          fs: input.fs,
          identity: input.identity,
          incrementalAssessment,
          incrementalOverlayEnabled: true,
          incrementalPrepared: true,
          inventory: input.inventory,
          languagePacks: input.languagePacks,
          layout: input.layout,
          onProgress: input.onProgress,
          persistentMaterializationTransactionBatchLimit: input.persistentMaterializationTransactionBatchLimit,
          requestedOverlay: input.requestedOverlay,
          startedAt: input.startedAt,
          store: input.store,
          threadnoteHome: input.threadnoteHome,
          workspace,
        }).pipe(
          Effect.catch(cause =>
            input.store
              .markFailed(input.layout.databasePath, building.id, messageOf(cause))
              .pipe(Effect.andThen(Effect.fail(cause))),
          ),
        );
        return Option.some<ReusableCleanSnapshotAttempt>({mode: 'complete', summary});
      }),
    token => input.store.releaseSnapshotLease(input.layout.databasePath, token).pipe(Effect.catch(() => Effect.void)),
  );
});

export const attemptReusableDirtyBase = Effect.fn('codeGraph.attemptReusableDirtyBase')(function* (
  input: {
    readonly extractorSet: string;
    readonly identity: RepositoryIdentity;
    readonly inventory: CodeGraphInventory;
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
    readonly layout: CodeGraphLayout;
    readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
    readonly store: CodeGraphStoreShape;
  },
  workspace: CodeGraphWorkspace,
) {
  if (!input.store.reusableCleanBase && !input.store.reusableOverlayBase) {
    return Option.none<{
      readonly committedBase: CommittedBaseResult;
      readonly preassessment: Extract<IncrementalOverlayPreassessment, {readonly mode: 'compatible'}>;
    }>();
  }
  const retainedOverlayCandidate =
    input.inventory.overlayFingerprint && input.store.reusableOverlayBase
      ? yield* input.store.reusableOverlayBase(
          input.layout.databasePath,
          input.identity.repositoryId,
          input.extractorSet,
          input.inventory.overlayFingerprint,
        )
      : undefined;
  // Prefer the exact committed snapshot path below when it is itself a root
  // reusable base. A clean incremental snapshot is already layered, so another
  // overlay must instead reuse its root and include the cumulative changed set.
  const committedExtractorSet = extractorSetIdentity(input.inventory.committedFiles, input.languagePacks);
  const exactCommittedSnapshotId = snapshotIdentity(
    input.identity,
    false,
    committedExtractorSet,
    input.inventory.committedFiles,
  );
  const exactCommittedSnapshot = yield* input.store.currentLexicalReadySnapshotById(
    input.layout.databasePath,
    exactCommittedSnapshotId,
  );
  if (!retainedOverlayCandidate && exactCommittedSnapshot && exactCommittedSnapshot.baseSnapshotId === undefined) {
    return Option.none();
  }
  const committedFileSetFingerprint = reusableBaseFileSetFingerprint(input.inventory.committedFiles);
  const committedGraphContentId = graphContentIdentity(committedExtractorSet, input.inventory.committedFiles);
  const commitReady = yield* input.store.readySnapshotForCommit(
    input.layout.databasePath,
    input.identity.repositoryId,
    input.identity.headCommit,
    committedExtractorSet,
  );
  const commitReceipt = commitReady
    ? yield* input.store.reusableBaseReceipt(input.layout.databasePath, commitReady.id)
    : undefined;
  let candidate: CodeGraphReusableCleanBase | undefined =
    retainedOverlayCandidate ??
    (commitReady &&
    commitReceipt &&
    commitReady.graphContentId === committedGraphContentId &&
    commitReceipt.fileSetFingerprint === committedFileSetFingerprint &&
    commitReceipt.workspaceFingerprint === workspace.fingerprint
      ? {files: input.inventory.committedFiles, receipt: commitReceipt, snapshot: commitReady}
      : undefined);
  if (!candidate && input.store.reusableCleanBase) {
    const preferredCommitGroups = yield* preferredIncrementalBaseCommitGroups(
      input.identity.repoRoot,
      input.identity.headCommit,
    );
    candidate = yield* input.store.reusableCleanBase(
      input.layout.databasePath,
      input.identity.repositoryId,
      input.extractorSet,
      workspace.fingerprint,
      reusableBaseFileSetFingerprint(input.inventory.files),
      graphContentIdentity(input.extractorSet, input.inventory.files),
      preferredCommitGroups,
      true,
    );
  }
  if (!candidate) return Option.none();
  const lease = yield* input.store
    .acquireSnapshotLease(input.layout.databasePath, candidate.snapshot.id, CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS)
    .pipe(Effect.option);
  if (Option.isNone(lease)) return Option.none();
  const leaseToken = yield* Effect.acquireRelease(Effect.succeed(lease.value), token =>
    input.store.releaseSnapshotLease(input.layout.databasePath, token).pipe(Effect.catch(() => Effect.void)),
  );
  const packDelta =
    candidate.snapshot.extractorSet === input.extractorSet
      ? ({changedPackIds: [], mode: 'compatible'} as const)
      : assessCodeGraphLanguagePackDelta(
          candidate.receipt.packProvenance,
          input.languagePacks.activePackProvenance(input.inventory.files.map(file => file.path)),
        );
  if (
    packDelta.mode === 'fallback' ||
    (candidate.snapshot.extractorSet !== input.extractorSet &&
      candidate.snapshot.extractorSet !== extractorSetIdentityFromPackProvenance(candidate.receipt.packProvenance))
  ) {
    return Option.none();
  }
  const changedPackIds = new Set(packDelta.changedPackIds);
  const alignedCommitCandidate = sameInventoryPaths(candidate.files, input.inventory.files);
  const baseByPath = alignedCommitCandidate ? undefined : new Map(candidate.files.map(file => [file.path, file]));
  const currentPaths = alignedCommitCandidate ? undefined : new Set(input.inventory.files.map(file => file.path));
  const modifiedFiles = input.inventory.files.filter((file, index) => {
    const base = alignedCommitCandidate ? candidate.files[index] : baseByPath!.get(file.path);
    return codeGraphInventoryFileChanged(base, file, input.languagePacks, changedPackIds);
  });
  const deletedPaths = alignedCommitCandidate
    ? []
    : candidate.files.filter(file => !currentPaths!.has(file.path)).map(file => file.path);
  if (modifiedFiles.length === 0 && deletedPaths.length === 0) return Option.none();
  const assessmentInput = {
    candidate,
    inventory: input.inventory,
    languagePacks: input.languagePacks,
    layout: input.layout,
    store: input.store,
  };
  const boundedAssessment = yield* assessReusableCleanBaseCompatibility(assessmentInput, workspace, modifiedFiles);
  if (boundedAssessment.mode === 'fallback') return Option.none();
  const preassessment = boundedAssessment;
  return Option.some({
    committedBase: {
      diagnostics: [
        `Dirty snapshot reused compatible persisted base ${candidate.snapshot.id} without first building commit ${input.identity.headCommit}.`,
      ],
      leaseToken: Option.some(leaseToken),
      snapshot: candidate.snapshot,
      stagingReusable: false,
    },
    preassessment,
  });
});

export const ensureCommittedBase = Effect.fn('codeGraph.ensureCommittedBase')(function* (input: {
  readonly buildOwner: CodeGraphBuildOwnerIdentity;
  readonly capacityProtection: DirectPersistentCapacityProtection;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly existing?: CodeGraphSnapshot;
  readonly force: boolean;
  readonly forceGeneration?: string;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly inventory: CodeGraphInventory;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly layout: CodeGraphLayout;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly persistentMaterializationTransactionBatchLimit?: 1 | 4;
  readonly requestedOverlay?: {readonly dirty: boolean; readonly fingerprint?: string};
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
  const existing = yield* input.store.currentLexicalReadySnapshotById(input.layout.databasePath, snapshotId);
  if (existing) {
    const lease = yield* input.store
      .acquireSnapshotLease(input.layout.databasePath, existing.id, CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS)
      .pipe(Effect.option);
    if (Option.isSome(lease)) {
      const leaseToken = yield* Effect.acquireRelease(Effect.succeed(lease.value), token =>
        input.store.releaseSnapshotLease(input.layout.databasePath, token).pipe(Effect.catch(() => Effect.void)),
      );
      const summary = {
        diagnostics: [],
        durationMs: (yield* Clock.currentTimeMillis) - input.startedAt,
        identity: input.identity,
        materialization: {mode: 'reused-snapshot', stagedFiles: 0, totalFiles: cleanInventory.files.length},
        reusedFiles: cleanInventory.files.length - cleanInventory.parsedFiles,
        skippedFiles: cleanInventory.skipped,
        snapshot: existing,
      } satisfies CodeGraphIndexSummary;
      return {
        diagnostics: [],
        leaseToken: Option.some(leaseToken),
        snapshot: existing,
        stagingReusable: false,
        summary,
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
        const ready = yield* input.store.currentLexicalReadySnapshotById(input.layout.databasePath, logicalSnapshotId);
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
        graphContentId: graphContentIdentity(extractorSet, cleanInventory.files),
        id: snapshotId,
        repositoryId: input.identity.repositoryId,
        state: 'building',
        symbolCount: 0,
        worktreeId: input.identity.worktreeId,
      };
      const ownerToken = yield* input.store.claimPersistentBuild(input.layout.databasePath, input.identity, building, {
        logicalSnapshotId,
        owner: input.buildOwner,
      });
      return yield* buildAndActivate({
        ...input,
        activatePointer: false,
        building,
        ensureVectors: false,
        existing: input.existing,
        inventory: cleanInventory,
        persistentOwnerToken: ownerToken,
      }).pipe(
        Effect.catch(cause =>
          isCodeGraphCapacityPause(cause)
            ? Effect.fail(cause)
            : input.store
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
    summary,
  } satisfies CommittedBaseResult;
});

export const buildAndActivate = Effect.fn('codeGraph.buildAndActivate')(function* (input: {
  readonly activatePointer: boolean;
  readonly building: CodeGraphSnapshot;
  readonly capacityProtection: DirectPersistentCapacityProtection;
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
  readonly persistentMaterializationTransactionBatchLimit?: 1 | 4;
  readonly persistentOwnerToken?: string;
  readonly requestedOverlay?: {readonly dirty: boolean; readonly fingerprint?: string};
  readonly sparseProjection?: {
    readonly packProvenance: readonly CodeGraphLanguagePackProvenance[];
    readonly totalFiles: number;
  };
  readonly startedAt: number;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
  readonly workspace?: CodeGraphWorkspace;
}) {
  const workspace =
    input.workspace ??
    input.inventory.workspace ??
    (yield* input.languagePacks.discoverWorkspace(input.inventory.files));
  const directPersistentMaterialization = input.persistentOwnerToken !== undefined;
  const protectDirectPersistentWrite = codeGraphDirectPersistentCapacityProtector(input);
  const persistentCapacityGuard = protectDirectPersistentWrite;
  const extractionDiagnostics: string[] = [...workspace.diagnostics];
  let materializedFiles = 0;
  let materializedShardFilesReused = 0;
  let materializedShardCacheDeferredFiles = 0;
  let materializedShardCacheDeferredRawFactBytes = 0;
  let materializedShardAssociationsComplete = directPersistentMaterialization;
  const totalFiles = input.sparseProjection?.totalFiles ?? input.inventory.files.length;
  const packProvenance =
    input.sparseProjection?.packProvenance ??
    input.languagePacks.activePackProvenance(input.inventory.files.map(file => file.path));
  const reusedFiles = totalFiles - input.inventory.parsedFiles;
  const incrementalAssessment =
    input.incrementalAssessment ??
    (input.inventory.dirty ? yield* assessIncrementalOverlay(input, workspace) : undefined);
  let fallbackReason: CodeGraphOverlayFallbackReason | undefined =
    incrementalAssessment?.mode === 'fallback'
      ? incrementalAssessment.reason
      : input.existing !== undefined &&
          input.existing.extractorSet !== input.building.extractorSet &&
          incrementalAssessment?.mode !== 'eligible'
        ? 'extractor-context-changed'
        : undefined;
  let incrementalApplied = false;
  if (incrementalAssessment?.mode === 'eligible') {
    const incrementalReusedFiles = totalFiles - incrementalAssessment.files.length;
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
              {
                deletedPaths: incrementalAssessment.deletedPaths,
                resolutionClosure: incrementalAssessment.resolutionClosure,
              },
              protectDirectPersistentWrite,
            )
          : yield* input.store.replaceStagedModifiedFiles(
              input.layout.databasePath,
              input.committedBase!.snapshot.id,
              incrementalAssessment.files,
              incrementalAssessment.facts,
              protectDirectPersistentWrite,
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
    const attributeFacts = createCachedCodeGraphFactsAttributor(input.inventory.files, workspace);
    const currentGraphContentId = graphContentIdentity(input.building.extractorSet, input.inventory.files);
    const repositorySemanticEnvelope = materializedShardRepositorySemanticEnvelope(input.inventory.files);
    const donorSnapshotIds = shardDonorIds(input.building.id, input.committedBase?.snapshot.id, input.existing?.id);
    const sourceBytesTotal = input.inventory.files.reduce((total, file) => total + file.size, 0);
    const cachedMetadata = yield* cachedFactsMetadata(
      input.store,
      input.layout.databasePath,
      input.inventory.files,
      input.languagePacks,
    );
    if (cachedMetadata.files !== input.inventory.files.length) {
      return yield* Effect.fail(
        new CodeGraphIndexOperationError(
          'Cached code graph facts are incomplete during materialization planning; retry with a full rebuild.',
        ),
      );
    }
    const batches = factMaterializationBatches(input.inventory.files, cachedMetadata.bytesByPath);
    const cachedFactBytesTotal = cachedMetadata.bytes;
    const materializedShardCacheWriteAdmission = codeGraphMaterializedShardCacheWriteAdmission(cachedFactBytesTotal);
    const committedHashesByPath = new Map(input.inventory.committedFiles.map(file => [file.path, file.contentHash]));
    const changedCurrentPaths = new Set(
      input.inventory.files
        .filter(file => committedHashesByPath.get(file.path) !== file.contentHash)
        .map(file => file.path),
    );
    let replayMetrics = emptyMaterializationReplayMetrics();
    let changedFactBytesCompleted: number | undefined = 0;
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
    // Attribution can split a cached-fact batch, so this lower bound converges as batches decode.
    let batchesTotal = batches.length;
    let sourceBytesCompleted = 0;
    let loadingMilliseconds = 0;
    let attributionMilliseconds = 0;
    const materializationSubphases = new MaterializationSubphaseTiming();
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
      ...replayMetrics,
      ...(changedFactBytesCompleted === undefined ? {} : {changedFactBytesCompleted}),
      ...(fallbackReason === undefined ? {} : {fallbackReason}),
      factsBytesCompleted,
      ...(finalFactsBytesTotal === undefined ? {} : {factsBytesTotal: finalFactsBytesTotal}),
      loadingMilliseconds,
      mode: 'full',
      ...(incrementalAssessment?.resolutionPublicationAssessment
        ? {
            resolutionLookupKeyForm: incrementalAssessment.resolutionPublicationAssessment.lookupKeyForm,
            resolutionPublicationGate: incrementalAssessment.resolutionPublicationAssessment.gate,
          }
        : {}),
      rows: materializedRows,
      sourceBytesCompleted,
      sourceBytesTotal,
      stageMilliseconds: {...stageMilliseconds},
      // Only publish cumulative subphase evidence at the terminal update to avoid sustained allocator pressure.
      ...(finalFactsBytesTotal === undefined ? {} : {subphaseMilliseconds: materializationSubphases.snapshot()}),
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
      total: totalFiles,
      unit: 'files',
    }) ?? Effect.void;
    yield* input.store.prepareActivation(
      input.layout.databasePath,
      input.inventory.files,
      directPersistentMaterialization ? input.building.id : undefined,
      undefined,
      input.persistentOwnerToken,
      persistentCapacityGuard,
    );
    yield* input.store.stageWorkspaceCatalog(input.layout.databasePath, workspace, persistentCapacityGuard);
    let persistentBatchCursor = 0;
    const persistentTransactionBatchLimit = input.persistentMaterializationTransactionBatchLimit ?? 4;
    const pendingBatches: PendingMaterializationBatch[] = [];
    const shardWrites = makeCodeGraphMaterializedShardWriteQueue({
      databasePath: input.layout.databasePath,
      onAssociation: elapsed => materializationSubphases.add('shardAssociation', elapsed),
      onCachePersistence: (elapsed, recordInAttribution) => {
        materializationSubphases.add('shardPersistence', elapsed);
        if (!recordInAttribution) return;
        attributionMilliseconds += elapsed;
        stageMilliseconds.attributing = attributionMilliseconds;
      },
      ownerToken: input.persistentOwnerToken!,
      persistentCapacityProtector: protectDirectPersistentWrite,
      snapshotId: input.building.id,
      store: input.store,
      transactionBatchLimit: persistentTransactionBatchLimit,
    });
    const reportStagingProgress = (batch: PendingMaterializationBatch, progress: CodeGraphStagingProgress) => {
      if (progress.temporaryDatabaseBytes !== undefined) {
        temporaryDatabaseBytes = progress.temporaryDatabaseBytes;
        temporaryDatabaseHighWaterBytes = Math.max(temporaryDatabaseHighWaterBytes, progress.temporaryDatabaseBytes);
      }
      if (progress.durableDatabaseBytes !== undefined) {
        durableDatabaseBytes = progress.durableDatabaseBytes;
        durableDatabaseHighWaterBytes = Math.max(durableDatabaseHighWaterBytes, progress.durableDatabaseBytes);
      }
      const activityStage = materializationStagingStage(progress);
      const timingKey = progress.stage === 'committed' ? 'committing' : progress.stage;
      const previousStageMilliseconds = batch.stageMilliseconds.get(timingKey) ?? 0;
      const currentStageMilliseconds = progress.stageElapsedMilliseconds ?? 0;
      const stageDeltaMilliseconds = Math.max(0, currentStageMilliseconds - previousStageMilliseconds);
      batch.stageMilliseconds.set(timingKey, currentStageMilliseconds);
      stageMilliseconds[activityStage] = (stageMilliseconds[activityStage] ?? 0) + stageDeltaMilliseconds;
      batch.rows = materializationRowsWithStoreProgress(batch.rows, progress);
      return refreshStorageFiles(progress.stage === 'committed').pipe(
        Effect.andThen(
          input.onProgress?.({
            activity: {
              batchCompleted: batch.batchIndex,
              batchTotal: batchesTotal,
              cachedFactBytes: batch.batchCachedFactBytes,
              elapsedMilliseconds: progress.elapsedMilliseconds,
              factsBytes: batch.factBytes,
              rows: batch.rows,
              sourceBytes: batch.sourceBytes,
              stage: activityStage,
              stageElapsedMilliseconds: currentStageMilliseconds,
              transactionMilliseconds: progress.elapsedMilliseconds,
            },
            completed: materializedFiles,
            metrics: metrics(),
            phase: 'materializing',
            reused: reusedFiles,
            total: totalFiles,
            unit: 'files',
          }) ?? Effect.void,
        ),
        Effect.catch(() => Effect.void),
      );
    };
    const flushPendingBatches = () =>
      Effect.gen(function* () {
        yield* shardWrites.flushCaches();
        if (pendingBatches.length === 0) return;
        const group = pendingBatches.splice(0, pendingBatches.length);
        const groupByIndex = new Map(group.map(batch => [batch.batchIndex, batch]));
        const transactionStartedAt = yield* Clock.currentTimeMillis;
        if (directPersistentMaterialization) {
          yield* input.store.stageActivationFactBatches(
            input.layout.databasePath,
            group.map(batch => ({
              batchIndex: batch.batchIndex,
              edges: batch.edges,
              finalFactBytes: batch.factBytes,
              monikers: batch.monikers,
              references: batch.references,
              symbols: batch.symbols,
            })),
            (batchIndex, progress) => reportStagingProgress(groupByIndex.get(batchIndex)!, progress),
            persistentCapacityGuard,
          );
        } else {
          for (const batch of group) {
            yield* input.store.stageActivationFacts(
              input.layout.databasePath,
              batch.symbols,
              batch.edges,
              batch.references,
              progress => reportStagingProgress(batch, progress),
              batch.batchIndex,
              persistentCapacityGuard,
              batch.monikers,
            );
          }
        }
        const groupTransactionMilliseconds = (yield* Clock.currentTimeMillis) - transactionStartedAt;
        transactionMilliseconds += groupTransactionMilliseconds;
        for (let index = 0; index < group.length; index += 1) {
          const batch = group[index]!;
          const accountedTransactionMilliseconds = index === group.length - 1 ? groupTransactionMilliseconds : 0;
          materializedFiles += batch.fileCount;
          batchesCompleted += 1;
          sourceBytesCompleted += batch.sourceBytes;
          cachedFactBytesCompleted += batch.batchCachedFactBytes;
          factsBytesCompleted += batch.factBytes;
          materializedRows = addMaterializationRows(materializedRows, batch.rows);
          yield* input.onProgress?.({
            activity: {
              batchCompleted: batch.batchIndex,
              batchTotal: batchesTotal,
              cachedFactBytes: batch.batchCachedFactBytes,
              elapsedMilliseconds:
                batch.loadingMilliseconds + batch.attributionMilliseconds + accountedTransactionMilliseconds,
              factsBytes: batch.factBytes,
              rows: batch.rows,
              sourceBytes: batch.sourceBytes,
              stage: 'committing',
              transactionMilliseconds: accountedTransactionMilliseconds,
            },
            completed: materializedFiles,
            metrics: metrics(),
            phase: 'materializing',
            reused: reusedFiles,
            total: totalFiles,
            unit: 'files',
          }) ?? Effect.void;
        }
      });
    for (const files of batches) {
      const shardDerivationIdentity = materializedBatchShardDerivationIdentity(
        input.building.extractorSet,
        workspace.fingerprint,
        repositorySemanticEnvelope,
        files,
      );
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
        total: totalFiles,
        unit: 'files',
      }) ?? Effect.void;
      const loadingStartedAt = yield* Clock.currentTimeMillis;
      // Attribution may inspect peer facts in this deterministic source batch (for example, TypeScript barrels).
      // Reuse only a complete batch so a hit/miss partition cannot become a persisted derivation input.
      const materializedShards = directPersistentMaterialization
        ? yield* input.store.loadMaterializedFileShards(
            input.layout.databasePath,
            files,
            input.building.extractorSet,
            shardDerivationIdentity,
            {currentGraphContentId, snapshotIds: donorSnapshotIds},
          )
        : {
            bytes: 0,
            bytesByPath: new Map<string, number>(),
            exactGenerationFiles: 0,
            facts: new Map(),
            materializedShardIdsByPath: new Map<string, string>(),
          };
      const exactGenerationShardFiles = materializedShards.exactGenerationFiles;
      const materializedShardBatchComplete =
        directPersistentMaterialization &&
        exactGenerationShardFiles !== undefined &&
        Number.isSafeInteger(exactGenerationShardFiles) &&
        exactGenerationShardFiles >= 0 &&
        exactGenerationShardFiles <= files.length &&
        materializedShards.facts.size === files.length &&
        materializedShards.materializedShardIdsByPath?.size === files.length;
      const fallbackFiles = materializedShardBatchComplete ? [] : files;
      const cached = yield* loadCachedFacts(input.store, input.layout.databasePath, fallbackFiles, input.languagePacks);
      const materializedShardCacheBatchPlan = codeGraphMaterializedShardCacheBatchPlan(
        materializedShardCacheWriteAdmission,
        materializedShardBatchComplete,
      );
      const deferMaterializedShardCache =
        directPersistentMaterialization && !materializedShardCacheBatchPlan.associationsComplete;
      // Count valid final-shard decodes even when an incomplete batch falls back to raw facts.
      const batchReplayBytes = Math.min(Number.MAX_SAFE_INTEGER, materializedShards.bytes + cached.bytes);
      replayMetrics = addMaterializationReplayMetrics(replayMetrics, {
        crossGenerationShardFiles: materializedShardBatchComplete ? files.length - exactGenerationShardFiles : 0,
        exactGenerationShardFiles: materializedShardBatchComplete ? exactGenerationShardFiles : 0,
        materializedShardReplayBytes: materializedShards.bytes,
        rawFactReplayBytes: cached.bytes,
      });
      // Changed-fact bytes measure the selected representation, not every physical cache decode.
      const batchChangedFactBytes = selectedDecodedFactBytes(
        materializedShardBatchComplete ? materializedShards.bytesByPath : cached.bytesByPath,
        files.filter(file => changedCurrentPaths.has(file.path)).map(file => file.path),
      );
      changedFactBytesCompleted =
        changedFactBytesCompleted === undefined || batchChangedFactBytes === undefined
          ? undefined
          : Math.min(Number.MAX_SAFE_INTEGER, changedFactBytesCompleted + batchChangedFactBytes);
      const batchLoadingMilliseconds = (yield* Clock.currentTimeMillis) - loadingStartedAt;
      loadingMilliseconds += batchLoadingMilliseconds;
      stageMilliseconds['loading-cache'] = loadingMilliseconds;
      if (fallbackFiles.some(file => !cached.facts.has(file.path))) {
        return yield* Effect.fail(
          new CodeGraphIndexOperationError(
            'A cached code graph fact disappeared during indexing; retry with a full rebuild.',
          ),
        );
      }
      yield* input.onProgress?.({
        activity: {
          batchCompleted: batchesCompleted,
          batchTotal: batchesTotal,
          cachedFactBytes: batchReplayBytes,
          elapsedMilliseconds: batchLoadingMilliseconds,
          sourceBytes,
          stage: 'attributing',
        },
        completed: materializedFiles,
        metrics: metrics(),
        phase: 'materializing',
        reused: reusedFiles,
        total: totalFiles,
        unit: 'files',
      }) ?? Effect.void;
      const attributionStartedAt = yield* Clock.currentTimeMillis;
      let flushShardCacheAfterAttribution = false;
      const attributedFallbackFacts = materializationSubphases.measure('attributionCompute', () =>
        attributeFacts(
          fallbackFiles.map(file => input.languagePacks.postprocessFile(file, cached.facts.get(file.path)!)),
        ),
      );
      replayMetrics = addMaterializationReplayMetrics(replayMetrics, {
        attributedFiles: fallbackFiles.length,
        materializedShardCacheDeferredFiles: deferMaterializedShardCache ? fallbackFiles.length : 0,
        materializedShardCacheDeferredRawFactBytes: deferMaterializedShardCache ? cached.bytes : 0,
      });
      materializedShardCacheDeferredFiles = replayMetrics.materializedShardCacheDeferredFilesCompleted;
      materializedShardCacheDeferredRawFactBytes = replayMetrics.materializedShardCacheDeferredRawFactBytesCompleted;
      if (
        fallbackFiles.length > 0 &&
        directPersistentMaterialization &&
        materializedShardCacheBatchPlan.cacheFallback
      ) {
        const serializedFallbackFacts = materializationSubphases.measure('shardSerialization', () =>
          attributedFallbackFacts.map(fact => serializeBoundedCodeGraphFact(fact)),
        );
        flushShardCacheAfterAttribution = shardWrites.enqueueCache({
          derivationIdentity: shardDerivationIdentity,
          extractorSet: input.building.extractorSet,
          facts: serializedFallbackFacts,
          files: fallbackFiles,
        });
      }
      if (directPersistentMaterialization && materializedShardCacheBatchPlan.associate) {
        const selectedShardIds = materializedShardBatchComplete
          ? materializedShards.materializedShardIdsByPath!
          : new Map(
              files.map(file => [
                file.path,
                materializedFileShardIdentity(
                  file.contentHash,
                  input.building.extractorSet,
                  shardDerivationIdentity,
                  file.path,
                ),
              ]),
            );
        const flushShardAssociations = shardWrites.enqueueAssociation({
          derivationIdentity: shardDerivationIdentity,
          extractorSet: input.building.extractorSet,
          files,
          selectedShardIds,
        });
        if (flushShardAssociations) {
          // This physical work is already captured by the batch-local attribution timer.
          yield* shardWrites.flushAssociations(false);
        }
      } else if (directPersistentMaterialization && !materializedShardCacheBatchPlan.associationsComplete) {
        materializedShardAssociationsComplete = false;
      }
      const attributedFallbackByPath = new Map(attributedFallbackFacts.map(fact => [fact.path, fact]));
      const facts = files.map(file =>
        materializedShardBatchComplete
          ? materializedShards.facts.get(file.path)!
          : attributedFallbackByPath.get(file.path)!,
      );
      materializedShardFilesReused += materializedShardBatchComplete ? files.length : 0;
      const batchAttributionMilliseconds = (yield* Clock.currentTimeMillis) - attributionStartedAt;
      attributionMilliseconds += batchAttributionMilliseconds;
      stageMilliseconds.attributing = attributionMilliseconds;
      if (flushShardCacheAfterAttribution) yield* shardWrites.flushCaches();
      const finalBatchPreparationStartedAt = performance.now();
      const finalBatches = finalCodeGraphFactBatches(facts);
      materializationSubphases.add('factBatchPreparation', performance.now() - finalBatchPreparationStartedAt);
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
        const rowPreparationStartedAt = performance.now();
        const finalBatch = finalBatches[finalBatchIndex]!;
        const finalFacts = finalBatch.map(value => value.facts);
        const batchFinalFactBytes = finalBatch.reduce((total, value) => total + value.bytes, 0);
        const batchFiles = finalFacts.map(fact => filesByPath.get(fact.path)!);
        const batchSourceBytes = batchFiles.reduce((total, file) => total + file.size, 0);
        const batchCachedFactBytes = batchFiles.reduce(
          (total, file) => total + (cachedMetadata.bytesByPath.get(file.path) ?? 0),
          0,
        );
        const symbols = uniqueById(finalFacts.flatMap(file => file.symbols));
        const relationships = deduplicateMaterializationRelationships(
          finalFacts.flatMap(file => file.edges),
          finalFacts.flatMap(file => file.references ?? []),
        );
        const edges = relationships.edges;
        const references = relationships.references;
        const monikers = canonicalCodeGraphMonikers(finalFacts.flatMap(file => file.monikers ?? []));
        const rows = materializationRows(symbols, edges.length, references, {
          edges: relationships.duplicateEdges,
          references: relationships.duplicateReferences,
        });
        materializationSubphases.add('factBatchPreparation', performance.now() - rowPreparationStartedAt);
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
          total: totalFiles,
          unit: 'files',
        }) ?? Effect.void;
        const candidate: PendingMaterializationBatch = {
          attributionMilliseconds: finalBatchIndex === 0 ? batchAttributionMilliseconds : 0,
          batchCachedFactBytes,
          batchFiles,
          batchIndex: persistentBatchCursor,
          edges,
          factBytes: batchFinalFactBytes,
          fileCount: batchFiles.length,
          loadingMilliseconds: finalBatchIndex === 0 ? batchLoadingMilliseconds : 0,
          monikers,
          references,
          rows,
          sourceBytes: batchSourceBytes,
          stageMilliseconds: new Map(),
          symbols,
        };
        if (
          directPersistentMaterialization &&
          persistentMaterializationTransactionBatches([...pendingBatches, candidate], persistentTransactionBatchLimit)
            .length > 1
        ) {
          yield* flushPendingBatches();
        }
        pendingBatches.push(candidate);
        persistentBatchCursor += 1;
        const pendingFactsBytes = pendingBatches.reduce((total, batch) => total + batch.factBytes, 0);
        const pendingFiles = pendingBatches.reduce((total, batch) => total + batch.fileCount, 0);
        const pendingSourceBytes = pendingBatches.reduce((total, batch) => total + batch.sourceBytes, 0);
        if (
          !directPersistentMaterialization ||
          pendingBatches.length >= persistentTransactionBatchLimit ||
          pendingFiles >= PERSISTENT_MATERIALIZATION_TRANSACTION_FILES ||
          pendingSourceBytes >= PERSISTENT_MATERIALIZATION_TRANSACTION_SOURCE_BYTES ||
          pendingFactsBytes >= PERSISTENT_MATERIALIZATION_TRANSACTION_FACT_BYTES
        ) {
          yield* flushPendingBatches();
        }
      }
    }
    yield* flushPendingBatches();
    yield* shardWrites.flushCaches();
    yield* shardWrites.flushAssociations();
    batchesTotal = persistentBatchCursor;
    if (directPersistentMaterialization) {
      yield* input.store.finalizePersistentMaterializationPlan(
        input.layout.databasePath,
        persistentBatchCursor,
        persistentCapacityGuard,
        secondaryIndexRestorationReporter({
          batchCompleted: batchesCompleted,
          batchTotal: batchesTotal,
          completed: materializedFiles,
          metrics,
          onProgress: input.onProgress,
          refreshStorageFiles: () => refreshStorageFiles(true),
          reused: reusedFiles,
          stageMilliseconds,
          total: totalFiles,
        }),
      );
    }
    yield* input.onProgress?.({
      completed: materializedFiles,
      metrics: metrics(factsBytesCompleted),
      phase: 'materializing',
      reused: reusedFiles,
      total: totalFiles,
      unit: 'files',
    }) ?? Effect.void;
  }
  const reusableBaseReceipt = incrementalApplied
    ? undefined
    : {
        fileSetFingerprint: reusableBaseFileSetFingerprint(input.inventory.files),
        ...(input.inventory.reuseReceipt ? {inventory: {...input.inventory.reuseReceipt, workspace}} : {}),
        packProvenance,
        workspaceFingerprint: workspace.fingerprint,
      };
  yield* input.onProgress?.({phase: 'resolving', subphase: 'references'}) ?? Effect.void;
  const resolution = yield* input.store.resolveStagedReferences(
    input.layout.databasePath,
    activity =>
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
    persistentCapacityGuard,
  );
  const stagedCounts = yield* input.store.stagedFactCounts(input.layout.databasePath);
  yield* input.onProgress?.({
    edges: stagedCounts.edges,
    phase: 'resolving',
    resolved: resolution.resolved,
    subphase: 'complete',
    symbols: stagedCounts.symbols,
  }) ?? Effect.void;
  yield* input.store.shrinkMemory(input.layout.databasePath);
  const ready: CodeGraphSnapshot = {
    ...input.building,
    edgeCount: stagedCounts.edges,
    fileCount: totalFiles,
    state: 'ready',
    symbolCount: stagedCounts.symbols,
  };
  yield* input.onProgress?.({phase: 'activating', snapshotId: ready.id, subphase: 'validating-input'}) ?? Effect.void;
  yield* verifyIndexInput(input.identity, input.activatePointer, input.threadnoteHome, input.requestedOverlay);
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
        reusableBaseReceipt,
        CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS,
        activity =>
          (
            input.onProgress?.({
              activity,
              phase: 'activating',
              snapshotId: ready.id,
            }) ?? Effect.void
          ).pipe(Effect.catch(() => Effect.void)),
        persistentCapacityGuard,
        packProvenance,
        directPersistentMaterialization && !incrementalApplied && materializedShardAssociationsComplete,
      ),
      lease =>
        Option.match(lease, {
          onNone: () => Effect.void,
          onSome: token =>
            input.store.releaseSnapshotLease(input.layout.databasePath, token).pipe(Effect.catch(() => Effect.void)),
        }),
    );
    const activated = yield* input.store.currentLexicalReadySnapshotById(input.layout.databasePath, ready.id);
    if (!activated) {
      return yield* Effect.fail(
        new CodeGraphIndexOperationError('Activated code graph snapshot could not be read back from its store.'),
      );
    }
    yield* input.store.shrinkMemory(input.layout.databasePath);
    if (input.activatePointer) {
      yield* input.onProgress?.({phase: 'activating', snapshotId: activated.id, subphase: 'promoting'}) ?? Effect.void;
      // Progress callbacks may yield long enough for the worktree to change. Revalidate on both sides of
      // pointer promotion so a mutation in this window triggers the bounded retry.
      yield* verifyCommittedIndexInput({
        databasePath: input.layout.databasePath,
        identity: input.identity,
        requestedOverlay: input.requestedOverlay,
        snapshotId: activated.id,
        store: input.store,
        threadnoteHome: input.threadnoteHome,
      });
      yield* input.store.promote(input.layout.databasePath, input.identity, activated.id, {
        persistentCapacityProtector: protectDirectPersistentWrite,
      });
      yield* input.store.shrinkMemory(input.layout.databasePath);
      yield* input.onProgress?.({phase: 'activating', snapshotId: activated.id, subphase: 'promoting'}) ?? Effect.void;
      yield* verifyCommittedIndexInput({
        databasePath: input.layout.databasePath,
        identity: input.identity,
        requestedOverlay: input.requestedOverlay,
        snapshotId: activated.id,
        store: input.store,
        threadnoteHome: input.threadnoteHome,
      });
      if (Option.isSome(activationLease)) {
        yield* input.store.releaseSnapshotLease(input.layout.databasePath, activationLease.value);
      }
    }
    if (input.committedBase && Option.isSome(input.committedBase.leaseToken)) {
      yield* input.store.releaseSnapshotLease(input.layout.databasePath, input.committedBase.leaseToken.value);
    }
    yield* input.onProgress?.({
      phase: 'activating',
      snapshotId: activated.id,
      subphase: input.activatePointer ? 'structural-ready' : 'complete',
    }) ?? Effect.void;
    return activated;
  });
  let analysisSummaryFailure: string | undefined;
  const analysisSummaryBackfilled =
    input.activatePointer && !activatedReady.dirty
      ? yield* prepareReadyAnalysisSummary({
          databasePath: input.layout.databasePath,
          onProgress: input.onProgress,
          snapshotId: activatedReady.id,
          store: input.store,
        }).pipe(
          Effect.catch(cause =>
            Effect.sync(() => {
              analysisSummaryFailure = messageOf(cause);
              return false;
            }),
          ),
        )
      : yield* (
          input.onProgress?.({
            phase: 'activating',
            snapshotId: activatedReady.id,
            subphase: 'complete',
          }) ?? Effect.void
        ).pipe(Effect.as(false));
  const embedding = input.ensureVectors
    ? yield* input.embedding
        .ensure(
          input.threadnoteHome,
          input.layout,
          activatedReady,
          embeddingSymbolSource(input.store, input.layout.databasePath, activatedReady.id),
          {
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
      ...(input.inventory.diagnostics ?? []),
      ...extractionDiagnostics,
      ...(input.inventory.dirty
        ? [
            incrementalApplied
              ? incrementalAssessment?.mode === 'eligible' && incrementalAssessment.reuse === 'persisted-base'
                ? `Dirty overlay reused persisted clean base for ${materializedFiles.toLocaleString()} modified file(s).`
                : `Dirty overlay reused clean staging for ${materializedFiles.toLocaleString()} modified file(s).`
              : `Dirty overlay used full materialization: ${overlayFallbackDescription(fallbackReason ?? 'staging-unavailable')}.`,
          ]
        : incrementalApplied
          ? [`Clean snapshot reused persisted base for ${materializedFiles.toLocaleString()} modified file(s).`]
          : []),
      ...(materializedShardFilesReused > 0
        ? [`Reused content-addressed materialized shards for ${materializedShardFilesReused.toLocaleString()} file(s).`]
        : []),
      ...(materializedShardCacheDeferredFiles > 0
        ? [
            `Deferred derived materialized-shard caching for ${materializedShardCacheDeferredFiles.toLocaleString()} ` +
              `file(s) covering ${materializedShardCacheDeferredRawFactBytes.toLocaleString()} raw fact byte(s).`,
          ]
        : []),
      ...(analysisSummaryBackfilled ? ['Built the persisted whole-graph analysis summary after promotion.'] : []),
      ...(analysisSummaryFailure
        ? [`Whole-graph analysis summary will be retried lazily: ${analysisSummaryFailure}`]
        : []),
      ...(embedding.ready ? [] : [`Vector graph retrieval unavailable: ${embedding.reason ?? 'unknown reason'}`]),
    ].slice(0, 100),
    durationMs: (yield* Clock.currentTimeMillis) - input.startedAt,
    identity: input.identity,
    ...(incrementalApplied && incrementalAssessment?.mode === 'eligible'
      ? {incrementalWork: incrementalAssessment.work}
      : {}),
    materialization: {
      ...(incrementalApplied && incrementalAssessment?.mode === 'eligible'
        ? {
            ...(incrementalAssessment.closureProjects === undefined
              ? {}
              : {closureProjects: incrementalAssessment.closureProjects}),
            ...(incrementalAssessment.resolutionClosure === undefined
              ? {}
              : {resolutionClosure: incrementalAssessment.resolutionClosure}),
          }
        : {}),
      ...(fallbackReason ? {fallbackReason} : {}),
      ...(incrementalAssessment?.resolutionPublicationAssessment
        ? {
            resolutionLookupKeyForm: incrementalAssessment.resolutionPublicationAssessment.lookupKeyForm,
            resolutionPublicationGate: incrementalAssessment.resolutionPublicationAssessment.gate,
          }
        : {}),
      mode: incrementalApplied ? (input.inventory.dirty ? 'incremental-overlay' : 'incremental-clean') : 'full',
      stagedFiles: materializedFiles,
      totalFiles,
    },
    reusedFiles,
    skippedFiles: input.inventory.skipped,
    snapshot: activatedReady,
  } satisfies CodeGraphIndexSummary;
});
