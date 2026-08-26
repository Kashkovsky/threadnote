import {ScriptError} from './effect/errors.js';

const BASE_DOCUMENT_COUNT = 10_000;
const SEMANTIC_QUERY_MILLISECONDS_PER_BASE = 750;
const INITIAL_BUILD_MILLISECONDS_PER_BASE = 15_000;
const INCREMENTAL_BUILD_MILLISECONDS_PER_BASE = 3_000;
// Equality can reach the gate through differently associated scale and ratio arithmetic. Bound only the
// resulting four-operation roundoff envelope; any measurement-scale overrun remains a failure.
const BUDGET_COMPARISON_ROUNDING_OPERATIONS = 4;

// Shared runners can throttle both builds together. Require incremental work to remain at least 40% faster
// while normalizing only when the same-runner initial build proves the absolute floor is not representative.
export const INCREMENTAL_BUILD_TO_INITIAL_RATIO_MAXIMUM = 0.6;

export interface RecallVectorPerformanceMeasurement {
  readonly incrementalBuildMilliseconds: number;
  readonly initialBuildMilliseconds: number;
  readonly semanticQueryP95Milliseconds: number;
}

export interface RecallVectorPerformanceBudget {
  readonly incrementalBuildLinearMaximumMilliseconds: number;
  readonly incrementalBuildMaximumMilliseconds: number;
  readonly incrementalBuildSameRunnerMaximumMilliseconds: number;
  readonly incrementalBuildWithinBudget: boolean;
  readonly initialBuildMaximumMilliseconds: number;
  readonly initialBuildWithinBudget: boolean;
  readonly semanticQueryP95MaximumMilliseconds: number;
  readonly semanticQueryWithinBudget: boolean;
  readonly sharedRunnerAdjustmentApplied: boolean;
}

export function assessRecallVectorPerformance(
  documents: number,
  measurement: RecallVectorPerformanceMeasurement,
): RecallVectorPerformanceBudget {
  if (!Number.isSafeInteger(documents) || documents <= 0) {
    throw new ScriptError('Recall vector performance budget requires a positive document count.');
  }
  assertMeasurement(measurement);

  const boundedScale = Math.max(1, documents / BASE_DOCUMENT_COUNT);
  const semanticQueryP95MaximumMilliseconds = boundedScale * SEMANTIC_QUERY_MILLISECONDS_PER_BASE;
  const initialBuildMaximumMilliseconds = boundedScale * INITIAL_BUILD_MILLISECONDS_PER_BASE;
  const incrementalBuildLinearMaximumMilliseconds = boundedScale * INCREMENTAL_BUILD_MILLISECONDS_PER_BASE;
  const incrementalBuildSameRunnerMaximumMilliseconds =
    measurement.initialBuildMilliseconds * INCREMENTAL_BUILD_TO_INITIAL_RATIO_MAXIMUM;
  const incrementalBuildMaximumMilliseconds = Math.min(
    initialBuildMaximumMilliseconds,
    Math.max(incrementalBuildLinearMaximumMilliseconds, incrementalBuildSameRunnerMaximumMilliseconds),
  );

  return {
    incrementalBuildLinearMaximumMilliseconds,
    incrementalBuildMaximumMilliseconds,
    incrementalBuildSameRunnerMaximumMilliseconds,
    incrementalBuildWithinBudget: withinFloatingPointBudget(
      measurement.incrementalBuildMilliseconds,
      incrementalBuildMaximumMilliseconds,
    ),
    initialBuildMaximumMilliseconds,
    initialBuildWithinBudget: withinFloatingPointBudget(
      measurement.initialBuildMilliseconds,
      initialBuildMaximumMilliseconds,
    ),
    semanticQueryP95MaximumMilliseconds,
    semanticQueryWithinBudget: withinFloatingPointBudget(
      measurement.semanticQueryP95Milliseconds,
      semanticQueryP95MaximumMilliseconds,
    ),
    sharedRunnerAdjustmentApplied:
      incrementalBuildSameRunnerMaximumMilliseconds > incrementalBuildLinearMaximumMilliseconds,
  };
}

function withinFloatingPointBudget(measurement: number, maximum: number): boolean {
  if (measurement <= maximum) return true;
  const magnitude = Math.max(Math.abs(measurement), Math.abs(maximum));
  const roundingTolerance = magnitude * Number.EPSILON * BUDGET_COMPARISON_ROUNDING_OPERATIONS;
  return measurement - maximum <= roundingTolerance;
}

function assertMeasurement(measurement: RecallVectorPerformanceMeasurement): void {
  for (const value of [
    measurement.incrementalBuildMilliseconds,
    measurement.initialBuildMilliseconds,
    measurement.semanticQueryP95Milliseconds,
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new ScriptError('Invalid recall vector performance measurement.');
    }
  }
}
