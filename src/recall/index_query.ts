import {indexTerms} from './index_lexical.js';

const LOGICAL_RESULT_OVERFETCH_MULTIPLIER = 8;
const MINIMUM_LOGICAL_RESULT_OVERFETCH = 256;
const MAXIMUM_LOGICAL_RESULT_OVERFETCH = 4_096;

type RecallStatisticRequest =
  | {readonly query?: string}
  | {readonly selections: readonly {readonly query?: string}[]}
  | {readonly terms: readonly string[]};

export function boundedRecallPhysicalCandidateLimit(logicalLimit: number): number {
  return Math.min(
    MAXIMUM_LOGICAL_RESULT_OVERFETCH,
    Math.max(MINIMUM_LOGICAL_RESULT_OVERFETCH, logicalLimit * LOGICAL_RESULT_OVERFETCH_MULTIPLIER),
  );
}

export function recallStatisticTerms(options: RecallStatisticRequest): readonly string[] {
  if ('terms' in options) return [];
  const queries =
    'selections' in options
      ? options.selections.flatMap(selection => (selection.query === undefined ? [] : [selection.query]))
      : options.query === undefined
        ? []
        : [options.query];
  return [...new Set(queries.flatMap(indexTerms))];
}
