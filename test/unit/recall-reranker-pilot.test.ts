import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {buildPilotProposalCorpusV1, type PilotScenario} from '../../scripts/training/build-recall-reranker-pilot.js';
import {
  normalizeRecallRerankerText,
  parseRecallRerankerDatasetDraftV1,
  parseRecallRerankerGroupJsonLinesV1,
} from '../../scripts/training/recall-reranker-contract.js';
import {createRecallEvaluationFixtureV2} from '../../src/evaluation/recall-fixture.js';
import {detectSecretMatches} from '../../src/share/scrubber.js';

const scenarios = JSON.parse(
  await Bun.file('training/recall-reranker/dataset-tools/pilot-v1/seeds.json').text(),
) as PilotScenario[];
const seedHash = 'a'.repeat(64);
const licenseHash = 'b'.repeat(64);

describe('fictional recall-reranker pilot proposals', () => {
  it('keeps every label and source unapproved while preserving organization-isolated splits', () => {
    const corpus = buildPilotProposalCorpusV1(scenarios, seedHash, licenseHash);
    expect(corpus.counts).toMatchObject({
      groups: 132,
      candidates: 792,
      noAnswerGroups: 44,
      splits: {train: 102, validation: 18, test: 12},
      organizations: 22,
    });
    expect(corpus.draft.privacyReviewed).toBe(false);
    expect(corpus.draft.sources[0]).toMatchObject({
      trainingApproved: false,
      redistributionApproved: false,
    });
    const partitions = new Map<string, string>();
    const documentSplits = new Map<string, string>();
    const positivePositions = new Set<number>();
    for (const group of corpus.groups) {
      const prior = partitions.get(group.partitionKey);
      expect(prior === undefined || prior === group.split).toBe(true);
      partitions.set(group.partitionKey, group.split);
      expect(group.candidates).toHaveLength(6);
      expect(group.candidates.every(candidate => candidate.reviewed === false)).toBe(true);
      if (group.answerability === 'no_answer') {
        expect(group.candidates.every(candidate => candidate.relevance === 0)).toBe(true);
      } else {
        expect(group.candidates.filter(candidate => candidate.relevance === 3)).toHaveLength(1);
        positivePositions.add(group.candidates.findIndex(candidate => candidate.relevance === 3));
      }
      for (const candidate of group.candidates) {
        expect(candidate.title).not.toMatch(/^(?:Superseded|Other product)\b/iu);
        const normalized = candidate.text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
        const seen = documentSplits.get(normalized);
        expect(seen === undefined || seen === group.split).toBe(true);
        documentSplits.set(normalized, group.split);
      }
    }
    expect([...positivePositions].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(parseRecallRerankerGroupJsonLinesV1(corpus.groupJsonl)).toHaveLength(132);
    expect(parseRecallRerankerDatasetDraftV1(corpus.draft).sources).toHaveLength(1);
  });

  it('rejects one fictional organization crossing train and evaluation splits', () => {
    const duplicateOrganization = {...scenarios[0], id: 'different-repository', split: 'validation' as const};
    expect(() => buildPilotProposalCorpusV1([...scenarios, duplicateOrganization], seedHash, licenseHash)).toThrow(
      /crosses splits/u,
    );
  });

  it('contains no scrubber matches, frozen fixture text, duplicate queries, or explicit missing-answer cues', () => {
    const corpus = buildPilotProposalCorpusV1(scenarios, seedHash, licenseHash);
    const fixture = createRecallEvaluationFixtureV2();
    const forbidden = new Set([
      ...fixture.queries.map(query => normalizeRecallRerankerText(query.query)),
      ...fixture.documents.map(document => normalizeRecallRerankerText(document.text)),
    ]);
    const queries = new Set<string>();
    for (const group of corpus.groups) {
      const normalizedQuery = normalizeRecallRerankerText(group.query);
      expect(forbidden.has(normalizedQuery)).toBe(false);
      expect(queries.has(normalizedQuery)).toBe(false);
      expect(detectSecretMatches(group.query)).toHaveLength(0);
      queries.add(normalizedQuery);
      for (const candidate of group.candidates) {
        expect(forbidden.has(normalizeRecallRerankerText(candidate.text))).toBe(false);
        expect(detectSecretMatches(candidate.text)).toHaveLength(0);
        expect(detectSecretMatches(candidate.title)).toHaveLength(0);
      }
    }
    for (const scenario of scenarios) {
      for (const missing of scenario.missing) {
        expect(missing.near).not.toMatch(/\b(?:absent|draft|missing|no|not|open|unapproved|unresolved)\b/iu);
      }
    }
  });

  it('is independent of source-card order', () => {
    const expected = buildPilotProposalCorpusV1(scenarios, seedHash, licenseHash).groupJsonl;
    fc.assert(
      fc.property(
        fc.shuffledSubarray(scenarios, {minLength: scenarios.length, maxLength: scenarios.length}),
        shuffled => buildPilotProposalCorpusV1(shuffled, seedHash, licenseHash).groupJsonl === expected,
      ),
      {numRuns: 30},
    );
  });
});
