import {expect, it} from '@effect/vitest';
import {Effect, Exit, Fiber, Layer} from 'effect';
import * as EmbeddingModel from 'effect/unstable/ai/EmbeddingModel';
import {describe} from 'vitest';
import {llamaEmbeddingModelLayer} from '../../src/effect/ai/embedding.js';
import {InferenceInterrupted} from '../../src/effect/ai/errors.js';
import {LlamaCppEngine} from '../../src/effect/ai/llama-cpp-engine.js';
import {nodeLlamaCppEngineLayer, resolveNativeEmbeddingGpuLayers} from '../../src/effect/ai/node-llama-cpp.js';
import {llamaStructuredGeneratorLayer, StructuredGenerator} from '../../src/effect/ai/structured-generator.js';
import {localModelRuntimeLayer, LocalModelRuntime} from '../../src/effect/ai/local-model-runtime.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';

describe('Effect AI native harness', () => {
  it('limits the built-in embedding model to zero GPU layers only on Darwin arm64', () => {
    const embedding = BUILTIN_MODEL_MANIFESTS.find(candidate => candidate.role === 'embedding')!;
    const modelDarwinArm64GpuLayers =
      'darwinArm64EmbeddingGpuLayers' in embedding.runtime
        ? embedding.runtime.darwinArm64EmbeddingGpuLayers
        : undefined;
    expect(modelDarwinArm64GpuLayers).toBe(0);
    expect(
      resolveNativeEmbeddingGpuLayers({
        architecture: 'arm64',
        modelDarwinArm64GpuLayers,
        platform: 'darwin',
      }),
    ).toBe(0);
    expect(
      resolveNativeEmbeddingGpuLayers({
        architecture: 'x64',
        modelDarwinArm64GpuLayers,
        platform: 'darwin',
      }),
    ).toBeUndefined();
    expect(
      resolveNativeEmbeddingGpuLayers({
        architecture: 'arm64',
        modelDarwinArm64GpuLayers,
        platform: 'linux',
      }),
    ).toBeUndefined();
  });

  it.effect('adapts ordered batches without loading a native module', () =>
    Effect.gen(function* () {
      const batches: string[][] = [];
      const engine = Layer.succeed(
        LlamaCppEngine,
        LlamaCppEngine.of({
          diagnostics: {backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4},
          loadEmbeddingSession: options =>
            Effect.succeed({
              dimensions: options.dimensions,
              embedMany: inputs =>
                Effect.sync(() => {
                  batches.push([...inputs]);
                  return inputs.map((input, index) => [input.length, index]);
                }),
              modelId: options.modelId,
            }),
          loadGenerationSession: () => Effect.die(new Error('Unexpected generation model load')),
          loadRankingSession: () => Effect.die(new Error('Unexpected ranking model load')),
        }),
      );
      const result = yield* Effect.gen(function* () {
        const embedding = yield* EmbeddingModel.EmbeddingModel;
        return yield* embedding.embedMany(['alpha', 'b']);
      }).pipe(
        Effect.provide(
          llamaEmbeddingModelLayer({
            dimensions: 2,
            modelId: 'fake-embedding',
            modelPath: '/models/fake.gguf',
          }).pipe(Layer.provide(engine)),
        ),
      );
      expect(result.embeddings.map(item => item.vector)).toEqual([
        [5, 0],
        [1, 1],
      ]);
      expect(batches).toEqual([['alpha', 'b']]);
    }),
  );

  it.effect('batches concurrent single-input calls through Effect EmbeddingModel', () =>
    Effect.gen(function* () {
      const batches: string[][] = [];
      const engine = Layer.succeed(
        LlamaCppEngine,
        LlamaCppEngine.of({
          diagnostics: {backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4},
          loadEmbeddingSession: options =>
            Effect.succeed({
              dimensions: options.dimensions,
              embedMany: inputs =>
                Effect.sync(() => {
                  batches.push([...inputs]);
                  return inputs.map(input => [input.length]);
                }),
              modelId: options.modelId,
            }),
          loadGenerationSession: () => Effect.die(new Error('Unexpected generation model load')),
          loadRankingSession: () => Effect.die(new Error('Unexpected ranking model load')),
        }),
      );
      const result = yield* Effect.gen(function* () {
        const embedding = yield* EmbeddingModel.EmbeddingModel;
        return yield* Effect.all([embedding.embed('one'), embedding.embed('three')], {
          batching: true,
          concurrency: 'unbounded',
        });
      }).pipe(
        Effect.provide(
          llamaEmbeddingModelLayer({
            dimensions: 1,
            modelId: 'fake-embedding',
            modelPath: '/models/fake.gguf',
          }).pipe(Layer.provide(engine)),
        ),
      );
      expect(result.map(item => item.vector)).toEqual([[3], [5]]);
      expect(batches).toEqual([['one', 'three']]);
    }),
  );

  it.effect('enforces prebuilt-only initialization and native disposal order', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const calls: unknown[] = [];
      const embeddingContextCalls: unknown[] = [];
      const modelLoadCalls: unknown[] = [];
      const layer = nodeLlamaCppEngineLayer({
        embeddingGpuLayers: 0,
        loadModule: () =>
          Promise.resolve({
            getLlama: options => {
              calls.push(options);
              return Promise.resolve({
                buildType: 'prebuilt' as const,
                cpuMathCores: 8,
                disposed: false,
                dispose: () => {
                  events.push('llama:dispose');
                  return Promise.resolve();
                },
                gpu: 'metal',
                loadModel: options => {
                  modelLoadCalls.push(options);
                  return Promise.resolve({
                    createEmbeddingContext: options => {
                      embeddingContextCalls.push(options);
                      return Promise.resolve({
                        disposed: false,
                        dispose: () => {
                          events.push('context:dispose');
                          return Promise.resolve();
                        },
                        getEmbeddingFor: (input: string) => Promise.resolve({vector: [input.length, 1]}),
                      });
                    },
                    createRankingContext: () => Promise.reject(new Error('Unexpected ranking context')),
                    detokenize: (tokens: readonly number[]) => String.fromCodePoint(...tokens),
                    disposed: false,
                    dispose: () => {
                      events.push('model:dispose');
                      return Promise.resolve();
                    },
                    tokenize: (text: string) => [...text].map(character => character.codePointAt(0)!),
                  });
                },
              });
            },
          }),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* LlamaCppEngine;
          expect(engine.diagnostics).toEqual({backend: 'metal', buildType: 'prebuilt', cpuMathCores: 8});
          const session = yield* engine.loadEmbeddingSession({
            dimensions: 2,
            modelId: 'fake',
            modelPath: '/models/fake.gguf',
          });
          expect(yield* session.embedMany(['abc'])).toEqual([[3, 1]]);
        }),
      ).pipe(Effect.provide(layer));

      expect(calls).toEqual([
        {
          build: 'never',
          debug: false,
          logger: expect.any(Function),
          logLevel: 'disabled',
          progressLogs: false,
          skipDownload: true,
          usePrebuiltBinaries: true,
        },
      ]);
      const nativeLogger = (calls[0] as {readonly logger: (level: string, message: string) => void}).logger;
      expect(nativeLogger('error', '[node-llama-cpp] load warning')).toBeUndefined();
      expect(modelLoadCalls).toEqual([
        {
          gpuLayers: 0,
          ignoreMemorySafetyChecks: false,
          loadSignal: expect.any(AbortSignal),
          modelPath: '/models/fake.gguf',
        },
      ]);
      expect(embeddingContextCalls).toEqual([
        {
          contextSize: undefined,
          createSignal: expect.any(AbortSignal),
          ignoreMemorySafetyChecks: false,
        },
      ]);
      expect(events).toEqual(['context:dispose', 'model:dispose', 'llama:dispose']);
    }),
  );

  it.effect('tokenizes and pools overlong embedding inputs within the model context', () =>
    Effect.gen(function* () {
      const embeddedWindows: string[] = [];
      let activeEmbeddings = 0;
      let maximumActiveEmbeddings = 0;
      const input = String.fromCodePoint(...Array.from({length: 80}, (_, index) => 33 + index));
      const layer = nodeLlamaCppEngineLayer({
        loadModule: () =>
          Promise.resolve({
            getLlama: () =>
              Promise.resolve({
                buildType: 'prebuilt' as const,
                cpuMathCores: 8,
                disposed: false,
                dispose: () => Promise.resolve(),
                gpu: false as const,
                loadModel: () =>
                  Promise.resolve({
                    createEmbeddingContext: () =>
                      Promise.resolve({
                        disposed: false,
                        dispose: () => Promise.resolve(),
                        getEmbeddingFor: async (input: string) => {
                          activeEmbeddings += 1;
                          maximumActiveEmbeddings = Math.max(maximumActiveEmbeddings, activeEmbeddings);
                          embeddedWindows.push(input);
                          const index = embeddedWindows.length - 1;
                          await Promise.resolve();
                          activeEmbeddings -= 1;
                          return {vector: [index + 1, 6 - index]};
                        },
                      }),
                    createRankingContext: () => Promise.reject(new Error('Unexpected ranking context')),
                    detokenize: (tokens: readonly number[]) => String.fromCodePoint(...tokens),
                    disposed: false,
                    dispose: () => Promise.resolve(),
                    tokenize: (text: string) => [...text].map(character => character.codePointAt(0)!),
                  }),
              }),
          }),
      });

      const vector = yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* LlamaCppEngine;
          const session = yield* engine.loadEmbeddingSession({
            contextSize: 32,
            dimensions: 2,
            modelId: 'fake',
            modelPath: '/models/fake.gguf',
          });
          return (yield* session.embedMany([input, 'tail']))[0];
        }),
      ).pipe(Effect.provide(layer));

      expect(embeddedWindows).toEqual([
        input.slice(0, 16),
        input.slice(14, 30),
        input.slice(28, 44),
        input.slice(42, 58),
        input.slice(56, 72),
        input.slice(70, 80),
        'tail',
      ]);
      expect(maximumActiveEmbeddings).toBe(1);
      const magnitude = Math.sqrt(300 ** 2 + 330 ** 2);
      expect(vector?.[0]).toBeCloseTo(300 / magnitude, 10);
      expect(vector?.[1]).toBeCloseTo(330 / magnitude, 10);
    }),
  );

  it.effect('generates JSON-schema output and disposes chat resources before the model runtime', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      class FakeChatSession {
        readonly disposed = false;
        constructor(
          readonly options: {
            readonly contextSequence: unknown;
            readonly systemPrompt?: string;
          },
        ) {}
        dispose() {
          events.push('chat:dispose');
        }
        prompt(_prompt: string) {
          return Promise.resolve('{"answer":"native"}');
        }
      }
      const nativeModel = {
        createContext() {
          if (this !== nativeModel) return Promise.reject(new Error('createContext was called without its model'));
          return Promise.resolve({
            disposed: false,
            dispose: () => {
              events.push('context:dispose');
              return Promise.resolve();
            },
            getSequence: () => ({id: 1}),
          });
        },
        createEmbeddingContext: () => Promise.reject(new Error('Unexpected embedding context')),
        createRankingContext: () => Promise.reject(new Error('Unexpected ranking context')),
        detokenize: (tokens: readonly number[]) => String.fromCodePoint(...tokens),
        disposed: false,
        dispose: () => {
          events.push('model:dispose');
          return Promise.resolve();
        },
        tokenize: (text: string) => [...text].map(character => character.codePointAt(0)!),
      };
      const nativeLlama = {
        buildType: 'prebuilt' as const,
        cpuMathCores: 4,
        createGrammarForJsonSchema(schema: Readonly<Record<string, unknown>>) {
          if (this !== nativeLlama) {
            return Promise.reject(new Error('createGrammarForJsonSchema was called without its llama runtime'));
          }
          expect(schema).toMatchObject({type: 'object'});
          return Promise.resolve({parse: (json: string) => JSON.parse(json) as unknown});
        },
        disposed: false,
        dispose: () => {
          events.push('llama:dispose');
          return Promise.resolve();
        },
        gpu: false as const,
        loadModel: () => Promise.resolve(nativeModel),
      };
      const engineLayer = nodeLlamaCppEngineLayer({
        loadModule: () =>
          Promise.resolve({
            LlamaChatSession: FakeChatSession,
            getLlama: () => Promise.resolve(nativeLlama),
          }),
      });
      const generatorLayer = llamaStructuredGeneratorLayer({
        contextSize: 512,
        modelId: 'fake-generation',
        modelPath: '/models/fake.gguf',
      }).pipe(Layer.provide(engineLayer));

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const generator = yield* StructuredGenerator;
          return yield* generator.generate({
            jsonSchema: {
              additionalProperties: false,
              properties: {answer: {type: 'string'}},
              required: ['answer'],
              type: 'object',
            },
            maxTokens: 32,
            prompt: 'Return JSON.',
            seed: 0,
            system: 'Be exact.',
          });
        }),
      ).pipe(Effect.provide(generatorLayer));

      expect(result).toEqual({answer: 'native'});
      expect(events).toEqual(['chat:dispose', 'context:dispose', 'model:dispose', 'llama:dispose']);
    }),
  );

  it.effect('returns an actionable typed error when no prebuilt exists', () =>
    Effect.gen(function* () {
      class NoBinaryFoundError extends Error {
        override readonly name = 'NoBinaryFoundError';
      }
      const exit = yield* LlamaCppEngine.pipe(
        Effect.provide(
          nodeLlamaCppEngineLayer({
            loadModule: () =>
              Promise.resolve({
                getLlama: () => Promise.reject(new NoBinaryFoundError('unsupported fixture')),
              }),
          }),
        ),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain('UnsupportedNativeRuntime');
        expect(exit.cause.toString()).toContain('will not compile llama.cpp automatically');
      }
    }),
  );

  it.effect('keeps retrieval sessions warm and releases heavyweight generation sessions after each request', () => {
    const loads = {embedding: 0, generation: 0, reranker: 0};
    const embeddingLoadOptions: unknown[] = [];
    let releasedGenerationSessions = 0;
    const engine = Layer.succeed(
      LlamaCppEngine,
      LlamaCppEngine.of({
        diagnostics: {backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4},
        loadEmbeddingSession: options =>
          Effect.sync(() => {
            loads.embedding += 1;
            embeddingLoadOptions.push(options);
            return {
              dimensions: options.dimensions,
              embedMany: inputs => Effect.succeed(inputs.map(input => Array(options.dimensions).fill(input.length))),
              modelId: options.modelId,
            };
          }),
        loadGenerationSession: options =>
          Effect.acquireRelease(
            Effect.sync(() => {
              loads.generation += 1;
              return {
                generate: request => Effect.succeed({model: options.modelId, prompt: request.prompt}),
                modelId: options.modelId,
              };
            }),
            () => Effect.sync(() => (releasedGenerationSessions += 1)),
          ),
        loadRankingSession: options =>
          Effect.sync(() => {
            loads.reranker += 1;
            return {
              modelId: options.modelId,
              rank: (_query, documents) => Effect.succeed(documents.map((_, index) => index / 10)),
            };
          }),
      }),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const embedding = BUILTIN_MODEL_MANIFESTS.find(candidate => candidate.role === 'embedding')!;
        const generation = BUILTIN_MODEL_MANIFESTS.find(candidate => candidate.role === 'generation')!;
        const reranker = BUILTIN_MODEL_MANIFESTS.find(candidate => candidate.role === 'reranker')!;

        const runtime = yield* LocalModelRuntime;
        for (let index = 0; index < 2; index += 1) {
          yield* runtime.embedMany({inputs: ['alpha'], manifest: embedding, modelPath: '/models/embed.gguf'});
          yield* runtime.rerank({
            documents: ['one', 'two'],
            manifest: reranker,
            modelPath: '/models/rerank.gguf',
            query: 'query',
          });
          yield* runtime.generate({
            jsonSchema: {type: 'object'},
            manifest: generation,
            maxTokens: 16,
            modelPath: '/models/generate.gguf',
            prompt: 'return json',
          });
        }
        expect(loads).toEqual({embedding: 1, generation: 2, reranker: 1});
        expect(embeddingLoadOptions).toEqual([
          expect.objectContaining({darwinArm64EmbeddingGpuLayers: 0, modelId: embedding.id}),
        ]);
        expect(releasedGenerationSessions).toBe(2);
      }).pipe(Effect.provide(localModelRuntimeLayer(engine))),
    );
  });

  it.effect('evicts interrupted embedding and reranking sessions before the next request', () => {
    const loads = {embedding: 0, reranker: 0};
    const engine = Layer.succeed(
      LlamaCppEngine,
      LlamaCppEngine.of({
        diagnostics: {backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4},
        loadEmbeddingSession: options =>
          Effect.sync(() => {
            loads.embedding += 1;
            const interrupted = loads.embedding === 1;
            return {
              dimensions: options.dimensions,
              embedMany: inputs =>
                interrupted
                  ? Effect.fail(
                      new InferenceInterrupted({
                        message: 'embedding interrupted',
                        modelId: options.modelId,
                        operation: 'embedding',
                      }),
                    )
                  : Effect.succeed(inputs.map(input => Array(options.dimensions).fill(input.length))),
              modelId: options.modelId,
            };
          }),
        loadGenerationSession: () => Effect.die(new Error('Unexpected generation model load')),
        loadRankingSession: options =>
          Effect.sync(() => {
            loads.reranker += 1;
            const interrupted = loads.reranker === 1;
            return {
              modelId: options.modelId,
              rank: (_query: string, documents: readonly string[]) =>
                interrupted
                  ? Effect.fail(
                      new InferenceInterrupted({
                        message: 'reranking interrupted',
                        modelId: options.modelId,
                        operation: 'reranking',
                      }),
                    )
                  : Effect.succeed(documents.map((_, index) => index / 10)),
            };
          }),
      }),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const embedding = BUILTIN_MODEL_MANIFESTS.find(candidate => candidate.role === 'embedding')!;
        const reranker = BUILTIN_MODEL_MANIFESTS.find(candidate => candidate.role === 'reranker')!;
        const runtime = yield* LocalModelRuntime;

        expect(
          Exit.isFailure(
            yield* Effect.exit(
              runtime.embedMany({inputs: ['alpha'], manifest: embedding, modelPath: '/models/embed.gguf'}),
            ),
          ),
        ).toBe(true);
        expect(
          yield* runtime.embedMany({inputs: ['alpha'], manifest: embedding, modelPath: '/models/embed.gguf'}),
        ).toHaveLength(1);

        expect(
          Exit.isFailure(
            yield* Effect.exit(
              runtime.rerank({
                documents: ['one', 'two'],
                manifest: reranker,
                modelPath: '/models/rerank.gguf',
                query: 'query',
              }),
            ),
          ),
        ).toBe(true);
        expect(
          yield* runtime.rerank({
            documents: ['one', 'two'],
            manifest: reranker,
            modelPath: '/models/rerank.gguf',
            query: 'query',
          }),
        ).toEqual([0, 0.1]);
        expect(loads).toEqual({embedding: 2, reranker: 2});
      }).pipe(Effect.provide(localModelRuntimeLayer(engine))),
    );
  });

  it.effect('releases a generation session when the request is interrupted', () => {
    let loaded = false;
    let releases = 0;
    const engine = Layer.succeed(
      LlamaCppEngine,
      LlamaCppEngine.of({
        diagnostics: {backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4},
        loadEmbeddingSession: () => Effect.die(new Error('Unexpected embedding model load')),
        loadGenerationSession: options =>
          Effect.acquireRelease(
            Effect.sync(() => {
              loaded = true;
              return {
                generate: () => Effect.never,
                modelId: options.modelId,
              };
            }),
            () => Effect.sync(() => (releases += 1)),
          ),
        loadRankingSession: () => Effect.die(new Error('Unexpected reranker model load')),
      }),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const generation = BUILTIN_MODEL_MANIFESTS.find(candidate => candidate.role === 'generation')!;
        const runtime = yield* LocalModelRuntime;
        const fiber = yield* Effect.forkChild(
          runtime.generate({
            jsonSchema: {type: 'object'},
            manifest: generation,
            maxTokens: 16,
            modelPath: '/models/generate.gguf',
            prompt: 'return json',
          }),
        );
        while (!loaded) yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        expect(releases).toBe(1);
      }).pipe(Effect.provide(localModelRuntimeLayer(engine))),
    );
  });
});
