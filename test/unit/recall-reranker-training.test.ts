import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  compareRecallRerankerStringsV1,
  createRecallRerankerDatasetV1,
  normalizeRecallRerankerText,
  parseRecallRerankerDatasetV1,
  recallRerankerGroupsHashV1,
  serializeRecallRerankerGroupsV1,
  type RecallRerankerDatasetV1,
  type RecallRerankerQueryGroupV1,
} from '../../scripts/training/recall-reranker-contract.js';
import {createRecallRerankerSmokeDatasetV1} from '../../scripts/training/recall-reranker-smoke.js';
import {prepareReviewedRecallRerankerDatasetV1} from '../../scripts/training/recall-reranker-preparation.js';
import {normalizeRecallRerankerScore} from '../../src/recall/reranker-score.js';

describe('recall reranker training dataset v1', () => {
  it('builds a deterministic, partitioned smoke corpus that is explicitly non-production', () => {
    const left = createRecallRerankerSmokeDatasetV1();
    const right = createRecallRerankerSmokeDatasetV1();

    expect(left).toEqual(right);
    expect(left.manifest.purpose).toBe('harness_smoke');
    expect(left.manifest.counts).toEqual({
      candidates: 72,
      groups: 18,
      noAnswerGroups: 9,
      splits: {test: 4, train: 10, validation: 4},
    });
    expect(left.manifest.reservedEvaluations).toHaveLength(1);
    expect(left.groups.every(group => group.candidates.length === 4)).toBe(true);
  });

  it('round-trips the manifest and canonical JSONL with integrity checks', () => {
    const dataset = createRecallRerankerSmokeDatasetV1();
    const groupContent = serializeRecallRerankerGroupsV1(dataset.groups);
    const parsed = parseRecallRerankerDatasetV1(JSON.parse(JSON.stringify(dataset.manifest)), groupContent);

    expect(parsed).toEqual(dataset);
    expect(() =>
      parseRecallRerankerDatasetV1(dataset.manifest, groupContent.replace('Aurora scheduler', 'Modified scheduler')),
    ).toThrow(/checksum does not match/);
  });

  it('shares one finite probability normalization contract with production recall', () => {
    expect(normalizeRecallRerankerScore(0.25)).toBe(0.25);
    expect(normalizeRecallRerankerScore(2)).toBeCloseTo(0.880797, 6);
    expect(normalizeRecallRerankerScore(-2)).toBeCloseTo(0.119203, 6);
    expect(normalizeRecallRerankerScore(Number.NaN)).toBe(0);
  });

  it('rejects split leakage by partition key or normalized candidate text', () => {
    const dataset = createRecallRerankerSmokeDatasetV1();
    const train = dataset.groups.find(group => group.split === 'train')!;
    const testIndex = dataset.groups.findIndex(group => group.split === 'test');
    const test = dataset.groups[testIndex]!;
    const partitionLeak = replaceGroup(dataset.groups, testIndex, {...test, partitionKey: train.partitionKey});
    const documentLeak = replaceGroup(dataset.groups, testIndex, {
      ...test,
      candidates: [{...test.candidates[0]!, text: train.candidates[0]!.text}, ...test.candidates.slice(1)],
    });

    expect(() => rebuild(dataset, partitionLeak)).toThrow(/partition key leaks across/);
    expect(() => rebuild(dataset, documentLeak)).toThrow(/document text leaks across/);
  });

  it('rejects credentials, local paths, and opt-in sources without consent', () => {
    const dataset = createRecallRerankerSmokeDatasetV1();
    const first = dataset.groups[0]!;
    const credentialGroups = replaceGroup(dataset.groups, 0, {
      ...first,
      query: 'Find token sk-1234567890abcdef1234567890',
    });
    const pathGroups = replaceGroup(dataset.groups, 0, {
      ...first,
      query: 'Inspect C:\\Users\\someone\\private\\notes.md',
    });
    const source = dataset.manifest.sources[0]!;

    expect(() => rebuild(dataset, credentialGroups)).toThrow(/sensitive data/);
    expect(() => rebuild(dataset, pathGroups)).toThrow(/contains sensitive data \(Windows absolute path\)/);
    expect(() =>
      createRecallRerankerDatasetV1(
        draft(dataset, [
          {
            ...source,
            kind: 'opt_in_sanitized',
            privacyBasis: 'explicit_opt_in',
          },
        ]),
        dataset.groups,
      ),
    ).toThrow(/requires an explicit consent reference/);
  });

  it('requires every labeled candidate, including negatives, to be reviewed', () => {
    const dataset = createRecallRerankerSmokeDatasetV1();
    const group = dataset.groups[0]!;
    const negativeIndex = group.candidates.findIndex(candidate => candidate.relevance === 0);
    const candidates = [...group.candidates];
    candidates[negativeIndex] = {...candidates[negativeIndex]!, reviewed: false};
    const groups = replaceGroup(dataset.groups, 0, {...group, candidates});

    expect(() => rebuild(dataset, groups)).toThrow(/candidate .* must be reviewed/);
  });

  it('matches the shared non-ASCII normalization, UTF-8 ordering, and canonical-hash vectors', async () => {
    const fixture = (await Bun.file(
      new URL('../../training/recall-reranker/fixtures/canonicalization-v1.json', import.meta.url),
    ).json()) as CanonicalizationFixture;

    for (const vector of fixture.normalization) {
      expect(normalizeRecallRerankerText(vector.input)).toBe(vector.output);
    }
    expect(
      [...fixture.canonicalGroups]
        .sort((left, right) => compareRecallRerankerStringsV1(left.id, right.id))
        .map(group => group.id),
    ).toEqual(fixture.sortedIds);
    expect(
      recallRerankerGroupsHashV1(fixture.canonicalGroups as unknown as readonly RecallRerankerQueryGroupV1[]),
    ).toBe(fixture.groupsSha256);
  });

  it('prepares the reviewed template without inventing review or source approval', async () => {
    const tools = new URL('../../training/recall-reranker/dataset-tools/', import.meta.url);
    const draft = (await Bun.file(new URL('draft.example.json', tools)).json()) as Record<string, unknown>;
    const groupContent = await Bun.file(new URL('groups.example.jsonl', tools)).text();
    const dataset = prepareReviewedRecallRerankerDatasetV1(draft, groupContent);

    expect(dataset.manifest.purpose).toBe('training_candidate');
    expect(dataset.manifest.counts).toEqual({
      candidates: 12,
      groups: 4,
      noAnswerGroups: 1,
      splits: {test: 1, train: 2, validation: 1},
    });
    expect(dataset.manifest.reservedEvaluations).toHaveLength(1);

    const groups = groupContent
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as RecallRerankerQueryGroupV1);
    const candidate = groups[0]!.candidates[1]!;
    groups[0] = {
      ...groups[0]!,
      candidates: [groups[0]!.candidates[0]!, {...candidate, reviewed: false}, ...groups[0]!.candidates.slice(2)],
    };
    const unreviewed = `${groups.map(group => JSON.stringify(group)).join('\n')}\n`;
    expect(() => prepareReviewedRecallRerankerDatasetV1(draft, unreviewed)).toThrow(/must be reviewed/);

    const source = (draft.sources as readonly Record<string, unknown>[])[0]!;
    const unapproved = {...draft, sources: [{...source, trainingApproved: false}]};
    expect(() => prepareReviewedRecallRerankerDatasetV1(unapproved, groupContent)).toThrow(/not approved for training/);
  });

  it.prop(
    'uses an order-independent canonical group hash',
    {weights: FC.array(FC.integer(), {maxLength: 18, minLength: 18})},
    ({weights}) => {
      const groups = createRecallRerankerSmokeDatasetV1().groups;
      const shuffled = groups
        .map((group, index) => ({group, index, weight: weights[index]!}))
        .sort((left, right) => left.weight - right.weight || right.index - left.index)
        .map(entry => entry.group);

      expect(recallRerankerGroupsHashV1(shuffled)).toBe(recallRerankerGroupsHashV1(groups));
    },
    {fastCheck: {numRuns: 50}},
  );

  it.prop(
    'never accepts a positive candidate in a no-answer group',
    {candidateIndex: FC.integer({max: 3, min: 0})},
    ({candidateIndex}) => {
      const dataset = createRecallRerankerSmokeDatasetV1();
      const groupIndex = dataset.groups.findIndex(group => group.answerability === 'no_answer');
      const group = dataset.groups[groupIndex]!;
      const candidate = group.candidates[candidateIndex]!;
      const candidates = [...group.candidates];
      candidates[candidateIndex] = {...candidate, negativeKind: undefined, relevance: 1};
      const invalid = replaceGroup(dataset.groups, groupIndex, {...group, candidates});

      expect(() => rebuild(dataset, invalid)).toThrow(/No-answer .* cannot contain relevant candidates/);
    },
    {fastCheck: {numRuns: 20}},
  );
});

interface CanonicalizationFixture {
  readonly canonicalGroups: readonly {readonly id: string; readonly payload: unknown}[];
  readonly groupsSha256: string;
  readonly normalization: readonly {readonly input: string; readonly output: string}[];
  readonly sortedIds: readonly string[];
  readonly version: 1;
}

function rebuild(dataset: RecallRerankerDatasetV1, groups: readonly RecallRerankerQueryGroupV1[]) {
  return createRecallRerankerDatasetV1(draft(dataset), groups);
}

function draft(dataset: RecallRerankerDatasetV1, sources = dataset.manifest.sources) {
  return {
    createdAt: dataset.manifest.createdAt,
    description: dataset.manifest.description,
    generatorRevision: dataset.manifest.generatorRevision,
    groupFile: dataset.manifest.groupFile,
    labelMethod: dataset.manifest.labelMethod,
    name: dataset.manifest.name,
    partitionStrategy: dataset.manifest.partitionStrategy,
    privacyReviewed: dataset.manifest.privacyReviewed,
    purpose: dataset.manifest.purpose,
    reservedEvaluations: dataset.manifest.reservedEvaluations,
    seed: dataset.manifest.seed,
    sources,
  };
}

function replaceGroup(
  groups: readonly RecallRerankerQueryGroupV1[],
  index: number,
  group: RecallRerankerQueryGroupV1,
): readonly RecallRerankerQueryGroupV1[] {
  const output = [...groups];
  output[index] = group;
  return output;
}
