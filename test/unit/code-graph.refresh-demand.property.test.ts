import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  deferCodeGraphRefreshDemand,
  emptyCodeGraphRefreshDemand,
  enqueueCodeGraphRefreshDemand,
  registerCodeGraphRefreshDemand,
} from '../../src/code_graph/refresh_demand_scheduler.js';

const checkout = 'a'.repeat(64);
const worktree = 'b'.repeat(64);
const target = fc.array(fc.integer({min: 0, max: 15}), {minLength: 1, maxLength: 8}).map(value =>
  value
    .map(part => part.toString(16))
    .join('')
    .padEnd(64, '0')
    .slice(0, 64),
);

describe('code graph refresh demand properties', () => {
  it('coalesces every preflight sequence to one latest desired target without claiming ownership', () => {
    fc.assert(
      fc.property(fc.array(target, {maxLength: 40}), targets => {
        const state = targets.reduce(
          (current, targetKey, index) =>
            enqueueCodeGraphRefreshDemand(current, {
              now: index,
              targetKey,
              token: `cgdq_${index.toString(16).padStart(32, '0')}`,
            }).state,
          emptyCodeGraphRefreshDemand(checkout, worktree),
        );

        expect(state.active).toBeUndefined();
        expect(state.desired?.targetKey).toBe(targets.at(-1));
      }),
      {numRuns: 200},
    );
  });

  it('is deterministic and makes the final observed target authoritative', () => {
    fc.assert(
      fc.property(fc.array(target, {maxLength: 40}), targets => {
        let state = emptyCodeGraphRefreshDemand(checkout, worktree);
        for (const [index, targetKey] of targets.entries()) {
          state = registerCodeGraphRefreshDemand(state, {
            now: index,
            targetKey,
            token: `cgdq_${index.toString(16).padStart(32, '0')}`,
          }).state;
        }
        if (targets.length === 0) return;
        expect(state.active?.targetKey).toBe(targets[0]);
        const latest = targets.at(-1)!;
        expect(state.desired?.targetKey).toBe(latest === targets[0] ? undefined : latest);
        const replay = targets.reduce(
          (current, targetKey, index) =>
            registerCodeGraphRefreshDemand(current, {
              now: index,
              targetKey,
              token: `cgdq_${index.toString(16).padStart(32, '0')}`,
            }).state,
          emptyCodeGraphRefreshDemand(checkout, worktree),
        );
        expect(replay).toEqual(state);
      }),
      {numRuns: 200},
    );
  });

  it('carries a capped monotonic retry attempt through every reclaimed target', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 12}), failures => {
        const targetKey = '1'.repeat(64);
        const targetToken = 'cgdq_11111111111111111111111111111111';
        let now = 0;
        let state = registerCodeGraphRefreshDemand(emptyCodeGraphRefreshDemand(checkout, worktree), {
          now,
          targetKey,
          token: targetToken,
        }).state;
        for (let attempt = 1; attempt <= failures; attempt += 1) {
          state = deferCodeGraphRefreshDemand(state, targetToken, targetKey, now);
          const expectedAttempt = Math.min(8, attempt);
          expect(state.desired?.retry?.attempt).toBe(expectedAttempt);
          const delay = Math.min(60_000, 250 * 2 ** (expectedAttempt - 1));
          expect(state.desired?.retry?.notBefore).toBe(now + delay);
          now += delay;
          const claimed = registerCodeGraphRefreshDemand(state, {now, targetKey, token: targetToken});
          expect(claimed.type).toBe('claimed');
          state = claimed.state;
        }
      }),
      {numRuns: 100},
    );
  });
});
