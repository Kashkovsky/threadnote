import {describe, expect, it} from 'vitest';
import {buildRecallCorpusStatistics, rankRecallCandidates, RECALL_RANKER_VERSION} from '../../src/recall/rank.js';

describe('hybrid recall ranker', () => {
  it('combines semantic, BM25/IDF, and field-aware identifier evidence', () => {
    const ranked = rankRecallCandidates(
      'alpha-42 retry policy',
      [
        {
          fields: {project: 'threadnote', title: 'General retry notes'},
          semantic: 0.78,
          text: 'Common retry retry retry information.',
          uri: 'viking://resources/repos/threadnote/general.md',
        },
        {
          fields: {
            identifiers: ['alpha-42'],
            project: 'threadnote',
            title: 'Alpha-42 retry policy',
            topic: 'alpha-42',
          },
          semantic: 0.65,
          text: 'Alpha-42 uses bounded retries.',
          uri: 'viking://resources/repos/threadnote/alpha-42.md',
        },
      ],
      {project: 'threadnote', now: new Date('2026-07-23T00:00:00.000Z')},
    );

    expect(ranked.rankerVersion).toBe(RECALL_RANKER_VERSION);
    expect(ranked.results[0]?.candidate.uri).toContain('alpha-42.md');
    expect(ranked.results[0]?.reasons.map(reason => reason.code)).toEqual(
      expect.arrayContaining(['semantic_similarity', 'bm25_lexical', 'field_match', 'project_scope']),
    );
  });

  it('uses typed graph proximity without allowing authority to bypass topical relevance', () => {
    const seedUri = 'viking://resources/repos/threadnote/design.md';
    const ranked = rankRecallCandidates(
      'candidate review',
      [
        {
          authority: 'canonical_repo',
          fields: {title: 'Unrelated deployment guide'},
          semantic: 0,
          text: 'Kubernetes deployment topology.',
          uri: 'viking://resources/repos/threadnote/deploy.md',
        },
        {
          authority: 'agent_generated',
          fields: {title: 'Candidate review'},
          relations: [{type: 'evidence_for', uri: seedUri}],
          semantic: 0.45,
          text: 'Candidate review requires approval.',
          uri: 'viking://user/me/memories/candidate.md',
        },
      ],
      {seedUris: [seedUri]},
    );

    expect(ranked.results.map(result => result.candidate.uri)).toEqual(['viking://user/me/memories/candidate.md']);
    expect(ranked.results[0]?.signals.graph).toBeGreaterThan(0);
    expect(ranked.results[0]?.reasons.map(reason => reason.code)).toContain('graph_proximity');
  });

  it('does not let graph proximity alone bypass the topical relevance gate', () => {
    const seedUri = 'viking://resources/repos/threadnote/design.md';
    const ranked = rankRecallCandidates(
      'candidate review',
      [
        {
          authority: 'canonical_repo',
          fields: {title: 'Unrelated deployment guide'},
          relations: [{type: 'evidence_for', uri: seedUri}],
          semantic: 0,
          text: 'Kubernetes deployment topology.',
          uri: 'viking://resources/repos/threadnote/unrelated.md',
        },
      ],
      {seedUris: [seedUri]},
    );

    expect(ranked.results).toEqual([]);
    expect(ranked.confidence.level).toBe('no_answer');
  });

  it('penalizes superseded and temporally invalid facts', () => {
    const ranked = rankRecallCandidates(
      'release channel',
      [
        {
          fields: {title: 'Release channel'},
          semantic: 0.8,
          status: 'superseded',
          text: 'The release channel is beta.',
          uri: 'viking://user/me/memories/old.md',
          validTo: '2026-01-01T00:00:00.000Z',
        },
        {
          fields: {title: 'Release channel'},
          semantic: 0.7,
          status: 'active',
          text: 'The release channel is stable.',
          uri: 'viking://user/me/memories/current.md',
          validFrom: '2026-01-02T00:00:00.000Z',
        },
      ],
      {
        includeInactive: true,
        includeTemporallyInvalid: true,
        now: new Date('2026-07-23T00:00:00.000Z'),
      },
    );

    expect(ranked.results[0]?.candidate.uri).toContain('current.md');
    expect(ranked.results[1]?.warnings).toEqual(
      expect.arrayContaining(['memory is superseded', 'outside temporal validity window']),
    );
  });

  it('keeps an active memory ahead of a stronger archived match', () => {
    const ranked = rankRecallCandidates(
      'release channel',
      [
        {
          fields: {project: 'threadnote', title: 'Release channel'},
          semantic: 0.9,
          status: 'archived',
          text: 'The release channel is beta.',
          uri: 'viking://user/me/memories/archived.md',
        },
        {
          fields: {project: 'threadnote', title: 'Release channel'},
          semantic: 0.7,
          status: 'active',
          text: 'The release channel is stable.',
          uri: 'viking://user/me/memories/active.md',
        },
      ],
      {includeInactive: true, project: 'threadnote'},
    );

    expect(ranked.results[0]?.candidate.uri).toContain('active.md');
    expect(ranked.results[1]?.warnings).toContain('memory is archived');
  });

  it('keeps explicitly included archived matches eligible at the relevance threshold', () => {
    const ranked = rankRecallCandidates(
      'release channel',
      [
        {
          fields: {project: 'threadnote', title: 'Release channel'},
          semantic: 1,
          status: 'archived',
          text: 'The release channel is beta.',
          uri: 'viking://user/me/memories/archived.md',
        },
      ],
      {includeInactive: true, minimumScore: 0.45, project: 'threadnote'},
    );

    expect(ranked.results).toHaveLength(1);
    expect(ranked.results[0]?.relevanceScore).toBeGreaterThanOrEqual(0.45);
    expect(ranked.results[0]?.finalScore).toBeLessThan(ranked.results[0]?.relevanceScore ?? 0);
  });

  it('returns an explicit no-answer confidence instead of elevating authority-only noise', () => {
    const ranked = rankRecallCandidates('service mesh', [
      {
        authority: 'canonical_repo',
        fields: {title: 'Release checklist'},
        text: 'Publish npm package and changelog.',
        uri: 'viking://resources/repos/threadnote/release.md',
      },
    ]);

    expect(ranked.results).toEqual([]);
    expect(ranked.confidence.level).toBe('no_answer');
  });

  it('includes bounded user feedback as a transparent reranking signal', () => {
    const ranked = rankRecallCandidates('effect workflow', [
      {
        feedback: -1,
        fields: {title: 'Effect workflow'},
        semantic: 0.7,
        text: 'Effect workflow guidance.',
        uri: 'viking://user/me/memories/downranked.md',
      },
      {
        feedback: 1,
        fields: {title: 'Effect workflow'},
        semantic: 0.7,
        text: 'Effect workflow guidance.',
        uri: 'viking://user/me/memories/upranked.md',
      },
    ]);

    expect(ranked.results[0]?.candidate.uri).toContain('upranked.md');
    expect(ranked.results[0]?.reasons.map(reason => reason.code)).toContain('user_feedback');
  });

  it('keeps BM25 corpus statistics stable when the preselected result pool changes', () => {
    const target = {
      fields: {title: 'Rare lexical target'},
      text: 'rare-identifier bounded retry',
      uri: 'viking://resources/repos/threadnote/target.md',
    };
    const corpus = [
      target,
      ...Array.from({length: 100}, (_unused, index) => ({
        fields: {title: `Common document ${index}`},
        text: 'common retry guidance',
        uri: `viking://resources/repos/threadnote/common-${index}.md`,
      })),
    ];
    const corpusStatistics = buildRecallCorpusStatistics(corpus);
    const alone = rankRecallCandidates('rare-identifier', [target], {corpusStatistics});
    const withPool = rankRecallCandidates('rare-identifier', [target, corpus[1]!], {corpusStatistics});

    expect(alone.results[0]?.signals.bm25).toBe(withPool.results[0]?.signals.bm25);
    expect(corpusStatistics.documentCount).toBe(101);
  });
});
