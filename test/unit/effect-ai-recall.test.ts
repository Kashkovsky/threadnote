import {expect, it} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import {describe} from 'vitest';
import {
  boundedRecallExpansionScopes,
  expandRecallQueryEffect,
  isLoopbackAiEndpoint,
  limitRecallRewritesForConfidence,
  normalizeRecallRewrites,
  recallMinimumScoreAfterExpansion,
  RecallQueryExpander,
  shouldExpandRecall,
} from '../../src/effect/ai-recall.js';

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
      normalizeRecallRewrites('where is the Android link handled', [
        ' Android app link intent filter ',
        'where is the Android link handled',
        'android app link intent filter',
        'asset links manifest configuration',
        'ignored third rewrite',
        'x'.repeat(700),
      ]),
    ).toEqual(['Android app link intent filter', 'asset links manifest configuration']);
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
        'viking://resources/repos/mobile',
      ]),
    ).toEqual([undefined]);
  });

  it('uses one rewrite for medium confidence and two for weaker recall', () => {
    const rewrites = ['first', 'second'];
    expect(limitRecallRewritesForConfidence({level: 'medium'}, rewrites)).toEqual(['first']);
    expect(limitRecallRewritesForConfidence({level: 'low'}, rewrites)).toEqual(rewrites);
    expect(limitRecallRewritesForConfidence({level: 'no_answer'}, rewrites)).toEqual(rewrites);
  });

  it('relaxes only the default threshold after expansion', () => {
    expect(recallMinimumScoreAfterExpansion(0.4, false)).toBeUndefined();
    expect(recallMinimumScoreAfterExpansion(0.9, true)).toBe(0.9);
  });

  it('only treats explicit loopback Effect AI endpoints as local', () => {
    expect(isLoopbackAiEndpoint('http://127.0.0.1:8081/v1')).toBe(true);
    expect(isLoopbackAiEndpoint('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackAiEndpoint('https://models.example.com/v1')).toBe(false);
    expect(isLoopbackAiEndpoint(undefined)).toBe(false);
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
});
