import {Context, Effect, Layer} from 'effect';
import {LlamaCppEngine} from './llama-cpp-engine.js';
import type {InferenceInterrupted, RerankingFailed} from './errors.js';

export interface RerankerShape {
  readonly modelId: string;
  readonly rank: (
    query: string,
    documents: readonly string[],
  ) => Effect.Effect<readonly number[], InferenceInterrupted | RerankingFailed>;
}

export class Reranker extends Context.Service<Reranker, RerankerShape>()('threadnote/effect/ai/reranker') {}

export interface LlamaRerankerLayerOptions {
  readonly contextSize?: number;
  readonly modelId: string;
  readonly modelPath: string;
  readonly rankingTemplate?: string;
}

export const llamaRerankerLayer = (options: LlamaRerankerLayerOptions) =>
  Layer.effect(
    Reranker,
    Effect.gen(function* () {
      const engine = yield* LlamaCppEngine;
      const session = yield* engine.loadRankingSession(options);
      return Reranker.of({
        modelId: options.modelId,
        rank: session.rank,
      });
    }),
  );
