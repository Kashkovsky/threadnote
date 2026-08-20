import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS,
  type CodeGraphBuildState,
  type CodeGraphBuildStatus,
  codeGraphAbandonedBuildStatusRemovable,
  observeCodeGraphBuildStatus,
  parseCodeGraphBuildStatus,
} from '../../src/code_graph/build_status.js';

const heartbeatAt = Date.parse('2026-07-31T12:00:00.000Z');

const observationCase = FC.record({
  ageMilliseconds: FC.integer({
    max: CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS * 2,
    min: -CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS,
  }),
  hasStartIdentity: FC.boolean(),
  isRunning: FC.boolean(),
  reusedProcessId: FC.boolean(),
  state: FC.constantFrom<CodeGraphBuildState>('completed', 'failed', 'queued', 'running'),
});

const materializationCase = FC.record({
  attributedFiles: FC.integer({max: 1_000_000, min: 0}),
  availableBytes: FC.integer({max: 1_000_000_000, min: 0}),
  batchCompleted: FC.integer({max: 100, min: 0}),
  cachedFactBytes: FC.integer({max: 1_000_000_000, min: 0}),
  edges: FC.integer({max: 1_000_000, min: 0}),
  exactGenerationShardFiles: FC.integer({max: 1_000_000, min: 0}),
  materializedShardReplayBytes: FC.integer({max: 1_000_000_000, min: 0}),
  rawFactReplayBytes: FC.integer({max: 1_000_000_000, min: 0}),
  sourceBytes: FC.integer({max: 1_000_000_000, min: 0}),
  stagingBytes: FC.integer({max: 1_000_000_000, min: 0}),
  symbols: FC.integer({max: 1_000_000, min: 0}),
});

const activationCase = FC.record({
  elapsedMilliseconds: FC.integer({max: 10_000_000, min: 0}),
  rows: FC.integer({max: 100_000_000, min: 0}),
  stage: FC.constantFrom(
    'checkpointing-snapshot' as const,
    'committing-snapshot' as const,
    'copying-edges' as const,
    'copying-files' as const,
    'copying-lookup-keys' as const,
    'copying-reexports' as const,
    'copying-symbols' as const,
    'copying-terms' as const,
    'copying-workspace' as const,
    'recording-completion' as const,
    'validating-input' as const,
  ),
  state: FC.constantFrom('completed' as const, 'progress' as const, 'started' as const),
  transactionMilliseconds: FC.integer({max: 100_000, min: 0}),
});

describe('code graph build-status properties', () => {
  it.prop(
    'classifies terminal, exited, reused, stale, and active owners in fail-closed precedence order',
    {observation: observationCase},
    ({observation}) => {
      const status = buildStatus(observation.state, observation.hasStartIdentity);
      const observed = observeCodeGraphBuildStatus(status, {
        isRunning: observation.isRunning,
        nowMilliseconds: heartbeatAt + observation.ageMilliseconds,
        ...(observation.hasStartIdentity
          ? {processStartIdentity: observation.reusedProcessId ? 'replacement-owner' : 'original-owner'}
          : {}),
      });

      expect(observed.observation.heartbeatAgeMilliseconds).toBe(Math.max(0, observation.ageMilliseconds));
      if (observation.state === 'completed' || observation.state === 'failed') {
        expect(observed.observation).toMatchObject({liveness: observation.state});
      } else if (!observation.isRunning) {
        expect(observed.observation).toMatchObject({liveness: 'abandoned', reason: 'owner-exited'});
      } else if (observation.hasStartIdentity && observation.reusedProcessId) {
        expect(observed.observation).toMatchObject({liveness: 'abandoned', reason: 'pid-reused'});
      } else if (observation.ageMilliseconds > CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS) {
        expect(observed.observation).toMatchObject({liveness: 'stalled', reason: 'heartbeat-stale'});
      } else {
        expect(observed.observation).toMatchObject({liveness: 'active'});
      }
    },
    {fastCheck: {numRuns: 250}},
  );

  it.prop(
    'admits abandoned nonterminal cleanup only without an exact protected build or matching lock owner',
    {
      liveness: FC.constantFrom(
        'abandoned' as const,
        'active' as const,
        'completed' as const,
        'failed' as const,
        'stalled' as const,
      ),
      lock: FC.constantFrom('absent' as const, 'matching' as const, 'replacement' as const),
      protectedBuild: FC.boolean(),
      state: FC.constantFrom<CodeGraphBuildState>('completed', 'failed', 'queued', 'running'),
    },
    ({liveness, lock, protectedBuild, state}) => {
      const status = {
        ...buildStatus(state, true),
        observation: {heartbeatAgeMilliseconds: 60_000, liveness},
      };
      const lockOwner =
        lock === 'absent'
          ? undefined
          : {
              processId: status.owner.processId,
              processStartIdentity: lock === 'matching' ? 'original-owner' : 'replacement-owner',
              token: 'owner-token',
              version: 1 as const,
            };

      expect(
        codeGraphAbandonedBuildStatusRemovable(status, lockOwner, protectedBuild ? status.buildId : undefined),
      ).toBe(
        liveness === 'abandoned' &&
          state !== 'completed' &&
          state !== 'failed' &&
          !protectedBuild &&
          lock !== 'matching',
      );
    },
    {fastCheck: {numRuns: 250}},
  );

  it('round-trips a bounded repository display name without accepting local-path control characters', () => {
    const status = buildStatus('running', true);
    const named = {...status, identity: {...status.identity, displayName: 'example/repository'}};
    expect(parseCodeGraphBuildStatus(named)?.identity.displayName).toBe('example/repository');
    expect(
      parseCodeGraphBuildStatus({...named, identity: {...named.identity, displayName: 'example\nrepository'}}),
    ).toBeUndefined();
  });

  it.prop(
    'never throws while validating arbitrary JSON values and only returns bounded schema-v1 records',
    {value: FC.jsonValue()},
    ({value}) => {
      const parsed = parseCodeGraphBuildStatus(value);
      if (!parsed) return;

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.buildId.length).toBeLessThanOrEqual(64);
      expect(parsed.owner.processId).toBeGreaterThan(0);
      expect(parsed.owner.runtime).toBe('bun');
      expect(parsed.owner.runtimeVersion.length).toBeLessThanOrEqual(64);
      expect(parsed.subphase?.length ?? 0).toBeLessThanOrEqual(64);
      expect(parsed.error?.summary.length ?? 0).toBeLessThanOrEqual(300);
      expect(Object.values(parsed.counters).every(value => typeof value === 'string' || value >= 0)).toBe(true);
    },
    {fastCheck: {numRuns: 500}},
  );

  it.prop(
    'round-trips bounded materialization activity and keeps TEMP database high-water internally consistent',
    {sample: materializationCase},
    ({sample}) => {
      const status = buildStatus('running', true);
      const batchesTotal = sample.batchCompleted + 1;
      const stagingHighWaterBytes = sample.stagingBytes + 1_024;
      const materializing: CodeGraphBuildStatus = {
        ...status,
        materialization: {
          activity: {
            batchCompleted: sample.batchCompleted,
            batchTotal: batchesTotal,
            cachedFactBytes: sample.cachedFactBytes,
            rows: {
              deduplicatedEdges: sample.edges,
              deduplicatedReferences: sample.symbols,
              edges: sample.edges,
              symbols: sample.symbols,
            },
            sourceBytes: sample.sourceBytes,
            stage: 'writing-facts',
            startedAt: status.timestamps.phaseStartedAt,
          },
          metrics: {
            attributedFilesCompleted: sample.attributedFiles,
            batchesCompleted: sample.batchCompleted,
            batchesTotal,
            cachedFactBytesCompleted: sample.cachedFactBytes,
            cachedFactBytesTotal: sample.cachedFactBytes,
            cachedFactReplayBytesCompleted: sample.materializedShardReplayBytes + sample.rawFactReplayBytes,
            changedFactBytesCompleted: sample.cachedFactBytes,
            crossGenerationShardFilesCompleted: 0,
            exactGenerationShardFilesCompleted: sample.exactGenerationShardFiles,
            materializedShardReplayBytesCompleted: sample.materializedShardReplayBytes,
            rawFactReplayBytesCompleted: sample.rawFactReplayBytes,
            rows: {
              deduplicatedEdges: sample.edges,
              deduplicatedReferences: sample.symbols,
              edges: sample.edges,
              symbols: sample.symbols,
            },
            sourceBytesCompleted: sample.sourceBytes,
            sourceBytesTotal: sample.sourceBytes,
            storage: {
              availableBytes: sample.availableBytes,
              durableAvailableBytes: sample.availableBytes,
              estimateBasis: 'cached-fact-bytes',
              estimatedConcurrentBuildBytes: sample.stagingBytes,
              estimatedDurableFilesystemRequiredBytes: sample.stagingBytes,
              estimatedDurableSnapshotBytes: sample.stagingBytes,
              estimatedJournalBytes: sample.stagingBytes,
              estimatedRequiredBytes: stagingHighWaterBytes,
              estimatedTemporaryFilesystemRequiredBytes: sample.stagingBytes,
              estimatedTemporaryDatabaseBytes: sample.stagingBytes,
              filesystemsShared: true,
              temporaryAvailableBytes: sample.availableBytes,
              temporaryDatabaseBytes: sample.stagingBytes,
              temporaryDatabaseHighWaterBytes: stagingHighWaterBytes,
            },
          },
        },
      };

      expect(parseCodeGraphBuildStatus(JSON.parse(JSON.stringify(materializing)))?.materialization).toEqual(
        materializing.materialization,
      );
      expect(
        parseCodeGraphBuildStatus({
          ...materializing,
          materialization: {
            ...materializing.materialization,
            metrics: {
              ...materializing.materialization!.metrics!,
              cachedFactReplayBytesCompleted:
                materializing.materialization!.metrics!.cachedFactReplayBytesCompleted! + 1,
            },
          },
        }),
      ).toBeUndefined();
      expect(
        parseCodeGraphBuildStatus({
          ...materializing,
          materialization: {
            metrics: {
              ...materializing.materialization!.metrics,
              storage: {
                temporaryDatabaseBytes: stagingHighWaterBytes + 1,
                temporaryDatabaseHighWaterBytes: stagingHighWaterBytes,
              },
            },
          },
        }),
      ).toBeUndefined();
    },
    {fastCheck: {numRuns: 150}},
  );

  it.prop(
    'round-trips bounded activation progress and rejects negative transaction timings',
    {sample: activationCase},
    ({sample}) => {
      const status = buildStatus('running', true);
      const activity = {
        elapsedMilliseconds: sample.elapsedMilliseconds,
        rows: sample.rows,
        stage: sample.stage,
        stageElapsedMilliseconds: Math.min(sample.elapsedMilliseconds, sample.transactionMilliseconds),
        startedAt: status.timestamps.phaseStartedAt,
        state: sample.state,
        transactionMilliseconds: sample.transactionMilliseconds,
      };
      const activating: CodeGraphBuildStatus = {...status, activation: {activity}, phase: 'activating'};

      expect(parseCodeGraphBuildStatus(JSON.parse(JSON.stringify(activating)))?.activation).toEqual(
        activating.activation,
      );
      expect(
        parseCodeGraphBuildStatus({
          ...activating,
          activation: {activity: {...activity, transactionMilliseconds: -1}},
        }),
      ).toBeUndefined();
    },
    {fastCheck: {numRuns: 150}},
  );
});

function buildStatus(state: CodeGraphBuildState, hasStartIdentity: boolean): CodeGraphBuildStatus {
  const timestamp = new Date(heartbeatAt).toISOString();
  return {
    buildId: 'a'.repeat(32),
    counters: {},
    identity: {
      checkoutId: 'b'.repeat(64),
      commit: 'c'.repeat(40),
      repositoryId: 'd'.repeat(64),
      worktreeId: 'e'.repeat(64),
    },
    owner: {
      processId: 42,
      ...(hasStartIdentity ? {processStartIdentity: 'original-owner'} : {}),
      runtime: 'bun',
      runtimeVersion: '1.3.14',
    },
    phase: state === 'queued' ? 'waiting' : 'materializing',
    schemaVersion: 1,
    state,
    timestamps: {
      ...(state === 'completed' || state === 'failed' ? {completedAt: timestamp} : {}),
      heartbeatAt: timestamp,
      lastProgressAt: timestamp,
      phaseStartedAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
  };
}
