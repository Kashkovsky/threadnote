import {Effect, Path} from 'effect';
import {analyzeCodeGraph, type CodeGraphAnalysisCoverage, type CodeGraphAnalysisStatistics} from './analysis.js';
import {codeGraphAnalysisLimitsForView} from './analysis_render.js';
import {
  readAllCodeGraphBuildStatuses,
  selectCodeGraphBuildStatuses,
  type ObservedCodeGraphBuildStatus,
} from './build_status.js';
import {
  diagnoseCodeGraphDatabaseReadOnly,
  inspectObsoleteCodeGraphStores,
  codeGraphDatabasePaths,
} from './maintenance.js';
import {codeGraphRepositoryLockActive, codeGraphWorktreeBuildActive} from './maintenance_gate.js';
import {
  CodeGraphStore,
  sanitizeCodeGraphStoreDiagnostic,
  type CodeGraphDatabaseHealth,
  type CodeGraphStoreShape,
  type CodeGraphVisualizationCatalog,
} from './store.js';
import {inspectCodeGraphStorage, type CodeGraphStorage} from './storage.js';

const DIAGNOSTIC_CATALOG_PAGE_SIZE = 64;

type PrivacySafeStorage<Storage = CodeGraphStorage> = Storage extends {readonly databasePath: string}
  ? Omit<Storage, 'databasePath'>
  : never;

export interface CodeGraphDiagnosticsOptions {
  readonly analyze?: boolean;
  readonly deep?: boolean;
  readonly onProgress?: (progress: CodeGraphDiagnosticsProgress) => Effect.Effect<void, never>;
}

export interface CodeGraphDiagnosticsProgress {
  readonly current: number;
  readonly phase: 'analyzing' | 'checking';
  readonly total: number;
}

export interface CodeGraphDiagnosticsIssue {
  readonly code: 'active-build' | 'analysis-failed' | 'catalog-unavailable' | 'health-check-failed';
  readonly message: string;
}

export interface CodeGraphDiagnosticsAnalysis {
  readonly coverage: CodeGraphAnalysisCoverage;
  readonly statistics: CodeGraphAnalysisStatistics;
  readonly usage: {
    readonly aggregateEdgePageReads: number;
    readonly aggregateEdgeRows: number;
    readonly aggregateSummaryReads: number;
    readonly aggregateSymbolPageReads: number;
    readonly aggregateSymbolRows: number;
    readonly durationMilliseconds: number;
    readonly edgePageReads: number;
    readonly edgeVisits: number;
    readonly nodePageReads: number;
  };
  readonly warnings: readonly string[];
}

export interface CodeGraphDiagnosticsView {
  readonly activatedAt?: string;
  readonly analysis?: CodeGraphDiagnosticsAnalysis;
  readonly managementAvailable: boolean;
  readonly metrics: CodeGraphVisualizationCatalog['metrics'];
  readonly model: CodeGraphVisualizationCatalog['model'];
  readonly projectCount: number;
  readonly projectsTruncated: boolean;
  readonly repository: CodeGraphVisualizationCatalog['repository'];
  readonly snapshot: CodeGraphVisualizationCatalog['snapshot'];
  readonly viewWorktreeId: string;
  readonly workspaceCount: number;
  readonly workspacesTruncated: boolean;
}

export interface CodeGraphDatabaseDiagnostics {
  readonly builds: readonly Omit<ObservedCodeGraphBuildStatus, 'managerContext'>[];
  readonly checkoutId: string;
  readonly health?: CodeGraphDatabaseHealth;
  readonly healthState: 'checked' | 'deferred' | 'unreadable';
  readonly issues: readonly CodeGraphDiagnosticsIssue[];
  readonly storage: PrivacySafeStorage;
  readonly views: readonly CodeGraphDiagnosticsView[];
  readonly waiters: readonly Omit<ObservedCodeGraphBuildStatus, 'managerContext'>[];
}

export interface CodeGraphDiagnosticsReport {
  readonly databases: readonly CodeGraphDatabaseDiagnostics[];
  readonly generatedAt: string;
  readonly mode: {readonly analyze: boolean; readonly deep: boolean};
  readonly obsoleteStores: {
    readonly bytes: number;
    readonly checkouts: readonly {
      readonly bytes: number;
      readonly checkoutId: string;
      readonly fileCount: number;
      readonly versions: readonly number[];
    }[];
    readonly fileCount: number;
    readonly unsafeEntryCount: number;
  };
  readonly summary: {
    readonly activeBuildCount: number;
    readonly analysisCompleteCount: number;
    readonly analysisPartialCount: number;
    readonly databaseCount: number;
    readonly deferredDatabaseCount: number;
    readonly healthyDatabaseCount: number;
    readonly readySnapshotCount: number;
    readonly totalStorageBytes: number;
    readonly unhealthyDatabaseCount: number;
    readonly unreadableDatabaseCount: number;
    readonly viewCount: number;
    readonly waiterCount: number;
  };
  readonly type: 'code-graph-diagnostics';
  readonly version: 1;
}

export const inspectAllCodeGraphs = Effect.fn('codeGraph.inspectAllDiagnostics')(function* (
  threadnoteHome: string,
  options: CodeGraphDiagnosticsOptions = {},
) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const buildSelection = selectCodeGraphBuildStatuses(yield* readAllCodeGraphBuildStatuses(threadnoteHome));
  const obsolete = yield* inspectObsoleteCodeGraphStores(threadnoteHome);
  const entries = yield* Effect.forEach(
    databases,
    (database, index) =>
      Effect.gen(function* () {
        yield* options.onProgress?.({current: index + 1, phase: 'checking', total: databases.length}) ?? Effect.void;
        const checkoutId = path.basename(path.dirname(database));
        const builds = buildSelection.builds
          .filter(status => status.identity.checkoutId === checkoutId)
          .map(privacySafeBuildStatus);
        const waiters = buildSelection.waiters
          .filter(status => status.identity.checkoutId === checkoutId)
          .map(privacySafeBuildStatus);
        const active =
          (yield* codeGraphRepositoryLockActive(threadnoteHome, checkoutId)) ||
          (yield* codeGraphWorktreeBuildActive(threadnoteHome, checkoutId));
        const issues: CodeGraphDiagnosticsIssue[] = [];
        let health: CodeGraphDatabaseHealth | undefined;
        let healthState: CodeGraphDatabaseDiagnostics['healthState'];
        if (active) {
          healthState = 'deferred';
          issues.push({
            code: 'active-build',
            message: 'An active graph build owns this checkout; database health inspection was deferred.',
          });
        } else {
          const diagnosed = yield* diagnoseCodeGraphDatabaseReadOnly(database, options.deep === true).pipe(
            Effect.match({onFailure: cause => ({cause}) as const, onSuccess: value => ({value}) as const}),
          );
          if ('value' in diagnosed) {
            health = diagnosed.value;
            healthState = 'checked';
          } else {
            healthState = 'unreadable';
            issues.push({
              code: 'health-check-failed',
              message: privacySafeDiagnostic(diagnosed.cause),
            });
          }
        }
        const storage = privacySafeStorage(yield* inspectCodeGraphStorage(threadnoteHome, checkoutId));
        const catalogResult = yield* loadAllCatalogs(store, database).pipe(
          Effect.match({onFailure: cause => ({cause}) as const, onSuccess: value => ({value}) as const}),
        );
        const catalogs = 'value' in catalogResult ? catalogResult.value : [];
        if ('cause' in catalogResult) {
          issues.push({code: 'catalog-unavailable', message: privacySafeDiagnostic(catalogResult.cause)});
        }
        const analysisBySnapshot = new Map<string, CodeGraphDiagnosticsAnalysis | CodeGraphDiagnosticsIssue>();
        const views: CodeGraphDiagnosticsView[] = [];
        for (const catalog of catalogs) {
          let analysis: CodeGraphDiagnosticsAnalysis | undefined;
          if (options.analyze) {
            const existing = analysisBySnapshot.get(catalog.snapshot.id);
            if (existing) {
              if ('statistics' in existing) analysis = existing;
            } else {
              yield* options.onProgress?.({
                current: index + 1,
                phase: 'analyzing',
                total: databases.length,
              }) ?? Effect.void;
              const analyzed = yield* store
                .withSession(
                  database,
                  analyzeCodeGraph(store, {
                    databasePath: database,
                    limits: codeGraphAnalysisLimitsForView('communities'),
                    snapshot: catalog.snapshot,
                  }),
                  {readOnly: true},
                )
                .pipe(Effect.match({onFailure: cause => ({cause}) as const, onSuccess: value => ({value}) as const}));
              if ('value' in analyzed) {
                analysis = {
                  coverage: analyzed.value.coverage,
                  statistics: analyzed.value.statistics,
                  usage: analyzed.value.usage,
                  warnings: analyzed.value.warnings,
                };
                analysisBySnapshot.set(catalog.snapshot.id, analysis);
              } else {
                const issue = {
                  code: 'analysis-failed',
                  message: privacySafeDiagnostic(analyzed.cause),
                } satisfies CodeGraphDiagnosticsIssue;
                issues.push(issue);
                analysisBySnapshot.set(catalog.snapshot.id, issue);
              }
            }
          }
          views.push({
            ...(catalog.activatedAt ? {activatedAt: catalog.activatedAt} : {}),
            ...(analysis ? {analysis} : {}),
            managementAvailable: [...buildSelection.builds, ...buildSelection.waiters].some(
              status =>
                status.identity.checkoutId === checkoutId &&
                status.identity.worktreeId === catalog.viewWorktreeId &&
                status.managerContext !== undefined,
            ),
            metrics: catalog.metrics,
            model: catalog.model,
            projectCount: catalog.projectCount,
            projectsTruncated: catalog.projectsTruncated,
            repository: catalog.repository,
            snapshot: catalog.snapshot,
            viewWorktreeId: catalog.viewWorktreeId,
            workspaceCount: catalog.workspaceCount,
            workspacesTruncated: catalog.workspacesTruncated,
          });
        }
        return {builds, checkoutId, health, healthState, issues, storage, views, waiters};
      }),
    {concurrency: options.analyze || options.deep ? 1 : 2},
  );
  const analyses = entries.flatMap(entry => entry.views.flatMap(view => (view.analysis ? [view.analysis] : [])));
  return {
    databases: entries,
    generatedAt: new Date().toISOString(),
    mode: {analyze: options.analyze === true, deep: options.deep === true},
    obsoleteStores: {
      bytes: obsolete.bytes,
      checkouts: obsolete.checkouts.map(checkout => ({
        bytes: checkout.bytes,
        checkoutId: checkout.checkoutId,
        fileCount: checkout.files.length,
        versions: checkout.versions,
      })),
      fileCount: obsolete.fileCount,
      unsafeEntryCount: obsolete.unsafeEntryCount,
    },
    summary: {
      activeBuildCount: buildSelection.builds.filter(status => status.observation.liveness === 'active').length,
      analysisCompleteCount: analyses.filter(analysis => analysis.coverage.complete).length,
      analysisPartialCount: analyses.filter(analysis => !analysis.coverage.complete).length,
      databaseCount: entries.length,
      deferredDatabaseCount: entries.filter(entry => entry.healthState === 'deferred').length,
      healthyDatabaseCount: entries.filter(entry => entry.health?.integrity === 'ok').length,
      readySnapshotCount: entries.reduce((total, entry) => total + (entry.health?.readySnapshots ?? 0), 0),
      totalStorageBytes: entries.reduce(
        (total, entry) => total + (entry.storage.state === 'available' ? entry.storage.totalBytes : 0),
        0,
      ),
      unhealthyDatabaseCount: entries.filter(entry => entry.health !== undefined && entry.health.integrity !== 'ok')
        .length,
      unreadableDatabaseCount: entries.filter(entry => entry.healthState === 'unreadable').length,
      viewCount: entries.reduce((total, entry) => total + entry.views.length, 0),
      waiterCount: buildSelection.waiters.length,
    },
    type: 'code-graph-diagnostics',
    version: 1,
  } satisfies CodeGraphDiagnosticsReport;
});

export function renderCodeGraphDiagnostics(report: CodeGraphDiagnosticsReport): string {
  const lines = [
    'Native code graph diagnostics',
    `Databases: ${report.summary.databaseCount} · healthy ${report.summary.healthyDatabaseCount} · unhealthy ${report.summary.unhealthyDatabaseCount} · deferred ${report.summary.deferredDatabaseCount} · unreadable ${report.summary.unreadableDatabaseCount}`,
    `Ready snapshots: ${report.summary.readySnapshotCount} · indexed views ${report.summary.viewCount} · storage ${formatBytes(report.summary.totalStorageBytes)}`,
  ];
  for (const database of report.databases) {
    const repository = database.views[0]?.repository.displayName ?? 'unknown repository';
    const health = database.health
      ? `${database.health.integrity}; schema v${database.health.schemaVersion ?? 'unknown'}; extension ${database.health.persistentExtensionSchemaRevision ?? 'missing'}`
      : database.healthState;
    lines.push(
      '',
      `${repository} · checkout ${database.checkoutId.slice(-8)}`,
      `Health: ${health}`,
      `Snapshots: ${database.health?.readySnapshots ?? 0} ready · ${(database.health?.buildingSnapshots ?? 0) + (database.health?.failedSnapshots ?? 0)} incomplete`,
      `Storage: ${database.storage.state === 'available' ? formatBytes(database.storage.totalBytes) : 'missing'}`,
    );
    for (const view of database.views) {
      lines.push(
        `View ${view.viewWorktreeId.slice(-8)}: ${view.snapshot.fileCount} files · ${view.snapshot.symbolCount} symbols · ${view.snapshot.edgeCount} edges`,
      );
      if (view.analysis) {
        lines.push(
          `Analysis: ${view.analysis.coverage.complete ? 'complete' : 'partial'} · ${view.analysis.statistics.connectedComponentCount} component(s) · ${view.analysis.statistics.communityCount} communit${view.analysis.statistics.communityCount === 1 ? 'y' : 'ies'}`,
        );
      }
    }
    for (const issue of database.issues) lines.push(`Warning: ${issue.code}: ${issue.message}`);
  }
  if (report.obsoleteStores.fileCount > 0 || report.obsoleteStores.unsafeEntryCount > 0) {
    lines.push(
      '',
      `Obsolete stores: ${report.obsoleteStores.fileCount} file(s), ${formatBytes(report.obsoleteStores.bytes)}; unsafe entries ${report.obsoleteStores.unsafeEntryCount}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const loadAllCatalogs = Effect.fn('codeGraph.loadAllDiagnosticCatalogs')(function* (
  store: CodeGraphStoreShape,
  database: string,
) {
  const catalogs: CodeGraphVisualizationCatalog[] = [];
  for (let offset = 0; ; offset += DIAGNOSTIC_CATALOG_PAGE_SIZE) {
    const page = yield* store.loadVisualizationCatalogs(database, 'deferred', {
      includeDependencies: false,
      projectLimit: 1,
      viewLimit: DIAGNOSTIC_CATALOG_PAGE_SIZE,
      viewOffset: offset,
      workspaceLimit: 1,
    });
    catalogs.push(...page);
    if (page.length < DIAGNOSTIC_CATALOG_PAGE_SIZE) return catalogs;
  }
});

function privacySafeBuildStatus(
  status: ObservedCodeGraphBuildStatus,
): Omit<ObservedCodeGraphBuildStatus, 'managerContext'> {
  const {managerContext: _managerContext, ...safe} = status;
  return safe;
}

function privacySafeStorage(storage: CodeGraphStorage): PrivacySafeStorage {
  const {databasePath: _databasePath, ...safe} = storage;
  return safe;
}

function privacySafeDiagnostic(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return sanitizeCodeGraphStoreDiagnostic(message) || 'unknown database error';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (const candidate of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = candidate;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}
