import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {WorktreeChangedDuringIndex} from '../../src/code_graph/indexer_shared.js';
import {recoverIsolatedCodeGraphIndexSnapshot} from '../../src/code_graph/isolated_index.js';
import {
  CodeGraphSnapshotUnavailable,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from '../../src/code_graph/types.js';

const identity: RepositoryIdentity = {
  caseMode: 'sensitive',
  checkoutId: 'a'.repeat(64),
  displayName: 'fixture/repository',
  gitCommonDirectory: '/fixture/repository/.git',
  headCommit: 'b'.repeat(40),
  objectFormat: 'sha1',
  repoRoot: '/fixture/repository',
  repositoryId: 'c'.repeat(64),
  worktreeId: 'd'.repeat(64),
};

const snapshot: CodeGraphSnapshot = {
  commit: identity.headCommit,
  dirty: false,
  edgeCount: 41,
  extractorSet: 'fixture-extractors',
  fileCount: 3,
  id: `cgsn_${'e'.repeat(40)}`,
  repositoryId: identity.repositoryId,
  state: 'ready',
  symbolCount: 29,
  worktreeId: identity.worktreeId,
};

const result = {
  dirty: snapshot.dirty,
  edges: snapshot.edgeCount,
  files: snapshot.fileCount,
  requestKey: 'request-key',
  snapshotId: snapshot.id,
  symbols: snapshot.symbolCount,
} as const;

describe('isolated index snapshot recovery', () => {
  effectIt.effect('recovers the exact authoritative ready snapshot named by the child receipt', () =>
    Effect.gen(function* () {
      const loadedIds: string[] = [];
      const recovered = yield* recoverIsolatedCodeGraphIndexSnapshot({
        completedIdentity: identity,
        currentRequestKey: result.requestKey,
        loadReadySnapshot: snapshotId =>
          Effect.sync(() => {
            loadedIds.push(snapshotId);
            return snapshot;
          }),
        requestedIdentity: identity,
        requestedRequestKey: result.requestKey,
        result,
      });

      expect(loadedIds).toEqual([snapshot.id]);
      expect(recovered).toEqual({identity, snapshot});
    }),
  );

  effectIt.effect('fails closed when the child receipt has no authoritative ready snapshot', () =>
    Effect.gen(function* () {
      const failure = yield* recoverIsolatedCodeGraphIndexSnapshot({
        completedIdentity: identity,
        currentRequestKey: result.requestKey,
        loadReadySnapshot: () => Effect.succeed(undefined),
        requestedIdentity: identity,
        requestedRequestKey: result.requestKey,
        result,
      }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(CodeGraphSnapshotUnavailable);
    }),
  );

  effectIt.effect.prop(
    'rejects every post-child target, commit, or request-key drift before loading a publishable snapshot (property)',
    {drift: fc.constantFrom('checkout', 'repository', 'worktree', 'head', 'receipt-request', 'current-request')},
    ({drift}) =>
      Effect.gen(function* () {
        let snapshotLoads = 0;
        const completedIdentity = {
          ...identity,
          ...(drift === 'checkout' ? {checkoutId: 'f'.repeat(64)} : {}),
          ...(drift === 'repository' ? {repositoryId: 'f'.repeat(64)} : {}),
          ...(drift === 'worktree' ? {worktreeId: 'f'.repeat(64)} : {}),
          ...(drift === 'head' ? {headCommit: 'f'.repeat(40)} : {}),
        };
        const failure = yield* recoverIsolatedCodeGraphIndexSnapshot({
          completedIdentity,
          currentRequestKey: drift === 'current-request' ? 'changed-current-request' : result.requestKey,
          loadReadySnapshot: () =>
            Effect.sync(() => {
              snapshotLoads += 1;
              return snapshot;
            }),
          requestedIdentity: identity,
          requestedRequestKey: result.requestKey,
          result: drift === 'receipt-request' ? {...result, requestKey: 'changed-receipt-request'} : result,
        }).pipe(Effect.flip);

        expect(failure).toBeInstanceOf(WorktreeChangedDuringIndex);
        expect(snapshotLoads).toBe(0);
      }),
    {fastCheck: {numRuns: 36}},
  );
});
