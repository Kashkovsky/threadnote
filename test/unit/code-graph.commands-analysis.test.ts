import {it as effectIt} from '@effect/vitest';
import {Effect, Fiber, Layer, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {resolveCodeGraphAnalysisSnapshot} from '../../src/code_graph/analysis_cli.js';
import type {CodeGraphCliFreshnessPolicy} from '../../src/code_graph/cli_freshness.js';
import {
  CodeGraphQueryService,
  type CodeGraphSharedReadyAttachInterlock,
  type CodeGraphStatusOptions,
} from '../../src/code_graph/query.js';
import type {CodeGraphSnapshot, CodeGraphStatus, RepositoryIdentity} from '../../src/code_graph/types.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('code graph CLI analysis freshness', () => {
  effectIt.effect('never borrows repository-level stale evidence for analysis', () => {
    const unavailable = codeGraphStatus({ready: false, stale: true});
    const harness = analysisSnapshotHarness({attachResults: [unavailable], statuses: [unavailable]});

    return Effect.gen(function* () {
      const result = yield* resolve(harness, 'allow-stale');

      expect(result).toMatchObject({
        ready: false,
        state: {
          freshnessPolicy: 'allow-stale',
          operation: 'stats',
          reason: 'no-ready-snapshot',
          state: 'unavailable',
          type: 'code-graph-analysis-state',
          version: 1,
        },
      });
      expect(harness.observation.attachOptions).toEqual([{allowBorrowedStale: false, requestMaintenance: false}]);
      expect(harness.observation.statusOptions).toEqual([{requestMaintenance: false}]);
      expect(harness.observation.refreshes).toBe(0);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('fails current analysis closed when refresh leaves only a stale snapshot', () => {
    const stale = codeGraphStatus({ready: true, stale: true});
    const harness = analysisSnapshotHarness({attachResults: [stale], statuses: [stale, stale]});

    return Effect.gen(function* () {
      const error = yield* Effect.flip(resolve(harness, 'current'));

      expect(String(error)).toContain('current native code graph snapshot is unavailable after indexing');
      expect(harness.observation.attachOptions).toEqual([{allowBorrowedStale: false, requestMaintenance: false}]);
      expect(harness.observation.statusOptions).toEqual([{requestMaintenance: false}, {requestMaintenance: false}]);
      expect(harness.observation.refreshes).toBe(1);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('interrupts a timed-out cold refresh and returns no analysis snapshot', () => {
    const unavailable = codeGraphStatus({ready: false, stale: true});
    const harness = analysisSnapshotHarness({attachResults: [unavailable], statuses: [unavailable]});

    return Effect.gen(function* () {
      const interrupted = yield* Ref.make(false);
      const resolution = yield* resolveCodeGraphAnalysisSnapshot<never, never>(
        runtimeConfig(),
        TEST_REPOSITORY,
        'ready',
        () => Effect.never.pipe(Effect.ensuring(Ref.set(interrupted, true))),
        {operation: 'stats', readTimeoutMilliseconds: 25_000},
      ).pipe(Effect.forkChild({startImmediately: true}));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(25_000);
      const result = yield* Fiber.join(resolution);

      expect(result).toMatchObject({
        ready: false,
        state: {
          budgetMilliseconds: 25_000,
          operation: 'stats',
          reason: 'read-timeout',
          state: 'timed-out',
          type: 'code-graph-analysis-state',
          version: 1,
        },
      });
      expect(yield* Ref.get(interrupted)).toBe(true);
      expect(harness.observation.attachOptions).toEqual([{allowBorrowedStale: false, requestMaintenance: false}]);
      expect(harness.observation.statusOptions).toEqual([{requestMaintenance: false}]);
    }).pipe(provideTestLayer(harness.layer));
  });
});

const TEST_HOME = '/threadnote-analysis-command-home';
const TEST_REPOSITORY = '/workspace/divergent-analysis-worktree';

interface AnalysisSnapshotHarnessInput {
  readonly attachResults: readonly CodeGraphStatus[];
  readonly statuses: readonly CodeGraphStatus[];
}

function analysisSnapshotHarness(input: AnalysisSnapshotHarnessInput) {
  const attachOptions: Array<CodeGraphSharedReadyAttachInterlock | undefined> = [];
  const statusOptions: Array<CodeGraphStatusOptions | undefined> = [];
  let refreshes = 0;
  let attachIndex = 0;
  let statusIndex = 0;
  const query = CodeGraphQueryService.of({
    attachSharedReadySnapshot: (_threadnoteHome, _identity, _status, options) =>
      Effect.suspend(() => {
        attachOptions.push(options);
        const result = input.attachResults[attachIndex];
        attachIndex += 1;
        return result === undefined
          ? Effect.die(new Error(`Unexpected analysis attachment ${attachIndex}.`))
          : Effect.succeed(result);
      }),
    inspect: () => Effect.die(new Error('Analysis snapshot resolution must not inspect the graph.')),
    purge: () => Effect.die(new Error('Analysis snapshot resolution must not purge the graph.')),
    status: (_threadnoteHome, _cwd, options) =>
      Effect.suspend(() => {
        statusOptions.push(options);
        const result = input.statuses[statusIndex];
        statusIndex += 1;
        return result === undefined
          ? Effect.die(new Error(`Unexpected analysis status ${statusIndex}.`))
          : Effect.succeed(result);
      }),
    statusForIdentity: () => Effect.die(new Error('Analysis snapshot resolution must not query another identity.')),
    statusForPublishedIdentity: () =>
      Effect.die(new Error('Analysis snapshot resolution must not query a published identity.')),
  });

  return {
    layer: Layer.succeed(CodeGraphQueryService, query),
    observation: {
      attachOptions,
      statusOptions,
      get refreshes() {
        return refreshes;
      },
    },
    refresh: () =>
      Effect.sync(() => {
        refreshes += 1;
      }),
  };
}

function resolve(harness: ReturnType<typeof analysisSnapshotHarness>, freshness: CodeGraphCliFreshnessPolicy) {
  return resolveCodeGraphAnalysisSnapshot(runtimeConfig(), TEST_REPOSITORY, freshness, harness.refresh, {
    operation: 'stats',
    readTimeoutMilliseconds: 25_000,
  });
}

function codeGraphStatus(options: {readonly ready: boolean; readonly stale: boolean}): CodeGraphStatus {
  const snapshot = analysisSnapshot();
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: 'analysis-checkout',
    displayName: 'Fixture/divergent-analysis',
    gitCommonDirectory: '/workspace/repository/.git',
    headCommit: '2'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: TEST_REPOSITORY,
    repositoryId: snapshot.repositoryId,
    worktreeId: snapshot.worktreeId,
  };
  return {
    databasePath: `${TEST_HOME}/graph.sqlite`,
    freshness: options.stale ? 'stale' : 'current',
    identity,
    languagePacks: [],
    ...(options.ready ? {readySnapshot: snapshot} : {}),
    stale: options.stale,
  };
}

function analysisSnapshot(): CodeGraphSnapshot {
  return {
    commit: '1'.repeat(40),
    dirty: false,
    edgeCount: 0,
    extractorSet: 'analysis-fixture',
    fileCount: 1,
    graphContentId: 'analysis-content',
    id: 'analysis-snapshot',
    repositoryId: 'analysis-repository',
    state: 'ready',
    symbolCount: 1,
    worktreeId: 'analysis-worktree',
  };
}

function runtimeConfig(): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: TEST_HOME,
    agentId: 'analysis-command-test',
    manifestPath: `${TEST_HOME}/seed-manifest.yaml`,
    user: 'analysis-command-test',
  };
}
