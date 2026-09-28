import {deriveRecallEligibilityPolicy} from './eligibility.js';
import {rankRecallCandidates, shouldExpandRecall, type RecallCandidate, type RecallConfidenceLevel} from './rank.js';

export interface RecallEvaluationQuery {
  readonly expandedSemanticScores?: Readonly<Record<string, number>>;
  readonly expectedAnswerability: 'answerable' | 'no_answer';
  readonly expectedExpansion?: boolean;
  readonly forbiddenUris?: readonly string[];
  readonly id: string;
  readonly now?: string;
  readonly project?: string;
  readonly query: string;
  readonly relevance: Readonly<Record<string, number>>;
  readonly requiredReasonCodes?: readonly string[];
  readonly seedUris?: readonly string[];
  readonly semanticScores?: Readonly<Record<string, number>>;
}

export interface RecallEvaluationFixture {
  readonly documents: readonly RecallCandidate[];
  readonly queries: readonly RecallEvaluationQuery[];
  readonly version: 1;
}

export interface RecallEvaluationMetrics {
  readonly averageContextTokens: number;
  readonly meanNdcgAt5: number;
  readonly meanReciprocalRank: number;
  readonly noAnswerPrecision: number;
  readonly noAnswerRecall: number;
  readonly recallAt5: number;
  readonly requiredReasonsPresent: boolean;
  readonly staleHitRate: number;
}

export interface RecallEvaluationResult {
  readonly failures: readonly string[];
  readonly metrics: RecallEvaluationMetrics;
  readonly queryResults: readonly {
    readonly confidence: RecallConfidenceLevel;
    readonly expanded: boolean;
    readonly id: string;
    readonly initialConfidence: RecallConfidenceLevel;
    readonly rankedUris: readonly string[];
  }[];
  readonly version: 1;
}

const EVALUATION_CUTOFF = 5;
const ESTIMATED_CHARACTERS_PER_TOKEN = 4;

export function evaluateRecallFixture(fixture: RecallEvaluationFixture): RecallEvaluationResult {
  const failures: string[] = [];
  const ndcgScores: number[] = [];
  const reciprocalRanks: number[] = [];
  let relevantExpected = 0;
  let relevantFound = 0;
  let forbiddenHits = 0;
  let returnedHits = 0;
  let predictedNoAnswer = 0;
  let expectedNoAnswer = 0;
  let correctNoAnswer = 0;
  let contextTokens = 0;
  let requiredReasonsPresent = true;
  const queryResults: Array<{
    readonly confidence: RecallConfidenceLevel;
    readonly expanded: boolean;
    readonly id: string;
    readonly initialConfidence: RecallConfidenceLevel;
    readonly rankedUris: readonly string[];
  }> = [];

  for (const query of fixture.queries) {
    const rankWithSemanticScores = (semanticScores: Readonly<Record<string, number>>) =>
      rankRecallCandidates(
        query.query,
        fixture.documents.map(document => ({
          ...document,
          semantic: semanticScores[document.uri] ?? 0,
        })),
        {
          eligibility: deriveRecallEligibilityPolicy({
            explicitProject: query.project,
            originalQuery: query.query,
          }),
          now: query.now ? new Date(query.now) : undefined,
          project: query.project,
          seedUris: query.seedUris,
        },
      );
    const initial = rankWithSemanticScores(query.semanticScores ?? {});
    const expanded =
      shouldExpandRecall(initial.confidence) &&
      query.expandedSemanticScores !== undefined &&
      Object.keys(query.expandedSemanticScores).length > 0;
    const ranked = expanded
      ? rankWithSemanticScores(
          Object.fromEntries(
            fixture.documents.map(document => [
              document.uri,
              Math.max(query.semanticScores?.[document.uri] ?? 0, query.expandedSemanticScores?.[document.uri] ?? 0),
            ]),
          ),
        )
      : initial;
    const top = ranked.results.slice(0, EVALUATION_CUTOFF);
    const rankedUris = top.map(result => result.candidate.uri);
    queryResults.push({
      confidence: ranked.confidence.level,
      expanded,
      id: query.id,
      initialConfidence: initial.confidence.level,
      rankedUris,
    });
    if (query.expectedExpansion !== undefined && expanded !== query.expectedExpansion) {
      failures.push(`${query.id}: expected expansion ${query.expectedExpansion}, got ${expanded}`);
    }
    const relevantUris = Object.entries(query.relevance)
      .filter(([, grade]) => grade > 0)
      .map(([uri]) => uri);
    relevantExpected += relevantUris.length;
    relevantFound += relevantUris.filter(uri => rankedUris.includes(uri)).length;
    const firstRelevantRank = rankedUris.findIndex(uri => (query.relevance[uri] ?? 0) > 0);
    if (query.expectedAnswerability === 'answerable') {
      reciprocalRanks.push(firstRelevantRank === -1 ? 0 : 1 / (firstRelevantRank + 1));
    }
    ndcgScores.push(ndcgAtCutoff(rankedUris, query.relevance, EVALUATION_CUTOFF));
    forbiddenHits += rankedUris.filter(uri => query.forbiddenUris?.includes(uri) === true).length;
    returnedHits += rankedUris.length;
    contextTokens += Math.ceil(
      top.reduce((characters, result) => characters + result.candidate.text.length, 0) / ESTIMATED_CHARACTERS_PER_TOKEN,
    );

    const predicted = ranked.confidence.level === 'no_answer';
    const expected = query.expectedAnswerability === 'no_answer';
    predictedNoAnswer += predicted ? 1 : 0;
    expectedNoAnswer += expected ? 1 : 0;
    correctNoAnswer += predicted && expected ? 1 : 0;
    if (predicted !== expected) {
      failures.push(`${query.id}: expected ${query.expectedAnswerability}, got confidence ${ranked.confidence.level}`);
    }

    const topReasonCodes = new Set(top[0]?.reasons.map(reason => reason.code) ?? []);
    for (const code of query.requiredReasonCodes ?? []) {
      if (!topReasonCodes.has(code)) {
        requiredReasonsPresent = false;
        failures.push(`${query.id}: top result is missing required reason ${code}`);
      }
    }
    for (const uri of query.forbiddenUris ?? []) {
      if (rankedUris.includes(uri)) {
        failures.push(`${query.id}: forbidden stale or wrong-scope result surfaced: ${uri}`);
      }
    }
  }

  const queryCount = fixture.queries.length;
  return {
    failures,
    metrics: {
      averageContextTokens: queryCount === 0 ? 0 : contextTokens / queryCount,
      meanNdcgAt5: mean(ndcgScores),
      meanReciprocalRank: mean(reciprocalRanks),
      noAnswerPrecision: predictedNoAnswer === 0 ? 1 : correctNoAnswer / predictedNoAnswer,
      noAnswerRecall: expectedNoAnswer === 0 ? 1 : correctNoAnswer / expectedNoAnswer,
      recallAt5: relevantExpected === 0 ? 1 : relevantFound / relevantExpected,
      requiredReasonsPresent,
      staleHitRate: returnedHits === 0 ? 0 : forbiddenHits / returnedHits,
    },
    queryResults,
    version: 1,
  };
}

export function parseRecallEvaluationFixture(value: unknown): RecallEvaluationFixture {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('documents' in value) ||
    !Array.isArray(value.documents) ||
    !('queries' in value) ||
    !Array.isArray(value.queries)
  ) {
    throw new Error('Expected a recall evaluation fixture with version 1, documents, and queries.');
  }
  return value as RecallEvaluationFixture;
}

function ndcgAtCutoff(
  rankedUris: readonly string[],
  relevance: Readonly<Record<string, number>>,
  cutoff: number,
): number {
  const actual = discountedCumulativeGain(rankedUris.slice(0, cutoff).map(uri => relevance[uri] ?? 0));
  const ideal = discountedCumulativeGain(
    Object.values(relevance)
      .sort((left, right) => right - left)
      .slice(0, cutoff),
  );
  return ideal === 0 ? 1 : actual / ideal;
}

function discountedCumulativeGain(grades: readonly number[]): number {
  return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
