import {describe, expect, it} from 'vitest';
import type {MemoryMetadata, MemoryRecord} from '../../src/memory_hygiene.js';
import {
  buildCompactPlan,
  existingReferencedUris,
  formatCompactPlan,
  handoffTopicForBranch,
  memoryContentWithHygieneSources,
  parseMemoryDocument,
  recallHygieneNudges,
  formatReferencedContextPointers,
  referencedUrisFromRecords,
} from '../../src/memory_hygiene.js';

function record(
  overrides: Omit<Partial<MemoryRecord>, 'metadata'> & {
    readonly metadata?: Partial<MemoryMetadata>;
  } & Pick<MemoryRecord, 'uri'>,
): MemoryRecord {
  const metadata = {
    kind: 'handoff' as const,
    project: 'mobile-native',
    sourceAgentClient: 'codex',
    status: 'active' as const,
    timestamp: '2026-05-20T00:00:00.000Z',
    topic: 'mobile-auth',
    ...overrides.metadata,
  };
  const body = overrides.body ?? 'task: keep going';
  return {
    body,
    content:
      overrides.content ??
      [
        metadata.kind === 'handoff' ? 'HANDOFF' : 'MEMORY',
        `kind: ${metadata.kind}`,
        `status: ${metadata.status}`,
        `project: ${metadata.project}`,
        metadata.topic ? `topic: ${metadata.topic}` : undefined,
        `source_agent_client: ${metadata.sourceAgentClient}`,
        `timestamp: ${metadata.timestamp}`,
        '',
        body,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
    headerTitle: overrides.headerTitle ?? (metadata.kind === 'handoff' ? 'HANDOFF' : 'MEMORY'),
    metadata,
    uri: overrides.uri,
  };
}

describe('buildCompactPlan', () => {
  it('keeps one exact duplicate and forgets redundant copies', () => {
    const stable = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/mobile-auth.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth', timestamp: '2026-05-20T00:00:00.000Z'},
      body: 'Shared auth contract.',
    });
    const duplicate = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/threadnote-2026.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth', timestamp: '2026-05-19T00:00:00.000Z'},
      body: 'Shared auth contract.',
    });

    const plan = buildCompactPlan([duplicate, stable], {project: 'mobile-native'});

    expect(plan.keepUpdates.map(action => action.uri)).toEqual([stable.uri]);
    expect(plan.forgets.map(action => action.uri)).toEqual([duplicate.uri]);
    expect(plan.archives).toEqual([]);
    expect(plan.keepUpdates[0]?.content).toContain(stable.uri);
    expect(plan.keepUpdates[0]?.content).toContain(duplicate.uri);
  });

  it('archives older non-exact handoffs for the same group', () => {
    const oldHandoff = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/threadnote-old.md',
      metadata: {timestamp: '2026-05-19T00:00:00.000Z'},
      body: 'task: first pass',
    });
    const newHandoff = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/mobile-auth.md',
      metadata: {timestamp: '2026-05-21T00:00:00.000Z'},
      body: 'task: latest status',
    });

    const plan = buildCompactPlan([oldHandoff, newHandoff], {project: 'mobile-native'});

    expect(plan.keepUpdates.map(action => action.uri)).toEqual([newHandoff.uri]);
    expect(plan.archives.map(action => action.uri)).toEqual([oldHandoff.uri]);
    expect(plan.forgets).toEqual([]);
    expect(plan.keepUpdates[0]?.content).toContain(oldHandoff.uri);
    expect(plan.keepUpdates[0]?.content).toContain(newHandoff.uri);
  });

  it('handles handoff groups with both duplicates and newer different content', () => {
    const duplicateA = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/threadnote-a.md',
      metadata: {timestamp: '2026-05-19T00:00:00.000Z'},
      body: 'task: old',
    });
    const duplicateB = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/threadnote-b.md',
      metadata: {timestamp: '2026-05-19T01:00:00.000Z'},
      body: 'task: old',
    });
    const latest = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/mobile-auth.md',
      metadata: {timestamp: '2026-05-21T00:00:00.000Z'},
      body: 'task: latest status',
    });

    const plan = buildCompactPlan([duplicateA, duplicateB, latest], {project: 'mobile-native'});

    expect(plan.keepUpdates.map(action => action.uri)).toEqual([latest.uri]);
    expect(plan.forgets.map(action => action.uri)).toEqual([duplicateA.uri]);
    expect(plan.archives.map(action => action.uri)).toEqual([duplicateB.uri]);
    expect(plan.keepUpdates[0]?.content).toContain(duplicateA.uri);
    expect(plan.keepUpdates[0]?.content).toContain(duplicateB.uri);
    expect(plan.keepUpdates[0]?.content).toContain(latest.uri);
  });

  it('leaves non-exact durable memories for manual review', () => {
    const left = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/mobile-auth.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth'},
      body: 'Contract A.',
    });
    const right = record({
      uri: 'threadnote://user/me/memories/durable/projects/mobile-native/threadnote-new.md',
      headerTitle: 'MEMORY',
      metadata: {kind: 'durable', topic: 'mobile-auth', timestamp: '2026-05-21T00:00:00.000Z'},
      body: 'Contract B.',
    });

    const plan = buildCompactPlan([left, right], {project: 'mobile-native'});

    expect(plan.keepUpdates).toEqual([]);
    expect(plan.archives).toEqual([]);
    expect(plan.forgets).toEqual([]);
    expect(plan.manualReview.map(item => item.uri).sort()).toEqual([left.uri, right.uri].sort());
  });

  it('reports stale singleton handoffs without mutating them', () => {
    const stale = record({
      uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/mobile-auth.md',
      metadata: {timestamp: '2026-05-01T00:00:00.000Z'},
      body: 'status: PR OPEN. Awaiting review.',
    });

    const plan = buildCompactPlan([stale], {now: new Date('2026-06-01T00:00:00.000Z'), project: 'mobile-native'});

    expect(plan.keepUpdates).toEqual([]);
    expect(plan.archives).toEqual([]);
    expect(plan.forgets).toEqual([]);
    expect(plan.manualReview).toEqual([{reason: 'stale-looking active handoff', uri: stale.uri}]);
  });
});

describe('memoryContentWithHygieneSources', () => {
  it('strips self-supersedes while preserving source URIs', () => {
    const uri = 'threadnote://user/me/memories/handoffs/active/mobile-native/mobile-auth.md';
    const input = record({
      content: [
        'HANDOFF',
        'kind: handoff',
        'status: active',
        'project: mobile-native',
        'topic: mobile-auth',
        'source_agent_client: codex',
        'timestamp: 2026-05-20T00:00:00.000Z',
        `supersedes: ${uri}`,
        '',
        'task: latest status',
      ].join('\n'),
      uri,
    });

    const output = memoryContentWithHygieneSources(input, [uri]);

    expect(output).not.toContain('supersedes:');
    expect(output).toContain('## Threadnote Hygiene Sources');
    expect(output).toContain(`- ${uri}`);
  });
});

describe('recallHygieneNudges', () => {
  it('returns no hint below thresholds', () => {
    const text = [
      'threadnote://user/me/memories/handoffs/active/mobile-native/a.md',
      'threadnote://user/me/memories/handoffs/active/mobile-native/b.md',
    ].join('\n');

    expect(recallHygieneNudges(text, {user: 'me'})).toEqual([]);
  });

  it('nudges for overlapping active memories', () => {
    const records = [1, 2, 3].map(index =>
      record({
        uri: `threadnote://user/me/memories/handoffs/active/mobile-native/threadnote-${index}.md`,
      }),
    );

    expect(recallHygieneNudges(records.map(item => item.uri).join('\n'), {records, user: 'me'})).toEqual([
      '3 active handoffs look overlapping for mobile-native/mobile-auth; run compact_context({"project":"mobile-native","topic":"mobile-auth","dryRun":true}).',
    ]);
  });

  it('nudges for many active project handoffs but ignores archived/shared/resources', () => {
    const active = Array.from(
      {length: 10},
      (_, index) => `threadnote://user/me/memories/handoffs/active/mobile-native/topic-${index}.md`,
    );
    const ignored = [
      'threadnote://user/me/memories/handoffs/archived/mobile-native/topic.md',
      'threadnote://user/me/memories/shared/default/durable/projects/mobile-native/topic.md',
      'threadnote://resources/repos/mobile-native/README.md',
    ];

    expect(recallHygieneNudges([...active, ...ignored].join('\n'), {user: 'me'})).toEqual([
      'Many active handoffs surfaced for mobile-native; run compact_context({"project":"mobile-native","dryRun":true}).',
    ]);
  });
});

describe('handoffTopicForBranch', () => {
  it('defaults bare handoffs to the current branch topic', () => {
    expect(handoffTopicForBranch('mobile-auth', {})).toBe('mobile-auth');
  });

  it('keeps timestamped handoffs opt-in', () => {
    expect(handoffTopicForBranch('mobile-auth', {timestamped: true})).toBeUndefined();
  });

  it('rejects timestamped handoffs with explicit topic', () => {
    expect(() => handoffTopicForBranch('mobile-auth', {timestamped: true, topic: 'feature'})).toThrow(
      'Cannot combine --timestamped with --topic.',
    );
  });
});

describe('formatCompactPlan', () => {
  it('prints the scoped dry-run plan', () => {
    const plan = buildCompactPlan(
      [
        record({
          uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/old.md',
          metadata: {timestamp: '2026-05-19T00:00:00.000Z'},
          body: 'task: old',
        }),
        record({
          uri: 'threadnote://user/me/memories/handoffs/active/mobile-native/mobile-auth.md',
          metadata: {timestamp: '2026-05-20T00:00:00.000Z'},
          body: 'task: new',
        }),
      ],
      {project: 'mobile-native'},
    );

    expect(formatCompactPlan(plan, {apply: false})).toContain('Dry-run memory hygiene plan for project mobile-native');
    expect(formatCompactPlan(plan, {apply: false})).toContain('Archive old handoffs');
  });
});

describe('references relation', () => {
  it('parses multiple references: header lines into metadata.references', () => {
    const content = [
      'HANDOFF',
      'kind: handoff',
      'status: active',
      'project: threadnote',
      'topic: my-branch',
      'source_agent_client: codex',
      'timestamp: 2026-07-02T00:00:00.000Z',
      'references: threadnote://user/me/memories/durable/projects/threadnote/design.md',
      'references: threadnote://user/me/memories/handoffs/active/threadnote/prior.md',
      '',
      'task: keep going',
    ].join('\n');
    const parsed = parseMemoryDocument(
      'threadnote://user/me/memories/handoffs/active/threadnote/my-branch.md',
      content,
    );
    expect(parsed?.metadata.references).toEqual([
      'threadnote://user/me/memories/durable/projects/threadnote/design.md',
      'threadnote://user/me/memories/handoffs/active/threadnote/prior.md',
    ]);
  });

  it('leaves references undefined when absent', () => {
    const content = ['MEMORY', 'kind: durable', 'status: active', 'project: x', '', 'body'].join('\n');
    const parsed = parseMemoryDocument('threadnote://user/me/memories/durable/projects/x/a.md', content);
    expect(parsed?.metadata.references).toBeUndefined();
  });

  it('collects referenced uris off records, skipping ones already surfaced', () => {
    const withRefs = record({
      uri: 'threadnote://user/me/memories/handoffs/active/threadnote/branch.md',
      metadata: {
        references: [
          'threadnote://user/me/memories/durable/projects/threadnote/design.md',
          'threadnote://user/me/memories/durable/projects/threadnote/shown.md',
        ],
      },
    });
    const recallOutput = 'surfaced: threadnote://user/me/memories/durable/projects/threadnote/shown.md';
    expect(referencedUrisFromRecords([withRefs], recallOutput)).toEqual([
      'threadnote://user/me/memories/durable/projects/threadnote/design.md',
    ]);
  });

  it('keeps only reference candidates that still resolve to memory records', () => {
    const first = 'threadnote://user/me/memories/durable/projects/threadnote/first.md';
    const missing = 'threadnote://user/me/memories/durable/projects/threadnote/missing.md';
    const second = 'threadnote://user/me/memories/durable/projects/threadnote/second.md';

    expect(
      existingReferencedUris(
        [first, missing, second],
        [record({uri: second, metadata: {kind: 'durable'}}), record({uri: first, metadata: {kind: 'durable'}})],
      ),
    ).toEqual([first, second]);
  });

  it('renders bounded URI-only pointers without referenced memory bodies', () => {
    expect(
      formatReferencedContextPointers(
        [
          'threadnote://user/me/memories/durable/projects/threadnote/first.md',
          'threadnote://user/me/memories/durable/projects/threadnote/second.md',
        ],
        1,
      ),
    ).toBe(
      [
        'Referenced read-only context (one-way pointers from surfaced memories):',
        '- threadnote://user/me/memories/durable/projects/threadnote/first.md',
        '- … 1 more referenced memory omitted',
      ].join('\n'),
    );
  });
});
