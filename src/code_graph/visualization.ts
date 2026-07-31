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

const DETAIL_SEED_LIMIT = 500;
const DETAIL_NODE_LIMIT = 900;
const DETAIL_EDGE_LIMIT = 3_000;
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
  readonly model: CodeGraphVisualizationCatalog['model'];
  readonly projects: readonly CodeGraphVisualizationProject[];
  readonly snapshot: CodeGraphSnapshot;
  readonly worktreeId: string;
  readonly workspaces: CodeGraphVisualizationCatalog['workspaces'];
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
  readonly provenance: CodeGraphEdge['provenance'] | 'aggregate';
  readonly relation: CodeGraphEdge['relation'] | 'cross-project';
  readonly sourceId: string;
  readonly targetId: string;
}

export interface ManagerGraphVisualization {
  readonly edges: readonly ManagerGraphEdge[];
  readonly mode: 'detail' | 'overview';
  readonly nodes: readonly ManagerGraphNode[];
  readonly projectId: string;
  readonly repository: ManagerGraphIndexedView;
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
      return store.loadVisualizationCatalogs(database).pipe(
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
) {
  if (!INDEXED_VIEW_ID.test(indexedViewId)) return yield* Effect.fail(new Error('Graph view identity is invalid.'));
  const store = yield* CodeGraphStore;
  const {catalog, checkoutId, database} = yield* resolveManagerGraphView(threadnoteHome, indexedViewId);
  const repository = repositoryFromCatalog(checkoutId, catalog);
  const projectId = requestedProjectId.trim() || 'all';
  if (projectId === 'all') {
    return yield* overviewVisualization(store, database, repository);
  }
  const project = catalog.projects.find(candidate => candidate.id === projectId);
  if (!project) return yield* Effect.fail(new Error('Indexed graph project was not found.'));
  return yield* detailVisualization(store, database, repository, project);
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
      evidencePath: edge.evidencePath,
      evidenceSpan: edge.evidenceSpan,
      id: edge.id,
      provenance: edge.provenance,
      related: {
        id: relatedSymbol?.id ?? relatedId,
        kind: relatedSymbol?.kind,
        label: relatedSymbol?.name ?? (outgoing ? edge.targetName : edge.sourceName),
        path: relatedSymbol?.path,
        projectId: relatedSymbol ? projectIdForSymbol(relatedSymbol) : undefined,
        qualifiedName: relatedSymbol?.qualifiedName,
      },
      relation: edge.relation,
    };
  });
  return {
    node: {
      documentation: symbol.documentation?.slice(0, 4_000),
      exported: symbol.exported,
      id: symbol.id,
      kind: symbol.kind,
      label: symbol.name,
      language: symbol.language,
      packageName: symbol.packageName,
      path: symbol.path,
      projectId: projectIdForSymbol(symbol),
      qualifiedName: symbol.qualifiedName,
      signature: symbol.signature,
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
  store: CodeGraphStoreShape,
  database: string,
  repository: ManagerGraphIndexedView,
): Effect.Effect<ManagerGraphVisualization, unknown> {
  return Effect.gen(function* () {
    const projects = repository.projects;
    const visibleProjects = new Map(projects.map(project => [project.id, project]));
    const edges = (yield* store.loadVisualizationScopeEdges(database, repository.snapshot.id))
      .filter(edge => visibleProjects.has(edge.sourceId) && visibleProjects.has(edge.targetId))
      .map(edge => ({
        confidence: edge.confidence,
        count: edge.count,
        id: `${edge.type}\0${edge.sourceId}\0${edge.targetId}\0${edge.provenance}\0${edge.relation}`,
        provenance: edge.provenance,
        relation: edge.relation,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
      }));
    const connections = connectionCounts(edges);
    const nodes = projects.map(project => ({
      degree: connections.get(project.id) ?? 0,
      fileCount: project.fileCount,
      id: project.id,
      kind: 'project',
      label: project.label,
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
    if (repository.accounting.omittedSymbols > 0) {
      warnings.push(
        `${repository.accounting.omittedSymbols.toLocaleString()} indexed symbols could not be attributed to an overview scope.`,
      );
    }
    return {
      edges,
      mode: 'overview',
      nodes,
      projectId: 'all',
      repository,
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
): Effect.Effect<ManagerGraphVisualization, unknown> {
  return Effect.gen(function* () {
    const seeds = yield* store.loadVisualizationSymbols(
      database,
      repository.snapshot.id,
      scopeFromProjectId(project.id),
      DETAIL_SEED_LIMIT,
    );
    const seedIds = new Set(seeds.map(symbol => symbol.id));
    const adjacent = yield* store.edgesForNodes(
      database,
      repository.snapshot.id,
      [...seedIds],
      'both',
      DETAIL_EDGE_LIMIT,
      ['declared', 'resolved', 'syntactic'],
    );
    const neighborIds = [...new Set(adjacent.flatMap(edge => [edge.sourceId, edge.targetId]).filter(isString))].filter(
      id => !seedIds.has(id),
    );
    const neighbors = yield* store.symbolsByIds(
      database,
      repository.snapshot.id,
      neighborIds.slice(0, Math.max(0, DETAIL_NODE_LIMIT - seeds.length)),
    );
    const symbols = [...seeds, ...neighbors].slice(0, DETAIL_NODE_LIMIT);
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
    if (project.symbolCount > seeds.length) {
      warnings.push(
        `Showing a connected ${nodes.length.toLocaleString()}-node working set from ${project.symbolCount.toLocaleString()} project symbols.`,
      );
    }
    if (adjacent.length >= DETAIL_EDGE_LIMIT) {
      warnings.push('The relationship working set reached its rendering budget.');
    }
    return {
      edges,
      mode: 'detail',
      nodes,
      projectId: project.id,
      repository,
      stats: {
        renderedEdges: edges.length,
        renderedNodes: nodes.length,
        totalEdges: repository.snapshot.edgeCount,
        totalNodes: project.symbolCount,
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
    model: catalog.model,
    projects: catalog.projects,
    snapshot: catalog.snapshot,
    worktreeId: catalog.viewWorktreeId,
    workspaces: catalog.workspaces,
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
    ? (yield* store.loadVisualizationCatalogs(database)).find(candidate => candidate.viewWorktreeId === worktreeId)
    : yield* store.loadVisualizationCatalog(database);
  if (!catalog) return yield* Effect.fail(new Error('Indexed graph view has no ready snapshot.'));
  return {catalog, checkoutId, database};
});

function scopeFromProjectId(projectId: string): CodeGraphVisualizationScope {
  if (projectId.startsWith('cgp_')) return {type: 'component', value: projectId};
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
    label: symbol.name,
    language: symbol.language,
    packageName: symbol.packageName,
    path: symbol.path,
    projectId: projectIdForSymbol(symbol),
    qualifiedName: symbol.qualifiedName,
    signature: symbol.signature,
    type: 'symbol',
  };
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
