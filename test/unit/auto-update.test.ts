import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import fc from 'fast-check';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  initializeAutoUpdatePolicy,
  isAutoUpdateDue,
  isAutoUpdateVersionEligible,
  nextAutoUpdateAttempt,
  parseAutoUpdateState,
  readAutoUpdateStatus,
  setAutoUpdatePolicy,
  stateAfterFailedAutoUpdateSpawn,
  terminalAutoUpdateState,
  type AutoUpdateState,
} from '../../src/auto_update.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const AutoUpdateTestLayer = Layer.mergeAll(BunServices.layer, SystemInfo.layer);

describe('automatic update state', () => {
  effectIt.effect('defaults to notify and persists explicit policy changes atomically', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseSystem = yield* SystemInfo;
      const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-auto-update-'});
      const installRoot = path.join(temporaryRoot, 'install');
      const statePath = path.join(installRoot, 'auto-update.json');
      const testSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: installRoot}),
      });

      const initial = yield* readAutoUpdateStatus().pipe(Effect.provideService(SystemInfo, testSystem));
      yield* initializeAutoUpdatePolicy('automatic').pipe(Effect.provideService(SystemInfo, testSystem));
      const enabled = yield* readAutoUpdateStatus().pipe(Effect.provideService(SystemInfo, testSystem));
      yield* fs.writeFileString(
        statePath,
        `${JSON.stringify({
          policy: 'automatic',
          running: {attempt: 1, fromVersion: '4.2.2', startedAt: '2026-08-13T08:00:00.000Z'},
          version: 1,
        })}\n`,
      );
      yield* setAutoUpdatePolicy('notify').pipe(Effect.provideService(SystemInfo, testSystem));
      const disabled = yield* readAutoUpdateStatus().pipe(Effect.provideService(SystemInfo, testSystem));
      const persisted = JSON.parse(yield* fs.readFileString(statePath)) as unknown;

      expect(initial).toMatchObject({effectivePolicy: 'notify', policy: 'notify', policySource: 'default'});
      expect(enabled).toMatchObject({effectivePolicy: 'automatic', policy: 'automatic', policySource: 'file'});
      expect(disabled).toMatchObject({effectivePolicy: 'notify', policy: 'notify', policySource: 'file'});
      expect(persisted).toEqual({policy: 'notify', version: 1});
    }).pipe(provideTestLayer(AutoUpdateTestLayer)),
  );

  effectIt.effect('honors environment opt-out without rewriting the persisted preference', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseSystem = yield* SystemInfo;
      const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-auto-update-opt-out-'});
      const installRoot = path.join(temporaryRoot, 'install');
      const persistedSystem = SystemInfo.of({
        ...baseSystem,
        environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: installRoot}),
      });
      yield* initializeAutoUpdatePolicy('automatic').pipe(Effect.provideService(SystemInfo, persistedSystem));
      const optedOutSystem = SystemInfo.of({
        ...persistedSystem,
        environment: () => ({
          ...persistedSystem.environment(),
          THREADNOTE_NO_UPDATE_CHECK: '1',
        }),
      });
      const status = yield* readAutoUpdateStatus().pipe(Effect.provideService(SystemInfo, optedOutSystem));

      expect(status).toMatchObject({effectivePolicy: 'notify', policy: 'automatic', policySource: 'environment'});
    }).pipe(provideTestLayer(AutoUpdateTestLayer)),
  );

  it('round-trips every valid fully populated state through JSON parsing', () => {
    const version = fc
      .tuple(fc.integer({max: 100, min: 0}), fc.integer({max: 100, min: 0}), fc.integer({max: 100, min: 0}))
      .map(parts => parts.join('.'));
    const timestamp = fc
      .integer({max: Date.parse('2099-12-31T23:59:59.999Z'), min: Date.parse('2000-01-01T00:00:00.000Z')})
      .map(milliseconds => new Date(milliseconds).toISOString());
    const notification = fc.constantFrom('failed' as const, 'sent' as const, 'unavailable' as const);
    const state = fc.record({
      lastCheckAt: timestamp,
      lastFailure: fc.record({
        attempt: fc.integer({max: 1_000, min: 1}),
        failedAt: timestamp,
        fromVersion: version,
        notification,
        summary: fc.string({maxLength: 500}),
      }),
      lastSuccess: fc.record({
        completedAt: timestamp,
        fromVersion: version,
        notification,
        repairRequired: fc.boolean(),
        toVersion: version,
      }),
      policy: fc.constantFrom('automatic' as const, 'notify' as const),
      running: fc.record({
        attempt: fc.integer({max: 1_000, min: 1}),
        fromVersion: version,
        startedAt: timestamp,
      }),
      version: fc.constant(1 as const),
    });

    fc.assert(
      fc.property(state, candidate => {
        expect(parseAutoUpdateState(JSON.parse(JSON.stringify(candidate)))).toEqual(candidate);
      }),
    );
  });

  it('increments attempts only for consecutive failures from the same active version', () => {
    const prior = {
      lastFailure: {
        attempt: 3,
        failedAt: '2026-08-13T08:00:00.000Z',
        fromVersion: '4.2.2',
        summary: 'network unavailable',
      },
      policy: 'automatic',
      version: 1,
    } satisfies AutoUpdateState;

    expect(nextAutoUpdateAttempt(prior, '4.2.2')).toBe(4);
    expect(nextAutoUpdateAttempt(prior, '4.2.3')).toBe(1);
  });

  it('never permits unattended replacement of a SHA-bound development runtime', () => {
    expect(isAutoUpdateVersionEligible('4.2.2')).toBe(true);
    expect(isAutoUpdateVersionEligible(`4.2.2-local.g${'a'.repeat(40)}`)).toBe(false);
  });

  it('removes every running claim from a terminal state transition', () => {
    fc.assert(
      fc.property(fc.integer({max: 1_000, min: 1}), attempt => {
        const runningState = {
          policy: 'automatic',
          running: {attempt, fromVersion: '4.2.2', startedAt: '2026-08-13T08:00:00.000Z'},
          version: 1,
        } satisfies AutoUpdateState;
        const terminal = terminalAutoUpdateState(runningState, {
          lastCheckAt: '2026-08-13T09:00:00.000Z',
        });
        expect(terminal.running).toBe(undefined);
        expect(terminal).toMatchObject({policy: 'automatic', version: 1});
      }),
    );
  });

  it('does not resurrect a running claim when opt-out wins a failed-spawn race', () => {
    const claimedAt = '2026-08-13T09:00:00.000Z';
    const disabledAfterClaim = {
      lastCheckAt: claimedAt,
      policy: 'notify',
      version: 1,
    } satisfies AutoUpdateState;
    expect(
      stateAfterFailedAutoUpdateSpawn(disabledAfterClaim, {
        claimedAt,
        previousLastCheckAt: '2026-08-13T08:00:00.000Z',
      }),
    ).toEqual({
      lastCheckAt: '2026-08-13T08:00:00.000Z',
      policy: 'notify',
      version: 1,
    });
  });

  it('backs off failed checks and eventually recovers a stale running claim', () => {
    const checkedAt = Date.parse('2026-08-13T08:00:00.000Z');
    const failure = {
      lastCheckAt: new Date(checkedAt).toISOString(),
      lastFailure: {
        attempt: 1,
        failedAt: new Date(checkedAt).toISOString(),
        fromVersion: '4.2.2',
        summary: 'network unavailable',
      },
      policy: 'automatic',
      version: 1,
    } satisfies AutoUpdateState;
    expect(isAutoUpdateDue(failure, checkedAt + 14 * 60 * 1_000)).toBe(false);
    expect(isAutoUpdateDue(failure, checkedAt + 15 * 60 * 1_000)).toBe(true);

    const running = {
      ...failure,
      running: {attempt: 2, fromVersion: '4.2.2', startedAt: new Date(checkedAt).toISOString()},
    } satisfies AutoUpdateState;
    expect(isAutoUpdateDue(running, checkedAt + 29 * 60 * 1_000)).toBe(false);
    expect(isAutoUpdateDue(running, checkedAt + 30 * 60 * 1_000)).toBe(true);
  });
});
