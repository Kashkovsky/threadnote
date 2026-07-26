import {describe, expect, it} from 'vitest';
import {
  buildRecallIndexSelectionCandidates,
  buildRecallSelectionCandidates,
  deterministicRecallQueryVariants,
  mergeRecallExpansionCandidates,
  mergeRecallIndexCandidates,
  recallExpansionVocabulary,
  recallSelectionAnchorIds,
  recallSelectionQueries,
  selectedRecallCandidateUris,
} from '../../src/recall/runtime.js';

describe('deterministic recall query variants', () => {
  it('splits a multi-intent query into substantive clauses', () => {
    expect(deterministicRecallQueryVariants('failures in worker lease renewal and artifact cache eviction')).toEqual([
      'failures in worker lease renewal',
      'artifact cache eviction',
    ]);
  });

  it('does not broaden a query around a one-word fragment', () => {
    expect(deterministicRecallQueryVariants('beta and stable release channel')).toEqual([]);
  });
});

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

  it('moves required search hits behind query-ranked candidates for grounded expansion', () => {
    const candidate = (uri: string) => ({text: '', uri});

    expect(
      mergeRecallExpansionCandidates(
        [
          [candidate('required'), candidate('query-1'), candidate('query-2')],
          [candidate('required'), candidate('expanded-1')],
        ],
        ['required'],
      ).map(item => item.uri),
    ).toEqual(['query-1', 'expanded-1', 'query-2', 'required']);
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

describe('recall candidate post-processing', () => {
  it('grounds local expansion in project index candidates and maps selections to ranked topics', () => {
    const indexedCandidates = [
      {
        fields: {project: 'atlas-cache', topic: 'unrelated-cache-topic'},
        text: 'Unrelated project text.',
        uri: 'viking://unrelated-cache',
      },
      {
        fields: {project: 'orion-worker', topic: 'worker-lease-renewal-mechanism'},
        kind: 'durable' as const,
        text: 'Worker Worker Lease Lease and heartbeat renewal.',
        uri: 'viking://lease-renewal',
      },
      {
        fields: {project: 'orion-worker', topic: 'job-recovery-howto'},
        kind: 'durable' as const,
        text: 'General failed job recovery guide.',
        uri: 'viking://job-recovery',
      },
    ];

    const candidates = buildRecallIndexSelectionCandidates(indexedCandidates, 'orion-worker', 24);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.summary).toContain('topic=worker-lease-renewal-mechanism');
    expect(candidates[0]?.summary).toContain('excerpt=Worker Lease and heartbeat renewal.');
    expect(recallSelectionQueries(candidates, indexedCandidates, ['c2', 'c1'], 'worker heartbeat renewal', 2)).toEqual([
      'worker-lease-renewal-mechanism',
      'job-recovery-howto',
    ]);
    expect(recallSelectionQueries(candidates, indexedCandidates, ['c1', 'c2'], 'job recovery', 1)).toEqual([
      'job-recovery-howto',
    ]);
  });

  it('prefers a selected topic that names a distinctive query acronym', () => {
    const indexedCandidates = [
      {
        fields: {project: 'orion-worker', topic: 'shared-worker-implementation'},
        text: 'Worker lease implementation that later mentions QX7.',
        uri: 'viking://shared-worker',
      },
      {
        fields: {project: 'orion-worker', topic: 'qx7-lease-flow'},
        text: 'Worker lease setup.',
        uri: 'viking://qx7-lease',
      },
    ];
    const candidates = buildRecallIndexSelectionCandidates(indexedCandidates, 'orion-worker', 24);

    expect(recallSelectionQueries(candidates, indexedCandidates, ['c1', 'c2'], 'QX7 worker lease', 1)).toEqual([
      'qx7-lease-flow',
    ]);
  });

  it('builds bounded candidate summaries and maps selected IDs back to URIs', () => {
    const candidates = buildRecallSelectionCandidates(
      [
        {
          category: 'memories',
          contextType: 'memory',
          score: 0.7,
          snippet: 'Directly relevant lease telemetry.',
          uri: 'viking://lease',
        },
        {
          category: 'resources',
          contextType: 'resource',
          score: 0.6,
          snippet: '',
          uri: 'viking://eviction',
        },
      ],
      [
        {
          fields: {project: 'atlas-cache', title: 'Eviction signal', topic: 'artifact-cache-eviction-signal'},
          text: 'artifact cache eviction telemetry',
          uri: 'viking://eviction',
        },
      ],
      2,
    );

    expect(candidates.map(candidate => candidate.id)).toEqual(['c1', 'c2']);
    expect(candidates[0]?.summary).toContain('Directly relevant lease telemetry.');
    expect(candidates[1]?.summary).toContain('topic=artifact-cache-eviction-signal');
    expect(selectedRecallCandidateUris(candidates, ['c2', 'unknown'])).toEqual(['viking://eviction']);
    expect(
      recallSelectionAnchorIds(candidates, [
        {
          category: 'memories',
          contextType: 'memory',
          score: 0.7,
          snippet: '',
          uri: 'viking://lease',
        },
        {
          category: 'resources',
          contextType: 'resource',
          rankWarnings: ['lexical-only result; no semantic or graph corroboration'],
          score: 0,
          snippet: '',
          uri: 'viking://eviction',
        },
      ]),
    ).toEqual(['c1']);
    expect(selectedRecallCandidateUris(candidates, ['c2'], ['c1'])).toEqual(['viking://lease', 'viking://eviction']);
    expect(selectedRecallCandidateUris(candidates, [], ['c1'])).toEqual([]);
  });
});
