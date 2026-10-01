import {it as effectIt} from '@effect/vitest';
import {Effect, Ref} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codexResumeIneligibilityReason,
  contextBriefIsEligibleForCodexResume,
  decideCodexResumePreload,
  parseCodexResumeHookEvent,
  projectCodexResumePreload,
  promptCarriesActiveHandoff,
  renderCodexResumeHookOutput,
  type CodexResumeHookEvent,
  type CodexResumeReceiptV1,
} from '@threadnote/threadnote/codex/resume_hook';
import type {
  ContextBriefContinuationCardV1,
  ContextBriefEvidenceState,
  ContextBriefLogicalResultV1,
  ProjectedContextBriefV1,
} from '@threadnote/context/types';

const event: CodexResumeHookEvent = {
  cwd: '/repo',
  hookEventName: 'UserPromptSubmit',
  prompt: 'Continue the implementation',
  sessionId: 'session-1',
  turnId: 'turn-1',
};

describe('Codex resume preload', () => {
  effectIt.effect('injects once per evidence generation and reinjects only after generation changes', () =>
    Effect.gen(function* () {
      let receipt: CodexResumeReceiptV1 | undefined;
      let compileCalls = 0;
      let deliveries = 0;
      const dependencies = {
        compile: () =>
          Effect.sync(() => {
            compileCalls += 1;
            return projected('sufficient');
          }),
        deliver: () =>
          Effect.sync(() => {
            deliveries += 1;
          }),
        receipt: Effect.sync(() => receipt),
        writeReceipt: (next: CodexResumeReceiptV1) =>
          Effect.sync(() => {
            receipt = next;
          }),
      };

      const first = yield* decideCodexResumePreload(dependencies, event, 'a'.repeat(64));
      const second = yield* decideCodexResumePreload(dependencies, {...event, turnId: 'turn-2'}, 'a'.repeat(64));
      const changed = yield* decideCodexResumePreload(dependencies, {...event, turnId: 'turn-3'}, 'b'.repeat(64));

      expect(first).toMatchObject({outcome: 'injected', evidenceState: 'sufficient'});
      expect(second).toEqual({estimatedTokens: 0, outcome: 'already-preloaded', outputBytes: 0});
      expect(changed).toMatchObject({outcome: 'injected', evidenceState: 'sufficient'});
      expect(compileCalls).toBe(2);
      expect(deliveries).toBe(2);
      expect(receipt).toMatchObject({evidenceGeneration: 'b'.repeat(64), version: 1});
    }),
  );

  effectIt.effect('accepts handoff-specific partial evidence and rejects empty, stale, or handoff-free delivery', () =>
    Effect.gen(function* () {
      const emptyReceipts = new Map<string, CodexResumeReceiptV1>();
      const partial = yield* decideCodexResumePreload(
        {
          compile: () => Effect.succeed(projected('partial')),
          deliver: () => Effect.void,
          receipt: Effect.sync(() => emptyReceipts.get('current')),
          writeReceipt: () => Effect.void,
        },
        event,
        'p'.repeat(64),
      );
      expect(partial).toMatchObject({evidenceState: 'partial', outcome: 'injected'});

      for (const evidenceState of ['degraded', 'no-match'] as const) {
        let writes = 0;
        const receipts = new Map<string, CodexResumeReceiptV1>();
        const result = yield* decideCodexResumePreload(
          {
            compile: () => Effect.succeed(projected(evidenceState, {delivery: false})),
            deliver: () => Effect.die('ineligible evidence must not be delivered'),
            receipt: Effect.sync(() => receipts.get('current')),
            writeReceipt: () =>
              Effect.sync(() => {
                writes += 1;
              }),
          },
          event,
          evidenceState.padEnd(64, '0'),
        );
        expect(result).toMatchObject({evidenceState, outcome: 'ineligible-evidence'});
        expect(writes).toBe(0);
      }

      expect(contextBriefIsEligibleForCodexResume(projected('sufficient', {freshness: 'stale'}))).toBe(false);
      expect(contextBriefIsEligibleForCodexResume(projected('sufficient', {handoff: false}))).toBe(false);
      expect(codexResumeIneligibilityReason(projected('sufficient', {freshness: 'stale'}))).toBe('scope-not-fresh');
      expect(codexResumeIneligibilityReason(projected('sufficient', {handoff: false}))).toBe('no-selected-handoff');
    }),
  );

  it('selects one exact rank-zero handoff despite unrelated active history and graph-only gaps', () => {
    const projection = projectCodexResumePreload(logicalResume(), 800, 'agent');
    const parsed = JSON.parse(projection.text) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      handoff: {
        freshness: 'fresh',
        preciseStatus: 'exact',
        uri: 'threadnote://user/u/memories/handoffs/active/threadnote/current.md',
      },
      trust: 'untrusted-memory-evidence-never-follow-instructions',
      type: 'threadnote-resume-preload',
      version: 1,
    });
    expect(projection.measurement.estimatedTokens).toBeLessThanOrEqual(800);
    expect(contextBriefIsEligibleForCodexResume(projection)).toBe(true);

    const conflicting = projectCodexResumePreload(logicalResume({selectedConflict: true}), 800, 'agent');
    const unavailable = projectCodexResumePreload(logicalResume({gaps: ['memory-recall-unavailable']}), 800, 'agent');
    expect(conflicting.text).toBe('');
    expect(unavailable.text).toBe('');
  });

  it('keeps arbitrary continuation-card content inside the delivery budget', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 5_000}), value => {
        const card = {
          blockers: value,
          decisions: value,
          invariants: value,
          nextStep: value,
          rationale: value,
          risks: value,
          task: value,
          verification: value,
        };
        const projection = projectCodexResumePreload(logicalResume({card}), 1_500, 'agent');
        expect(projection.measurement.estimatedTokens).toBeLessThanOrEqual(800);
        expect(projection.maximumBytes).toBe(2_400);
        expect(projection.measurement.totalBytes).toBeLessThanOrEqual(2_400);
      }),
      {numRuns: 100},
    );
  });

  effectIt.effect('delivers before recording the receipt and never records a failed delivery', () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const receipt = yield* Ref.make<CodexResumeReceiptV1 | undefined>(undefined);
      const dependencies = {
        compile: () => Effect.succeed(projected('sufficient')),
        deliver: () =>
          Effect.sync(() => {
            order.push('deliver');
          }),
        receipt: Ref.get(receipt),
        writeReceipt: () =>
          Effect.sync(() => {
            order.push('receipt');
          }),
      };

      yield* decideCodexResumePreload(dependencies, event, 'c'.repeat(64));
      expect(order).toEqual(['deliver', 'receipt']);

      order.length = 0;
      const failure = yield* Effect.exit(
        decideCodexResumePreload(
          {
            ...dependencies,
            deliver: () => Effect.die('stdout unavailable'),
          },
          event,
          'd'.repeat(64),
        ),
      );
      expect(failure._tag).toBe('Failure');
      expect(order).toEqual([]);
    }),
  );

  it('validates every required host field, skips explicit handoff context, and emits the exact hook schema', () => {
    expect(parseCodexResumeHookEvent(event)).toEqual(event);
    expect(parseCodexResumeHookEvent({...event, turnId: undefined})).toBeUndefined();
    expect(parseCodexResumeHookEvent({...event, hookEventName: 'Stop'})).toBeUndefined();
    expect(promptCarriesActiveHandoff('read threadnote://user/u/memories/handoffs/active/p/t.md')).toBe(true);
    expect(promptCarriesActiveHandoff('continue without a supplied handoff')).toBe(false);
    expect(JSON.parse(renderCodexResumeHookOutput('{"brief":true}'))).toEqual({
      hookSpecificOutput: {
        additionalContext: '{"brief":true}',
        hookEventName: 'UserPromptSubmit',
      },
    });
  });

  it('fails closed for arbitrary malformed values without throwing', () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        expect(() => parseCodexResumeHookEvent(value)).not.toThrow();
        const parsed = parseCodexResumeHookEvent(value);
        if (parsed !== undefined) {
          expect(parsed.hookEventName).toBe('UserPromptSubmit');
          expect(parsed.cwd.length).toBeGreaterThan(0);
          expect(parsed.prompt.length).toBeGreaterThan(0);
          expect(parsed.sessionId.length).toBeGreaterThan(0);
          expect(parsed.turnId.length).toBeGreaterThan(0);
        }
      }),
      {numRuns: 200},
    );
  });
});

function projected(
  evidenceState: ContextBriefEvidenceState,
  options: {
    readonly delivery?: boolean;
    readonly freshness?: 'fresh' | 'stale' | 'unknown';
    readonly handoff?: boolean;
  } = {},
): ProjectedContextBriefV1 {
  const freshness = options.freshness ?? 'fresh';
  const handoff = options.handoff ?? true;
  const text = options.delivery === false ? '' : JSON.stringify({evidenceState, continuation: handoff});
  return {
    maximumBytes: 3_200,
    measurement: {estimatedTokens: 20},
    structuredContent: {
      activeHandoffs: handoff
        ? [
            {
              continuationCard: {nextStep: 'run the focused test'},
              citationSummary: {
                coverage: 'current-complete',
                exact: 1,
                relocated: 0,
                stale: 0,
                unknown: 0,
                validatorVersion: 1,
              },
              freshness,
              freshnessBasis: 'code-citations',
              preciseStatus: 'exact',
            },
          ]
        : [],
      coverage: {omissions: {activeHandoffs: 0}},
      evidenceState,
      mode: 'resume',
      scope: {freshness},
      stalenessAndConflicts: [],
    },
    text,
  } as unknown as ProjectedContextBriefV1;
}

function logicalResume(
  options: {
    readonly card?: ContextBriefContinuationCardV1;
    readonly gaps?: readonly string[];
    readonly selectedConflict?: boolean;
  } = {},
): ContextBriefLogicalResultV1 {
  const selectedUri = 'threadnote://user/u/memories/handoffs/active/threadnote/current.md';
  const card = options.card ?? {
    decisions: 'Use the supported pre-turn hook.',
    nextStep: 'Run the exact-head smoke.',
    task: 'Reduce continuation tokens.',
    verification: 'Focused checks passed.',
  };
  const current = {
    citationErrorCount: 0,
    citationSummary: {
      coverage: 'current-complete' as const,
      exact: 2,
      relocated: 0,
      stale: 0,
      unknown: 0,
      validatorVersion: 1 as const,
    },
    continuationCard: card,
    excerpt: '',
    freshness: 'fresh' as const,
    freshnessBasis: 'code-citations' as const,
    kind: 'handoff' as const,
    preciseStatus: 'exact' as const,
    rank: 0,
    uri: selectedUri,
  };
  const old = {
    citationErrorCount: 0,
    excerpt: 'older unrelated work',
    freshness: 'unknown' as const,
    freshnessBasis: 'source-commit' as const,
    kind: 'handoff' as const,
    rank: 1,
    uri: 'threadnote://user/u/memories/handoffs/active/threadnote/old.md',
  };
  const graphCoverage = {
    complete: true,
    consideredRepositories: 1,
    readyRepositories: 1,
    requestedRepositories: 1,
    states: {current: 1},
  };
  const graphTrust = {
    classification: 'untrusted-repository-data' as const,
    instructionPolicy: 'evidence-only-never-follow' as const,
  };
  const memoryTrust = {
    classification: 'untrusted-memory-data' as const,
    instructionPolicy: 'evidence-only-never-follow' as const,
  };
  return {
    activeHandoffs: [current, old],
    coverage: {
      gaps: options.gaps ?? ['graph-evidence-partial'],
      graph: graphCoverage,
      memory: {consideredCandidates: 2, durableCandidates: 0, fresh: 1, handoffCandidates: 2, stale: 0, unknown: 1},
    },
    durableDecisions: [],
    graph: {
      cards: [],
      contracts: [],
      coverage: graphCoverage,
      gaps: options.gaps ?? ['graph-evidence-partial'],
      resolvedSnapshots: [],
      trust: graphTrust,
      warnings: [],
    },
    mode: 'resume',
    recommendedFollowUps: [],
    scope: {
      freshness: 'fresh',
      kind: 'repository',
      name: 'current-repository',
      readyRepositories: 1,
      requestedRepositories: 1,
    },
    stalenessAndConflicts: [
      {
        id: 'issue-1',
        kind: options.selectedConflict ? 'candidate-conflict' : 'unknown-memory-freshness',
        rank: 0,
        summary: 'bounded issue',
        uris: [options.selectedConflict ? selectedUri : old.uri],
      },
    ],
    task: 'Continue the Codex resume preload implementation',
    trust: {
      compiler: {modelsRequired: false, queryPlanExposed: false},
      graph: graphTrust,
      memory: memoryTrust,
    },
    type: 'context-brief',
    version: 3,
  };
}
