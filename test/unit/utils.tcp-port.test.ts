import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {isTcpPortOpen} from '../../src/utils.js';

effectIt.effect('detects an open TCP listener and rejects an invalid port', () =>
  Effect.acquireUseRelease(
    Effect.promise(async () => Bun.serve({port: 0, fetch: () => new Response('ok')})),
    server =>
      Effect.gen(function* () {
        const port = server.port;
        if (port === undefined) throw new Error('Expected TCP port');
        expect(yield* isTcpPortOpen('127.0.0.1', port, 1_000)).toBe(true);
        expect(yield* isTcpPortOpen('127.0.0.1', 0, 1_000)).toBe(false);
      }),
    server => Effect.promise(async () => server.stop(true)),
  ).pipe(TestClock.withLive),
);
