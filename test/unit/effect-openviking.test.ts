import {expect, it} from '@effect/vitest';
import {Effect, Exit, Fiber, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import {CommandExecutor} from '../../src/effect/command.js';
import {OpenVikingRemoveFailed, removeOpenVikingResourceEffect} from '../../src/effect/openviking.js';

const busy = {exitCode: 1, stderr: 'resource is being processed', stdout: ''};
const success = {exitCode: 0, stderr: '', stdout: 'removed'};

it.effect('retries busy OpenViking removals on an Effect schedule', () =>
  Effect.gen(function* () {
    let attempts = 0;
    const executor = Layer.succeed(
      CommandExecutor,
      CommandExecutor.of({
        execute: () => Effect.succeed(++attempts === 3 ? success : busy),
        executeStreaming: () => Effect.die(new Error('Unexpected streaming command')),
      }),
    );
    const fiber = yield* removeOpenVikingResourceEffect('ov', ['rm', 'viking://memory'], {
      isBusy: stderr => stderr.includes('being processed'),
    }).pipe(Effect.provide(executor), Effect.forkChild);

    yield* TestClock.adjust(3000);

    expect(yield* Fiber.join(fiber)).toEqual(success);
    expect(attempts).toBe(3);
  }),
);

it.effect('returns undefined after the scheduled busy retries are exhausted', () =>
  Effect.gen(function* () {
    let attempts = 0;
    const executor = Layer.succeed(
      CommandExecutor,
      CommandExecutor.of({
        execute: () => {
          attempts += 1;
          return Effect.succeed(busy);
        },
        executeStreaming: () => Effect.die(new Error('Unexpected streaming command')),
      }),
    );
    const fiber = yield* removeOpenVikingResourceEffect('ov', ['rm', 'viking://memory'], {
      isBusy: stderr => stderr.includes('being processed'),
    }).pipe(Effect.provide(executor), Effect.forkChild);

    yield* TestClock.adjust(6000);

    expect(yield* Fiber.join(fiber)).toBeUndefined();
    expect(attempts).toBe(4);
  }),
);

it.effect('does not retry non-transient removal failures', () =>
  Effect.gen(function* () {
    let attempts = 0;
    const executor = Layer.succeed(
      CommandExecutor,
      CommandExecutor.of({
        execute: () => {
          attempts += 1;
          return Effect.succeed({exitCode: 2, stderr: 'permission denied', stdout: ''});
        },
        executeStreaming: () => Effect.die(new Error('Unexpected streaming command')),
      }),
    );
    const exit = yield* removeOpenVikingResourceEffect('ov', ['rm', 'viking://memory'], {
      isBusy: () => false,
    }).pipe(Effect.provide(executor), Effect.exit);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain(OpenVikingRemoveFailed.name);
      expect(exit.cause.toString()).toContain('permission denied');
    }
    expect(attempts).toBe(1);
  }),
);
