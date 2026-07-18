import {expect, it} from '@effect/vitest';
import {Effect, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import {describe} from 'vitest';
import {pollUntilEffect} from '../../src/effect/time.js';

describe('Effect time orchestration', () => {
  it.effect('polls deterministically with TestClock', () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fiber = yield* pollUntilEffect(
        Effect.sync(() => {
          attempts += 1;
          return attempts === 3 ? 'healthy' : undefined;
        }),
        {intervalMs: 500, timeoutMs: 5000},
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(1000);

      expect(yield* Fiber.join(fiber)).toBe('healthy');
      expect(attempts).toBe(3);
    }),
  );

  it.effect('stops polling at the deadline', () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fiber = yield* pollUntilEffect(
        Effect.sync(() => {
          attempts += 1;
          return undefined;
        }),
        {intervalMs: 500, timeoutMs: 1000},
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(1000);

      expect(yield* Fiber.join(fiber)).toBeUndefined();
      expect(attempts).toBe(3);
    }),
  );
});
