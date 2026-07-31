import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS,
  type CodeGraphBuildState,
  type CodeGraphBuildStatus,
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
