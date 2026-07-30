import {Effect, Path} from 'effect';
import {codeGraphDatabasePaths} from './maintenance.js';
import {
  CodeGraphStore,
  type CodeGraphStoreShape,
  type CodeGraphVisualizationCatalog,
  type CodeGraphVisualizationProject,
  type CodeGraphVisualizationScope,
} from './store.js';
import type {CodeGraphEdge, CodeGraphProvenance, CodeGraphSnapshot, CodeGraphSpan, CodeGraphSymbol} from './types.js';

const OVERVIEW_EDGE_SAMPLE = 1_200;
const OVERVIEW_PROJECT_LIMIT = 80;
const DETAIL_SEED_LIMIT = 500;
const DETAIL_NODE_LIMIT = 900;
const DETAIL_EDGE_LIMIT = 3_000;
const NODE_DETAIL_EDGE_LIMIT = 160;
const REPOSITORY_ID = /^[0-9a-f]{64}$/;
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
  readonly projects: readonly CodeGraphVisualizationProject[];
  readonly repositoryId: string;
  readonly snapshot: CodeGraphSnapshot;
}

export interface ManagerGraphCatalog {
  readonly repositories: readonly ManagerGraphRepository[];
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
  readonly repository: ManagerGraphRepository;
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
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const repositories = (yield* Effect.forEach(
    databases,
    database =>
      store.loadVisualizationCatalog(database).pipe(
        Effect.map(catalog =>
          catalog ? repositoryFromCatalog(path.basename(path.dirname(database)), catalog) : undefined,
        ),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    {concurrency: 2},
  ))
    .filter((repository): repository is ManagerGraphRepository => repository !== undefined)
    .sort(
      (left, right) =>
        right.snapshot.symbolCount - left.snapshot.symbolCount || left.displayName.localeCompare(right.displayName),
    );
  return {repositories} satisfies ManagerGraphCatalog;
});

export const managerGraphVisualization = Effect.fn('codeGraph.managerVisualization')(function* (
  threadnoteHome: string,
  repositoryId: string,
  requestedProjectId: string,
) {
  if (!REPOSITORY_ID.test(repositoryId)) {
    return yield* Effect.fail(new Error('Graph repository identity is invalid.'));
  }
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const database = databases.find(candidate => path.basename(path.dirname(candidate)) === repositoryId);
  if (!database) return yield* Effect.fail(new Error('Indexed graph repository was not found.'));
  const catalog = yield* store.loadVisualizationCatalog(database);
  if (!catalog) return yield* Effect.fail(new Error('Indexed graph repository has no ready snapshot.'));
  const repository = repositoryFromCatalog(repositoryId, catalog);
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
  repositoryId: string,
  requestedNodeId: string,
) {
  if (!REPOSITORY_ID.test(repositoryId)) {
    return yield* Effect.fail(new Error('Graph repository identity is invalid.'));
  }
  const nodeId = requestedNodeId.trim();
  if (nodeId.length === 0 || nodeId.length > NODE_ID_MAX_LENGTH) {
    return yield* Effect.fail(new Error('Graph node identity is invalid.'));
  }
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const database = databases.find(candidate => path.basename(path.dirname(candidate)) === repositoryId);
  if (!database) return yield* Effect.fail(new Error('Indexed graph repository was not found.'));
  const catalog = yield* store.loadVisualizationCatalog(database);
  if (!catalog) return yield* Effect.fail(new Error('Indexed graph repository has no ready snapshot.'));
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
  repository: ManagerGraphRepository,
): Effect.Effect<ManagerGraphVisualization, unknown> {
  return Effect.gen(function* () {
    const projects = repository.projects.slice(0, OVERVIEW_PROJECT_LIMIT);
    const visibleProjects = new Map(projects.map(project => [project.id, project]));
    const sampledEdges = yield* store.loadEdgePage(database, repository.snapshot.id, undefined, OVERVIEW_EDGE_SAMPLE);
    const endpointIds = [...new Set(sampledEdges.flatMap(edge => [edge.sourceId, edge.targetId]).filter(isString))];
    const symbols = yield* store.symbolsByIds(database, repository.snapshot.id, endpointIds);
    const symbolsById = new Map(symbols.map(symbol => [symbol.id, symbol]));
    const aggregateEdges = new Map<string, {confidence: number; count: number; sourceId: string; targetId: string}>();
    for (const edge of sampledEdges) {
      const source = edge.sourceId ? symbolsById.get(edge.sourceId) : undefined;
      const target = edge.targetId ? symbolsById.get(edge.targetId) : undefined;
      if (!source || !target) continue;
      const sourceId = projectIdForSymbol(source);
      const targetId = projectIdForSymbol(target);
      if (sourceId === targetId || !visibleProjects.has(sourceId) || !visibleProjects.has(targetId)) continue;
      const id = `${sourceId}\0${targetId}`;
      const existing = aggregateEdges.get(id);
      aggregateEdges.set(id, {
        confidence: Math.max(existing?.confidence ?? 0, edge.confidence),
        count: (existing?.count ?? 0) + 1,
        sourceId,
        targetId,
      });
    }
    const edges = [...aggregateEdges].map(([id, edge]) => ({
      ...edge,
      id,
      provenance: 'aggregate' as const,
      relation: 'cross-project' as const,
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
    if (repository.projects.length > projects.length) {
      warnings.push(`Showing the ${projects.length} largest of ${repository.projects.length} projects.`);
    }
    if (repository.snapshot.edgeCount > sampledEdges.length) {
      warnings.push(
        `Project relationships are sampled from ${sampledEdges.length.toLocaleString()} indexed edges to keep the overview responsive.`,
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
  repository: ManagerGraphRepository,
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

function repositoryFromCatalog(id: string, catalog: CodeGraphVisualizationCatalog): ManagerGraphRepository {
  return {
    displayName: catalog.repository.displayName,
    id,
    projects: catalog.projects,
    repositoryId: catalog.repository.repositoryId,
    snapshot: catalog.snapshot,
  };
}

function scopeFromProjectId(projectId: string): CodeGraphVisualizationScope {
  if (projectId.startsWith('package:')) return {type: 'package', value: projectId.slice('package:'.length)};
  if (projectId.startsWith('path:')) return {type: 'path', value: projectId.slice('path:'.length)};
  return {type: 'all'};
}

function projectIdForSymbol(symbol: CodeGraphSymbol): string {
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
