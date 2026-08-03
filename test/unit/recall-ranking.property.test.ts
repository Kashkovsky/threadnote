import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {rankRecallCandidates, type RecallCandidate, type RankedRecallCandidate} from '../../src/recall/rank.js';
import {mergeRecallHits, RECALL_CATEGORY_ORDER, type RecallCategory, type RecallHit} from '../../src/utils.js';

const FIXED_NOW = new Date('2026-07-30T00:00:00.000Z');
const MEMORY_KINDS = ['durable', 'handoff', 'incident', 'preference', 'smoke'] as const;
const URI_LABELS = [
  '!bang',
  '-dash',
  '0digit',
  'A-upper',
  '_under',
  'a-lower',
  'é-accent',
  'Ω-greek',
  '中-cjk',
  '😀-emoji',
] as const;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function generatedUri(id: number, label = 'generated'): string {
  return `threadnote://user/test/memories/${label}-${String(id).padStart(3, '0')}.md`;
}

function expectBoundedRankedCandidate(result: RankedRecallCandidate): void {
  expect(Number.isFinite(result.finalScore)).toBe(true);
  expect(result.finalScore).toBeGreaterThanOrEqual(0);
  expect(result.finalScore).toBeLessThanOrEqual(1);
  expect(Number.isFinite(result.relevanceScore)).toBe(true);
  expect(result.relevanceScore).toBeGreaterThanOrEqual(0);
  expect(result.relevanceScore).toBeLessThanOrEqual(1);

  for (const [signal, value] of Object.entries(result.signals)) {
    expect(Number.isFinite(value), `${signal} should be finite`).toBe(true);
    expect(value, `${signal} should be at most 1`).toBeLessThanOrEqual(1);
    expect(value, `${signal} should be non-negative except for feedback`).toBeGreaterThanOrEqual(
      signal === 'feedback' ? -1 : 0,
    );
  }
  for (const reason of result.reasons) {
    expect(Number.isFinite(reason.contribution)).toBe(true);
  }
}

const recallCandidatesArbitrary = FC.uniqueArray(
  FC.record({
    feedbackPercent: FC.integer({max: 200, min: -200}),
    id: FC.integer({max: 999, min: 0}),
    kindIndex: FC.integer({max: MEMORY_KINDS.length - 1, min: 0}),
    rerankerPercent: FC.integer({max: 150, min: -50}),
    semanticPercent: FC.integer({max: 150, min: -50}),
    uriLabel: FC.constantFrom(...URI_LABELS),
  }),
  {
    maxLength: 24,
    minLength: 0,
    selector: value => value.id,
  },
).map(specs =>
  specs.map((spec): RecallCandidate => ({
    authority: 'agent_generated',
    feedback: spec.feedbackPercent / 100,
    fields: {
      project: 'threadnote',
      title: 'Alpha retry policy',
      topic: 'alpha-retry-policy',
    },
    kind: MEMORY_KINDS[spec.kindIndex]!,
    reranker: spec.rerankerPercent / 100,
    semantic: spec.semanticPercent / 100,
    status: 'active',
    text: 'Alpha retry policy uses bounded retries.',
    timestamp: '2026-07-29T00:00:00.000Z',
    trust: 'inferred',
    uri: generatedUri(spec.id, spec.uriLabel),
  })),
);

const recallRankingCaseArbitrary = recallCandidatesArbitrary.chain(candidates =>
  FC.shuffledSubarray(candidates, {maxLength: candidates.length, minLength: candidates.length}).map(permutation => ({
    candidates,
    permutation,
  })),
);

interface RecallDocumentSpec {
  readonly category: RecallCategory;
  readonly contextType: string;
  readonly id: number;
  readonly passOffset: number;
  readonly scores: readonly number[];
  readonly uriLabel: string;
}

const recallDocumentsArbitrary: FC.Arbitrary<readonly RecallDocumentSpec[]> = FC.uniqueArray(
  FC.record({
    category: FC.constantFrom(...RECALL_CATEGORY_ORDER),
    contextType: FC.constantFrom('memory', 'resource', 'skill'),
    id: FC.integer({max: 999, min: 0}),
    passOffset: FC.integer({max: 2, min: 0}),
    scores: FC.array(FC.integer({max: 10, min: 0}), {maxLength: 4, minLength: 1}),
    uriLabel: FC.constantFrom(...URI_LABELS),
  }),
  {
    maxLength: 24,
    minLength: 0,
    selector: value => value.id,
  },
);

function recallDocumentHits(document: RecallDocumentSpec): readonly RecallHit[] {
  const uri = `threadnote://${document.category}/${document.uriLabel}-${String(document.id).padStart(3, '0')}.md`;
  return document.scores.map((score, index) => ({
    category: document.category,
    contextType: `${document.contextType}-chunk-${index}`,
    score: score / 10,
    snippet: `generated document ${document.id}, chunk ${index}`,
    uri: `${uri}#chunk_${String(index).padStart(4, '0')}`,
  }));
}

function recallPasses(documents: readonly RecallDocumentSpec[]): readonly (readonly RecallHit[])[] {
  const passes: RecallHit[][] = [[], [], []];
  for (const document of documents) {
    recallDocumentHits(document).forEach((hit, index) => {
      passes[(document.passOffset + index) % passes.length]!.push(hit);
    });
  }
  return passes;
}

function mergeOracle(documents: readonly RecallDocumentSpec[]): readonly RecallHit[] {
  return documents
    .map((document): RecallHit => {
      const winner = [...recallDocumentHits(document)].sort(
        (left, right) => right.score - left.score || compareCodeUnits(left.uri, right.uri),
      )[0]!;
      return {...winner, uri: winner.uri.replace(/#.*$/, '')};
    })
    .sort(
      (left, right) =>
        RECALL_CATEGORY_ORDER.indexOf(left.category) - RECALL_CATEGORY_ORDER.indexOf(right.category) ||
        right.score - left.score ||
        compareCodeUnits(left.uri, right.uri),
    );
}

const recallMergeCaseArbitrary = recallDocumentsArbitrary.chain(documents => {
  const passes = recallPasses(documents);
  const hits = passes.flat();
  return FC.shuffledSubarray(hits, {maxLength: hits.length, minLength: hits.length}).map(permutation => ({
    documents,
    passes,
    permutation,
  }));
});

describe('recall ranking properties', () => {
  it.prop(
    'keeps finite bounded ranking output stable across candidate permutations',
    {rankingCase: recallRankingCaseArbitrary},
    ({rankingCase}) => {
      const {candidates, permutation} = rankingCase;
      const context = {
        includeInactive: true,
        includeTemporallyInvalid: true,
        now: FIXED_NOW,
        project: 'threadnote',
      };
      const ranked = rankRecallCandidates('alpha retry policy', candidates, context);
      const permuted = rankRecallCandidates('alpha retry policy', permutation, context);

      expect(permuted).toEqual(ranked);
      expect(ranked.results.length).toBeLessThanOrEqual(candidates.length);
      expect(new Set(ranked.results.map(result => result.candidate.uri)).size).toBe(ranked.results.length);
      ranked.results.forEach(expectBoundedRankedCandidate);
      expect(Number.isFinite(ranked.confidence.score)).toBe(true);
      expect(ranked.confidence.score).toBeGreaterThanOrEqual(0);
      expect(ranked.confidence.score).toBeLessThanOrEqual(1);
      expect(Number.isFinite(ranked.confidence.margin)).toBe(true);
      expect(ranked.confidence.margin).toBeGreaterThanOrEqual(0);
      expect(ranked.confidence.margin).toBeLessThanOrEqual(1);
    },
    {fastCheck: {numRuns: 125}},
  );

  it.prop(
    'uses locale-independent URI ordering as the final tie-break for otherwise equal candidates',
    {
      labels: FC.uniqueArray(FC.constantFrom(...URI_LABELS), {
        maxLength: URI_LABELS.length,
        minLength: 2,
      }),
    },
    ({labels}) => {
      const candidates = labels.map((label, index): RecallCandidate => ({
        fields: {title: 'Alpha retry policy'},
        kind: 'durable',
        reranker: 0.5,
        semantic: 0.75,
        text: 'Alpha retry policy uses bounded retries.',
        uri: generatedUri(index, label),
      }));
      const expected = candidates.map(candidate => candidate.uri).sort(compareCodeUnits);

      expect(
        rankRecallCandidates('alpha retry policy', [...candidates].reverse(), {
          now: FIXED_NOW,
          project: 'threadnote',
        }).results.map(result => result.candidate.uri),
      ).toEqual(expected);
    },
    {fastCheck: {numRuns: 75}},
  );

  it.prop(
    'matches a document-level merge oracle and is idempotent across pass permutations',
    {mergeCase: recallMergeCaseArbitrary},
    ({mergeCase}) => {
      const {documents, passes, permutation} = mergeCase;
      const expected = mergeOracle(documents);
      const merged = mergeRecallHits(passes);

      expect(merged).toEqual(expected);
      expect(mergeRecallHits([permutation])).toEqual(expected);
      expect(mergeRecallHits([merged])).toEqual(merged);
      expect(new Set(merged.map(hit => hit.uri)).size).toBe(merged.length);
      expect(merged.every(hit => !hit.uri.includes('#'))).toBe(true);
      expect(merged.every(hit => Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1)).toBe(true);
    },
    {fastCheck: {numRuns: 150}},
  );

  it.prop(
    'orders equal-score merged documents by locale-independent URI across input permutations',
    {
      category: FC.constantFrom(...RECALL_CATEGORY_ORDER),
      labels: FC.uniqueArray(FC.constantFrom(...URI_LABELS), {
        maxLength: URI_LABELS.length,
        minLength: 2,
      }),
      score: FC.integer({max: 10, min: 0}),
    },
    ({category, labels, score}) => {
      const hits = labels.map((label): RecallHit => ({
        category,
        contextType: 'generated',
        score: score / 10,
        snippet: `generated document ${label}`,
        uri: `threadnote://${category}/${label}.md`,
      }));
      const expectedUris = hits.map(hit => hit.uri).sort(compareCodeUnits);

      expect(mergeRecallHits([hits]).map(hit => hit.uri)).toEqual(expectedUris);
      expect(mergeRecallHits([[...hits].reverse()]).map(hit => hit.uri)).toEqual(expectedUris);
    },
    {fastCheck: {numRuns: 75}},
  );

  it.prop(
    'chooses a deterministic payload for equal-score chunks of one document',
    {
      category: FC.constantFrom(...RECALL_CATEGORY_ORDER),
      labels: FC.uniqueArray(FC.constantFrom(...URI_LABELS), {
        maxLength: URI_LABELS.length,
        minLength: 2,
      }),
      score: FC.integer({max: 10, min: 0}),
    },
    ({category, labels, score}) => {
      const documentUri = `threadnote://${category}/same-document.md`;
      const hits = labels.map((label): RecallHit => ({
        category,
        contextType: `context-${label}`,
        score: score / 10,
        snippet: `distinct payload ${label}`,
        uri: `${documentUri}#${label}`,
      }));
      const expectedSource = [...hits].sort((left, right) => compareCodeUnits(left.uri, right.uri))[0]!;
      const expected = {...expectedSource, uri: documentUri};

      expect(mergeRecallHits([hits])).toEqual([expected]);
      expect(mergeRecallHits([[...hits].reverse()])).toEqual([expected]);
    },
    {fastCheck: {numRuns: 75}},
  );
});
