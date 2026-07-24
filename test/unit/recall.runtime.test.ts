import {describe, expect, it} from 'vitest';
import {mergeRecallIndexCandidates, recallExpansionVocabulary} from '../../src/recall/runtime.js';

describe('recall expansion vocabulary', () => {
  it('offers project topics before verbose candidate identifiers', () => {
    expect(
      recallExpansionVocabulary(
        [
          {
            fields: {
              identifiers: ['first.ts', 'second.ts'],
              project: 'threadnote',
              topic: 'lifecycle-memory-split',
            },
            text: 'lifecycle lifecycle memory split split keeps keeps handoffs handoffs separate separate',
            uri: 'viking://first',
          },
          {
            fields: {
              identifiers: ['third.ts'],
              project: 'threadnote',
              topic: 'recall-and-memory-formation',
            },
            text: 'recall recall uses uses ranking ranking evidence evidence signals signals',
            uri: 'viking://second',
          },
          {
            fields: {
              identifiers: ['fourth.ts'],
              project: 'threadnote',
              topic: 'recall-and-memory-formation',
            },
            text: 'duplicate handoff excerpt',
            uri: 'viking://duplicate-topic',
          },
        ],
        'threadnote',
      ),
    ).toEqual([
      'lifecycle-memory-split :: lifecycle memory split keeps handoffs separate',
      'recall-and-memory-formation :: recall uses ranking evidence signals',
      'first.ts',
      'second.ts',
      'third.ts',
      'fourth.ts',
    ]);
  });

  it('interleaves original and expansion candidates before the bounded rank window', () => {
    const candidate = (uri: string) => ({text: '', uri});

    expect(
      mergeRecallIndexCandidates([
        [candidate('original-1'), candidate('original-2'), candidate('shared')],
        [candidate('expanded-1'), candidate('shared'), candidate('expanded-2')],
      ]).map(item => item.uri),
    ).toEqual(['original-1', 'expanded-1', 'original-2', 'shared', 'expanded-2']);
  });

  it('reserves grounded vocabulary space for recent project topics after a large ranked prefix', () => {
    const older = Array.from({length: 60}, (_unused, index) => ({
      fields: {project: 'threadnote', topic: `older-topic-${index}`},
      text: `older topic ${index}`,
      timestamp: '2025-01-01T00:00:00.000Z',
      uri: `viking://older-${index}`,
    }));
    const vocabulary = recallExpansionVocabulary(
      [
        ...older,
        {
          fields: {project: 'threadnote', topic: 'recent-release-contract'},
          text: 'recent release channel contract',
          timestamp: '2026-07-24T00:00:00.000Z',
          uri: 'viking://recent',
        },
      ],
      'threadnote',
    );

    expect(vocabulary).toHaveLength(50);
    expect(vocabulary).toContain('recent-release-contract :: recent release channel contract');
  });
});
