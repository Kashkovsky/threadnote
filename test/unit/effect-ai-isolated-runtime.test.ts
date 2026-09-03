import {TestError} from '../helpers/test-error.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {expect, it} from '@effect/vitest';
import {Cause, Effect, Exit, Fiber, Layer} from 'effect';
import {describe} from 'vitest';
import {
  isolatedLocalModelRuntimeLayer,
  localModelWorkerSpawnOptions,
  serveWorker,
  type LocalModelWorkerProcess,
  type LocalModelWorkerSpawnOptions,
  type LocalModelWorkerSpawner,
} from '../../src/effect/ai/isolated-local-model-runtime.js';
import {EmbeddingFailed} from '../../src/effect/ai/errors.js';
import {LocalModelRuntime} from '../../src/effect/ai/local-model-runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {fatalLocalModelWorkerHarness} from '../helpers/fatal-local-model-worker.js';
import {anonymousTelemetryDiagnosticFromError} from '../../src/telemetry/diagnostic.js';

const embeddingManifest = {
  ...BUILTIN_MODEL_MANIFESTS.find(candidate => candidate.role === 'embedding')!,
  dimensions: 2,
};
const generationManifest = BUILTIN_MODEL_MANIFESTS.find(candidate => candidate.role === 'generation')!;

describe('isolated local model runtime', () => {
  it.effect('round-trips the effective native embedding context plan in diagnostics', () => {
    const spawn: LocalModelWorkerSpawner = () => {
      const worker = new FakeWorkerProcess(request => {
        worker.respond(request, {
          backend: 'metal',
          buildType: 'prebuilt',
          cpuMathCores: 10,
          embeddingContextPlan: {
            effectiveContexts: 4,
            modelGpuLayers: 0,
            requestedContexts: 4,
            threadCounts: [3, 3, 2, 2],
          },
        });
      });
      return worker;
    };

    return Effect.gen(function* () {
      const runtime = yield* LocalModelRuntime;
      expect(yield* runtime.diagnostics).toEqual({
        backend: 'metal',
        buildType: 'prebuilt',
        cpuMathCores: 10,
        embeddingContextPlan: {
          effectiveContexts: 4,
          modelGpuLayers: 0,
          requestedContexts: 4,
          threadCounts: [3, 3, 2, 2],
        },
      });
    }).pipe(provideTestLayer(runtimeLayer(spawn)));
  });

  it.effect('boots the standalone source worker when called from a Bun development script', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const options = localModelWorkerSpawnOptions({
        ...system,
        environment: () => ({
          ...system.environment(),
          THREADNOTE_TELEMETRY_SESSION_ID: 'tns_000102030405060708090a0b0c0d0e0f',
          THREADNOTE_TELEMETRY_CONSENT_GENERATION: 'tng_000102030405060708090a0b0c0d0e0f',
        }),
        executablePath: '/runtime/bun',
        processArguments: ['/runtime/bun', '/checkout/scripts/evaluate-recall-models.ts'],
      });

      expect(options.executable).toBe('/runtime/bun');
      expect(options.arguments.at(-1)).toBe('--threadnote-local-model-worker');
      expect(options.arguments.at(-2)?.replaceAll('\\', '/')).toMatch(/\/src\/standalone\.ts$/);
      expect(options.environment.THREADNOTE_TELEMETRY_SESSION_ID).toBe('tns_000102030405060708090a0b0c0d0e0f');
      expect(options.environment.THREADNOTE_TELEMETRY_CONSENT_GENERATION).toBe('tng_000102030405060708090a0b0c0d0e0f');
      expect(options.environment.THREADNOTE_TELEMETRY_CHILD).toBe('local-model-worker');
    }).pipe(provideTestLayer(SystemInfo.layer)),
  );

  it.effect('contains repeated fatal generation-child crashes as a typed failure', () => {
    const fatalWorker = fatalLocalModelWorkerHarness();

    return Effect.gen(function* () {
      const runtime = yield* LocalModelRuntime;
      const exit = yield* Effect.exit(
        runtime.generate({
          jsonSchema: {type: 'object'},
          manifest: generationManifest,
          maxTokens: 32,
          modelPath: '/models/generation.gguf',
          prompt: 'Generate safe search metadata.',
          seed: 0,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain('GenerationFailed');
        expect(exit.cause.toString()).toContain('worker retry was exhausted');
        expect(anonymousTelemetryDiagnosticFromError(Cause.squash(exit.cause))).toMatchObject({
          domain: 'model-worker',
          errorType: 'GenerationFailed',
          operation: 'generate',
          reason: 'crash',
        });
      }
      expect(fatalWorker.spawnCount()).toBe(2);
    }).pipe(provideTestLayer(runtimeLayer(fatalWorker.spawnWorker)));
  });

  it.effect('kills a crash-banner worker, restarts it, and retries the current request once', () => {
    const processes: FakeWorkerProcess[] = [];
    const spawn: LocalModelWorkerSpawner = () => {
      const worker = new FakeWorkerProcess(request => {
        if (processes.length === 1) {
          worker.stderrFeed.push('panic(main thread): Segmentation fault SECRET_INPUT_MUST_NOT_LEAK\n');
          return;
        }
        worker.respond(
          request,
          request.payload.inputs.map((input: string) => [input.length, 1]),
        );
      });
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const runtime = yield* LocalModelRuntime;
      expect(
        yield* runtime.embedMany({
          inputs: ['alpha'],
          manifest: embeddingManifest,
          modelPath: '/models/embedding.gguf',
        }),
      ).toEqual([[5, 1]]);
      expect(processes).toHaveLength(2);
      expect(processes[0].killed).toBe(true);
      expect(processes[0].writes).toHaveLength(1);
      expect(processes[1].writes).toHaveLength(1);
    }).pipe(provideTestLayer(runtimeLayer(spawn)));
  });

  it.effect('retries one transient worker spawn failure', () => {
    const processes: FakeWorkerProcess[] = [];
    let attempts = 0;
    const spawn: LocalModelWorkerSpawner = () => {
      attempts += 1;
      if (attempts === 1) throw TestError.make({message: 'synthetic spawn failure'});
      const worker = new FakeWorkerProcess(request => {
        worker.respond(
          request,
          request.payload.inputs.map((input: string) => [input.length, 6]),
        );
      });
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const runtime = yield* LocalModelRuntime;
      expect(
        yield* runtime.embedMany({
          inputs: ['spawn'],
          manifest: embeddingManifest,
          modelPath: '/models/embedding.gguf',
        }),
      ).toEqual([[5, 6]]);
      expect(attempts).toBe(2);
      expect(processes).toHaveLength(1);
    }).pipe(provideTestLayer(runtimeLayer(spawn)));
  });

  it.effect(
    'applies the deadline to each attempt, kills both hung workers, and returns a sanitized typed error',
    () => {
      const processes: FakeWorkerProcess[] = [];
      const spawn: LocalModelWorkerSpawner = () => {
        const worker = new FakeWorkerProcess(() => {});
        processes.push(worker);
        return worker;
      };

      return Effect.gen(function* () {
        const runtime = yield* LocalModelRuntime;
        const exit = yield* Effect.exit(
          runtime.embedMany({
            inputs: ['SECRET_INPUT_MUST_NOT_LEAK'],
            manifest: embeddingManifest,
            modelPath: '/models/embedding.gguf',
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(exit.cause.toString()).toContain('EmbeddingFailed');
          expect(exit.cause.toString()).toContain('retry was exhausted');
          expect(exit.cause.toString()).not.toContain('SECRET_INPUT_MUST_NOT_LEAK');
        }
        expect(processes).toHaveLength(2);
        expect(processes.every(worker => worker.killed)).toBe(true);
      }).pipe(provideTestLayer(runtimeLayer(spawn, 10)));
    },
  );

  it.effect('bounds a worker write whose pipe never settles', () => {
    const processes: FakeWorkerProcess[] = [];
    const spawn: LocalModelWorkerSpawner = () => {
      const worker = new FakeWorkerProcess(
        () => {},
        () => new Promise<void>(() => {}),
      );
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const runtime = yield* LocalModelRuntime;
      const exit = yield* Effect.exit(
        runtime.embedMany({
          inputs: ['bounded-write'],
          manifest: embeddingManifest,
          modelPath: '/models/embedding.gguf',
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(processes).toHaveLength(2);
      expect(processes.every(worker => worker.killed)).toBe(true);
    }).pipe(provideTestLayer(runtimeLayer(spawn, 10)));
  });

  it.effect('kills and retries a worker whose protocol line exceeds the response budget', () => {
    const processes: FakeWorkerProcess[] = [];
    const spawn: LocalModelWorkerSpawner = () => {
      const worker = new FakeWorkerProcess(() => {
        worker.stdoutFeed.push('x'.repeat(33));
        worker.stdoutFeed.push('y'.repeat(33));
      });
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const runtime = yield* LocalModelRuntime;
      const exit = yield* Effect.exit(
        runtime.embedMany({
          inputs: ['bounded-response'],
          manifest: embeddingManifest,
          modelPath: '/models/embedding.gguf',
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(processes).toHaveLength(2);
      expect(processes.every(worker => worker.killed)).toBe(true);
    }).pipe(provideTestLayer(runtimeLayer(spawn, 1_000, 64)));
  });

  it.effect('reuses one worker across embedding batches and subsequent calls', () => {
    const processes: FakeWorkerProcess[] = [];
    const spawn: LocalModelWorkerSpawner = (_options: LocalModelWorkerSpawnOptions) => {
      const worker = new FakeWorkerProcess(request => {
        worker.respond(
          request,
          request.payload.inputs.map((input: string) => [input.length, 2]),
        );
      });
      processes.push(worker);
      return Promise.resolve(worker);
    };
    const inputs = Array.from({length: 40}, (_, index) => `input-${index}`);

    return Effect.gen(function* () {
      const runtime = yield* LocalModelRuntime;
      const first = yield* runtime.embedMany({
        embeddingContextPoolSize: 8,
        inputs,
        manifest: embeddingManifest,
        modelPath: '/models/embedding.gguf',
      });
      const second = yield* runtime.embedMany({
        inputs: ['later'],
        manifest: embeddingManifest,
        modelPath: '/models/embedding.gguf',
      });

      expect(first).toHaveLength(40);
      expect(second).toEqual([[5, 2]]);
      expect(processes).toHaveLength(1);
      expect(processes[0].writes.map(request => request.payload.inputs.length)).toEqual([32, 8, 1]);
      expect(processes[0].writes.map(request => request.payload.embeddingContextPoolSize)).toEqual([8, 8, undefined]);
      expect(new Set(processes[0].writes.map(request => request.id)).size).toBe(3);
    }).pipe(provideTestLayer(runtimeLayer(spawn)));
  });

  it.effect('evicts an idle worker and lazily respawns exactly one worker for concurrent requests', () => {
    const processes: FakeWorkerProcess[] = [];
    const spawn: LocalModelWorkerSpawner = () => {
      const generation = processes.length + 1;
      const worker = new FakeWorkerProcess(request => {
        worker.respond(
          request,
          request.payload.inputs.map((input: string) => [input.length, generation]),
        );
      });
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const runtime = yield* LocalModelRuntime;
      expect(
        yield* runtime.embedMany({
          inputs: ['first'],
          manifest: embeddingManifest,
          modelPath: '/models/embedding.gguf',
        }),
      ).toEqual([[5, 1]]);

      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 30)));
      expect(processes).toHaveLength(1);
      expect(processes[0].inputClosed).toBe(true);

      const results = yield* Effect.all(
        ['second', 'third'].map(input =>
          runtime.embedMany({
            inputs: [input],
            manifest: embeddingManifest,
            modelPath: '/models/embedding.gguf',
          }),
        ),
        {concurrency: 'unbounded'},
      );
      expect(results).toEqual([[[6, 2]], [[5, 2]]]);
      expect(processes).toHaveLength(2);
      expect(processes[1].writes).toHaveLength(2);
    }).pipe(provideTestLayer(runtimeLayer(spawn, 1_000, 1_024, 10)));
  });

  it.effect('waits for idle eviction to release native resources before spawning a replacement', () => {
    const processes: FakeWorkerProcess[] = [];
    let releaseEviction = () => {};
    const evictionGate = new Promise<void>(resolve => {
      releaseEviction = resolve;
    });
    const spawn: LocalModelWorkerSpawner = () => {
      const generation = processes.length + 1;
      const worker = new FakeWorkerProcess(
        request => {
          worker.respond(
            request,
            request.payload.inputs.map((input: string) => [input.length, generation]),
          );
        },
        undefined,
        generation === 1 ? () => evictionGate : undefined,
      );
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const runtime = yield* LocalModelRuntime;
      yield* runtime.embedMany({
        inputs: ['first'],
        manifest: embeddingManifest,
        modelPath: '/models/embedding.gguf',
      });
      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 30)));
      expect(processes[0]?.inputClosed).toBe(true);

      const pending = yield* runtime
        .embedMany({
          inputs: ['second'],
          manifest: embeddingManifest,
          modelPath: '/models/embedding.gguf',
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 20)));
      expect(processes).toHaveLength(1);

      releaseEviction();
      expect(yield* Fiber.join(pending)).toEqual([[6, 2]]);
      expect(processes).toHaveLength(2);
    }).pipe(provideTestLayer(runtimeLayer(spawn, 1_000, 1_024, 10)));
  });

  it.effect('serializes concurrent operations through the persistent worker', () => {
    const processes: FakeWorkerProcess[] = [];
    let active = 0;
    let maximumActive = 0;
    const spawn: LocalModelWorkerSpawner = () => {
      const worker = new FakeWorkerProcess(request => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        setTimeout(() => {
          active -= 1;
          worker.respond(
            request,
            request.payload.inputs.map((input: string) => [input.length, 3]),
          );
        }, 5);
      });
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      const runtime = yield* LocalModelRuntime;
      const results = yield* Effect.all(
        ['one', 'three', 'seven'].map(input =>
          runtime.embedMany({
            inputs: [input],
            manifest: embeddingManifest,
            modelPath: '/models/embedding.gguf',
          }),
        ),
        {concurrency: 'unbounded'},
      );
      expect(results).toEqual([[[3, 3]], [[5, 3]], [[5, 3]]]);
      expect(processes).toHaveLength(1);
      expect(maximumActive).toBe(1);
    }).pipe(provideTestLayer(runtimeLayer(spawn)));
  });

  it.effect('gracefully closes the persistent worker when its layer scope ends', () => {
    const processes: FakeWorkerProcess[] = [];
    const spawn: LocalModelWorkerSpawner = () => {
      const worker = new FakeWorkerProcess(request => {
        worker.respond(
          request,
          request.payload.inputs.map((input: string) => [input.length, 4]),
        );
      });
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const runtime = yield* LocalModelRuntime;
        yield* runtime.embedMany({
          inputs: ['scope'],
          manifest: embeddingManifest,
          modelPath: '/models/embedding.gguf',
        });
      }).pipe(provideTestLayer(runtimeLayer(spawn)));

      expect(processes).toHaveLength(1);
      expect(processes[0].inputClosed).toBe(true);
      expect(processes[0].killed).toBe(false);
    });
  });

  it.effect('contains a synchronous broken-pipe error while closing a worker', () => {
    const processes: FakeWorkerProcess[] = [];
    const spawn: LocalModelWorkerSpawner = () => {
      const worker = new FakeWorkerProcess(
        request => {
          worker.respond(
            request,
            request.payload.inputs.map((input: string) => [input.length, 5]),
          );
        },
        undefined,
        () => {
          throw TestError.make({message: 'synthetic broken pipe'});
        },
      );
      processes.push(worker);
      return worker;
    };

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const runtime = yield* LocalModelRuntime;
        yield* runtime.embedMany({
          inputs: ['scope'],
          manifest: embeddingManifest,
          modelPath: '/models/embedding.gguf',
        });
      }).pipe(provideTestLayer(runtimeLayer(spawn)));

      expect(processes).toHaveLength(1);
      expect(processes[0].killed).toBe(true);
    });
  });

  it.effect('serves JSON-lines failures as tags without exposing native errors or request payloads', () =>
    Effect.gen(function* () {
      const input = new AsyncFeed<string | Uint8Array>();
      const output: string[] = [];
      const secret = 'SECRET_NATIVE_DIAGNOSTIC_AND_INPUT';
      input.push(
        `${JSON.stringify({
          id: 'request-1',
          operation: 'embedMany',
          payload: {
            embeddingContextPoolSize: 8,
            inputs: [secret],
            manifest: embeddingManifest,
            modelPath: '/models/embedding.gguf',
          },
          protocol: 1,
        })}\n`,
      );
      input.end();

      yield* serveWorker(
        LocalModelRuntime.of({
          diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
          embedMany: request =>
            Effect.sync(() => expect(request.embeddingContextPoolSize).toBe(8)).pipe(
              Effect.andThen(
                Effect.fail(
                  EmbeddingFailed.make({
                    cause: TestError.make({message: `${secret}:${request.inputs[0]}`}),
                    message: secret,
                    modelId: request.manifest.id,
                  }),
                ),
              ),
            ),
          generate: () => Effect.die(TestError.make({message: 'Unexpected generation request'})),
          rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking request'})),
        }),
        {
          input,
          writeLine: line => {
            output.push(line);
            return Promise.resolve();
          },
        },
      );

      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0])).toEqual({
        error: {tag: 'EmbeddingFailed'},
        id: 'request-1',
        ok: false,
        protocol: 1,
      });
      expect(output[0]).not.toContain(secret);
    }),
  );
});

function runtimeLayer(
  spawnWorker: LocalModelWorkerSpawner,
  requestDeadlineMs = 1_000,
  responseLimitBytes = 1024,
  idleTimeoutMs = 0,
) {
  return isolatedLocalModelRuntimeLayer({
    idleTimeoutMs,
    maxStderrBytes: 128,
    requestDeadlineMs,
    responseLimitBytes,
    spawnWorker,
  }).pipe(Layer.provide(SystemInfo.layer));
}

interface FakeRequest {
  readonly id: string;
  readonly operation: string;
  readonly payload: {
    readonly embeddingContextPoolSize?: 1 | 2 | 4 | 8;
    readonly inputs: readonly string[];
  };
  readonly protocol: number;
}

class FakeWorkerProcess implements LocalModelWorkerProcess {
  readonly stderrFeed = new AsyncFeed<string | Uint8Array>();
  readonly stdoutFeed = new AsyncFeed<string | Uint8Array>();
  readonly stderr = this.stderrFeed;
  readonly stdout = this.stdoutFeed;
  readonly writes: FakeRequest[] = [];
  readonly exited: Promise<number>;
  inputClosed = false;
  killed = false;
  private resolveExit = (_code: number) => {};

  constructor(
    private readonly onWrite: (request: FakeRequest) => void,
    private readonly writeResult?: () => Promise<void>,
    private readonly closeInputResult?: () => Promise<void> | void,
  ) {
    this.exited = new Promise(resolve => {
      this.resolveExit = resolve;
    });
  }

  closeInput(): Promise<void> | void {
    this.inputClosed = true;
    const result = this.closeInputResult?.();
    this.stderrFeed.end();
    this.stdoutFeed.end();
    this.resolveExit(0);
    return result;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.stderrFeed.end();
    this.stdoutFeed.end();
    this.resolveExit(137);
  }

  respond(request: FakeRequest, result: unknown): void {
    this.stdoutFeed.push(
      `${JSON.stringify({
        id: request.id,
        ok: true,
        protocol: request.protocol,
        result,
      })}\n`,
    );
  }

  write(line: string): Promise<void> | void {
    const request = JSON.parse(line) as FakeRequest;
    this.writes.push(request);
    this.onWrite(request);
    return this.writeResult?.();
  }
}

class AsyncFeed<A> implements AsyncIterable<A> {
  private ended = false;
  private readonly queued: A[] = [];
  private readonly waiters: Array<(result: IteratorResult<A>) => void> = [];

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({done: true, value: undefined});
  }

  push(value: A): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({done: false, value});
    else this.queued.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<A> {
    return {
      next: () => {
        const value = this.queued.shift();
        if (value !== undefined) return Promise.resolve({done: false, value});
        if (this.ended) return Promise.resolve({done: true, value: undefined});
        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}
