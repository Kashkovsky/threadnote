import {Effect, Layer} from 'effect';
import * as AiError from 'effect/unstable/ai/AiError';
import * as EmbeddingModel from 'effect/unstable/ai/EmbeddingModel';
import {LlamaCppEngine} from './llama-cpp-engine.js';

export interface LlamaEmbeddingLayerOptions {
  readonly contextSize?: number;
  readonly darwinArm64EmbeddingGpuLayers?: number;
  readonly dimensions: number;
  readonly modelId: string;
  readonly modelPath: string;
}

export const llamaEmbeddingModelLayer = (options: LlamaEmbeddingLayerOptions) => {
  const model = Layer.effect(
    EmbeddingModel.EmbeddingModel,
    Effect.gen(function* () {
      const engine = yield* LlamaCppEngine;
      const session = yield* engine.loadEmbeddingSession(options);
      return yield* EmbeddingModel.make({
        embedMany: ({inputs}) =>
          session.embedMany(inputs).pipe(
            Effect.map(results => ({
              results: results.map(vector => [...vector]),
              usage: {inputTokens: undefined},
            })),
            Effect.mapError(error =>
              AiError.make({
                method: 'embedMany',
                module: 'ThreadnoteNodeLlamaCpp',
                reason: new AiError.InternalProviderError({description: error.message}),
              }),
            ),
          ),
      });
    }),
  );
  return Layer.merge(model, Layer.succeed(EmbeddingModel.Dimensions, options.dimensions));
};
