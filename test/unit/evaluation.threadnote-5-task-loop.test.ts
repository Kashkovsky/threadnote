import {describe, expect, it} from 'vitest';
import fixture from '../evaluation/fixtures/threadnote-5-task-loop-v1/fixture.json' with {type: 'json'};

const EXPECTED_CASES = [
  'activation',
  'closeout-usefulness',
  'contradiction-triage',
  'projection-drift',
  'stale-citation-detection',
  'token-budgets',
] as const;

const FORBIDDEN_KEYS = new Set([
  'credential',
  'memoryBody',
  'path',
  'query',
  'rawLog',
  'repository',
  'sourceFragment',
  'userId',
]);

describe('Threadnote 5 task-loop evaluation fixture', () => {
  it('freezes the complete offline release-gate matrix', () => {
    expect(fixture).toMatchObject({networkAllowed: false, suite: 'threadnote-5-task-loop', version: 1});
    expect(fixture.cases.map(entry => entry.id).sort()).toEqual(EXPECTED_CASES);
    expect(new Set(fixture.cases.map(entry => entry.id)).size).toBe(fixture.cases.length);
  });

  it('keeps activation, closeout, and budget thresholds aligned with the public plan', () => {
    expect(contract('activation')).toMatchObject({
      attempts: 10,
      maximumDurationMilliseconds: 600_000,
      minimumSuccessfulAttempts: 9,
      requiresSecondSurfaceReuse: true,
      requiresSourceVerifiedBrief: true,
    });
    expect(contract('closeout-usefulness')).toMatchObject({
      maximumDurableCandidates: 3,
      minimumFormableRate: 0.9,
      requiresExplicitApply: true,
    });
    expect(contract('token-budgets')).toMatchObject({
      contextBriefMaximumEstimatedTokens: 1_500,
      contextBriefMinimumEstimatedTokens: 800,
      maximumKnowledgeDeltaItems: 3,
    });
  });

  it('contains no identity-bearing or content-bearing field names', () => {
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (typeof value !== 'object' || value === null) return;
      for (const [key, nested] of Object.entries(value)) {
        expect(FORBIDDEN_KEYS.has(key)).toBe(false);
        visit(nested);
      }
    };
    visit(fixture);
  });
});

function contract(id: (typeof EXPECTED_CASES)[number]): Readonly<Record<string, unknown>> {
  const selected = fixture.cases.find(entry => entry.id === id);
  if (!selected) throw new Error(`Missing evaluation case: ${id}`);
  return selected.contract;
}
