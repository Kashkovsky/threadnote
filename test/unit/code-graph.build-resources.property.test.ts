import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT,
  CODE_GRAPH_PREPARED_SPOOL_COUNT_LIMIT,
  EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE,
  transitionCodeGraphBuildResourceState,
} from '../../src/code_graph/build/resources.js';
import {
  preparedSpoolBudgetCanAdmit,
  selectCodeGraphPreparedSpoolBudgetTicket,
} from '../../src/code_graph/prepared_spool_budget.js';

const event = fc.oneof(
  fc.constant({type: 'acquire-legacy-builder'} as const),
  fc.constant({type: 'release-legacy-builder'} as const),
  fc.constant({type: 'acquire-preparation'} as const),
  fc.constant({type: 'release-preparation'} as const),
  fc.constant({type: 'acquire-writer'} as const),
  fc.constant({type: 'release-writer'} as const),
  fc.record({
    bytes: fc.integer({min: 0, max: CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT}),
    type: fc.constant('acquire-prepared-spool' as const),
  }),
  fc.record({
    bytes: fc.integer({min: 0, max: CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT}),
    type: fc.constant('release-prepared-spool' as const),
  }),
);

describe('code graph build resource properties', () => {
  it('matches an independent resource-order model for every accepted and rejected transition', () => {
    fc.assert(
      fc.property(fc.array(event, {maxLength: 200}), events => {
        let state = EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE;
        let model = EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE;
        for (const next of events) {
          let actualAccepted = true;
          try {
            state = transitionCodeGraphBuildResourceState(state, next);
          } catch {
            actualAccepted = false;
          }
          const expected = modelTransition(model, next);
          expect(actualAccepted).toBe(expected !== undefined);
          if (expected !== undefined) {
            model = expected;
            expect(state).toEqual(model);
          }
        }
      }),
      {numRuns: 300},
    );
  });

  it('admits permutations identically and only permits an oversized spool when exclusive', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({min: 0, max: CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT}), {
          maxLength: CODE_GRAPH_PREPARED_SPOOL_COUNT_LIMIT,
        }),
        fc.integer({min: 0, max: CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT * 2}),
        fc.func(fc.integer()),
        (active, requested, priority) => {
          const permuted = [...active].sort((left, right) => priority(left) - priority(right) || left - right);
          expect(preparedSpoolBudgetCanAdmit(permuted, requested)).toBe(preparedSpoolBudgetCanAdmit(active, requested));
          if (requested > CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT) {
            expect(preparedSpoolBudgetCanAdmit(active, requested)).toBe(active.length === 0);
          }
        },
      ),
      {numRuns: 300},
    );
  });

  it('selects only the oldest ticket until capacity drains, including oversized tickets', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({min: 0, max: CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT}), {
          maxLength: CODE_GRAPH_PREPARED_SPOOL_COUNT_LIMIT,
        }),
        fc.array(
          fc.record({
            bytes: fc.integer({min: 0, max: CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT * 2}),
            createdAt: fc.integer({min: 0, max: 1_000_000}),
            token: fc.stringMatching(/^[0-9a-f]{8}$/u),
          }),
          {maxLength: 20},
        ),
        (active, waiting) => {
          const ordered = [...waiting].sort(
            (left, right) =>
              left.createdAt - right.createdAt || (left.token < right.token ? -1 : left.token > right.token ? 1 : 0),
          );
          const selected = selectCodeGraphPreparedSpoolBudgetTicket(active, waiting);
          const expected = ordered[0] && preparedSpoolBudgetCanAdmit(active, ordered[0].bytes) ? ordered[0] : undefined;
          expect(selected).toEqual(expected);
        },
      ),
      {numRuns: 300},
    );
  });
});

function modelTransition(
  state: typeof EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE,
  next: Parameters<typeof transitionCodeGraphBuildResourceState>[1],
): typeof EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE | undefined {
  switch (next.type) {
    case 'acquire-legacy-builder':
      return state.legacyBuilder || state.preparation ? undefined : {...state, legacyBuilder: true};
    case 'release-legacy-builder':
      return state.legacyBuilder ? {...state, legacyBuilder: false} : undefined;
    case 'acquire-preparation':
      return state.legacyBuilder || state.preparation || state.writer ? undefined : {...state, preparation: true};
    case 'release-preparation':
      return state.preparation ? {...state, preparation: false} : undefined;
    case 'acquire-writer':
      return state.preparation || state.writer ? undefined : {...state, writer: true};
    case 'release-writer':
      return state.writer ? {...state, writer: false} : undefined;
    case 'acquire-prepared-spool': {
      const bytes = state.preparedBytes + next.bytes;
      if (
        state.preparedSpools >= CODE_GRAPH_PREPARED_SPOOL_COUNT_LIMIT ||
        (state.preparedSpools > 0 &&
          (next.bytes > CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT || bytes > CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT))
      )
        return undefined;
      return {...state, preparedBytes: bytes, preparedSpools: state.preparedSpools + 1};
    }
    case 'release-prepared-spool':
      return state.preparedSpools <= 0 || state.preparedBytes < next.bytes
        ? undefined
        : {
            ...state,
            preparedBytes: state.preparedBytes - next.bytes,
            preparedSpools: state.preparedSpools - 1,
          };
  }
}
