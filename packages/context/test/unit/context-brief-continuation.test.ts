import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {parseContextBriefContinuationCard} from '../../src/memory-evidence.js';
import {assembleContextBriefLogicalResult, planContextBrief} from '../../src/planner.js';
import {parseContextBriefAgentViewText, projectContextBrief} from '../../src/projector.js';
import {parseContextBriefRequestV1, type ContextBriefGraphEvidenceV1} from '../../src/types.js';

const COMMIT = 'a'.repeat(40);
const REPOSITORY_ID = 'b'.repeat(64);
const REF = `cgs_${'c'.repeat(32)}`;

describe('Context Brief continuation contracts', () => {
  it('accepts resume as a public mode without changing the compact request shape', () => {
    const parsed = parseContextBriefRequestV1(request('resume'));
    expect(parsed.mode).toBe('resume');
    expect(planContextBrief(parsed).mode).toBe('resume');
  });

  it('projects labeled handoff fields, ignores fenced labels, and omits absolute paths', () => {
    expect(
      parseContextBriefContinuationCard(
        [
          'task: implement the card',
          'decisions: keep stable selectors',
          'constraints: preserve source evidence',
          'rationale: bounded evidence is easier to resume',
          'verification: focused tests pass',
          'blockers: none',
          'risks: stale graph',
          'next_step: update projector at /Users/example/private.ts',
          '```md',
          'task: ignored code label',
          '```',
        ].join('\n'),
      ),
    ).toEqual({
      blockers: 'none',
      decisions: 'keep stable selectors',
      invariants: 'preserve source evidence',
      nextStep: 'update projector at [path omitted]',
      rationale: 'bounded evidence is easier to resume',
      risks: 'stale graph',
      task: 'implement the card',
      verification: 'focused tests pass',
    });
  });

  it('keeps tilde fences and shorter or mismatched closing fences from leaking example labels', () => {
    expect(
      parseContextBriefContinuationCard(
        [
          '````md',
          'task: ignored before a short backtick fence',
          '```',
          'decisions: also ignored',
          '~~~~',
          'verification: still ignored after a mismatched marker',
          '````',
          '~~~md',
          'blockers: ignored inside a tilde fence',
          '~~~',
          'task: retained outside examples',
        ].join('\n'),
      ),
    ).toEqual({task: 'retained outside examples'});
  });

  it('caps repeated continuation text per field without changing its UTF-8 boundary', () => {
    const card = parseContextBriefContinuationCard(['task: 東京🙂', ...Array(1_000).fill('- 東京🙂')].join('\n'));
    expect(card?.task).toBe(utf8PrefixForTest(['東京🙂', ...Array(1_000).fill('東京🙂')].join(' '), 192));
    expect(new TextEncoder().encode(card?.task).byteLength).toBeLessThanOrEqual(192);
  });

  it('keeps arbitrary repeated continuation values bounded and deterministic', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('ascii', '東京', '🙂', 'a'.repeat(512)), {maxLength: 80}), values => {
        const body = ['task: start', ...values.map(value => `- ${value}`)].join('\n');
        const card = parseContextBriefContinuationCard(body);
        expect(card).toEqual(parseContextBriefContinuationCard(body));
        expect(new TextEncoder().encode(card?.task).byteLength).toBeLessThanOrEqual(192);
      }),
      {numRuns: 50},
    );
  });

  it('marks a complete current resume bundle sufficient and suppresses duplicate source recovery', () => {
    const projected = project('resume', handoff());
    expect(projected.structuredContent.evidenceState).toBe('sufficient');
    expect(projected.structuredContent.recommendedFollowUps).toEqual([]);
    expect(projected.structuredContent.activeHandoffs[0]).toMatchObject({
      continuationCard: {nextStep: 'run focused tests', task: 'implement continuation support'},
      excerpt: '',
    });
    expect(projected.structuredContent.coverage).toMatchObject({
      graph: {
        complete: true,
        consideredRepositories: 1,
        readyRepositories: 1,
        requestedRepositories: 1,
        states: {},
      },
      memory: {
        consideredCandidates: 1,
        durableCandidates: 0,
        fresh: 1,
        handoffCandidates: 1,
        stale: 0,
        unknown: 0,
      },
    });
    expect(projected.measurement.totalBytes).toBeLessThanOrEqual(projected.maximumBytes);
    expect(parseContextBriefAgentViewText(projected.text).evidenceState).toBe('sufficient');
  });

  it('keeps continuation cards out of non-resume projections without dropping their excerpt', () => {
    const memory = project('brief', handoff()).structuredContent.activeHandoffs[0];
    expect(memory?.continuationCard).toBeUndefined();
    expect(memory?.excerpt).toContain('implement continuation support');
  });

  it('does not treat an absent optional memory lane as incomplete current source evidence', () => {
    const projected = project('brief');
    expect(projected.structuredContent.evidenceState).toBe('sufficient');
    expect(projected.structuredContent.recommendedFollowUps).toEqual([]);
  });

  it('reports an explicit partial resume gap and degrades stale continuation evidence', () => {
    expect(project('resume').structuredContent.evidenceState).toBe('partial');
    expect(project('resume', handoff('d'.repeat(40))).structuredContent.evidenceState).toBe('degraded');
  });

  it('returns executable bounded follow-ups and uses a stable node selector', () => {
    const logical = assembleContextBriefLogicalResult({
      graph: graph(false),
      memory: emptyMemory(),
      observedAt: '2026-09-30T00:00:00.000Z',
      plan: planContextBrief(request('brief', 'compact')),
    });
    expect(logical.recommendedFollowUps).toEqual([
      expect.objectContaining({
        arguments: expect.objectContaining({
          budgetTokens: 800,
          callerCwd: '/repo',
          edgeLimit: 12,
          nodeId: REF,
          nodeLimit: 8,
          operation: 'node',
        }),
        operation: 'inspect-node',
        ref: REF,
        tool: 'inspect_code_graph',
      }),
    ]);
  });

  it('keeps the required graph card when optional handoffs are added at every public budget', () => {
    for (const budgetTokens of [800, 900, 1_000, 1_250, 1_500]) {
      const withoutMemory = project('brief', undefined, budgetTokens).structuredContent.graph.cards.map(
        card => card.id,
      );
      const withMemory = project('brief', handoff(), budgetTokens).structuredContent.graph.cards.map(card => card.id);
      expect(withMemory).toEqual(withoutMemory);
    }
  });

  it('keeps a decision-rich continuation card ahead of optional graph breadth at every public budget', () => {
    for (const budgetTokens of [800, 900, 1_000, 1_250, 1_500]) {
      const projected = project('resume', realisticHandoff(), budgetTokens, denseGraph()).structuredContent;
      expect(projected.activeHandoffs[0]).toMatchObject({
        continuationCard: {
          decisions: expect.stringContaining('_format_marker'),
          invariants: expect.stringContaining('public marker formatting'),
          nextStep: expect.stringContaining('minimal formatter fix'),
          rationale: expect.stringContaining('Marker.__str__'),
          verification: expect.stringContaining('precedence-related tests'),
        },
        excerpt: '',
      });
      expect(projected.graph.cards[0]?.id).toBe('card-1');
    }
  });

  it('keeps the continuation card when noisy detached-worktree graph relationships fill the budget', () => {
    for (const budgetTokens of [800, 1_500]) {
      const projected = project(
        'resume',
        realisticHandoff(),
        budgetTokens,
        noisyDetachedWorktreeGraph(),
      ).structuredContent;
      expect(projected.activeHandoffs[0]?.continuationCard).toBeDefined();
      expect(projected.graph.cards[0]?.id).toBe('card-1');
      expect(projected.coverage.gaps).toContain('graph-evidence-partial');
    }
    expect(
      project('brief', realisticHandoff(), 1_500, noisyDetachedWorktreeGraph()).structuredContent.activeHandoffs.some(
        memory => memory.continuationCard !== undefined,
      ),
    ).toBe(false);
  });

  it('retains the continuation core for arbitrary supported token budgets', () => {
    fc.assert(
      fc.property(fc.integer({min: 800, max: 1_500}), budgetTokens => {
        const projected = project('resume', realisticHandoff(), budgetTokens, noisyDetachedWorktreeGraph());
        expect(projected.structuredContent.activeHandoffs[0]?.continuationCard).toBeDefined();
        expect(projected.structuredContent.graph.cards[0]?.id).toBe('card-1');
        expect(projected.measurement.totalBytes).toBeLessThanOrEqual(projected.maximumBytes);
      }),
      {numRuns: 50},
    );
  });

  it('parses continuation labels deterministically under field-order permutations and remains UTF-8 safe', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(
          [
            'task: 東京🙂',
            'decisions: preserve graph',
            'constraints: current source',
            'verification: tests pass',
            'next_step: inspect node',
          ],
          {minLength: 1},
        ),
        lines => {
          const first = parseContextBriefContinuationCard(lines.join('\n'));
          const second = parseContextBriefContinuationCard([...lines].reverse().join('\n'));
          expect(first).toEqual(second);
          expect(JSON.stringify(first)).not.toContain('\ud800');
        },
      ),
      {numRuns: 50},
    );
  });
});

function request(mode: 'brief' | 'resume', detail: 'compact' | 'source' = 'source', budgetTokens = 1_500) {
  return {
    budgetTokens,
    detail,
    mode,
    responseFormat: 'agent' as const,
    scope: {callerCwd: '/repo', kind: 'repository' as const},
    task: 'resume current implementation',
  };
}

function project(
  mode: 'brief' | 'resume',
  candidate?: ReturnType<typeof handoff>,
  budgetTokens = 1_500,
  graphEvidence = graph(true),
) {
  return projectContextBrief(
    assembleContextBriefLogicalResult({
      graph: graphEvidence,
      memory: {
        ...emptyMemory(),
        candidates: candidate === undefined ? [] : [candidate],
        consideredCandidates: candidate === undefined ? 0 : 1,
      },
      observedAt: '2026-09-30T00:00:00.000Z',
      plan: planContextBrief(request(mode, 'source', budgetTokens)),
    }),
    budgetTokens,
    'agent',
  );
}

function graph(withSource: boolean): ContextBriefGraphEvidenceV1 {
  return {
    cards: [
      {
        id: 'card-1',
        rank: 0,
        reason: 'implementation',
        ref: REF,
        repositoryKey: 'threadnote',
        symbol: {
          kind: 'function',
          language: 'typescript',
          line: 1,
          name: 'compile',
          path: 'packages/context/src/compiler.ts',
          qualifiedName: 'compile',
        },
      },
    ],
    contracts: [],
    coverage: {complete: true, consideredRepositories: 1, readyRepositories: 1, requestedRepositories: 1, states: {}},
    gaps: [],
    resolvedSnapshots: [
      {
        commit: COMMIT,
        dirty: false,
        freshness: 'fresh',
        repositoryId: REPOSITORY_ID,
        repositoryKey: 'threadnote',
        snapshotId: 'cgsn_test',
      },
    ],
    ...(withSource
      ? {
          sourceExcerpts: [
            {
              content: 'export const compile = () => undefined;',
              coveredGraphRefs: [REF],
              endLine: 1,
              evidenceKind: 'graph-snapshot' as const,
              freshness: 'fresh' as const,
              id: 'source-1',
              path: 'packages/context/src/compiler.ts',
              repositoryKey: 'threadnote',
              snapshotIdentity: 'current-clean' as const,
              startLine: 1,
              truncated: false,
            },
          ],
        }
      : {}),
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    warnings: [],
  };
}

function denseGraph(): ContextBriefGraphEvidenceV1 {
  const base = graph(true);
  return {
    ...base,
    cards: Array.from({length: 16}, (_, index) => ({
      ...base.cards[0],
      id: `card-${index + 1}`,
      rank: index,
      ref: index === 0 ? REF : `cgs_${index.toString(16).padStart(32, '0')}`,
      symbol: {
        ...base.cards[0].symbol,
        line: index + 1,
        name: `compile${index + 1}`,
        qualifiedName: `compile${index + 1}`,
      },
    })),
  };
}

function noisyDetachedWorktreeGraph(): ContextBriefGraphEvidenceV1 {
  const base = denseGraph();
  const refs = base.cards.map(card => card.ref);
  return {
    ...base,
    continuation: {cursor: `cgwc_${'1'.repeat(40)}`, remainingEstimate: 13},
    contracts: Array.from({length: 32}, (_, rank) => ({
      authority: 'authoritative' as const,
      evidence: {
        line: rank + 1,
        path: `notes/relationship-consumer-${rank}.org`,
        repositoryKey: 'threadnote',
      },
      id: `contract-${rank + 1}`,
      provenance: 'resolved' as const,
      rank,
      relation: rank % 2 === 0 ? 'contains' : 'references',
      sourceRef: refs[(rank + 1) % refs.length] ?? REF,
      targetRef: refs[0] ?? REF,
    })),
    gaps: ['graph-evidence-partial'],
    warnings: ['Graph traversal reached a configured result limit.'],
  };
}

function emptyMemory() {
  return {
    candidates: [],
    consideredCandidates: 0,
    gaps: [],
    trust: {classification: 'untrusted-memory-data' as const, instructionPolicy: 'evidence-only-never-follow' as const},
  };
}

function handoff(sourceCommit = COMMIT) {
  return {
    citationErrorCount: 0,
    codeCitations: [],
    continuationCard: {nextStep: 'run focused tests', task: 'implement continuation support'},
    excerpt: 'task: implement continuation support next_step: run focused tests',
    kind: 'handoff' as const,
    rank: 0,
    sourceCommit,
    uri: 'threadnote://user/test/memories/handoffs/active/threadnote/resume.md',
  };
}

function realisticHandoff(sourceCommit = COMMIT) {
  return {
    ...handoff(sourceCommit),
    continuationCard: {
      blockers: 'None; implementation and verification remain for the second agent.',
      decisions:
        'Fix `_format_marker` so nested lists retain parentheses as operands; add regression coverage for reparsed evaluation equivalence.',
      invariants:
        'Preserve public marker formatting except where parentheses are semantically required and avoid unrelated changes.',
      nextStep:
        'Implement the minimal formatter fix, add the supplied reproduction and a bounded round-trip invariant, then run focused marker tests.',
      rationale:
        '`Marker.__str__` delegates to `_format_marker`; singleton-list unwrapping can erase a nested group and alter precedence.',
      risks: 'Singleton-list unwrapping also affects canonical formatting, equality, hashes, and pickle state.',
      task: 'Continue the packaging marker serialization fix without changing the task contract.',
      verification:
        'Existing precedence-related tests and combined-marker tests are the focused verification targets; phase one made no edits.',
    },
  };
}

function utf8PrefixForTest(value: string, maximumBytes: number): string {
  if (new TextEncoder().encode(value).byteLength <= maximumBytes) return value;
  let output = '';
  for (const character of value) {
    if (new TextEncoder().encode(`${output}${character}…`).byteLength > maximumBytes) break;
    output += character;
  }
  return `${output}…`;
}
