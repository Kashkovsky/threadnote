import {Effect} from 'effect';
import {ApplicationLayer, type ApplicationServices} from '../../src/effect/runtime.js';

export const runEffect = <A, E>(effect: Effect.Effect<A, E, ApplicationServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(ApplicationLayer)));
