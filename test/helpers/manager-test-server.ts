import {BunHttpServer} from '@effect/platform-bun';
import {Effect, Fiber, Scope} from 'effect';
import {HttpServer} from 'effect/unstable/http';
import {createManagerServer} from '../../src/manager.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from './effect-layer.js';
import {TestError} from './test-error.js';

export interface ManagerTestServer {
  readonly close: () => Promise<void>;
  readonly url: string;
}

// The manager tests exercise the actual fetch/HTTP callback boundary. This
// helper owns the one Effect runtime that backs that Promise-native server.
export async function startManagerTestServer(config: RuntimeConfig, token: string): Promise<ManagerTestServer> {
  let resolveAddress: ((value: string) => void) | undefined;
  let rejectAddress: ((reason: unknown) => void) | undefined;
  const address = new Promise<string>((resolve, reject) => {
    resolveAddress = resolve;
    rejectAddress = reject;
  });
  const fiber = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const worksetScope = yield* Scope.Scope;
        yield* server.serve(createManagerServer({config, jobs: new Map(), token, worksetScope}));
        const serverAddress = server.address;
        if (serverAddress._tag !== 'TcpAddress') {
          return yield* Effect.fail(new TestError('manager test server did not bind to TCP'));
        }
        yield* Effect.sync(() => resolveAddress?.(`http://127.0.0.1:${serverAddress.port}`));
        return yield* Effect.never;
      }),
    ).pipe(
      provideTestLayer(BunHttpServer.layerTest),
      provideTestLayer(ApplicationLayer),
      Effect.tapError(error => Effect.sync(() => rejectAddress?.(error))),
    ),
  );
  return {
    close: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
    url: await address,
  };
}
