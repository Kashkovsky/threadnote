import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  assessRecallVectorPerformance,
  INCREMENTAL_BUILD_TO_INITIAL_RATIO_MAXIMUM,
} from '../../scripts/recall-vector-performance-budget.js';

describe('recall vector performance budget', () => {
  it('accepts the exact 60% boundary after a threefold common-runner slowdown', () => {
    const initialBuildMilliseconds = 2_992;
    const ratioBasisPoints = 6_000;
    const slowdown = 3;
    const ratio = ratioBasisPoints / 10_000;
    const measurement = {
      incrementalBuildMilliseconds: initialBuildMilliseconds * ratio * slowdown,
      initialBuildMilliseconds: initialBuildMilliseconds * slowdown,
      semanticQueryP95Milliseconds: 50,
    };
    const budget = assessRecallVectorPerformance(10_000, measurement);

    expect(ratio).toBe(INCREMENTAL_BUILD_TO_INITIAL_RATIO_MAXIMUM);
    expect(measurement.incrementalBuildMilliseconds).toBeGreaterThan(budget.incrementalBuildMaximumMilliseconds);
    expect(budget.initialBuildWithinBudget).toBe(true);
    expect(budget.incrementalBuildWithinBudget).toBe(true);
  });

  it('normalizes the preserved failed sample against its same-runner initial build', () => {
    const budget = assessRecallVectorPerformance(10_000, {
      incrementalBuildMilliseconds: 3_899.673482,
      initialBuildMilliseconds: 8_730.164416,
      semanticQueryP95Milliseconds: 55.508846,
    });

    expect(budget.incrementalBuildLinearMaximumMilliseconds).toBe(3_000);
    expect(budget.incrementalBuildSameRunnerMaximumMilliseconds).toBeCloseTo(5_238.09865, 5);
    expect(budget.sharedRunnerAdjustmentApplied).toBe(true);
    expect(budget.initialBuildWithinBudget).toBe(true);
    expect(budget.incrementalBuildWithinBudget).toBe(true);
    expect(budget.semanticQueryWithinBudget).toBe(true);
  });

  it('still rejects a disproportionate incremental regression on an ordinary runner', () => {
    const budget = assessRecallVectorPerformance(10_000, {
      incrementalBuildMilliseconds: 3_001,
      initialBuildMilliseconds: 2_500,
      semanticQueryP95Milliseconds: 50,
    });

    expect(budget.sharedRunnerAdjustmentApplied).toBe(false);
    expect(budget.incrementalBuildMaximumMilliseconds).toBe(3_000);
    expect(budget.incrementalBuildWithinBudget).toBe(false);
  });

  it('retains the independent initial-build and semantic-query watchdogs', () => {
    const budget = assessRecallVectorPerformance(10_000, {
      incrementalBuildMilliseconds: 1_200,
      initialBuildMilliseconds: 15_001,
      semanticQueryP95Milliseconds: 751,
    });

    expect(budget.initialBuildMaximumMilliseconds).toBe(15_000);
    expect(budget.initialBuildWithinBudget).toBe(false);
    expect(budget.semanticQueryP95MaximumMilliseconds).toBe(750);
    expect(budget.semanticQueryWithinBudget).toBe(false);
  });

  it.prop(
    'preserves a ratio-bounded result under common runner slowdown while the initial watchdog holds',
    {
      initialBuildMilliseconds: FC.integer({max: 3_000, min: 1_500}),
      ratioBasisPoints: FC.integer({max: 6_000, min: 1_000}),
      slowdown: FC.integer({max: 5, min: 2}),
    },
    ({initialBuildMilliseconds, ratioBasisPoints, slowdown}) => {
      const incrementalBuildMilliseconds = initialBuildMilliseconds * (ratioBasisPoints / 10_000);
      const measurement = {
        incrementalBuildMilliseconds: incrementalBuildMilliseconds * slowdown,
        initialBuildMilliseconds: initialBuildMilliseconds * slowdown,
        semanticQueryP95Milliseconds: 50,
      };
      const budget = assessRecallVectorPerformance(10_000, measurement);

      expect(budget.initialBuildWithinBudget).toBe(true);
      expect(budget.incrementalBuildWithinBudget).toBe(true);
      if (measurement.initialBuildMilliseconds * INCREMENTAL_BUILD_TO_INITIAL_RATIO_MAXIMUM > 3_000) {
        expect(budget.sharedRunnerAdjustmentApplied).toBe(true);
      }
    },
    {fastCheck: {numRuns: 200}},
  );

  it.prop(
    'rejects incremental work above both the linear floor and same-runner ratio',
    {
      initialBuildMilliseconds: FC.integer({max: 15_000, min: 5_000}),
      excessMilliseconds: FC.integer({max: 1_000, min: 1}),
    },
    ({excessMilliseconds, initialBuildMilliseconds}) => {
      const budget = assessRecallVectorPerformance(10_000, {
        incrementalBuildMilliseconds:
          initialBuildMilliseconds * INCREMENTAL_BUILD_TO_INITIAL_RATIO_MAXIMUM + excessMilliseconds,
        initialBuildMilliseconds,
        semanticQueryP95Milliseconds: 50,
      });

      expect(budget.incrementalBuildWithinBudget).toBe(false);
    },
    {fastCheck: {numRuns: 200}},
  );

  it.prop(
    'accepts reassociated equality without admitting a one-nanosecond ratio overrun',
    {
      initialBuildMilliseconds: FC.integer({max: 3_000, min: 2_501}),
      slowdown: FC.integer({max: 5, min: 2}),
    },
    ({initialBuildMilliseconds, slowdown}) => {
      const incrementalBuildMilliseconds =
        initialBuildMilliseconds * INCREMENTAL_BUILD_TO_INITIAL_RATIO_MAXIMUM * slowdown;
      const measurement = {
        incrementalBuildMilliseconds,
        initialBuildMilliseconds: initialBuildMilliseconds * slowdown,
        semanticQueryP95Milliseconds: 50,
      };

      expect(assessRecallVectorPerformance(10_000, measurement).incrementalBuildWithinBudget).toBe(true);
      expect(
        assessRecallVectorPerformance(10_000, {
          ...measurement,
          incrementalBuildMilliseconds: incrementalBuildMilliseconds + 0.000_001,
        }).incrementalBuildWithinBudget,
      ).toBe(false);
    },
    {fastCheck: {numRuns: 200}},
  );
});
