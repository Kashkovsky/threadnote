import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import type {MemoryRecord} from '../../src/memory/document.js';
import {
  classifyDeferredCodeAnchorEligibility,
  deferredCodeAnchorIntentMatchesFinalizationRoute,
  deferredCodeAnchorFinalizationVerified,
  type DeferredCodeAnchorFinalizationRoute,
  type DeferredCodeAnchorIntentV1,
  type DeferredMemoryObservation,
} from '../../src/memory/deferred_code_anchor.js';
import {selectDeferredCodeAnchorWorkspaceRefreshTargets} from '../../src/memory/deferred_code_anchor_refresh.js';

const URI = 'threadnote://user/test/memories/durable/projects/threadnote/deferred.md';

describe('deferred code-anchor state model', () => {
  effectIt.effect.prop(
    'finalization is eligible only for the unchanged active personal uncited memory revision',
    {
      citationCount: fc.integer({min: 0, max: 4}),
      contentMatches: fc.boolean(),
      memoryIdMatches: fc.boolean(),
      present: fc.boolean(),
      status: fc.constantFrom('active' as const, 'archived' as const, 'expired' as const, 'superseded' as const),
      visibility: fc.constantFrom('personal' as const, 'shared' as const, 'external' as const),
    },
    input =>
      Effect.sync(() => {
        const intent = deferredIntent();
        const observation = input.present
          ? deferredObservation({
              citationCount: input.citationCount,
              hash: input.contentMatches ? intent.expectedMemoryHash : 'changed-hash',
              memoryId: input.memoryIdMatches ? intent.memoryId : 'tn_other',
              status: input.status,
              visibility: input.visibility,
            })
          : undefined;
        const result = classifyDeferredCodeAnchorEligibility(intent, observation);
        const expectedEligible =
          input.present &&
          input.contentMatches &&
          input.memoryIdMatches &&
          input.status === 'active' &&
          input.visibility === 'personal' &&
          input.citationCount === 0;
        expect(result.state === 'eligible').toBe(expectedEligible);
      }),
  );

  effectIt.effect('classifies every conflict before citation capture can run', () =>
    Effect.sync(() => {
      const intent = deferredIntent();
      expect(classifyDeferredCodeAnchorEligibility(intent, undefined)).toEqual({
        reason: 'canonical-memory-missing',
        state: 'conflict',
      });
      expect(
        classifyDeferredCodeAnchorEligibility(
          intent,
          deferredObservation({citationCount: 0, hash: intent.expectedMemoryHash, memoryId: intent.memoryId}),
        ),
      ).toEqual({state: 'eligible'});
    }),
  );

  effectIt.effect('requires the complete finalized canonical document to match the intended write', () =>
    Effect.sync(() => {
      const expected = 'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\n\nDecision body.\n';
      expect(deferredCodeAnchorFinalizationVerified(expected, expected)).toBe(true);
      expect(
        deferredCodeAnchorFinalizationVerified(
          expected,
          'MEMORY\nkind: durable\nstatus: active\nproject: other\n\nDecision body.\n',
        ),
      ).toBe(false);
      expect(
        deferredCodeAnchorFinalizationVerified(
          expected,
          'MEMORY\nkind: durable\nstatus: active\nproject: threadnote\n\nChanged body.\n',
        ),
      ).toBe(false);
    }),
  );

  effectIt.effect.prop(
    'repository routes admit the exact repository/worktree identity regardless of preparation hint',
    {
      callerPreparation: fc.boolean(),
      repositoryMatches: fc.boolean(),
      worktreeMatches: fc.boolean(),
    },
    input =>
      Effect.sync(() => {
        const intent = deferredIntent({preparation: input.callerPreparation ? 'caller' : 'workset'});
        const route: DeferredCodeAnchorFinalizationRoute = {
          callerCwd: '/other-checkout-spelling-is-not-authority',
          kind: 'repository',
          repositoryId: input.repositoryMatches ? intent.repositoryId : '3'.repeat(64),
          worktreeId: input.worktreeMatches ? intent.worktreeId : '4'.repeat(64),
        };
        expect(deferredCodeAnchorIntentMatchesFinalizationRoute(intent, route)).toBe(
          input.repositoryMatches && input.worktreeMatches,
        );
      }),
  );

  effectIt.effect.prop(
    'workset routes admit the exact prepared workset or a qualified cross-repository reference',
    {
      hasQualifiedRef: fc.boolean(),
      nameMatches: fc.boolean(),
      worksetPreparation: fc.boolean(),
    },
    input =>
      Effect.sync(() => {
        const intent = deferredIntent({
          codeRefs: input.hasQualifiedRef ? [`cgr_${'a'.repeat(40)}`] : ['src/index.ts'],
          preparation: input.worksetPreparation ? 'workset' : 'caller',
        });
        const route: DeferredCodeAnchorFinalizationRoute = {
          kind: 'workset',
          name: input.nameMatches ? 'platform' : 'other',
        };
        expect(deferredCodeAnchorIntentMatchesFinalizationRoute(intent, route)).toBe(
          input.hasQualifiedRef || (input.worksetPreparation && input.nameMatches),
        );
      }),
  );

  effectIt.effect.prop(
    'refresh targets stay on still-present matching worktrees and never rebind a sibling checkout',
    {
      duplicateWorktree: fc.boolean(),
      intents: fc.uniqueArray(
        fc.record({
          cwdIndex: fc.integer({min: 0, max: 2}),
          identity: fc.constantFrom('match', 'missing', 'mismatch'),
          workset: fc.boolean(),
        }),
        {maxLength: 3, selector: item => item.cwdIndex},
      ),
      siblingPresent: fc.boolean(),
    },
    input =>
      Effect.sync(() => {
        const cwds = ['/repo-a', '/repo-b', '/repo-missing'] as const;
        const intents = input.intents.map((item, index) =>
          deferredIntent({
            callerCwd: cwds[item.cwdIndex],
            memoryUri: `${URI}-${index}`,
            preparation: item.workset ? 'workset' : 'caller',
            repositoryId: '1'.repeat(64),
            worktreeId: `${item.cwdIndex + 2}`.repeat(64),
          }),
        );
        const match = intents.find((_, index) => {
          const item = input.intents[index];
          return item !== undefined && !item.workset && item.identity === 'match';
        });
        if (input.duplicateWorktree && match !== undefined) {
          intents.push(
            deferredIntent({
              callerCwd: match.callerCwd,
              memoryUri: `${URI}-duplicate`,
              repositoryId: match.repositoryId,
              worktreeId: match.worktreeId,
            }),
          );
        }
        const identityByCwd = new Map<string, {repositoryId: string; worktreeId: string} | undefined>();
        for (const [index, item] of input.intents.entries()) {
          const intent = intents[index];
          if (intent === undefined) continue;
          if (item.identity === 'missing') {
            identityByCwd.set(intent.callerCwd, undefined);
            continue;
          }
          identityByCwd.set(
            intent.callerCwd,
            item.identity === 'mismatch'
              ? {repositoryId: intent.repositoryId, worktreeId: '9'.repeat(64)}
              : {repositoryId: intent.repositoryId, worktreeId: intent.worktreeId},
          );
        }
        if (input.siblingPresent) {
          identityByCwd.set('/repo-sibling', {repositoryId: '1'.repeat(64), worktreeId: '5'.repeat(64)});
        }
        const targets = selectDeferredCodeAnchorWorkspaceRefreshTargets(intents, identityByCwd);
        const expectedCwds = new Set(
          intents
            .filter((intent, index) => {
              const item = input.intents[index];
              return item !== undefined && !item.workset && item.identity === 'match';
            })
            .map(intent => intent.callerCwd),
        );
        expect(new Set(targets.map(target => target.cwd))).toEqual(expectedCwds);
        expect(new Set(targets.map(target => target.worktreeId)).size).toBe(targets.length);
        expect(targets.some(target => target.cwd === '/repo-sibling')).toBe(false);
        expect(targets.some(target => target.cwd === '/repo-missing' && !expectedCwds.has('/repo-missing'))).toBe(
          false,
        );
        for (const target of targets) {
          const intent = intents.find(candidate => candidate.callerCwd === target.cwd);
          expect(intent).toBeDefined();
          expect(intent?.recovery.preparation.target).toBe('callerCwd');
          expect(target.repositoryId).toBe(intent?.repositoryId);
          expect(target.worktreeId).toBe(intent?.worktreeId);
        }
      }),
  );
});

function deferredIntent(
  options: {
    readonly callerCwd?: string;
    readonly codeRefs?: readonly string[];
    readonly memoryUri?: string;
    readonly preparation?: 'caller' | 'workset';
    readonly repositoryId?: string;
    readonly worktreeId?: string;
  } = {},
): DeferredCodeAnchorIntentV1 {
  const preparation =
    options.preparation === 'workset'
      ? {
          action: 'prepare-workset' as const,
          arguments: ['platform'] as const,
          command: 'threadnote workset prepare' as const,
          target: 'workset' as const,
        }
      : {
          action: 'index-current-graph' as const,
          arguments: [] as const,
          command: 'threadnote graph index --no-vectors' as const,
          target: 'callerCwd' as const,
        };
  return {
    authorization: 'explicit-code-refs',
    callerCwd: options.callerCwd ?? '/repo',
    codeRefs: options.codeRefs ?? ['src/index.ts'],
    createdAt: '2026-08-29T00:00:00.000Z',
    expectedMemoryHash: 'expected-hash',
    intentId: 'tnca_test',
    memoryId: 'tn_memory',
    memoryUri: options.memoryUri ?? URI,
    recovery: {
      code: 'exact-current-evidence-unavailable',
      indexingStarted: false,
      observedGraph: {freshness: 'stale', readySnapshot: 'available', stale: true},
      preparation,
      recovery: 'prepare-current-graph',
      retryCondition: 'after-current-graph-ready',
      retryable: true,
      type: 'memory-code-citation-capture-recovery',
      version: 1,
    },
    repositoryId: options.repositoryId ?? '1'.repeat(64),
    type: 'threadnote-deferred-code-anchor-intent',
    version: 1,
    visibility: 'private-local',
    worktreeId: options.worktreeId ?? '2'.repeat(64),
  };
}

function deferredObservation(
  input: {
    readonly citationCount?: number;
    readonly hash?: string;
    readonly memoryId?: string;
    readonly status?: MemoryRecord['metadata']['status'];
    readonly visibility?: MemoryRecord['metadata']['visibility'];
  } = {},
): DeferredMemoryObservation {
  const citations = Array.from({length: input.citationCount ?? 0}, (_, index) => ({id: `citation-${index}`}));
  const record = {
    body: 'Decision body.',
    content: 'MEMORY\n\nDecision body.',
    headerTitle: 'MEMORY',
    metadata: {
      codeCitations: citations,
      kind: 'durable',
      memoryId: input.memoryId ?? 'tn_memory',
      sourceAgentClient: 'test',
      status: input.status ?? 'active',
      timestamp: '2026-08-29T00:00:00.000Z',
      visibility: input.visibility ?? 'personal',
    },
    uri: URI,
  } as unknown as MemoryRecord;
  return {content: record.content, hash: input.hash ?? 'expected-hash', record};
}
