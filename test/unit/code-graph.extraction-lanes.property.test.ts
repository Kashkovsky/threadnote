import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codeGraphExtractionGroupIsHighCost,
  planCodeGraphExtractionLanes,
} from '../../src/code_graph/extraction_lanes.js';

describe('code graph extraction lanes', () => {
  it('preserves every reuse group in order while isolating each high-cost group', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            files: fc.array(
              fc.record({
                language: fc.constantFrom('typescript', 'json', 'yaml', 'python'),
                size: fc.integer({max: 2 * 1_048_576, min: 0}),
              }),
              {maxLength: 4, minLength: 1},
            ),
            id: fc.uuid(),
          }),
          {maxLength: 40},
        ),
        fc.integer({max: 16, min: 1}),
        (groups, capacity) => {
          const first = planCodeGraphExtractionLanes(groups, capacity);
          const second = planCodeGraphExtractionLanes(groups, capacity);
          expect(first).toEqual(second);
          expect(first.flatMap(lane => lane.groups.map(group => group.id))).toEqual(groups.map(group => group.id));
          for (const lane of first) {
            expect(lane.concurrency).toBeLessThanOrEqual(capacity);
            if (lane.kind === 'isolated-high-cost') {
              expect(lane.concurrency).toBe(1);
              expect(lane.groups).toHaveLength(1);
              expect(codeGraphExtractionGroupIsHighCost(lane.groups[0]!)).toBe(true);
            } else {
              expect(lane.groups.every(group => !codeGraphExtractionGroupIsHighCost(group))).toBe(true);
            }
          }
        },
      ),
      {numRuns: 250},
    );
  });
});
