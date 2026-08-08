import {Cause, Clock, Effect, Exit, Option, SynchronizedRef} from 'effect';
import type {CodeGraphRoutineMaintenanceResult} from './store.js';
import {classifyCodeGraphStoreFailure} from './store_failure.js';
import type {CodeGraphStoreFailureCode} from './types.js';

export type CodeGraphAutomaticRecoveryAction = 'none' | 'routine-maintenance';

export type CodeGraphAutomaticRecoveryAdmission =
  | {
      readonly action: 'routine-maintenance';
      readonly state: 'coalesced' | 'scheduled';
    }
  | {
      readonly action: 'routine-maintenance';
      readonly retryAfterMilliseconds: number;
      readonly state: 'cooldown';
    }
  | {
      readonly action: 'none';
      readonly code: CodeGraphStoreFailureCode;
      readonly state: 'not-actionable-here';
    };

export interface CodeGraphAutomaticRecoveryRequest {
  readonly failureCode: CodeGraphStoreFailureCode;
  /** Opaque worktree identity used only for bounded in-process coalescing. */
  readonly recoveryKey: string;
  /**
   * One zero-wait, one-page E1 maintenance effect. It is evaluated only after
   * an additive-schema request wins admission.
   */
  readonly routineMaintenance?: Effect.Effect<CodeGraphRoutineMaintenanceResult, unknown>;
}

export interface CodeGraphAutomaticRecoveryCoordinatorShape {
  readonly request: (input: CodeGraphAutomaticRecoveryRequest) => Effect.Effect<CodeGraphAutomaticRecoveryAdmission>;
}

export interface CodeGraphAutomaticRecoveryCoordinatorOptions {
  readonly cooldownMilliseconds?: number;
  /** @internal Deterministic clock seam for state-machine tests. */
  readonly nowMilliseconds?: () => Effect.Effect<number>;
}

type RecoveryEntry =
  {readonly state: 'active'; readonly token: object} | {readonly state: 'cooldown'; readonly untilMilliseconds: number};

type RecoverySchedulingDecision =
  | {readonly action: 'routine-maintenance'; readonly state: 'coalesced'}
  | {
      readonly action: 'routine-maintenance';
      readonly retryAfterMilliseconds: number;
      readonly state: 'cooldown';
    }
  | {readonly action: 'routine-maintenance'; readonly state: 'scheduled'; readonly token: object};

const DEFAULT_RECOVERY_COOLDOWN_MILLISECONDS = 60_000;
const CODE_GRAPH_AUTOMATIC_RECOVERY_OPERATION = 'automatic code graph recovery';

/**
 * Automatic recovery is deliberately narrower than diagnosis or explicit
 * repair. A schema-additive failure is created only after a positive
 * creates-only preflight. Every other class needs either E6 capacity evidence,
 * an operator action, or a future quarantine protocol.
 */
export function codeGraphAutomaticRecoveryAction(
  failureCode: CodeGraphStoreFailureCode,
): CodeGraphAutomaticRecoveryAction {
  return failureCode === 'schema-additive' ? 'routine-maintenance' : 'none';
}

/**
 * Schedule at most one path-free, opaque-worktree-scoped recovery attempt. Callers do
 * not join the maintenance effect, so foreground reads and refresh failures
 * retain their original latency and cancellation contracts.
 */
export const makeCodeGraphAutomaticRecoveryCoordinator = Effect.fn('codeGraph.makeAutomaticRecoveryCoordinator')(
  function* (options: CodeGraphAutomaticRecoveryCoordinatorOptions = {}) {
    const scope = yield* Effect.scope;
    const cooldownMilliseconds = positiveInteger(options.cooldownMilliseconds, DEFAULT_RECOVERY_COOLDOWN_MILLISECONDS);
    const nowMilliseconds = options.nowMilliseconds ?? (() => Clock.currentTimeMillis);
    const entries = yield* SynchronizedRef.make(new Map<string, RecoveryEntry>());

    const removeActive = (key: string, token: object) =>
      SynchronizedRef.update(entries, current => {
        const existing = current.get(key);
        if (existing?.state !== 'active' || existing.token !== token) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });

    const enterCooldown = (key: string, token: object) =>
      Effect.gen(function* () {
        const now = yield* nowMilliseconds();
        yield* SynchronizedRef.update(entries, current => {
          const existing = current.get(key);
          if (existing?.state !== 'active' || existing.token !== token) return current;
          const next = new Map(current);
          next.set(key, {state: 'cooldown', untilMilliseconds: now + cooldownMilliseconds});
          return next;
        });
      });

    const request = (input: CodeGraphAutomaticRecoveryRequest) =>
      Effect.uninterruptibleMask(restore =>
        Effect.gen(function* () {
          if (
            codeGraphAutomaticRecoveryAction(input.failureCode) === 'none' ||
            input.routineMaintenance === undefined ||
            !/^[0-9a-f]{64}$/u.test(input.recoveryKey)
          ) {
            return {
              action: 'none',
              code: input.failureCode,
              state: 'not-actionable-here',
            } as const;
          }

          const now = yield* nowMilliseconds();
          const token = {};
          const decision = yield* SynchronizedRef.modify<Map<string, RecoveryEntry>, RecoverySchedulingDecision>(
            entries,
            current => {
              const next = new Map(current);
              for (const [key, entry] of next) {
                if (entry.state === 'cooldown' && entry.untilMilliseconds <= now) next.delete(key);
              }
              const existing = next.get(input.recoveryKey);
              if (existing?.state === 'active') {
                return [{action: 'routine-maintenance', state: 'coalesced'} as const, next] as const;
              }
              if (existing?.state === 'cooldown') {
                return [
                  {
                    action: 'routine-maintenance',
                    retryAfterMilliseconds: Math.max(1, existing.untilMilliseconds - now),
                    state: 'cooldown',
                  } as const,
                  next,
                ] as const;
              }
              next.set(input.recoveryKey, {state: 'active', token});
              return [{action: 'routine-maintenance', state: 'scheduled', token} as const, next] as const;
            },
          );
          if (decision.state !== 'scheduled') return decision;

          const recovery = Effect.gen(function* () {
            const exit = yield* Effect.exit(input.routineMaintenance!);
            if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
              yield* removeActive(input.recoveryKey, token);
              return yield* Effect.failCause(exit.cause);
            }

            yield* enterCooldown(input.recoveryKey, token);
            if (Exit.isFailure(exit)) {
              const classified = classifyCodeGraphStoreFailure(
                CODE_GRAPH_AUTOMATIC_RECOVERY_OPERATION,
                Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
              );
              yield* Effect.logWarning(
                `Code graph automatic recovery maintenance failed (${classified.code}; recovery: ${classified.recovery}).`,
              );
              return;
            }
            if (exit.value.state === 'completed') {
              yield* Effect.logInfo(
                `Code graph automatic recovery maintenance completed (cleanup: ${exit.value.cleanup}).`,
              );
              return;
            }
            yield* Effect.logWarning(
              `Code graph automatic recovery maintenance ${exit.value.state} (${exit.value.reason}).`,
            );
          });
          yield* restore(recovery).pipe(Effect.forkIn(scope));
          const admission: CodeGraphAutomaticRecoveryAdmission = {
            action: 'routine-maintenance',
            state: 'scheduled',
          };
          return admission;
        }),
      );

    return {request} satisfies CodeGraphAutomaticRecoveryCoordinatorShape;
  },
);

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value <= 0 ? fallback : value;
}
