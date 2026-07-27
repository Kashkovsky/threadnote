import {Context, Effect, Exit, Layer, Scope, Semaphore} from 'effect';
import * as AiError from 'effect/unstable/ai/AiError';
import * as EmbeddingModel from 'effect/unstable/ai/EmbeddingModel';
import type {LocalModelManifest} from '../../models/catalog.js';
import type {LlamaCppEngine} from './llama-cpp-engine.js';
import {llamaEmbeddingModelLayer} from './embedding.js';
import {nodeLlamaCppEngineLayer} from './node-llama-cpp.js';
import {llamaRerankerLayer, Reranker, type RerankerShape} from './reranker.js';
import {
  llamaStructuredGeneratorLayer,
  StructuredGenerator,
  type StructuredGenerationError,
  type StructuredGenerationRequest,
  type StructuredGeneratorShape,
} from './structured-generator.js';
import type {InferenceInterrupted, ModelSessionError, NativeRuntimeError, RerankingFailed} from './errors.js';

const EMBEDDING_BATCH_SIZE = 32;

export interface LocalEmbeddingRequest {
  readonly inputs: readonly string[];
  readonly manifest: LocalModelManifest;
  readonly modelPath: string;
}

export type LocalEmbeddingError = AiError.AiError | ModelSessionError;

export interface LocalRerankingRequest {
  readonly documents: readonly string[];
  readonly manifest: LocalModelManifest;
  readonly modelPath: string;
  readonly query: string;
}

export interface LocalGenerationRequest extends StructuredGenerationRequest {
  readonly manifest: LocalModelManifest;
  readonly modelPath: string;
}

export interface LocalModelRuntimeShape {
  readonly embedMany: (
    request: LocalEmbeddingRequest,
  ) => Effect.Effect<readonly (readonly number[])[], LocalEmbeddingError>;
  readonly generate: (request: LocalGenerationRequest) => Effect.Effect<unknown, StructuredGenerationError>;
  readonly rerank: (
    request: LocalRerankingRequest,
  ) => Effect.Effect<readonly number[], InferenceInterrupted | RerankingFailed | ModelSessionError>;
}

/**
 * Threadnote-owned inference port. Domain code depends on this service, never
 * Effect AI or node-llama-cpp directly. Tests can replace it with a pure Layer.
 */
export class LocalModelRuntime extends Context.Service<LocalModelRuntime, LocalModelRuntimeShape>()(
  'threadnote/effect/ai/LocalModelRuntime',
) {
  static readonly nativeLayer = localModelRuntimeLayer();
}

export function localModelRuntimeLayer(
  engineLayer: Layer.Layer<LlamaCppEngine, NativeRuntimeError> = nodeLlamaCppEngineLayer(),
) {
  return Layer.fromBuild((_memoMap, scope) =>
    Effect.gen(function* () {
      const inferencePermits = yield* Semaphore.make(1);
      const engineContext: Effect.Effect<Context.Context<LlamaCppEngine>, NativeRuntimeError> = yield* Effect.cached(
        Layer.buildWithScope(engineLayer, scope),
      );
      const embeddingModels = new Map<string, Effect.Effect<EmbeddingModel.Service, LocalEmbeddingError>>();
      const rerankers = new Map<
        string,
        Effect.Effect<RerankerShape, InferenceInterrupted | RerankingFailed | ModelSessionError>
      >();
      const generators = new Map<string, Effect.Effect<StructuredGeneratorShape, StructuredGenerationError>>();
      return Context.make(LocalModelRuntime, {
        embedMany: request =>
          inferencePermits.withPermit(embedManyNative(request, scope, engineContext, embeddingModels)),
        generate: request => inferencePermits.withPermit(generateNative(request, scope, engineContext, generators)),
        rerank: request => inferencePermits.withPermit(rerankNative(request, scope, engineContext, rerankers)),
      });
    }),
  );
}

function embedManyNative(
  request: LocalEmbeddingRequest,
  scope: Scope.Scope,
  engineContext: Effect.Effect<Context.Context<LlamaCppEngine>, NativeRuntimeError>,
  models: Map<string, Effect.Effect<EmbeddingModel.Service, LocalEmbeddingError>>,
) {
  const dimensions = request.manifest.dimensions;
  if (!dimensions) {
    return Effect.die(new Error(`Embedding dimensions are missing for ${request.manifest.id}.`));
  }
  const key = modelCacheKey(request);
  return Effect.gen(function* () {
    let model = models.get(key);
    if (!model) {
      model = yield* Effect.cached(
        Effect.gen(function* () {
          const engine = yield* engineContext;
          const services = yield* Layer.buildWithScope(
            llamaEmbeddingModelLayer({
              contextSize: request.manifest.contextLimit,
              dimensions,
              modelId: request.manifest.id,
              modelPath: request.modelPath,
            }),
            scope,
          ).pipe(Effect.provide(engine));
          return Context.get(services, EmbeddingModel.EmbeddingModel);
        }),
      );
      models.set(key, model);
    }
    const embedding = yield* model;
    const vectors: number[][] = [];
    for (let start = 0; start < request.inputs.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = yield* embedding.embedMany(request.inputs.slice(start, start + EMBEDDING_BATCH_SIZE));
      vectors.push(...batch.embeddings.map(item => [...item.vector]));
    }
    return vectors;
  }).pipe(Effect.onExit(exit => (Exit.isFailure(exit) ? Effect.sync(() => models.delete(key)) : Effect.void)));
}

function rerankNative(
  request: LocalRerankingRequest,
  scope: Scope.Scope,
  engineContext: Effect.Effect<Context.Context<LlamaCppEngine>, NativeRuntimeError>,
  models: Map<string, Effect.Effect<RerankerShape, InferenceInterrupted | RerankingFailed | ModelSessionError>>,
) {
  if (request.manifest.role !== 'reranker') {
    return Effect.die(new Error(`Model ${request.manifest.id} is not a reranker.`));
  }
  const key = modelCacheKey(request);
  return Effect.gen(function* () {
    let model = models.get(key);
    if (!model) {
      model = yield* Effect.cached(
        Effect.gen(function* () {
          const engine = yield* engineContext;
          const services = yield* Layer.buildWithScope(
            llamaRerankerLayer({
              contextSize: request.manifest.contextLimit,
              modelId: request.manifest.id,
              modelPath: request.modelPath,
            }),
            scope,
          ).pipe(Effect.provide(engine));
          return Context.get(services, Reranker);
        }),
      );
      models.set(key, model);
    }
    const reranker = yield* model;
    return yield* reranker.rank(request.query, request.documents);
  }).pipe(Effect.onExit(exit => (Exit.isFailure(exit) ? Effect.sync(() => models.delete(key)) : Effect.void)));
}

function generateNative(
  request: LocalGenerationRequest,
  scope: Scope.Scope,
  engineContext: Effect.Effect<Context.Context<LlamaCppEngine>, NativeRuntimeError>,
  models: Map<string, Effect.Effect<StructuredGeneratorShape, StructuredGenerationError>>,
) {
  if (request.manifest.role !== 'generation') {
    return Effect.die(new Error(`Model ${request.manifest.id} is not a generation model.`));
  }
  const key = modelCacheKey(request);
  return Effect.gen(function* () {
    let model = models.get(key);
    if (!model) {
      model = yield* Effect.cached(
        Effect.gen(function* () {
          const engine = yield* engineContext;
          const services = yield* Layer.buildWithScope(
            llamaStructuredGeneratorLayer({
              contextSize: request.manifest.contextLimit,
              modelId: request.manifest.id,
              modelPath: request.modelPath,
            }),
            scope,
          ).pipe(Effect.provide(engine));
          return Context.get(services, StructuredGenerator);
        }),
      );
      models.set(key, model);
    }
    const generator = yield* model;
    return yield* generator.generate(request);
  });
}

function modelCacheKey(request: {readonly manifest: LocalModelManifest; readonly modelPath: string}): string {
  return `${request.manifest.role}\u0000${request.manifest.id}\u0000${request.manifest.sha256}\u0000${request.modelPath}`;
}
