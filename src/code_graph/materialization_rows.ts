import {compareCodeUnits} from './ordering.js';
import type {CodeGraphSymbol} from './types.js';

export interface CodeGraphMaterializationSymbolLookupRow {
  readonly evidenceEdgeId?: string;
  readonly evidencePath: string;
  readonly exported: 0 | 1;
  readonly lookupKey: string;
  readonly provenance: 'symbol';
  readonly resolutionDomain: string;
  readonly symbolId: string;
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
