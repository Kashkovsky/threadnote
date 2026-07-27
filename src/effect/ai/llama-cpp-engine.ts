import {Context, Effect, Scope} from 'effect';
import type {
  EmbeddingFailed,
  InferenceInterrupted,
  InsufficientMemory,
  ModelLoadFailed,
  ModelNotInstalled,
  NativeRuntimeError,
  GenerationFailed,
  InvalidModelOutput,
  RerankingFailed,
} from './errors.js';

export interface LocalModelLoadOptions {
  readonly contextSize?: number;
  readonly modelId: string;
  readonly modelPath: string;
}

export interface LlamaCppDiagnostics {
  readonly backend: string;
  readonly buildType: 'localBuild' | 'prebuilt';
  readonly cpuMathCores: number;
}

export interface LlamaEmbeddingSession {
  readonly dimensions: number;
  readonly embedMany: (
    inputs: readonly string[],
  ) => Effect.Effect<readonly (readonly number[])[], EmbeddingFailed | InferenceInterrupted>;
  readonly modelId: string;
}

export interface LlamaRankingSession {
  readonly modelId: string;
  readonly rank: (
    query: string,
    documents: readonly string[],
  ) => Effect.Effect<readonly number[], InferenceInterrupted | RerankingFailed>;
}

export interface LlamaStructuredGenerationRequest {
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly maxTokens: number;
  readonly prompt: string;
  readonly seed?: number;
  readonly system?: string;
}

export interface LlamaGenerationSession {
  readonly generate: (
    request: LlamaStructuredGenerationRequest,
  ) => Effect.Effect<unknown, GenerationFailed | InferenceInterrupted | InvalidModelOutput>;
  readonly modelId: string;
}

export type LlamaModelSessionLoadError = InsufficientMemory | ModelLoadFailed | ModelNotInstalled | NativeRuntimeError;

export interface LlamaCppEngineShape {
  readonly diagnostics: LlamaCppDiagnostics;
  readonly loadEmbeddingSession: (
    options: LocalModelLoadOptions & {readonly dimensions: number},
  ) => Effect.Effect<LlamaEmbeddingSession, LlamaModelSessionLoadError, Scope.Scope>;
  readonly loadGenerationSession: (
    options: LocalModelLoadOptions,
  ) => Effect.Effect<LlamaGenerationSession, LlamaModelSessionLoadError, Scope.Scope>;
  readonly loadRankingSession: (
    options: LocalModelLoadOptions,
  ) => Effect.Effect<LlamaRankingSession, LlamaModelSessionLoadError, Scope.Scope>;
}

export class LlamaCppEngine extends Context.Service<LlamaCppEngine, LlamaCppEngineShape>()(
  'threadnote/effect/ai/LlamaCppEngine',
) {}
