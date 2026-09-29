import {Cause, Effect, SynchronizedRef} from 'effect';

type SchedulerEntry<Input> = {readonly generation: object; readonly pending?: {readonly value: Input}};
type SchedulerDecision<Input> = {readonly type: 'run'; readonly value: Input} | {readonly type: 'stop'};

/** Coalesce keyed background work and bind every fiber to the caller's scope. */
export const makeKeyedBackgroundScheduler = <Input>(input: {
  /** @internal Deterministic test hook inside the reservation handoff. */
  readonly beforeFork?: Effect.Effect<void>;
  readonly key: (value: Input) => string;
  readonly onFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
  readonly run: (value: Input) => Effect.Effect<unknown, unknown>;
}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const active = yield* SynchronizedRef.make(new Map<string, SchedulerEntry<Input>>());
    const remove = (key: string, generation: object) =>
      SynchronizedRef.update(active, current => {
        if (current.get(key)?.generation !== generation) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    const run = (key: string, generation: object, initial: Input) =>
      Effect.gen(function* () {
        let value = initial;
        for (;;) {
          yield* input.run(value).pipe(
            Effect.catchCauseIf(
              cause => !Cause.hasInterruptsOnly(cause),
              cause => input.onFailure(cause).pipe(Effect.ignore),
            ),
          );
          const trailing = yield* SynchronizedRef.modify(
            active,
            (current): readonly [SchedulerDecision<Input>, Map<string, SchedulerEntry<Input>>] => {
              const entry = current.get(key);
              if (entry?.generation !== generation) return [{type: 'stop'}, current];
              if (entry.pending !== undefined) {
                const next = new Map(current);
                next.set(key, {generation});
                return [{type: 'run', value: entry.pending.value}, next];
              }
              const next = new Map(current);
              next.delete(key);
              return [{type: 'stop'}, next];
            },
          );
          if (trailing.type === 'stop') return;
          value = trailing.value;
        }
      }).pipe(Effect.interruptible, Effect.ensuring(remove(key, generation)));
    return (value: Input): Effect.Effect<void> => {
      const key = input.key(value);
      return Effect.uninterruptible(
        Effect.gen(function* () {
          const generation = {};
          const start = yield* SynchronizedRef.modify(active, current => {
            const entry = current.get(key);
            const next = new Map(current);
            if (entry !== undefined) {
              next.set(key, {...entry, pending: {value}});
              return [undefined, next] as const;
            }
            next.set(key, {generation});
            return [generation, next] as const;
          });
          if (start === undefined) return;
          if (input.beforeFork !== undefined) yield* input.beforeFork;
          yield* run(key, start, value).pipe(Effect.forkIn(scope));
        }),
      );
    };
  });
