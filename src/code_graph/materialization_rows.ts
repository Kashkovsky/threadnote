import {compareCodeUnits} from './ordering.js';
import type {CodeGraphEdge, CodeGraphSymbol} from './types.js';

export interface CodeGraphMaterializationEdgeRow {
  readonly confidence: number;
  readonly evidencePath: string;
  readonly evidenceSpanJson: string;
  readonly id: string;
  readonly provenance: CodeGraphEdge['provenance'];
  readonly relation: CodeGraphEdge['relation'];
  readonly sourceId: string | null;
  readonly sourceName: string;
  readonly targetId: string | null;
  readonly targetName: string;
}

export function codeGraphMaterializationEdgeRows(
  edges: readonly CodeGraphEdge[],
): readonly CodeGraphMaterializationEdgeRow[] {
  return [...edges]
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .map(edge => ({
      confidence: edge.confidence,
      evidencePath: edge.evidencePath,
      evidenceSpanJson: JSON.stringify(edge.evidenceSpan),
      id: edge.id,
      provenance: edge.provenance,
      relation: edge.relation,
      sourceId: edge.sourceId ?? null,
      sourceName: edge.sourceName,
      targetId: edge.targetId ?? null,
      targetName: edge.targetName,
    }));
}

export interface CodeGraphMaterializationSymbolLookupRow {
  readonly evidenceEdgeId?: string;
  readonly evidencePath: string;
  readonly exported: 0 | 1;
  readonly lookupKey: string;
  readonly provenance: 'symbol';
  readonly resolutionDomain: string;
  readonly symbolId: string;
}

export interface CodeGraphMaterializationSymbolRow {
  readonly arity: number | null;
  readonly contentHash: string;
  readonly documentation: string | null;
  readonly exported: 0 | 1;
  readonly id: string;
  readonly kind: string;
  readonly language: string;
  readonly lookupKeysJson: string;
  readonly name: string;
  readonly packageName: string | null;
  readonly path: string;
  readonly qualifiedName: string;
  readonly resolutionDomain: string | null;
  readonly resolutionScopeId: string | null;
  readonly signature: string | null;
  readonly spanJson: string;
}

export function codeGraphMaterializationSymbolRows(
  symbols: readonly CodeGraphSymbol[],
): readonly CodeGraphMaterializationSymbolRow[] {
  return [...symbols]
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .map(symbol => ({
      arity: symbol.arity ?? null,
      contentHash: symbol.contentHash,
      documentation: symbol.documentation ?? null,
      exported: symbol.exported ? 1 : 0,
      id: symbol.id,
      kind: symbol.kind,
      language: symbol.language,
      lookupKeysJson: JSON.stringify(symbol.lookupKeys ?? []),
      name: symbol.name,
      packageName: symbol.packageName ?? null,
      path: symbol.path,
      qualifiedName: symbol.qualifiedName,
      resolutionDomain: symbol.resolutionDomain ?? null,
      resolutionScopeId: symbol.resolutionScopeId ?? null,
      signature: symbol.signature ?? null,
      spanJson: JSON.stringify(symbol.span),
    }));
}

/** Canonical snapshot-independent lookup rows shared by direct and spool writers. */
export function codeGraphMaterializationSymbolLookupRows(
  symbols: readonly CodeGraphSymbol[],
): readonly CodeGraphMaterializationSymbolLookupRow[] {
  const rows = new Map<string, CodeGraphMaterializationSymbolLookupRow>();
  for (const symbol of symbols) {
    for (const lookupKey of symbol.lookupKeys ?? []) {
      const identity = `${lookupKey}\0${symbol.id}`;
      if (rows.has(identity)) continue;
      rows.set(identity, {
        evidencePath: symbol.path,
        exported: symbol.exported ? 1 : 0,
        lookupKey,
        provenance: 'symbol',
        resolutionDomain: codeGraphLookupDomain(lookupKey, symbol.resolutionDomain),
        symbolId: symbol.id,
      });
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      compareCodeUnits(left.lookupKey, right.lookupKey) || compareCodeUnits(left.symbolId, right.symbolId),
  );
}

export function codeGraphLookupDomain(lookupKey: string, fallback: string | undefined): string {
  const separator = lookupKey.indexOf(':');
  return separator > 0 ? lookupKey.slice(0, separator) : (fallback ?? 'generic');
}
