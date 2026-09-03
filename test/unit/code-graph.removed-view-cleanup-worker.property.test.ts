import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {
  makeCodeGraphRemovedViewCleanupWorker,
  type CodeGraphRemovedViewCleanupPageResult,
  type CodeGraphRemovedViewCleanupWorkerDependencies,
} from '../../src/code_graph/removed_view_cleanup.js';
import {
  CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES,
  type CodeGraphRemovedViewCleanupBlockedCode,
  type CodeGraphRemovedViewCleanupEntry,
  type CodeGraphRemovedViewCleanupPhase,
  type CodeGraphRemovedViewCleanupUpdate,
} from '../../src/code_graph/store.js';

const INPUT = {
  checkoutId: 'a'.repeat(64),
  databasePath: '/private/graph-v3.sqlite',
  threadnoteHome: '/private/threadnote',
};
const SNAPSHOT_ID = `cgsn_${'1'.repeat(40)}`;

const phaseArbitrary = fc.constantFrom<Exclude<CodeGraphRemovedViewCleanupPhase, 'complete'>>(
  'vector-pointers',
  'build-status',
  'provenance',
);
const actionArbitrary = fc.constantFrom<'complete' | 'deferred' | 'progress'>('progress', 'deferred', 'complete');
const blockedCodeArbitrary = fc.constantFrom<CodeGraphRemovedViewCleanupBlockedCode>(
  'busy',
  'evidence-unavailable',
  'invalid-sidecar',
  'io-error',
  'permission-denied',
  'schema-incompatible',
);

describe('removed view cleanup worker properties', () => {
  effectIt.effect.prop(
    'maps one authorized page into the independent monotone phase model',
    {
      action: actionArbitrary,
      attempts: fc.integer({max: 12, min: 0}),
      blockedCode: blockedCodeArbitrary,
      delay: fc.integer({max: 60_000, min: 1}),
      now: fc.integer({max: 1_000_000, min: 0}),
      phase: phaseArbitrary,
      revision: fc.integer({max: 10_000, min: 1}),
      rollback: fc.integer({max: 10_000, min: 0}),
    },
    ({action, attempts, blockedCode, delay, now, phase, revision, rollback}) =>
      Effect.gen(function* () {
        const entry = cleanupEntry({
          attempts,
          nextAttemptAt: now + 30_000,
          phase,
          revision,
          updatedAt: new Date(now + rollback).toISOString(),
        });
        const effectiveAction = phase === 'provenance' && action === 'progress' ? 'deferred' : action;
        const page = pageResult(phase, effectiveAction, blockedCode, delay, revision);
        const observed: CodeGraphRemovedViewCleanupUpdate[] = [];
        const worker = yield* makeCodeGraphRemovedViewCleanupWorker(
          dependencies(entry, page, now, update => observed.push(update)),
        );

        yield* worker.tick(INPUT);

        expect(observed).toEqual([modeledUpdate(entry, page, now)]);
        const update = observed[0];
        const beforeIndex = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.indexOf(entry.phase);
        const afterIndex = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.indexOf(update.phase);
        expect(afterIndex === beforeIndex || afterIndex === beforeIndex + 1).toBe(true);
        expect(Date.parse(update.updatedAt)).toBeGreaterThanOrEqual(Date.parse(entry.updatedAt));
      }),
    {fastCheck: {numRuns: 100}},
  );

  effectIt.effect.prop(
    'never invokes a phase or update after stale authorization',
    {phase: phaseArbitrary, revision: fc.integer({max: 10_000, min: 1})},
    ({phase, revision}) =>
      Effect.gen(function* () {
        let phaseCalls = 0;
        let updates = 0;
        const entry = cleanupEntry({phase, revision});
        const worker = yield* makeCodeGraphRemovedViewCleanupWorker({
          ...dependencies(entry, {state: 'complete'}, 0, () => {
            updates += 1;
          }),
          authorize: () => Effect.succeed({state: 'stale'}),
          cleanupBuildStatusUnit: () =>
            Effect.sync(() => {
              phaseCalls += 1;
              return {state: 'complete'} as const;
            }),
          cleanupProvenanceUnit: () =>
            Effect.sync(() => {
              phaseCalls += 1;
              return {state: 'complete'} as const;
            }),
          withPreparedVectorUnit: (_input, _entry, _deadline, use) =>
            use(
              Effect.sync(() => {
                phaseCalls += 1;
                return {state: 'complete'} as const;
              }),
            ),
        });

        yield* worker.tick(INPUT);
        expect({phaseCalls, updates}).toEqual({phaseCalls: 0, updates: 0});
      }),
    {fastCheck: {numRuns: 60}},
  );
});

function cleanupEntry(overrides: Partial<CodeGraphRemovedViewCleanupEntry>): CodeGraphRemovedViewCleanupEntry {
  return {
    attempts: 0,
    epoch: 1,
    expectedSnapshotId: SNAPSHOT_ID,
    nextAttemptAt: 30_000,
    phase: 'vector-pointers',
    provenanceRecordDigest: 'b'.repeat(64),
    provenanceRecordIdentity: 'c'.repeat(64),
    removedAt: new Date(0).toISOString(),
    repositoryId: 'd'.repeat(64),
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    worktreeId: 'e'.repeat(64),
    ...overrides,
  };
}

function pageResult(
  phase: Exclude<CodeGraphRemovedViewCleanupPhase, 'complete'>,
  action: 'complete' | 'deferred' | 'progress',
  blockedCode: CodeGraphRemovedViewCleanupBlockedCode,
  delay: number,
  revision: number,
): CodeGraphRemovedViewCleanupPageResult {
  if (action === 'complete') return {state: 'complete'};
  if (action === 'deferred') return {blockedCode, retryAfterMilliseconds: delay, state: 'deferred'};
  return {
    cursorToken:
      phase === 'vector-pointers' ? `vp1:a:${'f'.repeat(64)}:model-000:${revision}` : buildProgressCursor(revision),
    state: 'progress',
  };
}

function buildProgressCursor(revision: number): string {
  const fields = ['bs1', 's', revision.toString(16).padStart(16, '0'), 'a'.repeat(64)] as const;
  const seal = sha256HexSync(['threadnote-code-graph-build-cleanup-cursor-v1', ...fields].join('\0'));
  return [...fields, seal].join(':');
}

function modeledUpdate(
  entry: CodeGraphRemovedViewCleanupEntry,
  page: CodeGraphRemovedViewCleanupPageResult,
  now: number,
): CodeGraphRemovedViewCleanupUpdate {
  const updatedAt = new Date(Math.max(now, Date.parse(entry.updatedAt))).toISOString();
  if (page.state === 'progress') {
    return {
      attempts: entry.attempts,
      cursorToken: page.cursorToken,
      nextAttemptAt: now + 1,
      phase: entry.phase,
      updatedAt,
    };
  }
  if (page.state === 'deferred') {
    return {
      attempts: entry.attempts + 1,
      blockedCode: page.blockedCode,
      cursorToken: entry.cursorToken,
      nextAttemptAt: Math.max(entry.nextAttemptAt + 1, now + page.retryAfterMilliseconds),
      phase: entry.phase,
      updatedAt,
    };
  }
  const phaseIndex = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.indexOf(entry.phase);
  return {
    attempts: 0,
    nextAttemptAt: now + 1,
    phase: CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES[phaseIndex + 1],
    updatedAt,
  };
}

function dependencies(
  entry: CodeGraphRemovedViewCleanupEntry,
  page: CodeGraphRemovedViewCleanupPageResult,
  now: number,
  observeUpdate: (update: CodeGraphRemovedViewCleanupUpdate) => void,
): CodeGraphRemovedViewCleanupWorkerDependencies {
  return {
    authorize: (_input, candidate) => Effect.succeed({entry: candidate, state: 'authorized'}),
    claim: () => Effect.succeed([entry]),
    cleanupBuildStatusUnit: () => Effect.succeed(page),
    cleanupProvenanceUnit: () => Effect.succeed(page),
    withPreparedVectorUnit: (_input, _entry, _deadline, use) => use(Effect.succeed(page)),
    monotonicMilliseconds: Effect.succeed(now),
    nowMilliseconds: Effect.succeed(now),
    sleep: () => Effect.void,
    update: (_input, candidate, update) =>
      Effect.sync(() => {
        observeUpdate(update);
        return {entry: {...candidate, ...update, revision: candidate.revision + 1}, state: 'updated'} as const;
      }),
    withTargetLock: (_input, _worktreeId, effect) => effect,
  };
}
