import {Effect} from 'effect';
import type {CodeGraphEdgeCursor, CodeGraphStoreShape, CodeGraphSymbolCursor} from '../../src/code_graph/store.js';
import type {CodeGraphEdge, CodeGraphSnapshot, CodeGraphSymbol} from '../../src/code_graph/types.js';

export interface AnalysisPagingObservation {
  readonly edgePageLimits: number[];
  readonly symbolPageLimits: number[];
}

export function pagedAnalysisStore(
  inputSymbols: readonly CodeGraphSymbol[],
  inputEdges: readonly CodeGraphEdge[],
  observation: AnalysisPagingObservation = {edgePageLimits: [], symbolPageLimits: []},
): CodeGraphStoreShape {
  const symbols = [...inputSymbols].sort(compareSymbols);
  const edges = [...inputEdges].sort(compareEdges);
  return {
    loadEdgePage: (
      _databasePath: string,
      _snapshotId: string,
      cursor: CodeGraphEdgeCursor | undefined,
      limit: number,
    ) =>
      Effect.sync(() => {
        observation.edgePageLimits.push(limit);
        return edges.slice(firstEdgeAfter(edges, cursor), firstEdgeAfter(edges, cursor) + limit);
      }),
    loadSymbolPage: (
      _databasePath: string,
      _snapshotId: string,
      cursor: CodeGraphSymbolCursor | undefined,
      limit: number,
    ) =>
      Effect.sync(() => {
        observation.symbolPageLimits.push(limit);
        return symbols.slice(firstSymbolAfter(symbols, cursor), firstSymbolAfter(symbols, cursor) + limit);
      }),
  } as unknown as CodeGraphStoreShape;
}

export function analysisSnapshot(
  symbols: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
): CodeGraphSnapshot {
  return {
    commit: '1'.repeat(40),
    completedAt: '2026-07-31T00:00:00.000Z',
    dirty: false,
    edgeCount: edges.length,
    extractorSet: 'analysis-fixture',
    fileCount: new Set(symbols.map(symbol => symbol.path)).size,
    id: 'analysis-snapshot',
    repositoryId: 'analysis-repository',
    state: 'ready',
    symbolCount: symbols.length,
    worktreeId: 'analysis-worktree',
  };
}

export function analysisSymbol(
  id: string,
  packageName: string | undefined,
  path: string,
  overrides: Partial<CodeGraphSymbol> = {},
): CodeGraphSymbol {
  return {
    contentHash: `hash-${id}`,
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    name: id,
    packageName,
    path,
    qualifiedName: id,
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
    ...overrides,
  };
}

export function analysisEdge(
  id: string,
  source: CodeGraphSymbol,
  target: CodeGraphSymbol,
  relation: CodeGraphEdge['relation'] = 'calls',
  overrides: Partial<CodeGraphEdge> = {},
): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: source.path,
    evidenceSpan: source.span,
    id,
    provenance: 'resolved',
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
    ...overrides,
  };
}

function firstSymbolAfter(symbols: readonly CodeGraphSymbol[], cursor: CodeGraphSymbolCursor | undefined): number {
  return cursor === undefined ? 0 : firstAfter(symbols, symbol => compareSymbolToCursor(symbol, cursor));
}

function firstEdgeAfter(edges: readonly CodeGraphEdge[], cursor: CodeGraphEdgeCursor | undefined): number {
  return cursor === undefined ? 0 : firstAfter(edges, edge => compareEdgeToCursor(edge, cursor));
}

function firstAfter<Value>(values: readonly Value[], compareToCursor: (value: Value) => number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareToCursor(values[middle]!) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function compareSymbols(left: CodeGraphSymbol, right: CodeGraphSymbol): number {
  return (
    left.path.localeCompare(right.path) ||
    left.qualifiedName.localeCompare(right.qualifiedName) ||
    left.id.localeCompare(right.id)
  );
}

function compareSymbolToCursor(symbol: CodeGraphSymbol, cursor: CodeGraphSymbolCursor): number {
  return (
    symbol.path.localeCompare(cursor.path) ||
    symbol.qualifiedName.localeCompare(cursor.qualifiedName) ||
    symbol.id.localeCompare(cursor.id)
  );
}

function compareEdges(left: CodeGraphEdge, right: CodeGraphEdge): number {
  return (
    left.sourceName.localeCompare(right.sourceName) ||
    left.relation.localeCompare(right.relation) ||
    left.targetName.localeCompare(right.targetName) ||
    left.id.localeCompare(right.id)
  );
}

function compareEdgeToCursor(edge: CodeGraphEdge, cursor: CodeGraphEdgeCursor): number {
  return (
    edge.sourceName.localeCompare(cursor.sourceName) ||
    edge.relation.localeCompare(cursor.relation) ||
    edge.targetName.localeCompare(cursor.targetName) ||
    edge.id.localeCompare(cursor.id)
  );
}
