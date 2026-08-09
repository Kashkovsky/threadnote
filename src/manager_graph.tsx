import React, {useEffect, useMemo, useRef, useState} from 'react';
import * as THREE from 'three';
import type {CodeGraphLocalDiagnosticsReport} from './code_graph/diagnostics.js';
import type {CodeGraphLocalAssociation} from './code_graph/local_provenance.js';
import type {CodeGraphMaintenanceStatus} from './code_graph/maintenance_gate.js';
import {compareCodeUnits} from './code_graph/ordering.js';
import {
  CODE_GRAPH_SLOW_FILE_THRESHOLD_MILLISECONDS,
  CODE_GRAPH_TOP_SLOW_FILE_LIMIT,
} from './code_graph/progress_telemetry.js';
import {
  MANAGER_GRAPH_DEFAULT_EDGE_LIMIT,
  MANAGER_GRAPH_DEFAULT_NODE_LIMIT,
  MANAGER_GRAPH_MAX_EDGE_LIMIT,
  MANAGER_GRAPH_MAX_NODE_LIMIT,
  type ManagerGraphVisualizationLimits,
} from './manager_graph_limits.js';
import {type ManagerDialogOptions, useOptionalManagerDialogs} from './manager_dialog.js';

interface GraphProject {
  readonly buildSystem?: string;
  readonly fileCount?: number;
  readonly id: string;
  readonly kind?: string;
  readonly label: string;
  readonly model?: 'component' | 'facet' | 'legacy-fallback';
  readonly provenance?: string;
  readonly symbolCount?: number;
  readonly workspaceId?: string;
}

interface GraphWorkspaceDescriptor {
  readonly buildSystem: string;
  readonly id: string;
  readonly name: string;
  readonly root: string;
}

interface GraphSnapshot {
  readonly commit: string;
  readonly completedAt?: string;
  readonly dirty: boolean;
  readonly edgeCount: number;
  readonly fileCount: number;
  readonly id: string;
  readonly symbolCount: number;
}

export interface GraphRepository {
  readonly accounting: {
    readonly attributedSymbols: number;
    readonly componentSymbols: number;
    readonly fallbackSymbols: number;
    readonly omittedSymbols: number;
    readonly totalSymbols: number;
  };
  readonly activatedAt?: string;
  readonly checkoutId: string;
  readonly displayName: string;
  readonly id: string;
  readonly label: string;
  readonly localAssociation: CodeGraphLocalAssociation;
  readonly metrics: 'complete' | 'deferred';
  readonly model: 'legacy-fallback' | 'workspace';
  readonly projectCount: number;
  readonly projects: readonly GraphProject[];
  readonly projectsTruncated: boolean;
  readonly snapshot: GraphSnapshot;
  readonly worktreeId: string;
  readonly workspaceCount: number;
  readonly workspaces: readonly GraphWorkspaceDescriptor[];
  readonly workspacesTruncated: boolean;
}

export interface GraphRepositoryGroup {
  readonly defaultViewId: string;
  readonly displayName: string;
  readonly id: string;
  readonly repositoryId: string;
  readonly views: readonly GraphRepository[];
  readonly viewsTruncated: boolean;
}

export interface GraphCatalogDiagnostic {
  readonly checkoutId: string;
  readonly code: 'lease-deferred' | 'lease-failed' | 'no-ready-snapshot' | 'unreadable-database';
  readonly message: string;
}

export interface GraphCatalog {
  readonly builds: readonly GraphBuildStatus[];
  readonly catalogRevision?: string;
  readonly diagnostics: readonly GraphCatalogDiagnostic[];
  readonly lifecyclePending?: boolean;
  readonly maintenance?: CodeGraphMaintenanceStatus;
  readonly repositories: readonly GraphRepositoryGroup[];
  readonly waiterCount: number;
  readonly waiters: readonly GraphBuildStatus[];
}

export type GraphAdministrationAction =
  | {
      readonly action: 'compact' | 'index';
      readonly checkoutId: string;
      readonly cwd?: string;
      readonly dryRun?: boolean;
      readonly force?: boolean;
      readonly full?: boolean;
      readonly repositoryId: string;
      readonly worktreeId: string;
    }
  | {
      readonly action: 'purge' | 'purge-obsolete';
      readonly checkoutId: string;
      readonly dryRun?: boolean;
    }
  | {
      readonly action: 'remove-view';
      readonly checkoutId: string;
      readonly dryRun?: boolean;
      readonly expectedSnapshotId: string;
      readonly worktreeId: string;
    }
  | {readonly action: 'purge-all'; readonly dryRun?: boolean}
  | {readonly action: 'repair'; readonly deep?: boolean; readonly dryRun?: boolean};

type GraphWorktreeAdministrationAction = Extract<GraphAdministrationAction, {readonly action: 'compact' | 'index'}>;

export function graphAdministrationTarget(
  checkoutId: string,
  view: {readonly repository: {readonly repositoryId: string}; readonly worktreeId: string},
): Pick<GraphWorktreeAdministrationAction, 'checkoutId' | 'repositoryId' | 'worktreeId'> {
  return {checkoutId, repositoryId: view.repository.repositoryId, worktreeId: view.worktreeId};
}

export function graphViewRemovalTarget(
  checkoutId: string,
  view: {readonly snapshot: {readonly id: string}; readonly worktreeId: string},
): Pick<
  Extract<GraphAdministrationAction, {readonly action: 'remove-view'}>,
  'checkoutId' | 'expectedSnapshotId' | 'worktreeId'
> {
  return {checkoutId, expectedSnapshotId: view.snapshot.id, worktreeId: view.worktreeId};
}

export interface GraphCatalogPage {
  readonly projectOffset: number;
  readonly query: string;
  readonly repository: GraphRepository;
  readonly workspaceOffset: number;
}

export interface GraphViewPage {
  readonly hasMore: boolean;
  readonly offset: number;
  readonly query: string;
  readonly repositories: readonly GraphRepositoryGroup[];
}

export interface GraphBuildStatus {
  readonly activation?: {
    readonly activity: {
      readonly elapsedMilliseconds: number;
      readonly rows?: number;
      readonly stage: GraphActivationStage;
      readonly stageElapsedMilliseconds: number;
      readonly startedAt: string;
      readonly state: 'completed' | 'progress' | 'started';
      readonly transactionMilliseconds?: number;
    };
  };
  readonly activity?: {
    readonly batchCompleted: number;
    readonly batchTotal: number;
    readonly bytes: number;
    readonly classifier?: string;
    readonly degraded?: boolean;
    readonly factsBytes?: number;
    readonly language: string;
    readonly parseMilliseconds?: number;
    readonly persistMilliseconds?: number;
    readonly relations?: number;
    readonly role?: string;
    readonly sizeBucket?: '0-16KiB' | '16-64KiB' | '64-256KiB' | '256KiB-1MiB' | '>1MiB';
    readonly stage: 'extracting' | 'persisting' | 'reading';
    readonly symbols?: number;
  };
  readonly buildId: string;
  readonly coordination?: {
    readonly lockVerified: boolean;
    readonly progressSilent?: boolean;
    readonly role: 'history' | 'owner' | 'waiter';
  };
  readonly counters: {
    readonly accepted?: number;
    readonly completed?: number;
    readonly edges?: number;
    readonly excluded?: number;
    readonly pagesCompleted?: number;
    readonly reused?: number;
    readonly resolved?: number;
    readonly rowsDeleted?: number;
    readonly skipped?: number;
    readonly symbols?: number;
    readonly total?: number;
    readonly unit?: string;
  };
  readonly error?: {readonly summary: string};
  readonly eta?: {
    readonly basis?: 'cached-fact-bytes' | 'files' | 'final-fact-bytes' | 'source-bytes';
    readonly confidence: 'high' | 'low' | 'medium';
    readonly remainingMilliseconds: number;
  };
  readonly extraction?: {
    readonly completedFiles: number;
    readonly slowFiles: number;
    readonly topSlowFiles: readonly {
      readonly classifier: string;
      readonly degraded?: boolean;
      readonly durationMilliseconds: number;
      readonly extension: string;
      readonly factsBytes?: number;
      readonly language: string;
      readonly pathHash: string;
      readonly relations?: number;
      readonly role: string;
      readonly sizeBucket: '0-16KiB' | '16-64KiB' | '64-256KiB' | '256KiB-1MiB' | '>1MiB';
      readonly sourceBytes: number;
      readonly symbols?: number;
    }[];
  };
  readonly identity: {
    readonly checkoutId: string;
    readonly commit: string;
    readonly displayName?: string;
    readonly repositoryId: string;
    readonly worktreeId: string;
  };
  readonly managerContext?: {
    readonly worktreePath: string;
  };
  readonly observation: {
    readonly heartbeatAgeMilliseconds: number;
    readonly liveness: 'abandoned' | 'active' | 'completed' | 'failed' | 'stalled';
  };
  readonly materialization?: {
    readonly activity?: {
      readonly batchCompleted: number;
      readonly batchTotal: number;
      readonly cachedFactBytes?: number;
      readonly elapsedMilliseconds?: number;
      readonly factsBytes?: number;
      readonly rows?: GraphMaterializationRows;
      readonly sourceBytes: number;
      readonly stage: GraphMaterializationStage;
      readonly stageElapsedMilliseconds?: number;
      readonly startedAt: string;
      readonly transactionMilliseconds?: number;
    };
    readonly metrics?: {
      readonly attributionMilliseconds?: number;
      readonly batchesCompleted: number;
      readonly batchesTotal: number;
      readonly cachedFactBytesCompleted?: number;
      readonly cachedFactBytesTotal?: number;
      readonly factsBytesCompleted?: number;
      readonly factsBytesTotal?: number;
      readonly loadingMilliseconds?: number;
      readonly rows?: GraphMaterializationRows;
      readonly sourceBytesCompleted: number;
      readonly sourceBytesTotal: number;
      readonly stageMilliseconds?: Readonly<Partial<Record<GraphMaterializationStage, number>>>;
      readonly storage?: GraphMaterializationStorage;
      readonly transactionMilliseconds?: number;
    };
  };
  readonly owner: {readonly processId: number; readonly processStartIdentity?: string};
  readonly phase: string;
  readonly request?: {readonly key: string};
  readonly resolution?: {
    readonly activity: {
      readonly aliasesDiscovered: number;
      readonly elapsedMilliseconds: number;
      readonly matchingMilliseconds: number;
      readonly pageCompleted: number;
      readonly pageTotal: number;
      readonly pagesCompleted: number;
      readonly pass: number;
      readonly referencesCompleted: number;
      readonly referencesExamined: number;
      readonly referencesTotal: number;
      readonly resolved: number;
      readonly startedAt: string;
      readonly transactionMilliseconds: number;
    };
  };
  readonly result?: {readonly snapshotId: string};
  readonly state: 'completed' | 'failed' | 'queued' | 'running';
  readonly subphase?: string;
  readonly timings?: {
    readonly extractionMilliseconds: number;
    readonly persistenceMilliseconds: number;
    readonly readingMilliseconds: number;
  };
  readonly timestamps: {
    readonly heartbeatAt: string;
    readonly lastProgressAt: string;
    readonly startedAt: string;
  };
}

type GraphActivationStage =
  | 'checkpointing-snapshot'
  | 'committing-snapshot'
  | 'copying-edges'
  | 'copying-files'
  | 'copying-lookup-keys'
  | 'copying-reexports'
  | 'copying-symbols'
  | 'copying-terms'
  | 'copying-workspace'
  | 'recording-completion'
  | 'validating-input';

type GraphMaterializationStage =
  | 'attributing'
  | 'committing'
  | 'loading-cache'
  | 'preparing-rows'
  | 'writing-analysis'
  | 'writing-candidates'
  | 'writing-edges'
  | 'writing-facts'
  | 'writing-lookups'
  | 'writing-references'
  | 'writing-receipt'
  | 'writing-symbols'
  | 'writing-terms';

interface GraphMaterializationRows {
  readonly deduplicatedEdges?: number;
  readonly deduplicatedReferences?: number;
  readonly edges?: number;
  readonly lookupKeys?: number;
  readonly referenceCandidates?: number;
  readonly references?: number;
  readonly reexports?: number;
  readonly symbols?: number;
  readonly terms?: number;
}

interface GraphMaterializationStorage {
  readonly availableBytes?: number;
  readonly durableAvailableBytes?: number;
  readonly durableDatabaseBytes?: number;
  readonly durableDatabaseFileBytes?: number;
  readonly durableDatabaseFileHighWaterBytes?: number;
  readonly durableDatabaseGrowthBytes?: number;
  readonly durableDatabaseGrowthHighWaterBytes?: number;
  readonly durableDatabaseHighWaterBytes?: number;
  readonly durableDatabaseStartBytes?: number;
  readonly durableFilesystemBytes?: number;
  readonly durableFilesystemHighWaterBytes?: number;
  readonly durableJournalBytes?: number;
  readonly durableJournalHighWaterBytes?: number;
  readonly durableSharedMemoryBytes?: number;
  readonly durableSharedMemoryHighWaterBytes?: number;
  readonly durableWalBytes?: number;
  readonly durableWalHighWaterBytes?: number;
  readonly estimateBasis?: 'cached-fact-bytes' | 'final-fact-bytes' | 'source-bytes-fallback';
  readonly estimatedConcurrentBuildBytes?: number;
  readonly estimatedDurableFilesystemRequiredBytes?: number;
  readonly estimatedDurableSnapshotBytes?: number;
  readonly estimatedJournalBytes?: number;
  readonly estimatedRequiredBytes?: number;
  readonly estimatedTemporaryFilesystemRequiredBytes?: number;
  readonly estimatedTemporaryDatabaseBytes?: number;
  readonly filesystemsShared?: boolean;
  readonly materializationMode?: 'direct-persistent' | 'temporary-staged';
  readonly temporaryAvailableBytes?: number;
  readonly temporaryDatabaseBytes: number;
  readonly temporaryDatabaseHighWaterBytes: number;
}

export function graphBuildIsActive(build: GraphBuildStatus): boolean {
  return (
    (build.state === 'queued' || build.state === 'running') &&
    build.observation.liveness === 'active' &&
    build.coordination?.role !== 'history'
  );
}

export function graphBuildShouldDisplay(build: GraphBuildStatus): boolean {
  return build.state === 'failed' || graphBuildIsActive(build);
}

const GRAPH_ADMINISTRATION_JOB_LIMIT = 4;

export interface GraphAdministrationJobSelection {
  readonly hiddenCount: number;
  readonly jobs: readonly GraphBuildStatus[];
  readonly total: number;
}

/** Keep administration cards focused on bounded, actionable build state. */
export function graphAdministrationJobSelection(
  builds: readonly GraphBuildStatus[],
  waiters: readonly GraphBuildStatus[],
): GraphAdministrationJobSelection {
  const unique = new Map<string, GraphBuildStatus>();
  for (const job of [...builds, ...waiters]) {
    if (graphBuildShouldDisplay(job) && !unique.has(job.buildId)) unique.set(job.buildId, job);
  }
  const relevant = [...unique.values()].sort(compareGraphAdministrationJob);
  const jobs = relevant.slice(0, GRAPH_ADMINISTRATION_JOB_LIMIT);
  return {hiddenCount: relevant.length - jobs.length, jobs, total: relevant.length};
}

function compareGraphAdministrationJob(left: GraphBuildStatus, right: GraphBuildStatus): number {
  const priority = (job: GraphBuildStatus) => (job.state === 'running' ? 0 : job.state === 'queued' ? 1 : 2);
  return (
    priority(left) - priority(right) ||
    (Date.parse(right.timestamps.lastProgressAt) || 0) - (Date.parse(left.timestamps.lastProgressAt) || 0) ||
    compareCodeUnits(left.buildId, right.buildId)
  );
}

export interface GraphBuildTarget {
  readonly repositoryLabel: string;
  readonly worktreeLabel: string;
}

export interface GraphBuildConcurrencyState {
  readonly activeTargetCommit?: string;
  readonly latestTargetCommit: string;
  readonly queuedRequests: number;
  readonly readySnapshotCommit?: string;
  readonly staleReady: boolean;
}

export function graphBuildTarget(
  build: GraphBuildStatus,
  repositories: readonly GraphRepositoryGroup[],
): GraphBuildTarget {
  const repository = repositories.find(candidate => candidate.repositoryId === build.identity.repositoryId);
  const view = repository?.views.find(
    candidate =>
      candidate.checkoutId === build.identity.checkoutId && candidate.worktreeId === build.identity.worktreeId,
  );
  const fallbackName = build.identity.displayName?.trim();
  const repositoryLabel = repository
    ? graphRepositoryOptionLabel(repository, repositories)
    : fallbackName
      ? `${fallbackName} · repository ${shortGraphIdentity(build.identity.repositoryId)}`
      : `Repository ${shortGraphIdentity(build.identity.repositoryId)}`;
  return {
    repositoryLabel,
    worktreeLabel:
      view?.localAssociation.displayPath ??
      view?.label ??
      `Checkout ${shortGraphIdentity(build.identity.checkoutId)} · worktree ${shortGraphIdentity(
        build.identity.worktreeId,
      )}`,
  };
}

/**
 * Summarize only observed concurrency facts. File locks do not promise FIFO, so
 * waiters are counted without claiming an execution position. The most recent
 * request is the latest requested target, independent of input ordering.
 */
export function graphBuildConcurrencyState(
  build: GraphBuildStatus,
  waiters: readonly GraphBuildStatus[],
  repositories: readonly GraphRepositoryGroup[],
): GraphBuildConcurrencyState {
  const matchingWaiters = waiters.filter(
    waiter =>
      waiter.buildId !== build.buildId &&
      waiter.identity.checkoutId === build.identity.checkoutId &&
      waiter.identity.worktreeId === build.identity.worktreeId,
  );
  const latest = [build, ...matchingWaiters].sort(compareGraphBuildRequest)[matchingWaiters.length]!;
  const repository = repositories.find(candidate => candidate.repositoryId === build.identity.repositoryId);
  const ready = repository?.views.find(
    candidate =>
      candidate.checkoutId === build.identity.checkoutId && candidate.worktreeId === build.identity.worktreeId,
  );
  const queuedRequests = matchingWaiters.length + (build.state === 'queued' ? 1 : 0);
  const readySnapshotCommit = ready?.snapshot.commit;
  return {
    ...(build.state === 'running' ? {activeTargetCommit: build.identity.commit} : {}),
    latestTargetCommit: latest.identity.commit,
    queuedRequests,
    ...(readySnapshotCommit === undefined ? {} : {readySnapshotCommit}),
    staleReady: readySnapshotCommit !== undefined && !graphCommitMatches(readySnapshotCommit, latest.identity.commit),
  };
}

function compareGraphBuildRequest(left: GraphBuildStatus, right: GraphBuildStatus): number {
  const leftStartedAt = Date.parse(left.timestamps.startedAt) || 0;
  const rightStartedAt = Date.parse(right.timestamps.startedAt) || 0;
  return leftStartedAt - rightStartedAt || compareCodeUnits(left.buildId, right.buildId);
}

function graphCommitMatches(left: string, right: string): boolean {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

export function graphStatusPollDelay(
  builds: readonly GraphBuildStatus[],
  maintenance?: CodeGraphMaintenanceStatus,
  lifecyclePending = false,
): number {
  return builds.some(graphBuildIsActive) || maintenance !== undefined || lifecyclePending ? 1_000 : 5_000;
}

export function graphMaintenanceStatusLabel(status: CodeGraphMaintenanceStatus): string {
  const operation = status.operation === 'selected-snapshot-purge' ? 'Selected snapshot purge' : 'Graph maintenance';
  const phases: Record<CodeGraphMaintenanceStatus['phase'], string> = {
    'acquiring-gates': 'acquiring safety gates',
    'retiring-and-cleaning': 'retiring snapshot and advancing cleanup',
    'status-unavailable': 'working; detailed status unavailable',
    'verifying-graph': 'rechecking graph safety evidence',
    'verifying-vectors': 'rechecking vector safety evidence',
    'waiting-builders': 'waiting for graph builders',
    working: 'working',
  };
  return `${operation} · ${phases[status.phase]}`;
}

export function graphCompletedBuildResultIdentity(build: GraphBuildStatus): string | undefined {
  return build.state === 'completed' && build.result !== undefined
    ? `${build.buildId}:${build.result.snapshotId}`
    : undefined;
}

export function graphStatusRequiresCatalogRefresh(
  catalog: GraphCatalog | undefined,
  builds: readonly GraphBuildStatus[],
  acknowledgedResults: ReadonlySet<string> = new Set(),
  observedCatalogRevision?: string,
): boolean {
  if (
    catalog !== undefined &&
    observedCatalogRevision !== undefined &&
    catalog.catalogRevision !== observedCatalogRevision
  ) {
    return true;
  }
  if (!catalog) {
    return builds.some(build => {
      const identity = graphCompletedBuildResultIdentity(build);
      return identity !== undefined && !acknowledgedResults.has(identity);
    });
  }
  return builds.some(build => {
    const identity = graphCompletedBuildResultIdentity(build);
    const resultVisible = catalog.repositories.some(
      repository =>
        repository.repositoryId === build.identity.repositoryId &&
        repository.views.some(
          view =>
            view.checkoutId === build.identity.checkoutId &&
            view.worktreeId === build.identity.worktreeId &&
            view.snapshot.id === build.result?.snapshotId,
        ),
    );
    return identity !== undefined && !acknowledgedResults.has(identity) && !resultVisible;
  });
}

export function graphWaiterCountForBuild(build: GraphBuildStatus, waiters: readonly GraphBuildStatus[]): number {
  return waiters.filter(
    waiter =>
      waiter.identity.checkoutId === build.identity.checkoutId &&
      waiter.identity.worktreeId === build.identity.worktreeId &&
      waiter.request?.key === build.request?.key,
  ).length;
}

export function resolveGraphSelection(
  repositories: readonly GraphRepositoryGroup[],
  currentRepositoryId: string,
  currentViewId: string,
): {readonly repositoryId: string; readonly viewId: string} {
  const repository = repositories.find(candidate => candidate.id === currentRepositoryId) ?? repositories[0];
  if (!repository) return {repositoryId: '', viewId: ''};
  const view = repository.views.find(candidate => candidate.id === currentViewId);
  return {
    repositoryId: repository.id,
    viewId: view?.id ?? repository.defaultViewId ?? repository.views[0]?.id ?? '',
  };
}

export function graphRepositoryOptionLabel(
  repository: GraphRepositoryGroup,
  repositories: readonly GraphRepositoryGroup[],
): string {
  const collides = repositories.some(
    candidate => candidate.id !== repository.id && candidate.displayName === repository.displayName,
  );
  return collides ? `${repository.displayName} · ${repository.id.slice(0, 8)}` : repository.displayName;
}

function shortGraphIdentity(value: string): string {
  return value.slice(-8) || 'unknown';
}

export function mergeGraphRepositoryGroups(
  current: readonly GraphRepositoryGroup[],
  additions: readonly GraphRepositoryGroup[],
): readonly GraphRepositoryGroup[] {
  const groups = new Map(current.map(group => [group.id, {...group, views: [...group.views]}]));
  for (const addition of additions) {
    const existing = groups.get(addition.id);
    if (!existing) {
      groups.set(addition.id, {...addition, views: [...addition.views]});
      continue;
    }
    const views = new Map(existing.views.map(view => [view.id, view]));
    for (const view of addition.views) {
      const currentView = views.get(view.id);
      views.set(view.id, currentView ? mergeGraphRepository(currentView, view) : view);
    }
    groups.set(addition.id, {
      ...existing,
      defaultViewId: existing.defaultViewId || addition.defaultViewId,
      views: [...views.values()],
      viewsTruncated: existing.viewsTruncated || addition.viewsTruncated,
    });
  }
  return [...groups.values()].sort(
    (left, right) => compareCodeUnits(left.displayName, right.displayName) || compareCodeUnits(left.id, right.id),
  );
}

export function graphCatalogPageOffsets(input: {
  readonly baseRepository?: GraphRepository;
  readonly baseRepositoryGroup?: GraphRepositoryGroup;
  readonly checkoutId: string;
  readonly continuation?: {
    readonly projectOffset: number;
    readonly viewId: string;
    readonly viewOffset: number;
    readonly workspaceOffset: number;
  };
  readonly viewId: string;
}): {readonly projectOffset: number; readonly viewOffset: number; readonly workspaceOffset: number} {
  const continuation = input.continuation?.viewId === input.viewId ? input.continuation : undefined;
  return {
    projectOffset:
      continuation?.projectOffset ??
      input.baseRepository?.projects.filter(project => project.id.startsWith('cgp_')).length ??
      0,
    viewOffset:
      continuation?.viewOffset ??
      input.baseRepositoryGroup?.views.filter(view => view.checkoutId === input.checkoutId).length ??
      0,
    workspaceOffset: continuation?.workspaceOffset ?? input.baseRepository?.workspaces.length ?? 0,
  };
}

function mergeGraphRepository(current: GraphRepository, addition: GraphRepository): GraphRepository {
  if (current.snapshot.id !== addition.snapshot.id) {
    const currentTime = Date.parse(current.activatedAt ?? current.snapshot.completedAt ?? '') || 0;
    const additionTime = Date.parse(addition.activatedAt ?? addition.snapshot.completedAt ?? '') || 0;
    return additionTime > currentTime ? addition : current;
  }
  const projects = new Map(current.projects.map(project => [project.id, project]));
  for (const project of addition.projects) projects.set(project.id, project);
  const workspaces = new Map(current.workspaces.map(workspace => [workspace.id, workspace]));
  for (const workspace of addition.workspaces) workspaces.set(workspace.id, workspace);
  return {
    ...current,
    ...addition,
    projectCount: Math.max(current.projectCount, addition.projectCount),
    projects: [...projects.values()],
    projectsTruncated: current.projectsTruncated || addition.projectsTruncated,
    workspaceCount: Math.max(current.workspaceCount, addition.workspaceCount),
    workspaces: [...workspaces.values()],
    workspacesTruncated: current.workspacesTruncated || addition.workspacesTruncated,
  };
}

interface GraphNode {
  readonly degree: number;
  readonly exported?: boolean;
  readonly fileCount?: number;
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly language?: string;
  readonly packageName?: string;
  readonly path?: string;
  readonly projectId: string;
  readonly qualifiedName?: string;
  readonly signature?: string;
  readonly symbolCount?: number;
  readonly type: 'project' | 'symbol';
}

export interface GraphEdge {
  readonly confidence: number;
  readonly count: number;
  readonly id: string;
  readonly provenance: string;
  readonly relation: string;
  readonly sourceId: string;
  readonly targetId: string;
}

interface GraphSpan {
  readonly column: number;
  readonly endColumn: number;
  readonly endLine: number;
  readonly line: number;
}

export interface GraphNodeDetail {
  readonly node: {
    readonly documentation?: string;
    readonly exported: boolean;
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly language: string;
    readonly packageName?: string;
    readonly path: string;
    readonly projectId: string;
    readonly qualifiedName: string;
    readonly signature?: string;
    readonly span: GraphSpan;
  };
  readonly relationships: readonly {
    readonly confidence: number;
    readonly direction: 'incoming' | 'outgoing';
    readonly evidencePath: string;
    readonly evidenceSpan: GraphSpan;
    readonly id: string;
    readonly provenance: string;
    readonly related: {
      readonly id?: string;
      readonly kind?: string;
      readonly label: string;
      readonly path?: string;
      readonly projectId?: string;
      readonly qualifiedName?: string;
    };
    readonly relation: string;
  }[];
  readonly snapshotId: string;
  readonly stats: {
    readonly incoming: number;
    readonly outgoing: number;
    readonly sampledEdges?: number;
    readonly summaryTruncated?: boolean;
    readonly provenances: readonly {readonly count: number; readonly provenance: string}[];
    readonly relations: readonly {
      readonly count: number;
      readonly incoming: number;
      readonly outgoing: number;
      readonly relation: string;
    }[];
    readonly truncated: boolean;
  };
}

export function graphRelationshipCountLabel(count: number, sampled: boolean): string {
  return `${sampled ? '≥' : ''}${Math.max(0, count).toLocaleString()}`;
}

export function graphRelationshipSampleLabel(detail: GraphNodeDetail): string | undefined {
  if (detail.stats.summaryTruncated !== true) return undefined;
  const sampledEdges = detail.stats.sampledEdges ?? detail.stats.incoming + detail.stats.outgoing;
  return `Counts are lower bounds from a ${sampledEdges.toLocaleString()}-edge sample.`;
}

export function graphDisplayEdges(
  edges: readonly GraphEdge[],
  selectedNodeId: string | undefined,
  focusMode: GraphFocusMode,
  relationFilter: string,
): readonly GraphEdge[] {
  const related = relationFilter === 'all' ? edges : edges.filter(edge => edge.relation === relationFilter);
  if (!selectedNodeId || focusMode === 'all') return related;
  return related.filter(edge => {
    if (focusMode === 'incoming') return edge.targetId === selectedNodeId;
    if (focusMode === 'outgoing') return edge.sourceId === selectedNodeId;
    return edge.sourceId === selectedNodeId || edge.targetId === selectedNodeId;
  });
}

export function graphAnalysisRequestIsCurrent(
  currentSequence: number,
  requestedSequence: number,
  currentScope: string,
  requestedScope: string,
): boolean {
  return currentSequence === requestedSequence && currentScope === requestedScope;
}

export function graphRequestIsCurrent(
  currentSequence: number,
  requestedSequence: number,
  currentScope: string,
  requestedScope: string,
): boolean {
  return currentSequence === requestedSequence && currentScope === requestedScope;
}

export function graphQueryRequestIsCurrent(
  aborted: boolean,
  currentSequence: number,
  requestedSequence: number,
  currentScope: string,
  requestedScope: string,
  graph: GraphQueryVisualization,
  expectedSnapshotId: string,
  expectedQuery: string,
): boolean {
  return (
    !aborted &&
    graphRequestIsCurrent(currentSequence, requestedSequence, currentScope, requestedScope) &&
    graph.repository.snapshot.id === expectedSnapshotId &&
    graph.query.state === 'ready' &&
    graph.query.text.trim() === expectedQuery
  );
}

export interface GraphQueryRequestInput {
  readonly expectedQuery: string;
  readonly expectedSnapshotId: string;
  readonly scope: string;
}

export type GraphQueryRequestOutcome =
  | {readonly graph: GraphQueryVisualization; readonly state: 'accepted'}
  | {readonly cause: unknown; readonly state: 'failed'}
  | {readonly state: 'cancelled'}
  | {readonly graph: GraphQueryVisualization; readonly state: 'stale'};

export interface GraphQueryRequestHandle {
  readonly cancel: () => void;
  readonly isCurrent: () => boolean;
  readonly result: Promise<GraphQueryRequestOutcome>;
}

export interface GraphQueryRequestGate {
  readonly cancelCurrent: () => void;
  readonly request: (
    input: GraphQueryRequestInput,
    load: (signal: AbortSignal) => Promise<GraphQueryVisualization>,
  ) => GraphQueryRequestHandle;
}

/**
 * Owns the same supersession boundary used by the Manager graph-query UI.
 *
 * A new request aborts the previous signal. The sequence, scope, snapshot, and
 * query checks remain mandatory even when a loader ignores cancellation and
 * eventually delivers a late response.
 */
export function createGraphQueryRequestGate(): GraphQueryRequestGate {
  let currentController: AbortController | undefined;
  let currentScope = '';
  let currentSequence = 0;

  const cancelCurrent = (): void => {
    currentController?.abort();
    currentController = undefined;
    currentScope = '';
    currentSequence += 1;
  };

  return {
    cancelCurrent,
    request: (input, load) => {
      currentController?.abort();
      const controller = new AbortController();
      const requestedSequence = currentSequence + 1;
      currentController = controller;
      currentScope = input.scope;
      currentSequence = requestedSequence;
      const isCurrent = (): boolean =>
        currentController === controller &&
        graphRequestIsCurrent(currentSequence, requestedSequence, currentScope, input.scope);
      const cancel = (): void => {
        if (!isCurrent()) return;
        cancelCurrent();
      };
      let pending: Promise<GraphQueryVisualization>;
      try {
        pending = load(controller.signal);
      } catch (cause) {
        pending = Promise.reject(cause);
      }
      const result = pending.then<GraphQueryRequestOutcome, GraphQueryRequestOutcome>(
        graph =>
          graphQueryRequestIsCurrent(
            controller.signal.aborted,
            currentSequence,
            requestedSequence,
            currentScope,
            input.scope,
            graph,
            input.expectedSnapshotId,
            input.expectedQuery,
          )
            ? {graph, state: 'accepted'}
            : {graph, state: 'stale'},
        cause =>
          controller.signal.aborted || isAbortError(cause)
            ? {state: 'cancelled'}
            : isCurrent()
              ? {cause, state: 'failed'}
              : {state: 'cancelled'},
      );
      return {cancel, isCurrent, result};
    },
  };
}

export function graphNodeDetailRequestIsCurrent(
  aborted: boolean,
  detail: Pick<GraphNodeDetail, 'node' | 'snapshotId'>,
  expectedSnapshotId: string,
  expectedNodeId: string,
): boolean {
  return !aborted && detail.snapshotId === expectedSnapshotId && detail.node.id === expectedNodeId;
}

export function cacheGraphNodeDetail(
  cache: Map<string, GraphNodeDetail>,
  key: string,
  detail: GraphNodeDetail,
  limit = 128,
): void {
  cache.delete(key);
  cache.set(key, detail);
  while (cache.size > Math.max(1, limit)) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function graphWithNodeNeighborhood(graph: GraphVisualization, detail: GraphNodeDetail): GraphVisualization {
  if (graph.mode !== 'detail') return graph;
  const nodesById = new Map(graph.nodes.slice(0, MANAGER_GRAPH_MAX_NODE_LIMIT).map(node => [node.id, node]));
  const existingRoot = nodesById.get(detail.node.id);
  if (existingRoot || nodesById.size < MANAGER_GRAPH_MAX_NODE_LIMIT) {
    nodesById.set(detail.node.id, {
      ...existingRoot,
      degree: existingRoot?.degree ?? 0,
      exported: detail.node.exported,
      id: detail.node.id,
      kind: detail.node.kind,
      label: detail.node.label,
      language: detail.node.language,
      packageName: detail.node.packageName,
      path: detail.node.path,
      projectId: detail.node.projectId,
      qualifiedName: detail.node.qualifiedName,
      signature: detail.node.signature,
      type: 'symbol',
    });
  }

  const edgesById = new Map(graph.edges.slice(0, MANAGER_GRAPH_MAX_EDGE_LIMIT).map(edge => [edge.id, edge]));
  let truncated = graph.nodes.length > nodesById.size || graph.edges.length > edgesById.size;
  for (const relationship of detail.relationships.slice(0, MAX_EXPANDED_NEIGHBOR_EDGES)) {
    const relatedId = relationship.related.id;
    if (!relatedId || relatedId === detail.node.id) continue;
    if (!nodesById.has(relatedId)) {
      if (nodesById.size >= MANAGER_GRAPH_MAX_NODE_LIMIT) {
        truncated = true;
        continue;
      }
      nodesById.set(relatedId, {
        degree: 0,
        id: relatedId,
        kind: relationship.related.kind ?? 'symbol',
        label: relationship.related.label,
        path: relationship.related.path,
        projectId: relationship.related.projectId ?? detail.node.projectId,
        qualifiedName: relationship.related.qualifiedName,
        type: 'symbol',
      });
    }
    if (!edgesById.has(relationship.id)) {
      if (edgesById.size >= MANAGER_GRAPH_MAX_EDGE_LIMIT || !nodesById.has(detail.node.id)) {
        truncated = true;
        continue;
      }
      const outgoing = relationship.direction === 'outgoing';
      edgesById.set(relationship.id, {
        confidence: relationship.confidence,
        count: 1,
        id: relationship.id,
        provenance: relationship.provenance,
        relation: relationship.relation,
        sourceId: outgoing ? detail.node.id : relatedId,
        targetId: outgoing ? relatedId : detail.node.id,
      });
    }
  }

  const edges = [...edgesById.values()];
  const degrees = graphNodeSizeValues(edges, 'connections');
  const nodes = [...nodesById.values()].map(node => ({...node, degree: degrees.get(node.id) ?? 0}));
  const addedNodes = nodes.length - graph.nodes.length;
  return {
    ...graph,
    edges,
    nodes,
    stats: {
      ...graph.stats,
      renderedEdges: edges.length,
      renderedNodes: nodes.length,
    },
    paging: {...graph.paging, hasMore: graph.paging.hasMore || truncated || detail.stats.truncated},
    warnings: [
      ...graph.warnings,
      ...(addedNodes > 0 ? [`Loaded ${addedNodes.toLocaleString()} direct neighbors for ${detail.node.label}.`] : []),
      ...(truncated ? ['Direct-neighbor expansion reached the global Manager graph budget.'] : []),
    ],
  };
}

export interface GraphVisualization {
  readonly edges: readonly GraphEdge[];
  readonly mode: 'detail' | 'overview';
  readonly nodes: readonly GraphNode[];
  readonly paging: {
    readonly edgeLimit: number;
    readonly hasMore: boolean;
    readonly nodeLimit: number;
  };
  readonly projectId: string;
  readonly query?: GraphQueryMetadata;
  readonly repository: Pick<GraphRepository, 'accounting' | 'displayName' | 'id' | 'metrics' | 'snapshot'>;
  readonly scope: {readonly id: string; readonly label: string};
  readonly stats: {
    readonly renderedEdges: number;
    readonly renderedNodes: number;
    readonly totalEdges: number;
    readonly totalNodes: number;
  };
  readonly warnings: readonly string[];
}

export interface GraphQueryMetadata {
  readonly matchedNodes: number;
  readonly state: 'ready';
  readonly text: string;
  readonly warnings: readonly string[];
}

export interface GraphQueryVisualization extends GraphVisualization {
  readonly query: GraphQueryMetadata;
}

interface GraphCatalogContinuation {
  readonly projectOffset: number;
  readonly projectHasMore: boolean;
  readonly viewOffset: number;
  readonly viewHasMore: boolean;
  readonly viewId: string;
  readonly workspaceOffset: number;
  readonly workspaceHasMore: boolean;
}

export interface GraphCatalogSearchOptions {
  readonly projects: readonly {
    readonly description: string;
    readonly id: string;
    readonly label: string;
    readonly viewId: string;
  }[];
  readonly views: readonly {
    readonly description: string;
    readonly id: string;
    readonly label: string;
    readonly repositoryId: string;
  }[];
}

export function graphCatalogSearchOptions(
  repository: GraphRepository,
  repositories: readonly GraphRepositoryGroup[],
): GraphCatalogSearchOptions {
  const workspaces = new Map(repository.workspaces.map(workspace => [workspace.id, workspace]));
  const projects = repository.projects
    .map(project => {
      const workspace = project.workspaceId ? workspaces.get(project.workspaceId) : undefined;
      return {
        description: [workspace?.name, graphProjectBadge(project)].filter(Boolean).join(' · '),
        id: project.id,
        label: project.label,
        viewId: repository.id,
      };
    })
    .sort((left, right) => compareCodeUnits(left.label, right.label) || compareCodeUnits(left.id, right.id));
  const viewsById = new Map<
    string,
    {readonly description: string; readonly id: string; readonly label: string; readonly repositoryId: string}
  >();
  for (const group of repositories) {
    for (const view of group.views) {
      viewsById.set(view.id, {
        description: `${group.displayName} · ${view.snapshot.commit.slice(0, 8)}${view.snapshot.dirty ? ' · dirty' : ''} · folder ${graphLocalAssociationText(view.localAssociation)}`,
        id: view.id,
        label: view.label,
        repositoryId: group.id,
      });
    }
  }
  return {
    projects,
    views: [...viewsById.values()].sort(
      (left, right) => compareCodeUnits(left.label, right.label) || compareCodeUnits(left.id, right.id),
    ),
  };
}

export function graphCatalogContinuationHasMore(
  continuation: GraphCatalogContinuation | undefined,
  viewId: string | undefined,
  field: 'projectHasMore' | 'viewHasMore' | 'workspaceHasMore',
  fallback: boolean,
): boolean {
  return continuation !== undefined && continuation.viewId === viewId ? continuation[field] : fallback;
}

export interface GraphAnalysis {
  readonly communities: readonly {
    readonly id: string;
    readonly label: string;
    readonly memberCount: number;
  }[];
  readonly coverage: {
    readonly complete: boolean;
    readonly topology: {
      readonly complete: boolean;
      readonly state: 'complete' | 'not-requested' | 'partial' | 'unavailable';
    };
  };
  readonly hubs: readonly {
    readonly classification: 'god-node' | 'hub';
    readonly degree: number;
    readonly node: {readonly label: string; readonly path: string};
  }[];
  readonly statistics: {
    readonly analyzedEdgeCount: number;
    readonly analyzedNodeCount: number;
    readonly communityCount: number;
    readonly connectedComponentCount: number;
    readonly maximumDegree: number;
  };
  readonly surprisingLinks: readonly {
    readonly relation: string;
    readonly score: number;
    readonly source: {readonly label: string};
    readonly target: {readonly label: string};
  }[];
  readonly warnings: readonly string[];
}

export function graphAnalysisTopologyAvailable(analysis: GraphAnalysis): boolean {
  return analysis.coverage.topology.state === 'complete' || analysis.coverage.topology.state === 'partial';
}

export function graphAnalysisCoverageLabel(analysis: GraphAnalysis): string {
  switch (analysis.coverage.topology.state) {
    case 'complete':
      return analysis.coverage.complete ? 'Complete' : 'Topology complete';
    case 'partial':
      return 'Topology partial';
    case 'not-requested':
      return 'Topology not requested';
    case 'unavailable':
      return 'Topology unavailable';
  }
}

interface PositionedNode extends GraphNode {
  readonly color: THREE.Color;
  readonly radius: number;
  readonly x: number;
  readonly y: number;
}

interface GraphLayout {
  readonly bounds: {readonly height: number; readonly width: number};
  readonly nodes: readonly PositionedNode[];
  readonly nodesById: ReadonlyMap<string, PositionedNode>;
}

export interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

interface GraphLabelSize {
  readonly height: number;
  readonly width: number;
}

interface GraphRuntime {
  readonly camera: THREE.OrthographicCamera;
  readonly edgePosition: THREE.BufferAttribute;
  readonly edges: readonly GraphEdge[];
  readonly highlightPosition?: THREE.BufferAttribute;
  readonly highlightedEdges: readonly GraphEdge[];
  readonly nodeIds: readonly string[];
  readonly nodePosition: THREE.BufferAttribute;
  readonly pointMaterials: readonly THREE.ShaderMaterial[];
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly selectedNodeId?: string;
  readonly selectedPosition?: THREE.BufferAttribute;
}

export interface ViewState {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export type GraphFocusMode = 'all' | 'incoming' | 'neighbors' | 'outgoing';
export type GraphSizeMetric = 'connections' | 'incoming' | 'outgoing';

const GRAPH_PALETTE = ['#67e8c7', '#7aa2ff', '#c08cff', '#ff9f7a', '#f7d56b', '#75d8ff', '#ef88b7', '#9be27d'];
const SELECTED_NODE_COLOR = '#ff4fd8';
const MIN_ZOOM = 0.32;
const MAX_ZOOM = 8;
const DEFAULT_WORKING_SET = {
  edgeLimit: MANAGER_GRAPH_DEFAULT_EDGE_LIMIT,
  nodeLimit: MANAGER_GRAPH_DEFAULT_NODE_LIMIT,
} as const;
const MAX_WORKING_SET = {
  edgeLimit: MANAGER_GRAPH_MAX_EDGE_LIMIT,
  nodeLimit: MANAGER_GRAPH_MAX_NODE_LIMIT,
} as const;
const MAX_ANIMATED_NEIGHBOR_EDGES = 120;
const MAX_EXPANDED_NEIGHBOR_EDGES = 160;
const MAX_FOCUSED_LABELS = 24;
const FOCUS_LAYOUT_ZOOM = 2.8;
const SEARCH_FOCUS_ZOOM = {
  detail: 2.8,
  overview: 1.8,
} as const;
const GRAPH_QUERY_DEBOUNCE_MILLISECONDS = 450;
const GRAPH_QUERY_MINIMUM_LENGTH = 3;
const GRAPH_QUERY_MAXIMUM_LENGTH = 512;
const DEFAULT_QUERY_WORKING_SET = {edgeLimit: 240, nodeLimit: 120} as const;
const MAX_QUERY_WORKING_SET = {edgeLimit: 500, nodeLimit: 200} as const;

export function managerGraphQueryCandidate(input: string): string | undefined {
  const candidate = input.trim();
  return candidate.length > 0 && candidate.length <= GRAPH_QUERY_MAXIMUM_LENGTH ? candidate : undefined;
}

export function managerGraphDebouncedQueryCandidate(input: string): string | undefined {
  const candidate = managerGraphQueryCandidate(input);
  return candidate && candidate.length >= GRAPH_QUERY_MINIMUM_LENGTH ? candidate : undefined;
}

export function managerGraphClientRenderProxy(
  graph: GraphVisualization,
  size: {readonly height: number; readonly width: number} = {height: 720, width: 1_280},
): {readonly labels: number; readonly matchedEdges: number; readonly nodes: number} {
  const layout = buildGraphLayout(graph, 'connections', graph.edges);
  const view = fittedView(layout, size);
  let matchedEdges = 0;
  for (const edge of graph.edges) {
    if (layout.nodesById.has(edge.sourceId) && layout.nodesById.has(edge.targetId)) matchedEdges += 1;
  }
  return {
    labels: visibleLabels(layout, graph.mode, size, view).length,
    matchedEdges,
    nodes: layout.nodes.length,
  };
}

export function graphOverviewSizeLabel(graph: GraphVisualization): string {
  return graph.repository.metrics === 'complete' && graph.nodes.some(node => node.symbolCount !== undefined)
    ? 'Component symbols'
    : 'Visible relationship degree';
}

export function GraphWorkspace(props: {
  readonly administration?: CodeGraphLocalDiagnosticsReport;
  readonly administrationBusy?: string;
  readonly administrationOutput?: string;
  readonly catalog?: GraphCatalog;
  readonly catalogError?: string;
  readonly loadAnalysis: (repositoryId: string, snapshotId: string, signal: AbortSignal) => Promise<GraphAnalysis>;
  readonly loadGraph: (
    repositoryId: string,
    snapshotId: string,
    projectId: string,
    limits: ManagerGraphVisualizationLimits,
    signal: AbortSignal,
  ) => Promise<GraphVisualization>;
  readonly loadCatalogPage: (
    repositoryId: string,
    snapshotId: string,
    projectOffset: number,
    workspaceOffset: number,
    query: string,
    signal: AbortSignal,
  ) => Promise<GraphCatalogPage>;
  readonly loadNodeDetail: (
    repositoryId: string,
    snapshotId: string,
    nodeId: string,
    signal: AbortSignal,
  ) => Promise<GraphNodeDetail>;
  readonly loadQuery: (
    repositoryId: string,
    snapshotId: string,
    query: string,
    limits: ManagerGraphVisualizationLimits,
    signal: AbortSignal,
  ) => Promise<GraphQueryVisualization>;
  readonly loadViewsPage: (
    repositoryId: string,
    offset: number,
    query: string,
    signal: AbortSignal,
  ) => Promise<GraphViewPage>;
  readonly onAdministrationAction?: (action: GraphAdministrationAction) => void;
  readonly onDiagnostics?: (options: {readonly analyze: boolean; readonly deep: boolean}) => void;
  readonly onRefresh: () => void;
}): React.ReactElement {
  const [repositoryId, setRepositoryId] = useState('');
  const [viewId, setViewId] = useState('');
  const [projectId, setProjectId] = useState('all');
  const [baseGraph, setBaseGraph] = useState<GraphVisualization | undefined>();
  const [workingSet, setWorkingSet] = useState<ManagerGraphVisualizationLimits>(DEFAULT_WORKING_SET);
  const [expandedNeighborhood, setExpandedNeighborhood] = useState<GraphNodeDetail | undefined>();
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [focusRequest, setFocusRequest] = useState<{readonly nodeId: string; readonly sequence: number} | undefined>();
  const focusSequence = useRef(0);
  const [search, setSearch] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [queryGraph, setQueryGraph] = useState<GraphQueryVisualization | undefined>();
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [queryAttempt, setQueryAttempt] = useState(0);
  const [queryWorkingSet, setQueryWorkingSet] = useState<ManagerGraphVisualizationLimits>(DEFAULT_QUERY_WORKING_SET);
  const queryRequestGate = useRef(createGraphQueryRequestGate());
  const [relationFilter, setRelationFilter] = useState('all');
  const [focusMode, setFocusMode] = useState<GraphFocusMode>('all');
  const [sizeMetric, setSizeMetric] = useState<GraphSizeMetric>('connections');
  const [nodeDetail, setNodeDetail] = useState<GraphNodeDetail | undefined>();
  const [nodeDetailLoading, setNodeDetailLoading] = useState(false);
  const [nodeDetailError, setNodeDetailError] = useState('');
  const nodeDetailCache = useRef(new Map<string, GraphNodeDetail>());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [analysis, setAnalysis] = useState<GraphAnalysis | undefined>();
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const analysisRequestSequence = useRef(0);
  const analysisAbortController = useRef<AbortController | undefined>(undefined);
  const graphRequestSequence = useRef(0);
  const [catalogAdditions, setCatalogAdditions] = useState<readonly GraphRepositoryGroup[]>([]);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [catalogSearchResult, setCatalogSearchResult] = useState<
    {readonly options: GraphCatalogSearchOptions; readonly query: string} | undefined
  >();
  const [catalogContinuation, setCatalogContinuation] = useState<GraphCatalogContinuation>();
  const catalogAbortController = useRef<AbortController | undefined>(undefined);
  const catalogRequestSequence = useRef(0);
  const baseCatalogIdentity = useMemo(
    () =>
      (props.catalog?.repositories ?? [])
        .flatMap(group => group.views.map(view => `${view.id}:${view.snapshot.id}`))
        .sort(compareCodeUnits)
        .join('|'),
    [props.catalog?.repositories],
  );
  const repositories = useMemo(
    () => mergeGraphRepositoryGroups(props.catalog?.repositories ?? [], catalogAdditions),
    [catalogAdditions, props.catalog?.repositories],
  );
  const repositoryGroup = repositories.find(candidate => candidate.id === repositoryId) ?? repositories[0];
  const repository =
    repositoryGroup?.views.find(candidate => candidate.id === viewId) ??
    repositoryGroup?.views.find(candidate => candidate.id === repositoryGroup.defaultViewId) ??
    repositoryGroup?.views[0];
  const baseRepositoryGroup = (props.catalog?.repositories ?? []).find(
    candidate => candidate.id === repositoryGroup?.id,
  );
  const baseRepository = baseRepositoryGroup?.views.find(candidate => candidate.id === repository?.id);
  const analysisScope = `${repository?.id ?? ''}:${repository?.snapshot.id ?? ''}`;
  const analysisScopeRef = useRef(analysisScope);
  analysisScopeRef.current = analysisScope;
  const graphScope = `${analysisScope}:${projectId}:${workingSet.nodeLimit}:${workingSet.edgeLimit}`;
  const graphScopeRef = useRef(graphScope);
  graphScopeRef.current = graphScope;
  const queryScope = `${analysisScope}:${activeQuery}:${queryAttempt}:${queryWorkingSet.nodeLimit}:${queryWorkingSet.edgeLimit}`;
  const graphSource = activeQuery ? queryGraph : baseGraph;
  const graph = useMemo(
    () =>
      graphSource && expandedNeighborhood ? graphWithNodeNeighborhood(graphSource, expandedNeighborhood) : graphSource,
    [expandedNeighborhood, graphSource],
  );
  const selectedNode = graph?.nodes.find(node => node.id === selectedNodeId);
  const relations = useMemo(
    () => [...new Set(graph?.edges.map(edge => edge.relation) ?? [])].sort(compareCodeUnits),
    [graph],
  );
  const activeBuilds = (props.catalog?.builds ?? []).filter(graphBuildShouldDisplay);
  const selectedRepositoryIsIndexing = activeBuilds.some(
    build =>
      repository !== undefined &&
      build.identity.checkoutId === repository.checkoutId &&
      build.identity.worktreeId === repository.worktreeId &&
      (build.state === 'queued' || build.state === 'running'),
  );
  const workingSetAtMaximum = activeQuery
    ? queryWorkingSet.nodeLimit >= MAX_QUERY_WORKING_SET.nodeLimit &&
      queryWorkingSet.edgeLimit >= MAX_QUERY_WORKING_SET.edgeLimit
    : workingSet.nodeLimit >= MAX_WORKING_SET.nodeLimit && workingSet.edgeLimit >= MAX_WORKING_SET.edgeLimit;
  const projectCatalogHasMore = graphCatalogContinuationHasMore(
    catalogContinuation,
    repository?.id,
    'projectHasMore',
    repository?.projectsTruncated ?? false,
  );
  const workspaceCatalogHasMore = graphCatalogContinuationHasMore(
    catalogContinuation,
    repository?.id,
    'workspaceHasMore',
    repository?.workspacesTruncated ?? false,
  );
  const viewCatalogHasMore = graphCatalogContinuationHasMore(
    catalogContinuation,
    repository?.id,
    'viewHasMore',
    repositoryGroup?.viewsTruncated ?? false,
  );

  useEffect(() => {
    const selection = resolveGraphSelection(repositories, repositoryId, viewId);
    if (selection.repositoryId !== repositoryId) {
      setRepositoryId(selection.repositoryId);
      setProjectId('all');
      setWorkingSet(DEFAULT_WORKING_SET);
    }
    if (selection.viewId !== viewId) {
      setViewId(selection.viewId);
      setProjectId('all');
      setWorkingSet(DEFAULT_WORKING_SET);
    }
  }, [repositories, repositoryId, viewId]);

  useEffect(() => {
    if (!repository) {
      setBaseGraph(undefined);
      setExpandedNeighborhood(undefined);
      return;
    }
    const requestSequence = graphRequestSequence.current + 1;
    graphRequestSequence.current = requestSequence;
    const requestedScope = graphScope;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setSelectedNodeId(undefined);
    setExpandedNeighborhood(undefined);
    setFocusRequest(undefined);
    setFocusMode('all');
    setRelationFilter('all');
    setSizeMetric('connections');
    void props
      .loadGraph(repository.id, repository.snapshot.id, projectId, workingSet, controller.signal)
      .then(next => {
        if (
          graphRequestIsCurrent(graphRequestSequence.current, requestSequence, graphScopeRef.current, requestedScope)
        ) {
          setBaseGraph(next);
        }
      })
      .catch(cause => {
        if (
          !isAbortError(cause) &&
          graphRequestIsCurrent(graphRequestSequence.current, requestSequence, graphScopeRef.current, requestedScope)
        ) {
          setBaseGraph(undefined);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (
          graphRequestIsCurrent(graphRequestSequence.current, requestSequence, graphScopeRef.current, requestedScope)
        ) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      graphRequestSequence.current += 1;
    };
  }, [graphScope, projectId, props.loadGraph, repository?.id, repository?.snapshot.id, workingSet]);

  useEffect(() => {
    const candidate = managerGraphDebouncedQueryCandidate(queryInput);
    if (!candidate || candidate === activeQuery) return;
    const timeout = window.setTimeout(() => {
      setQueryAttempt(0);
      setQueryWorkingSet(DEFAULT_QUERY_WORKING_SET);
      setActiveQuery(candidate);
    }, GRAPH_QUERY_DEBOUNCE_MILLISECONDS);
    return () => window.clearTimeout(timeout);
  }, [activeQuery, queryInput]);

  useEffect(() => {
    if (!repository || !activeQuery) {
      setQueryGraph(undefined);
      setQueryLoading(false);
      setQueryError('');
      return;
    }
    const expectedSnapshotId = repository.snapshot.id;
    const expectedQuery = activeQuery;
    const request = queryRequestGate.current.request({expectedQuery, expectedSnapshotId, scope: queryScope}, signal =>
      props.loadQuery(repository.id, expectedSnapshotId, expectedQuery, queryWorkingSet, signal),
    );
    setQueryGraph(undefined);
    setQueryLoading(true);
    setQueryError('');
    setSelectedNodeId(undefined);
    setExpandedNeighborhood(undefined);
    setFocusRequest(undefined);
    setFocusMode('all');
    setRelationFilter('all');
    setSizeMetric('connections');
    void request.result.then(outcome => {
      if (!request.isCurrent()) return;
      if (outcome.state === 'accepted') {
        setQueryGraph(outcome.graph);
      } else if (outcome.state === 'failed') {
        setQueryGraph(undefined);
        setQueryError(outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause));
      }
      setQueryLoading(false);
    });
    return () => {
      request.cancel();
    };
  }, [activeQuery, props.loadQuery, queryScope, queryWorkingSet, repository?.id, repository?.snapshot.id]);

  useEffect(() => {
    analysisAbortController.current?.abort();
    analysisRequestSequence.current += 1;
    setAnalysis(undefined);
    setAnalysisError('');
    setAnalysisLoading(false);
    return () => {
      analysisAbortController.current?.abort();
      analysisRequestSequence.current += 1;
    };
  }, [repository?.id, repository?.snapshot.id]);

  const loadAnalysis = (): void => {
    if (!repository || analysisLoading) return;
    const requestedScope = analysisScope;
    const requestSequence = analysisRequestSequence.current + 1;
    analysisRequestSequence.current = requestSequence;
    analysisAbortController.current?.abort();
    const controller = new AbortController();
    analysisAbortController.current = controller;
    setAnalysisLoading(true);
    setAnalysisError('');
    void props
      .loadAnalysis(repository.id, repository.snapshot.id, controller.signal)
      .then(next => {
        if (
          graphAnalysisRequestIsCurrent(
            analysisRequestSequence.current,
            requestSequence,
            analysisScopeRef.current,
            requestedScope,
          )
        ) {
          setAnalysis(next);
        }
      })
      .catch(cause => {
        if (
          !isAbortError(cause) &&
          graphAnalysisRequestIsCurrent(
            analysisRequestSequence.current,
            requestSequence,
            analysisScopeRef.current,
            requestedScope,
          )
        ) {
          setAnalysisError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (
          graphAnalysisRequestIsCurrent(
            analysisRequestSequence.current,
            requestSequence,
            analysisScopeRef.current,
            requestedScope,
          )
        ) {
          setAnalysisLoading(false);
        }
      });
  };

  useEffect(() => {
    if (!selectedNode || selectedNode.type !== 'symbol' || !repository) {
      setNodeDetail(undefined);
      setNodeDetailLoading(false);
      setNodeDetailError('');
      return;
    }
    const key = `${repository.id}:${graph?.repository.snapshot.id ?? ''}:${selectedNode.id}`;
    const cached = nodeDetailCache.current.get(key);
    if (cached) {
      cacheGraphNodeDetail(nodeDetailCache.current, key, cached);
      setNodeDetail(cached);
      setExpandedNeighborhood(cached);
      setNodeDetailLoading(false);
      setNodeDetailError('');
      focusSequence.current += 1;
      setFocusRequest({nodeId: cached.node.id, sequence: focusSequence.current});
      return;
    }
    const controller = new AbortController();
    setNodeDetail(undefined);
    setNodeDetailLoading(true);
    setNodeDetailError('');
    void props
      .loadNodeDetail(repository.id, repository.snapshot.id, selectedNode.id, controller.signal)
      .then(detail => {
        if (
          !graphNodeDetailRequestIsCurrent(controller.signal.aborted, detail, repository.snapshot.id, selectedNode.id)
        )
          return;
        cacheGraphNodeDetail(nodeDetailCache.current, key, detail);
        setNodeDetail(detail);
        setExpandedNeighborhood(detail);
        focusSequence.current += 1;
        setFocusRequest({nodeId: detail.node.id, sequence: focusSequence.current});
      })
      .catch(cause => {
        if (!controller.signal.aborted && !isAbortError(cause)) {
          setExpandedNeighborhood(undefined);
          setNodeDetailError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setNodeDetailLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [graph?.repository.snapshot.id, props.loadNodeDetail, repository?.id, selectedNode?.id, selectedNode?.type]);

  const searchResults = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle || !graph) return [];
    return graph.nodes
      .filter(
        node =>
          node.label.toLowerCase().includes(needle) ||
          node.qualifiedName?.toLowerCase().includes(needle) ||
          node.path?.toLowerCase().includes(needle),
      )
      .sort((left, right) => right.degree - left.degree || compareCodeUnits(left.label, right.label))
      .slice(0, 8);
  }, [graph, search]);

  const chooseRepository = (nextRepositoryId: string): void => {
    const next = repositories.find(candidate => candidate.id === nextRepositoryId);
    setRepositoryId(nextRepositoryId);
    setViewId(next?.defaultViewId ?? next?.views[0]?.id ?? '');
    setProjectId('all');
    setWorkingSet(DEFAULT_WORKING_SET);
    clearCatalogSearch();
    clearCodeQuery();
  };

  const chooseView = (nextViewId: string): void => {
    setViewId(nextViewId);
    setProjectId('all');
    setWorkingSet(DEFAULT_WORKING_SET);
    clearCatalogSearch();
    clearCodeQuery();
  };

  const chooseCatalogView = (nextRepositoryId: string, nextViewId: string): void => {
    setRepositoryId(nextRepositoryId);
    setViewId(nextViewId);
    setProjectId('all');
    setWorkingSet(DEFAULT_WORKING_SET);
    clearCatalogSearch();
    clearCodeQuery();
  };

  const chooseProject = (nextProjectId: string): void => {
    setProjectId(nextProjectId);
    setWorkingSet(DEFAULT_WORKING_SET);
    setSearch('');
    setSelectedNodeId(undefined);
    setExpandedNeighborhood(undefined);
    clearCatalogSearch();
    clearCodeQuery();
  };

  function clearCatalogSearch(): void {
    setCatalogQuery('');
    setCatalogSearchResult(undefined);
    setCatalogError('');
  }

  const submitCodeQuery = (): void => {
    const candidate = managerGraphQueryCandidate(queryInput);
    if (!candidate) {
      setQueryError(`Enter between 1 and ${GRAPH_QUERY_MAXIMUM_LENGTH} characters to search the code graph.`);
      return;
    }
    if (candidate === activeQuery) {
      setQueryAttempt(current => current + 1);
      return;
    }
    setQueryAttempt(0);
    setQueryWorkingSet(DEFAULT_QUERY_WORKING_SET);
    setActiveQuery(candidate);
  };

  function clearCodeQuery(): void {
    queryRequestGate.current.cancelCurrent();
    setQueryInput('');
    setActiveQuery('');
    setQueryGraph(undefined);
    setQueryLoading(false);
    setQueryError('');
    setQueryAttempt(0);
    setQueryWorkingSet(DEFAULT_QUERY_WORKING_SET);
    setSelectedNodeId(undefined);
    setExpandedNeighborhood(undefined);
    setFocusRequest(undefined);
  }

  const selectNode = (nodeId: string | undefined, focus = false): void => {
    setSelectedNodeId(nodeId);
    if (!nodeId) {
      setFocusMode('all');
      setExpandedNeighborhood(undefined);
      return;
    }
    if (baseGraph?.nodes.some(node => node.id === nodeId)) setExpandedNeighborhood(undefined);
    if (focus) {
      focusSequence.current += 1;
      setFocusRequest({nodeId, sequence: focusSequence.current});
    }
  };

  const loadCatalogContinuation = (requestedQuery: string): void => {
    if (!repository || !repositoryGroup || catalogLoading) return;
    const query = requestedQuery.trim().slice(0, 256);
    const continuation = catalogContinuation?.viewId === repository.id ? catalogContinuation : undefined;
    const offsets =
      query.length === 0
        ? graphCatalogPageOffsets({
            baseRepository,
            baseRepositoryGroup,
            checkoutId: repository.checkoutId,
            continuation,
            viewId: repository.id,
          })
        : {projectOffset: 0, viewOffset: 0, workspaceOffset: 0};
    const {projectOffset, viewOffset, workspaceOffset} = offsets;
    const requestedScope = `${repository.id}:${repository.snapshot.id}:${projectOffset}:${workspaceOffset}:${viewOffset}:${query}`;
    const requestSequence = catalogRequestSequence.current + 1;
    catalogRequestSequence.current = requestSequence;
    catalogAbortController.current?.abort();
    const controller = new AbortController();
    catalogAbortController.current = controller;
    setCatalogLoading(true);
    setCatalogError('');
    void Promise.all([
      props.loadCatalogPage(
        repository.id,
        repository.snapshot.id,
        projectOffset,
        workspaceOffset,
        query,
        controller.signal,
      ),
      props.loadViewsPage(repository.id, viewOffset, query, controller.signal),
    ])
      .then(([catalogPage, viewPage]) => {
        const currentScope = `${repository.id}:${repository.snapshot.id}:${projectOffset}:${workspaceOffset}:${viewOffset}:${query}`;
        if (
          controller.signal.aborted ||
          catalogRequestSequence.current !== requestSequence ||
          currentScope !== requestedScope
        )
          return;
        const selectedViewGroup: GraphRepositoryGroup = {
          ...repositoryGroup,
          defaultViewId: repositoryGroup.defaultViewId,
          views: [catalogPage.repository],
          viewsTruncated: false,
        };
        setCatalogAdditions(current =>
          mergeGraphRepositoryGroups(current, [selectedViewGroup, ...viewPage.repositories]),
        );
        if (query.length > 0) {
          setCatalogSearchResult({
            options: graphCatalogSearchOptions(catalogPage.repository, viewPage.repositories),
            query,
          });
        }
        if (query.length === 0) {
          setCatalogContinuation({
            projectHasMore: catalogPage.repository.projectsTruncated,
            projectOffset:
              projectOffset + catalogPage.repository.projects.filter(project => project.id.startsWith('cgp_')).length,
            viewHasMore: viewPage.hasMore,
            viewId: repository.id,
            viewOffset:
              viewOffset +
              viewPage.repositories
                .flatMap(group => group.views)
                .filter(view => view.checkoutId === repository.checkoutId).length,
            workspaceHasMore: catalogPage.repository.workspacesTruncated,
            workspaceOffset: workspaceOffset + catalogPage.repository.workspaces.length,
          });
        }
      })
      .catch(cause => {
        if (!controller.signal.aborted && catalogRequestSequence.current === requestSequence) {
          setCatalogError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && catalogRequestSequence.current === requestSequence) setCatalogLoading(false);
      });
  };

  useEffect(() => {
    setCatalogAdditions([]);
  }, [baseCatalogIdentity]);

  useEffect(() => {
    catalogAbortController.current?.abort();
    catalogRequestSequence.current += 1;
    setCatalogContinuation(undefined);
    setCatalogError('');
    setCatalogSearchResult(undefined);
    setCatalogLoading(false);
  }, [baseCatalogIdentity, repository?.id, repository?.snapshot.id]);

  return (
    <section className="graph-workspace">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Native code intelligence</p>
          <h2>Knowledge graph</h2>
          <p className="workspace-subtitle">
            Explore architecture from repository-level structure down to individual symbols.
          </p>
        </div>
        <button className="quiet-button" onClick={props.onRefresh} type="button">
          Refresh indexes
        </button>
      </header>

      <div className="graph-notices">
        <GraphAdministration
          busy={props.administrationBusy}
          onAction={props.onAdministrationAction ?? (() => undefined)}
          onDiagnostics={props.onDiagnostics ?? (() => undefined)}
          output={props.administrationOutput}
          report={props.administration}
        />
        {props.catalog?.maintenance ? <GraphMaintenanceProgress status={props.catalog.maintenance} /> : null}
        {activeBuilds.length > 0 ? (
          <div className="graph-build-status" aria-live="polite">
            {activeBuilds.map(build => (
              <GraphBuildProgress
                build={build}
                key={`${build.identity.checkoutId}:${build.identity.worktreeId}:${build.buildId}`}
                repositories={repositories}
                waiters={props.catalog?.waiters ?? []}
              />
            ))}
          </div>
        ) : null}

        {props.catalog?.diagnostics.length ? (
          <div className="graph-catalog-diagnostics" role="status">
            <strong>Some indexed views need attention</strong>
            {props.catalog.diagnostics.map(diagnostic => (
              <span key={`${diagnostic.checkoutId}:${diagnostic.code}`}>{diagnostic.message}</span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="graph-toolbar">
        <div className="graph-toolbar-scope">
          <label>
            <span>Repository</span>
            <select
              aria-label="Repository"
              disabled={repositories.length === 0}
              onChange={event => chooseRepository(event.target.value)}
              value={repositoryGroup?.id ?? ''}
            >
              {repositories.map(item => (
                <option key={item.id} value={item.id}>
                  {graphRepositoryOptionLabel(item, repositories)}
                </option>
              ))}
            </select>
          </label>
          {repositoryGroup && (repositoryGroup.views.length > 1 || viewCatalogHasMore) ? (
            <label>
              <span>Indexed view</span>
              <select
                aria-label="Indexed view"
                onChange={event => chooseView(event.target.value)}
                value={repository?.id ?? ''}
              >
                {repositoryGroup.views.map(view => (
                  <option key={view.id} value={view.id}>
                    {view.label} · folder {graphLocalAssociationText(view.localAssociation)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span>Component</span>
            <select
              aria-label="Component"
              disabled={!repository}
              onChange={event => chooseProject(event.target.value)}
              value={projectId}
            >
              <option value="all">All components</option>
              {(repository?.workspaces ?? []).map(workspace => {
                const projects = repository?.projects.filter(project => project.workspaceId === workspace.id) ?? [];
                return projects.length > 0 ? (
                  <optgroup
                    key={workspace.id}
                    label={`${workspace.name} · ${workspace.buildSystem} · ${workspace.root || 'repository root'}`}
                  >
                    {projects.map(project => (
                      <option key={project.id} value={project.id}>
                        {project.label} · {graphProjectBadge(project)} ·{' '}
                        {repository?.metrics === 'deferred'
                          ? 'count on demand'
                          : compactNumber(project.symbolCount ?? 0)}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
              {(repository?.projects ?? [])
                .filter(
                  project =>
                    !project.workspaceId ||
                    !repository?.workspaces.some(workspace => workspace.id === project.workspaceId),
                )
                .map(project => (
                  <option key={project.id} value={project.id}>
                    {project.label} · {graphProjectBadge(project)} ·{' '}
                    {repository?.metrics === 'deferred' ? 'count on demand' : compactNumber(project.symbolCount ?? 0)}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="graph-control graph-catalog-continuation">
          <label htmlFor="graph-catalog-search">Find component or indexed view</label>
          <div className="graph-control-actions">
            <input
              aria-describedby="graph-catalog-search-status"
              disabled={!repository || catalogLoading}
              id="graph-catalog-search"
              maxLength={256}
              onChange={event => {
                setCatalogQuery(event.target.value);
                setCatalogSearchResult(undefined);
                setCatalogError('');
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                loadCatalogContinuation(catalogQuery);
              }}
              placeholder="Component, workspace, commit, or view"
              type="search"
              value={catalogQuery}
            />
            <button
              disabled={!repository || catalogLoading || catalogQuery.trim().length === 0}
              onClick={() => loadCatalogContinuation(catalogQuery)}
              type="button"
            >
              {catalogLoading && catalogQuery.trim().length > 0 ? 'Searching…' : 'Find options'}
            </button>
          </div>
          {projectCatalogHasMore || workspaceCatalogHasMore || viewCatalogHasMore ? (
            <button
              className="quiet-button"
              disabled={!repository || catalogLoading}
              onClick={() => loadCatalogContinuation('')}
              type="button"
            >
              {catalogLoading && catalogQuery.trim().length === 0 ? 'Loading…' : 'Load more options'}
            </button>
          ) : null}
          {catalogError ? <small role="alert">{catalogError}</small> : null}
          {catalogSearchResult ? (
            <div className="graph-search-results graph-catalog-results" id="graph-catalog-search-status" role="status">
              {catalogSearchResult.options.projects.length + catalogSearchResult.options.views.length > 0 ? (
                <>
                  <p>
                    Found{' '}
                    {(
                      catalogSearchResult.options.projects.length + catalogSearchResult.options.views.length
                    ).toLocaleString()}{' '}
                    options for “{catalogSearchResult.query}”
                  </p>
                  {catalogSearchResult.options.projects.length > 0 ? (
                    <div className="graph-catalog-result-group">
                      <span>Components and workspace matches</span>
                      {catalogSearchResult.options.projects.map(option => (
                        <button
                          key={`${option.viewId}:${option.id}`}
                          onClick={() => chooseProject(option.id)}
                          type="button"
                        >
                          <strong>{option.label}</strong>
                          <span>{option.description}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {catalogSearchResult.options.views.length > 0 ? (
                    <div className="graph-catalog-result-group">
                      <span>Indexed views</span>
                      {catalogSearchResult.options.views.map(option => (
                        <button
                          key={`${option.repositoryId}:${option.id}`}
                          onClick={() => chooseCatalogView(option.repositoryId, option.id)}
                          type="button"
                        >
                          <strong>{option.label}</strong>
                          <span>{option.description}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <p>No catalog matches for “{catalogSearchResult.query}”</p>
              )}
            </div>
          ) : (
            <span className="sr-only" id="graph-catalog-search-status">
              Search results appear here.
            </span>
          )}
        </div>
        <div className="graph-control graph-search graph-node-search">
          <label htmlFor="graph-current-view-search">Find in current view</label>
          <input
            id="graph-current-view-search"
            disabled={!graph}
            onChange={event => setSearch(event.target.value)}
            placeholder={graph?.mode === 'overview' ? 'Search components' : 'Name, path, or symbol'}
            type="search"
            value={search}
          />
          {search.trim() ? (
            <div className="graph-search-results">
              {searchResults.length > 0 ? (
                searchResults.map(node => (
                  <button
                    key={node.id}
                    onClick={() => {
                      selectNode(node.id, true);
                      setSearch('');
                    }}
                    type="button"
                  >
                    <strong>{node.label}</strong>
                    <span>{node.path ?? node.kind}</span>
                  </button>
                ))
              ) : (
                <p>No matching nodes</p>
              )}
            </div>
          ) : null}
        </div>
        <div className="graph-control graph-search graph-code-query">
          <label htmlFor="graph-code-query">Query the code graph</label>
          <div className="graph-control-actions">
            <input
              disabled={!repository}
              id="graph-code-query"
              maxLength={GRAPH_QUERY_MAXIMUM_LENGTH}
              onChange={event => setQueryInput(event.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                submitCodeQuery();
              }}
              placeholder="Concept, path, module, or symbol"
              type="search"
              value={queryInput}
            />
            <button
              disabled={!repository || managerGraphQueryCandidate(queryInput) === undefined || queryLoading}
              onClick={submitCodeQuery}
              type="button"
            >
              {queryLoading ? 'Searching…' : 'Query graph'}
            </button>
          </div>
          {activeQuery ? (
            <button className="quiet-button" onClick={clearCodeQuery} type="button">
              Back to {projectId === 'all' ? 'overview' : 'component'}
            </button>
          ) : null}
          {!activeQuery && queryError ? <small role="alert">{queryError}</small> : null}
        </div>
        <div className="graph-stats" aria-label="Graph rendering status">
          <span>{graph ? compactNumber(graph.stats.renderedNodes) : '—'} nodes</span>
          <span>{graph ? compactNumber(graph.stats.renderedEdges) : '—'} links</span>
          {graph?.paging.hasMore ? (
            <button
              disabled={(activeQuery ? queryLoading : loading) || workingSetAtMaximum}
              onClick={() => {
                if (activeQuery) {
                  setQueryWorkingSet(current => ({
                    edgeLimit: Math.min(MAX_QUERY_WORKING_SET.edgeLimit, current.edgeLimit * 2),
                    nodeLimit: Math.min(MAX_QUERY_WORKING_SET.nodeLimit, current.nodeLimit * 2),
                  }));
                } else {
                  setWorkingSet(current => ({
                    edgeLimit: Math.min(MAX_WORKING_SET.edgeLimit, current.edgeLimit * 2),
                    nodeLimit: Math.min(MAX_WORKING_SET.nodeLimit, current.nodeLimit * 2),
                  }));
                }
              }}
              type="button"
            >
              {(activeQuery ? queryLoading : loading)
                ? 'Expanding…'
                : workingSetAtMaximum
                  ? activeQuery
                    ? 'Query capped'
                    : 'View capped'
                  : activeQuery
                    ? 'Expand results'
                    : 'Expand view'}
            </button>
          ) : null}
          <span className="gpu-badge">WebGL</span>
        </div>
      </div>

      {graph ? (
        <div className="graph-filterbar">
          <label>
            <span>Relationship</span>
            <select
              aria-label="Filter relationships"
              onChange={event => setRelationFilter(event.target.value)}
              value={relationFilter}
            >
              <option value="all">All relationships</option>
              {relations.map(relation => (
                <option key={relation} value={relation}>
                  {relationLabel(relation)}
                </option>
              ))}
            </select>
          </label>
          {graph.mode === 'detail' ? (
            <label>
              <span>Node size</span>
              <select
                aria-label="Node size metric"
                onChange={event => setSizeMetric(event.target.value as GraphSizeMetric)}
                value={sizeMetric}
              >
                <option value="connections">Connections</option>
                <option value="incoming">Incoming</option>
                <option value="outgoing">Outgoing</option>
              </select>
            </label>
          ) : (
            <div className="graph-size-readout">
              <span>Node size</span>
              <strong>{graphOverviewSizeLabel(graph)}</strong>
            </div>
          )}
          <div className="graph-focus-control">
            <span>Selection focus</span>
            <div className="segmented-control" aria-label="Selection focus">
              {(
                [
                  ['all', 'All'],
                  ['neighbors', 'Neighbors'],
                  ['incoming', 'Incoming'],
                  ['outgoing', 'Outgoing'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  aria-pressed={focusMode === mode}
                  disabled={!selectedNode}
                  key={mode}
                  onClick={() => setFocusMode(mode)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {selectedNode ? (
            <button className="graph-clear-selection" onClick={() => selectNode(undefined)} type="button">
              Clear selection
            </button>
          ) : (
            <p>Select a node to isolate its neighborhood and direction.</p>
          )}
        </div>
      ) : null}

      <div className="graph-body">
        <section className="graph-stage">
          {!props.catalog && props.catalogError ? (
            <div className="graph-empty" role="status">
              <span className="empty-orbit" aria-hidden="true" />
              <h3>Indexed repositories unavailable</h3>
              <p>{props.catalogError}</p>
              <button onClick={props.onRefresh} type="button">
                Try again
              </button>
            </div>
          ) : !props.catalog ? (
            <div aria-live="polite" className="graph-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              <span>Loading indexed repositories…</span>
            </div>
          ) : repositories.length === 0 ? (
            <GraphEmptyState
              building={activeBuilds.some(build => build.state === 'queued' || build.state === 'running')}
            />
          ) : activeQuery && selectedRepositoryIsIndexing && !queryGraph ? (
            <div aria-live="polite" className="graph-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              <span>Code graph indexing is in progress. Search will use the pinned ready snapshot when available.</span>
            </div>
          ) : activeQuery && queryError ? (
            <div className="graph-empty" role="status">
              <span className="empty-orbit" aria-hidden="true" />
              <h3>Code search unavailable</h3>
              <p>{queryError}</p>
              <button onClick={submitCodeQuery} type="button">
                Try query again
              </button>
              <button className="quiet-button" onClick={clearCodeQuery} type="button">
                Return to graph
              </button>
            </div>
          ) : !activeQuery && error ? (
            <div className="graph-empty">
              <span className="empty-orbit" aria-hidden="true" />
              <h3>Graph unavailable</h3>
              <p>{error}</p>
              <button onClick={props.onRefresh} type="button">
                Try again
              </button>
            </div>
          ) : (activeQuery ? queryLoading : loading) || !graph ? (
            <div aria-live="polite" className="graph-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              <span>{activeQuery ? `Searching for “${activeQuery}”…` : 'Preparing a bounded graph view…'}</span>
            </div>
          ) : activeQuery && (graph.query?.matchedNodes === 0 || graph.nodes.length === 0) ? (
            <div className="graph-empty" role="status">
              <span className="empty-orbit" aria-hidden="true" />
              <h3>No code graph matches</h3>
              <p>
                No concept, path, module, or symbol was returned for “{activeQuery}” by this bounded snapshot search.
                Review any partial-result warning below or refine the query.
              </p>
              <button className="quiet-button" onClick={clearCodeQuery} type="button">
                Return to graph
              </button>
            </div>
          ) : (
            <ThreeGraph
              graph={graph}
              focusMode={focusMode}
              key={`${graph.repository.id}:${graph.repository.snapshot.id}:${graph.projectId}:${graph.query?.text ?? ''}`}
              onOpenProject={chooseProject}
              onSelectNode={nodeId => selectNode(nodeId, Boolean(nodeId))}
              relationFilter={relationFilter}
              sizeMetric={sizeMetric}
              focusRequest={focusRequest}
              selectedNodeId={selectedNodeId}
            />
          )}
        </section>

        <aside className="graph-inspector">
          {selectedNode ? (
            <NodeInspector
              graph={graph!}
              detail={nodeDetail}
              detailError={nodeDetailError}
              detailLoading={nodeDetailLoading}
              node={selectedNode}
              onOpenProject={() => chooseProject(selectedNode.projectId)}
              onSelectNode={nodeId => selectNode(nodeId, true)}
            />
          ) : graph ? (
            <GraphSummary
              analysis={analysis}
              analysisError={analysisError}
              analysisLoading={analysisLoading}
              graph={graph}
              onAnalyze={loadAnalysis}
              sizeMetric={sizeMetric}
            />
          ) : (
            <div className="inspector-placeholder">
              <span className="inspector-dot" />
              <p>Select a node to inspect its role, source location, and relationships.</p>
            </div>
          )}
        </aside>
      </div>

      {graph && [...new Set([...graph.warnings, ...(graph.query?.warnings ?? [])])].length ? (
        <footer className="graph-notes">
          {[...new Set([...graph.warnings, ...(graph.query?.warnings ?? [])])].map(warning => (
            <span key={warning}>{warning}</span>
          ))}
        </footer>
      ) : null}
    </section>
  );
}

function ThreeGraph(props: {
  readonly focusRequest?: {readonly nodeId: string; readonly sequence: number};
  readonly focusMode: GraphFocusMode;
  readonly graph: GraphVisualization;
  readonly onOpenProject: (projectId: string) => void;
  readonly onSelectNode: (nodeId: string | undefined) => void;
  readonly relationFilter: string;
  readonly selectedNodeId?: string;
  readonly sizeMetric: GraphSizeMetric;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{moved: boolean; pointerId: number; x: number; y: number} | undefined>(undefined);
  const labelRefs = useRef(new Map<string, HTMLSpanElement>());
  const livePositionsRef = useRef<ReadonlyMap<string, GraphPosition>>(new Map());
  const runtimeRef = useRef<GraphRuntime | undefined>(undefined);
  const [settledPositions, setSettledPositions] = useState<ReadonlyMap<string, GraphPosition>>(() => new Map());
  const [size, setSize] = useState({height: 1, width: 1});
  const sizingEdges = useMemo(
    () =>
      props.relationFilter === 'all'
        ? props.graph.edges
        : props.graph.edges.filter(edge => edge.relation === props.relationFilter),
    [props.graph.edges, props.relationFilter],
  );
  const baseLayout = useMemo(
    () => buildGraphLayout(props.graph, props.sizeMetric, sizingEdges),
    [props.graph, props.sizeMetric, sizingEdges],
  );
  const layout = useMemo(() => graphLayoutWithPositions(baseLayout, settledPositions), [baseLayout, settledPositions]);
  const displayEdges = useMemo(
    () => graphDisplayEdges(props.graph.edges, props.selectedNodeId, props.focusMode, props.relationFilter),
    [props.focusMode, props.graph.edges, props.relationFilter, props.selectedNodeId],
  );
  const neighborhoodEdges = useMemo(
    () =>
      props.selectedNodeId
        ? displayEdges.filter(edge => edge.sourceId === props.selectedNodeId || edge.targetId === props.selectedNodeId)
        : [],
    [displayEdges, props.selectedNodeId],
  );
  const animatedNeighborhoodEdges = useMemo(
    () => neighborhoodEdges.slice(0, MAX_ANIMATED_NEIGHBOR_EDGES),
    [neighborhoodEdges],
  );
  const highlightedNodeIds = useMemo(
    () =>
      props.selectedNodeId
        ? new Set([props.selectedNodeId, ...animatedNeighborhoodEdges.flatMap(edge => [edge.sourceId, edge.targetId])])
        : undefined,
    [animatedNeighborhoodEdges, props.selectedNodeId],
  );
  const activeNodeIds = useMemo(() => {
    if (!props.selectedNodeId || props.focusMode === 'all') return undefined;
    return new Set([props.selectedNodeId, ...displayEdges.flatMap(edge => [edge.sourceId, edge.targetId])]);
  }, [displayEdges, props.focusMode, props.selectedNodeId]);
  const [view, setView] = useState<ViewState>(() => fittedView(layout, size));
  const viewRef = useRef(view);
  const [focusLayoutRevision, setFocusLayoutRevision] = useState(0);
  const [renderError, setRenderError] = useState('');

  useEffect(() => {
    setView(fittedView(layout, size));
  }, [props.graph.projectId, props.graph.repository.id, props.graph.repository.snapshot.id, size.height, size.width]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const request = props.focusRequest;
    const node = request ? layout.nodesById.get(request.nodeId) : undefined;
    if (!request || !node) return;
    const startedAt = performance.now();
    const duration = 360;
    const start = viewRef.current;
    const target = graphFocusTarget(start, graphPosition(node, livePositionsRef.current), props.graph.mode);
    let frame = 0;
    const animate = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setView({
        x: lerp(start.x, target.x, eased),
        y: lerp(start.y, target.y, eased),
        zoom: lerp(start.zoom, target.zoom, eased),
      });
      if (progress < 1) frame = window.requestAnimationFrame(animate);
      else setFocusLayoutRevision(current => current + 1);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [props.focusRequest?.sequence, props.graph.mode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect;
      if (bounds) setSize({height: Math.max(1, bounds.height), width: Math.max(1, bounds.width)});
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        canvas,
        powerPreference: 'high-performance',
      });
      setRenderError('');
    } catch {
      setRenderError('WebGL is unavailable in this browser. Enable hardware acceleration to render the graph.');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size.width, size.height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera();
    updateCamera(camera, view, size);
    const currentPositions = livePositionsRef.current;

    const edgePositions: number[] = [];
    const edgeColors: number[] = [];
    const renderedEdges = displayEdges.filter(
      edge => layout.nodesById.has(edge.sourceId) && layout.nodesById.has(edge.targetId),
    );
    for (const edge of renderedEdges) {
      const source = layout.nodesById.get(edge.sourceId);
      const target = layout.nodesById.get(edge.targetId);
      if (!source || !target) continue;
      const sourcePosition = graphPosition(source, currentPositions);
      const targetPosition = graphPosition(target, currentPositions);
      edgePositions.push(sourcePosition.x, sourcePosition.y, 0, targetPosition.x, targetPosition.y, 0);
      edgeColors.push(source.color.r, source.color.g, source.color.b, target.color.r, target.color.g, target.color.b);
    }
    const edgeGeometry = new THREE.BufferGeometry();
    const edgePosition = new THREE.Float32BufferAttribute(edgePositions, 3);
    edgeGeometry.setAttribute('position', edgePosition);
    edgeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(edgeColors, 3));
    const edgeMaterial = new THREE.LineBasicMaterial({
      blending: THREE.AdditiveBlending,
      opacity: props.graph.mode === 'overview' ? 0.34 : 0.18,
      transparent: true,
      vertexColors: true,
    });
    const lines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    scene.add(lines);

    const positions: number[] = [];
    const colors: number[] = [];
    const pointSizes: number[] = [];
    for (const node of layout.nodes) {
      const color = activeNodeIds && !activeNodeIds.has(node.id) ? node.color.clone().multiplyScalar(0.12) : node.color;
      const position = graphPosition(node, currentPositions);
      positions.push(position.x, position.y, 1);
      colors.push(color.r, color.g, color.b);
      pointSizes.push(node.radius * 2);
    }
    const nodeGeometry = new THREE.BufferGeometry();
    const nodePosition = new THREE.Float32BufferAttribute(positions, 3);
    nodeGeometry.setAttribute('position', nodePosition);
    nodeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    nodeGeometry.setAttribute('pointSize', new THREE.Float32BufferAttribute(pointSizes, 1));
    const nodeMaterial = graphPointMaterial(1, view.zoom);
    const points = new THREE.Points(nodeGeometry, nodeMaterial);
    scene.add(points);

    const renderedHighlightedEdges = animatedNeighborhoodEdges.filter(
      edge => layout.nodesById.has(edge.sourceId) && layout.nodesById.has(edge.targetId),
    );
    const highlightPositions = directionalEdgePositions(renderedHighlightedEdges, layout.nodesById, currentPositions);
    let highlightGeometry: THREE.BufferGeometry | undefined;
    let highlightPosition: THREE.BufferAttribute | undefined;
    let highlightMaterial: THREE.LineBasicMaterial | undefined;
    if (highlightPositions.length > 0) {
      highlightGeometry = new THREE.BufferGeometry();
      highlightPosition = new THREE.Float32BufferAttribute(highlightPositions, 3);
      highlightGeometry.setAttribute('position', highlightPosition);
      highlightMaterial = new THREE.LineBasicMaterial({
        blending: THREE.AdditiveBlending,
        color: SELECTED_NODE_COLOR,
        opacity: 0.72,
        transparent: true,
      });
      scene.add(new THREE.LineSegments(highlightGeometry, highlightMaterial));
    }

    const selectedNode = props.selectedNodeId ? layout.nodesById.get(props.selectedNodeId) : undefined;
    let selectedGeometry: THREE.BufferGeometry | undefined;
    let selectedPosition: THREE.BufferAttribute | undefined;
    let selectedMaterial: THREE.ShaderMaterial | undefined;
    if (selectedNode) {
      const position = graphPosition(selectedNode, currentPositions);
      selectedGeometry = new THREE.BufferGeometry();
      selectedPosition = new THREE.Float32BufferAttribute([position.x, position.y, 2], 3);
      selectedGeometry.setAttribute('position', selectedPosition);
      selectedGeometry.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(new THREE.Color(SELECTED_NODE_COLOR).toArray(), 3),
      );
      selectedGeometry.setAttribute('pointSize', new THREE.Float32BufferAttribute([selectedNode.radius * 3.3], 1));
      selectedMaterial = graphPointMaterial(1.3, view.zoom);
      scene.add(new THREE.Points(selectedGeometry, selectedMaterial));
    }

    runtimeRef.current = {
      camera,
      edgePosition,
      edges: renderedEdges,
      highlightedEdges: renderedHighlightedEdges,
      highlightPosition,
      nodeIds: layout.nodes.map(node => node.id),
      nodePosition,
      pointMaterials: selectedMaterial ? [nodeMaterial, selectedMaterial] : [nodeMaterial],
      renderer,
      scene,
      selectedNodeId: selectedNode?.id,
      selectedPosition,
    };
    renderer.render(scene, camera);
    return () => {
      runtimeRef.current = undefined;
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      highlightGeometry?.dispose();
      highlightMaterial?.dispose();
      selectedGeometry?.dispose();
      selectedMaterial?.dispose();
      renderer.dispose();
    };
  }, [activeNodeIds, animatedNeighborhoodEdges, displayEdges, layout, props.graph.mode, props.selectedNodeId]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    runtime.renderer.setSize(size.width, size.height, false);
    for (const material of runtime.pointMaterials) {
      const scale = material.uniforms.viewScale;
      if (scale) scale.value = graphPointViewScale(view.zoom);
    }
    updateCamera(runtime.camera, view, size);
    runtime.renderer.render(runtime.scene, runtime.camera);
  }, [size, view]);

  useEffect(() => {
    const currentNodes = baseLayout.nodes.map(node => {
      const settledNode = layout.nodesById.get(node.id) ?? node;
      const position = graphPosition(settledNode, livePositionsRef.current);
      return {...node, x: position.x, y: position.y};
    });
    const labelSizes = new Map<string, GraphLabelSize>();
    for (const [nodeId, element] of labelRefs.current) {
      labelSizes.set(nodeId, {height: element.offsetHeight, width: element.offsetWidth});
    }
    const targets = graphFocusLayoutTargets(
      currentNodes,
      props.selectedNodeId,
      animatedNeighborhoodEdges,
      labelSizes,
      Math.max(FOCUS_LAYOUT_ZOOM, viewRef.current.zoom),
    );
    const simulationIds = new Set([...livePositionsRef.current.keys(), ...settledPositions.keys(), ...targets.keys()]);
    const particles = [...simulationIds].flatMap(nodeId => {
      const baseNode = baseLayout.nodesById.get(nodeId);
      const currentNode = layout.nodesById.get(nodeId) ?? baseNode;
      if (!baseNode || !currentNode) return [];
      const start = livePositionsRef.current.get(nodeId) ?? currentNode;
      const target = targets.get(nodeId) ?? baseNode;
      return [
        {
          id: nodeId,
          targetX: target.x,
          targetY: target.y,
          velocityX: 0,
          velocityY: 0,
          x: start.x,
          y: start.y,
        },
      ];
    });
    const container = containerRef.current;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let frame = 0;
    let lastFrame = performance.now();
    const startedAt = lastFrame;

    const settle = (): void => {
      const resolvedPositions = new Map<string, GraphPosition>();
      for (const particle of particles) {
        resolvedPositions.set(particle.id, {x: particle.targetX, y: particle.targetY});
      }
      applyGraphPositions(runtimeRef.current, resolvedPositions, layout, size, viewRef.current, labelRefs.current);
      const retainedTargets = new Map<string, GraphPosition>();
      for (const [nodeId, target] of targets) {
        const baseNode = baseLayout.nodesById.get(nodeId);
        if (baseNode && Math.hypot(target.x - baseNode.x, target.y - baseNode.y) > 0.01) {
          retainedTargets.set(nodeId, target);
        }
      }
      livePositionsRef.current = retainedTargets;
      setSettledPositions(retainedTargets);
      container?.removeAttribute('data-layout-animating');
    };

    if (
      reducedMotion ||
      particles.every(particle => Math.hypot(particle.targetX - particle.x, particle.targetY - particle.y) < 0.01)
    ) {
      settle();
      return;
    }

    container?.setAttribute('data-layout-animating', 'true');
    const animate = (now: number): void => {
      const delta = Math.min(0.032, Math.max(0.001, (now - lastFrame) / 1000));
      lastFrame = now;
      let movement = 0;
      const positions = new Map<string, GraphPosition>();
      for (const particle of particles) {
        const accelerationX = (particle.targetX - particle.x) * 108 - particle.velocityX * 13;
        const accelerationY = (particle.targetY - particle.y) * 108 - particle.velocityY * 13;
        particle.velocityX += accelerationX * delta;
        particle.velocityY += accelerationY * delta;
        particle.x += particle.velocityX * delta;
        particle.y += particle.velocityY * delta;
        movement = Math.max(
          movement,
          Math.hypot(particle.targetX - particle.x, particle.targetY - particle.y),
          Math.hypot(particle.velocityX, particle.velocityY) * 0.035,
        );
        positions.set(particle.id, {x: particle.x, y: particle.y});
      }
      livePositionsRef.current = positions;
      applyGraphPositions(runtimeRef.current, positions, layout, size, viewRef.current, labelRefs.current);
      if (movement < 0.08 || now - startedAt >= 1250) {
        settle();
        return;
      }
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frame);
      container?.removeAttribute('data-layout-animating');
    };
  }, [animatedNeighborhoodEdges, baseLayout, focusLayoutRevision, props.selectedNodeId]);

  const labels = useMemo(
    () =>
      visibleLabels(
        layout,
        props.graph.mode,
        size,
        view,
        props.selectedNodeId,
        activeNodeIds,
        highlightedNodeIds,
        livePositionsRef.current,
      ),
    [activeNodeIds, highlightedNodeIds, layout, props.graph.mode, props.selectedNodeId, size, view],
  );

  const zoomAt = (factor: number, clientX = size.width / 2, clientY = size.height / 2): void => {
    setView(current => zoomViewAt(current, factor, clientX, clientY, size));
  };

  return (
    <div className="webgl-graph" ref={containerRef}>
      <canvas
        aria-label="Interactive code graph. Drag to pan, scroll to zoom, and click nodes to inspect."
        onDoubleClick={event => {
          const node = nearestNode(
            layout,
            view,
            size,
            event.nativeEvent.offsetX,
            event.nativeEvent.offsetY,
            livePositionsRef.current,
          );
          if (node?.type === 'project') props.onOpenProject(node.projectId);
        }}
        onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {moved: false, pointerId: event.pointerId, x: event.clientX, y: event.clientY};
        }}
        onPointerMove={event => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
          drag.x = event.clientX;
          drag.y = event.clientY;
          setView(current => ({...current, x: current.x - dx / current.zoom, y: current.y + dy / current.zoom}));
        }}
        onPointerUp={event => {
          const drag = dragRef.current;
          if (drag && !drag.moved) {
            const node = nearestNode(
              layout,
              view,
              size,
              event.nativeEvent.offsetX,
              event.nativeEvent.offsetY,
              livePositionsRef.current,
            );
            props.onSelectNode(node?.id);
          }
          dragRef.current = undefined;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onWheel={event => {
          event.preventDefault();
          zoomAt(graphWheelZoomFactor(event.deltaY), event.nativeEvent.offsetX, event.nativeEvent.offsetY);
        }}
        ref={canvasRef}
      />
      <div className="graph-labels" aria-hidden="true">
        {labels.map(label => (
          <span
            className={
              label.node.id === props.selectedNodeId
                ? 'is-selected'
                : highlightedNodeIds?.has(label.node.id)
                  ? 'is-highlighted'
                  : undefined
            }
            data-node-id={label.node.id}
            key={label.node.id}
            ref={element => {
              if (element) labelRefs.current.set(label.node.id, element);
              else labelRefs.current.delete(label.node.id);
            }}
            style={{left: label.x, top: label.y}}
          >
            {label.node.label}
            {label.node.type === 'project' && props.graph.repository.metrics === 'complete' ? (
              <small>{compactNumber(label.node.symbolCount ?? 0)}</small>
            ) : null}
          </span>
        ))}
      </div>
      {renderError ? (
        <div className="graph-empty graph-render-error" role="alert">
          <h3>GPU rendering unavailable</h3>
          <p>{renderError}</p>
        </div>
      ) : null}
      <div className="graph-controls">
        <button aria-label="Zoom in" onClick={() => zoomAt(1.35)} title="Zoom in" type="button">
          +
        </button>
        <button aria-label="Zoom out" onClick={() => zoomAt(1 / 1.35)} title="Zoom out" type="button">
          −
        </button>
        <button
          aria-label="Fit graph"
          onClick={() => setView(fittedView(layout, size))}
          title="Fit graph"
          type="button"
        >
          Fit
        </button>
      </div>
      <div className="zoom-hint">
        <span>{Math.round(view.zoom * 100)}%</span>
        <span>{view.zoom < 1.45 ? 'Zoom in to reveal symbols' : 'Detailed labels visible'}</span>
      </div>
    </div>
  );
}

function GraphSummary(props: {
  readonly analysis?: GraphAnalysis;
  readonly analysisError: string;
  readonly analysisLoading: boolean;
  readonly graph: GraphVisualization;
  readonly onAnalyze: () => void;
  readonly sizeMetric: GraphSizeMetric;
}): React.ReactElement {
  return (
    <div className="graph-summary">
      <p className="eyebrow">{props.graph.mode === 'overview' ? 'Repository overview' : 'Component working set'}</p>
      <h3>{props.graph.scope.label}</h3>
      <p>
        {props.graph.mode === 'overview'
          ? props.graph.repository.metrics === 'complete'
            ? 'Node size reflects indexed symbol volume. Double-click a component to explore its symbol graph.'
            : 'Node size reflects visible relationship degree. Double-click a component to explore its symbol graph.'
          : `Node size reflects ${sizeMetricLabel(props.sizeMetric).toLowerCase()} among the filtered relationships.`}
      </p>
      <dl className="metric-list">
        <div>
          <dt>Indexed symbols</dt>
          <dd>{compactNumber(props.graph.stats.totalNodes)}</dd>
        </div>
        <div>
          <dt>Visible nodes</dt>
          <dd>{compactNumber(props.graph.stats.renderedNodes)}</dd>
        </div>
        <div>
          <dt>Visible links</dt>
          <dd>{compactNumber(props.graph.stats.renderedEdges)}</dd>
        </div>
        <div>
          <dt>Snapshot</dt>
          <dd>
            {props.graph.repository.snapshot.commit.slice(0, 8)}
            {props.graph.repository.snapshot.dirty ? ' + dirty' : ''}
          </dd>
        </div>
        {props.graph.mode === 'overview' ? (
          <div>
            <dt>Overview coverage</dt>
            <dd>
              {props.graph.repository.metrics === 'deferred'
                ? 'Computed on demand'
                : `${compactNumber(props.graph.repository.accounting.attributedSymbols)} / ${compactNumber(
                    props.graph.repository.accounting.totalSymbols,
                  )}`}
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="graph-legend">
        <span>
          <i style={{background: GRAPH_PALETTE[0]}} /> Component or facet
        </span>
        <span>
          <i style={{background: SELECTED_NODE_COLOR}} /> Selected node
        </span>
        <span>
          <i className="legend-size" /> Size ·{' '}
          {props.graph.mode === 'overview'
            ? props.graph.repository.metrics === 'complete'
              ? 'Component symbols'
              : 'Visible relationships'
            : sizeMetricLabel(props.sizeMetric)}
        </span>
      </div>
      <section className="graph-analysis-summary">
        <header>
          <div>
            <p className="eyebrow">Whole-graph analysis</p>
            <h4>Architecture signals</h4>
          </div>
          <button className="quiet-button" disabled={props.analysisLoading} onClick={props.onAnalyze} type="button">
            {props.analysisLoading ? 'Analyzing…' : props.analysis ? 'Refresh' : 'Analyze'}
          </button>
        </header>
        {props.analysis ? (
          <>
            <dl className="metric-list graph-analysis-metrics">
              <div>
                <dt>Communities</dt>
                <dd>
                  {graphAnalysisTopologyAvailable(props.analysis)
                    ? compactNumber(props.analysis.statistics.communityCount)
                    : 'Unavailable'}
                </dd>
              </div>
              <div>
                <dt>Components</dt>
                <dd>
                  {graphAnalysisTopologyAvailable(props.analysis)
                    ? compactNumber(props.analysis.statistics.connectedComponentCount)
                    : 'Unavailable'}
                </dd>
              </div>
              <div>
                <dt>Hubs</dt>
                <dd>
                  {graphAnalysisTopologyAvailable(props.analysis)
                    ? compactNumber(props.analysis.hubs.length)
                    : 'Unavailable'}
                </dd>
              </div>
              <div>
                <dt>Coverage</dt>
                <dd>{graphAnalysisCoverageLabel(props.analysis)}</dd>
              </div>
            </dl>
            {props.analysis.hubs.length > 0 ? (
              <div className="graph-analysis-list">
                <h5>Highest-connectivity nodes</h5>
                {props.analysis.hubs.slice(0, 4).map(hub => (
                  <div key={`${hub.node.path}:${hub.node.label}`}>
                    <span>
                      <strong>{hub.node.label}</strong>
                      <small>{hub.node.path}</small>
                    </span>
                    <em>
                      {hub.classification === 'god-node' ? 'God node' : 'Hub'} · {hub.degree}
                    </em>
                  </div>
                ))}
              </div>
            ) : graphAnalysisTopologyAvailable(props.analysis) ? null : (
              <p>Topology was not derived, so community, component, and hub absence is not inferred.</p>
            )}
            {props.analysis.surprisingLinks[0] ? (
              <p className="graph-analysis-surprise">
                <strong>Cross-community signal:</strong> {props.analysis.surprisingLinks[0].source.label}{' '}
                {relationLabel(props.analysis.surprisingLinks[0].relation)}{' '}
                {props.analysis.surprisingLinks[0].target.label}
              </p>
            ) : null}
            {props.analysis.warnings.length > 0 ? <p>{props.analysis.warnings[0]}</p> : null}
          </>
        ) : props.analysisError ? (
          <p className="graph-analysis-error">{props.analysisError}</p>
        ) : (
          <p>Run deterministic communities, hub, and cross-boundary analysis on demand.</p>
        )}
      </section>
    </div>
  );
}

function NodeInspector(props: {
  readonly detail?: GraphNodeDetail;
  readonly detailError: string;
  readonly detailLoading: boolean;
  readonly graph: GraphVisualization;
  readonly node: GraphNode;
  readonly onOpenProject: () => void;
  readonly onSelectNode: (nodeId: string) => void;
}): React.ReactElement {
  const [tab, setTab] = useState<'evidence' | 'overview' | 'relationships'>('overview');
  useEffect(() => setTab('overview'), [props.node.id]);
  const connected = props.graph.edges.filter(
    edge => edge.sourceId === props.node.id || edge.targetId === props.node.id,
  );
  const nodesById = new Map(props.graph.nodes.map(node => [node.id, node]));
  const localRelated = connected
    .slice()
    .sort((left, right) => right.count - left.count || right.confidence - left.confidence)
    .slice(0, 7)
    .map(edge => {
      const id = edge.sourceId === props.node.id ? edge.targetId : edge.sourceId;
      return {edge, node: nodesById.get(id)};
    })
    .filter((item): item is {readonly edge: GraphEdge; readonly node: GraphNode} => item.node !== undefined);
  const visibleNodeIds = new Set(props.graph.nodes.map(node => node.id));
  const detail = props.detail?.node.id === props.node.id ? props.detail : undefined;
  const sourceLocation = detail
    ? `${detail.node.path}:${detail.node.span.line}:${detail.node.span.column}`
    : props.node.path;
  const breadcrumb = detail ? sourceBreadcrumb(detail.node.projectId, detail.node.path) : [];
  const relationshipCountsSampled = detail?.stats.summaryTruncated === true;
  const relationshipSampleLabel = detail ? graphRelationshipSampleLabel(detail) : undefined;
  return (
    <div className="node-inspector">
      <header className="node-inspector-header">
        <div className="node-kind-row">
          <span>{props.node.kind}</span>
          {props.node.exported ? <span>exported</span> : null}
          {props.node.projectId !== props.graph.projectId && props.graph.mode === 'detail' ? (
            <span>context</span>
          ) : null}
        </div>
        <h3>{props.node.label}</h3>
        <p className="node-qualified">{props.node.qualifiedName ?? props.node.projectId.replace(/^[^:]+:/, '')}</p>
        {breadcrumb.length > 0 ? (
          <div className="source-breadcrumb" aria-label="Source breadcrumb">
            {breadcrumb.map((part, index) => (
              <React.Fragment key={`${part}-${index}`}>
                {index > 0 ? <span aria-hidden="true">/</span> : null}
                <strong>{part}</strong>
              </React.Fragment>
            ))}
          </div>
        ) : null}
      </header>
      {props.node.type === 'project' ? (
        <button className="primary-button" onClick={props.onOpenProject} type="button">
          Explore component
        </button>
      ) : (
        <div className="inspector-tabs" role="tablist" aria-label="Node details">
          {(
            [
              ['overview', 'Overview'],
              ['relationships', 'Relations'],
              ['evidence', 'Evidence'],
            ] as const
          ).map(([value, label]) => (
            <button aria-selected={tab === value} key={value} onClick={() => setTab(value)} role="tab" type="button">
              {label}
            </button>
          ))}
        </div>
      )}

      {props.detailLoading ? (
        <div className="node-detail-status" role="status">
          <span className="spinner" aria-hidden="true" />
          Loading indexed details…
        </div>
      ) : null}
      {props.detailError ? (
        <div className="node-detail-error" role="alert">
          Detailed evidence unavailable: {props.detailError}
        </div>
      ) : null}

      {props.node.type === 'project' || tab === 'overview' ? (
        <>
          {detail?.node.documentation ? <p className="node-documentation">{detail.node.documentation}</p> : null}
          <dl className="node-details">
            {sourceLocation ? (
              <>
                <dt>Source</dt>
                <dd className="source-location">{sourceLocation}</dd>
              </>
            ) : null}
            {props.node.language ? (
              <>
                <dt>Language</dt>
                <dd>{props.node.language}</dd>
              </>
            ) : null}
            {detail?.node.packageName ? (
              <>
                <dt>Package</dt>
                <dd>{detail.node.packageName}</dd>
              </>
            ) : null}
            <dt>{detail ? 'Fan-in' : 'Visible degree'}</dt>
            <dd>
              {detail
                ? graphRelationshipCountLabel(detail.stats.incoming, relationshipCountsSampled)
                : props.node.degree.toLocaleString()}
            </dd>
            {detail ? (
              <>
                <dt>Fan-out</dt>
                <dd>{graphRelationshipCountLabel(detail.stats.outgoing, relationshipCountsSampled)}</dd>
              </>
            ) : null}
            {props.node.symbolCount !== undefined ? (
              <>
                <dt>Symbols</dt>
                <dd>{props.node.symbolCount.toLocaleString()}</dd>
                <dt>Files</dt>
                <dd>{props.node.fileCount?.toLocaleString()}</dd>
              </>
            ) : null}
          </dl>
          {detail?.stats.provenances.length ? (
            <div className="provenance-strip" aria-label="Relationship provenance">
              {detail.stats.provenances.map(item => (
                <span key={item.provenance}>
                  {item.provenance}{' '}
                  <strong>{graphRelationshipCountLabel(item.count, relationshipCountsSampled)}</strong>
                </span>
              ))}
            </div>
          ) : null}
          {relationshipSampleLabel ? <p className="detail-truncation">{relationshipSampleLabel}</p> : null}
          {(detail?.node.signature ?? props.node.signature) ? (
            <pre className="node-signature">{detail?.node.signature ?? props.node.signature}</pre>
          ) : null}
          {props.node.type === 'project' && localRelated.length ? (
            <div className="related-list">
              <h4>Strongest visible links</h4>
              {localRelated.map(({edge, node}) => (
                <button key={edge.id} onClick={() => props.onSelectNode(node.id)} type="button">
                  <span>{node.label}</span>
                  <small>
                    {relationLabel(edge.relation)} ·{' '}
                    {edge.count > 1 ? `${edge.count} links` : `${Math.round(edge.confidence * 100)}%`}
                  </small>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {props.node.type === 'symbol' && tab === 'relationships' ? (
        detail ? (
          <div className="relationship-view">
            <div className="relationship-totals">
              <span>
                <strong>{graphRelationshipCountLabel(detail.stats.incoming, relationshipCountsSampled)}</strong>{' '}
                incoming
              </span>
              <span>
                <strong>{graphRelationshipCountLabel(detail.stats.outgoing, relationshipCountsSampled)}</strong>{' '}
                outgoing
              </span>
            </div>
            <div className="relation-breakdown">
              {detail.stats.relations.map(item => {
                const maximum = detail.stats.relations[0]?.count ?? 1;
                return (
                  <div key={item.relation}>
                    <span>
                      <strong>{relationLabel(item.relation)}</strong>
                      <small>
                        {graphRelationshipCountLabel(item.incoming, relationshipCountsSampled)} in ·{' '}
                        {graphRelationshipCountLabel(item.outgoing, relationshipCountsSampled)} out
                      </small>
                    </span>
                    <i style={{width: `${Math.max(4, (item.count / maximum) * 100)}%`}} />
                  </div>
                );
              })}
            </div>
            {relationshipSampleLabel ? <p className="detail-truncation">{relationshipSampleLabel}</p> : null}
            <div className="related-list relationship-list">
              <h4>Direct neighborhood</h4>
              {detail.relationships.slice(0, 32).map(relationship => {
                const canSelect = Boolean(relationship.related.id && visibleNodeIds.has(relationship.related.id));
                return (
                  <button
                    disabled={!canSelect}
                    key={relationship.id}
                    onClick={() => {
                      if (relationship.related.id) props.onSelectNode(relationship.related.id);
                    }}
                    type="button"
                  >
                    <span>
                      <i aria-hidden="true">{relationship.direction === 'incoming' ? '←' : '→'}</i>{' '}
                      {relationship.related.label}
                    </span>
                    <small>
                      {relationLabel(relationship.relation)} · {relationship.provenance} ·{' '}
                      {Math.round(relationship.confidence * 100)}%
                      {!canSelect ? (relationship.related.id ? ' · unavailable' : ' · reference only') : ''}
                    </small>
                  </button>
                );
              })}
            </div>
            {detail.stats.truncated ? (
              <p className="detail-truncation">Showing the strongest 160 relationships from this node.</p>
            ) : null}
          </div>
        ) : (
          <p className="node-tab-empty">Relationship details are not available.</p>
        )
      ) : null}

      {props.node.type === 'symbol' && tab === 'evidence' ? (
        detail?.relationships.length ? (
          <div className="evidence-list">
            {detail.relationships.slice(0, 32).map(relationship => (
              <article key={relationship.id}>
                <header>
                  <span>{relationLabel(relationship.relation)}</span>
                  <strong>{Math.round(relationship.confidence * 100)}%</strong>
                </header>
                <p>
                  {relationship.direction === 'incoming' ? 'From' : 'To'}{' '}
                  {relationship.related.qualifiedName ?? relationship.related.label}
                </p>
                <code>
                  {relationship.evidencePath}:{relationship.evidenceSpan.line}:{relationship.evidenceSpan.column}
                </code>
                <footer>
                  <span>{relationship.provenance}</span>
                  <span>
                    lines {relationship.evidenceSpan.line}–{relationship.evidenceSpan.endLine}
                  </span>
                </footer>
              </article>
            ))}
            {detail.stats.truncated ? (
              <p className="detail-truncation">
                Evidence is capped at 160 relationships to keep inspection responsive.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="node-tab-empty">No relationship evidence is indexed for this node.</p>
        )
      ) : null}
    </div>
  );
}

function GraphAdministration(props: {
  readonly busy?: string;
  readonly onAction: (action: GraphAdministrationAction) => void;
  readonly onDiagnostics: (options: {readonly analyze: boolean; readonly deep: boolean}) => void;
  readonly output?: string;
  readonly report?: CodeGraphLocalDiagnosticsReport;
}): React.ReactElement {
  const dialogs = useOptionalManagerDialogs();
  const [analyze, setAnalyze] = useState(false);
  const [deep, setDeep] = useState(false);
  const [forceCompact, setForceCompact] = useState(false);
  const blocked = props.busy !== undefined;
  const confirmAction = async (options: ManagerDialogOptions, action: GraphAdministrationAction): Promise<void> => {
    if (await dialogs.confirm(options)) props.onAction(action);
  };
  const targetAction = async (
    managementAvailable: boolean,
    action: GraphWorktreeAdministrationAction,
  ): Promise<GraphWorktreeAdministrationAction | undefined> => {
    if (managementAvailable) return action;
    const values = await dialogs.prompt({
      confirmLabel: 'Use worktree',
      detail: `Checkout ${action.checkoutId.slice(-12)} · view ${action.worktreeId.slice(-8)}`,
      fields: [
        {
          description: 'Threadnote verifies this path against the indexed checkout and worktree before acting.',
          id: 'cwd',
          label: 'Absolute worktree path',
          placeholder: '/absolute/path/to/worktree',
          required: true,
        },
      ],
      message: 'Threadnote has no current local path for this indexed view.',
      title: 'Locate the indexed worktree',
    });
    return values ? {...action, cwd: values.cwd} : undefined;
  };
  const dispatchTargetAction = async (
    managementAvailable: boolean,
    action: GraphWorktreeAdministrationAction,
    confirmation?: ManagerDialogOptions,
  ): Promise<void> => {
    const targeted = await targetAction(managementAvailable, action);
    if (!targeted) return;
    if (confirmation && !(await dialogs.confirm(confirmation))) return;
    props.onAction(targeted);
  };
  return (
    <details className="graph-administration">
      <summary>
        <span>
          <strong>Graph administration</strong>
          <small>
            {props.report
              ? `${props.report.summary.databaseCount} databases · ${props.report.summary.readySnapshotCount} ready snapshots`
              : 'Load home-wide status, diagnostics, and maintenance controls'}
          </small>
        </span>
        {props.busy ? <em>{props.busy}…</em> : null}
      </summary>
      <div className="graph-administration-body">
        <div className="graph-administration-toolbar">
          <label className="check-row">
            <input
              checked={analyze}
              disabled={blocked}
              onChange={event => setAnalyze(event.target.checked)}
              type="checkbox"
            />
            <span>Structural stats</span>
          </label>
          <label className="check-row">
            <input
              checked={deep}
              disabled={blocked}
              onChange={event => setDeep(event.target.checked)}
              type="checkbox"
            />
            <span>Deep SQLite checks</span>
          </label>
          <button disabled={blocked} onClick={() => props.onDiagnostics({analyze, deep})} type="button">
            Diagnose all
          </button>
          <button
            disabled={blocked}
            onClick={() => props.onAction({action: 'repair', deep, dryRun: true})}
            type="button"
          >
            Preview repair
          </button>
          <button
            disabled={blocked}
            onClick={() =>
              void confirmAction(
                {
                  confirmLabel: deep ? 'Run deep repair' : 'Run repair',
                  message: deep
                    ? 'Deep repair may discard corrupt disposable graph databases after integrity checks.'
                    : 'Run immediate quick repair and pending graph schema migrations.',
                  title: deep ? 'Repair every graph deeply?' : 'Repair every graph?',
                  tone: deep ? 'danger' : 'default',
                },
                {action: 'repair', deep},
              )
            }
            type="button"
          >
            {deep ? 'Deep repair all' : 'Repair all'}
          </button>
          <button disabled={blocked} onClick={() => props.onAction({action: 'purge-all', dryRun: true})} type="button">
            Preview purge all
          </button>
          <button
            className="danger"
            disabled={blocked}
            onClick={() =>
              void confirmAction(
                {
                  confirmLabel: 'Purge every graph',
                  message: 'Every local native code graph index will be removed and rebuilt on demand.',
                  title: 'Purge all disposable graphs?',
                  tone: 'danger',
                },
                {action: 'purge-all'},
              )
            }
            type="button"
          >
            Purge all
          </button>
        </div>
        <label className="check-row graph-force-compact">
          <input
            checked={forceCompact}
            disabled={blocked}
            onChange={event => setForceCompact(event.target.checked)}
            type="checkbox"
          />
          <span>Force compaction below the reviewed reclaimable-space threshold</span>
        </label>
        {props.report ? (
          <div className="graph-database-grid">
            {props.report.databases.map(database => {
              const view = database.views.find(candidate => candidate.managementAvailable) ?? database.views[0];
              const managementAvailable = view?.managementAvailable === true;
              const repository = view?.repository.displayName ?? `Checkout ${database.checkoutId.slice(-8)}`;
              const jobs = graphAdministrationJobSelection(database.builds, database.waiters);
              const obsolete = props.report?.obsoleteStores.checkouts.find(
                checkout => checkout.checkoutId === database.checkoutId,
              );
              const target = view
                ? graphAdministrationTarget(database.checkoutId, {
                    repository: view.repository,
                    worktreeId: view.viewWorktreeId,
                  })
                : undefined;
              return (
                <article className="graph-database-card" key={database.checkoutId}>
                  <header>
                    <span>
                      <strong>{repository}</strong>
                      <small>{database.checkoutId.slice(-12)}</small>
                    </span>
                    <em className={`is-${database.health?.integrity ?? database.healthState}`}>
                      {database.health?.integrity ?? database.healthState}
                    </em>
                  </header>
                  <dl>
                    <div>
                      <dt>Snapshots</dt>
                      <dd>
                        {database.health
                          ? `${database.health.readySnapshots} ready`
                          : database.healthState === 'deferred'
                            ? 'health inspection deferred'
                            : 'unavailable'}
                      </dd>
                    </div>
                    <div>
                      <dt>Views</dt>
                      <dd>{database.views.length}</dd>
                    </div>
                    <div>
                      <dt>Storage</dt>
                      <dd>
                        {database.storage.state === 'available'
                          ? formatGraphBytes(database.storage.totalBytes)
                          : 'missing'}
                      </dd>
                    </div>
                    <div>
                      <dt>Jobs</dt>
                      <dd>{jobs.total === 0 ? 'None' : `${jobs.total} actionable`}</dd>
                    </div>
                  </dl>
                  <div className="graph-database-views">
                    {database.views.map(candidate => {
                      const removalTarget = graphViewRemovalTarget(database.checkoutId, {
                        snapshot: candidate.snapshot,
                        worktreeId: candidate.viewWorktreeId,
                      });
                      return (
                        <div key={`${database.checkoutId}:${candidate.viewWorktreeId}`}>
                          <strong>View {candidate.viewWorktreeId.slice(-8)}</strong>
                          <span>
                            {candidate.snapshot.fileCount.toLocaleString()} files ·{' '}
                            {candidate.snapshot.symbolCount.toLocaleString()} symbols ·{' '}
                            {candidate.snapshot.edgeCount.toLocaleString()} edges
                          </span>
                          <small>
                            Folder: {graphLocalAssociationText(candidate.localAssociation)} ·{' '}
                            {candidate.localAssociation.state}
                          </small>
                          {candidate.analysis ? (
                            <small>
                              {candidate.analysis.coverage.complete ? 'Complete' : 'Partial'} analysis ·{' '}
                              {candidate.analysis.coverage.topology.state === 'complete' ||
                              candidate.analysis.coverage.topology.state === 'partial' ? (
                                <>
                                  {candidate.analysis.statistics.connectedComponentCount.toLocaleString()} components ·{' '}
                                  {candidate.analysis.statistics.communityCount.toLocaleString()} communities · average
                                  degree {candidate.analysis.statistics.averageDegree.toFixed(2)} · maximum{' '}
                                  {candidate.analysis.statistics.maximumDegree.toLocaleString()} ·{' '}
                                  {candidate.analysis.statistics.isolatedNodeCount.toLocaleString()} isolated
                                </>
                              ) : (
                                <>topology {candidate.analysis.coverage.topology.state}</>
                              )}
                            </small>
                          ) : null}
                          <button
                            aria-label={`Remove indexed view ${candidate.viewWorktreeId.slice(-8)}`}
                            className="danger graph-view-remove"
                            disabled={blocked}
                            onClick={() => props.onAction({action: 'remove-view', ...removalTarget})}
                            title="Remove indexed view"
                            type="button"
                          >
                            <svg aria-hidden="true" viewBox="0 0 24 24">
                              <path d="M4 6h16M9 6V4h6v2m3 0-1 14H7L6 6m4 4v6m4-6v6" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {jobs.jobs.map(job => (
                    <p className="graph-database-job" key={`${job.buildId}:${job.coordination?.role ?? 'build'}`}>
                      View {job.identity.worktreeId.slice(-8)} · {job.state === 'running' ? 'active' : job.state} ·{' '}
                      {job.phase}
                      {job.subphase ? `/${job.subphase}` : ''} · {job.observation.liveness}
                      {job.error ? ` · ${job.error.summary}` : ''}
                    </p>
                  ))}
                  {jobs.hiddenCount > 0 ? (
                    <p className="graph-database-job">+{jobs.hiddenCount} more active or failed jobs</p>
                  ) : null}
                  {database.issues.map(issue => (
                    <p className="graph-database-issue" key={`${database.checkoutId}:${issue.code}`}>
                      {issue.code}: {issue.message}
                    </p>
                  ))}
                  <div className="graph-database-actions">
                    <button
                      disabled={blocked || !target}
                      onClick={() => {
                        if (!target) return;
                        void dispatchTargetAction(managementAvailable, {action: 'index', ...target});
                      }}
                      type="button"
                    >
                      Index
                    </button>
                    <button
                      disabled={blocked || !target}
                      onClick={() => {
                        if (!target) return;
                        void dispatchTargetAction(managementAvailable, {action: 'index', full: true, ...target});
                      }}
                      type="button"
                    >
                      Reindex
                    </button>
                    <button
                      disabled={blocked || !target}
                      onClick={() => {
                        if (!target) return;
                        void dispatchTargetAction(managementAvailable, {
                          action: 'compact',
                          dryRun: true,
                          force: forceCompact,
                          ...target,
                        });
                      }}
                      type="button"
                    >
                      Preview compact
                    </button>
                    <button
                      disabled={blocked || !target}
                      onClick={() => {
                        if (!target) return;
                        void dispatchTargetAction(
                          managementAvailable,
                          {action: 'compact', force: forceCompact, ...target},
                          {
                            confirmLabel: 'Compact graph',
                            detail: repository,
                            message: 'Rewrite this verified graph database to reclaim reviewed free space.',
                            title: 'Compact this graph?',
                          },
                        );
                      }}
                      type="button"
                    >
                      Compact
                    </button>
                    {obsolete ? (
                      <>
                        <button
                          disabled={blocked}
                          onClick={() =>
                            props.onAction({
                              action: 'purge-obsolete',
                              checkoutId: database.checkoutId,
                              dryRun: true,
                            })
                          }
                          type="button"
                        >
                          Preview obsolete
                        </button>
                        <button
                          disabled={blocked}
                          onClick={() =>
                            void confirmAction(
                              {
                                confirmLabel: 'Purge obsolete files',
                                detail: repository,
                                message: `Remove ${obsolete.fileCount} verified obsolete graph file${obsolete.fileCount === 1 ? '' : 's'}.`,
                                title: 'Purge obsolete graph files?',
                                tone: 'danger',
                              },
                              {action: 'purge-obsolete', checkoutId: database.checkoutId},
                            )
                          }
                          type="button"
                        >
                          Purge obsolete
                        </button>
                      </>
                    ) : null}
                    <button
                      disabled={blocked}
                      onClick={() => props.onAction({action: 'purge', checkoutId: database.checkoutId, dryRun: true})}
                      type="button"
                    >
                      Preview purge
                    </button>
                    <button
                      className="danger"
                      disabled={blocked}
                      onClick={() =>
                        void confirmAction(
                          {
                            confirmLabel: 'Purge graph',
                            detail: repository,
                            message: 'Remove this disposable native graph index. It will rebuild on demand.',
                            title: 'Purge this graph?',
                            tone: 'danger',
                          },
                          {action: 'purge', checkoutId: database.checkoutId},
                        )
                      }
                      type="button"
                    >
                      Purge graph
                    </button>
                  </div>
                  {!managementAvailable ? (
                    <small className="graph-management-unavailable">
                      Index, reindex, and compact require a verified local worktree path. Purge actions target this
                      inventoried checkout directly.
                    </small>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <p>Load diagnostics to enumerate every local graph database.</p>
        )}
        {props.output ? <pre className="graph-administration-output">{props.output}</pre> : null}
      </div>
    </details>
  );
}

export function graphLocalAssociationText(association: CodeGraphLocalAssociation): string {
  return association.displayPath ?? association.state.replaceAll('-', ' ');
}

function GraphMaintenanceProgress(props: {readonly status: CodeGraphMaintenanceStatus}): React.ReactElement {
  const {status} = props;
  const elapsed = status.startedAt === undefined ? undefined : Math.max(0, Date.now() - Date.parse(status.startedAt));
  const lastUpdate =
    status.updatedAt === undefined ? undefined : Math.max(0, Date.now() - Date.parse(status.updatedAt));
  const percentage =
    status.completed !== undefined && status.total !== undefined && status.total > 0
      ? Math.max(0, Math.min(100, (status.completed / status.total) * 100))
      : undefined;
  return (
    <div className="graph-build-status graph-maintenance-status" aria-live="polite">
      <article className="graph-build-card is-running is-active">
        <header>
          <div className="graph-build-target">
            <strong>
              {status.operation === 'selected-snapshot-purge' ? 'Selected snapshot purge' : 'Graph maintenance'}
            </strong>
            <span>
              {status.checkoutId ? `Checkout ${shortGraphIdentity(status.checkoutId)}` : 'Home-wide maintenance'}
              {status.snapshotId ? ` · snapshot ${status.snapshotId}` : ''}
            </span>
          </div>
          {elapsed === undefined ? null : <span>Elapsed {formatBuildDuration(elapsed)}</span>}
        </header>
        <p className="graph-build-phase">{graphMaintenanceStatusLabel(status)}</p>
        {percentage === undefined ? null : (
          <div className="graph-build-meter" aria-label={`${Math.round(percentage)}% complete`}>
            <i style={{width: `${percentage}%`}} />
          </div>
        )}
        <p>
          {status.completed === undefined || status.total === undefined
            ? 'Waiting for the next maintenance phase update'
            : `${status.completed.toLocaleString()} / ${status.total.toLocaleString()} safety phases`}
          {lastUpdate === undefined ? '' : ` · last update ${formatBuildDuration(lastUpdate)} ago`}
        </p>
      </article>
    </div>
  );
}

function GraphBuildProgress(props: {
  readonly build: GraphBuildStatus;
  readonly repositories: readonly GraphRepositoryGroup[];
  readonly waiters: readonly GraphBuildStatus[];
}): React.ReactElement {
  const {build} = props;
  const completed = build.counters.completed;
  const total = build.counters.total;
  const percentage =
    completed !== undefined && total !== undefined && total > 0
      ? Math.max(0, Math.min(100, (completed / total) * 100))
      : undefined;
  const elapsed = Math.max(0, Date.now() - Date.parse(build.timestamps.startedAt));
  const lastProgress = Math.max(0, Date.now() - Date.parse(build.timestamps.lastProgressAt));
  const progressSilent = build.coordination?.progressSilent === true;
  const eta = progressSilent ? undefined : build.eta;
  const target = graphBuildTarget(build, props.repositories);
  const concurrency = graphBuildConcurrencyState(build, props.waiters, props.repositories);
  const waiterCount = graphWaiterCountForBuild(build, props.waiters);
  const statusLabel =
    build.state === 'failed'
      ? 'Indexing failed'
      : build.state === 'queued'
        ? 'Waiting to index'
        : progressSilent
          ? 'Indexing status is stale'
          : 'Indexing';
  return (
    <article className={`graph-build-card is-${build.state} is-${build.observation.liveness}`}>
      <header>
        <div className="graph-build-target">
          <strong>{target.repositoryLabel}</strong>
          <span title={target.worktreeLabel}>{target.worktreeLabel}</span>
        </div>
        <span>Elapsed {formatBuildDuration(elapsed)}</span>
      </header>
      <p className="graph-build-phase">
        {statusLabel} · {build.phase}/{build.subphase ?? 'working'} · commit {build.identity.commit}
      </p>
      <p className="graph-build-concurrency">
        {build.state === 'running'
          ? `Active target ${graphCommitLabel(build.identity.commit)}`
          : build.state === 'queued'
            ? `Queued target ${graphCommitLabel(build.identity.commit)}`
            : build.state === 'failed'
              ? `Failed target ${graphCommitLabel(build.identity.commit)}`
              : `Completed target ${graphCommitLabel(build.identity.commit)}`}
        {concurrency.latestTargetCommit === build.identity.commit
          ? ''
          : ` · latest target ${graphCommitLabel(concurrency.latestTargetCommit)} queued`}
        {concurrency.queuedRequests === 0
          ? ''
          : ` · ${concurrency.queuedRequests.toLocaleString()} queued request${concurrency.queuedRequests === 1 ? '' : 's'}`}
      </p>
      {concurrency.staleReady && concurrency.readySnapshotCommit !== undefined ? (
        <p className="graph-build-attention">
          Ready snapshot {graphCommitLabel(concurrency.readySnapshotCommit)} remains queryable · stale for latest target{' '}
          {graphCommitLabel(concurrency.latestTargetCommit)}
        </p>
      ) : null}
      {percentage === undefined ? null : (
        <div className="graph-build-meter" aria-label={`${Math.round(percentage)}% complete`}>
          <i style={{width: `${percentage}%`}} />
        </div>
      )}
      <p>
        {build.phase === 'reclaiming'
          ? `${(completed ?? 0).toLocaleString()} / ${(total ?? 0).toLocaleString()} snapshots · ${(
              build.counters.pagesCompleted ?? 0
            ).toLocaleString()} pages · ${(build.counters.rowsDeleted ?? 0).toLocaleString()} rows reclaimed`
          : completed === undefined || total === undefined
            ? 'Preparing phase counters'
            : `${completed.toLocaleString()} / ${total.toLocaleString()} ${build.counters.unit ?? 'items'}`}
        {' · '}last progress change {formatBuildDuration(lastProgress)} ago
      </p>
      {progressSilent ? (
        <p className="graph-build-attention">
          No progress update for {formatBuildDuration(lastProgress)}. Process {build.owner.processId} still owns the
          build lock, but Manager cannot determine whether its current operation is advancing.
        </p>
      ) : null}
      {build.activity ? (
        <p>
          Current reported step: {build.activity.stage} {build.activity.language} ·{' '}
          {formatGraphBytes(build.activity.bytes)} · batch {build.activity.batchCompleted.toLocaleString()}/
          {build.activity.batchTotal.toLocaleString()}
          {build.activity.sizeBucket === undefined ? '' : ` · ${build.activity.sizeBucket} source bucket`}
          {build.activity.role === undefined ? '' : ` · ${build.activity.role}`}
          {build.activity.classifier === undefined ? '' : `/${build.activity.classifier}`}
          {build.activity.factsBytes === undefined
            ? ''
            : ` · ${formatGraphBytes(build.activity.factsBytes)} emitted facts`}
          {build.activity.symbols === undefined ? '' : ` · ${build.activity.symbols.toLocaleString()} symbols`}
          {build.activity.relations === undefined ? '' : ` · ${build.activity.relations.toLocaleString()} relations`}
          {build.activity.parseMilliseconds === undefined
            ? ''
            : ` · parse ${formatGraphMilliseconds(build.activity.parseMilliseconds)}`}
          {build.activity.persistMilliseconds === undefined
            ? ''
            : ` · persist ${formatGraphMilliseconds(build.activity.persistMilliseconds)}`}
          {build.activity.degraded ? ' · metadata fallback; retry scheduled' : ''}
        </p>
      ) : null}
      {build.extraction ? (
        <p>
          Extraction telemetry: {build.extraction.completedFiles.toLocaleString()} files completed ·{' '}
          {build.extraction.slowFiles.toLocaleString()} at or above{' '}
          {formatGraphMilliseconds(CODE_GRAPH_SLOW_FILE_THRESHOLD_MILLISECONDS)} · bounded top-slow evidence{' '}
          {build.extraction.topSlowFiles.length.toLocaleString()}/{CODE_GRAPH_TOP_SLOW_FILE_LIMIT.toLocaleString()}
        </p>
      ) : null}
      {build.materialization?.activity ? (
        <p>
          Current reported step: {graphMaterializationStageLabel(build.materialization.activity.stage)} · batch{' '}
          {graphActiveBatchNumber(
            build.materialization.activity.batchCompleted,
            build.materialization.activity.batchTotal,
          ).toLocaleString()}
          /{build.materialization.activity.batchTotal.toLocaleString()} ·{' '}
          {formatGraphBytes(build.materialization.activity.sourceBytes)} source
          {build.materialization.activity.cachedFactBytes === undefined
            ? ''
            : ` · ${formatGraphBytes(build.materialization.activity.cachedFactBytes)} cached facts`}
          {build.materialization.activity.factsBytes === undefined
            ? ''
            : ` · ${formatGraphBytes(build.materialization.activity.factsBytes)} final facts`}
          {graphMaterializationRows(build.materialization.activity.rows)}
          {' · '}this step{' '}
          {formatBuildDuration(Math.max(0, Date.now() - Date.parse(build.materialization.activity.startedAt)))}
          {build.materialization.activity.transactionMilliseconds === undefined
            ? ''
            : ` · transaction ${formatGraphMilliseconds(build.materialization.activity.transactionMilliseconds)}`}
        </p>
      ) : null}
      {build.activation?.activity ? (
        <p>
          Current reported step: activating · {build.activation.activity.stage.replaceAll('-', ' ')} ·{' '}
          {build.activation.activity.state}
          {build.activation.activity.rows === undefined
            ? ''
            : ` · ${build.activation.activity.rows.toLocaleString()} rows`}
          {' · '}stage {formatGraphMilliseconds(build.activation.activity.stageElapsedMilliseconds)} · total{' '}
          {formatGraphMilliseconds(build.activation.activity.elapsedMilliseconds)}
          {build.activation.activity.transactionMilliseconds === undefined
            ? ''
            : ` · transaction ${formatGraphMilliseconds(build.activation.activity.transactionMilliseconds)}`}
        </p>
      ) : null}
      {build.resolution?.activity ? (
        <p>
          Reference resolution: pass {build.resolution.activity.pass.toLocaleString()} · page{' '}
          {build.resolution.activity.pageCompleted.toLocaleString()}/
          {build.resolution.activity.pageTotal.toLocaleString()} ·{' '}
          {build.resolution.activity.referencesCompleted.toLocaleString()}/
          {build.resolution.activity.referencesTotal.toLocaleString()} references ·{' '}
          {build.resolution.activity.referencesExamined.toLocaleString()} cumulative examined ·{' '}
          {build.resolution.activity.resolved.toLocaleString()} linked ·{' '}
          {build.resolution.activity.aliasesDiscovered.toLocaleString()} aliases · match{' '}
          {formatGraphMilliseconds(build.resolution.activity.matchingMilliseconds)} · transactions{' '}
          {formatGraphMilliseconds(build.resolution.activity.transactionMilliseconds)} · total{' '}
          {formatGraphMilliseconds(build.resolution.activity.elapsedMilliseconds)}
        </p>
      ) : null}
      {build.materialization?.metrics ? (
        <>
          <p>
            Materialized: {build.materialization.metrics.batchesCompleted.toLocaleString()}/
            {build.materialization.metrics.batchesTotal.toLocaleString()} batches ·{' '}
            {formatGraphBytes(build.materialization.metrics.sourceBytesCompleted)}/
            {formatGraphBytes(build.materialization.metrics.sourceBytesTotal)} source
            {build.materialization.metrics.cachedFactBytesCompleted === undefined
              ? ''
              : ` · ${formatGraphBytes(build.materialization.metrics.cachedFactBytesCompleted)}${
                  build.materialization.metrics.cachedFactBytesTotal === undefined
                    ? ''
                    : `/${formatGraphBytes(build.materialization.metrics.cachedFactBytesTotal)}`
                } cached facts`}
            {build.materialization.metrics.factsBytesCompleted === undefined
              ? ''
              : ` · ${formatGraphBytes(build.materialization.metrics.factsBytesCompleted)}${
                  build.materialization.metrics.factsBytesTotal === undefined
                    ? ''
                    : `/${formatGraphBytes(build.materialization.metrics.factsBytesTotal)}`
                } final facts`}
            {graphMaterializationRows(build.materialization.metrics.rows)}
            {build.materialization.metrics.loadingMilliseconds === undefined
              ? ''
              : ` · load ${formatGraphMilliseconds(build.materialization.metrics.loadingMilliseconds)}`}
            {build.materialization.metrics.attributionMilliseconds === undefined
              ? ''
              : ` · attribute ${formatGraphMilliseconds(build.materialization.metrics.attributionMilliseconds)}`}
            {build.materialization.metrics.transactionMilliseconds === undefined
              ? ''
              : ` · transactions ${formatGraphMilliseconds(build.materialization.metrics.transactionMilliseconds)}`}
          </p>
          {build.materialization.metrics.storage ? (
            <>
              <p>
                Storage:
                {build.materialization.metrics.storage.durableDatabaseBytes === undefined
                  ? ''
                  : ` ${formatGraphBytes(build.materialization.metrics.storage.durableDatabaseBytes)} allocated durable pages`}
                {build.materialization.metrics.storage.durableDatabaseHighWaterBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.durableDatabaseHighWaterBytes)} allocated-page high-water`}
                {build.materialization.metrics.storage.durableDatabaseGrowthHighWaterBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.durableDatabaseGrowthHighWaterBytes)} main-database growth`}
                {build.materialization.metrics.storage.durableFilesystemHighWaterBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.durableFilesystemHighWaterBytes)} DB + sidecars high-water`}
                {build.materialization.metrics.storage.durableWalHighWaterBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.durableWalHighWaterBytes)} WAL high-water`}
                {build.materialization.metrics.storage.durableJournalHighWaterBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.durableJournalHighWaterBytes)} rollback-journal high-water`}
                {build.materialization.metrics.storage.durableDatabaseBytes === undefined ? '' : ' ·'}{' '}
                {formatGraphBytes(build.materialization.metrics.storage.temporaryDatabaseBytes)} current TEMP database ·{' '}
                {formatGraphBytes(build.materialization.metrics.storage.temporaryDatabaseHighWaterBytes)} TEMP database
                high-water
                {build.materialization.metrics.storage.estimatedRequiredBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.estimatedRequiredBytes)} combined estimate`}
                {build.materialization.metrics.storage.estimatedTemporaryFilesystemRequiredBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.estimatedTemporaryFilesystemRequiredBytes)} TEMP-filesystem requirement`}
                {build.materialization.metrics.storage.estimatedDurableFilesystemRequiredBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.estimatedDurableFilesystemRequiredBytes)} graph-filesystem requirement`}
                {build.materialization.metrics.storage.temporaryAvailableBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.temporaryAvailableBytes)} available for TEMP`}
                {build.materialization.metrics.storage.durableAvailableBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.durableAvailableBytes)} available for graph database`}
                {build.materialization.metrics.storage.filesystemsShared === true ? ' · shared filesystem' : ''}
                {build.materialization.metrics.storage.materializationMode === undefined
                  ? ''
                  : ` · ${build.materialization.metrics.storage.materializationMode.replaceAll('-', ' ')}`}
                {build.materialization.metrics.storage.estimateBasis === undefined
                  ? ''
                  : ` · estimate from ${build.materialization.metrics.storage.estimateBasis.replaceAll('-', ' ')}`}
                {' · '}rollback journals excluded from TEMP totals
              </p>
              {graphMaterializationDiskWarning(build.materialization.metrics.storage) ? (
                <p className="graph-build-error">
                  {graphMaterializationDiskWarning(build.materialization.metrics.storage)} Indexing continues with live
                  storage telemetry.
                </p>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {build.timings ? (
        <p>
          Phase: read {formatGraphMilliseconds(build.timings.readingMilliseconds)} · parse{' '}
          {formatGraphMilliseconds(build.timings.extractionMilliseconds)} · persist{' '}
          {formatGraphMilliseconds(build.timings.persistenceMilliseconds)}
        </p>
      ) : null}
      <footer>
        <span title={build.owner.processStartIdentity}>
          Process {build.owner.processId}
          {build.owner.processStartIdentity
            ? ` · owner instance ${shortGraphIdentity(build.owner.processStartIdentity)}`
            : ''}
        </span>
        {eta && eta.confidence !== 'low' ? (
          <span>
            Estimated time remaining in this phase: {formatBuildDuration(eta.remainingMilliseconds)} · {eta.confidence}{' '}
            confidence
            {eta.basis ? ` · ${graphEtaBasisLabel(eta.basis)}` : ''}
          </span>
        ) : null}
        {waiterCount > 0 ? <span>{waiterCount} waiting process(es) for this exact target</span> : null}
        {build.error ? <span className="graph-build-error">{build.error.summary}</span> : null}
      </footer>
    </article>
  );
}

function graphCommitLabel(commit: string): string {
  return commit.slice(0, 12) || 'unknown';
}

function graphActiveBatchNumber(completed: number, total: number): number {
  return total === 0 ? 0 : Math.min(total, completed + 1);
}

function graphMaterializationStageLabel(stage: GraphMaterializationStage): string {
  switch (stage) {
    case 'loading-cache':
      return 'loading cached facts';
    case 'attributing':
      return 'attributing facts';
    case 'preparing-rows':
      return 'preparing rows';
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

function graphMaterializationRows(rows: GraphMaterializationRows | undefined): string {
  if (!rows) return '';
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
  return values.length > 0 ? ` · ${values.join(', ')}` : '';
}

function graphMaterializationDiskWarning(storage: GraphMaterializationStorage): string | undefined {
  if (
    storage.filesystemsShared === true &&
    storage.availableBytes !== undefined &&
    storage.estimatedRequiredBytes !== undefined &&
    storage.availableBytes < storage.estimatedRequiredBytes
  ) {
    return 'Low disk: shared TEMP and graph storage is below the conservative combined estimate.';
  }
  const scopes: string[] = [];
  if (
    storage.temporaryAvailableBytes !== undefined &&
    storage.estimatedTemporaryFilesystemRequiredBytes !== undefined &&
    storage.temporaryAvailableBytes < storage.estimatedTemporaryFilesystemRequiredBytes
  ) {
    scopes.push('SQLite TEMP');
  }
  if (
    storage.durableAvailableBytes !== undefined &&
    storage.estimatedDurableFilesystemRequiredBytes !== undefined &&
    storage.durableAvailableBytes < storage.estimatedDurableFilesystemRequiredBytes
  ) {
    scopes.push('graph database');
  }
  return scopes.length === 0 ? undefined : `Low disk: ${scopes.join(' and ')} storage is below its estimate.`;
}

function graphEtaBasisLabel(basis: 'cached-fact-bytes' | 'files' | 'final-fact-bytes' | 'source-bytes'): string {
  switch (basis) {
    case 'cached-fact-bytes':
      return 'cached-fact bytes';
    case 'final-fact-bytes':
      return 'final attributed fact bytes';
    case 'source-bytes':
      return 'source bytes';
    case 'files':
      return 'files';
  }
}

function GraphEmptyState(props: {readonly building: boolean}): React.ReactElement {
  return (
    <div className="graph-empty">
      <span className="empty-orbit" aria-hidden="true" />
      <h3>{props.building ? 'Building the first repository graph' : 'No indexed repositories yet'}</h3>
      <p>
        {props.building
          ? 'The newest phase and counters appear above. A ready snapshot will open here automatically.'
          : 'Build a native graph from a repository, then refresh this workspace.'}
      </p>
      {props.building ? null : <code>threadnote graph index</code>}
    </div>
  );
}

function formatBuildDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return 'unknown';
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatGraphMilliseconds(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';
  if (milliseconds < 1) return '<1ms';
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 1 : 2)}s`;
}

function formatGraphBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1_024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1_024;
  let unit = units[0]!;
  for (const candidate of units.slice(1)) {
    if (value < 1_024) break;
    value /= 1_024;
    unit = candidate;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function buildGraphLayout(
  graph: GraphVisualization,
  sizeMetric: GraphSizeMetric,
  sizingEdges: readonly GraphEdge[],
): GraphLayout {
  const sizeValues = graphNodeSizeValues(sizingEdges, sizeMetric);
  const nodes = graph.mode === 'overview' ? overviewLayout(graph.nodes) : detailLayout(graph.nodes, sizeValues);
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const extentX = Math.max(260, ...nodes.map(node => Math.abs(node.x) + node.radius));
  const extentY = Math.max(200, ...nodes.map(node => Math.abs(node.y) + node.radius));
  return {bounds: {height: extentY * 2.2, width: extentX * 2.2}, nodes, nodesById};
}

function graphLayoutWithPositions(layout: GraphLayout, positions: ReadonlyMap<string, GraphPosition>): GraphLayout {
  if (positions.size === 0) return layout;
  const nodes = layout.nodes.map(node => {
    const position = positions.get(node.id);
    return position ? {...node, x: position.x, y: position.y} : node;
  });
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const extentX = Math.max(260, ...nodes.map(node => Math.abs(node.x) + node.radius));
  const extentY = Math.max(200, ...nodes.map(node => Math.abs(node.y) + node.radius));
  return {bounds: {height: extentY * 2.2, width: extentX * 2.2}, nodes, nodesById};
}

export function graphFocusLayoutTargets(
  nodes: readonly {
    readonly id: string;
    readonly label: string;
    readonly radius: number;
    readonly x: number;
    readonly y: number;
  }[],
  selectedNodeId: string | undefined,
  edges: readonly Pick<GraphEdge, 'sourceId' | 'targetId'>[],
  labelSizes: ReadonlyMap<string, {readonly height: number; readonly width: number}> = new Map(),
  zoom = FOCUS_LAYOUT_ZOOM,
): ReadonlyMap<string, GraphPosition> {
  if (!selectedNodeId) return new Map();
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const selectedNode = nodesById.get(selectedNodeId);
  if (!selectedNode) return new Map();
  const neighborIds = new Set<string>();
  for (const edge of edges) {
    if (edge.sourceId === selectedNodeId && nodesById.has(edge.targetId)) neighborIds.add(edge.targetId);
    if (edge.targetId === selectedNodeId && nodesById.has(edge.sourceId)) neighborIds.add(edge.sourceId);
  }
  neighborIds.delete(selectedNodeId);
  const orderedNeighbors = [...neighborIds]
    .map(nodeId => nodesById.get(nodeId))
    .filter(node => node !== undefined)
    .sort((left, right) => compareCodeUnits(left.label, right.label) || compareCodeUnits(left.id, right.id));
  const highlightedIds = new Set([selectedNodeId, ...neighborIds]);
  const visibleObstacles = nodes
    .filter(node => !highlightedIds.has(node.id) && labelSizes.has(node.id))
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .slice(0, 180);
  const focusNodes = [
    {
      anchorX: selectedNode.x,
      anchorY: selectedNode.y,
      fixed: true,
      highlighted: true,
      ...selectedNode,
    },
    ...orderedNeighbors.map(node => ({
      anchorX: node.x,
      anchorY: node.y,
      fixed: false,
      highlighted: true,
      ...node,
    })),
    ...visibleObstacles.map(node => ({
      anchorX: node.x,
      anchorY: node.y,
      fixed: false,
      highlighted: false,
      ...node,
    })),
  ];
  const safeZoom = Math.max(0.5, zoom);
  const animatedNeighbors = focusNodes.filter(node => node.highlighted && !node.fixed);
  const maximumLabelWidth = Math.max(
    72,
    ...animatedNeighbors.map(node => labelSizes.get(node.id)?.width ?? Math.min(150, node.label.length * 6.2)),
  );
  const maximumLabelHeight = Math.max(14, ...animatedNeighbors.map(node => labelSizes.get(node.id)?.height ?? 14));
  const columns = Math.max(2, Math.ceil(Math.sqrt((animatedNeighbors.length + 1) * 0.35)));
  const rows = Math.ceil((animatedNeighbors.length + 1) / columns);
  const cellWidth = (Math.min(150, maximumLabelWidth) + 14) / safeZoom;
  const cellHeight = (maximumLabelHeight + 10) / safeZoom;
  const slots = Array.from({length: rows * columns}, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      x: (column - (columns - 1) / 2) * cellWidth,
      y: ((rows - 1) / 2 - row) * cellHeight,
    };
  });
  const centerSlot = slots.reduce(
    (closest, slot, index) =>
      Math.hypot(slot.x, slot.y) < closest.distance ? {distance: Math.hypot(slot.x, slot.y), index} : closest,
    {distance: Number.POSITIVE_INFINITY, index: 0},
  );
  slots.splice(centerSlot.index, 1);
  slots.sort(
    (left, right) => Math.hypot(left.x, left.y) - Math.hypot(right.x, right.y) || left.y - right.y || left.x - right.x,
  );
  for (const [index, node] of animatedNeighbors.entries()) {
    const slot = slots[index] ?? {x: 0, y: 0};
    node.x = selectedNode.x + slot.x;
    node.y = selectedNode.y + slot.y;
    node.anchorX = node.x;
    node.anchorY = node.y;
    let deltaX = slot.x;
    let deltaY = slot.y;
    let distance = Math.hypot(deltaX, deltaY);
    const minimumDistance = (selectedNode.radius * 1.25 + node.radius * 1.25 + 22) / safeZoom;
    if (distance < 0.001) {
      const angle = (Math.abs(hashString(node.id)) % 6283) / 1000 + index * 2.399963;
      deltaX = Math.cos(angle);
      deltaY = Math.sin(angle);
      distance = 1;
    }
    if (distance < minimumDistance) {
      node.x = selectedNode.x + (deltaX / distance) * minimumDistance;
      node.y = selectedNode.y + (deltaY / distance) * minimumDistance;
    }
  }

  // Preserve the full relaxation pass for ordinary neighborhoods while bounding
  // maximum-cardinality focus work. Dense graphs benefit more from responsive
  // interaction than from repeatedly refining already-overlapping offscreen labels.
  const collisionIterations = Math.max(10, Math.min(18, Math.floor(5_000 / focusNodes.length)));
  const movableFocusNodes = focusNodes.filter(node => !node.fixed);
  for (let iteration = 0; iteration < collisionIterations; iteration += 1) {
    for (const node of movableFocusNodes) {
      node.x += (node.anchorX - node.x) * 0.006;
      node.y += (node.anchorY - node.y) * 0.006;
    }
    for (const [leftIndex, rightIndex] of focusCollisionPairs(focusNodes, labelSizes, safeZoom)) {
      separateFocusNodes(focusNodes[leftIndex]!, focusNodes[rightIndex]!, labelSizes, safeZoom);
    }
    for (const node of animatedNeighbors) {
      const deltaX = node.x - selectedNode.x;
      const deltaY = node.y - selectedNode.y;
      const distance = Math.max(0.001, Math.hypot(deltaX, deltaY));
      const minimumDistance = (selectedNode.radius * 1.25 + node.radius * 1.25 + 22) / safeZoom;
      if (distance < minimumDistance) {
        node.x = selectedNode.x + (deltaX / distance) * minimumDistance;
        node.y = selectedNode.y + (deltaY / distance) * minimumDistance;
      }
    }
  }
  return new Map(focusNodes.map(node => [node.id, {x: node.x, y: node.y}]));
}

function focusCollisionPairs(
  nodes: readonly {
    readonly fixed: boolean;
    readonly highlighted: boolean;
    readonly id: string;
    readonly label: string;
    readonly radius: number;
    readonly x: number;
    readonly y: number;
  }[],
  labelSizes: ReadonlyMap<string, {readonly height: number; readonly width: number}>,
  zoom: number,
): readonly (readonly [number, number])[] {
  const bounds = nodes
    .map((node, index) => {
      const boxes = focusNodeBoxes(node, labelSizes.get(node.id), zoom, node.fixed);
      return {
        bottom: Math.max(...boxes.map(box => box.bottom)),
        highlighted: node.highlighted,
        index,
        left: Math.min(...boxes.map(box => box.left)),
        right: Math.max(...boxes.map(box => box.right)),
        top: Math.min(...boxes.map(box => box.top)),
      };
    })
    .sort((left, right) => left.left - right.left || left.index - right.index);
  const pairs: Array<readonly [number, number]> = [];
  for (const [leftPosition, left] of bounds.entries()) {
    for (let rightPosition = leftPosition + 1; rightPosition < bounds.length; rightPosition += 1) {
      const right = bounds[rightPosition]!;
      if (right.left >= left.right) break;
      if (!left.highlighted && !right.highlighted) continue;
      if (Math.min(left.bottom, right.bottom) <= Math.max(left.top, right.top)) continue;
      pairs.push([left.index, right.index]);
    }
  }
  return pairs;
}

function separateFocusNodes(
  left: {
    readonly fixed: boolean;
    readonly id: string;
    readonly label: string;
    readonly radius: number;
    x: number;
    y: number;
  },
  right: {
    readonly fixed: boolean;
    readonly id: string;
    readonly label: string;
    readonly radius: number;
    x: number;
    y: number;
  },
  labelSizes: ReadonlyMap<string, {readonly height: number; readonly width: number}>,
  zoom: number,
): void {
  const leftBoxes = focusNodeBoxes(left, labelSizes.get(left.id), zoom, left.fixed);
  const rightBoxes = focusNodeBoxes(right, labelSizes.get(right.id), zoom, right.fixed);
  for (const leftBox of leftBoxes) {
    for (const rightBox of rightBoxes) {
      const overlapX = Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left);
      const overlapY = Math.min(leftBox.bottom, rightBox.bottom) - Math.max(leftBox.top, rightBox.top);
      if (overlapX <= 0 || overlapY <= 0) continue;
      const leftCenterX = (leftBox.left + leftBox.right) / 2;
      const leftCenterY = (leftBox.top + leftBox.bottom) / 2;
      const rightCenterX = (rightBox.left + rightBox.right) / 2;
      const rightCenterY = (rightBox.top + rightBox.bottom) / 2;
      const fallback = hashString(`${left.id}:${right.id}`);
      if (overlapX < overlapY) {
        const direction =
          leftCenterX === rightCenterX ? (fallback % 2 === 0 ? -1 : 1) : Math.sign(leftCenterX - rightCenterX);
        moveFocusPair(left, right, direction * (overlapX + 2 / zoom), 0);
      } else {
        const direction =
          leftCenterY === rightCenterY ? (fallback % 2 === 0 ? -1 : 1) : Math.sign(leftCenterY - rightCenterY);
        moveFocusPair(left, right, 0, direction * (overlapY + 2 / zoom));
      }
    }
  }
}

function moveFocusPair(
  left: {readonly fixed: boolean; x: number; y: number},
  right: {readonly fixed: boolean; x: number; y: number},
  deltaX: number,
  deltaY: number,
): void {
  if (left.fixed && right.fixed) return;
  if (left.fixed) {
    right.x -= deltaX;
    right.y -= deltaY;
    return;
  }
  if (right.fixed) {
    left.x += deltaX;
    left.y += deltaY;
    return;
  }
  left.x += deltaX / 2;
  left.y += deltaY / 2;
  right.x -= deltaX / 2;
  right.y -= deltaY / 2;
}

function focusNodeBoxes(
  node: {readonly label: string; readonly radius: number; readonly x: number; readonly y: number},
  measured: {readonly height: number; readonly width: number} | undefined,
  zoom: number,
  selected: boolean,
): readonly {readonly bottom: number; readonly left: number; readonly right: number; readonly top: number}[] {
  const nodeHalfSize = (node.radius * 1.25 + 4) / zoom;
  const estimatedWidth = Math.min(selected ? 300 : 220, Math.max(28, node.label.length * 6.2 + (selected ? 14 : 0)));
  const labelWidth = (measured?.width ?? estimatedWidth) / zoom;
  const labelHeight = (measured?.height ?? (selected ? 22 : 14)) / zoom;
  const labelLeft = node.x + (node.radius + 4) / zoom;
  const margin = 3 / zoom;
  const nodeBox = {
    bottom: node.y + nodeHalfSize + margin,
    left: node.x - nodeHalfSize - margin,
    right: node.x + nodeHalfSize + margin,
    top: node.y - nodeHalfSize - margin,
  };
  if (!measured && !selected) return [nodeBox];
  return [
    nodeBox,
    {
      bottom: node.y + labelHeight / 2 + margin,
      left: labelLeft - margin,
      right: labelLeft + labelWidth + margin,
      top: node.y - labelHeight / 2 - margin,
    },
  ];
}

function overviewLayout(nodes: readonly GraphNode[]): readonly PositionedNode[] {
  const ordered = [...nodes].sort(
    (left, right) =>
      (right.symbolCount ?? right.degree) - (left.symbolCount ?? left.degree) ||
      compareCodeUnits(left.label, right.label),
  );
  return ordered.map((node, index) => {
    const angle = index * 2.399963;
    const ring = index === 0 ? 0 : 78 + Math.sqrt(index) * 84;
    return positionNode(node, Math.cos(angle) * ring, Math.sin(angle) * ring, index);
  });
}

function detailLayout(nodes: readonly GraphNode[], sizeValues: ReadonlyMap<string, number>): readonly PositionedNode[] {
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const group = graphGroup(node);
    const items = groups.get(group) ?? [];
    items.push(node);
    groups.set(group, items);
  }
  const orderedGroups = [...groups].sort(
    ([leftName, left], [rightName, right]) => right.length - left.length || compareCodeUnits(leftName, rightName),
  );
  const output: PositionedNode[] = [];
  for (const [groupIndex, [, items]] of orderedGroups.entries()) {
    const groupAngle = groupIndex * 2.399963;
    const groupRadius = orderedGroups.length === 1 ? 0 : 120 + Math.sqrt(groupIndex) * 135;
    const centerX = Math.cos(groupAngle) * groupRadius;
    const centerY = Math.sin(groupAngle) * groupRadius;
    const ordered = [...items].sort(
      (left, right) => right.degree - left.degree || compareCodeUnits(left.label, right.label),
    );
    for (const [itemIndex, node] of ordered.entries()) {
      const angle = itemIndex * 2.399963 + groupAngle;
      const radius = itemIndex === 0 ? 0 : 17 * Math.sqrt(itemIndex);
      output.push(
        positionNode(
          node,
          centerX + Math.cos(angle) * radius,
          centerY + Math.sin(angle) * radius,
          groupIndex,
          sizeValues.get(node.id) ?? 0,
        ),
      );
    }
  }
  return output;
}

function positionNode(
  node: GraphNode,
  x: number,
  y: number,
  colorIndex: number,
  sizeValue = node.degree,
): PositionedNode {
  const radius =
    node.type === 'project'
      ? 8 + Math.min(14, Math.sqrt(Math.max(1, Math.log2((node.symbolCount ?? sizeValue) + 1))) * 3)
      : 4 + Math.min(11, Math.log2(Math.max(0, sizeValue) + 1) * 2);
  return {
    ...node,
    color: new THREE.Color(colorForNode(node, colorIndex)),
    radius,
    x,
    y,
  };
}

export function graphNodeSizeValues(
  edges: readonly Pick<GraphEdge, 'sourceId' | 'targetId'>[],
  metric: GraphSizeMetric,
): ReadonlyMap<string, number> {
  const connected = new Map<string, Set<string>>();
  const add = (nodeId: string, neighborId: string): void => {
    const neighbors = connected.get(nodeId) ?? new Set<string>();
    neighbors.add(neighborId);
    connected.set(nodeId, neighbors);
  };
  for (const edge of edges) {
    if (edge.sourceId === edge.targetId) continue;
    if (metric !== 'incoming') add(edge.sourceId, edge.targetId);
    if (metric !== 'outgoing') add(edge.targetId, edge.sourceId);
  }
  return new Map([...connected].map(([nodeId, neighbors]) => [nodeId, neighbors.size]));
}

function colorForNode(node: GraphNode, fallbackIndex: number): string {
  if (node.type === 'project') return GRAPH_PALETTE[fallbackIndex % GRAPH_PALETTE.length]!;
  const key = node.projectId || node.kind;
  return GRAPH_PALETTE[Math.abs(hashString(key)) % GRAPH_PALETTE.length]!;
}

function graphGroup(node: GraphNode): string {
  if (!node.path) return node.projectId;
  const parts = node.path.split('/');
  return parts.slice(0, Math.min(2, Math.max(1, parts.length - 1))).join('/');
}

function fittedView(layout: GraphLayout, size: {readonly height: number; readonly width: number}): ViewState {
  const padding = 1.12;
  const zoom = Math.min(
    1.6,
    Math.max(
      MIN_ZOOM,
      Math.min(size.width / (layout.bounds.width * padding), size.height / (layout.bounds.height * padding)),
    ),
  );
  return {x: 0, y: 0, zoom: Number.isFinite(zoom) ? zoom : 1};
}

export function graphFocusTarget(
  current: ViewState,
  node: {readonly x: number; readonly y: number},
  mode: GraphVisualization['mode'],
): ViewState {
  const targetZoom = SEARCH_FOCUS_ZOOM[mode];
  const currentZoom = Number.isFinite(current.zoom) ? current.zoom : targetZoom;
  return {
    x: Number.isFinite(node.x) ? node.x : Number.isFinite(current.x) ? current.x : 0,
    y: Number.isFinite(node.y) ? node.y : Number.isFinite(current.y) ? current.y : 0,
    zoom: Math.min(targetZoom * 1.35, Math.max(currentZoom, targetZoom)),
  };
}

export function graphWheelZoomFactor(deltaY: number): number {
  if (Number.isNaN(deltaY)) return 1;
  return Math.max(0.72, Math.min(1.38, Math.exp(-deltaY * 0.0012)));
}

function updateCamera(
  camera: THREE.OrthographicCamera,
  view: ViewState,
  size: {readonly height: number; readonly width: number},
): void {
  camera.left = -size.width / 2 / view.zoom;
  camera.right = size.width / 2 / view.zoom;
  camera.top = size.height / 2 / view.zoom;
  camera.bottom = -size.height / 2 / view.zoom;
  camera.near = 0.1;
  camera.far = 200;
  camera.position.set(view.x, view.y, 100);
  camera.updateProjectionMatrix();
}

function graphPosition(
  node: {readonly id: string; readonly x: number; readonly y: number},
  positions?: ReadonlyMap<string, GraphPosition>,
): GraphPosition {
  return positions?.get(node.id) ?? node;
}

function applyGraphPositions(
  runtime: GraphRuntime | undefined,
  positions: ReadonlyMap<string, GraphPosition>,
  layout: GraphLayout,
  size: {readonly height: number; readonly width: number},
  view: ViewState,
  labelElements: ReadonlyMap<string, HTMLSpanElement>,
): void {
  if (runtime) {
    for (const [index, nodeId] of runtime.nodeIds.entries()) {
      const node = layout.nodesById.get(nodeId);
      if (!node) continue;
      const position = graphPosition(node, positions);
      runtime.nodePosition.setXYZ(index, position.x, position.y, 1);
    }
    runtime.nodePosition.needsUpdate = true;
    for (const [index, edge] of runtime.edges.entries()) {
      const source = layout.nodesById.get(edge.sourceId);
      const target = layout.nodesById.get(edge.targetId);
      if (!source || !target) continue;
      const sourcePosition = graphPosition(source, positions);
      const targetPosition = graphPosition(target, positions);
      runtime.edgePosition.setXYZ(index * 2, sourcePosition.x, sourcePosition.y, 0);
      runtime.edgePosition.setXYZ(index * 2 + 1, targetPosition.x, targetPosition.y, 0);
    }
    runtime.edgePosition.needsUpdate = true;
    if (runtime.highlightPosition) {
      const highlightPositions = directionalEdgePositions(runtime.highlightedEdges, layout.nodesById, positions);
      if (highlightPositions.length === runtime.highlightPosition.array.length) {
        runtime.highlightPosition.array.set(highlightPositions);
        runtime.highlightPosition.needsUpdate = true;
      }
    }
    if (runtime.selectedNodeId && runtime.selectedPosition) {
      const selectedNode = layout.nodesById.get(runtime.selectedNodeId);
      if (selectedNode) {
        const selectedPosition = graphPosition(selectedNode, positions);
        runtime.selectedPosition.setXYZ(0, selectedPosition.x, selectedPosition.y, 2);
        runtime.selectedPosition.needsUpdate = true;
      }
    }
  }

  for (const [nodeId, element] of labelElements) {
    const node = layout.nodesById.get(nodeId);
    if (!node) continue;
    const position = graphPosition(node, positions);
    const x = size.width / 2 + (position.x - view.x) * view.zoom;
    const y = size.height / 2 - (position.y - view.y) * view.zoom;
    element.style.left = `${x + node.radius + 4}px`;
    element.style.top = `${y}px`;
  }
  if (runtime) runtime.renderer.render(runtime.scene, runtime.camera);
}

function zoomViewAt(
  view: ViewState,
  factor: number,
  screenX: number,
  screenY: number,
  size: {readonly height: number; readonly width: number},
): ViewState {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * factor));
  const dx = screenX - size.width / 2;
  const dy = screenY - size.height / 2;
  const worldX = view.x + dx / view.zoom;
  const worldY = view.y - dy / view.zoom;
  return {x: worldX - dx / zoom, y: worldY + dy / zoom, zoom};
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException
    ? cause.name === 'AbortError'
    : cause instanceof Error && cause.name === 'AbortError';
}

function nearestNode(
  layout: GraphLayout,
  view: ViewState,
  size: {readonly height: number; readonly width: number},
  screenX: number,
  screenY: number,
  positions?: ReadonlyMap<string, GraphPosition>,
): PositionedNode | undefined {
  const worldX = view.x + (screenX - size.width / 2) / view.zoom;
  const worldY = view.y - (screenY - size.height / 2) / view.zoom;
  let selected: PositionedNode | undefined;
  let selectedDistance = Number.POSITIVE_INFINITY;
  for (const node of layout.nodes) {
    const position = graphPosition(node, positions);
    const distance = Math.hypot(position.x - worldX, position.y - worldY);
    const hitRadius = Math.max(node.radius * 1.45, 10 / view.zoom);
    if (distance <= hitRadius && distance < selectedDistance) {
      selected = node;
      selectedDistance = distance;
    }
  }
  return selected;
}

function visibleLabels(
  layout: GraphLayout,
  mode: GraphVisualization['mode'],
  size: {readonly height: number; readonly width: number},
  view: ViewState,
  selectedNodeId?: string,
  activeNodeIds?: ReadonlySet<string>,
  highlightedNodeIds?: ReadonlySet<string>,
  positions?: ReadonlyMap<string, GraphPosition>,
): readonly {readonly node: PositionedNode; readonly x: number; readonly y: number}[] {
  const baseMaximum =
    mode === 'overview'
      ? view.zoom < 0.65
        ? 18
        : 80
      : view.zoom < 0.75
        ? 8
        : view.zoom < 1.45
          ? 24
          : view.zoom < 3
            ? 72
            : 180;
  const highlightedMaximum =
    view.zoom < 0.75
      ? 0
      : view.zoom < 1.45
        ? Math.min(24, highlightedNodeIds?.size ?? 0)
        : Math.min(MAX_FOCUSED_LABELS + 1, highlightedNodeIds?.size ?? 0);
  const maximum = Math.max(baseMaximum, highlightedMaximum);
  let focusedLabelCount = 0;
  return [...layout.nodes]
    .filter(node => !activeNodeIds || activeNodeIds.has(node.id))
    .flatMap(node => {
      const position = graphPosition(node, positions);
      const x = size.width / 2 + (position.x - view.x) * view.zoom;
      const y = size.height / 2 - (position.y - view.y) * view.zoom;
      return x < -80 || x > size.width + 80 || y < -30 || y > size.height + 30 ? [] : [{node, x, y}];
    })
    .sort((left, right) => {
      if (left.node.id === selectedNodeId) return -1;
      if (right.node.id === selectedNodeId) return 1;
      if (highlightedNodeIds?.has(left.node.id) && !highlightedNodeIds.has(right.node.id)) return -1;
      if (highlightedNodeIds?.has(right.node.id) && !highlightedNodeIds.has(left.node.id)) return 1;
      return (
        right.node.degree - left.node.degree ||
        right.node.radius - left.node.radius ||
        compareCodeUnits(left.node.label, right.node.label)
      );
    })
    .filter(({node}) => {
      if (node.id === selectedNodeId || !highlightedNodeIds?.has(node.id)) return true;
      focusedLabelCount += 1;
      return focusedLabelCount <= MAX_FOCUSED_LABELS;
    })
    .map(({node, x, y}) => ({node, x: x + node.radius + 4, y}))
    .slice(0, maximum);
}

function directionalEdgePositions(
  edges: readonly GraphEdge[],
  nodesById: ReadonlyMap<string, PositionedNode>,
  positionOverrides?: ReadonlyMap<string, GraphPosition>,
): readonly number[] {
  const positions: number[] = [];
  for (const edge of edges.slice(0, MAX_ANIMATED_NEIGHBOR_EDGES)) {
    const source = nodesById.get(edge.sourceId);
    const target = nodesById.get(edge.targetId);
    if (!source || !target) continue;
    const sourcePosition = graphPosition(source, positionOverrides);
    const targetPosition = graphPosition(target, positionOverrides);
    let dx = targetPosition.x - sourcePosition.x;
    let dy = targetPosition.y - sourcePosition.y;
    let length = Math.hypot(dx, dy);
    if (length < 0.001) {
      const angle = (Math.abs(hashString(edge.id)) % 6283) / 1000;
      dx = Math.cos(angle) * 0.001;
      dy = Math.sin(angle) * 0.001;
      length = 0.001;
    }
    const unitX = dx / length;
    const unitY = dy / length;
    const tipX = targetPosition.x - unitX * (target.radius + 2);
    const tipY = targetPosition.y - unitY * (target.radius + 2);
    const arrowLength = Math.min(8, Math.max(4, length * 0.16));
    const wingX = tipX - unitX * arrowLength;
    const wingY = tipY - unitY * arrowLength;
    const normalX = -unitY * arrowLength * 0.55;
    const normalY = unitX * arrowLength * 0.55;
    positions.push(
      sourcePosition.x,
      sourcePosition.y,
      1.5,
      tipX,
      tipY,
      1.5,
      tipX,
      tipY,
      1.5,
      wingX + normalX,
      wingY + normalY,
      1.5,
      tipX,
      tipY,
      1.5,
      wingX - normalX,
      wingY - normalY,
      1.5,
    );
  }
  return positions;
}

function graphPointMaterial(scale: number, zoom: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        vec2 point = gl_PointCoord - vec2(0.5);
        float distanceToCenter = length(point);
        if (distanceToCenter > 0.5) discard;
        float glow = smoothstep(0.5, 0.05, distanceToCenter);
        float core = smoothstep(0.24, 0.05, distanceToCenter);
        gl_FragColor = vec4(vColor + core * 0.32, glow * 0.94);
      }
    `,
    transparent: true,
    uniforms: {
      viewScale: {value: graphPointViewScale(zoom)},
    },
    vertexColors: true,
    vertexShader: `
      attribute float pointSize;
      uniform float viewScale;
      varying vec3 vColor;
      void main() {
        vColor = color;
        gl_PointSize = max(3.0, pointSize * ${scale.toFixed(2)} * viewScale);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
  });
}

function graphPointViewScale(zoom: number): number {
  return Math.min(1.25, Math.max(0.32, zoom * 0.75));
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {maximumFractionDigits: 1, notation: 'compact'}).format(value);
}

function graphProjectBadge(project: GraphProject): string {
  if (project.model === 'legacy-fallback') return 'legacy group';
  if (project.model === 'facet') return 'facet';
  return project.buildSystem ? `${project.buildSystem} ${project.kind ?? 'component'}` : (project.kind ?? 'component');
}

function relationLabel(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function sizeMetricLabel(metric: GraphSizeMetric): string {
  switch (metric) {
    case 'incoming':
      return 'Distinct incoming neighbors';
    case 'outgoing':
      return 'Distinct outgoing neighbors';
    default:
      return 'Distinct connections';
  }
}

function sourceBreadcrumb(projectId: string, path: string): readonly string[] {
  const project = projectId.replace(/^[^:]+:/, '');
  const parts = path.split('/').filter(Boolean);
  const compactPath = parts.length > 4 ? [...parts.slice(0, 2), '…', ...parts.slice(-2)] : parts;
  return [project, ...compactPath.filter((part, index) => index > 0 || part !== project)];
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}
