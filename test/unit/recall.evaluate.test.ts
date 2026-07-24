import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';
import {evaluateRecallFixture, parseRecallEvaluationFixture} from '../../src/recall/evaluate.js';

describe('recall evaluation contract v1', () => {
  it('meets the checked-in ranking, lifecycle, explanation, and no-answer contract', async () => {
    const raw = await readFile('test/evaluation/fixtures/recall-v1/fixture.json', 'utf8');
    const result = evaluateRecallFixture(parseRecallEvaluationFixture(JSON.parse(raw)));

    expect(result.failures).toEqual([]);
    expect(result.metrics.meanNdcgAt5).toBeGreaterThanOrEqual(0.95);
    expect(result.metrics.meanReciprocalRank).toBe(1);
    expect(result.metrics.recallAt5).toBe(1);
    expect(result.metrics.noAnswerPrecision).toBe(1);
    expect(result.metrics.noAnswerRecall).toBe(1);
    expect(result.metrics.requiredReasonsPresent).toBe(true);
    expect(result.metrics.staleHitRate).toBe(0);

    const paraphrases = result.queryResults.filter(query => query.id.startsWith('paraphrase-'));
    expect(paraphrases).toHaveLength(4);
    expect(paraphrases.every(query => query.expanded && query.initialConfidence !== 'high')).toBe(true);
    expect(paraphrases.every(query => query.rankedUris.length > 0)).toBe(true);
  });
});
