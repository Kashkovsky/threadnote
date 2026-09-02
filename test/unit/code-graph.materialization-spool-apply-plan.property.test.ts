import {expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  codeGraphMaterializationSpoolApplyPlan,
  CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES,
} from '../../src/code_graph/materialization_spool_apply_surfaces.js';
import {CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES} from '../../src/code_graph/materialization_spool_surfaces.js';

it.prop(
  'maps physical row counts to every resumable main surface without mutation',
  {
    lexicalTermCount: FC.integer({max: 1_000_000, min: 0}),
    rowCounts: FC.array(FC.integer({max: 1_000_000, min: 0}), {
      maxLength: CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length,
      minLength: CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length,
    }),
  },
  ({lexicalTermCount, rowCounts}) => {
    const surfaces = CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.map((surface, index) => ({
      name: surface.name,
      rowCount: rowCounts[index],
    }));
    const plan = codeGraphMaterializationSpoolApplyPlan({
      batches: [],
      lexicalTermCount,
      spoolIdentity: 'a'.repeat(64),
      surfaces,
    });
    expect(plan.map(surface => surface.name)).toEqual(
      CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES.map(surface => surface.name),
    );
    expect(plan.map(surface => surface.rowCount)).toEqual([
      rowCounts[0],
      rowCounts[1],
      rowCounts[2],
      rowCounts[3],
      rowCounts[4],
      rowCounts[5],
      1,
      rowCounts[0],
      lexicalTermCount,
      rowCounts[6],
    ]);
    expect(surfaces.map(surface => surface.rowCount)).toEqual(rowCounts);
  },
  {fastCheck: {numRuns: 100}},
);
