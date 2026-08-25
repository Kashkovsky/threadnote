import {Console, Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {startProgress} from '../cli_ui.js';
import {writeFinalCliOutput} from '../effect/cli_output.js';
import {SystemInfo} from '../effect/system.js';
import type {RuntimeConfig} from '../types.js';
import {CodeGraphIndexer, materializationStorageShortfalls} from './indexer.js';
import {makeCodeGraphJsonProgressReporter} from './json_progress.js';
import {codeGraphLayout} from './layout.js';
import {CodeGraphMaintenanceCoordinator} from './maintenance_coordinator.js';
import {
  repairCodeGraphIndexes,
  inspectObsoleteCodeGraphStores,
  purgeAllCodeGraphIndexes,
  purgeCodeGraphIndex,
  purgeObsoleteCodeGraphStores,
  type CodeGraphMaintenanceProgress,
  type CodeGraphRepairCompletion,
  type ObsoleteCodeGraphStoreInventory,
} from './maintenance.js';
import {CodeGraphQueryService, observationFromCodeGraphStatus, renderCodeGraphResult} from './query.js';
import {repositoryChangesSince, repositoryIdentityMatchesExpectation, resolveRepositoryIdentity} from './repository.js';
import {CodeGraphStore} from './store.js';
import type {
  CodeGraphProgress,
  CodeGraphQueryOptions,
  CodeGraphStatus,
  RepositoryIdentityExpectation,
} from './types.js';
import {CodeGraphWatcher} from './watcher.js';
import {
  findCodeGraphWorksetPath,
  inspectCodeGraphWorksetTopology,
  traceCodeGraphWorksetImpact,
  type CodeGraphWorksetTopologyResultV1,
} from './cross_repository/runtime.js';
import type {CodeGraphCrossRepositoryTraversalResultV1} from './cross_repository/traversal.js';
import {
  continueCodeGraphWorksetQueryV2,
  queryCodeGraphWorksetV2,
  resolveCodeGraphQualifiedRefTarget,
} from './workset_query_v2.js';
import {
  inspectCodeGraphWorksetStatus,
  prepareCodeGraphWorkset,
  type CodeGraphWorksetPrepareResultV1,
  type CodeGraphWorksetStatusResultV1,
} from './workset_catalog/workset.js';
import {makeCodeGraphWorksetJsonProgressReporter} from './workset_progress.js';
import {CodeGraphAnalysis} from './analysis.js';
import {
  codeGraphAnalysisLimitsForView,
  renderCodeGraphAnalysis,
  renderCodeGraphReport,
  type CodeGraphAnalysisView,
} from './analysis_render.js';
import {
  renderCodeGraphCliAnalysisState,
  resolveCodeGraphAnalysisSnapshot,
  type CodeGraphCliAnalysisState,
} from './analysis_cli.js';
import {
  CODE_GRAPH_CLI_READ_RETRY_MILLISECONDS,
  CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS,
  codeGraphCliReadPlan,
  type CodeGraphCliFreshnessPolicy,
  type CodeGraphCliReadPlan,
} from './cli_freshness.js';
import {exportCodeGraph, type CodeGraphExportFormat, type CodeGraphExportLimit} from './export.js';
import {
  readCodeGraphBuildStatuses,
  selectCodeGraphBuildStatuses,
  type ObservedCodeGraphBuildStatus,
} from './build_status.js';
import {compactCodeGraphStorage, inspectCodeGraphStorage, type CodeGraphStorage} from './storage.js';
import {inspectAllCodeGraphsLocal, renderCodeGraphDiagnostics} from './diagnostics.js';
import {previewCodeGraphInventory, type CodeGraphInventoryPreview} from './inventory.js';
import {
  codeGraphViewRemovalTargetFailure,
  removeCodeGraphView,
  renderCodeGraphViewRemovalResult,
  serializeCodeGraphViewRemovalResult,
} from './view_removal.js';
import {
  codeGraphSnapshotPurgeTargetFailure,
  purgeCodeGraphSnapshot,
  renderCodeGraphSnapshotPurgeResult,
  serializeCodeGraphSnapshotPurgeResult,
} from './snapshot_purge.js';

interface CwdOption {
  readonly cwd?: string;
}

export {CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS, codeGraphCliReadPlan};
export type {CodeGraphCliFreshnessPolicy, CodeGraphCliReadPlan};

class CodeGraphCommandError extends Error {
  readonly _tag = 'CodeGraphCommandError' as const;
}

export function defaultCodeGraphCliFreshness(
  operation: CodeGraphQueryOptions['operation'],
): Exclude<CodeGraphCliFreshnessPolicy, 'allow-stale'> {
  return operation === 'impact' || operation === 'path' ? 'current' : 'ready';
}

interface CodeGraphCliReadState {
  readonly budgetMilliseconds?: number;
  readonly freshness: CodeGraphStatus['freshness'];
  readonly freshnessPolicy: CodeGraphCliFreshnessPolicy;
  readonly operation: CodeGraphQueryOptions['operation'];
  readonly reason: 'no-ready-snapshot' | 'read-timeout';
  readonly repository: {
    readonly displayName: string;
    readonly repositoryId: string;
  };
  readonly retryAfterMilliseconds: number;
  readonly snapshot?: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly id: string;
  };
  readonly state: 'timed-out' | 'unavailable';
  readonly type: 'code-graph-query-state';
  readonly version: 1;
}

function codeGraphCliReadState(
  status: CodeGraphStatus,
  policy: CodeGraphCliFreshnessPolicy,
  operation: CodeGraphQueryOptions['operation'],
  reason: CodeGraphCliReadState['reason'],
  budgetMilliseconds?: number,
): CodeGraphCliReadState {
  return {
    ...(budgetMilliseconds === undefined ? {} : {budgetMilliseconds}),
    freshness: status.freshness,
    freshnessPolicy: policy,
    operation,
    reason,
    repository: {
      displayName: status.identity.displayName,
      repositoryId: status.identity.repositoryId,
    },
    retryAfterMilliseconds: CODE_GRAPH_CLI_READ_RETRY_MILLISECONDS,
    ...(status.readySnapshot
      ? {
          snapshot: {
            commit: status.readySnapshot.commit,
            dirty: status.readySnapshot.dirty,
            id: status.readySnapshot.id,
          },
        }
      : {}),
    state: reason === 'read-timeout' ? 'timed-out' : 'unavailable',
    type: 'code-graph-query-state',
    version: 1,
  };
}

function renderCodeGraphCliReadState(state: CodeGraphCliReadState): string {
  if (state.state === 'unavailable') {
    return (
      'No ready code graph snapshot is available. Retry after indexing, or use --freshness ready/current to allow ' +
      'this command to start a bounded refresh.\n'
    );
  }
  const readyHint =
    state.snapshot === undefined
      ? ''
      : ' A ready snapshot remains available; retry with --freshness ready to inspect it without waiting.';
  return (
    `Code graph ${state.freshnessPolicy} read exceeded Threadnote's ` +
    `${(state.budgetMilliseconds ?? CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS) / 1_000}-second foreground budget.${readyHint}\n`
  );
}

interface ExpectedRepositoryIdentityOption {
  readonly expectedIdentity?: RepositoryIdentityExpectation;
}

export interface CodeGraphExportInterlock {
  readonly afterOutputCheck?: () => Effect.Effect<void>;
  readonly beforeLink?: (temporaryPath: string) => Effect.Effect<void>;
  readonly beforePublish?: (temporaryPath: string) => Effect.Effect<void>;
}

export const runCodeGraphRepair = Effect.fn('codeGraph.command.repair')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly all?: boolean;
    readonly checkoutId?: string;
    readonly deep?: boolean;
    readonly dryRun?: boolean;
    readonly json?: boolean;
  },
) {
  if (options.all && (options.checkoutId !== undefined || options.cwd !== undefined)) {
    return yield* Effect.fail(new CodeGraphCommandError('Use --all by itself, without --checkout-id or --cwd.'));
  }
  if (options.checkoutId !== undefined && options.cwd !== undefined) {
    return yield* Effect.fail(new CodeGraphCommandError('Use either --checkout-id or --cwd, not both.'));
  }
  const targetCheckoutId = options.all
    ? undefined
    : (options.checkoutId ?? (yield* resolveRepositoryIdentity(yield* commandCwd(options.cwd))).checkoutId);
  let completion: CodeGraphRepairCompletion | undefined;
  const summary = yield* repairCodeGraphIndexes(
    config.agentContextHome,
    options.dryRun === true,
    options.json
      ? undefined
      : progress => Console.log(codeGraphRepairProgressMessage(progress, options.dryRun === true)),
    result => Effect.sync(() => void (completion = result)),
    {migrateSchema: true, mode: options.deep ? 'deep' : 'quick', targetCheckoutId},
  );
  if (options.json) {
    yield* writeFinalCliOutput(
      JSON.stringify({
        doctor: completion?.doctorCheck ?? null,
        ...(targetCheckoutId === undefined ? {all: true} : {checkoutId: targetCheckoutId}),
        dryRun: options.dryRun === true,
        mode: options.deep ? 'deep' : 'quick',
        summary,
        type: 'code-graph-repair',
        version: 1,
      }),
    );
    return;
  }
  yield* Console.log(
    `${options.dryRun ? 'Would repair' : 'Repaired'} ${summary.databases} native code graph database(s): ` +
      `${summary.migratedDatabases} schema migration(s), ${summary.deferredDatabases} deferred, ` +
      `${summary.discarded} disposable rebuild(s), ${summary.removedIncompleteSnapshots} incomplete snapshot(s), ` +
      `${summary.removedTemporaryFiles} temporary vector file(s).`,
  );
  if (completion) {
    yield* Console.log(
      `${completion.doctorCheck.status.toUpperCase()} native code graph: ${completion.doctorCheck.detail}`,
    );
  }
});

export const runCodeGraphDiagnostics = Effect.fn('codeGraph.command.diagnostics')(function* (
  config: RuntimeConfig,
  options: {readonly analyze?: boolean; readonly deep?: boolean; readonly json?: boolean},
) {
  const report = yield* inspectAllCodeGraphsLocal(config.agentContextHome, {
    analyze: options.analyze,
    deep: options.deep,
    onProgress: options.json
      ? undefined
      : progress =>
          Console.log(
            `${progress.phase === 'analyzing' ? 'Analyzing' : options.deep ? 'Deep-checking' : 'Checking'} native code graph database ${progress.current}/${progress.total}.`,
          ),
  });
  yield* writeFinalCliOutput(options.json ? JSON.stringify(report) : renderCodeGraphDiagnostics(report).trimEnd());
});

function codeGraphRepairProgressMessage(progress: CodeGraphMaintenanceProgress, dryRun: boolean): string {
  const database = `native code graph database ${progress.current}/${progress.total}`;
  switch (progress.phase) {
    case 'checking':
      return `Checking ${database}.`;
    case 'migrating-schema':
      return `${dryRun ? 'Would migrate' : 'Migrating'} the persistent schema for ${database}.`;
    case 'cleaning-snapshots':
      return `${dryRun ? 'Would clean' : 'Cleaning'} ${progress.snapshots ?? 0} incomplete snapshot(s) from ${database}.`;
    case 'cleaning-vectors':
      return `Checking temporary vector state for ${database}.`;
    case 'discarding':
      return `${dryRun ? 'Would discard' : 'Discarding'} unreadable derived ${database}.`;
    case 'deferred':
      if (progress.reason === 'active-build') {
        return `Deferred ${database}: an active graph build owns the checkout.`;
      }
      if (progress.reason === 'schema-upgrade-on-use') {
        return `Deferred ${database}: ready snapshots remain usable while background schema migration retries.`;
      }
      return `Deferred ${database}: rerun with --deep when a full derived-store check is convenient.`;
  }
}

interface CodeGraphExportTemporaryIdentity {
  readonly birthtimeMilliseconds: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly modifiedAtMilliseconds: number;
  readonly size: bigint;
}

export const runCodeGraphStatus = Effect.fn('codeGraph.command.status')(function* (
  config: RuntimeConfig,
  options: CwdOption & {readonly json?: boolean},
) {
  const cwd = yield* commandCwd(options.cwd);
  const path = yield* Path.Path;
  const query = yield* CodeGraphQueryService;
  const ready = yield* query.status(config.agentContextHome, cwd);
  const identity = ready.identity;
  const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
  const obsoleteStores = yield* inspectObsoleteCodeGraphStores(config.agentContextHome, identity.checkoutId);
  const storage = yield* inspectCodeGraphStorage(config.agentContextHome, identity.checkoutId);
  const selection = selectCodeGraphBuildStatuses(yield* readCodeGraphBuildStatuses(layout));
  const buildStatuses = selection.builds;
  const current =
    buildStatuses.find(status => status.identity.worktreeId === identity.worktreeId) ??
    buildStatuses.find(status => status.observation.liveness === 'active');
  const queuedWorktreeIds = [...new Set(selection.waiters.map(status => status.identity.worktreeId))];
  if (options.json) {
    yield* writeFinalCliOutput(
      JSON.stringify({
        build: current ?? null,
        builds: buildStatuses,
        databasePath: layout.databasePath,
        identity,
        languagePacks: ready.languagePacks,
        obsoleteStores,
        queuedWorktreeIds,
        readySnapshot: ready.readySnapshot ?? null,
        stale: ready.stale,
        storage,
        type: 'code-graph-status',
        version: 2,
        waiterCount: selection.waiters.length,
        waiters: selection.waiters,
      }),
    );
    return;
  }
  if (current !== undefined) {
    yield* Console.log(`Repository: ${identity.displayName}`);
    yield* Console.log(`Database: ${layout.databasePath}`);
    yield* renderObsoleteStoreStatus(obsoleteStores);
    yield* renderActiveStorageStatus(storage);
    if (!current) {
      yield* Console.log(`Build status: ${buildStatuses.length} other worktree build(s) observed.`);
      yield* renderReadySnapshotStatus(ready);
      return;
    }
    yield* Console.log(
      `Build: ${current.state} · ${current.observation.liveness}${current.coordination?.progressSilent ? ' (progress silent)' : ''} · ${current.phase}/${current.subphase ?? 'unknown'}`,
    );
    yield* Console.log(
      `Owner: PID ${current.owner.processId} · Bun ${current.owner.runtimeVersion} · ` +
        `heartbeat ${formatStatusDuration(current.observation.heartbeatAgeMilliseconds)} ago`,
    );
    const counters = renderBuildCounters(current);
    if (counters) yield* Console.log(`Progress: ${counters}`);
    if (current.activity) {
      const activity = current.activity;
      const details = [
        `${activity.stage} ${activity.language}`,
        formatBytes(activity.bytes),
        `batch ${activity.batchCompleted}/${activity.batchTotal}`,
        activity.parseMilliseconds === undefined
          ? undefined
          : `parse ${formatMilliseconds(activity.parseMilliseconds)}`,
        activity.persistMilliseconds === undefined
          ? undefined
          : `persist ${formatMilliseconds(activity.persistMilliseconds)}`,
        activity.degraded ? 'metadata fallback' : undefined,
      ].filter((value): value is string => value !== undefined);
      yield* Console.log(`Current activity: ${details.join(' · ')}`);
    }
    if (current.materialization?.activity) {
      const activity = current.materialization.activity;
      const details = [
        materializationStageLabel(activity.stage),
        `batch ${activeBatchNumber(activity.batchCompleted, activity.batchTotal)}/${activity.batchTotal}`,
        `${formatBytes(activity.sourceBytes)} source`,
        activity.cachedFactBytes === undefined ? undefined : `${formatBytes(activity.cachedFactBytes)} cached facts`,
        activity.factsBytes === undefined ? undefined : `${formatBytes(activity.factsBytes)} final facts`,
        renderMaterializationRows(activity.rows),
        activity.elapsedMilliseconds === undefined
          ? `active ${formatStatusDuration(Math.max(0, Date.now() - Date.parse(activity.startedAt)))}`
          : `batch ${formatMilliseconds(activity.elapsedMilliseconds)}`,
        activity.stageElapsedMilliseconds === undefined
          ? undefined
          : `stage ${formatMilliseconds(activity.stageElapsedMilliseconds)}`,
        activity.transactionMilliseconds === undefined
          ? undefined
          : `transaction ${formatMilliseconds(activity.transactionMilliseconds)}`,
      ].filter((value): value is string => value !== undefined);
      yield* Console.log(`Current activity: ${details.join(' · ')}`);
    }
    if (current.activation?.activity) {
      const activity = current.activation.activity;
      const details = [
        activity.stage.replaceAll('-', ' '),
        activity.state,
        activity.rows === undefined ? undefined : `${activity.rows.toLocaleString()} rows`,
        `stage ${formatMilliseconds(activity.stageElapsedMilliseconds)}`,
        `total ${formatMilliseconds(activity.elapsedMilliseconds)}`,
        activity.transactionMilliseconds === undefined
          ? undefined
          : `transaction ${formatMilliseconds(activity.transactionMilliseconds)}`,
      ].filter((value): value is string => value !== undefined);
      yield* Console.log(`Current activity: activating · ${details.join(' · ')}`);
    }
    if (current.resolution?.activity) {
      const activity = current.resolution.activity;
      const details = [
        `pass ${activity.pass}`,
        `page ${activity.pageCompleted}/${activity.pageTotal}`,
        `${activity.referencesCompleted.toLocaleString()}/${activity.referencesTotal.toLocaleString()} references`,
        `${activity.referencesExamined.toLocaleString()} cumulative examined`,
        `${activity.resolved.toLocaleString()} linked`,
        `${activity.aliasesDiscovered.toLocaleString()} aliases`,
        `match ${formatMilliseconds(activity.matchingMilliseconds)}`,
        `transactions ${formatMilliseconds(activity.transactionMilliseconds)}`,
        `total ${formatMilliseconds(activity.elapsedMilliseconds)}`,
      ];
      yield* Console.log(`Reference resolution: ${details.join(' · ')}`);
    }
    if (current.materialization?.metrics) {
      const metrics = current.materialization.metrics;
      const details = [
        metrics.mode === undefined ? undefined : `${metrics.mode.replaceAll('-', ' ')} materialization`,
        metrics.fallbackReason === undefined
          ? undefined
          : `incremental fallback: ${metrics.fallbackReason.replaceAll('-', ' ')}`,
        `${metrics.batchesCompleted}/${metrics.batchesTotal} batches committed`,
        `${formatBytes(metrics.sourceBytesCompleted)}/${formatBytes(metrics.sourceBytesTotal)} source`,
        metrics.cachedFactBytesCompleted === undefined
          ? undefined
          : `${formatBytes(metrics.cachedFactBytesCompleted)}${
              metrics.cachedFactBytesTotal === undefined ? '' : `/${formatBytes(metrics.cachedFactBytesTotal)}`
            } cached facts`,
        metrics.factsBytesCompleted === undefined
          ? undefined
          : `${formatBytes(metrics.factsBytesCompleted)}${
              metrics.factsBytesTotal === undefined ? '' : `/${formatBytes(metrics.factsBytesTotal)}`
            } final facts`,
        renderMaterializationRows(metrics.rows),
        metrics.loadingMilliseconds === undefined
          ? undefined
          : `load ${formatMilliseconds(metrics.loadingMilliseconds)}`,
        metrics.attributionMilliseconds === undefined
          ? undefined
          : `attribute ${formatMilliseconds(metrics.attributionMilliseconds)}`,
        metrics.transactionMilliseconds === undefined
          ? undefined
          : `transactions ${formatMilliseconds(metrics.transactionMilliseconds)}`,
      ].filter((value): value is string => value !== undefined);
      yield* Console.log(`Materialized: ${details.join(' · ')}`);
      if (metrics.subphaseMilliseconds) {
        const subphases = metrics.subphaseMilliseconds;
        yield* Console.log(
          `Materialization detail: compute ${formatMilliseconds(subphases.attributionCompute)} · ` +
            `serialize ${formatMilliseconds(subphases.shardSerialization)} · ` +
            `persist shards ${formatMilliseconds(subphases.shardPersistence)} · ` +
            `associate shards ${formatMilliseconds(subphases.shardAssociation)} · ` +
            `prepare batches ${formatMilliseconds(subphases.factBatchPreparation)}`,
        );
      }
      if (metrics.storage) {
        const storage = metrics.storage;
        const storageDetails = [
          storage.materializationMode === undefined
            ? undefined
            : `${storage.materializationMode.replaceAll('-', ' ')} materialization`,
          storage.durableDatabaseBytes === undefined
            ? undefined
            : `${formatBytes(storage.durableDatabaseBytes)} allocated durable pages`,
          storage.durableDatabaseHighWaterBytes === undefined
            ? undefined
            : `${formatBytes(storage.durableDatabaseHighWaterBytes)} allocated-page high-water`,
          storage.durableDatabaseGrowthHighWaterBytes === undefined
            ? undefined
            : `${formatBytes(storage.durableDatabaseGrowthHighWaterBytes)} main-database growth`,
          storage.durableFilesystemHighWaterBytes === undefined
            ? undefined
            : `${formatBytes(storage.durableFilesystemHighWaterBytes)} DB + sidecars high-water`,
          storage.durableSidecarDatabaseHighWaterBytes === undefined
            ? undefined
            : `${formatBytes(storage.durableSidecarDatabaseHighWaterBytes)} sorted-sidecar high-water`,
          storage.durableSidecarJournalHighWaterBytes === undefined
            ? undefined
            : `${formatBytes(storage.durableSidecarJournalHighWaterBytes)} sidecar journal high-water`,
          storage.durableSidecarWalHighWaterBytes === undefined
            ? undefined
            : `${formatBytes(storage.durableSidecarWalHighWaterBytes)} sidecar WAL high-water`,
          storage.durableWalHighWaterBytes === undefined
            ? undefined
            : `${formatBytes(storage.durableWalHighWaterBytes)} WAL high-water`,
          storage.durableJournalHighWaterBytes === undefined
            ? undefined
            : `${formatBytes(storage.durableJournalHighWaterBytes)} rollback-journal high-water`,
          `${formatBytes(storage.temporaryDatabaseBytes)} current TEMP database`,
          `${formatBytes(storage.temporaryDatabaseHighWaterBytes)} TEMP database high-water`,
          storage.estimatedRequiredBytes === undefined
            ? undefined
            : `${formatBytes(storage.estimatedRequiredBytes)} combined estimate`,
          storage.estimatedTemporaryFilesystemRequiredBytes === undefined
            ? undefined
            : `${formatBytes(storage.estimatedTemporaryFilesystemRequiredBytes)} TEMP-filesystem requirement`,
          storage.estimatedDurableFilesystemRequiredBytes === undefined
            ? undefined
            : `${formatBytes(storage.estimatedDurableFilesystemRequiredBytes)} graph-filesystem requirement`,
          storage.estimatedTemporaryDatabaseBytes === undefined
            ? undefined
            : `${formatBytes(storage.estimatedTemporaryDatabaseBytes)} estimated TEMP`,
          storage.estimatedDurableSnapshotBytes === undefined
            ? undefined
            : `${formatBytes(storage.estimatedDurableSnapshotBytes)} estimated snapshot/WAL`,
          storage.estimatedJournalBytes === undefined
            ? undefined
            : `${formatBytes(storage.estimatedJournalBytes)} estimated journals`,
          storage.estimatedConcurrentBuildBytes === undefined
            ? undefined
            : `${formatBytes(storage.estimatedConcurrentBuildBytes)} concurrent-build allowance`,
          storage.filesystemsShared === true ? 'TEMP and graph database share a filesystem' : undefined,
          storage.temporaryAvailableBytes === undefined
            ? undefined
            : `${formatBytes(storage.temporaryAvailableBytes)} available for TEMP`,
          storage.durableAvailableBytes === undefined
            ? undefined
            : `${formatBytes(storage.durableAvailableBytes)} available for graph database`,
          storage.estimateBasis === undefined
            ? undefined
            : `estimate from ${storage.estimateBasis.replaceAll('-', ' ')}`,
        ].filter((value): value is string => value !== undefined);
        yield* Console.log(
          `Materialization storage: ${storageDetails.join(' · ')} · rollback journals excluded from TEMP totals`,
        );
        const diskWarning = materializationDiskWarning(storage);
        if (diskWarning) yield* Console.log(`Warning: ${diskWarning}`);
      }
    }
    if (current.timings) {
      yield* Console.log(
        `Phase timings: read ${formatMilliseconds(current.timings.readingMilliseconds)} · ` +
          `parse ${formatMilliseconds(current.timings.extractionMilliseconds)} · ` +
          (current.timings.serializationMilliseconds === undefined
            ? ''
            : `serialize ${formatMilliseconds(current.timings.serializationMilliseconds)} · `) +
          `persist ${formatMilliseconds(current.timings.persistenceMilliseconds)}`,
      );
    }
    if (current.extraction?.metrics) {
      const metrics = current.extraction.metrics;
      const workPercentage =
        metrics.workUnitsTotal === 0 ? 0 : Math.min(100, (metrics.workUnitsCompleted / metrics.workUnitsTotal) * 100);
      yield* Console.log(
        `Extraction: ${formatBytes(metrics.sourceBytesCompleted)}/${formatBytes(metrics.sourceBytesTotal)} source · ` +
          `${formatBytes(metrics.factsBytesCompleted)} emitted facts · ${workPercentage.toFixed(1)}% class-weighted work`,
      );
    }
    const lastProgressAge = Math.max(0, Date.now() - Date.parse(current.timestamps.lastProgressAt));
    if (current.eta && current.eta.confidence !== 'low' && lastProgressAge <= 15_000) {
      yield* Console.log(
        `Phase ETA: about ${formatStatusDuration(current.eta.remainingMilliseconds)} ` +
          `(${current.eta.confidence} confidence${current.eta.basis ? `, ${etaBasisLabel(current.eta.basis)}` : ''})`,
      );
    } else if (current.eta) {
      yield* Console.log(
        lastProgressAge > 15_000
          ? 'Phase ETA: paused while progress is silent.'
          : 'Phase ETA: stabilizing from completed batch output.',
      );
    }
    if (current.result) {
      yield* Console.log(
        `Ready snapshot: ${current.result.snapshotId} · ${current.result.files} files · ` +
          `${current.result.symbols} symbols · ${current.result.edges} edges`,
      );
    }
    if (current.error) yield* Console.log(`Error: ${current.error.summary}`);
    if (selection.waiters.length > 0) {
      yield* Console.log(
        `Waiters: ${selection.waiters.length} process(es) across ${queuedWorktreeIds.length} worktree(s)`,
      );
    }
    if (!current.result) yield* renderReadySnapshotStatus(ready);
    return;
  }
  const status = ready;
  yield* Console.log(`Repository: ${status.identity.displayName}`);
  yield* Console.log(`Database: ${status.databasePath}`);
  yield* renderObsoleteStoreStatus(obsoleteStores);
  yield* renderActiveStorageStatus(storage);
  yield* Console.log(
    `Language packs: ${status.languagePacks
      .map(pack => `${pack.id}@${pack.version} [${pack.languages.join(', ')}]`)
      .join('; ')}`,
  );
  if (!status.readySnapshot) {
    yield* Console.log('Ready snapshot: none');
    return;
  }
  yield* Console.log(
    `Ready snapshot: ${status.readySnapshot.id} · ${status.readySnapshot.fileCount} files · ` +
      `${status.readySnapshot.symbolCount} symbols · ${status.readySnapshot.edgeCount} edges`,
  );
  yield* Console.log(
    `Source: ${status.readySnapshot.commit.slice(0, 12)}${status.readySnapshot.dirty ? ' + dirty overlay' : ''} · ${
      status.stale ? 'stale' : 'current'
    }`,
  );
});

export const runCodeGraphInventory = Effect.fn('codeGraph.command.inventory')(function* (
  _config: RuntimeConfig,
  options: CwdOption & {readonly json?: boolean},
) {
  const identity = yield* resolveRepositoryIdentity(yield* commandCwd(options.cwd));
  const preview = yield* previewCodeGraphInventory(identity);
  yield* writeFinalCliOutput(options.json ? JSON.stringify(preview) : renderCodeGraphInventoryPreview(preview));
});

function renderCodeGraphInventoryPreview(preview: CodeGraphInventoryPreview): string {
  const source = `${preview.commit.slice(0, 12)}${preview.dirty ? ' + worktree changes' : ' (clean)'}`;
  const lines = [
    'Code graph inventory admission preview',
    `Source: ${source}`,
    `Policy: v${preview.policyVersion} · aggregate metadata only · repository paths and content omitted`,
    `Repository: ${preview.totals.repository.files} file(s) · ${preview.totals.repository.bytes} bytes (${formatBytes(preview.totals.repository.bytes)})`,
    `Eligible: ${preview.totals.eligible.files} file(s) · ${preview.totals.eligible.bytes} bytes (${formatBytes(preview.totals.eligible.bytes)})`,
    `Skipped: ${preview.totals.skipped.files} file(s) · ${preview.totals.skipped.bytes} bytes (${formatBytes(preview.totals.skipped.bytes)})`,
  ];
  if (preview.omittedUnsafeWorktreeFiles > 0) {
    lines.push(
      `Omitted: ${preview.omittedUnsafeWorktreeFiles} changed unsafe/non-regular worktree path(s) are outside byte totals.`,
    );
  }
  lines.push('', 'DISPOSITION\tLANGUAGE\tROLE\tCLASSIFIER\tREASON\tFILES\tBYTES');
  for (const group of preview.groups) {
    lines.push(
      [group.disposition, group.language, group.role, group.classifier, group.reason, group.files, group.bytes].join(
        '\t',
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

function renderReadySnapshotStatus(status: {
  readonly readySnapshot?: {
    readonly edgeCount: number;
    readonly fileCount: number;
    readonly id: string;
    readonly symbolCount: number;
  };
  readonly stale: boolean;
}): Effect.Effect<void> {
  return status.readySnapshot
    ? Console.log(
        `Current-worktree ready snapshot: ${status.readySnapshot.id} · ${status.readySnapshot.fileCount} files · ` +
          `${status.readySnapshot.symbolCount} symbols · ${status.readySnapshot.edgeCount} edges · ` +
          `${status.stale ? 'stale' : 'current'}`,
      )
    : Console.log('Current-worktree ready snapshot: none');
}

function renderObsoleteStoreStatus(inventory: ObsoleteCodeGraphStoreInventory): Effect.Effect<void> {
  if (inventory.fileCount === 0 && inventory.unsafeEntryCount === 0) return Effect.void;
  const versions = inventory.checkouts.flatMap(checkout => checkout.versions);
  const versionSummary = [...new Set(versions)]
    .sort((left, right) => left - right)
    .map(version => `v${version}`)
    .join(', ');
  return Console.log(
    `Obsolete stores: ${inventory.fileCount} file(s), ${inventory.bytes} byte(s)` +
      (versionSummary ? ` (${versionSummary})` : '') +
      (inventory.unsafeEntryCount > 0
        ? `; ${inventory.unsafeEntryCount} unsafe obsolete-shaped entry/entries require manual review`
        : '') +
      '; remove verified files explicitly with `threadnote graph purge --obsolete`.',
  );
}

function renderActiveStorageStatus(storage: CodeGraphStorage): Effect.Effect<void> {
  if (storage.state === 'missing') return Effect.void;
  return Effect.gen(function* () {
    yield* Console.log(
      `Storage: ${formatBytes(storage.databaseBytes)} database · ${formatBytes(storage.walBytes)} WAL · ` +
        `${formatBytes(storage.journalBytes)} journal · ${formatBytes(storage.shmBytes)} SHM · ` +
        `${formatBytes(storage.temporaryBytes)} TEMP · ${formatBytes(storage.filesystemBytes)} filesystem · ` +
        `${formatBytes(storage.totalBytes)} observed total`,
    );
    if (storage.pageStorage.state === 'deferred') {
      yield* Console.log('Page storage: deferred while an active graph build owns the checkout lock.');
      return;
    }
    if (storage.pageStorage.state === 'unavailable') {
      yield* Console.log(
        'Page storage: unavailable because the database is busy or unreadable; exact file sizes remain valid.',
      );
      return;
    }
    const page = storage.pageStorage;
    yield* Console.log(
      `Reclaimable: ${formatBytes(page.reclaimableBytes)} (${formatPercent(page.reclaimableRatio)}; ` +
        `${page.freelistPages}/${page.pageCount} pages at ${page.pageSize} byte(s)/page)`,
    );
    if (
      page.fragmentedBytes !== undefined &&
      page.fragmentationRatio !== undefined &&
      page.compactionOpportunityBytes !== undefined &&
      page.compactionOpportunityRatio !== undefined
    ) {
      yield* Console.log(
        `Fragmented: ${formatBytes(page.fragmentedBytes)} (${formatPercent(page.fragmentationRatio)}); ` +
          `combined compaction opportunity ${formatBytes(page.compactionOpportunityBytes)} ` +
          `(${formatPercent(page.compactionOpportunityRatio)}).`,
      );
    }
    yield* Console.log(
      `Compaction: ${page.threshold.recommended ? 'recommended' : 'not needed'}; threshold is ` +
        `${formatBytes(page.threshold.minimumReclaimableBytes)} and ` +
        `${formatPercent(page.threshold.minimumReclaimableRatio)} free or fragmented` +
        (page.threshold.reason === 'freelist-and-fragmentation' ? '; fragmentation crossed the threshold.' : '.'),
    );
  });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}

function formatPercent(ratio: number): string {
  return `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(1)}%`;
}

function renderBuildCounters(status: ObservedCodeGraphBuildStatus): string | undefined {
  const counters = status.counters;
  const measured =
    counters.completed === undefined || counters.total === undefined
      ? undefined
      : `${counters.completed}/${counters.total} ${counters.unit ?? 'items'}`;
  const details = [
    counters.accepted === undefined ? undefined : `${counters.accepted} accepted`,
    counters.reused === undefined ? undefined : `${counters.reused} reused`,
    counters.resolved === undefined ? undefined : `${counters.resolved} references linked`,
    counters.skipped === undefined ? undefined : `${counters.skipped} skipped`,
    counters.excluded === undefined ? undefined : `${counters.excluded} excluded`,
    counters.pagesCompleted === undefined ? undefined : `${counters.pagesCompleted} cleanup pages`,
    counters.rowsDeleted === undefined ? undefined : `${counters.rowsDeleted} rows reclaimed`,
    counters.symbols === undefined ? undefined : `${counters.symbols} symbols`,
    counters.edges === undefined ? undefined : `${counters.edges} edges`,
  ].filter((value): value is string => value !== undefined);
  return [measured, ...details].filter((value): value is string => value !== undefined).join(' · ') || undefined;
}

function formatStatusDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return 'unknown';
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.ceil(minutes / 60)}h`;
}

export const runCodeGraphIndex = Effect.fn('codeGraph.command.index')(function* (
  config: RuntimeConfig,
  options: CwdOption &
    ExpectedRepositoryIdentityOption & {readonly full?: boolean; readonly json?: boolean; readonly noVectors?: boolean},
) {
  const indexer = yield* CodeGraphIndexer;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  if (options.expectedIdentity && !repositoryIdentityMatchesExpectation(identity, options.expectedIdentity)) {
    return yield* Effect.fail(
      new CodeGraphCommandError('Repository identity does not match the requested graph target.'),
    );
  }
  const ensureVectors = options.noVectors === true ? false : undefined;
  if (options.json) {
    const reportProgress = yield* makeCodeGraphJsonProgressReporter({
      displayName: identity.displayName,
      repositoryId: identity.repositoryId,
    });
    const summary = yield* indexer.index({
      cwd,
      ...(ensureVectors === false ? {ensureVectors: false} : {}),
      ...(options.expectedIdentity ? {expectedIdentity: options.expectedIdentity} : {}),
      force: options.full,
      onProgress: reportProgress,
      threadnoteHome: config.agentContextHome,
    });
    yield* writeFinalCliOutput(JSON.stringify({type: 'code-graph-index', version: 1, ...summary}));
    return;
  }
  yield* Console.log(`Indexing code graph: ${identity.displayName}`);
  yield* Effect.acquireUseRelease(
    startProgress('Scanning repository source from Git.'),
    progress =>
      indexer
        .index({
          cwd,
          ...(ensureVectors === false ? {ensureVectors: false} : {}),
          ...(options.expectedIdentity ? {expectedIdentity: options.expectedIdentity} : {}),
          force: options.full,
          onProgress: state => progress.update(progressMessage(state)).pipe(Effect.catch(() => Effect.void)),
          threadnoteHome: config.agentContextHome,
        })
        .pipe(
          Effect.tap(summary =>
            progress
              .update(
                `Ready · ${summary.snapshot.fileCount} files · ${summary.snapshot.symbolCount} symbols · ` +
                  `${summary.snapshot.edgeCount} edges`,
              )
              .pipe(Effect.catch(() => Effect.void)),
          ),
        ),
    progress => progress.stop.pipe(Effect.catch(() => Effect.void)),
  ).pipe(
    Effect.flatMap(summary =>
      Console.log(
        `Code graph ready for ${summary.identity.displayName}: ${summary.snapshot.fileCount} file(s), ` +
          `${summary.snapshot.symbolCount} symbol(s), ${summary.snapshot.edgeCount} relationship(s); ` +
          `${summary.reusedFiles} file(s) reused.`,
      ),
    ),
  );
});

export const runCodeGraphWorksetPrepare = Effect.fn('codeGraph.command.worksetPrepare')(function* (
  config: RuntimeConfig,
  options: {readonly concurrency?: number; readonly json?: boolean; readonly name: string},
) {
  const result = options.json
    ? yield* prepareCodeGraphWorkset(config, options.name, {
        concurrency: options.concurrency,
        onProgress: yield* makeCodeGraphWorksetJsonProgressReporter(),
      })
    : yield* Effect.acquireUseRelease(
        startProgress(`Preparing workset ${options.name}.`),
        progress =>
          prepareCodeGraphWorkset(config, options.name, {
            concurrency: options.concurrency,
            onProgress: event => progress.update(event.message),
          }),
        progress => progress.stop.pipe(Effect.catch(() => Effect.void)),
      );
  yield* writeFinalCliOutput(
    options.json ? JSON.stringify(result) : renderCodeGraphWorksetPrepareResult(result).trimEnd(),
  );
  if (result.state === 'failed') {
    return yield* Effect.fail(
      new CodeGraphCommandError(
        'Workset preparation was incomplete; the previous published catalog generation was preserved.',
      ),
    );
  }
});

export const runCodeGraphWorksetStatus = Effect.fn('codeGraph.command.worksetStatus')(function* (
  config: RuntimeConfig,
  options: {readonly json?: boolean; readonly name: string},
) {
  const result = yield* inspectCodeGraphWorksetStatus(config, options.name);
  yield* writeFinalCliOutput(
    options.json ? JSON.stringify(result) : renderCodeGraphWorksetStatusResult(result).trimEnd(),
  );
});

export function renderCodeGraphWorksetPrepareResult(result: CodeGraphWorksetPrepareResultV1): string {
  const lines = [
    `Workset prepare: ${result.workset}`,
    `State: ${result.state}`,
    `Coverage: ${result.coverage.ready}/${result.coverage.requested} ready (${result.coverage.complete ? 'complete' : 'incomplete'})`,
  ];
  for (const member of result.members) {
    lines.push(
      member.state === 'ready'
        ? `- ${member.project}: ready (${member.symbolCount} routing symbols)`
        : member.state === 'failed'
          ? `- ${member.project}: failed (${member.reason}; ${member.detail.code}; ${member.detail.summary})`
          : `- ${member.project}: ${member.state} (${member.reason})`,
    );
  }
  if (!result.coverage.complete) {
    lines.push(
      `Warning: published coverage is incomplete (${result.coverage.failed} failed, ${result.coverage.missing} missing, ${result.coverage.excluded} excluded).`,
    );
  }
  if (result.bridges !== undefined) {
    lines.push(
      `Bridges: ${result.bridges.state} (${result.bridges.bridgeCount} resolved, ${result.bridges.rejectionCount} rejected, ${result.bridges.monikerCount} monikers)`,
    );
    for (const warning of result.bridges.warnings) lines.push(`Warning: ${warning}`);
  }
  if (result.published !== undefined) lines.push(`Published generation: ${result.published.id}`);
  return `${lines.join('\n')}\n`;
}

export function renderCodeGraphWorksetStatusResult(result: CodeGraphWorksetStatusResultV1): string {
  const lines = [
    `Workset status: ${result.workset}`,
    `Catalog: ${result.catalog.state}${result.catalog.generation ? ` (${result.catalog.generation.id})` : ''}`,
    `Coverage: ${result.coverage.current}/${result.coverage.requested} current`,
  ];
  if (result.bridges !== undefined) {
    lines.push(
      `Bridges: ${result.bridges.coverage.state} (${result.bridges.bridgeCount} resolved, ${result.bridges.coverage.rejectionCount} rejected)`,
    );
  }
  for (const member of result.members) {
    lines.push(`- ${member.project}: ${member.state}${member.reason ? ` (${member.reason})` : ''}`);
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return `${lines.join('\n')}\n`;
}

export const runCodeGraphAnalysis = Effect.fn('codeGraph.command.analysis')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly communityId?: string;
    readonly freshness?: CodeGraphCliFreshnessPolicy;
    readonly includeHeuristic?: boolean;
    readonly includeModelAssociations?: boolean;
    readonly json?: boolean;
    readonly memberLimit?: number;
    readonly readTimeoutMilliseconds?: number;
    readonly view: CodeGraphAnalysisView;
  },
) {
  const cwd = yield* commandCwd(options.cwd);
  const communityId = options.communityId?.trim();
  if (options.view === 'community' && !communityId?.match(/^cgc_[a-f0-9]{32}$/)) {
    return yield* Effect.fail(
      new CodeGraphCommandError(
        'Community drill-down requires --community-id with a stable cgc_ identifier from graph communities.',
      ),
    );
  }
  const freshness = options.freshness ?? 'ready';
  const resolution = yield* ensureAnalysisSnapshot(
    config,
    cwd,
    options.json === true,
    freshness,
    options.view,
    options.readTimeoutMilliseconds,
  );
  if (!resolution.ready) {
    yield* writeFinalCliOutput(
      options.json ? JSON.stringify(resolution.state) : renderCodeGraphCliAnalysisState(resolution.state).trimEnd(),
    );
    return;
  }
  const status = resolution;
  const analysis = yield* CodeGraphAnalysis;
  const result = yield* analysis.analyze({
    allowedProvenances: [
      'declared',
      'resolved',
      'syntactic',
      ...(options.includeHeuristic ? (['heuristic'] as const) : []),
      ...(options.includeModelAssociations ? (['model'] as const) : []),
    ],
    ...(communityId === undefined ? {} : {communityId}),
    databasePath: status.databasePath,
    limits: codeGraphAnalysisLimitsForView(options.view, options.memberLimit),
    snapshot: status.snapshot,
  });
  if (options.json) {
    yield* writeFinalCliOutput(
      JSON.stringify({
        freshness: status.freshness,
        freshnessPolicy: status.freshnessPolicy,
        type: 'code-graph-analysis',
        repository: status.repository,
        result,
        version: 1,
      }),
    );
    return;
  }
  const rendered = renderCodeGraphAnalysis(result, options.view).trimEnd().split('\n');
  rendered.splice(1, 0, `Snapshot freshness: ${status.freshness} (requested ${status.freshnessPolicy})`);
  yield* writeFinalCliOutput(rendered.join('\n'));
});

export const runCodeGraphReport = Effect.fn('codeGraph.command.report')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly includeHeuristic?: boolean;
    readonly includeModelAssociations?: boolean;
    readonly output: string;
    readonly readTimeoutMilliseconds?: number;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* commandCwd(options.cwd);
  const output = path.resolve(options.output);
  if (yield* fs.exists(output))
    return yield* Effect.fail(new CodeGraphCommandError(`Report output already exists: ${output}`));
  const resolution = yield* ensureAnalysisSnapshot(
    config,
    cwd,
    false,
    'current',
    'report',
    options.readTimeoutMilliseconds,
  );
  if (!resolution.ready) {
    return yield* Effect.fail(
      new CodeGraphCommandError(
        `${renderCodeGraphCliAnalysisState(resolution.state).trim()} The report output was not created.`,
      ),
    );
  }
  const status = resolution;
  const analysis = yield* CodeGraphAnalysis;
  const result = yield* analysis.analyze({
    allowedProvenances: [
      'declared',
      'resolved',
      'syntactic',
      ...(options.includeHeuristic ? (['heuristic'] as const) : []),
      ...(options.includeModelAssociations ? (['model'] as const) : []),
    ],
    databasePath: status.databasePath,
    limits: codeGraphAnalysisLimitsForView('full'),
    snapshot: status.snapshot,
  });
  yield* fs.makeDirectory(path.dirname(output), {recursive: true});
  let ownsOutput = false;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(output, {flag: 'wx', mode: 0o600});
      ownsOutput = true;
      yield* file.writeAll(new TextEncoder().encode(renderCodeGraphReport(result, status.repository)));
      yield* file.sync;
    }),
  ).pipe(
    Effect.onError(() =>
      ownsOutput ? fs.remove(output, {force: true}).pipe(Effect.catch(() => Effect.void)) : Effect.void,
    ),
  );
  yield* Console.log(
    `Wrote code graph report for ${status.repository.displayName}: ${output}${
      result.coverage.complete ? '' : ' (partial analysis; see report warnings)'
    }`,
  );
});

export const runCodeGraphInspect = Effect.fn('codeGraph.command.inspect')(function* (
  config: RuntimeConfig,
  options: CwdOption &
    Omit<CodeGraphQueryOptions, 'cwd'> & {
      readonly baseCommit?: string;
      readonly freshness?: CodeGraphCliFreshnessPolicy;
      readonly json?: boolean;
      /** @internal Tests can exercise the foreground timeout without waiting for the public budget. */
      readonly readTimeoutMilliseconds?: number;
      readonly budgetTokens?: number;
      readonly cursor?: string;
      readonly seedQueries?: readonly string[];
      readonly workset?: string;
    },
) {
  if (options.workset?.trim()) {
    const worksetName = options.workset.trim();
    if (options.operation === 'path') {
      const result = yield* findCodeGraphWorksetPath(config, {
        from: options.from ?? '',
        maxDepth: options.depth,
        maxEdges: options.edgeLimit,
        to: options.to ?? '',
        worksetName,
      });
      yield* writeFinalCliOutput(options.json ? JSON.stringify(result) : renderCodeGraphWorksetTraversal(result));
      return;
    }
    if (options.operation === 'impact') {
      const query = options.query?.trim();
      if (!query) return yield* Effect.fail(new CodeGraphCommandError('A workset impact trace requires --query.'));
      const result = yield* traceCodeGraphWorksetImpact(config, {
        maxDepth: options.depth,
        maxEdges: options.edgeLimit,
        query,
        worksetName,
      });
      yield* writeFinalCliOutput(options.json ? JSON.stringify(result) : renderCodeGraphWorksetTraversal(result));
      return;
    }
    if (options.operation !== 'query') {
      return yield* Effect.fail(new CodeGraphCommandError('--workset is valid for graph query, path, and impact.'));
    }
    const cursor = options.cursor?.trim();
    const projected = cursor
      ? yield* continueCodeGraphWorksetQueryV2(config, {
          cursor,
          maximumEstimatedTokens: options.budgetTokens,
        })
      : yield* Effect.gen(function* () {
          const query = options.query?.trim();
          if (!query)
            return yield* Effect.fail(new CodeGraphCommandError('A workset graph query requires --query or --cursor.'));
          return yield* queryCodeGraphWorksetV2(config, {
            depth: options.depth,
            edgeLimit: options.edgeLimit,
            includeHeuristic: options.includeHeuristic,
            includeModelAssociations: options.includeModelAssociations,
            maximumEstimatedTokens: options.budgetTokens,
            nodeLimit: options.nodeLimit,
            packageName: options.packageName,
            query,
            worksetName,
          });
        });
    yield* writeFinalCliOutput(options.json ? JSON.stringify(projected.structuredContent) : projected.text.trimEnd());
    return;
  }
  if (options.cursor?.trim() || options.budgetTokens !== undefined) {
    return yield* Effect.fail(new CodeGraphCommandError('--cursor and --budget-tokens require --workset.'));
  }
  if (options.operation === 'query' && !options.query?.trim()) {
    return yield* Effect.fail(new CodeGraphCommandError('A graph query requires --query.'));
  }
  const qualifiedTarget = options.nodeId?.startsWith('cgr_')
    ? yield* resolveCodeGraphQualifiedRefTarget(config, options.nodeId, options.cwd)
    : undefined;
  const effectiveOptions =
    qualifiedTarget === undefined ? options : {...options, cwd: qualifiedTarget.cwd, nodeId: qualifiedTarget.nodeId};
  const service = yield* CodeGraphQueryService;
  const cwd = yield* commandCwd(effectiveOptions.cwd);
  const freshness = options.freshness ?? defaultCodeGraphCliFreshness(options.operation);
  let status = yield* service.status(config.agentContextHome, cwd);
  const identity = status.identity;
  if (status.stale || !status.readySnapshot) {
    status = yield* service.attachSharedReadySnapshot(config.agentContextHome, identity, status, {
      allowBorrowedStale: freshness !== 'current',
    });
  }
  const readPlan = codeGraphCliReadPlan(freshness, status);
  if (readPlan.unavailable) {
    const unavailable = codeGraphCliReadState(status, freshness, options.operation, 'no-ready-snapshot');
    yield* writeFinalCliOutput(
      options.json ? JSON.stringify(unavailable) : renderCodeGraphCliReadState(unavailable).trimEnd(),
    );
    return;
  }
  const statusObservation = observationFromCodeGraphStatus(status);
  const inspect = (onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void>) =>
    service.inspect({
      ...effectiveOptions,
      cwd,
      onProgress,
      refresh: readPlan.refresh,
      statusObservation,
      strictFreshness: readPlan.strictFreshness,
      threadnoteHome: config.agentContextHome,
    });
  const reportProgress = effectiveOptions.json ? yield* makeCodeGraphJsonProgressReporter() : undefined;
  const read = effectiveOptions.json
    ? inspect(reportProgress)
    : readPlan.refresh
      ? Effect.acquireUseRelease(
          startProgress('Scanning repository source from Git.'),
          progress => inspect(state => progress.update(progressMessage(state)).pipe(Effect.catch(() => Effect.void))),
          progress => progress.stop.pipe(Effect.catch(() => Effect.void)),
        )
      : inspect();
  const readTimeoutMilliseconds = options.readTimeoutMilliseconds ?? CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS;
  const result = yield* read.pipe(
    Effect.map(Option.some),
    Effect.timeoutOrElse({
      duration: readTimeoutMilliseconds,
      orElse: () => Effect.succeed(Option.none()),
    }),
  );
  if (Option.isNone(result)) {
    const timedOut = codeGraphCliReadState(
      status,
      freshness,
      options.operation,
      'read-timeout',
      readTimeoutMilliseconds,
    );
    yield* writeFinalCliOutput(
      options.json ? JSON.stringify(timedOut) : renderCodeGraphCliReadState(timedOut).trimEnd(),
    );
    return;
  }
  yield* writeFinalCliOutput(
    options.json ? JSON.stringify(result.value) : renderCodeGraphResult(result.value).trimEnd(),
  );
});

export const runCodeGraphWorksetTopology = Effect.fn('codeGraph.command.worksetTopology')(function* (
  config: RuntimeConfig,
  options: {
    readonly edgeLimit?: number;
    readonly json?: boolean;
    readonly nodeLimit?: number;
    readonly workset: string;
  },
) {
  const result = yield* inspectCodeGraphWorksetTopology(config, {
    maxEdges: options.edgeLimit,
    maxNodes: options.nodeLimit,
    worksetName: options.workset,
  });
  yield* writeFinalCliOutput(options.json ? JSON.stringify(result) : renderCodeGraphWorksetTopology(result));
});

export function renderCodeGraphWorksetTraversal(result: CodeGraphCrossRepositoryTraversalResultV1): string {
  const lines = [
    `Workset ${result.direction === 'forward' ? 'path' : 'impact'}: ${result.generationId}`,
    `Stop: ${result.stop.reason}${result.stop.complete ? ' (complete)' : ' (partial)'}`,
    `Coverage: ${result.coverage.endpointsVisited} endpoints, ${result.coverage.acceptedLocalEdges} local edges, ${result.coverage.acceptedBridgeEdges} bridges`,
  ];
  for (const edge of result.edges) {
    lines.push(
      `- ${traversalEndpointLabel(edge.source)} --${edge.relation}/${edge.provenance.kind}--> ${traversalEndpointLabel(edge.target)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function renderCodeGraphWorksetTopology(result: CodeGraphWorksetTopologyResultV1): string {
  const lines = [`Workset topology: ${result.workset}`, `State: ${result.state}`];
  if (result.bridgeSet !== undefined) {
    lines.push(
      `Bridges: ${result.bridgeSet.bridgeCount} (${result.bridgeSet.coverage.state}; generation ${result.bridgeSet.generationId})`,
    );
  }
  if (result.topology !== undefined) {
    lines.push(
      `Topology: ${result.topology.nodes.length} nodes, ${result.topology.edges.length} aggregate edges${result.topology.coverage.complete ? '' : ' (partial)'}`,
    );
    for (const edge of result.topology.edges) {
      lines.push(`- ${edge.sourceNodeId} -> ${edge.targetNodeId}: ${edge.bridgeCount} declared bridge(s)`);
    }
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return `${lines.join('\n')}\n`;
}

function traversalEndpointLabel(endpoint: CodeGraphCrossRepositoryTraversalResultV1['visited'][number]): string {
  return `${endpoint.repositoryKey}:${
    endpoint.reference.kind === 'component' ? endpoint.reference.componentId : endpoint.reference.ref
  }`;
}

export const runCodeGraphImpact = Effect.fn('codeGraph.command.impact')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly base?: string;
    readonly depth?: number;
    readonly edgeLimit?: number;
    readonly json?: boolean;
    readonly nodeLimit?: number;
    readonly query?: string;
    readonly workset?: string;
  },
) {
  if (options.workset?.trim()) {
    if (!options.query?.trim()) {
      return yield* Effect.fail(
        new CodeGraphCommandError('A workset impact trace requires --query with a qualified endpoint.'),
      );
    }
    yield* runCodeGraphInspect(config, {...options, operation: 'impact'});
    return;
  }
  const cwd = yield* commandCwd(options.cwd);
  const changes = options.query?.trim() ? undefined : yield* repositoryChangesSince(cwd, options.base ?? 'HEAD~1');
  const input = options.query?.trim() || changes!.paths.join(' ');
  yield* runCodeGraphInspect(config, {
    ...options,
    baseCommit: changes?.baseCommit,
    cwd,
    operation: 'impact',
    query: input,
    seedQueries: changes?.paths,
  });
});

export const runCodeGraphPurge = Effect.fn('codeGraph.command.purge')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly all?: boolean;
    readonly apply?: boolean;
    readonly approval?: string;
    readonly checkoutId?: string;
    readonly dryRun?: boolean;
    readonly json?: boolean;
    readonly obsolete?: boolean;
    readonly snapshotId?: string;
    readonly waitTimeoutMilliseconds?: number;
  },
) {
  const path = yield* Path.Path;
  if (options.all && (options.checkoutId !== undefined || options.obsolete || options.snapshotId !== undefined)) {
    return yield* Effect.fail(
      new CodeGraphCommandError('Use --all by itself, without --checkout-id, --obsolete, or --snapshot-id.'),
    );
  }
  if (options.checkoutId !== undefined && options.cwd !== undefined) {
    return yield* Effect.fail(new CodeGraphCommandError('Use either --checkout-id or --cwd, not both.'));
  }
  if (options.snapshotId !== undefined) {
    if (options.obsolete || options.all || options.dryRun) {
      return yield* Effect.fail(
        new CodeGraphCommandError('Use --snapshot-id without --all, --obsolete, or --dry-run.'),
      );
    }
    let checkoutId = options.checkoutId;
    if (checkoutId === undefined) {
      const cwd = yield* commandCwd(options.cwd);
      checkoutId = (yield* resolveRepositoryIdentity(cwd)).checkoutId;
    }
    const result = yield* purgeCodeGraphSnapshot(
      config.agentContextHome,
      {checkoutId, snapshotId: options.snapshotId},
      {apply: options.apply === true, approvalDigest: options.approval},
    );
    yield* writeFinalCliOutput(
      options.json ? serializeCodeGraphSnapshotPurgeResult(result) : renderCodeGraphSnapshotPurgeResult(result),
    );
    const failure = codeGraphSnapshotPurgeTargetFailure(result);
    if (failure) return yield* Effect.fail(failure);
    return;
  }
  if (options.apply || options.approval !== undefined || options.json) {
    return yield* Effect.fail(new CodeGraphCommandError('Use --apply, --approval, or --json only with --snapshot-id.'));
  }
  if (options.obsolete) {
    let checkoutId = options.checkoutId;
    if (checkoutId === undefined) {
      const cwd = yield* commandCwd(options.cwd);
      checkoutId = (yield* resolveRepositoryIdentity(cwd)).checkoutId;
    }
    const summary = yield* purgeObsoleteCodeGraphStores(config.agentContextHome, checkoutId, {
      dryRun: options.dryRun === true,
    });
    const action = options.dryRun ? 'Would remove' : 'Removed';
    yield* Console.log(
      `${action} ${summary.fileCount} verified obsolete code graph file(s), ${summary.bytes} byte(s), ` +
        `from checkout ${summary.checkoutId.slice(0, 12)}` +
        (summary.versions.length > 0 ? ` (schema ${summary.versions.map(version => `v${version}`).join(', ')})` : '') +
        '.',
    );
    return;
  }
  if (options.all) {
    const root = path.join(config.agentContextHome, 'indexes', 'code-graph');
    if (options.dryRun) {
      yield* Console.log(`Would remove derived code graph indexes: ${root}`);
      return;
    }
    const removed = yield* purgeAllCodeGraphIndexes(config.agentContextHome);
    yield* Console.log(`Removed derived code graph indexes: ${removed}`);
    return;
  }
  if (options.checkoutId !== undefined) {
    const summary = yield* purgeCodeGraphIndex(config.agentContextHome, options.checkoutId, {
      dryRun: options.dryRun === true,
      waitTimeoutMilliseconds: options.waitTimeoutMilliseconds,
    });
    if (!summary.existed) {
      yield* Console.log(`No derived code graph index exists for checkout ${summary.checkoutId.slice(0, 12)}.`);
      return;
    }
    yield* Console.log(
      `${options.dryRun ? 'Would remove' : 'Removed'} derived code graph index for checkout ${summary.checkoutId.slice(0, 12)}.`,
    );
    return;
  }
  const service = yield* CodeGraphQueryService;
  const cwd = yield* commandCwd(options.cwd);
  if (options.dryRun) {
    const status = yield* service.status(config.agentContextHome, cwd);
    yield* Console.log(`Would remove derived code graph indexes: ${path.dirname(status.databasePath)}`);
    return;
  }
  const repositoryRoot = yield* service.purge(config.agentContextHome, cwd);
  yield* Console.log(`Removed derived code graph indexes: ${repositoryRoot}`);
});

export const runCodeGraphRemoveView = Effect.fn('codeGraph.command.removeView')(function* (
  config: RuntimeConfig,
  options: {
    readonly apply?: boolean;
    readonly checkoutId: string;
    readonly json?: boolean;
    readonly snapshotId: string;
    readonly worktreeId: string;
  },
) {
  const path = yield* Path.Path;
  const maintenance = yield* CodeGraphMaintenanceCoordinator;
  const layout = codeGraphLayout(path, config.agentContextHome, options.checkoutId, options.worktreeId);
  const result = yield* removeCodeGraphView(
    config.agentContextHome,
    {
      checkoutId: options.checkoutId,
      snapshotId: options.snapshotId,
      worktreeId: options.worktreeId,
    },
    {
      afterRemoval: input =>
        maintenance
          .kickResidual({
            checkoutId: input.checkoutId,
            databasePath: input.databasePath,
            threadnoteHome: input.threadnoteHome,
            writerLockPath: layout.databaseWriteLockPath,
          })
          .pipe(Effect.asVoid),
      apply: options.apply === true,
    },
  );
  yield* writeFinalCliOutput(
    options.json ? serializeCodeGraphViewRemovalResult(result) : renderCodeGraphViewRemovalResult(result),
  );
  const targetFailure = codeGraphViewRemovalTargetFailure(result);
  if (targetFailure) return yield* Effect.fail(targetFailure);
});

export const runCodeGraphCompact = Effect.fn('codeGraph.command.compact')(function* (
  config: RuntimeConfig,
  options: CwdOption &
    ExpectedRepositoryIdentityOption & {readonly dryRun?: boolean; readonly force?: boolean; readonly json?: boolean},
) {
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  if (options.expectedIdentity && !repositoryIdentityMatchesExpectation(identity, options.expectedIdentity)) {
    return yield* Effect.fail(
      new CodeGraphCommandError('Repository identity does not match the requested graph target.'),
    );
  }
  const summary = yield* compactCodeGraphStorage(config.agentContextHome, identity.checkoutId, {
    dryRun: options.dryRun === true,
    force: options.force,
  });
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify({type: 'code-graph-compaction', version: 1, ...summary}));
    return;
  }
  switch (summary.action) {
    case 'deferred':
      yield* Console.log(
        `Code graph compaction deferred: ${
          summary.reason === 'active-build'
            ? 'an active build owns this checkout'
            : 'another maintenance task is active'
        }.`,
      );
      return;
    case 'missing':
      yield* Console.log('No active code graph database exists for this checkout.');
      return;
    case 'not-needed':
      yield* Console.log('Code graph compaction is below the reviewed reclaimable-space threshold.');
      if (summary.before) yield* renderActiveStorageStatus(summary.before);
      return;
    case 'would-compact':
      yield* Console.log(
        `Would compact the active code graph and reclaim about ${formatBytes(summary.reclaimedBytes)}.`,
      );
      if (summary.before) yield* renderActiveStorageStatus(summary.before);
      return;
    case 'compacted':
      yield* Console.log(`Compacted the active code graph and reclaimed ${formatBytes(summary.reclaimedBytes)}.`);
      if (summary.after) yield* renderActiveStorageStatus(summary.after);
  }
});

export const runCodeGraphExport = Effect.fn('codeGraph.command.export')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly edgeLimit?: CodeGraphExportLimit | string;
    readonly format: CodeGraphExportFormat;
    readonly interlock?: CodeGraphExportInterlock;
    readonly nodeLimit?: CodeGraphExportLimit | string;
    readonly output: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const identity = yield* resolveRepositoryIdentity(yield* commandCwd(options.cwd));
  const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
  const store = yield* CodeGraphStore;
  const snapshot = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
  if (!snapshot) {
    return yield* Effect.fail(
      new CodeGraphCommandError(
        'No ready native code graph snapshot exists. Run `threadnote graph index` before exporting.',
      ),
    );
  }
  const output = path.resolve(options.output);
  if (yield* fs.exists(output))
    return yield* Effect.fail(new CodeGraphCommandError(`Export output already exists: ${output}`));
  yield* options.interlock?.afterOutputCheck?.() ?? Effect.void;
  const edgeLimit = yield* parseCodeGraphExportLimit(options.edgeLimit, '--edge-limit');
  const nodeLimit = yield* parseCodeGraphExportLimit(options.nodeLimit, '--node-limit');
  const parent = path.dirname(output);
  yield* fs.makeDirectory(parent, {recursive: true});
  const temporary = path.join(parent, `.${path.basename(output)}.${yield* crypto.randomUUIDv4}.tmp`);
  const summary = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(temporary, {flag: 'wx', mode: 0o600});
      return yield* Effect.gen(function* () {
        const encoder = new TextEncoder();
        const rendered = yield* exportCodeGraph({
          databasePath: layout.databasePath,
          ...(edgeLimit === undefined ? {} : {edgeLimit}),
          format: options.format,
          ...(nodeLimit === undefined ? {} : {nodeLimit}),
          repository: {displayName: identity.displayName, repositoryId: identity.repositoryId},
          snapshotId: snapshot.id,
          write: content => file.writeAll(encoder.encode(content)),
        });
        yield* file.sync;
        // Capture the final stable metadata only after every byte and its metadata have reached the file.
        const publicationIdentity = yield* requireExportTemporaryIdentity(yield* file.stat);
        yield* verifyOwnedExportTemporary(fs, temporary, publicationIdentity);
        yield* options.interlock?.beforePublish?.(temporary) ?? Effect.void;
        yield* verifyOwnedExportTemporary(fs, temporary, publicationIdentity);
        yield* options.interlock?.beforeLink?.(temporary) ?? Effect.void;
        const linked = yield* fs.link(temporary, output).pipe(Effect.result);
        if (linked._tag === 'Failure') {
          if (yield* fs.exists(output)) {
            return yield* Effect.fail(new CodeGraphCommandError(`Export output already exists: ${output}`));
          }
          return yield* linked.failure;
        }
        yield* verifyPublishedExportOutput(fs, output, publicationIdentity);
        yield* syncExportDirectory(fs, parent);
        yield* removeOwnedExportTemporary(fs, temporary, publicationIdentity);
        yield* syncExportDirectory(fs, parent);
        return rendered;
      }).pipe(
        // The descriptor stays open through verification and publication, preventing inode reuse in that window.
        Effect.ensuring(removeOpenedExportTemporary(fs, temporary, file)),
      );
    }),
  );
  yield* Console.log(
    `Exported ${summary.nodes.written} node(s) and ${summary.edges.written} relationship(s) as ${summary.format}: ${output}`,
  );
});

export const runCodeGraphWatch = Effect.fn('codeGraph.command.watch')(function* (
  config: RuntimeConfig,
  options: CwdOption,
) {
  const cwd = yield* commandCwd(options.cwd);
  const watcher = yield* CodeGraphWatcher;
  yield* Console.log(`Watching code graph inputs in ${cwd}. Press Ctrl-C to stop.`);
  yield* watcher.watch({
    cwd,
    key: cwd,
    onRefreshed: (symbols, edges) => Console.log(`Code graph refreshed: ${symbols} symbol(s), ${edges} edge(s).`),
    threadnoteHome: config.agentContextHome,
  });
});

function commandCwd(value: string | undefined) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return path.resolve(value?.trim() || system.currentDirectory());
  });
}

function parseCodeGraphExportLimit(
  value: CodeGraphExportLimit | string | undefined,
  flag: '--edge-limit' | '--node-limit',
): Effect.Effect<CodeGraphExportLimit | undefined, Error> {
  if (value === undefined || value === 'all') return Effect.succeed(value);
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0 || (typeof value === 'string' && !/^\d+$/.test(value.trim()))) {
    return Effect.fail(new CodeGraphCommandError(`${flag} must be "all" or a non-negative safe integer.`));
  }
  return Effect.succeed(parsed);
}

function verifyOwnedExportTemporary(
  fs: FileSystem.FileSystem,
  temporary: string,
  expected: CodeGraphExportTemporaryIdentity,
) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(temporary).pipe(Effect.option))) {
      return yield* Effect.fail(new CodeGraphCommandError('Export temporary path was replaced by a symbolic link.'));
    }
    const current = exportTemporaryIdentity(yield* fs.stat(temporary));
    if (Option.isNone(current) || !sameExportFile(expected, current.value)) {
      return yield* Effect.fail(
        new CodeGraphCommandError('Export temporary path no longer identifies the private output file.'),
      );
    }
  });
}

function verifyPublishedExportOutput(
  fs: FileSystem.FileSystem,
  output: string,
  expected: CodeGraphExportTemporaryIdentity,
) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(output).pipe(Effect.option))) {
      yield* fs.remove(output, {force: true});
      return yield* Effect.fail(new CodeGraphCommandError('Export publication did not link the private output file.'));
    }
    const current = yield* fs.stat(output).pipe(Effect.option);
    const identity = Option.flatMap(current, exportTemporaryIdentity);
    if (
      Option.isSome(identity) &&
      sameExportFile(expected, identity.value) &&
      Option.isNone(yield* fs.readLink(output).pipe(Effect.option))
    ) {
      return;
    }
    if (Option.isSome(yield* fs.readLink(output).pipe(Effect.option))) {
      yield* fs.remove(output, {force: true});
      return yield* Effect.fail(new CodeGraphCommandError('Export publication did not link the private output file.'));
    }
    if (Option.isSome(identity)) yield* removeOwnedExportTemporary(fs, output, identity.value);
    return yield* Effect.fail(new CodeGraphCommandError('Export publication did not link the private output file.'));
  });
}

function removeOwnedExportTemporary(
  fs: FileSystem.FileSystem,
  temporary: string,
  expected: CodeGraphExportTemporaryIdentity,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(temporary).pipe(Effect.option))) return;
    const current = yield* fs.stat(temporary).pipe(Effect.option);
    const currentIdentity = Option.flatMap(current, exportTemporaryIdentity);
    if (Option.isSome(currentIdentity) && sameExportFile(expected, currentIdentity.value)) {
      yield* fs.remove(temporary, {force: true});
    }
  }).pipe(Effect.catch(() => Effect.void));
}

function removeOpenedExportTemporary(
  fs: FileSystem.FileSystem,
  temporary: string,
  file: FileSystem.File,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const identity = exportTemporaryIdentity(yield* file.stat);
    if (Option.isSome(identity)) yield* removeOwnedExportTemporary(fs, temporary, identity.value);
  }).pipe(Effect.catch(() => Effect.void));
}

function requireExportTemporaryIdentity(info: FileSystem.File.Info) {
  return Option.match(exportTemporaryIdentity(info), {
    onNone: () =>
      Effect.fail(
        new CodeGraphCommandError('Export temporary file has insufficient identity metadata for safe publication.'),
      ),
    onSome: Effect.succeed,
  });
}

function exportTemporaryIdentity(info: FileSystem.File.Info): Option.Option<CodeGraphExportTemporaryIdentity> {
  const birthtime = Option.getOrUndefined(info.birthtime);
  const ino = Option.getOrUndefined(info.ino);
  const modifiedAt = Option.getOrUndefined(info.mtime);
  return info.type !== 'File' || birthtime === undefined || ino === undefined || modifiedAt === undefined
    ? Option.none()
    : Option.some({
        birthtimeMilliseconds: birthtime.getTime(),
        dev: info.dev,
        ino,
        mode: info.mode,
        modifiedAtMilliseconds: modifiedAt.getTime(),
        size: info.size,
      });
}

function sameExportFile(
  expected: CodeGraphExportTemporaryIdentity,
  current: CodeGraphExportTemporaryIdentity,
): boolean {
  return (
    expected.dev === current.dev &&
    expected.ino === current.ino &&
    expected.size === current.size &&
    expected.mode === current.mode &&
    expected.modifiedAtMilliseconds === current.modifiedAtMilliseconds &&
    expected.birthtimeMilliseconds === current.birthtimeMilliseconds
  );
}

function syncExportDirectory(fs: FileSystem.FileSystem, directory: string): Effect.Effect<void, never> {
  return Effect.scoped(
    fs.open(directory, {flag: 'r'}).pipe(
      Effect.flatMap(file => file.sync),
      Effect.catch(() => Effect.void),
    ),
  );
}

const ensureAnalysisSnapshot = Effect.fn('codeGraph.command.ensureAnalysisSnapshot')(function* (
  config: RuntimeConfig,
  cwd: string,
  json: boolean,
  freshnessPolicy: CodeGraphCliFreshnessPolicy,
  operation: CodeGraphCliAnalysisState['operation'],
  readTimeoutMilliseconds = CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS,
) {
  const indexer = yield* CodeGraphIndexer;
  return yield* resolveCodeGraphAnalysisSnapshot(
    config,
    cwd,
    freshnessPolicy,
    () =>
      json
        ? Effect.gen(function* () {
            const reportProgress = yield* makeCodeGraphJsonProgressReporter();
            yield* indexer.index({
              cwd,
              ensureVectors: false,
              onProgress: reportProgress,
              threadnoteHome: config.agentContextHome,
            });
          })
        : Effect.acquireUseRelease(
            startProgress('Refreshing repository graph before analysis.'),
            progress =>
              indexer.index({
                cwd,
                ensureVectors: false,
                onProgress: state => progress.update(progressMessage(state)).pipe(Effect.catch(() => Effect.void)),
                threadnoteHome: config.agentContextHome,
              }),
            progress => progress.stop.pipe(Effect.catch(() => Effect.void)),
          ),
    {operation, readTimeoutMilliseconds},
  );
});

function progressMessage(progress: CodeGraphProgress): string {
  switch (progress.phase) {
    case 'registering':
      return 'Registering repository index';
    case 'waiting':
      switch (progress.reason) {
        case 'database-writer':
          return 'Waiting for the code graph database writer';
        case 'home-builder-cap':
          return 'Waiting for the home code graph builder cap';
        case 'request-lock':
          return 'Waiting for the matching code graph request';
        case 'snapshot-build':
          return 'Waiting for the matching code graph snapshot build';
        case 'repository-lock':
          return 'Waiting for another code graph build to finish';
        default:
          return 'Waiting for another code graph build to finish';
      }
    case 'scanning': {
      const summary =
        `Scanning · ${progress.completed}/${progress.total} eligible files · ${progress.accepted} accepted · ` +
        `${progress.skipped} content skipped · ${progress.excluded} excluded`;
      if (!progress.activity) return summary;
      const activity = progress.activity;
      const timing = [
        activity.parseMilliseconds === undefined
          ? undefined
          : `parse ${formatMilliseconds(activity.parseMilliseconds)}`,
        activity.persistMilliseconds === undefined
          ? undefined
          : `persist ${formatMilliseconds(activity.persistMilliseconds)}`,
      ].filter((value): value is string => value !== undefined);
      const activityLabel =
        activity.stage === 'reading'
          ? `reading Git batch from ${activity.path}`
          : activity.stage === 'persisting'
            ? `persisting batch from ${activity.path}`
            : `${activity.stage} ${activity.path}`;
      return (
        `${summary} · ${activityLabel} · ${activity.language} · ${formatBytes(activity.bytes)} · ` +
        `batch ${activity.batchCompleted}/${activity.batchTotal}` +
        (activity.degraded ? ' · metadata fallback' : '') +
        (timing.length > 0 ? ` · ${timing.join(' · ')}` : '')
      );
    }
    case 'materializing':
      return materializationProgressMessage(progress);
    case 'reclaiming':
      return (
        `Reclaiming superseded graph storage · ${progress.completed}/${progress.total} snapshots · ` +
        `${progress.pagesCompleted.toLocaleString()} pages · ${progress.rowsDeleted.toLocaleString()} rows`
      );
    case 'resolving':
      if (progress.subphase === 'complete') {
        return `Resolved · ${progress.symbols} symbols · ${progress.edges} relationships · ${progress.resolved} references linked`;
      }
      if (!progress.activity) return 'Resolving references · preparing pass totals';
      return (
        `Resolving references · pass ${progress.activity.pass} · ` +
        `page ${progress.activity.pageCompleted}/${progress.activity.pageTotal} · ` +
        `${progress.activity.referencesCompleted}/${progress.activity.referencesTotal} references · ` +
        `${progress.activity.resolved} linked · ${progress.activity.referencesExamined} cumulative examined · ` +
        `match ${formatMilliseconds(progress.activity.matchingMilliseconds)} · ` +
        `transactions ${formatMilliseconds(progress.activity.transactionMilliseconds)} · ` +
        `elapsed ${formatMilliseconds(progress.activity.elapsedMilliseconds)}`
      );
    case 'embedding':
      return (
        `Embedding · ${Math.min(progress.total, progress.embedded + progress.reused)}/${progress.total} complete · ` +
        `${progress.reused} reused`
      );
    case 'activating': {
      if (progress.activity) {
        const activity = progress.activity;
        const rows = activity.rows === undefined ? '' : ` · ${activity.rows.toLocaleString()} rows`;
        const transaction =
          activity.transactionMilliseconds === undefined
            ? ''
            : ` · transaction ${formatMilliseconds(activity.transactionMilliseconds)}`;
        return (
          `Activating · ${activity.stage.replaceAll('-', ' ')} ${activity.state} · ` +
          `${formatMilliseconds(activity.stageElapsedMilliseconds)}${rows}${transaction}`
        );
      }
      return `Activating (${progress.subphase ?? 'snapshot'}) · ${progress.snapshotId}`;
    }
  }
}

function materializationProgressMessage(
  progress: Extract<CodeGraphProgress, {readonly phase: 'materializing'}>,
): string {
  const plan = [
    progress.metrics?.mode === undefined ? undefined : `${progress.metrics.mode.replaceAll('-', ' ')} materialization`,
    progress.metrics?.fallbackReason === undefined
      ? undefined
      : `incremental fallback: ${progress.metrics.fallbackReason.replaceAll('-', ' ')}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join(' · ');
  const summary = `Materializing · ${progress.completed}/${progress.total} files · ${progress.reused} reused${
    plan ? ` · ${plan}` : ''
  }`;
  const diskWarning = materializationDiskWarning(progress.metrics?.storage);
  const activity = progress.activity;
  if (!activity) return diskWarning ? `${summary} · ${diskWarning}` : summary;
  const details = [
    materializationStageLabel(activity.stage),
    `batch ${activeBatchNumber(activity.batchCompleted, activity.batchTotal)}/${activity.batchTotal}`,
    `${formatBytes(activity.sourceBytes)} source`,
    activity.cachedFactBytes === undefined ? undefined : `${formatBytes(activity.cachedFactBytes)} cached facts`,
    renderMaterializationRows(activity.rows),
    activity.elapsedMilliseconds === undefined ? undefined : formatMilliseconds(activity.elapsedMilliseconds),
    activity.transactionMilliseconds === undefined
      ? undefined
      : `transaction ${formatMilliseconds(activity.transactionMilliseconds)}`,
  ].filter((value): value is string => value !== undefined);
  return `${summary} · ${details.join(' · ')}${diskWarning ? ` · ${diskWarning}` : ''}`;
}

function materializationDiskWarning(
  storage:
    | NonNullable<NonNullable<Extract<CodeGraphProgress, {readonly phase: 'materializing'}>['metrics']>['storage']>
    | undefined,
): string | undefined {
  if (!storage) return undefined;
  const shortfalls = materializationStorageShortfalls(storage);
  if (shortfalls.length === 0) return undefined;
  if (shortfalls[0] === 'shared') {
    return (
      `low disk: ${formatBytes(storage.availableBytes!)} available is below the ` +
      `${formatBytes(storage.estimatedRequiredBytes!)} conservative combined estimate; ` +
      'indexing continues with live telemetry'
    );
  }
  const scopes = shortfalls.map(scope => {
    const available = scope === 'temporary' ? storage.temporaryAvailableBytes : storage.durableAvailableBytes;
    const required =
      scope === 'temporary'
        ? storage.estimatedTemporaryFilesystemRequiredBytes
        : storage.estimatedDurableFilesystemRequiredBytes;
    return `${scope} filesystem (${formatBytes(available!)} available, ${formatBytes(required!)} estimated)`;
  });
  return `low disk on ${scopes.join(' and ')}; indexing continues with live telemetry`;
}

function activeBatchNumber(completed: number, total: number): number {
  return total === 0 ? 0 : Math.min(total, completed + 1);
}

function materializationStageLabel(
  stage: NonNullable<Extract<CodeGraphProgress, {readonly phase: 'materializing'}>['activity']>['stage'],
): string {
  switch (stage) {
    case 'loading-cache':
      return 'loading cached facts';
    case 'attributing':
      return 'attributing facts';
    case 'preparing-rows':
      return 'preparing rows';
    case 'restoring-indexes':
      return 'restoring query indexes';
    case 'writing-analysis':
      return 'writing analysis summary';
    case 'writing-symbols':
      return 'writing symbols';
    case 'writing-lookups':
      return 'writing lookup keys';
    case 'writing-terms':
      return 'writing lexical terms';
    case 'writing-edges':
      return 'writing relationships';
    case 'writing-references':
      return 'writing references';
    case 'writing-receipt':
      return 'recording resumable batch';
    case 'writing-candidates':
      return 'writing reference candidates';
    case 'writing-facts':
      return 'writing graph facts';
    case 'committing':
      return 'committing batch';
  }
}

function renderMaterializationRows(
  rows:
    | {
        readonly edges?: number;
        readonly deduplicatedEdges?: number;
        readonly deduplicatedReferences?: number;
        readonly lookupKeys?: number;
        readonly referenceCandidates?: number;
        readonly references?: number;
        readonly reexports?: number;
        readonly symbols?: number;
        readonly terms?: number;
      }
    | undefined,
): string | undefined {
  if (!rows) return undefined;
  const values = [
    rows.symbols === undefined ? undefined : `${rows.symbols.toLocaleString()} symbols`,
    rows.lookupKeys === undefined ? undefined : `${rows.lookupKeys.toLocaleString()} lookup keys`,
    rows.terms === undefined ? undefined : `${rows.terms.toLocaleString()} terms`,
    rows.edges === undefined ? undefined : `${rows.edges.toLocaleString()} relationships`,
    rows.references === undefined ? undefined : `${rows.references.toLocaleString()} references`,
    rows.referenceCandidates === undefined ? undefined : `${rows.referenceCandidates.toLocaleString()} candidates`,
    rows.reexports === undefined ? undefined : `${rows.reexports.toLocaleString()} re-exports`,
    rows.deduplicatedEdges === undefined || rows.deduplicatedEdges === 0
      ? undefined
      : `${rows.deduplicatedEdges.toLocaleString()} repeated relationships collapsed`,
    rows.deduplicatedReferences === undefined || rows.deduplicatedReferences === 0
      ? undefined
      : `${rows.deduplicatedReferences.toLocaleString()} repeated resolution records collapsed`,
  ].filter((value): value is string => value !== undefined);
  return values.length > 0 ? values.join(', ') : undefined;
}

function etaBasisLabel(
  basis: 'cached-fact-bytes' | 'extraction-work' | 'files' | 'final-fact-bytes' | 'source-bytes',
): string {
  switch (basis) {
    case 'cached-fact-bytes':
      return 'cached-fact bytes';
    case 'final-fact-bytes':
      return 'final attributed fact bytes';
    case 'source-bytes':
      return 'source bytes';
    case 'extraction-work':
      return 'class-weighted extraction work';
    case 'files':
      return 'files';
  }
}

function formatMilliseconds(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';
  if (milliseconds < 1) return '<1ms';
  if (milliseconds < 1_000) return `${milliseconds.toFixed(milliseconds >= 100 ? 0 : 1)}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 1 : 2)}s`;
}
