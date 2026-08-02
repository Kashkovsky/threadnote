import {Effect, Option, Path} from 'effect';
import {codeGraphDatabasePaths} from './maintenance.js';
import {compareCodeUnits} from './ordering.js';
import {
  CodeGraphStore,
  type CodeGraphStoreShape,
  type CodeGraphVisualizationCatalog,
  type CodeGraphVisualizationProject,
  type CodeGraphVisualizationScope,
  type CodeGraphVisualizationScopeEdge,
} from './store.js';
import type {CodeGraphEdge, CodeGraphProvenance, CodeGraphSnapshot, CodeGraphSpan, CodeGraphSymbol} from './types.js';
import {CodeGraphAnalysis} from './analysis.js';
import {codeGraphAnalysisLimitsForView} from './analysis_render.js';
import {
  readAllCodeGraphBuildStatuses,
  selectCodeGraphBuildStatuses,
  type ObservedCodeGraphBuildStatus,
} from './build_status.js';
import {
  managerGraphVisualizationLimits,
  type ManagerGraphVisualizationBudget,
  type ManagerGraphVisualizationLimits,
} from '../manager_graph_limits.js';

const NODE_DETAIL_EDGE_LIMIT = 160;
const NODE_DETAIL_SUMMARY_LIMIT = 2_000;
const MANAGER_CATALOG_PROJECT_LIMIT = 160;
const MANAGER_OVERVIEW_PROJECT_LIMIT = 500;
const MANAGER_CATALOG_WORKSPACE_LIMIT = 64;
const MANAGER_CATALOG_SNAPSHOT_LEASE_MILLISECONDS = 60 * 60_000;
const MANAGER_CATALOG_SNAPSHOT_RENEW_MILLISECONDS = MANAGER_CATALOG_SNAPSHOT_LEASE_MILLISECONDS / 2;
const managerSnapshotLeases = new Map<string, {readonly renewAfter: number; readonly token: string}>();
const INDEXED_VIEW_ID = /^[0-9a-f]{64}(?:\.[0-9a-f]{64})?$/;
const NODE_ID_MAX_LENGTH = 512;
const NODE_DETAIL_PROVENANCES: readonly CodeGraphProvenance[] = [
  'declared',
  'resolved',
  'syntactic',
  'heuristic',
  'model',
];

export interface ManagerGraphRepository {
  readonly displayName: string;
  readonly id: string;
  readonly defaultViewId: string;
  readonly repositoryId: string;
  readonly views: readonly ManagerGraphIndexedView[];
}

export interface ManagerGraphIndexedView {
  readonly accounting: CodeGraphVisualizationCatalog['accounting'];
  readonly activatedAt?: string;
  readonly checkoutId: string;
  readonly displayName: string;
  readonly id: string;
  readonly label: string;
  readonly metrics: CodeGraphVisualizationCatalog['metrics'];
  readonly model: CodeGraphVisualizationCatalog['model'];
  readonly projects: readonly {
    readonly buildSystem?: string;
    readonly fileCount?: number;
    readonly id: string;
    readonly kind?: string;
    readonly label: string;
    readonly model: CodeGraphVisualizationProject['model'];
    readonly provenance: string;
    readonly symbolCount?: number;
    readonly workspaceId?: string;
  }[];
  readonly projectCount: number;
  readonly projectsTruncated: boolean;
  readonly snapshot: CodeGraphSnapshot;
  readonly worktreeId: string;
  readonly workspaces: readonly {
    readonly buildSystem: string;
    readonly id: string;
    readonly name: string;
    readonly root: string;
  }[];
  readonly workspaceCount: number;
  readonly workspacesTruncated: boolean;
}

export interface ManagerGraphCatalogDiagnostic {
  readonly checkoutId: string;
  readonly code: 'no-ready-snapshot' | 'unreadable-database';
  readonly message: string;
}

export interface ManagerGraphCatalog {
  readonly builds: readonly ObservedCodeGraphBuildStatus[];
  readonly diagnostics: readonly ManagerGraphCatalogDiagnostic[];
  readonly repositories: readonly ManagerGraphRepository[];
  readonly waiterCount: number;
  readonly waiters: readonly ObservedCodeGraphBuildStatus[];
}

export interface ManagerGraphBuildCatalog {
  readonly builds: readonly ObservedCodeGraphBuildStatus[];
  readonly queuedWorktreeIds: readonly string[];
  readonly waiterCount: number;
  readonly waiters: readonly ObservedCodeGraphBuildStatus[];
}

export interface ManagerGraphNode {
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

export interface ManagerGraphEdge {
  readonly confidence: number;
  readonly count: number;
  readonly id: string;
  readonly provenance:
    CodeGraphEdge['provenance'] | CodeGraphVisualizationProject['dependencies'][number]['provenance'] | 'aggregate';
  readonly relation: CodeGraphEdge['relation'] | 'cross-project';
  readonly sourceId: string;
  readonly targetId: string;
}

export interface ManagerGraphVisualization {
  readonly edges: readonly ManagerGraphEdge[];
  readonly mode: 'detail' | 'overview';
  readonly nodes: readonly ManagerGraphNode[];
  readonly paging: {
    readonly edgeLimit: number;
    readonly hasMore: boolean;
    readonly nodeLimit: number;
  };
  readonly projectId: string;
  readonly repository: {
    readonly accounting: CodeGraphVisualizationCatalog['accounting'];
    readonly displayName: string;
    readonly id: string;
    readonly metrics: CodeGraphVisualizationCatalog['metrics'];
    readonly snapshot: CodeGraphSnapshot;
  };
  readonly scope: {readonly id: string; readonly label: string};
  readonly stats: {
    readonly renderedEdges: number;
    readonly renderedNodes: number;
    readonly totalEdges: number;
    readonly totalNodes: number;
  };
  readonly warnings: readonly string[];
}

export interface ManagerGraphNodeDetail {
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
    readonly span: CodeGraphSpan;
  };
  readonly relationships: readonly {
    readonly confidence: number;
    readonly direction: 'incoming' | 'outgoing';
    readonly evidencePath: string;
    readonly evidenceSpan: CodeGraphSpan;
    readonly id: string;
    readonly provenance: CodeGraphEdge['provenance'];
    readonly related: {
      readonly id?: string;
      readonly kind?: string;
      readonly label: string;
      readonly path?: string;
      readonly projectId?: string;
      readonly qualifiedName?: string;
    };
    readonly relation: CodeGraphEdge['relation'];
  }[];
  readonly snapshotId: string;
  readonly stats: {
    readonly incoming: number;
    readonly outgoing: number;
    readonly provenances: readonly {
      readonly count: number;
      readonly provenance: CodeGraphEdge['provenance'];
    }[];
    readonly relations: readonly {
      readonly count: number;
      readonly incoming: number;
      readonly outgoing: number;
      readonly relation: CodeGraphEdge['relation'];
    }[];
    readonly truncated: boolean;
  };
}

export const managerGraphCatalog = Effect.fn('codeGraph.managerCatalog')(function* (threadnoteHome: string) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const buildSelection = selectCodeGraphBuildStatuses(yield* readAllCodeGraphBuildStatuses(threadnoteHome));
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const entries = yield* Effect.forEach(
    databases,
    database => {
      const checkoutId = path.basename(path.dirname(database));
      return store
        .loadVisualizationCatalogs(database, 'deferred', {
          includeDependencies: false,
          projectLimit: MANAGER_CATALOG_PROJECT_LIMIT,
          workspaceLimit: MANAGER_CATALOG_WORKSPACE_LIMIT,
        })
        .pipe(
          Effect.tap(catalogs =>
            Effect.forEach(catalogs, catalog => retainManagerSnapshot(store, database, catalog.snapshot.id), {
              concurrency: 1,
              discard: true,
            }),
          ),
          Effect.map(catalogs =>
            catalogs.length > 0
              ? ({checkoutId, catalogs} as const)
              : ({
                  diagnostic: {
                    checkoutId,
                    code: 'no-ready-snapshot',
                    message: `Checkout ${shortIdentity(checkoutId)} has no ready graph snapshot.`,
                  } satisfies ManagerGraphCatalogDiagnostic,
                } as const),
          ),
          Effect.catchCause(cause =>
            Effect.succeed({
              diagnostic: {
                checkoutId,
                code: 'unreadable-database',
                message: `Checkout ${shortIdentity(checkoutId)} graph database is unreadable: ${privacySafeCatalogError(cause)}`,
              } satisfies ManagerGraphCatalogDiagnostic,
            } as const),
          ),
        );
    },
    {concurrency: 2},
  );
  const catalogEntries: Array<{catalog: CodeGraphVisualizationCatalog; checkoutId: string}> = [];
  const diagnostics: ManagerGraphCatalogDiagnostic[] = [];
  for (const entry of entries) {
    if ('catalogs' in entry && entry.catalogs) {
      catalogEntries.push(...entry.catalogs.map(catalog => ({catalog, checkoutId: entry.checkoutId})));
    }
    if ('diagnostic' in entry && entry.diagnostic) diagnostics.push(entry.diagnostic);
  }
  return {
    builds: buildSelection.builds,
    diagnostics,
    repositories: groupManagerGraphRepositories(catalogEntries),
    waiterCount: buildSelection.waiters.length,
    waiters: buildSelection.waiters,
  } satisfies ManagerGraphCatalog;
});

const retainManagerSnapshot = Effect.fn('codeGraph.retainManagerSnapshot')(function* (
  store: CodeGraphStoreShape,
  database: string,
  snapshotId: string,
) {
  const key = `${database}\0${snapshotId}`;
  const existing = managerSnapshotLeases.get(key);
  const now = Date.now();
  if (existing && existing.renewAfter > now) return;
  if (existing) {
    const renewed = yield* store
      .renewSnapshotLease(database, existing.token, MANAGER_CATALOG_SNAPSHOT_LEASE_MILLISECONDS)
      .pipe(Effect.match({onFailure: () => false, onSuccess: () => true}));
    if (renewed) {
      managerSnapshotLeases.set(key, {
        renewAfter: now + MANAGER_CATALOG_SNAPSHOT_RENEW_MILLISECONDS,
        token: existing.token,
      });
      return;
    }
  }
  const token = yield* store.acquireSnapshotLease(database, snapshotId, MANAGER_CATALOG_SNAPSHOT_LEASE_MILLISECONDS);
  managerSnapshotLeases.set(key, {renewAfter: now + MANAGER_CATALOG_SNAPSHOT_RENEW_MILLISECONDS, token});
});

export function groupManagerGraphRepositories(
  entries: readonly {readonly catalog: CodeGraphVisualizationCatalog; readonly checkoutId: string}[],
): readonly ManagerGraphRepository[] {
  const groups = new Map<string, {displayName: string; views: ManagerGraphIndexedView[]}>();
  for (const entry of entries) {
    const repositoryId = entry.catalog.repository.repositoryId;
    const group = groups.get(repositoryId) ?? {displayName: entry.catalog.repository.displayName, views: []};
    group.views.push(repositoryFromCatalog(entry.checkoutId, entry.catalog));
    groups.set(repositoryId, group);
  }
  return [...groups]
    .map(([repositoryId, group]) => {
      const views = group.views.sort(compareIndexedViews);
      return {
        defaultViewId: views[0]!.id,
        displayName: group.displayName,
        id: repositoryId,
        repositoryId,
        views,
      } satisfies ManagerGraphRepository;
    })
    .sort(
      (left, right) =>
        compareCodeUnits(left.displayName, right.displayName) ||
        compareCodeUnits(left.repositoryId, right.repositoryId),
    );
}

export const managerGraphBuildCatalog = Effect.fn('codeGraph.managerBuildCatalog')(function* (threadnoteHome: string) {
  const selection = selectCodeGraphBuildStatuses(yield* readAllCodeGraphBuildStatuses(threadnoteHome));
  return {
    builds: selection.builds,
    queuedWorktreeIds: [...new Set(selection.waiters.map(status => status.identity.worktreeId))],
    waiterCount: selection.waiters.length,
    waiters: selection.waiters,
  } satisfies ManagerGraphBuildCatalog;
});

export const managerGraphAnalysis = Effect.fn('codeGraph.managerAnalysis')(function* (
  threadnoteHome: string,
  indexedViewId: string,
  expectedSnapshotId: Option.Option<string> = Option.none(),
) {
  if (!INDEXED_VIEW_ID.test(indexedViewId)) return yield* Effect.fail(new Error('Graph view identity is invalid.'));
  const analysis = yield* CodeGraphAnalysis;
  const {catalog, database} = yield* resolveManagerGraphView(threadnoteHome, indexedViewId, {
    expectedSnapshotId,
    includeDependencies: false,
    projectLimit: 1,
  });
  return yield* analysis.analyze({
    budget: {maxDurationMilliseconds: 20_000},
    databasePath: database,
    limits: codeGraphAnalysisLimitsForView('full'),
    snapshot: catalog.snapshot,
  });
});

export const managerGraphVisualization = Effect.fn('codeGraph.managerVisualization')(function* (
  threadnoteHome: string,
  indexedViewId: string,
  requestedProjectId: string,
  requestedBudget: ManagerGraphVisualizationBudget = {},
  expectedSnapshotId: Option.Option<string> = Option.none(),
) {
  if (!INDEXED_VIEW_ID.test(indexedViewId)) return yield* Effect.fail(new Error('Graph view identity is invalid.'));
  const store = yield* CodeGraphStore;
  const projectId = requestedProjectId.trim() || 'all';
  const {catalog, checkoutId, database} = yield* resolveManagerGraphView(threadnoteHome, indexedViewId, {
    expectedSnapshotId,
    includeDependencies: projectId === 'all',
    projectId: projectId === 'all' ? Option.none() : Option.some(projectId),
    projectLimit: projectId === 'all' ? MANAGER_OVERVIEW_PROJECT_LIMIT : 1,
  });
  const repository = repositoryFromCatalog(checkoutId, catalog);
  const limits = managerGraphVisualizationLimits(requestedBudget);
  if (projectId === 'all') {
    return yield* overviewVisualization(store, database, repository, catalog, limits);
  }
  const project = catalog.projects.find(candidate => candidate.id === projectId);
  if (!project) return yield* Effect.fail(new Error('Indexed graph project was not found.'));
  return yield* detailVisualization(store, database, repository, project, limits);
});

export const managerGraphNodeDetail = Effect.fn('codeGraph.managerNodeDetail')(function* (
  threadnoteHome: string,
  indexedViewId: string,
  requestedNodeId: string,
  expectedSnapshotId: Option.Option<string> = Option.none(),
) {
  if (!INDEXED_VIEW_ID.test(indexedViewId)) return yield* Effect.fail(new Error('Graph view identity is invalid.'));
  const nodeId = requestedNodeId.trim();
  if (nodeId.length === 0 || nodeId.length > NODE_ID_MAX_LENGTH) {
    return yield* Effect.fail(new Error('Graph node identity is invalid.'));
  }
  const store = yield* CodeGraphStore;
  const {catalog, database} = yield* resolveManagerGraphView(threadnoteHome, indexedViewId, {
    expectedSnapshotId,
    includeDependencies: false,
    projectLimit: 1,
  });
  const symbols = yield* store.symbolsByIds(database, catalog.snapshot.id, [nodeId]);
  const symbol = symbols.find(candidate => candidate.id === nodeId);
  if (!symbol) return yield* Effect.fail(new Error('Indexed graph node was not found.'));

  const [edges, summary] = yield* Effect.all([
    store.edgesForNodes(
      database,
      catalog.snapshot.id,
      [nodeId],
      'both',
      NODE_DETAIL_EDGE_LIMIT,
      NODE_DETAIL_PROVENANCES,
    ),
    store.relationshipSummaryForNode(
      database,
      catalog.snapshot.id,
      nodeId,
      NODE_DETAIL_PROVENANCES,
      NODE_DETAIL_SUMMARY_LIMIT,
    ),
  ]);
  const relatedIds = [
    ...new Set(edges.map(edge => (edge.sourceId === nodeId ? edge.targetId : edge.sourceId)).filter(isString)),
  ];
  const relatedSymbols = yield* store.symbolsByIds(database, catalog.snapshot.id, relatedIds);
  const relatedSymbolsById = new Map(relatedSymbols.map(candidate => [candidate.id, candidate]));
  const relationships = edges.map(edge => {
    const outgoing = edge.sourceId === nodeId;
    const relatedId = outgoing ? edge.targetId : edge.sourceId;
    const relatedSymbol = relatedId ? relatedSymbolsById.get(relatedId) : undefined;
    return {
      confidence: edge.confidence,
      direction: outgoing ? ('outgoing' as const) : ('incoming' as const),
      evidencePath: boundedText(edge.evidencePath, 512),
      evidenceSpan: edge.evidenceSpan,
      id: edge.id,
      provenance: edge.provenance,
      related: {
        id: relatedSymbol?.id ?? relatedId,
        kind: relatedSymbol?.kind,
        label: boundedText(relatedSymbol?.name ?? (outgoing ? edge.targetName : edge.sourceName), 160),
        path: relatedSymbol?.path ? boundedText(relatedSymbol.path, 512) : undefined,
        projectId: relatedSymbol ? projectIdForSymbol(relatedSymbol) : undefined,
        qualifiedName: relatedSymbol?.qualifiedName ? boundedText(relatedSymbol.qualifiedName, 320) : undefined,
      },
      relation: edge.relation,
    };
  });
  return {
    node: {
      documentation: symbol.documentation ? boundedText(symbol.documentation, 4_000) : undefined,
      exported: symbol.exported,
      id: symbol.id,
      kind: symbol.kind,
      label: boundedText(symbol.name, 160),
      language: boundedText(symbol.language, 64),
      packageName: symbol.packageName ? boundedText(symbol.packageName, 256) : undefined,
      path: boundedText(symbol.path, 512),
      projectId: projectIdForSymbol(symbol),
      qualifiedName: boundedText(symbol.qualifiedName, 320),
      signature: symbol.signature ? boundedText(symbol.signature, 2_000) : undefined,
      span: symbol.span,
    },
    relationships,
    snapshotId: catalog.snapshot.id,
    stats: {
      ...summary,
      truncated:
        summary.truncated || summary.provenances.reduce((total, item) => total + item.count, 0) > relationships.length,
    },
  } satisfies ManagerGraphNodeDetail;
});

function overviewVisualization(
  store: CodeGraphStoreShape,
  database: string,
  repository: ManagerGraphIndexedView,
  catalog: CodeGraphVisualizationCatalog,
  limits: ManagerGraphVisualizationLimits,
): Effect.Effect<ManagerGraphVisualization, unknown> {
  return Effect.gen(function* () {
    const declaredEdgesById = new Map<string, ManagerGraphEdge>();
    for (const project of catalog.projects) {
      for (const dependency of project.dependencies) {
        if (dependency.targetId === project.id) continue;
        const id = `declared-build-dependency\0${project.id}\0${dependency.targetId}\0${dependency.provenance}`;
        const current = declaredEdgesById.get(id);
        declaredEdgesById.set(id, {
          confidence: 1,
          count: (current?.count ?? 0) + 1,
          id,
          provenance: dependency.provenance,
          relation: 'depends_on',
          sourceId: project.id,
          targetId: dependency.targetId,
        });
      }
    }
    const declaredEdges = [...declaredEdgesById.values()];
    const sourceSummary = yield* store.loadVisualizationScopeEdgeSummary(
      database,
      repository.snapshot.id,
      repository.projects.map(project => project.id),
      limits.edgeLimit,
    );
    const sourceEdges = sourceSummary.edges.map(scopeEdgeToManagerEdge);
    const candidates = [...declaredEdges, ...sourceEdges];
    const allConnections = connectionCounts(candidates);
    const projects = [...repository.projects]
      .sort(
        (left, right) =>
          (allConnections.get(right.id) ?? 0) - (allConnections.get(left.id) ?? 0) ||
          compareCodeUnits(left.label, right.label) ||
          compareCodeUnits(left.id, right.id),
      )
      .slice(0, limits.nodeLimit);
    const visibleProjects = new Set(projects.map(project => project.id));
    const visibleCandidates = candidates.filter(
      edge => visibleProjects.has(edge.sourceId) && visibleProjects.has(edge.targetId),
    );
    const edges = representativeManagerGraphEdges(visibleCandidates, [...visibleProjects], limits.edgeLimit);
    const connections = connectionCounts(edges);
    const nodes = projects.map(project => ({
      degree: connections.get(project.id) ?? 0,
      ...(project.fileCount === undefined ? {} : {fileCount: project.fileCount}),
      id: project.id,
      kind: 'project',
      label: boundedText(project.label, 160),
      projectId: project.id,
      ...(project.symbolCount === undefined ? {} : {symbolCount: project.symbolCount}),
      type: 'project' as const,
    }));
    const warnings: string[] = [];
    if (repository.model === 'legacy-fallback') {
      warnings.push(
        'This snapshot predates typed workspace catalogs; rebuild it to replace legacy package/folder groups.',
      );
    }
    if (repository.metrics === 'complete' && repository.accounting.omittedSymbols > 0) {
      warnings.push(
        `${repository.accounting.omittedSymbols.toLocaleString()} indexed symbols could not be attributed to an overview scope.`,
      );
    }
    if (repository.model === 'workspace') {
      warnings.push(
        'Overview combines declared dependencies with a deterministic bounded sample of source-derived relationships.',
      );
    }
    if (sourceSummary.truncated) {
      warnings.push('Source-derived overview evidence is sampled fairly across the retained components.');
    }
    const hasMore =
      repository.projectsTruncated ||
      repository.projects.length > projects.length ||
      visibleCandidates.length > edges.length ||
      sourceSummary.truncated;
    if (hasMore) warnings.push('The repository overview is bounded; expand the working set to reveal more components.');
    return {
      edges,
      mode: 'overview',
      nodes,
      paging: {...limits, hasMore},
      projectId: 'all',
      repository: visualizationRepository(repository),
      scope: {id: 'all', label: repository.displayName},
      stats: {
        renderedEdges: edges.length,
        renderedNodes: nodes.length,
        totalEdges: repository.snapshot.edgeCount,
        totalNodes: repository.snapshot.symbolCount,
      },
      warnings,
    };
  });
}

function scopeEdgeToManagerEdge(edge: CodeGraphVisualizationScopeEdge): ManagerGraphEdge {
  return {
    confidence: edge.confidence,
    count: edge.count,
    id: `source-relationship\0${edge.sourceId}\0${edge.targetId}\0${edge.provenance}\0${edge.relation}`,
    provenance: edge.provenance,
    relation: edge.relation,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
  };
}

export function representativeManagerGraphEdges(
  candidates: readonly ManagerGraphEdge[],
  retainedNodeIds: readonly string[],
  limit: number,
): readonly ManagerGraphEdge[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const retained = new Set(retainedNodeIds);
  const eligible = candidates
    .filter(edge => edge.sourceId !== edge.targetId && retained.has(edge.sourceId) && retained.has(edge.targetId))
    .sort(compareManagerGraphEdges);
  const selected = new Map<string, ManagerGraphEdge>();
  for (const nodeId of [...retained].sort(compareCodeUnits)) {
    const representative = eligible.find(edge => edge.sourceId === nodeId || edge.targetId === nodeId);
    if (representative && !selected.has(representative.id)) selected.set(representative.id, representative);
    if (selected.size >= safeLimit) return [...selected.values()];
  }
  for (const edge of eligible) {
    if (!selected.has(edge.id)) selected.set(edge.id, edge);
    if (selected.size >= safeLimit) break;
  }
  return [...selected.values()];
}

function compareManagerGraphEdges(left: ManagerGraphEdge, right: ManagerGraphEdge): number {
  const provenanceRank = (value: ManagerGraphEdge['provenance']): number =>
    value === 'declared' ? 0 : value === 'resolved' ? 1 : value === 'syntactic' ? 2 : 3;
  return (
    provenanceRank(left.provenance) - provenanceRank(right.provenance) ||
    right.count - left.count ||
    right.confidence - left.confidence ||
    compareCodeUnits(left.sourceId, right.sourceId) ||
    compareCodeUnits(left.targetId, right.targetId) ||
    compareCodeUnits(left.relation, right.relation) ||
    compareCodeUnits(left.id, right.id)
  );
}

function detailVisualization(
  store: CodeGraphStoreShape,
  database: string,
  repository: ManagerGraphIndexedView,
  project: CodeGraphVisualizationProject,
  limits: ManagerGraphVisualizationLimits,
): Effect.Effect<ManagerGraphVisualization, unknown> {
  return Effect.gen(function* () {
    const seedLimit = Math.max(1, Math.min(limits.nodeLimit, Math.floor(limits.nodeLimit * 0.65)));
    const seedPage = yield* store.loadVisualizationSymbols(
      database,
      repository.snapshot.id,
      scopeFromProjectId(project.id),
      seedLimit + 1,
    );
    const seeds = seedPage.slice(0, seedLimit);
    const seedIds = new Set(seeds.map(symbol => symbol.id));
    const adjacentPage = yield* store.representativeEdgesForNodes(
      database,
      repository.snapshot.id,
      [...seedIds],
      'both',
      limits.edgeLimit,
      ['declared', 'resolved', 'syntactic'],
    );
    const adjacent = adjacentPage.edges;
    const neighborIds = [...new Set(adjacent.flatMap(edge => [edge.sourceId, edge.targetId]).filter(isString))].filter(
      id => !seedIds.has(id),
    );
    const neighborBudget = Math.max(0, limits.nodeLimit - seeds.length);
    const neighborCandidateLimit = Math.min(400, Math.max(neighborBudget, neighborBudget * 4));
    const neighborCandidates = yield* store.symbolsByIds(
      database,
      repository.snapshot.id,
      neighborIds.slice(0, neighborCandidateLimit),
    );
    const neighbors = rankManagerGraphNeighbors(neighborCandidates, adjacent, seeds, project.id).slice(
      0,
      neighborBudget,
    );
    const workingSet = managerGraphDetailWorkingSet(seeds, neighbors, adjacent, project.id, limits);
    const {edges, nodes} = workingSet;
    const warnings: string[] = [];
    if (repository.metrics === 'complete' && project.symbolCount > seeds.length) {
      warnings.push(
        `Showing a connected ${nodes.length.toLocaleString()}-node working set from ${project.symbolCount.toLocaleString()} project symbols.`,
      );
    } else if (seedPage.length > seedLimit) {
      warnings.push(`Showing a connected ${nodes.length.toLocaleString()}-node working set for this component.`);
    }
    if (adjacentPage.truncated) {
      warnings.push('The relationship working set reached its rendering budget.');
    }
    const hasMore =
      adjacentPage.truncated ||
      workingSet.truncated ||
      neighborIds.length > neighborCandidates.length ||
      seedPage.length > seedLimit ||
      (repository.metrics === 'complete' && project.symbolCount > seeds.length);
    return {
      edges,
      mode: 'detail',
      nodes,
      paging: {...limits, hasMore},
      projectId: project.id,
      repository: visualizationRepository(repository),
      scope: {id: project.id, label: project.label},
      stats: {
        renderedEdges: edges.length,
        renderedNodes: nodes.length,
        totalEdges: repository.snapshot.edgeCount,
        totalNodes: repository.snapshot.symbolCount,
      },
      warnings,
    };
  });
}

function rankManagerGraphNeighbors(
  candidates: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
  seeds: readonly CodeGraphSymbol[],
  selectedProjectId: string,
): readonly CodeGraphSymbol[] {
  const seedById = new Map(seeds.map(seed => [seed.id, seed]));
  const incidentCounts = new Map<string, number>();
  const seedPriorities = new Map<string, number>();
  for (const edge of edges) {
    const sourceSeed = edge.sourceId ? seedById.get(edge.sourceId) : undefined;
    const targetSeed = edge.targetId ? seedById.get(edge.targetId) : undefined;
    if (edge.sourceId && !sourceSeed && targetSeed) {
      incidentCounts.set(edge.sourceId, (incidentCounts.get(edge.sourceId) ?? 0) + 1);
      seedPriorities.set(
        edge.sourceId,
        Math.min(seedPriorities.get(edge.sourceId) ?? Number.POSITIVE_INFINITY, searchKindPriority(targetSeed.kind)),
      );
    }
    if (edge.targetId && !targetSeed && sourceSeed) {
      incidentCounts.set(edge.targetId, (incidentCounts.get(edge.targetId) ?? 0) + 1);
      seedPriorities.set(
        edge.targetId,
        Math.min(seedPriorities.get(edge.targetId) ?? Number.POSITIVE_INFINITY, searchKindPriority(sourceSeed.kind)),
      );
    }
  }
  return [...candidates].sort(
    (left, right) =>
      (seedPriorities.get(left.id) ?? Number.POSITIVE_INFINITY) -
        (seedPriorities.get(right.id) ?? Number.POSITIVE_INFINITY) ||
      Number(projectIdForSymbol(right) !== selectedProjectId) -
        Number(projectIdForSymbol(left) !== selectedProjectId) ||
      (incidentCounts.get(right.id) ?? 0) - (incidentCounts.get(left.id) ?? 0) ||
      searchKindPriority(left.kind) - searchKindPriority(right.kind) ||
      compareCodeUnits(left.path, right.path) ||
      compareCodeUnits(left.qualifiedName, right.qualifiedName) ||
      compareCodeUnits(left.id, right.id),
  );
}

function searchKindPriority(kind: string): number {
  switch (kind) {
    case 'package':
      return 0;
    case 'module':
      return 1;
    case 'class':
      return 2;
    case 'interface':
      return 3;
    case 'function':
      return 4;
    case 'method':
      return 5;
    default:
      return 6;
  }
}

export function managerGraphDetailWorkingSet(
  seeds: readonly CodeGraphSymbol[],
  neighbors: readonly CodeGraphSymbol[],
  adjacent: readonly CodeGraphEdge[],
  selectedProjectId: string,
  limits: ManagerGraphVisualizationLimits,
): {
  readonly edges: readonly ManagerGraphEdge[];
  readonly nodes: readonly ManagerGraphNode[];
  readonly truncated: boolean;
} {
  const seedIds = new Set(seeds.map(symbol => symbol.id));
  const symbols = [...seeds, ...neighbors].slice(0, limits.nodeLimit);
  const visibleIds = new Set(symbols.map(symbol => symbol.id));
  const edges = adjacent
    .filter((edge): edge is CodeGraphEdge & {readonly sourceId: string; readonly targetId: string} =>
      Boolean(
        edge.sourceId &&
        edge.targetId &&
        edge.sourceId !== edge.targetId &&
        visibleIds.has(edge.sourceId) &&
        visibleIds.has(edge.targetId),
      ),
    )
    .slice(0, limits.edgeLimit)
    .map(edge => ({
      confidence: edge.confidence,
      count: 1,
      id: edge.id,
      provenance: edge.provenance,
      relation: edge.relation,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
    }));
  const connections = connectionCounts(edges);
  return {
    edges,
    nodes: symbols.map(symbol =>
      symbolNode(symbol, connections.get(symbol.id) ?? 0, seedIds.has(symbol.id) ? selectedProjectId : undefined),
    ),
    truncated:
      adjacent.length > edges.length ||
      [...new Set(adjacent.flatMap(edge => [edge.sourceId, edge.targetId]).filter(isString))].some(
        id => !visibleIds.has(id),
      ),
  };
}

function repositoryFromCatalog(checkoutId: string, catalog: CodeGraphVisualizationCatalog): ManagerGraphIndexedView {
  const viewId = `${checkoutId}.${catalog.viewWorktreeId}`;
  return {
    accounting: catalog.accounting,
    ...(catalog.activatedAt ? {activatedAt: catalog.activatedAt} : {}),
    checkoutId,
    displayName: catalog.repository.displayName,
    id: viewId,
    label: indexedViewLabel(checkoutId, catalog),
    metrics: catalog.metrics,
    model: catalog.model,
    projectCount: catalog.projectCount,
    projects: catalog.projects.map(project => ({
      ...(project.buildSystem ? {buildSystem: project.buildSystem} : {}),
      ...(catalog.metrics === 'complete' ? {fileCount: project.fileCount} : {}),
      id: project.id,
      ...(project.kind ? {kind: project.kind} : {}),
      label: boundedText(project.label, 160),
      model: project.model,
      provenance: project.provenance,
      ...(catalog.metrics === 'complete' ? {symbolCount: project.symbolCount} : {}),
      ...(project.workspaceId ? {workspaceId: project.workspaceId} : {}),
    })),
    projectsTruncated: catalog.projectsTruncated,
    snapshot: catalog.snapshot,
    worktreeId: catalog.viewWorktreeId,
    workspaceCount: catalog.workspaceCount,
    workspaces: catalog.workspaces.map(workspace => ({
      buildSystem: workspace.buildSystem,
      id: workspace.id,
      name: boundedText(workspace.name, 160),
      root: boundedText(workspace.root, 512),
    })),
    workspacesTruncated: catalog.workspacesTruncated,
  };
}

function visualizationRepository(repository: ManagerGraphIndexedView): ManagerGraphVisualization['repository'] {
  return {
    accounting: repository.accounting,
    displayName: repository.displayName,
    id: repository.id,
    metrics: repository.metrics,
    snapshot: repository.snapshot,
  };
}

const resolveManagerGraphView = Effect.fn('codeGraph.resolveManagerGraphView')(function* (
  threadnoteHome: string,
  indexedViewId: string,
  options: {
    readonly expectedSnapshotId: Option.Option<string>;
    readonly includeDependencies: boolean;
    readonly projectId?: Option.Option<string>;
    readonly projectLimit: number;
  },
) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const [checkoutId, worktreeId] = indexedViewId.split('.', 2) as [string, string | undefined];
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const database = databases.find(candidate => path.basename(path.dirname(candidate)) === checkoutId);
  if (!database) return yield* Effect.fail(new Error('Indexed graph checkout was not found.'));
  const catalogOptions = {
    includeDependencies: options.includeDependencies,
    projectId: options.projectId ?? Option.none(),
    projectLimit: options.projectLimit,
    snapshotId: options.expectedSnapshotId,
    workspaceLimit: MANAGER_CATALOG_WORKSPACE_LIMIT,
  };
  const catalog = Option.isSome(options.expectedSnapshotId)
    ? yield* store.loadVisualizationCatalog(database, 'deferred', catalogOptions)
    : worktreeId
      ? (yield* store.loadVisualizationCatalogs(database, 'deferred', catalogOptions)).find(
          candidate => candidate.viewWorktreeId === worktreeId,
        )
      : yield* store.loadVisualizationCatalog(database, 'deferred', catalogOptions);
  if (!catalog) return yield* Effect.fail(new Error('Indexed graph view has no ready snapshot.'));
  if (worktreeId && catalog.viewWorktreeId !== worktreeId) {
    return yield* Effect.fail(new Error('Indexed graph snapshot does not belong to the requested view.'));
  }
  return {catalog, checkoutId, database};
});

function scopeFromProjectId(projectId: string): CodeGraphVisualizationScope {
  if (projectId.startsWith('cgp_')) return {type: 'component', value: projectId};
  if (projectId === 'facet:repository') return {type: 'all'};
  if (projectId === 'facet:unscoped') return {type: 'unscoped'};
  if (projectId === 'facet:unscoped-documentation') return {type: 'documentation-facet'};
  if (projectId.startsWith('package:')) return {type: 'package', value: projectId.slice('package:'.length)};
  if (projectId.startsWith('path:')) return {type: 'path', value: projectId.slice('path:'.length)};
  return {type: 'all'};
}

function projectIdForSymbol(symbol: CodeGraphSymbol): string {
  if (symbol.resolutionScopeId) return symbol.resolutionScopeId;
  if (symbol.language === 'markdown' || ['document', 'heading', 'section'].includes(symbol.kind)) {
    return 'facet:unscoped-documentation';
  }
  const packageName = symbol.packageName?.trim();
  if (packageName) return `package:${packageName}`;
  return `path:${symbol.path.split('/')[0] || '(root)'}`;
}

function symbolNode(symbol: CodeGraphSymbol, degree: number, projectId?: string): ManagerGraphNode {
  return {
    degree,
    exported: symbol.exported,
    id: symbol.id,
    kind: symbol.kind,
    label: boundedText(symbol.name, 160),
    language: symbol.language,
    path: boundedText(symbol.path, 512),
    projectId: projectId ?? projectIdForSymbol(symbol),
    qualifiedName: boundedText(symbol.qualifiedName, 320),
    type: 'symbol',
  };
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(1, maximum - 1))}…`;
}

function connectionCounts(edges: readonly Pick<ManagerGraphEdge, 'sourceId' | 'targetId'>[]): Map<string, number> {
  const neighbors = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.sourceId === edge.targetId) continue;
    const sourceNeighbors = neighbors.get(edge.sourceId) ?? new Set<string>();
    sourceNeighbors.add(edge.targetId);
    neighbors.set(edge.sourceId, sourceNeighbors);
    const targetNeighbors = neighbors.get(edge.targetId) ?? new Set<string>();
    targetNeighbors.add(edge.sourceId);
    neighbors.set(edge.targetId, targetNeighbors);
  }
  return new Map([...neighbors].map(([id, connected]) => [id, connected.size]));
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}

function compareIndexedViews(left: ManagerGraphIndexedView, right: ManagerGraphIndexedView): number {
  const leftTime = Date.parse(left.activatedAt ?? left.snapshot.completedAt ?? '') || 0;
  const rightTime = Date.parse(right.activatedAt ?? right.snapshot.completedAt ?? '') || 0;
  return (
    rightTime - leftTime || compareCodeUnits(right.snapshot.id, left.snapshot.id) || compareCodeUnits(left.id, right.id)
  );
}

function indexedViewLabel(checkoutId: string, catalog: CodeGraphVisualizationCatalog): string {
  const commit = catalog.snapshot.commit.slice(0, 8) || 'no-commit';
  const state = catalog.snapshot.dirty ? 'dirty' : 'clean';
  const indexed = catalog.activatedAt ?? catalog.snapshot.completedAt;
  const indexedLabel = indexed ? new Date(indexed).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : 'time unknown';
  return `${commit} · ${state} · ${indexedLabel} · checkout ${shortIdentity(checkoutId)} · worktree ${shortIdentity(catalog.viewWorktreeId)}`;
}

function shortIdentity(value: string): string {
  return value.slice(-8) || 'unknown';
}

function privacySafeCatalogError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    message
      .replaceAll(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s'"`<>]|\\ )+/g, '<local-path>')
      .replaceAll(/\s+/g, ' ')
      .trim()
      .slice(0, 240) || 'unknown database error'
  );
}
