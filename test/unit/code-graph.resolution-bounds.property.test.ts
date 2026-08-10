import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_RESOLUTION_PASS_MAXIMUM,
  codeGraphResolutionPassAdmitted,
} from '../../src/code_graph/store_resolution.js';

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
});
