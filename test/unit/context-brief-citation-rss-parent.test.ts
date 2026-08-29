import {describe, expect, it} from '@effect/vitest';
import {Effect, Exit, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import {
  makeContextBriefCitationRssObserverController,
  terminateContextBriefCitationRssProcess,
  validateContextBriefCitationRssAcknowledgement,
  validateContextBriefCitationRssBundleDigest,
  waitForContextBriefCitationRssReady,
} from '../../scripts/benchmark-context-brief-citations-target.js';
import type {
  ContextBriefCitationRssAcknowledgementV1,
  ContextBriefCitationRssArtifactV1,
  ContextBriefCitationRssReadyV1,
} from '../../scripts/context-brief-citation-rss-observer.js';
import {ScriptError} from '../../scripts/effect/errors.js';

describe('Context Brief citation RSS parent controller', () => {
  it.effect('rejects a same-bundle digest mismatch before controller startup', () =>
    Effect.gen(function* () {
      const observed = 'a'.repeat(64);
      const expected = 'b'.repeat(64);
      const error = yield* validateContextBriefCitationRssBundleDigest(observed, expected).pipe(Effect.flip);

      expect(error.message).toContain(`target digest ${observed}; expected ${expected}`);
      yield* validateContextBriefCitationRssBundleDigest(expected, expected);
    }),
  );

  it.effect('fails immediately on early child exit and deterministically on ready timeout', () =>
    Effect.gen(function* () {
      const earlyExit = yield* waitForContextBriefCitationRssReady({
        childExitCode: () => 17,
        readReady: Effect.succeed(undefined),
        stderr: Promise.resolve('early diagnostic'),
        timeoutMilliseconds: 100,
      }).pipe(Effect.flip);
      expect(earlyExit.message).toContain('exited before ready: early diagnostic');

      let polls = 0;
      const timeoutFiber = yield* waitForContextBriefCitationRssReady({
        childExitCode: () => null,
        readReady: Effect.sync(() => {
          polls += 1;
          return undefined;
        }),
        stderr: Promise.resolve(''),
        timeoutMilliseconds: 100,
      }).pipe(Effect.flip, Effect.forkChild({startImmediately: true}));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(100);
      const timeout = yield* Fiber.join(timeoutFiber);

      expect(timeout.message).toContain('Timed out waiting');
      expect(polls).toBeGreaterThan(1);
    }),
  );

  it.effect('rejects every non-exact acknowledgement dimension', () =>
    Effect.gen(function* () {
      const request = {observationId: 'local-100k-0', operation: 'begin', sequence: 1, version: 1} as const;
      const valid = {
        observationId: request.observationId,
        sequence: request.sequence,
        state: 'begun',
        version: 1,
      } as const;
      yield* validateContextBriefCitationRssAcknowledgement(request, 'begun', valid);

      const mismatches: readonly ContextBriefCitationRssAcknowledgementV1[] = [
        {...valid, sequence: 2},
        {...valid, state: 'ended'},
        {...valid, observationId: 'local-100k-1'},
      ];
      for (const acknowledgement of mismatches) {
        const error = yield* validateContextBriefCitationRssAcknowledgement(request, 'begun', acknowledgement).pipe(
          Effect.flip,
        );
        expect(error.message).toContain('mismatched barrier');
      }
    }),
  );

  it.effect('closes the child after begin, use, or end failure while preserving end cleanup after use begins', () =>
    Effect.gen(function* () {
      for (const failure of ['begin', 'use', 'end'] as const) {
        const harness = controllerHarness({barrierFailure: failure === 'use' ? undefined : failure});
        const use = Effect.gen(function* () {
          harness.events.push('use');
          if (failure === 'use') return yield* Effect.fail(new ScriptError('use failed'));
        });
        const result = yield* Effect.acquireUseRelease(
          Effect.succeed(harness.controller),
          controller => controller.observe('local-100k-0', use),
          controller => controller.close,
        ).pipe(Effect.exit);

        expect(Exit.isFailure(result)).toBe(true);
        expect(harness.events.at(-1)).toBe('terminate');
        if (failure === 'begin') {
          expect(harness.events).toEqual(['barrier:begin', 'terminate']);
        } else {
          expect(harness.events).toEqual(['barrier:begin', 'use', 'barrier:end', 'terminate']);
        }
      }
    }),
  );

  it.effect('orders stop, confirmed exit, and artifact read and rejects ready-contract drift', () =>
    Effect.gen(function* () {
      const successful = controllerHarness();
      expect(yield* successful.controller.finish).toEqual(artifact());
      expect(successful.events).toEqual(['barrier:stop', 'wait-exit', 'read-artifact']);
      yield* successful.controller.close;
      expect(successful.events).not.toContain('terminate');

      const drifted = controllerHarness({artifact: artifact({rootStartIdentity: 'different-root'})});
      const error = yield* drifted.controller.finish.pipe(Effect.flip);
      expect(error.message).toContain('changed its ready contract');
      expect(drifted.events).toEqual(['barrier:stop', 'wait-exit', 'read-artifact']);
    }),
  );

  it.effect('escalates TERM to KILL and succeeds only after confirmed child exit', () =>
    Effect.gen(function* () {
      let exitCode: number | null = null;
      let waits = 0;
      const signals: Array<'TERM' | 9> = [];
      yield* terminateContextBriefCitationRssProcess({
        exitCode: () => exitCode,
        kill: signal => signals.push(signal === 9 ? 9 : 'TERM'),
        waitForExit: async () => {
          waits += 1;
          if (waits === 1) return undefined;
          exitCode = 137;
          return exitCode;
        },
      });
      expect(signals).toEqual(['TERM', 9]);
      expect(exitCode).toBe(137);

      const unconfirmedSignals: Array<'TERM' | 9> = [];
      const error = yield* terminateContextBriefCitationRssProcess({
        exitCode: () => null,
        kill: signal => unconfirmedSignals.push(signal === 9 ? 9 : 'TERM'),
        waitForExit: () => Promise.resolve(undefined),
      }).pipe(Effect.flip);
      expect(unconfirmedSignals).toEqual(['TERM', 9]);
      expect(error.message).toContain('could not be confirmed stopped');
    }),
  );
});

function controllerHarness(
  options: {
    readonly artifact?: ContextBriefCitationRssArtifactV1;
    readonly barrierFailure?: 'begin' | 'end';
  } = {},
) {
  const events: string[] = [];
  let exitCode: number | null = null;
  const controller = makeContextBriefCitationRssObserverController({
    barrier: request =>
      Effect.gen(function* () {
        events.push(`barrier:${request.operation}`);
        if (request.operation === options.barrierFailure) {
          return yield* Effect.fail(new ScriptError(`${request.operation} failed`));
        }
      }),
    childExitCode: () => exitCode,
    exitWithin: Effect.sync(() => {
      events.push('wait-exit');
      exitCode = 0;
      return 0;
    }),
    readArtifact: Effect.sync(() => {
      events.push('read-artifact');
      return options.artifact ?? artifact();
    }),
    ready: ready(),
    stderr: Promise.resolve(''),
    terminate: Effect.sync(() => {
      events.push('terminate');
      exitCode = 143;
    }),
  });
  return {controller, events};
}

function ready(): ContextBriefCitationRssReadyV1 {
  return {
    intervalMilliseconds: 10,
    observerExcluded: true,
    rootIdentityValidation: 'linux-proc-starttime',
    rootStartIdentity: '4242',
    scope: 'recursive-process-tree',
    source: 'linux-proc',
    state: 'ready',
    version: 1,
  };
}

function artifact(overrides: Partial<ContextBriefCitationRssArtifactV1> = {}): ContextBriefCitationRssArtifactV1 {
  return {
    finalSample: {
      processCount: 1,
      rootRssBytes: 100,
      sampleAttempts: 1,
      sampleFailures: 0,
      treeRssBytes: 100,
    },
    intervalMilliseconds: 10,
    maximumSampleGapMilliseconds: 0,
    observations: [],
    observerExcluded: true,
    processCountPeakObserved: 1,
    rootIdentityValidation: 'linux-proc-starttime',
    rootStartIdentity: '4242',
    sampleAttempts: 1,
    sampleFailures: 0,
    scope: 'recursive-process-tree',
    source: 'linux-proc',
    successfulSamples: 1,
    version: 1,
    ...overrides,
  };
}
