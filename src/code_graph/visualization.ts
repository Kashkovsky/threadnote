import {Effect, Path} from 'effect';
import {codeGraphDatabasePaths} from './maintenance.js';
import {compareCodeUnits} from './ordering.js';
import {
  CodeGraphStore,
  type CodeGraphStoreShape,
  type CodeGraphVisualizationCatalog,
  type CodeGraphVisualizationProject,
  type CodeGraphVisualizationScope,
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
    readonly fileCount: number;
    readonly id: string;
    readonly kind?: string;
    readonly label: string;
    readonly model: CodeGraphVisualizationProject['model'];
    readonly provenance: string;
    readonly symbolCount: number;
    readonly workspaceId?: string;
  }[];
  readonly snapshot: CodeGraphSnapshot;
  readonly worktreeId: string;
  readonly workspaces: readonly {
    readonly buildSystem: string;
    readonly id: string;
    readonly name: string;
    readonly root: string;
  }[];
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
      return store.loadVisualizationCatalogs(database, 'deferred').pipe(
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
) {
  if (!INDEXED_VIEW_ID.test(indexedViewId)) return yield* Effect.fail(new Error('Graph view identity is invalid.'));
  const analysis = yield* CodeGraphAnalysis;
  const {catalog, database} = yield* resolveManagerGraphView(threadnoteHome, indexedViewId);
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
) {
  if (!INDEXED_VIEW_ID.test(indexedViewId)) return yield* Effect.fail(new Error('Graph view identity is invalid.'));
  const store = yield* CodeGraphStore;
  const {catalog, checkoutId, database} = yield* resolveManagerGraphView(threadnoteHome, indexedViewId);
  const repository = repositoryFromCatalog(checkoutId, catalog);
  const limits = managerGraphVisualizationLimits(requestedBudget);
  const projectId = requestedProjectId.trim() || 'all';
  if (projectId === 'all') {
    return yield* overviewVisualization(repository, catalog, limits);
  }
  const project = catalog.projects.find(candidate => candidate.id === projectId);
  if (!project) return yield* Effect.fail(new Error('Indexed graph project was not found.'));
  return yield* detailVisualization(store, database, repository, project, limits);
});

export const managerGraphNodeDetail = Effect.fn('codeGraph.managerNodeDetail')(function* (
  threadnoteHome: string,
  indexedViewId: string,
  requestedNodeId: string,
) {
  if (!INDEXED_VIEW_ID.test(indexedViewId)) return yield* Effect.fail(new Error('Graph view identity is invalid.'));
  const nodeId = requestedNodeId.trim();
  if (nodeId.length === 0 || nodeId.length > NODE_ID_MAX_LENGTH) {
    return yield* Effect.fail(new Error('Graph node identity is invalid.'));
  }
  const store = yield* CodeGraphStore;
  const {catalog, database} = yield* resolveManagerGraphView(threadnoteHome, indexedViewId);
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
    store.relationshipSummaryForNode(database, catalog.snapshot.id, nodeId, NODE_DETAIL_PROVENANCES),
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
    stats: {
      ...summary,
      truncated: summary.provenances.reduce((total, item) => total + item.count, 0) > relationships.length,
    },
  } satisfies ManagerGraphNodeDetail;
});

function overviewVisualization(
  repository: ManagerGraphIndexedView,
  catalog: CodeGraphVisualizationCatalog,
  limits: ManagerGraphVisualizationLimits,
): Effect.Effect<ManagerGraphVisualization> {
  return Effect.sync(() => {
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
    const allConnections = connectionCounts(declaredEdges);
    const projects = [...repository.projects]
      .sort(
        (left, right) =>
          (allConnections.get(right.id) ?? 0) - (allConnections.get(left.id) ?? 0) ||
          compareCodeUnits(left.label, right.label) ||
          compareCodeUnits(left.id, right.id),
      )
      .slice(0, limits.nodeLimit);
    const visibleProjects = new Set(projects.map(project => project.id));
    const visibleDeclaredEdges = declaredEdges.filter(
      edge => visibleProjects.has(edge.sourceId) && visibleProjects.has(edge.targetId),
    );
    const edges = visibleDeclaredEdges.slice(0, limits.edgeLimit);
    const connections = connectionCounts(edges);
    const nodes = projects.map(project => ({
      degree: connections.get(project.id) ?? 0,
      fileCount: project.fileCount,
      id: project.id,
      kind: 'project',
      label: boundedText(project.label, 160),
      projectId: project.id,
      symbolCount: project.symbolCount,
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
        'Overview shows persisted workspace components and declared dependencies; open a component for bounded source relationships.',
      );
    }
    const hasMore = repository.projects.length > projects.length || visibleDeclaredEdges.length > edges.length;
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
    const adjacentPage = yield* store.edgesForNodes(
      database,
      repository.snapshot.id,
      [...seedIds],
      'both',
      limits.edgeLimit + 1,
      ['declared', 'resolved', 'syntactic'],
    );
    const adjacent = adjacentPage.slice(0, limits.edgeLimit);
    const neighborIds = [...new Set(adjacent.flatMap(edge => [edge.sourceId, edge.targetId]).filter(isString))].filter(
      id => !seedIds.has(id),
    );
    const neighbors = yield* store.symbolsByIds(
      database,
      repository.snapshot.id,
      neighborIds.slice(0, Math.max(0, limits.nodeLimit - seeds.length)),
    );
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
    const nodes = symbols.map(symbol => symbolNode(symbol, connections.get(symbol.id) ?? 0));
    const warnings: string[] = [];
    if (repository.metrics === 'complete' && project.symbolCount > seeds.length) {
      warnings.push(
        `Showing a connected ${nodes.length.toLocaleString()}-node working set from ${project.symbolCount.toLocaleString()} project symbols.`,
      );
    } else if (seedPage.length > seedLimit) {
      warnings.push(`Showing a connected ${nodes.length.toLocaleString()}-node working set for this component.`);
    }
    if (adjacentPage.length > limits.edgeLimit) {
      warnings.push('The relationship working set reached its rendering budget.');
    }
    const hasMore =
      adjacentPage.length > limits.edgeLimit ||
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
    projects: catalog.projects.map(project => ({
      ...(project.buildSystem ? {buildSystem: project.buildSystem} : {}),
      fileCount: project.fileCount,
      id: project.id,
      ...(project.kind ? {kind: project.kind} : {}),
      label: boundedText(project.label, 160),
      model: project.model,
      provenance: project.provenance,
      symbolCount: project.symbolCount,
      ...(project.workspaceId ? {workspaceId: project.workspaceId} : {}),
    })),
    snapshot: catalog.snapshot,
    worktreeId: catalog.viewWorktreeId,
    workspaces: catalog.workspaces.map(workspace => ({
      buildSystem: workspace.buildSystem,
      id: workspace.id,
      name: boundedText(workspace.name, 160),
      root: boundedText(workspace.root, 512),
    })),
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
) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const [checkoutId, worktreeId] = indexedViewId.split('.', 2) as [string, string | undefined];
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const database = databases.find(candidate => path.basename(path.dirname(candidate)) === checkoutId);
  if (!database) return yield* Effect.fail(new Error('Indexed graph checkout was not found.'));
  const catalog = worktreeId
    ? (yield* store.loadVisualizationCatalogs(database, 'deferred')).find(
        candidate => candidate.viewWorktreeId === worktreeId,
      )
    : yield* store.loadVisualizationCatalog(database, 'deferred');
  if (!catalog) return yield* Effect.fail(new Error('Indexed graph view has no ready snapshot.'));
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

function symbolNode(symbol: CodeGraphSymbol, degree: number): ManagerGraphNode {
  return {
    degree,
    exported: symbol.exported,
    id: symbol.id,
    kind: symbol.kind,
    label: boundedText(symbol.name, 160),
    language: symbol.language,
    path: boundedText(symbol.path, 512),
    projectId: projectIdForSymbol(symbol),
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
