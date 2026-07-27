import {createRecallEvaluationFixtureV2, expandRecallEvaluationFixtureV2} from '../src/evaluation/recall-fixture.js';
import {rankRecallCandidates} from '../src/recall/rank.js';

export function createBenchmarkFixture(documentCount: number) {
  return expandRecallEvaluationFixtureV2(createRecallEvaluationFixtureV2(), documentCount);
}

export function runBenchmarkQuery(
  fixture: ReturnType<typeof createBenchmarkFixture>,
  queryIndex = 0,
): {readonly confidence: string; readonly topScore: number; readonly topUri: string} {
  const query = fixture.queries[queryIndex % fixture.queries.length]!;
  const result = rankRecallCandidates(query.query, fixture.documents, {
    now: query.now ? new Date(query.now) : undefined,
    project: query.project,
    seedUris: query.seedUris,
  });
  return {
    confidence: result.confidence.level,
    topScore: result.results[0]?.finalScore ?? 0,
    topUri: result.results[0]?.candidate.uri ?? '',
  };
}
