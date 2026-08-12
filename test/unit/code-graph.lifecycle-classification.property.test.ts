import {TestError} from '../helpers/test-error.js';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_LIFECYCLE_PROTECTIONS,
  classifyCodeGraphLifecycle,
  planCodeGraphLifecycleReclamation,
  type CodeGraphLifecycleCandidate,
  type CodeGraphLifecycleProtection,
  type CodeGraphLifecycleState,
} from '../../src/code_graph/lifecycle_classification.js';
import {selectCodeGraphLifecycleOpportunityTarget} from '../../src/code_graph/lifecycle_opportunity.js';

const reclaimableState = fc.constantFrom<CodeGraphLifecycleState>(
  'missing-view',
  'abandoned-build',
  'orphaned-sidecar',
  'retired-generation',
);
const protection = fc.constantFrom<CodeGraphLifecycleProtection>(...CODE_GRAPH_LIFECYCLE_PROTECTIONS);

describe('code graph lifecycle classification properties', () => {
  it('lets every active protection dominate otherwise valid destructive authority', () => {
    fc.assert(
      fc.property(reclaimableState, fc.uniqueArray(protection, {minLength: 1}), (state, protections) => {
        const classified = classifyCodeGraphLifecycle({authority: 'proven-disposable', protections, state});
        expect(classified).toMatchObject({action: 'preserve', disposition: 'preserve', reason: 'protected'});
        expect(classified.protections).toEqual([...protections].sort());
      }),
      {numRuns: 120},
    );
  });

  it('never converts unreadability, corruption, or a required clean base into automatic deletion', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<CodeGraphLifecycleState>('unreadable-store', 'corrupt-store', 'required-clean-base'),
        fc.array(protection),
        (state, protections) => {
          expect(classifyCodeGraphLifecycle({authority: 'proven-disposable', protections, state}).disposition).not.toBe(
            'reclaim',
          );
        },
      ),
      {numRuns: 80},
    );
  });

  it('plans a bounded order-independent reclaim sequence that converges and is idempotent', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            authority: fc.constantFrom('proven-disposable' as const, 'unproven' as const),
            id: fc.string({maxLength: 24, minLength: 1}),
            protected: fc.boolean(),
            state: reclaimableState,
          }),
          {maxLength: 64, selector: value => value.id},
        ),
        values => {
          const candidates: readonly CodeGraphLifecycleCandidate[] = values.map(value => ({
            id: value.id,
            lifecycle: {
              authority: value.authority,
              protections: value.protected ? ['active-writer'] : [],
              state: value.state,
            },
          }));
          const expected = candidates
            .filter(candidate => classifyCodeGraphLifecycle(candidate.lifecycle).disposition === 'reclaim')
            .map(candidate => candidate.id)
            .sort();
          expect(planCodeGraphLifecycleReclamation([...candidates].reverse(), 64).map(value => value.id)).toEqual(
            expected,
          );

          let remaining = [...candidates];
          const reclaimed: string[] = [];
          for (let step = 0; step <= candidates.length; step += 1) {
            const page = planCodeGraphLifecycleReclamation(remaining, 1);
            if (page.length === 0) break;
            reclaimed.push(page[0]!.id);
            remaining = remaining.filter(candidate => candidate.id !== page[0]!.id);
          }
          expect(reclaimed).toEqual(expected);
          expect(planCodeGraphLifecycleReclamation(remaining, 1)).toEqual([]);
          expect(planCodeGraphLifecycleReclamation(remaining, 1)).toEqual([]);
        },
      ),
      {numRuns: 120},
    );
  });

  it('rotates lifecycle opportunities fairly regardless of catalog order', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([0, 1, 2, 3], {maxLength: 4, minLength: 4}), order => {
        const targets = order.map(index => ({
          checkoutId: index.toString(16).repeat(64),
          databasePath: `/database/${index}`,
        }));
        const visited: string[] = [];
        let cursor: string | undefined;
        for (let index = 0; index < targets.length; index += 1) {
          const selected = selectCodeGraphLifecycleOpportunityTarget(targets, cursor);
          if (!selected) throw new TestError('valid lifecycle target was not selected');
          visited.push(selected.checkoutId);
          cursor = `${selected.checkoutId}\0${selected.databasePath}`;
        }
        expect(visited).toEqual(['0'.repeat(64), '1'.repeat(64), '2'.repeat(64), '3'.repeat(64)]);
        expect(selectCodeGraphLifecycleOpportunityTarget(targets, cursor)?.checkoutId).toBe('0'.repeat(64));
      }),
      {numRuns: 40},
    );
  });
});
