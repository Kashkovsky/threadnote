import {TestError} from '../helpers/test-error.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Ref} from 'effect';
import {describe, expect} from 'vitest';
import {
  makeCodeGraphLifecycleOpportunityRunner,
  runCodeGraphLifecycleOpportunity,
  type CodeGraphLifecycleOpportunityTarget,
} from '../../src/code_graph/lifecycle_opportunity.js';
import type {
  CodeGraphMaintenanceCoordinatorShape,
  CodeGraphRoutineMaintenanceTick,
} from '../../src/code_graph/maintenance_coordinator.js';
import {SystemInfo} from '../../src/effect/system.js';

describe('code graph lifecycle opportunities', () => {
  effectIt.layer(Layer.merge(BunServices.layer, SystemInfo.layer))(layerIt => {
    layerIt.effect('services a pending reconciliation directly on a cold one-shot opportunity', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const threadnoteHome = yield* fs.makeTempDirectoryScoped({
            prefix: 'threadnote-lifecycle-opportunity-cold-',
          });
          const calls = yield* Ref.make<readonly CodeGraphRoutineMaintenanceTick[]>([]);
          const unexpected = (operation: string) =>
            Effect.die(new TestError(`pending opportunity unexpectedly called ${operation}`));
          const maintenance: CodeGraphMaintenanceCoordinatorShape = {
            kickOrdinary: () => unexpected('ordinary maintenance'),
            kickReconciliation: input =>
              Ref.update(calls, current => [...current, input]).pipe(
                Effect.as({
                  cleanup: 'removed-worktree-view',
                  expiredLeases: 0,
                  remaining: true,
                  retiredSnapshots: 1,
                  rowsDeleted: 0,
                  state: 'completed',
                } as const),
              ),
            kickResidual: () => unexpected('residual maintenance'),
            request: () => unexpected('detached maintenance'),
            tick: () => unexpected('rotating maintenance'),
          };
          const targets: readonly CodeGraphLifecycleOpportunityTarget[] = [
            {checkoutId: '0'.repeat(64), databasePath: '/database/healthy'},
            {
              anchorPath: '/repository/live-anchor',
              checkoutId: 'f'.repeat(64),
              databasePath: '/database/missing-view',
              reconciliationPending: true,
            },
          ];

          const result = yield* runCodeGraphLifecycleOpportunity({
            maintenance,
            opportunity: 'diagnostics',
            targets,
            threadnoteHome,
          });

          expect(result).toMatchObject({checkoutId: 'f'.repeat(64), state: 'completed'});
          expect(yield* Ref.get(calls)).toEqual([
            expect.objectContaining({
              anchorPath: '/repository/live-anchor',
              automaticTail: false,
              checkoutId: 'f'.repeat(64),
              databasePath: '/database/missing-view',
              joinActive: false,
            }),
          ]);
        }),
      ),
    );

    layerIt.effect('persists cold rotation when an earlier pending database makes no progress', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const threadnoteHome = yield* fs.makeTempDirectoryScoped({
            prefix: 'threadnote-lifecycle-opportunity-cursor-',
          });
          const firstCheckoutId = '0'.repeat(64);
          const secondCheckoutId = '1'.repeat(64);
          const calls = yield* Ref.make<readonly string[]>([]);
          const unexpected = (operation: string) =>
            Effect.die(new TestError(`pending opportunity unexpectedly called ${operation}`));
          const maintenance: CodeGraphMaintenanceCoordinatorShape = {
            kickOrdinary: () => unexpected('ordinary maintenance'),
            kickReconciliation: input =>
              Ref.update(calls, current => [...current, input.checkoutId]).pipe(
                Effect.as(
                  input.checkoutId === firstCheckoutId
                    ? ({
                        cleanup: 'none',
                        expiredLeases: 0,
                        remaining: false,
                        retiredSnapshots: 0,
                        rowsDeleted: 0,
                        state: 'completed',
                      } as const)
                    : ({
                        cleanup: 'removed-worktree-view',
                        expiredLeases: 0,
                        remaining: true,
                        retiredSnapshots: 1,
                        rowsDeleted: 0,
                        state: 'completed',
                      } as const),
                ),
              ),
            kickResidual: () => unexpected('residual maintenance'),
            request: () => unexpected('detached maintenance'),
            tick: () => unexpected('rotating maintenance'),
          };
          const targets: readonly CodeGraphLifecycleOpportunityTarget[] = [
            {
              anchorPath: '/repository/unprovable-anchor',
              checkoutId: firstCheckoutId,
              databasePath: '/database/unprovable-missing-view',
              reconciliationPending: true,
            },
            {
              anchorPath: '/repository/actionable-anchor',
              checkoutId: secondCheckoutId,
              databasePath: '/database/actionable-missing-view',
              reconciliationPending: true,
            },
          ];
          const cursorRoot = path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'lifecycle-opportunities');
          const strandedTemporary = path.join(cursorRoot, '.diagnostics.cursor-v1.json.tmp');
          yield* fs.makeDirectory(cursorRoot, {recursive: true});
          yield* fs.writeFileString(strandedTemporary, 'stranded publication');

          const firstProcess = makeCodeGraphLifecycleOpportunityRunner();
          const first = yield* firstProcess({
            maintenance,
            opportunity: 'diagnostics',
            targets,
            threadnoteHome,
          });
          const secondProcess = makeCodeGraphLifecycleOpportunityRunner();
          const second = yield* secondProcess({
            maintenance,
            opportunity: 'diagnostics',
            targets,
            threadnoteHome,
          });

          expect(first).toMatchObject({checkoutId: firstCheckoutId, result: {cleanup: 'none'}, state: 'completed'});
          expect(second).toMatchObject({
            checkoutId: secondCheckoutId,
            result: {cleanup: 'removed-worktree-view'},
            state: 'completed',
          });
          expect(yield* Ref.get(calls)).toEqual([firstCheckoutId, secondCheckoutId]);
          const cursor = yield* fs.readFileString(path.join(cursorRoot, 'diagnostics.cursor-v1.json'));
          expect(cursor).not.toContain('/database/');
          expect(cursor).not.toContain('/repository/');
          expect(yield* fs.exists(strandedTemporary)).toBe(false);
        }),
      ),
    );

    layerIt.effect('rotates every explicit lane for one unprovable pending database across fresh processes', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const threadnoteHome = yield* fs.makeTempDirectoryScoped({
            prefix: 'threadnote-lifecycle-opportunity-sole-pending-',
          });
          const calls = yield* Ref.make<readonly string[]>([]);
          const record = (lane: string) =>
            Ref.update(calls, current => [...current, lane]).pipe(Effect.as(emptyMaintenanceResult()));
          const maintenance: CodeGraphMaintenanceCoordinatorShape = {
            kickOrdinary: () => record('ordinary'),
            kickReconciliation: () => record('reconciliation'),
            kickResidual: () => record('residual'),
            request: () => Effect.die(new TestError('foreground opportunity unexpectedly detached maintenance')),
            tick: () => Effect.die(new TestError('pending opportunity unexpectedly used process-local rotation')),
          };
          const target: CodeGraphLifecycleOpportunityTarget = {
            anchorPath: '/repository/unprovable-anchor',
            checkoutId: '4'.repeat(64),
            databasePath: '/database/unprovable-missing-view',
            reconciliationPending: true,
          };

          for (let index = 0; index < 3; index += 1) {
            const freshProcess = makeCodeGraphLifecycleOpportunityRunner();
            yield* freshProcess({
              maintenance,
              opportunity: 'status',
              targets: [target],
              threadnoteHome,
            });
          }

          expect(yield* Ref.get(calls)).toEqual(['reconciliation', 'ordinary', 'residual']);
        }),
      ),
    );

    layerIt.effect('services a healthy sibling while one pending database remains unprovable', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const threadnoteHome = yield* fs.makeTempDirectoryScoped({
            prefix: 'threadnote-lifecycle-opportunity-healthy-sibling-',
          });
          const calls = yield* Ref.make<readonly string[]>([]);
          const record = (lane: string, input: CodeGraphRoutineMaintenanceTick) =>
            Ref.update(calls, current => [...current, `${lane}:${input.checkoutId[0]}`]).pipe(
              Effect.as(emptyMaintenanceResult()),
            );
          const maintenance: CodeGraphMaintenanceCoordinatorShape = {
            kickOrdinary: input => record('ordinary', input),
            kickReconciliation: input => record('reconciliation', input),
            kickResidual: input => record('residual', input),
            request: () => Effect.die(new TestError('foreground opportunity unexpectedly detached maintenance')),
            tick: () => Effect.die(new TestError('pending opportunity unexpectedly used process-local rotation')),
          };
          const targets: readonly CodeGraphLifecycleOpportunityTarget[] = [
            {
              anchorPath: '/repository/unprovable-anchor',
              checkoutId: '5'.repeat(64),
              databasePath: '/database/unprovable-missing-view',
              reconciliationPending: true,
            },
            {checkoutId: '6'.repeat(64), databasePath: '/database/healthy'},
          ];

          for (let index = 0; index < 5; index += 1) {
            const freshProcess = makeCodeGraphLifecycleOpportunityRunner();
            yield* freshProcess({maintenance, opportunity: 'catalog', targets, threadnoteHome});
          }

          expect(yield* Ref.get(calls)).toEqual([
            'reconciliation:5',
            'ordinary:5',
            'ordinary:6',
            'residual:5',
            'residual:6',
          ]);
        }),
      ),
    );

    layerIt.effect('rotates diagnostics through later anchored databases without a pending-view signal', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const threadnoteHome = yield* fs.makeTempDirectoryScoped({
            prefix: 'threadnote-lifecycle-opportunity-diagnostics-sweep-',
          });
          const calls = yield* Ref.make<readonly string[]>([]);
          const unexpected = (operation: string) =>
            Effect.die(new TestError(`diagnostics sweep unexpectedly called ${operation}`));
          const maintenance: CodeGraphMaintenanceCoordinatorShape = {
            kickOrdinary: () => unexpected('ordinary maintenance before reconciliation sweep'),
            kickReconciliation: input =>
              Ref.update(calls, current => [...current, input.checkoutId]).pipe(Effect.as(emptyMaintenanceResult())),
            kickResidual: () => unexpected('residual maintenance before reconciliation sweep'),
            request: () => unexpected('detached maintenance'),
            tick: () => unexpected('process-local rotation'),
          };
          const targets: readonly CodeGraphLifecycleOpportunityTarget[] = [
            {
              anchorPath: '/repository/first-anchor',
              checkoutId: '7'.repeat(64),
              databasePath: '/database/first',
            },
            {
              anchorPath: '/repository/later-anchor',
              checkoutId: '8'.repeat(64),
              databasePath: '/database/later-hidden-candidate',
            },
          ];

          for (let index = 0; index < 2; index += 1) {
            const freshProcess = makeCodeGraphLifecycleOpportunityRunner();
            yield* freshProcess({maintenance, opportunity: 'diagnostics', targets, threadnoteHome});
          }

          expect(yield* Ref.get(calls)).toEqual(['7'.repeat(64), '8'.repeat(64)]);
        }),
      ),
    );

    layerIt.effect('keeps healthy status opportunities free of durable cursor writes', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const threadnoteHome = yield* fs.makeTempDirectoryScoped({
            prefix: 'threadnote-lifecycle-opportunity-healthy-status-',
          });
          const unexpected = (operation: string) =>
            Effect.die(new TestError(`healthy status unexpectedly called ${operation}`));
          const maintenance: CodeGraphMaintenanceCoordinatorShape = {
            kickOrdinary: () => unexpected('direct ordinary maintenance'),
            kickReconciliation: () => unexpected('direct reconciliation'),
            kickResidual: () => unexpected('direct residual maintenance'),
            request: () => unexpected('detached maintenance'),
            tick: () => Effect.succeed(emptyMaintenanceResult()),
          };
          const target: CodeGraphLifecycleOpportunityTarget = {
            anchorPath: '/repository/healthy-anchor',
            checkoutId: '9'.repeat(64),
            databasePath: '/database/healthy',
          };

          yield* makeCodeGraphLifecycleOpportunityRunner()({
            maintenance,
            opportunity: 'status',
            targets: [target],
            threadnoteHome,
          });

          expect(
            yield* fs.exists(
              path.join(
                threadnoteHome,
                'locks',
                'indexes',
                'code-graph',
                'lifecycle-opportunities',
                'status.cursor-v1.json',
              ),
            ),
          ).toBe(false);
        }),
      ),
    );

    layerIt.effect('advances durable rotation before claimed maintenance crashes', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const threadnoteHome = yield* fs.makeTempDirectoryScoped({
            prefix: 'threadnote-lifecycle-opportunity-crash-',
          });
          const firstCheckoutId = '2'.repeat(64);
          const secondCheckoutId = '3'.repeat(64);
          const calls = yield* Ref.make<readonly string[]>([]);
          const unexpected = (operation: string) =>
            Effect.die(new TestError(`pending opportunity unexpectedly called ${operation}`));
          const shared = {
            kickOrdinary: () => unexpected('ordinary maintenance'),
            kickResidual: () => unexpected('residual maintenance'),
            request: () => unexpected('detached maintenance'),
            tick: () => unexpected('rotating maintenance'),
          } satisfies Omit<CodeGraphMaintenanceCoordinatorShape, 'kickReconciliation'>;
          const targets: readonly CodeGraphLifecycleOpportunityTarget[] = [
            {
              anchorPath: '/repository/crashing-anchor',
              checkoutId: firstCheckoutId,
              databasePath: '/database/crashing-missing-view',
              reconciliationPending: true,
            },
            {
              anchorPath: '/repository/recovery-anchor',
              checkoutId: secondCheckoutId,
              databasePath: '/database/recovery-missing-view',
              reconciliationPending: true,
            },
          ];
          const firstProcess = makeCodeGraphLifecycleOpportunityRunner();
          const firstExit = yield* firstProcess({
            maintenance: {
              ...shared,
              kickReconciliation: input =>
                Ref.update(calls, current => [...current, input.checkoutId]).pipe(
                  Effect.andThen(Effect.die(new TestError('simulated process crash after cursor claim'))),
                ),
            },
            opportunity: 'diagnostics',
            targets,
            threadnoteHome,
          }).pipe(Effect.exit);

          const secondProcess = makeCodeGraphLifecycleOpportunityRunner();
          const second = yield* secondProcess({
            maintenance: {
              ...shared,
              kickReconciliation: input =>
                Ref.update(calls, current => [...current, input.checkoutId]).pipe(
                  Effect.as({
                    cleanup: 'removed-worktree-view',
                    expiredLeases: 0,
                    remaining: true,
                    retiredSnapshots: 1,
                    rowsDeleted: 0,
                    state: 'completed',
                  } as const),
                ),
            },
            opportunity: 'diagnostics',
            targets,
            threadnoteHome,
          });

          expect(firstExit._tag).toBe('Failure');
          expect(second).toMatchObject({
            checkoutId: secondCheckoutId,
            result: {cleanup: 'removed-worktree-view'},
            state: 'completed',
          });
          expect(yield* Ref.get(calls)).toEqual([firstCheckoutId, secondCheckoutId]);
        }),
      ),
    );
  });
});

function emptyMaintenanceResult() {
  return {
    cleanup: 'none',
    expiredLeases: 0,
    remaining: false,
    retiredSnapshots: 0,
    rowsDeleted: 0,
    state: 'completed',
  } as const;
}
