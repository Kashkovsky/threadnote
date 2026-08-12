import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {afterAll, beforeAll, describe, expect, vi} from 'vitest';
import {getJsonEffect, getTextEffect} from '../../src/effect/http.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

let nextResponse: () => Response;

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => nextResponse()),
  );
});

afterAll(() => vi.unstubAllGlobals());

describe('Effect HttpService', () => {
  effectIt.effect('returns status and text through the managed application layer', () =>
    Effect.gen(function* () {
      nextResponse = () => new Response('healthy', {status: 200});

      expect(yield* getTextEffect('http://localhost/health').pipe(provideTestLayer(ApplicationLayer))).toEqual({
        body: 'healthy',
        status: 200,
      });
    }),
  );

  effectIt.effect('returns decoded JSON', () =>
    Effect.gen(function* () {
      nextResponse = () => Response.json({version: '4.0.0'});

      expect(yield* getJsonEffect('https://registry.example/latest').pipe(provideTestLayer(ApplicationLayer))).toEqual({
        body: {version: '4.0.0'},
        status: 200,
      });
    }),
  );

  effectIt.effect('models non-success status codes in the typed error channel', () =>
    Effect.gen(function* () {
      nextResponse = () => new Response('nope', {status: 503});

      const result = yield* getTextEffect('http://localhost/health').pipe(
        Effect.match({onFailure: Result.fail, onSuccess: Result.succeed}),
        provideTestLayer(ApplicationLayer),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe('HttpStatusError');
      }
    }),
  );

  effectIt.effect('times out while a successful response body is still streaming', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        nextResponse = () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('partial'));
              },
            }),
            {status: 200},
          );

        expect(
          String(
            yield* Effect.flip(
              getTextEffect('http://localhost/health', {timeoutMs: 20}).pipe(provideTestLayer(ApplicationLayer)),
            ),
          ),
        ).toContain('GET http://localhost/health failed');
      }),
    ),
  );
});
