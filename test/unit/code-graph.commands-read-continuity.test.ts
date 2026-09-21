import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import {resolveCodeGraphCliReadContinuity} from '../../src/code_graph/commands/read_continuity.js';
import {attachCodeGraphStatusObservation} from '../../src/code_graph/query/contract.js';
import {CodeGraphQueryService} from '../../src/code_graph/query.js';
import type {CodeGraphStatus} from '../../src/code_graph/types.js';
import {CodeGraphWatcher} from '../../src/code_graph/watcher.js';
import type {RuntimeConfig} from '../../src/types.js';

describe('code graph CLI shared-read continuity', () => {
  effectIt.effect('serves a borrowed scoped query and registers its current refresh in the background', () =>
    Effect.gen(function* () {
      const requests: unknown[] = [];
      const initial = attachCodeGraphStatusObservation(scopedStatus(false), statusObservation());
      const borrowed = attachCodeGraphStatusObservation(scopedStatus(true), {
        ...statusObservation(),
        borrowedSnapshotId: 'scope-snapshot',
      });
      const service = CodeGraphQueryService.of({
        attachSharedReadySnapshot: () => Effect.succeed(borrowed),
        inspect: () => Effect.die('Unexpected graph inspection.'),
        purge: () => Effect.die('Unexpected graph purge.'),
        status: () => Effect.die('Unexpected graph status.'),
        statusForIdentity: () => Effect.die('Unexpected identity status.'),
        statusForPublishedIdentity: () => Effect.die('Unexpected published identity status.'),
      });
      const watcher = CodeGraphWatcher.of({
        ensure: () => Effect.void,
        metrics: Effect.succeed({
          activeRefreshKeys: 0,
          activeWatches: 0,
          executingRefreshes: 0,
          executingRefreshHighWater: 0,
          idleSweepFibers: 0,
          maximumWatchers: 32,
          pendingTrailingRefreshes: 0,
          retainedStatuses: 0,
        }),
        refresh: () => Effect.succeed(false),
        request: options =>
          Effect.sync(() => {
            requests.push(options);
            return {
              refresh: {state: 'active' as const, type: 'code-graph-refresh-continuity' as const, version: 1 as const},
              requestState: 'started' as const,
            };
          }),
        status: () => Effect.succeedNone,
        watch: () => Effect.void,
      });

      const result = yield* resolveCodeGraphCliReadContinuity(CONFIG, service, initial, 'query', 'current').pipe(
        Effect.provideService(CodeGraphWatcher, watcher),
      );

      expect(result.borrowedContinuity).toBe(true);
      expect(result.backgroundRefreshRegistered).toBe(true);
      expect(result.readPlan).toEqual({refresh: false, strictFreshness: false, unavailable: false});
      expect(result.status.readySnapshot?.id).toBe('scope-snapshot');
      expect(requests).toEqual([
        expect.objectContaining({
          cwd: '/workspace/fresh',
          key: 'fresh-worktree',
          project: expect.objectContaining({name: 'docs'}),
        }),
      ]);
    }),
  );

  effectIt.effect('reports when a borrowed current read cannot register its background refresh', () =>
    Effect.gen(function* () {
      const initial = attachCodeGraphStatusObservation(scopedStatus(false), statusObservation());
      const borrowed = attachCodeGraphStatusObservation(scopedStatus(true), {
        ...statusObservation(),
        borrowedSnapshotId: 'scope-snapshot',
      });
      const service = CodeGraphQueryService.of({
        attachSharedReadySnapshot: () => Effect.succeed(borrowed),
        inspect: () => Effect.die('Unexpected graph inspection.'),
        purge: () => Effect.die('Unexpected graph purge.'),
        status: () => Effect.die('Unexpected graph status.'),
        statusForIdentity: () => Effect.die('Unexpected identity status.'),
        statusForPublishedIdentity: () => Effect.die('Unexpected published identity status.'),
      });
      const watcher = CodeGraphWatcher.of({
        ensure: () => Effect.void,
        metrics: Effect.succeed({
          activeRefreshKeys: 0,
          activeWatches: 0,
          executingRefreshes: 0,
          executingRefreshHighWater: 0,
          idleSweepFibers: 0,
          maximumWatchers: 32,
          pendingTrailingRefreshes: 0,
          retainedStatuses: 0,
        }),
        refresh: () => Effect.succeed(false),
        request: () => Effect.fail('refresh registration failed'),
        status: () => Effect.succeedNone,
        watch: () => Effect.void,
      });

      const result = yield* resolveCodeGraphCliReadContinuity(CONFIG, service, initial, 'query', 'current').pipe(
        Effect.provideService(CodeGraphWatcher, watcher),
      );

      expect(result.borrowedContinuity).toBe(true);
      expect(result.backgroundRefreshRegistered).toBe(false);
      expect(result.readPlan).toEqual({refresh: false, strictFreshness: false, unavailable: false});
      expect(result.status.readySnapshot?.id).toBe('scope-snapshot');
    }),
  );
});

function scopedStatus(ready: boolean): CodeGraphStatus {
  const status: CodeGraphStatus = {
    databasePath: '/threadnote/code-graph.sqlite',
    freshness: 'stale',
    identity: {
      caseMode: 'sensitive',
      checkoutId: 'checkout',
      displayName: 'fixture',
      gitCommonDirectory: '/workspace/repository/.git',
      headCommit: 'b'.repeat(40),
      objectFormat: 'sha1',
      repoRoot: '/workspace/fresh',
      repositoryId: 'a'.repeat(64),
      worktreeId: 'fresh-worktree',
    },
    languagePacks: [],
    projectCoverage: {
      completeness: 'complete',
      configuredRoots: ['apps/docs'],
      dependencyComponents: 0,
      kind: 'project',
      negativeProof: 'selected-graph-only',
      observedWorktreeCommit: 'b'.repeat(40),
      project: 'docs',
      reusedEquivalentSnapshot: false,
      rootComponents: 1,
    },
    ...(ready
      ? {
          readySnapshot: {
            commit: 'a'.repeat(40),
            dirty: false,
            edgeCount: 1,
            extractorSet: 'extractor',
            fileCount: 1,
            id: 'scope-snapshot',
            repositoryId: 'a'.repeat(64),
            scopeId: `code-graph-scope:${'c'.repeat(64)}`,
            state: 'ready' as const,
            symbolCount: 1,
            worktreeId: 'source-worktree',
          },
        }
      : {}),
    stale: true,
  };
  return status;
}

function statusObservation() {
  return {
    identity: scopedStatusIdentity(),
    manifestPath: '/threadnote/manifest.yaml',
    projectScope: {
      project: {
        graph: {closure: 'dependencies' as const, roots: ['apps/docs']},
        name: 'docs',
        uri: 'threadnote://resources/repos/docs',
      },
      scope: {
        admittedPrefixes: ['apps/docs'],
        closureDigest: 'd'.repeat(64),
        completeness: 'complete' as const,
        controlPaths: ['package.json'],
        definitionDigest: 'e'.repeat(64),
        diagnostics: [],
        includedProjectIds: ['@fixture/docs'],
        rootProjectIds: ['@fixture/docs'],
        scopeKey: `code-graph-scope:${'c'.repeat(64)}`,
      },
    },
  };
}

function scopedStatusIdentity() {
  return {
    caseMode: 'sensitive' as const,
    checkoutId: 'checkout',
    displayName: 'fixture',
    gitCommonDirectory: '/workspace/repository/.git',
    headCommit: 'b'.repeat(40),
    objectFormat: 'sha1' as const,
    repoRoot: '/workspace/fresh',
    repositoryId: 'a'.repeat(64),
    worktreeId: 'fresh-worktree',
  };
}

const CONFIG: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/threadnote',
  agentId: 'test-agent',
  manifestPath: '/threadnote/manifest.yaml',
  user: 'tester',
};
