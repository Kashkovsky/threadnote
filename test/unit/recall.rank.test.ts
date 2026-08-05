import {describe, expect, it} from 'vitest';
import {buildRecallCorpusStatistics, rankRecallCandidates, RECALL_RANKER_VERSION} from '../../src/recall/rank.js';

describe('hybrid recall ranker', () => {
  it('treats enriched keywords as focused topical evidence', () => {
    const candidate = {
      fields: {
        keywords: ['resume jobs after stalled heartbeat', 'worker lease renewal'],
        project: 'orion-worker',
        title: 'Lease coordinator',
        topic: 'lease-renewal',
      },
      kind: 'durable' as const,
      text: 'Reschedules work after a stalled heartbeat.',
      uri: 'threadnote://user/me/memories/lease-renewal.md',
    };
    const ranked = rankRecallCandidates('resume jobs after a stalled heartbeat', [candidate], {
      project: 'orion-worker',
    });
    const withoutKeywords = rankRecallCandidates(
      'resume jobs after a stalled heartbeat',
      [{...candidate, fields: {...candidate.fields, keywords: undefined}}],
      {project: 'orion-worker'},
    );

    expect(ranked.results[0]?.candidate.uri).toContain('lease-renewal.md');
    expect(ranked.results[0]?.signals.field).toBeGreaterThan(withoutKeywords.results[0]?.signals.field ?? 0);
  });

  it('scores each enriched keyword phrase independently so other aliases do not dilute a strong match', () => {
    const ranked = rankRecallCandidates(
      'why does queued work remain stalled after a heartbeat timeout',
      [
        {
          fields: {
            keywords: [
              'queued work stalled recovery',
              'heartbeat lease renewal failure',
              'automatic task rescheduling',
              'worker heartbeat timeout',
              'stalled job recovery',
              'lease renewal dead end',
            ],
            project: 'orion-worker',
            topic: 'lease-renewal',
          },
          kind: 'durable',
          text: 'A bounded coordinator reschedules stalled work.',
          uri: 'threadnote://user/me/memories/lease-renewal.md',
        },
      ],
      {project: 'orion-worker'},
    );

    expect(ranked.results[0]?.candidate.uri).toContain('lease-renewal.md');
    expect(ranked.results[0]?.signals.field).toBeGreaterThan(0.08);
  });

  it('combines semantic, BM25/IDF, and field-aware identifier evidence', () => {
    const ranked = rankRecallCandidates(
      'alpha-42 retry policy',
      [
        {
          fields: {project: 'threadnote', title: 'General retry notes'},
          semantic: 0.78,
          text: 'Common retry retry retry information.',
          uri: 'threadnote://resources/repos/threadnote/general.md',
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
          uri: 'threadnote://resources/repos/threadnote/alpha-42.md',
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

  it('keeps an untrusted seeded resource below an active durable memory that owns the topic', () => {
    const resourceUri = 'threadnote://resources/repos/threadnote/.graph.md/code-graph-snapshot-lease.md';
    const memoryUri =
      'threadnote://user/me/memories/shared/threadnote/durable/projects/threadnote/graph-administration.md';
    const ranked = rankRecallCandidates(
      'code graph snapshot lease',
      [
        {
          authority: 'external',
          fields: {
            project: 'threadnote',
            title: 'Code graph snapshot lease',
            topic: 'code-graph-snapshot-lease',
          },
          status: 'active',
          text: 'Generated notes about the code graph snapshot lease.',
          trust: 'untrusted',
          uri: resourceUri,
        },
        {
          authority: 'reviewed_shared',
          fields: {
            project: 'threadnote',
            title: 'Graph administration',
            topic: 'graph-administration',
          },
          kind: 'durable',
          status: 'active',
          text: 'Snapshot lease retirement and code graph maintenance policy.',
          trust: 'approved',
          uri: memoryUri,
        },
      ],
      {now: new Date('2026-08-05T00:00:00.000Z'), project: 'threadnote'},
    );

    expect(ranked.results[0]?.candidate.uri).toBe(memoryUri);
    expect(ranked.results.map(result => result.candidate.uri)).toContain(resourceUri);
  });

  it('uses native reranker evidence as a bounded, explained ranking signal', () => {
    const ranked = rankRecallCandidates(
      'worker lease timeout recovery',
      [
        {
          reranker: 0.12,
          semantic: 0.72,
          text: 'Worker lease timeout recovery.',
          uri: 'threadnote://low-reranker',
        },
        {
          reranker: 0.94,
          semantic: 0.72,
          text: 'Worker lease timeout recovery.',
          uri: 'threadnote://high-reranker',
        },
      ],
      {},
    );

    expect(ranked.results[0]?.candidate.uri).toBe('threadnote://high-reranker');
    expect(ranked.results[0]?.signals.reranker).toBe(0.94);
    expect(ranked.results[0]?.reasons.map(reason => reason.code)).toContain('native_reranker');
  });

  it('uses expanded query vocabulary without weakening original-query evidence', () => {
    const candidates = [
      {
        fields: {project: 'threadnote', title: 'Beta update channel', topic: 'beta-update-channel'},
        kind: 'durable' as const,
        text: 'Prerelease packages use npm beta dist-tag; stable packages use latest.',
        uri: 'threadnote://user/me/memories/beta-update-channel.md',
      },
      {
        fields: {project: 'threadnote', title: 'Ordinary installation troubleshooting'},
        semantic: 0.5,
        text: 'Ordinary installation troubleshooting.',
        uri: 'threadnote://user/me/memories/install-troubleshooting.md',
      },
    ];
    const query = 'How do preview builds get upgraded compared with ordinary installs?';
    const original = rankRecallCandidates(query, candidates, {project: 'threadnote'});
    const expanded = rankRecallCandidates(query, candidates, {
      project: 'threadnote',
      queryVariants: ['beta prerelease channel npm dist-tag stable latest'],
    });

    expect(original.results[0]?.candidate.uri).toContain('install-troubleshooting.md');
    expect(expanded.results[0]?.candidate.uri).toContain('beta-update-channel.md');
    expect(expanded.results.some(result => result.candidate.uri.includes('install-troubleshooting.md'))).toBe(true);
    expect(expanded.results[0]?.signals.bm25).toBeGreaterThan(original.results[0]?.signals.bm25 ?? 0);
  });

  it('prefers an exact compound topic over a general body match', () => {
    const ranked = rankRecallCandidates(
      'threadnote user preference posting style for release notes',
      [
        {
          fields: {
            project: 'agent-posting',
            title: 'Denys writing style',
            topic: 'denys-writing-style',
          },
          kind: 'preference',
          semantic: 0.69,
          text: 'General posting style guidance that mentions release notes among many other formats.',
          uri: 'threadnote://user/me/memories/preferences/denys-writing-style.md',
        },
        {
          fields: {
            project: 'github',
            title: 'Release notes',
            topic: 'release-notes',
          },
          kind: 'preference',
          semantic: 0.68,
          text: 'Release descriptions should emphasize end-user value.',
          uri: 'threadnote://user/me/memories/preferences/release-notes.md',
        },
      ],
      {project: 'threadnote', now: new Date('2026-07-23T00:00:00.000Z')},
    );

    expect(ranked.results[0]?.candidate.uri).toContain('release-notes.md');
    expect(ranked.results[0]?.reasons.map(reason => reason.code)).toContain('memory_kind_intent');
    expect(ranked.results[0]?.signals.field).toBeGreaterThan(ranked.results[1]?.signals.field ?? 0);
  });

  it('uses memory-kind intent to prefer durable contracts over related handoffs', () => {
    const ranked = rankRecallCandidates(
      'threadnote native Windows support contract and unsupported installation requirements',
      [
        {
          fields: {project: 'threadnote', title: 'Recall and memory formation', topic: 'recall-and-memory-formation'},
          kind: 'handoff',
          semantic: 0.73,
          text: 'Windows installation remains unsupported and is documented in shared durable memory.',
          uri: 'threadnote://user/me/memories/handoffs/active/threadnote/recall-and-memory-formation.md',
        },
        {
          authority: 'reviewed_shared',
          fields: {
            project: 'threadnote',
            title: 'Windows installation support',
            topic: 'windows-installation-support',
          },
          kind: 'durable',
          semantic: 0.68,
          text: 'Native Windows installation is unsupported until the package, model, and lifecycle gates pass.',
          trust: 'approved',
          uri: 'threadnote://user/me/memories/shared/default/durable/projects/threadnote/windows-installation-support.md',
        },
      ],
      {project: 'threadnote', now: new Date('2026-07-23T00:00:00.000Z')},
    );

    expect(ranked.results[0]?.candidate.uri).toContain('windows-installation-support.md');
    expect(ranked.results[0]?.signals.kindIntent).toBe(1);
    expect(ranked.results[1]?.signals.kindIntent).toBe(0);
  });

  it('rescues a focused exact field without boosting a project-name-only match', () => {
    const ranked = rankRecallCandidates(
      'threadnote can users install reliably on native Windows what remains unsupported',
      [
        {
          exactTerms: ['threadnote'],
          fields: {project: 'threadnote', title: 'Threadnote macOS native app', topic: 'macos-native-app'},
          kind: 'durable',
          semantic: 0.69,
          text: 'Threadnote macOS application guidance.',
          uri: 'threadnote://user/me/memories/durable/projects/threadnote/macos-native-app.md',
        },
        {
          authority: 'reviewed_shared',
          exactTerms: ['windows'],
          fields: {
            project: 'threadnote',
            title: 'Windows installation support',
            topic: 'windows-installation-support',
          },
          kind: 'durable',
          text: 'Native Windows installation remains unsupported.',
          trust: 'approved',
          uri: 'threadnote://user/me/memories/shared/default/durable/projects/threadnote/windows-installation-support.md',
        },
      ],
      {
        allowExactRescue: true,
        minimumScore: 0.45,
        project: 'threadnote',
        now: new Date('2026-07-23T00:00:00.000Z'),
      },
    );

    expect(ranked.results[0]?.candidate.uri).toContain('windows-installation-support.md');
    expect(ranked.results[0]?.signals.exact).toBe(1);
    expect(ranked.results.find(result => result.candidate.uri.includes('macos-native-app'))).toBeUndefined();
  });

  it('weights discriminative exact terms above common project-name matches', () => {
    const ranked = rankRecallCandidates(
      'Threadnote Windows installation issue durable decision',
      [
        {
          exactTerms: ['Threadnote', 'installation', 'decision'],
          fields: {project: 'threadnote', title: 'macos-native-app.md', topic: 'macos-native-app'},
          kind: 'durable',
          semantic: 0.62,
          text: 'Threadnote native app installation decision.',
          uri: 'threadnote://user/me/memories/durable/projects/threadnote/macos-native-app.md',
        },
        {
          authority: 'reviewed_shared',
          exactTerms: ['Windows', 'installation', 'decision'],
          fields: {project: 'threadnote', title: 'Current status', topic: 'windows-installation-support'},
          kind: 'durable',
          text: 'Windows installation remains unsupported by a durable product decision.',
          trust: 'approved',
          uri: 'threadnote://user/me/memories/shared/default/durable/projects/threadnote/windows-installation-support.md',
        },
      ],
      {
        corpusStatistics: {
          averageDocumentLength: 100,
          documentCount: 59,
          documentFrequency: {
            decision: 7,
            durable: 18,
            installation: 7,
            issue: 7,
            threadnote: 55,
            windows: 4,
          },
          totalDocumentLength: 5_900,
        },
        allowExactRescue: true,
        minimumScore: 0.5,
        now: new Date('2026-07-23T00:00:00.000Z'),
        project: 'threadnote',
      },
    );

    expect(ranked.results[0]?.candidate.uri).toContain('windows-installation-support.md');
    expect(ranked.results[0]?.signals.exact).toBeGreaterThan(ranked.results[1]?.signals.exact ?? 0);
  });

  it('does not let default exact rescue bypass an explicit strict minimum', () => {
    const ranked = rankRecallCandidates(
      'Windows installation decision',
      [
        {
          exactTerms: ['Windows', 'installation', 'decision'],
          fields: {project: 'threadnote', title: 'Windows installation', topic: 'windows-installation'},
          kind: 'durable',
          text: 'Windows installation decision.',
          uri: 'threadnote://user/me/memories/windows-installation.md',
        },
      ],
      {allowExactRescue: false, minimumScore: 0.95, project: 'threadnote'},
    );

    expect(ranked.results).toEqual([]);
    expect(ranked.confidence.level).toBe('no_answer');
  });

  it('does not treat a matching project field as topical evidence by itself', () => {
    const ranked = rankRecallCandidates('threadnote quantum networking policy', [
      {
        fields: {project: 'threadnote'},
        text: 'Unrelated deployment instructions.',
        uri: 'threadnote://user/me/memories/unrelated.md',
      },
    ]);

    expect(ranked.results).toEqual([]);
    expect(ranked.confidence.level).toBe('no_answer');
  });

  it('does not treat a project-only exact identifier as topical evidence', () => {
    const ranked = rankRecallCandidates(
      'my-project quantum networking',
      [
        {
          exactTerms: ['my-project'],
          fields: {project: 'my-project'},
          kind: 'durable',
          text: 'Unrelated deployment instructions.',
          uri: 'threadnote://user/me/memories/unrelated.md',
        },
      ],
      {allowExactRescue: true, minimumScore: 0.45, project: 'my-project'},
    );

    expect(ranked.results).toEqual([]);
    expect(ranked.confidence.level).toBe('no_answer');
  });

  it('does not reuse a generic kind-intent term as exact rescue evidence', () => {
    const ranked = rankRecallCandidates(
      'quantum networking policy',
      [
        {
          exactTerms: ['policy'],
          fields: {title: 'Policy'},
          kind: 'durable',
          text: 'Policy for unrelated deployments.',
          uri: 'threadnote://user/me/memories/unrelated-policy.md',
        },
      ],
      {allowExactRescue: true, minimumScore: 0.45},
    );

    expect(ranked.results).toEqual([]);
    expect(ranked.confidence.level).toBe('no_answer');
  });

  it('rejects body-only lexical overlap without focused field or semantic evidence', () => {
    const ranked = rankRecallCandidates(
      'kubernetes helm chart canary rollout istio service mesh',
      [
        {
          exactTerms: ['kubernetes', 'canary', 'rollout', 'service'],
          fields: {project: 'threadnote', title: 'Recall quality backlog', topic: 'recall-quality-backlog'},
          kind: 'durable',
          text: 'A negative-control query once used kubernetes canary rollout service mesh as its example.',
          uri: 'threadnote://user/me/memories/durable/projects/threadnote/recall-quality-backlog.md',
        },
      ],
      {allowExactRescue: true, project: 'threadnote'},
    );

    expect(ranked.results).toEqual([]);
    expect(ranked.confidence.level).toBe('no_answer');
  });

  it('keeps lexical-only matches whose topic directly names the query', () => {
    const ranked = rankRecallCandidates(
      'QX7 worker lease',
      [
        {
          exactTerms: ['QX7', 'lease'],
          fields: {project: 'orion-worker', title: 'QX7 lease flow', topic: 'qx7-lease-flow'},
          kind: 'durable',
          text: 'The QX7 worker renews its execution lease.',
          uri: 'threadnote://user/me/memories/durable/projects/orion-worker/qx7-lease-flow.md',
        },
      ],
      {allowExactRescue: true, project: 'orion-worker'},
    );

    expect(ranked.results.map(result => result.candidate.uri)).toEqual([
      'threadnote://user/me/memories/durable/projects/orion-worker/qx7-lease-flow.md',
    ]);
  });

  it('keeps evaluation and backlog topics out of feature recall unless the query asks for them', () => {
    const candidate = {
      fields: {
        project: 'threadnote',
        title: 'Recall paraphrase evaluation',
        topic: 'recall-quality-live-paraphrase-evaluation',
      },
      kind: 'durable' as const,
      semantic: 0.8,
      text: 'The evaluation records which ranking-signal paraphrases passed.',
      uri: 'threadnote://user/me/memories/durable/projects/threadnote/recall-quality-evaluation.md',
    };

    expect(rankRecallCandidates('what controls memory ranking signals', [candidate]).results).toEqual([]);
    expect(rankRecallCandidates('what did the recall quality evaluation find', [candidate]).results).toHaveLength(1);
  });

  it('uses typed graph proximity without allowing authority to bypass topical relevance', () => {
    const seedUri = 'threadnote://resources/repos/threadnote/design.md';
    const ranked = rankRecallCandidates(
      'candidate review',
      [
        {
          authority: 'canonical_repo',
          fields: {title: 'Unrelated deployment guide'},
          semantic: 0,
          text: 'Kubernetes deployment topology.',
          uri: 'threadnote://resources/repos/threadnote/deploy.md',
        },
        {
          authority: 'agent_generated',
          fields: {title: 'Candidate review'},
          relations: [{type: 'evidence_for', uri: seedUri}],
          semantic: 0.45,
          text: 'Candidate review requires approval.',
          uri: 'threadnote://user/me/memories/candidate.md',
        },
      ],
      {seedUris: [seedUri]},
    );

    expect(ranked.results.map(result => result.candidate.uri)).toEqual(['threadnote://user/me/memories/candidate.md']);
    expect(ranked.results[0]?.signals.graph).toBeGreaterThan(0);
    expect(ranked.results[0]?.reasons.map(reason => reason.code)).toContain('graph_proximity');
  });

  it('does not let graph proximity alone bypass the topical relevance gate', () => {
    const seedUri = 'threadnote://resources/repos/threadnote/design.md';
    const ranked = rankRecallCandidates(
      'candidate review',
      [
        {
          authority: 'canonical_repo',
          fields: {title: 'Unrelated deployment guide'},
          relations: [{type: 'evidence_for', uri: seedUri}],
          semantic: 0,
          text: 'Kubernetes deployment topology.',
          uri: 'threadnote://resources/repos/threadnote/unrelated.md',
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
          uri: 'threadnote://user/me/memories/old.md',
          validTo: '2026-01-01T00:00:00.000Z',
        },
        {
          fields: {title: 'Release channel'},
          semantic: 0.7,
          status: 'active',
          text: 'The release channel is stable.',
          uri: 'threadnote://user/me/memories/current.md',
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
          uri: 'threadnote://user/me/memories/archived.md',
        },
        {
          fields: {project: 'threadnote', title: 'Release channel'},
          semantic: 0.7,
          status: 'active',
          text: 'The release channel is stable.',
          uri: 'threadnote://user/me/memories/active.md',
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
          exactTerms: ['release', 'channel'],
          fields: {project: 'threadnote', title: 'Release channel'},
          semantic: 1,
          status: 'archived',
          text: 'The release channel is beta.',
          uri: 'threadnote://user/me/memories/archived.md',
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
        uri: 'threadnote://resources/repos/threadnote/release.md',
      },
    ]);

    expect(ranked.results).toEqual([]);
    expect(ranked.confidence.level).toBe('no_answer');
  });

  it('rejects uncorroborated semantic background similarity below the measured answer boundary', () => {
    const ranked = rankRecallCandidates('quantum networking policy', [
      {
        authority: 'canonical_repo',
        semantic: 0.78,
        status: 'active',
        text: 'Publish the package and verify its release tag.',
        trust: 'approved',
        uri: 'threadnote://resources/repos/threadnote/release.md',
      },
    ]);

    expect(ranked.results).toHaveLength(1);
    expect(ranked.confidence.level).toBe('no_answer');
  });

  it('allows exceptionally strong semantic evidence without lexical overlap', () => {
    const ranked = rankRecallCandidates('resume jobs after a stalled heartbeat', [
      {
        authority: 'canonical_repo',
        semantic: 0.98,
        status: 'active',
        text: 'The coordinator reschedules work when worker liveness expires.',
        trust: 'approved',
        uri: 'threadnote://resources/repos/orion/lease-renewal.md',
      },
    ]);

    expect(ranked.results).toHaveLength(1);
    expect(ranked.confidence.level).not.toBe('no_answer');
  });

  it('includes bounded user feedback as a transparent reranking signal', () => {
    const ranked = rankRecallCandidates('effect workflow', [
      {
        feedback: -1,
        fields: {title: 'Effect workflow'},
        semantic: 0.7,
        text: 'Effect workflow guidance.',
        uri: 'threadnote://user/me/memories/downranked.md',
      },
      {
        feedback: 1,
        fields: {title: 'Effect workflow'},
        semantic: 0.7,
        text: 'Effect workflow guidance.',
        uri: 'threadnote://user/me/memories/upranked.md',
      },
    ]);

    expect(ranked.results[0]?.candidate.uri).toContain('upranked.md');
    expect(ranked.results[0]?.reasons.map(reason => reason.code)).toContain('user_feedback');
  });

  it('keeps BM25 corpus statistics stable when the preselected result pool changes', () => {
    const target = {
      fields: {title: 'Rare lexical target'},
      text: 'rare-identifier bounded retry',
      uri: 'threadnote://resources/repos/threadnote/target.md',
    };
    const corpus = [
      target,
      ...Array.from({length: 100}, (_unused, index) => ({
        fields: {title: `Common document ${index}`},
        text: 'common retry guidance',
        uri: `threadnote://resources/repos/threadnote/common-${index}.md`,
      })),
    ];
    const corpusStatistics = buildRecallCorpusStatistics(corpus);
    const alone = rankRecallCandidates('rare-identifier', [target], {corpusStatistics});
    const withPool = rankRecallCandidates('rare-identifier', [target, corpus[1]!], {corpusStatistics});

    expect(alone.results[0]?.signals.bm25).toBe(withPool.results[0]?.signals.bm25);
    expect(corpusStatistics.documentCount).toBe(101);
  });
});
