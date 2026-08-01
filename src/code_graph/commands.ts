import {Console, Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {startProgress} from '../cli_ui.js';
import {SystemInfo} from '../effect/system.js';
import type {RuntimeConfig} from '../types.js';
import {CodeGraphIndexer} from './indexer.js';
import {codeGraphLayout} from './layout.js';
import {
  inspectObsoleteCodeGraphStores,
  purgeAllCodeGraphIndexes,
  purgeObsoleteCodeGraphStores,
  type ObsoleteCodeGraphStoreInventory,
} from './maintenance.js';
import {CodeGraphQueryService, renderCodeGraphResult} from './query.js';
import {repositoryChangesSince, resolveRepositoryIdentity} from './repository.js';
import {CodeGraphStore} from './store.js';
import type {CodeGraphProgress, CodeGraphQueryOptions} from './types.js';
import {CodeGraphWatcher} from './watcher.js';
import {CodeGraphAnalysis} from './analysis.js';
import {
  codeGraphAnalysisLimitsForView,
  renderCodeGraphAnalysis,
  renderCodeGraphReport,
  type CodeGraphAnalysisView,
} from './analysis_render.js';
import {exportCodeGraph, type CodeGraphExportFormat, type CodeGraphExportLimit} from './export.js';
import {
  readCodeGraphBuildStatuses,
  selectCodeGraphBuildStatuses,
  type ObservedCodeGraphBuildStatus,
} from './build_status.js';
import {compactCodeGraphStorage, inspectCodeGraphStorage, type CodeGraphStorage} from './storage.js';

interface CwdOption {
  readonly cwd?: string;
}

export interface CodeGraphExportInterlock {
  readonly afterOutputCheck?: () => Effect.Effect<void>;
  readonly beforeLink?: (temporaryPath: string) => Effect.Effect<void>;
  readonly beforePublish?: (temporaryPath: string) => Effect.Effect<void>;
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
  const identity = yield* resolveRepositoryIdentity(cwd);
  const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
  const obsoleteStores = yield* inspectObsoleteCodeGraphStores(config.agentContextHome, identity.checkoutId);
  const storage = yield* inspectCodeGraphStorage(config.agentContextHome, identity.checkoutId);
  const selection = selectCodeGraphBuildStatuses(yield* readCodeGraphBuildStatuses(layout));
  const buildStatuses = selection.builds;
  if (buildStatuses.length > 0) {
    const query = yield* CodeGraphQueryService;
    const ready = yield* query.statusForIdentity(config.agentContextHome, identity);
    const current =
      buildStatuses.find(status => status.identity.worktreeId === identity.worktreeId) ??
      buildStatuses.find(status => status.observation.liveness === 'active');
    const queuedWorktreeIds = [...new Set(selection.waiters.map(status => status.identity.worktreeId))];
    const status = {
      build: current,
      builds: buildStatuses,
      databasePath: layout.databasePath,
      identity,
      obsoleteStores,
      queuedWorktreeIds,
      readySnapshot: ready.readySnapshot,
      stale: ready.stale,
      storage,
      waiterCount: selection.waiters.length,
      waiters: selection.waiters,
    };
    if (options.json) {
      yield* Console.log(JSON.stringify({type: 'code-graph-status', version: 2, ...status}));
      return;
    }
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
    if (current.timings) {
      yield* Console.log(
        `Phase timings: read ${formatMilliseconds(current.timings.readingMilliseconds)} · ` +
          `parse ${formatMilliseconds(current.timings.extractionMilliseconds)} · ` +
          `persist ${formatMilliseconds(current.timings.persistenceMilliseconds)}`,
      );
    }
    const lastProgressAge = Math.max(0, Date.now() - Date.parse(current.timestamps.lastProgressAt));
    if (current.eta && lastProgressAge <= 15_000) {
      yield* Console.log(
        `Phase ETA: about ${formatStatusDuration(current.eta.remainingMilliseconds)} (${current.eta.confidence} confidence)`,
      );
    } else if (current.eta) {
      yield* Console.log('Phase ETA: paused while progress is silent.');
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
  const query = yield* CodeGraphQueryService;
  const status = yield* query.statusForIdentity(config.agentContextHome, identity);
  if (options.json) {
    yield* Console.log(JSON.stringify({type: 'code-graph-status', version: 1, ...status, obsoleteStores, storage}));
    return;
  }
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
        `${formatBytes(storage.shmBytes)} SHM · ${formatBytes(storage.totalBytes)} total`,
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
    yield* Console.log(
      `Compaction: ${page.threshold.recommended ? 'recommended' : 'not needed'}; threshold is ` +
        `${formatBytes(page.threshold.minimumReclaimableBytes)} and ` +
        `${formatPercent(page.threshold.minimumReclaimableRatio)} free.`,
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
    counters.skipped === undefined ? undefined : `${counters.skipped} skipped`,
    counters.excluded === undefined ? undefined : `${counters.excluded} excluded`,
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
  options: CwdOption & {readonly full?: boolean; readonly json?: boolean},
) {
  const indexer = yield* CodeGraphIndexer;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  if (options.json) {
    const summary = yield* indexer.index({
      cwd,
      force: options.full,
      onProgress: progress =>
        Console.error(
          JSON.stringify({
            type: 'code-graph-progress',
            version: 2,
            repository: {
              displayName: identity.displayName,
              repositoryId: identity.repositoryId,
            },
            ...progress,
          }),
        ),
      threadnoteHome: config.agentContextHome,
    });
    yield* Console.log(JSON.stringify({type: 'code-graph-index', version: 1, ...summary}));
    return;
  }
  yield* Console.log(`Indexing code graph: ${identity.displayName}`);
  yield* Effect.acquireUseRelease(
    startProgress('Scanning repository source from Git.'),
    progress =>
      indexer
        .index({
          cwd,
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
    progress => progress.stop().pipe(Effect.catch(() => Effect.void)),
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

export const runCodeGraphAnalysis = Effect.fn('codeGraph.command.analysis')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly communityId?: string;
    readonly includeHeuristic?: boolean;
    readonly includeModelAssociations?: boolean;
    readonly json?: boolean;
    readonly memberLimit?: number;
    readonly view: CodeGraphAnalysisView;
  },
) {
  const cwd = yield* commandCwd(options.cwd);
  const communityId = options.communityId?.trim();
  if (options.view === 'community' && !communityId?.match(/^cgc_[a-f0-9]{32}$/)) {
    return yield* Effect.fail(
      new Error('Community drill-down requires --community-id with a stable cgc_ identifier from graph communities.'),
    );
  }
  const status = yield* ensureAnalysisSnapshot(config, cwd, options.json === true);
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
    yield* Console.log(
      JSON.stringify({
        type: 'code-graph-analysis',
        repository: status.repository,
        result,
        version: 1,
      }),
    );
    return;
  }
  yield* Console.log(renderCodeGraphAnalysis(result, options.view).trimEnd());
});

export const runCodeGraphReport = Effect.fn('codeGraph.command.report')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly includeHeuristic?: boolean;
    readonly includeModelAssociations?: boolean;
    readonly output: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* commandCwd(options.cwd);
  const output = path.resolve(options.output);
  if (yield* fs.exists(output)) return yield* Effect.fail(new Error(`Report output already exists: ${output}`));
  const status = yield* ensureAnalysisSnapshot(config, cwd, false);
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
      readonly json?: boolean;
      readonly seedQueries?: readonly string[];
    },
) {
  const service = yield* CodeGraphQueryService;
  const cwd = yield* commandCwd(options.cwd);
  const status = yield* service.status(config.agentContextHome, cwd);
  const inspect = (onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void>) =>
    service.inspect({
      ...options,
      cwd,
      onProgress,
      refresh: true,
      threadnoteHome: config.agentContextHome,
    });
  const result = options.json
    ? yield* inspect(progress => Console.error(JSON.stringify({type: 'code-graph-progress', version: 2, ...progress})))
    : status.stale
      ? yield* Effect.acquireUseRelease(
          startProgress('Scanning repository source from Git.'),
          progress => inspect(state => progress.update(progressMessage(state)).pipe(Effect.catch(() => Effect.void))),
          progress => progress.stop().pipe(Effect.catch(() => Effect.void)),
        )
      : yield* inspect();
  yield* Console.log(options.json ? JSON.stringify(result) : renderCodeGraphResult(result).trimEnd());
});

export const runCodeGraphImpact = Effect.fn('codeGraph.command.impact')(function* (
  config: RuntimeConfig,
  options: CwdOption & {
    readonly base?: string;
    readonly depth?: number;
    readonly edgeLimit?: number;
    readonly json?: boolean;
    readonly nodeLimit?: number;
    readonly query?: string;
  },
) {
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
  options: CwdOption & {readonly all?: boolean; readonly dryRun?: boolean; readonly obsolete?: boolean},
) {
  const path = yield* Path.Path;
  if (options.all && options.obsolete) {
    return yield* Effect.fail(new Error('Use either --all or --obsolete, not both.'));
  }
  if (options.obsolete) {
    const cwd = yield* commandCwd(options.cwd);
    const identity = yield* resolveRepositoryIdentity(cwd);
    const summary = yield* purgeObsoleteCodeGraphStores(config.agentContextHome, identity.checkoutId, {
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

export const runCodeGraphCompact = Effect.fn('codeGraph.command.compact')(function* (
  config: RuntimeConfig,
  options: CwdOption & {readonly dryRun?: boolean; readonly force?: boolean; readonly json?: boolean},
) {
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const summary = yield* compactCodeGraphStorage(config.agentContextHome, identity.checkoutId, {
    dryRun: options.dryRun === true,
    force: options.force,
  });
  if (options.json) {
    yield* Console.log(JSON.stringify({type: 'code-graph-compaction', version: 1, ...summary}));
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
      new Error('No ready native code graph snapshot exists. Run `threadnote graph index` before exporting.'),
    );
  }
  const output = path.resolve(options.output);
  if (yield* fs.exists(output)) return yield* Effect.fail(new Error(`Export output already exists: ${output}`));
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
            return yield* Effect.fail(new Error(`Export output already exists: ${output}`));
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
    return Effect.fail(new Error(`${flag} must be "all" or a non-negative safe integer.`));
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
      return yield* Effect.fail(new Error('Export temporary path was replaced by a symbolic link.'));
    }
    const current = exportTemporaryIdentity(yield* fs.stat(temporary));
    if (Option.isNone(current) || !sameExportFile(expected, current.value)) {
      return yield* Effect.fail(new Error('Export temporary path no longer identifies the private output file.'));
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
      return yield* Effect.fail(new Error('Export publication did not link the private output file.'));
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
      return yield* Effect.fail(new Error('Export publication did not link the private output file.'));
    }
    if (Option.isSome(identity)) yield* removeOwnedExportTemporary(fs, output, identity.value);
    return yield* Effect.fail(new Error('Export publication did not link the private output file.'));
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
      Effect.fail(new Error('Export temporary file has insufficient identity metadata for safe publication.')),
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
) {
  const query = yield* CodeGraphQueryService;
  const indexer = yield* CodeGraphIndexer;
  let status = yield* query.status(config.agentContextHome, cwd);
  if (status.stale) {
    if (json) {
      yield* indexer.index({
        cwd,
        onProgress: progress => Console.error(JSON.stringify({type: 'code-graph-progress', version: 2, ...progress})),
        threadnoteHome: config.agentContextHome,
      });
    } else {
      yield* Effect.acquireUseRelease(
        startProgress('Refreshing repository graph before analysis.'),
        progress =>
          indexer.index({
            cwd,
            onProgress: state => progress.update(progressMessage(state)).pipe(Effect.catch(() => Effect.void)),
            threadnoteHome: config.agentContextHome,
          }),
        progress => progress.stop().pipe(Effect.catch(() => Effect.void)),
      );
    }
    status = yield* query.status(config.agentContextHome, cwd);
  }
  if (!status.readySnapshot) {
    return yield* Effect.fail(new Error('No ready native code graph snapshot exists after indexing.'));
  }
  return {
    databasePath: status.databasePath,
    repository: {
      displayName: status.identity.displayName,
      repositoryId: status.identity.repositoryId,
    },
    snapshot: status.readySnapshot,
  };
});

function progressMessage(progress: CodeGraphProgress): string {
  switch (progress.phase) {
    case 'registering':
      return 'Registering repository index';
    case 'waiting':
      return 'Waiting for another code graph build to finish';
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
      return `Materializing · ${progress.completed}/${progress.total} files · ${progress.reused} reused`;
    case 'resolving':
      return progress.subphase === 'references'
        ? 'Resolving references · totals and ETA unavailable until this pass completes'
        : `Resolved · ${progress.symbols} symbols · ${progress.edges} relationships · ${progress.resolved} references linked`;
    case 'embedding':
      return (
        `Embedding · ${Math.min(progress.total, progress.embedded + progress.reused)}/${progress.total} complete · ` +
        `${progress.reused} reused`
      );
    case 'activating':
      return `Activating (${progress.subphase ?? 'snapshot'}) · ${progress.snapshotId}`;
  }
}

function formatMilliseconds(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';
  if (milliseconds < 1) return '<1ms';
  if (milliseconds < 1_000) return `${milliseconds.toFixed(milliseconds >= 100 ? 0 : 1)}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 1 : 2)}s`;
}
