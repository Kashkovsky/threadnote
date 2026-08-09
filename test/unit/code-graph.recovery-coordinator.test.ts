import {Deferred, Effect, Exit, Logger, Ref} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codeGraphAutomaticRecoveryAction,
  makeCodeGraphAutomaticRecoveryCoordinator,
} from '../../src/code_graph/recovery_coordinator.js';
import type {CodeGraphRoutineMaintenanceResult} from '../../src/code_graph/store.js';
import {
  CodeGraphStorePermissionError,
  CodeGraphStoreSchemaAdditiveError,
  type CodeGraphStoreFailureCode,
} from '../../src/code_graph/types.js';
import {
  makeCodeGraphWatcher,
  requestCodeGraphAutomaticRecovery,
  type CodeGraphRefreshFailure,
  type CodeGraphWatchOptions,
} from '../../src/code_graph/watcher.js';

const recoveryKey = 'a'.repeat(64);
const watchOptions: CodeGraphWatchOptions = {
  cwd: '/fixture/repository',
  key: recoveryKey,
  threadnoteHome: '/fixture/home',
};
const noWorkResult = {
  cleanup: 'none',
  expiredLeases: 0,
  remaining: false,
  retiredSnapshots: 0,
  rowsDeleted: 0,
  state: 'completed',
} as const satisfies CodeGraphRoutineMaintenanceResult;
const failureCodes = [
  'busy',
  'confirmed-corruption',
  'incompatible-schema',
  'no-space',
  'permission',
  'schema-additive',
  'transient-io',
  'unknown',
] as const satisfies readonly CodeGraphStoreFailureCode[];

describe('automatic code graph recovery', () => {
  it('admits routine maintenance only for positive additive-schema evidence', () => {
    fc.assert(
      fc.property(fc.constantFrom(...failureCodes), failureCode => {
        expect(codeGraphAutomaticRecoveryAction(failureCode)).toBe(
          failureCode === 'schema-additive' ? 'routine-maintenance' : 'none',
        );
      }),
      {numRuns: 250},
    );
  });

  it('never turns no-space load into a second maintenance attempt', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const coordinator = yield* makeCodeGraphAutomaticRecoveryCoordinator();
        const admissions = yield* Effect.all(
          Array.from({length: 256}, () =>
            coordinator.request({
              failureCode: 'no-space',
              recoveryKey,
              routineMaintenance: Ref.update(calls, count => count + 1).pipe(Effect.as(noWorkResult)),
            }),
          ),
          {concurrency: 'unbounded'},
        );

        expect(yield* Ref.get(calls)).toBe(0);
        expect(admissions).toEqual(
          Array.from({length: 256}, () => ({
            action: 'none',
            code: 'no-space',
            state: 'not-actionable-here',
          })),
        );
      }).pipe(Effect.scoped),
    );
  });

  it('fails closed when a direct recovery key is not an opaque worktree identity', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const coordinator = yield* makeCodeGraphAutomaticRecoveryCoordinator();
        const admission = yield* coordinator.request({
          failureCode: 'schema-additive',
          recoveryKey: '/private/not-an-opaque-key',
          routineMaintenance: Ref.update(calls, count => count + 1).pipe(Effect.as(noWorkResult)),
        });

        expect(admission).toEqual({
          action: 'none',
          code: 'schema-additive',
          state: 'not-actionable-here',
        });
        expect(yield* Ref.get(calls)).toBe(0);
        expect(JSON.stringify(admission)).not.toContain('/private');
      }).pipe(Effect.scoped),
    );
  });

  it('resolves a CLI-shaped key before additive admission and reuses that identity for one tick', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const resolverCalls = yield* Ref.make(0);
        const maintenanceCalls = yield* Ref.make(0);
        const completed = yield* Deferred.make<void>();
        const coordinator = yield* makeCodeGraphAutomaticRecoveryCoordinator();
        const admission = yield* requestCodeGraphAutomaticRecovery(
          {
            coordinator,
            resolveIdentity: () =>
              Ref.update(resolverCalls, count => count + 1).pipe(
                Effect.as({checkoutId: 'b'.repeat(64), worktreeId: recoveryKey}),
              ),
            routineMaintenance: (_options, identity) =>
              Ref.update(maintenanceCalls, count => count + 1).pipe(
                Effect.tap(() => {
                  expect(identity).toEqual({checkoutId: 'b'.repeat(64), worktreeId: recoveryKey});
                  return Effect.void;
                }),
                Effect.as(noWorkResult),
                Effect.ensuring(Deferred.succeed(completed, undefined)),
              ),
          },
          {...watchOptions, key: '/fixture/repository'},
          refreshFailure('schema-additive'),
        );
        yield* Deferred.await(completed);

        expect(admission).toEqual({action: 'routine-maintenance', state: 'scheduled'});
        expect(yield* Ref.get(resolverCalls)).toBe(1);
        expect(yield* Ref.get(maintenanceCalls)).toBe(1);
      }).pipe(Effect.scoped),
    );
  });

  it('coalesces 256 MCP-shaped failures before resolving identity or opening maintenance', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const resolverCalls = yield* Ref.make(0);
        const maintenanceCalls = yield* Ref.make(0);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const coordinator = yield* makeCodeGraphAutomaticRecoveryCoordinator();
        const dependencies = {
          coordinator,
          resolveIdentity: () =>
            Ref.update(resolverCalls, count => count + 1).pipe(
              Effect.as({checkoutId: 'b'.repeat(64), worktreeId: recoveryKey}),
            ),
          routineMaintenance: () =>
            Ref.update(maintenanceCalls, count => count + 1).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as(noWorkResult),
            ),
        };
        const admissions = yield* Effect.all(
          Array.from({length: 256}, () =>
            requestCodeGraphAutomaticRecovery(dependencies, watchOptions, refreshFailure('schema-additive')),
          ),
          {concurrency: 'unbounded'},
        );

        yield* Deferred.await(started);
        expect(yield* Ref.get(resolverCalls)).toBe(1);
        expect(yield* Ref.get(maintenanceCalls)).toBe(1);
        expect(admissions.filter(admission => admission.state === 'scheduled')).toHaveLength(1);
        expect(admissions.filter(admission => admission.state === 'coalesced')).toHaveLength(255);
        yield* Deferred.succeed(release, undefined);
      }).pipe(Effect.scoped),
    );
  });

  it('does not resolve identity or mutate for any non-actionable failure class', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const resolverCalls = yield* Ref.make(0);
        const maintenanceCalls = yield* Ref.make(0);
        const coordinator = yield* makeCodeGraphAutomaticRecoveryCoordinator();
        const nonActionable = failureCodes.filter(code => code !== 'schema-additive');
        const admissions = yield* Effect.forEach(nonActionable, code =>
          requestCodeGraphAutomaticRecovery(
            {
              coordinator,
              resolveIdentity: () =>
                Ref.update(resolverCalls, count => count + 1).pipe(
                  Effect.as({checkoutId: 'b'.repeat(64), worktreeId: recoveryKey}),
                ),
              routineMaintenance: () => Ref.update(maintenanceCalls, count => count + 1).pipe(Effect.as(noWorkResult)),
            },
            {...watchOptions, key: '/fixture/repository'},
            refreshFailure(code),
          ),
        );

        expect(admissions).toEqual(nonActionable.map(code => ({action: 'none', code, state: 'not-actionable-here'})));
        expect(yield* Ref.get(resolverCalls)).toBe(0);
        expect(yield* Ref.get(maintenanceCalls)).toBe(0);
      }).pipe(Effect.scoped),
    );
  });

  it('single-flights additive recovery without joining a held maintenance page', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const coordinator = yield* makeCodeGraphAutomaticRecoveryCoordinator();
        const routineMaintenance = Ref.update(calls, count => count + 1).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Deferred.await(release)),
          Effect.as(noWorkResult),
        );
        const admissions = yield* Effect.all(
          Array.from({length: 256}, () =>
            coordinator.request({failureCode: 'schema-additive', recoveryKey, routineMaintenance}),
          ),
          {concurrency: 'unbounded'},
        );

        // Every caller returned while the admitted maintenance page was still held.
        yield* Deferred.await(started);
        expect(yield* Ref.get(calls)).toBe(1);
        expect(admissions.filter(admission => admission.state === 'scheduled')).toHaveLength(1);
        expect(admissions.filter(admission => admission.state === 'coalesced')).toHaveLength(255);
        yield* Deferred.succeed(release, undefined);
      }).pipe(Effect.scoped),
    );
  });

  it('opens a bounded cooldown after one additive recovery attempt', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const now = yield* Ref.make(0);
        const completed = yield* Deferred.make<void>();
        const coordinator = yield* makeCodeGraphAutomaticRecoveryCoordinator({
          cooldownMilliseconds: 1_000,
          nowMilliseconds: () => Ref.get(now),
        });
        const routineMaintenance = Ref.update(calls, count => count + 1).pipe(
          Effect.as(noWorkResult),
          Effect.ensuring(Deferred.succeed(completed, undefined)),
        );
        expect(yield* coordinator.request({failureCode: 'schema-additive', recoveryKey, routineMaintenance})).toEqual({
          action: 'routine-maintenance',
          state: 'scheduled',
        });
        yield* Deferred.await(completed);

        let duringCooldown = yield* coordinator.request({
          failureCode: 'schema-additive',
          recoveryKey,
          routineMaintenance,
        });
        for (let attempt = 0; attempt < 16 && duringCooldown.state === 'coalesced'; attempt += 1) {
          yield* Effect.yieldNow;
          duringCooldown = yield* coordinator.request({
            failureCode: 'schema-additive',
            recoveryKey,
            routineMaintenance,
          });
        }
        expect(duringCooldown).toEqual({
          action: 'routine-maintenance',
          retryAfterMilliseconds: 1_000,
          state: 'cooldown',
        });
        expect(yield* Ref.get(calls)).toBe(1);

        yield* Ref.set(now, 1_000);
        expect(yield* coordinator.request({failureCode: 'schema-additive', recoveryKey, routineMaintenance})).toEqual({
          action: 'routine-maintenance',
          state: 'scheduled',
        });
        for (let attempt = 0; attempt < 16 && (yield* Ref.get(calls)) < 2; attempt += 1) yield* Effect.yieldNow;
        expect(yield* Ref.get(calls)).toBe(2);
      }).pipe(Effect.scoped),
    );
  });

  it('reports a failed first attempt without retaining native paths', async () => {
    const privateMarker = '/Users/private/recovery.sqlite';
    const logs: string[] = [];
    const logger = Logger.make<unknown, void>(options => {
      logs.push(String(options.message));
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const attempted = yield* Deferred.make<void>();
        const coordinator = yield* makeCodeGraphAutomaticRecoveryCoordinator();
        const routineMaintenance = Deferred.succeed(attempted, undefined).pipe(
          Effect.andThen(Effect.fail(new CodeGraphStorePermissionError(`permission denied at ${privateMarker}`))),
        );
        expect(yield* coordinator.request({failureCode: 'schema-additive', recoveryKey, routineMaintenance})).toEqual({
          action: 'routine-maintenance',
          state: 'scheduled',
        });
        yield* Deferred.await(attempted);
        let settled = yield* coordinator.request({failureCode: 'schema-additive', recoveryKey, routineMaintenance});
        for (let attempt = 0; attempt < 16 && settled.state === 'coalesced'; attempt += 1) {
          yield* Effect.yieldNow;
          settled = yield* coordinator.request({failureCode: 'schema-additive', recoveryKey, routineMaintenance});
        }

        expect(settled.state).toBe('cooldown');
        expect(logs).toContain(
          'Code graph automatic recovery maintenance failed (permission; recovery: fix-permissions).',
        );
        expect(`${JSON.stringify(settled)}\n${logs.join('\n')}`).not.toContain(privateMarker);
      }).pipe(Effect.provide(Logger.layer([logger])), Effect.scoped),
    );
  });

  it('bounds a detached CLI identity-resolution failure without retaining its path', async () => {
    const privateMarker = '/Volumes/private/recovery-worktree';
    const logs: string[] = [];
    const logger = Logger.make<unknown, void>(options => {
      logs.push(String(options.message));
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const attempted = yield* Deferred.make<void>();
        const coordinator = yield* makeCodeGraphAutomaticRecoveryCoordinator();
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          () => Effect.fail(new CodeGraphStoreSchemaAdditiveError('additive migration required')),
          {},
          (options, failure) =>
            requestCodeGraphAutomaticRecovery(
              {
                coordinator,
                resolveIdentity: () =>
                  Deferred.succeed(attempted, undefined).pipe(
                    Effect.andThen(Effect.fail(new Error(`could not resolve ${privateMarker}`))),
                  ),
                routineMaintenance: () => Effect.die('must not run'),
              },
              options,
              failure,
            ).pipe(Effect.asVoid),
        );
        const cliOptions = {...watchOptions, key: watchOptions.cwd};
        yield* watcher.ensure(cliOptions);
        expect(yield* watcher.refresh(cliOptions)).toBe(true);
        yield* Deferred.await(attempted);
        for (
          let attempt = 0;
          attempt < 16 &&
          !logs.includes('Code graph automatic recovery scheduling failed (unknown; recovery: diagnose).');
          attempt += 1
        ) {
          yield* Effect.yieldNow;
        }

        expect(logs).toContain('Code graph automatic recovery scheduling failed (unknown; recovery: diagnose).');
        expect(logs.join('\n')).not.toContain(privateMarker);
      }).pipe(Effect.provide(Logger.layer([logger])), Effect.scoped),
    );
  });

  it('preserves scope cancellation without reporting it as recovery failure', async () => {
    const logs: string[] = [];
    const logger = Logger.make<unknown, void>(options => {
      logs.push(String(options.message));
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const interrupted = yield* Ref.make(0);
        const started = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const coordinator = yield* makeCodeGraphAutomaticRecoveryCoordinator();
            const admission = yield* coordinator.request({
              failureCode: 'schema-additive',
              recoveryKey,
              routineMaintenance: Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Ref.update(interrupted, count => count + 1)),
              ),
            });
            expect(admission).toEqual({action: 'routine-maintenance', state: 'scheduled'});
            yield* Deferred.await(started);
          }),
        );

        expect(yield* Ref.get(interrupted)).toBe(1);
        expect(logs.some(message => message.includes('automatic recovery maintenance failed'))).toBe(false);
      }).pipe(Effect.provide(Logger.layer([logger]))),
    );
  });

  it('publishes background failure state while recovery scheduling remains held', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const recoveryCalls = yield* Ref.make(0);
        const recoveryStarted = yield* Deferred.make<void>();
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          () => Effect.fail(new CodeGraphStoreSchemaAdditiveError('additive migration required')),
          {},
          () =>
            Ref.update(recoveryCalls, count => count + 1).pipe(
              Effect.andThen(Deferred.succeed(recoveryStarted, undefined)),
              Effect.andThen(Effect.never),
            ),
        );
        yield* watcher.ensure(watchOptions);
        expect(yield* watcher.refresh(watchOptions)).toBe(true);
        yield* Deferred.await(recoveryStarted);
        const status = yield* watcher.status(watchOptions.key);

        expect(yield* Ref.get(recoveryCalls)).toBe(1);
        expect(status).toMatchObject({
          _tag: 'Some',
          value: {failure: {code: 'schema-additive'}, state: 'deferred'},
        });
      }).pipe(Effect.scoped),
    );
  });

  it('does not make foreground watch wait for held recovery scheduling', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const recoveryStarted = yield* Deferred.make<void>();
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          () => Effect.fail(new CodeGraphStoreSchemaAdditiveError('additive migration required')),
          {},
          () => Deferred.succeed(recoveryStarted, undefined).pipe(Effect.andThen(Effect.never)),
        );
        const exit = yield* Effect.exit(watcher.watch(watchOptions));
        yield* Deferred.await(recoveryStarted);

        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.scoped),
    );
  });
});

function refreshFailure(code: CodeGraphStoreFailureCode): CodeGraphRefreshFailure {
  return {
    code,
    operation: 'refresh code graph',
    recovery: code === 'schema-additive' ? 'migrate-additive' : 'diagnose',
    retryable: false,
  };
}
