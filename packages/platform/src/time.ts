import {Clock, Effect, Schedule} from 'effect';

export interface PollOptions {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

export const pollUntilEffect = <A, E, R>(
  attempt: Effect.Effect<A | undefined, E, R>,
  options: PollOptions,
): Effect.Effect<A | undefined, E, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = startedAt + options.timeoutMs;
    while (true) {
      const result = yield* attempt;
      if (result !== undefined) {
        return result;
      }
      const now = yield* Clock.currentTimeMillis;
      const remainingMs = deadline - now;
      if (remainingMs <= 0) {
        return undefined;
      }
      yield* Effect.sleep(Math.min(options.intervalMs, remainingMs));
    }
  });

export function retrySchedule(delaysMs: readonly number[]): Schedule.Schedule<number> {
  return Schedule.addDelay(Schedule.recurs(delaysMs.length), ({output}) =>
    Effect.succeed(delaysMs[Math.min(output, delaysMs.length - 1)] ?? 0),
  );
}
