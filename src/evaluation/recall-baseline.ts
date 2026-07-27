import {Schema} from 'effect';
import {
  RECALL_EVALUATION_CATEGORIES,
  type RecallEvaluationCategory,
  type RecallEvaluationMetricSetV1,
  type RecallEvaluationResultV1,
} from './recall.js';

export const RECALL_BASELINE_VERSION = 1 as const;

export interface RecallEvaluationBaselineV1 {
  readonly createdAt: string;
  readonly fixture: {
    readonly documents: number;
    readonly hash: string;
    readonly queries: number;
    readonly version: number;
  };
  readonly knownContractFailures: number;
  readonly result: {
    readonly categories: Partial<Record<RecallEvaluationCategory, RecallEvaluationMetricSetV1>>;
    readonly metrics: RecallEvaluationMetricSetV1;
    readonly pipeline: RecallEvaluationResultV1['pipeline'];
  };
  readonly source: {
    readonly openVikingVersion: string;
    readonly rankerVersion: string;
    readonly threadnoteVersion: string;
  };
  readonly version: typeof RECALL_BASELINE_VERSION;
}

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Rate = NonNegativeFinite.check(Schema.isLessThanOrEqualTo(1));
const MetricSet = Schema.Struct({
  answerableQueries: NonNegativeFinite,
  authorityInversionRate: Rate,
  averageCandidatesRead: NonNegativeFinite,
  averageContextCharacters: NonNegativeFinite,
  averageContextTokens: NonNegativeFinite,
  expansionFallbackRate: Rate,
  expansionInvocationRate: Rate,
  explanationCoverage: Rate,
  forbiddenHitRate: Rate,
  meanNdcgAt10: Rate,
  meanNdcgAt5: Rate,
  meanReciprocalRank: Rate,
  noAnswerF1: Rate,
  noAnswerPrecision: Rate,
  noAnswerRecall: Rate,
  queryCount: NonNegativeFinite,
  recallAt1: Rate,
  recallAt10: Rate,
  recallAt5: Rate,
  staleHitRate: Rate,
});
const Categories = Schema.Struct(
  Object.fromEntries(RECALL_EVALUATION_CATEGORIES.map(category => [category, Schema.optionalKey(MetricSet)])) as Record<
    RecallEvaluationCategory,
    ReturnType<typeof Schema.optionalKey<typeof MetricSet>>
  >,
);

export const RecallEvaluationBaselineSchemaV1 = Schema.Struct({
  createdAt: NonEmptyString,
  fixture: Schema.Struct({
    documents: NonNegativeFinite,
    hash: NonEmptyString,
    queries: NonNegativeFinite,
    version: NonNegativeFinite,
  }),
  knownContractFailures: NonNegativeFinite,
  result: Schema.Struct({
    categories: Categories,
    metrics: MetricSet,
    pipeline: Schema.Struct({
      model: Schema.optionalKey(NonEmptyString),
      name: NonEmptyString,
      revision: Schema.optionalKey(NonEmptyString),
    }),
  }),
  source: Schema.Struct({
    openVikingVersion: NonEmptyString,
    rankerVersion: NonEmptyString,
    threadnoteVersion: NonEmptyString,
  }),
  version: Schema.Literal(RECALL_BASELINE_VERSION),
});

export function parseRecallEvaluationBaselineV1(value: unknown): RecallEvaluationBaselineV1 {
  const baseline = Schema.decodeUnknownSync(RecallEvaluationBaselineSchemaV1)(value) as RecallEvaluationBaselineV1;
  for (const [name, value] of [
    ['fixture.documents', baseline.fixture.documents],
    ['fixture.queries', baseline.fixture.queries],
    ['fixture.version', baseline.fixture.version],
    ['knownContractFailures', baseline.knownContractFailures],
  ] as const) {
    if (!Number.isInteger(value)) throw new Error(`Recall baseline ${name} must be an integer`);
  }
  return baseline;
}

export function baselineResult(baseline: RecallEvaluationBaselineV1): RecallEvaluationResultV1 {
  return {
    ...baseline.result,
    failures: Array.from({length: baseline.knownContractFailures}, (_, index) => `known-baseline-defect-${index}`),
    queryResults: [],
    version: 1,
  };
}
