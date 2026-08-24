import type {CodeGraphMaterializationSpoolReadyPlan} from './materialization_spool.js';
import {CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES} from './materialization_spool_surfaces.js';

export interface CodeGraphMaterializationSpoolApplySurface {
  readonly name: string;
  readonly pageOrder?: 'ascending';
  readonly source?: string;
}

/**
 * Main-database apply cursors are intentionally distinct from physical spool
 * surfaces. The compact lexical dictionaries replay the already-sorted symbol
 * and term sources, while their singleton allocates the surrogate snapshot key
 * under the same resumable cursor contract.
 */
export const CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES = [
  {name: 'symbols', source: 'symbols'},
  {name: 'lookup', source: 'lookup'},
  {name: 'edges', source: 'edges'},
  {name: 'references', source: 'references'},
  {name: 'reexports', source: 'reexports'},
  {name: 'monikers', source: 'monikers'},
  {name: 'lexical_snapshot', pageOrder: 'ascending'},
  {name: 'lexical_symbols', pageOrder: 'ascending', source: 'symbols'},
  {name: 'lexical_terms', pageOrder: 'ascending', source: 'terms'},
  {name: 'symbol_terms', source: 'symbol_terms'},
] as const satisfies readonly CodeGraphMaterializationSpoolApplySurface[];

export function codeGraphMaterializationSpoolApplyPlan(
  ready: CodeGraphMaterializationSpoolReadyPlan,
): readonly {readonly name: string; readonly rowCount: number}[] {
  if (
    ready.surfaces.length !== CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length ||
    ready.surfaces.some(
      (surface, index) =>
        surface.name !== CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES[index]!.name ||
        !Number.isSafeInteger(surface.rowCount) ||
        surface.rowCount < 0,
    ) ||
    !Number.isSafeInteger(ready.lexicalTermCount) ||
    ready.lexicalTermCount < 0
  ) {
    throw new Error('Code graph materialization spool ready plan is invalid.');
  }
  const physicalCounts = new Map(ready.surfaces.map(surface => [surface.name, surface.rowCount]));
  return CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES.map(surface => ({
    name: surface.name,
    rowCount:
      surface.name === 'lexical_snapshot'
        ? 1
        : surface.name === 'lexical_terms'
          ? ready.lexicalTermCount
          : physicalCounts.get(surface.source!)!,
  }));
}
