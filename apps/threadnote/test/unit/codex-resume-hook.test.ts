import {it as effectIt} from '@effect/vitest';
import {Effect, Ref} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  contextBriefIsEligibleForCodexResume,
  decideCodexResumePreload,
  parseCodexResumeHookEvent,
  promptCarriesActiveHandoff,
  renderCodexResumeHookOutput,
  type CodexResumeHookEvent,
  type CodexResumeReceiptV1,
} from '@threadnote/threadnote/codex/resume_hook';
import type {ContextBriefEvidenceState, ProjectedContextBriefV1} from '@threadnote/context/types';

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

  effectIt.effect('never writes or injects partial, degraded, stale, or handoff-free evidence', () =>
    Effect.gen(function* () {
      for (const evidenceState of ['partial', 'degraded', 'no-match'] as const) {
        let writes = 0;
        const receipts = new Map<string, CodexResumeReceiptV1>();
        const result = yield* decideCodexResumePreload(
          {
            compile: () => Effect.succeed(projected(evidenceState)),
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
    }),
  );

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
  options: {readonly freshness?: 'fresh' | 'stale' | 'unknown'; readonly handoff?: boolean} = {},
): ProjectedContextBriefV1 {
  const freshness = options.freshness ?? 'fresh';
  const handoff = options.handoff ?? true;
  const text = JSON.stringify({evidenceState, continuation: handoff});
  return {
    maximumBytes: 3_200,
    measurement: {estimatedTokens: 20},
    structuredContent: {
      activeHandoffs: handoff
        ? [
            {
              continuationCard: {nextStep: 'run the focused test'},
              freshness,
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
