import {Effect, Layer} from 'effect';
import {fromPromiseInterruptible} from '../errors.js';
import {
  EmbeddingFailed,
  GenerationFailed,
  InferenceInterrupted,
  InsufficientMemory,
  ModelLoadFailed,
  ModelNotInstalled,
  NativeRuntimeUnavailable,
  RerankingFailed,
  InvalidModelOutput,
  UnsupportedNativeRuntime,
} from './errors.js';
import {
  LlamaCppEngine,
  type LlamaCppEngineShape,
  type LlamaEmbeddingSession,
  type LlamaGenerationSession,
  type LlamaRankingSession,
  type LocalModelLoadOptions,
} from './llama-cpp-engine.js';

interface NativeEmbedding {
  readonly vector: readonly number[];
}

interface NativeEmbeddingContext {
  readonly disposed: boolean;
  readonly dispose: () => Promise<void>;
  readonly getEmbeddingFor: (input: string) => Promise<NativeEmbedding>;
}

interface NativeRankingContext {
  readonly disposed: boolean;
  readonly dispose: () => Promise<void>;
  readonly rankAll: (query: string, documents: string[]) => Promise<number[]>;
}

interface NativeModel {
  readonly disposed: boolean;
  readonly dispose: () => Promise<void>;
  readonly createEmbeddingContext: (options: {
    readonly contextSize?: number;
    readonly createSignal: AbortSignal;
    readonly ignoreMemorySafetyChecks: false;
  }) => Promise<NativeEmbeddingContext>;
  readonly createRankingContext: (options: {
    readonly contextSize?: number;
    readonly createSignal: AbortSignal;
    readonly ignoreMemorySafetyChecks: false;
  }) => Promise<NativeRankingContext>;
  readonly createContext?: (options: {
    readonly contextSize?: number;
    readonly createSignal: AbortSignal;
    readonly ignoreMemorySafetyChecks: false;
    readonly sequences: 1;
  }) => Promise<NativeGenerationContext>;
}

interface NativeGenerationContext {
  readonly disposed: boolean;
  readonly dispose: () => Promise<void>;
  readonly getSequence: () => unknown;
}

interface NativeGrammar {
  readonly parse: (json: string) => unknown;
}

interface NativeChatSession {
  readonly dispose: (options?: {readonly disposeSequence?: boolean}) => void;
  readonly disposed: boolean;
  readonly prompt: (
    prompt: string,
    options: {
      readonly grammar: NativeGrammar;
      readonly maxTokens: number;
      readonly seed?: number;
      readonly signal: AbortSignal;
      readonly temperature: 0;
    },
  ) => Promise<string>;
}

interface NativeLlama {
  readonly buildType: 'localBuild' | 'prebuilt';
  readonly cpuMathCores: number;
  readonly disposed: boolean;
  readonly gpu: string | false;
  readonly dispose: () => Promise<void>;
  readonly loadModel: (options: {
    readonly ignoreMemorySafetyChecks: false;
    readonly loadSignal: AbortSignal;
    readonly modelPath: string;
  }) => Promise<NativeModel>;
  readonly createGrammarForJsonSchema?: (schema: Readonly<Record<string, unknown>>) => Promise<NativeGrammar>;
}

interface NodeLlamaCppModule {
  readonly LlamaChatSession?: new (options: {
    readonly contextSequence: unknown;
    readonly systemPrompt?: string;
  }) => NativeChatSession;
  readonly getLlama: (options: {
    readonly build: 'never';
    readonly progressLogs: false;
    readonly skipDownload: true;
    readonly usePrebuiltBinaries: true;
  }) => Promise<NativeLlama>;
}

export interface NodeLlamaCppLayerOptions {
  readonly loadModule?: () => Promise<NodeLlamaCppModule>;
}

const loadInstalledNodeLlamaCpp = async (): Promise<NodeLlamaCppModule> =>
  (await import('node-llama-cpp')) as unknown as NodeLlamaCppModule;

export const nodeLlamaCppEngineLayer = (options: NodeLlamaCppLayerOptions = {}) =>
  Layer.effect(
    LlamaCppEngine,
    Effect.gen(function* () {
      const module = yield* fromPromiseInterruptible(
        () => (options.loadModule ?? loadInstalledNodeLlamaCpp)(),
        cause =>
          new NativeRuntimeUnavailable({
            cause,
            message: `Could not load the node-llama-cpp runtime: ${errorMessage(cause)}`,
          }),
      );
      const llama = yield* Effect.acquireRelease(
        fromPromiseInterruptible(
          () =>
            module.getLlama({
              build: 'never',
              progressLogs: false,
              skipDownload: true,
              usePrebuiltBinaries: true,
            }),
          cause =>
            isNoBinaryFound(cause)
              ? new UnsupportedNativeRuntime({
                  cause,
                  message:
                    'No compatible prebuilt node-llama-cpp binary is available. Threadnote will not compile llama.cpp automatically.',
                })
              : new NativeRuntimeUnavailable({
                  cause,
                  message: `Could not initialize node-llama-cpp: ${errorMessage(cause)}`,
                }),
        ),
        native => disposeIgnoringFailure(native),
      );
      return LlamaCppEngine.of(makeEngine(llama, module));
    }),
  );

function makeEngine(llama: NativeLlama, module: NodeLlamaCppModule): LlamaCppEngineShape {
  return {
    diagnostics: {
      backend: llama.gpu === false ? 'cpu' : llama.gpu,
      buildType: llama.buildType,
      cpuMathCores: llama.cpuMathCores,
    },
    loadEmbeddingSession: options =>
      Effect.gen(function* () {
        const model = yield* acquireModel(llama, options);
        const context = yield* Effect.acquireRelease(
          fromPromiseInterruptible(
            signal =>
              model.createEmbeddingContext({
                contextSize: options.contextSize,
                createSignal: signal,
                ignoreMemorySafetyChecks: false,
              }),
            cause => modelLoadError(options, cause, 'embedding context'),
          ),
          native => disposeIgnoringFailure(native),
        );
        return embeddingSession(options, context);
      }),
    loadGenerationSession: options =>
      Effect.gen(function* () {
        const model = yield* acquireModel(llama, options);
        if (!model.createContext || !llama.createGrammarForJsonSchema || !module.LlamaChatSession) {
          return yield* new ModelLoadFailed({
            cause: new Error('Installed node-llama-cpp runtime does not expose structured generation APIs.'),
            message: `Could not load structured generation for ${options.modelId}.`,
            modelId: options.modelId,
          });
        }
        return generationSession(options, model, llama, module.LlamaChatSession);
      }),
    loadRankingSession: options =>
      Effect.gen(function* () {
        const model = yield* acquireModel(llama, options);
        const context = yield* Effect.acquireRelease(
          fromPromiseInterruptible(
            signal =>
              model.createRankingContext({
                contextSize: options.contextSize,
                createSignal: signal,
                ignoreMemorySafetyChecks: false,
              }),
            cause => modelLoadError(options, cause, 'ranking context'),
          ),
          native => disposeIgnoringFailure(native),
        );
        return rankingSession(options, context);
      }),
  };
}

function generationSession(
  options: LocalModelLoadOptions,
  model: NativeModel,
  llama: NativeLlama,
  ChatSession: NonNullable<NodeLlamaCppModule['LlamaChatSession']>,
): LlamaGenerationSession {
  return {
    generate: request =>
      Effect.scoped(
        Effect.gen(function* () {
          const createContext = model.createContext;
          const createGrammar = llama.createGrammarForJsonSchema;
          if (!createContext || !createGrammar) {
            return yield* new GenerationFailed({
              cause: new Error('Structured generation APIs became unavailable.'),
              message: `Structured generation with ${options.modelId} is unavailable.`,
              modelId: options.modelId,
            });
          }
          const context = yield* Effect.acquireRelease(
            fromPromiseInterruptible(
              signal =>
                createContext({
                  contextSize: options.contextSize,
                  createSignal: signal,
                  ignoreMemorySafetyChecks: false,
                  sequences: 1,
                }),
              cause => modelLoadError(options, cause, 'generation context'),
            ),
            native => disposeIgnoringFailure(native),
          ).pipe(
            Effect.mapError(
              cause =>
                new GenerationFailed({
                  cause,
                  message: `Could not create a generation context for ${options.modelId}.`,
                  modelId: options.modelId,
                }),
            ),
          );
          const grammar = yield* fromPromiseInterruptible(
            () => createGrammar(request.jsonSchema),
            cause =>
              new GenerationFailed({
                cause,
                message: `Could not create JSON grammar for ${options.modelId}.`,
                modelId: options.modelId,
              }),
          );
          const session = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new ChatSession({
                  contextSequence: context.getSequence(),
                  systemPrompt: request.system,
                }),
            ),
            native => Effect.sync(() => native.dispose({disposeSequence: false})),
          );
          const output = yield* fromPromiseInterruptible(
            signal =>
              session.prompt(request.prompt, {
                grammar,
                maxTokens: request.maxTokens,
                seed: request.seed,
                signal,
                temperature: 0,
              }),
            cause =>
              isAbortError(cause)
                ? new InferenceInterrupted({
                    message: `Generation with ${options.modelId} was interrupted.`,
                    modelId: options.modelId,
                    operation: 'generate',
                  })
                : new GenerationFailed({
                    cause,
                    message: `Generation with ${options.modelId} failed: ${errorMessage(cause)}`,
                    modelId: options.modelId,
                  }),
          );
          return yield* Effect.try({
            try: () => grammar.parse(output),
            catch: () =>
              new InvalidModelOutput({
                message: `Generation model ${options.modelId} returned output that did not match its JSON schema.`,
                modelId: options.modelId,
              }),
          });
        }),
      ),
    modelId: options.modelId,
  };
}

function acquireModel(llama: NativeLlama, options: LocalModelLoadOptions) {
  return Effect.acquireRelease(
    fromPromiseInterruptible(
      signal =>
        llama.loadModel({
          ignoreMemorySafetyChecks: false,
          loadSignal: signal,
          modelPath: options.modelPath,
        }),
      cause => modelLoadError(options, cause, 'model'),
    ),
    model => disposeIgnoringFailure(model),
  );
}

function embeddingSession(
  options: LocalModelLoadOptions & {readonly dimensions: number},
  context: NativeEmbeddingContext,
): LlamaEmbeddingSession {
  return {
    dimensions: options.dimensions,
    embedMany: inputs =>
      fromPromiseInterruptible(
        signal => {
          const disposeOnAbort = () => {
            void context.dispose();
          };
          signal.addEventListener('abort', disposeOnAbort, {once: true});
          return Promise.all(inputs.map(input => context.getEmbeddingFor(input))).finally(() => {
            signal.removeEventListener('abort', disposeOnAbort);
          });
        },
        cause =>
          isAbortError(cause)
            ? new InferenceInterrupted({
                message: `Embedding with ${options.modelId} was interrupted.`,
                modelId: options.modelId,
                operation: 'embed',
              })
            : new EmbeddingFailed({
                cause,
                message: `Embedding with ${options.modelId} failed: ${errorMessage(cause)}`,
                modelId: options.modelId,
              }),
      ).pipe(
        Effect.flatMap(embeddings => {
          const vectors = embeddings.map(embedding => embedding.vector);
          const invalid = vectors.find(
            vector => vector.length !== options.dimensions || vector.some(component => !Number.isFinite(component)),
          );
          return invalid
            ? Effect.fail(
                new EmbeddingFailed({
                  cause: invalid,
                  message: `Embedding model ${options.modelId} returned an invalid vector; expected ${options.dimensions} finite dimensions.`,
                  modelId: options.modelId,
                }),
              )
            : Effect.succeed(vectors);
        }),
      ),
    modelId: options.modelId,
  };
}

function rankingSession(options: LocalModelLoadOptions, context: NativeRankingContext): LlamaRankingSession {
  return {
    modelId: options.modelId,
    rank: (query, documents) =>
      fromPromiseInterruptible(
        signal => {
          const disposeOnAbort = () => {
            void context.dispose();
          };
          signal.addEventListener('abort', disposeOnAbort, {once: true});
          return context.rankAll(query, [...documents]).finally(() => {
            signal.removeEventListener('abort', disposeOnAbort);
          });
        },
        cause =>
          isAbortError(cause)
            ? new InferenceInterrupted({
                message: `Reranking with ${options.modelId} was interrupted.`,
                modelId: options.modelId,
                operation: 'rerank',
              })
            : new RerankingFailed({
                cause,
                message: `Reranking with ${options.modelId} failed: ${errorMessage(cause)}`,
                modelId: options.modelId,
              }),
      ).pipe(
        Effect.flatMap(scores =>
          scores.length !== documents.length || scores.some(score => !Number.isFinite(score))
            ? Effect.fail(
                new RerankingFailed({
                  cause: scores,
                  message: `Reranker ${options.modelId} returned ${scores.length} invalid scores for ${documents.length} documents.`,
                  modelId: options.modelId,
                }),
              )
            : Effect.succeed(scores),
        ),
      ),
  };
}

function modelLoadError(options: LocalModelLoadOptions, cause: unknown, resource: string) {
  if (isMissingFile(cause)) {
    return new ModelNotInstalled({
      message: `Model ${options.modelId} is not installed.`,
      modelId: options.modelId,
      path: options.modelPath,
    });
  }
  if (isInsufficientMemory(cause)) {
    return new InsufficientMemory({
      cause,
      message: `There is not enough memory to load the ${resource} for ${options.modelId}.`,
      modelId: options.modelId,
    });
  }
  return new ModelLoadFailed({
    cause,
    message: `Could not load the ${resource} for ${options.modelId}: ${errorMessage(cause)}`,
    modelId: options.modelId,
  });
}

function disposeIgnoringFailure(resource: {readonly disposed: boolean; readonly dispose: () => Promise<void>}) {
  return resource.disposed
    ? Effect.void
    : fromPromiseInterruptible(
        () => resource.dispose(),
        () => undefined,
      ).pipe(Effect.ignore);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function errorName(cause: unknown): string | undefined {
  if (cause instanceof Error) {
    return cause.name && cause.name !== 'Error' ? cause.name : cause.constructor.name;
  }
  return typeof cause === 'object' && cause !== null && 'name' in cause ? String(cause.name) : undefined;
}

function isAbortError(cause: unknown): boolean {
  return errorName(cause) === 'AbortError';
}

function isInsufficientMemory(cause: unknown): boolean {
  return errorName(cause) === 'InsufficientMemoryError';
}

function isMissingFile(cause: unknown): boolean {
  return (
    errorName(cause) === 'ENOENT' ||
    (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT')
  );
}

function isNoBinaryFound(cause: unknown): boolean {
  return errorName(cause) === 'NoBinaryFoundError';
}
