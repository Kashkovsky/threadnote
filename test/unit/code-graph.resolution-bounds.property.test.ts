import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_RESOLUTION_PASS_MAXIMUM,
  codeGraphResolutionPassAdmitted,
} from '../../src/code_graph/store_resolution.js';
import {aggregatePersistentReferenceResolutionCapacityBoundaries} from '../../src/code_graph/store_resolution_core.js';

describe('code graph resolution pass bounds', () => {
  it('admits exactly the finite non-negative pass prefix', () => {
    fc.assert(
      fc.property(fc.integer({max: 1_000, min: -1_000}), completed => {
        expect(codeGraphResolutionPassAdmitted(completed)).toBe(
          completed >= 0 && completed < CODE_GRAPH_RESOLUTION_PASS_MAXIMUM,
        );
      }),
      {numRuns: 250},
    );
    expect(codeGraphResolutionPassAdmitted(Number.POSITIVE_INFINITY)).toBe(false);
    expect(codeGraphResolutionPassAdmitted(1.5)).toBe(false);
  });

  it('aggregates compatible page capacities without overflow or order dependence', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            finalFactBytes: fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
            rowCount: fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
          }),
          {maxLength: 16, minLength: 1},
        ),
        pages => {
          const boundaries = pages.map(page => ({
            ...page,
            operation: 'resolve persistent code graph references' as const,
          }));
          const expectedBytes = pages.reduce((total, page) => total + BigInt(page.finalFactBytes), 0n);
          const expectedRows = pages.reduce((total, page) => total + BigInt(page.rowCount), 0n);
          const maximum = BigInt(Number.MAX_SAFE_INTEGER);
          const expected = {
            finalFactBytes: Number(expectedBytes > maximum ? maximum : expectedBytes),
            operation: 'resolve persistent code graph references',
            rowCount: Number(expectedRows > maximum ? maximum : expectedRows),
          };
          expect(aggregatePersistentReferenceResolutionCapacityBoundaries(boundaries)).toEqual(expected);
          expect(aggregatePersistentReferenceResolutionCapacityBoundaries([...boundaries].reverse())).toEqual(expected);
        },
      ),
      {numRuns: 250},
    );
  });

  it('fails closed for absent, invalid, or incompatible capacity evidence', () => {
    expect(aggregatePersistentReferenceResolutionCapacityBoundaries([])).toMatchObject({
      finalFactBytes: Number.NaN,
      rowCount: Number.NaN,
    });
    expect(
      aggregatePersistentReferenceResolutionCapacityBoundaries([
        {finalFactBytes: 1, operation: 'resolve persistent code graph references', rowCount: 1},
        {
          finalFactBytes: 1,
          mainFilesystem: 'temporary',
          operation: 'resolve temporary code graph references',
          rowCount: 1,
          transientFilesystem: 'temporary',
        },
      ]),
    ).toMatchObject({finalFactBytes: Number.NaN, rowCount: Number.NaN});
    expect(
      aggregatePersistentReferenceResolutionCapacityBoundaries([
        {finalFactBytes: Number.NaN, operation: 'resolve persistent code graph references', rowCount: 1},
      ]),
    ).toMatchObject({finalFactBytes: Number.NaN, rowCount: Number.NaN});
  });
});
