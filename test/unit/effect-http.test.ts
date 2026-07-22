import {Effect, pipe, Result} from 'effect';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {getJsonEffect, getTextEffect} from '../../src/effect/http.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

let nextResponse: () => Response;
const runTestEffect = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => nextResponse()),
  );
});

afterAll(() => vi.unstubAllGlobals());

describe('Effect HttpService', () => {
  it('returns status and text through the managed application layer', async () => {
    nextResponse = () => new Response('healthy', {status: 200});

    await expect(
      pipe(getTextEffect('http://localhost/health'), Effect.provide(ApplicationLayer), runTestEffect),
    ).resolves.toEqual({
      body: 'healthy',
      status: 200,
    });
  });

  it('returns decoded JSON', async () => {
    nextResponse = () => Response.json({version: '4.0.0'});

    await expect(
      pipe(getJsonEffect('https://registry.example/latest'), Effect.provide(ApplicationLayer), runTestEffect),
    ).resolves.toEqual({
      body: {version: '4.0.0'},
      status: 200,
    });
  });

  it('models non-success status codes in the typed error channel', async () => {
    nextResponse = () => new Response('nope', {status: 503});

    const result = await pipe(
      getTextEffect('http://localhost/health').pipe(Effect.match({onFailure: Result.fail, onSuccess: Result.succeed})),
      Effect.provide(ApplicationLayer),
      runTestEffect,
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe('HttpStatusError');
    }
  });

  it('times out while a successful response body is still streaming', async () => {
    nextResponse = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
          },
        }),
        {status: 200},
      );

    await expect(
      pipe(getTextEffect('http://localhost/health', {timeoutMs: 20}), Effect.provide(ApplicationLayer), runTestEffect),
    ).rejects.toThrow('GET http://localhost/health failed');
  });
});
