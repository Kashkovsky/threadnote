import type {Database} from 'bun:sqlite';
import type {CodeGraphMonikerV1} from './cross_repository/types.js';
import {
  codeGraphMaterializationEdgeRows,
  codeGraphMaterializationMonikerRows,
  codeGraphMaterializationReferenceRows,
  codeGraphMaterializationReexportRows,
  codeGraphMaterializationSymbolLookupRows,
  codeGraphMaterializationSymbolRows,
  codeGraphMaterializationSymbolTermRows,
  type CodeGraphMaterializationEdgeRow,
  type CodeGraphMaterializationMonikerRow,
  type CodeGraphMaterializationReferenceRow,
  type CodeGraphMaterializationSymbolLookupRow,
  type CodeGraphMaterializationSymbolRow,
  type CodeGraphMaterializationSymbolTermRow,
} from './materialization_rows.js';
import type {CodeGraphReusableReexport} from './store_models.js';
import type {CodeGraphEdge, CodeGraphReference, CodeGraphSymbol} from './types.js';

const SPOOL_INSERT_PARAMETER_MAXIMUM = 32_000;
const SPOOL_INSERT_ROW_MAXIMUM = 4_000;

export interface CodeGraphMaterializationSpoolFactBatch {
  readonly directEdges: readonly CodeGraphEdge[];
  readonly monikers: readonly CodeGraphMonikerV1[];
  readonly referenceEdges: ReadonlyMap<string, CodeGraphEdge>;
  readonly references: readonly CodeGraphReference[];
  readonly symbols: readonly CodeGraphSymbol[];
  readonly termsBySymbol: ReadonlyMap<CodeGraphSymbol, readonly (readonly [string, number])[]>;
}

export interface PreparedCodeGraphMaterializationSpoolFactBatch {
  readonly edges: readonly CodeGraphMaterializationEdgeRow[];
  readonly lookup: readonly CodeGraphMaterializationSymbolLookupRow[];
  readonly monikers: readonly CodeGraphMaterializationMonikerRow[];
  readonly references: readonly CodeGraphMaterializationReferenceRow[];
  readonly reexports: readonly CodeGraphReusableReexport[];
  readonly rowCount: number;
  readonly symbolTerms: readonly CodeGraphMaterializationSymbolTermRow[];
  readonly symbols: readonly CodeGraphMaterializationSymbolRow[];
}

export function prepareCodeGraphMaterializationSpoolFactBatch(
  batch: CodeGraphMaterializationSpoolFactBatch,
): PreparedCodeGraphMaterializationSpoolFactBatch {
  const prepared = {
    edges: codeGraphMaterializationEdgeRows(batch.directEdges),
    lookup: codeGraphMaterializationSymbolLookupRows(batch.symbols),
    monikers: codeGraphMaterializationMonikerRows(batch.monikers),
    references: codeGraphMaterializationReferenceRows(batch.references, batch.referenceEdges),
    reexports: codeGraphMaterializationReexportRows(batch.references),
    symbolTerms: codeGraphMaterializationSymbolTermRows(batch.symbols, batch.termsBySymbol),
    symbols: codeGraphMaterializationSymbolRows(batch.symbols),
  };
  return {
    ...prepared,
    rowCount: Object.values(prepared).reduce((total, rows) => total + rows.length, 0),
  };
}

export function appendCodeGraphMaterializationSpoolFactBatch(
  database: Database,
  batch: PreparedCodeGraphMaterializationSpoolFactBatch,
): void {
  insertRows(database, 'symbols', 16, batch.symbols, row => [
    row.id,
    row.contentHash,
    row.kind,
    row.name,
    row.qualifiedName,
    row.path,
    row.language,
    row.arity,
    row.lookupKeysJson,
    row.resolutionDomain,
    row.resolutionScopeId,
    row.packageName,
    row.exported,
    row.signature,
    row.documentation,
    row.spanJson,
  ]);
  insertRows(database, 'lookup', 7, batch.lookup, row => [
    row.lookupKey,
    row.symbolId,
    row.resolutionDomain,
    row.exported,
    row.provenance,
    row.evidenceEdgeId ?? null,
    row.evidencePath,
  ]);
  insertRows(database, 'edges', 10, batch.edges, row => [
    row.id,
    row.sourceId,
    row.sourceName,
    row.relation,
    row.targetId,
    row.targetName,
    row.provenance,
    row.confidence,
    row.evidencePath,
    row.evidenceSpanJson,
  ]);
  insertRows(database, 'references', 15, batch.references, row => [
    row.edgeId,
    row.resolutionDomain,
    row.exportedOnly,
    row.aliasLookupKeysJson,
    row.lookupTiersJson,
    row.candidateCount,
    row.candidatePayloadBytes,
    row.sourceId,
    row.sourceName,
    row.relation,
    row.targetName,
    row.provenance,
    row.confidence,
    row.evidencePath,
    row.evidenceSpanJson,
  ]);
  insertRows(database, 'reexports', 4, batch.reexports, row => [
    row.sourcePath,
    row.localName,
    row.targetPath,
    row.importedName,
  ]);
  insertRows(database, 'monikers', 16, batch.monikers, row => [
    row.id,
    row.version,
    row.scheme,
    row.role,
    row.kind,
    row.resolutionDomain,
    row.identity,
    row.packageName,
    row.packageVersion,
    row.importPath,
    row.qualifiedName,
    row.componentId,
    row.symbolId,
    row.dependencyKind,
    row.evidencePath,
    row.evidenceSpanJson,
  ]);
  insertRows(database, 'symbol_terms', 3, batch.symbolTerms, row => [row.term, row.symbolId, row.weight]);
}

function insertRows<Row>(
  database: Database,
  surface: string,
  columnCount: number,
  rows: readonly Row[],
  parameters: (row: Row) => readonly (number | string | null)[],
): void {
  const pageRows = Math.min(SPOOL_INSERT_ROW_MAXIMUM, Math.floor(SPOOL_INSERT_PARAMETER_MAXIMUM / columnCount));
  for (let offset = 0; offset < rows.length; offset += pageRows) {
    const page = rows.slice(offset, offset + pageRows);
    const placeholders = `(${Array.from({length: columnCount}, () => '?').join(', ')})`;
    database
      .prepare(`INSERT INTO materialization_raw_${surface} VALUES ${page.map(() => placeholders).join(', ')}`)
      .run(...page.flatMap(row => [...parameters(row)]));
  }
}
