import {Context, Effect, Layer} from 'effect';
import type {
  GenerationFailed,
  InsufficientMemory,
  InferenceInterrupted,
  InvalidModelOutput,
  ModelLoadFailed,
  ModelNotInstalled,
  NativeRuntimeError,
} from './errors.js';
import {LlamaCppEngine} from './llama-cpp-engine.js';

export interface StructuredGenerationRequest {
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly maxTokens: number;
  readonly prompt: string;
  readonly seed?: number;
  readonly system?: string;
}

export type StructuredGenerationError =
  | GenerationFailed
  | InferenceInterrupted
  | InsufficientMemory
  | InvalidModelOutput
  | ModelLoadFailed
  | ModelNotInstalled
  | NativeRuntimeError;

export interface StructuredGeneratorShape {
  readonly generate: (request: StructuredGenerationRequest) => Effect.Effect<unknown, StructuredGenerationError>;
  readonly modelId: string;
}

export class StructuredGenerator extends Context.Service<StructuredGenerator, StructuredGeneratorShape>()(
  'threadnote/effect/ai/structured-generator/StructuredGenerator',
) {}

export interface LlamaStructuredGeneratorLayerOptions {
  readonly contextSize?: number;
  readonly modelId: string;
  readonly modelPath: string;
}

export const llamaStructuredGeneratorLayer = (options: LlamaStructuredGeneratorLayerOptions) =>
  Layer.effect(
    StructuredGenerator,
    Effect.gen(function* () {
      const engine = yield* LlamaCppEngine;
      const session = yield* engine.loadGenerationSession(options);
      return StructuredGenerator.of({
        generate: session.generate,
        modelId: options.modelId,
      });
    }),
  );
