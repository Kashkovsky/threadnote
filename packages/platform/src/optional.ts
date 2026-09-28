import {Effect, Option} from 'effect';

/** Absent optional success without `Effect.succeed(undefined)`. */
export const succeedUndefined: Effect.Effect<undefined> = Effect.map(Effect.succeedNone, Option.getOrUndefined);
