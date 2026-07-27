import {expect, it} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import {describe} from 'vitest';
import {
  boundedRecallExpansionScopes,
  expandRecallQueryEffect,
  isLoopbackAiEndpoint,
  limitRecallRewritesForConfidence,
  mergeRecallRewritesForConfidence,
  normalizeRecallCandidateSelection,
  normalizeRecallRewrites,
  RecallCandidateSelector,
  recallHybridMinimumScore,
  RecallQueryExpander,
  selectRecallCandidatesEffect,
  shouldExpandRecall,
} from '../../src/effect/ai/recall.js';

describe('Effect AI recall expansion', () => {
  it('only expands weak deterministic recalls', () => {
    expect(shouldExpandRecall({level: 'no_answer'})).toBe(true);
    expect(shouldExpandRecall({level: 'low'})).toBe(true);
    expect(shouldExpandRecall({level: 'medium'})).toBe(true);
    expect(shouldExpandRecall({level: 'high'})).toBe(false);
    expect(shouldExpandRecall(undefined)).toBe(false);
  });

  it('keeps at most two unique, bounded rewrites and drops the original query', () => {
    expect(
      normalizeRecallRewrites('where is the QX7 lease handled', [
        ' QX7 worker lease coordinator ',
        'where is the QX7 lease handled',
        'qx7 worker lease coordinator',
        'heartbeat renewal configuration',
        'ignored third rewrite',
        'x'.repeat(700),
      ]),
    ).toEqual(['QX7 worker lease coordinator', 'heartbeat renewal configuration']);
  });

  it('drops locally grounded rewrites that ignore the supplied project vocabulary', () => {
    expect(
      normalizeRecallRewrites(
        'How do preview builds get upgraded?',
        [
          'upgrade-preview-builds-threadnote',
          'beta-update-channel prerelease upgrades',
          'release-process :: stable release workflow',
        ],
        ['beta-update-channel :: beta update and prerelease contract', 'release-process :: stable release workflow'],
      ),
    ).toEqual(['beta-update-channel', 'release-process']);
  });

  it('does not accept a vocabulary term embedded in a different word', () => {
    expect(normalizeRecallRewrites('share behavior', ['shared repository'], ['share'])).toEqual([]);
  });

  it('uses only the first search scope for expansion', () => {
    expect(
      boundedRecallExpansionScopes([
        undefined,
        'viking://user/me/memories/durable/projects/threadnote',
        undefined,
        'viking://resources/repos/threadnote',
        'viking://resources/repos/atlas-cache',
      ]),
    ).toEqual([undefined]);
  });

  it('uses one rewrite for medium confidence and two for weaker recall', () => {
    const rewrites = ['first', 'second'];
    expect(limitRecallRewritesForConfidence({level: 'medium'}, rewrites)).toEqual(['first']);
    expect(limitRecallRewritesForConfidence({level: 'low'}, rewrites)).toEqual(rewrites);
    expect(limitRecallRewritesForConfidence({level: 'no_answer'}, rewrites)).toEqual(rewrites);
    expect(mergeRecallRewritesForConfidence({level: 'low'}, ['grounded'], [' Grounded ', 'fallback'])).toEqual([
      'grounded',
      'fallback',
    ]);
  });

  it('uses the hybrid score scale by default and preserves explicit thresholds', () => {
    expect(recallHybridMinimumScore(0.45, false)).toBe(0.3);
    expect(recallHybridMinimumScore(0.9, true)).toBe(0.9);
  });

  it('only treats explicit loopback Effect AI endpoints as local', () => {
    expect(isLoopbackAiEndpoint('http://127.0.0.1:8081/v1')).toBe(true);
    expect(isLoopbackAiEndpoint('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackAiEndpoint('https://models.example.com/v1')).toBe(false);
    expect(isLoopbackAiEndpoint(undefined)).toBe(false);
  });

  it('keeps only known, unique candidate IDs and supports a confident empty selection', () => {
    const candidates = [
      {id: 'c1', summary: 'first', uri: 'viking://first'},
      {id: 'c2', summary: 'second', uri: 'viking://second'},
    ];
    expect(
      normalizeRecallCandidateSelection({candidateIds: ['c2', 'unknown', 'c2'], relevant: true}, candidates),
    ).toEqual(['c2']);
    expect(normalizeRecallCandidateSelection({candidateIds: [], relevant: false}, candidates)).toEqual([]);
    expect(() => normalizeRecallCandidateSelection({candidateIds: ['unknown'], relevant: true}, candidates)).toThrow(
      'no known candidate IDs',
    );
    const manyCandidates = Array.from({length: 12}, (_unused, index) => ({
      id: `c${index + 1}`,
      summary: `candidate ${index + 1}`,
      uri: `viking://candidate-${index + 1}`,
    }));
    expect(
      normalizeRecallCandidateSelection(
        {candidateIds: manyCandidates.map(candidate => candidate.id), relevant: true},
        manyCandidates,
      ),
    ).toHaveLength(8);
  });

  it.effect('keeps application code provider-independent', () =>
    expandRecallQueryEffect({project: 'threadnote', query: 'how do beta updates differ'}).pipe(
      Effect.provide(
        Layer.succeed(RecallQueryExpander, {
          expand: ({query}) => Effect.succeed([`rewrite:${query}`]),
        }),
      ),
      Effect.tap(rewrites => Effect.sync(() => expect(rewrites).toEqual(['rewrite:how do beta updates differ']))),
    ),
  );

  it.effect('keeps candidate selection provider-independent', () =>
    selectRecallCandidatesEffect({
      candidates: [{id: 'c1', summary: 'release channel', uri: 'viking://release'}],
      query: 'preview release updates',
    }).pipe(
      Effect.provide(
        Layer.succeed(RecallCandidateSelector, {
          select: () => Effect.succeed(['c1']),
        }),
      ),
      Effect.tap(selected => Effect.sync(() => expect(selected).toEqual(['c1']))),
    ),
  );
});
