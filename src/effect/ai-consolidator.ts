import {NodeHttpClient} from '@effect/platform-node';
import {OpenAiClient, OpenAiLanguageModel} from '@effect/ai-openai-compat';
import {Context, Effect, Layer, pipe, Redacted, Schema} from 'effect';
import {LanguageModel} from 'effect/unstable/ai';

export const EFFECT_AI_ENABLED_ENV = 'THREADNOTE_EFFECT_AI';
export const EFFECT_AI_API_KEY_ENV = 'THREADNOTE_EFFECT_AI_API_KEY';
export const EFFECT_AI_API_URL_ENV = 'THREADNOTE_EFFECT_AI_API_URL';
export const EFFECT_AI_MODEL_ENV = 'THREADNOTE_EFFECT_AI_MODEL';

export interface EffectAiConfiguration {
  readonly apiKey?: string;
  readonly apiUrl?: string;
  readonly model: string;
}

export class AiConsolidationFailed extends Schema.TaggedErrorClass<AiConsolidationFailed>()('AiConsolidationFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

const ConsolidationDraft = Schema.Struct({draft: Schema.String});

export class AiConsolidator extends Context.Service<
  AiConsolidator,
  {
    readonly consolidate: (prompt: string) => Effect.Effect<string, AiConsolidationFailed>;
  }
>()('threadnote/effect/AiConsolidator') {}

export const consolidateWithAiEffect = Effect.fn('AiConsolidator.consolidate')(function* (prompt: string) {
  const consolidator = yield* AiConsolidator;
  return yield* consolidator.consolidate(prompt);
});

export function effectAiConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EffectAiConfiguration | undefined {
  if (!['1', 'true', 'yes'].includes(env[EFFECT_AI_ENABLED_ENV]?.trim().toLowerCase() ?? '')) {
    return undefined;
  }
  const model = env[EFFECT_AI_MODEL_ENV]?.trim();
  if (!model) {
    return undefined;
  }
  const apiKey = env[EFFECT_AI_API_KEY_ENV]?.trim();
  const apiUrl = env[EFFECT_AI_API_URL_ENV]?.trim();
  return {
    apiKey: apiKey || undefined,
    apiUrl: apiUrl || undefined,
    model,
  };
}

export function aiConsolidatorLayer(config: EffectAiConfiguration): Layer.Layer<AiConsolidator> {
  const clientLayer = OpenAiClient.layer({
    apiKey: config.apiKey ? Redacted.make(config.apiKey) : undefined,
    apiUrl: config.apiUrl,
  }).pipe(Layer.provide(NodeHttpClient.layerFetch));
  const languageModelLayer = OpenAiLanguageModel.layer({
    config: {max_output_tokens: 4000, strictJsonSchema: true},
    model: config.model,
  }).pipe(Layer.provide(clientLayer));

  return Layer.effect(
    AiConsolidator,
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel;
      return AiConsolidator.of({
        consolidate: prompt =>
          model
            .generateObject({
              objectName: 'threadnote_consolidation',
              prompt,
              schema: ConsolidationDraft,
            })
            .pipe(
              Effect.map(response => response.value.draft.trim()),
              Effect.filterOrFail(
                draft => draft.length > 0,
                () =>
                  new AiConsolidationFailed({
                    cause: new Error('The model returned an empty consolidation draft.'),
                    message: 'Effect AI returned an empty consolidation draft.',
                  }),
              ),
              Effect.mapError(cause =>
                cause instanceof AiConsolidationFailed
                  ? cause
                  : new AiConsolidationFailed({cause, message: 'Effect AI consolidation failed.'}),
              ),
            ),
      });
    }),
  ).pipe(Layer.provide(languageModelLayer));
}

export function runEffectAiConsolidation(prompt: string, config: EffectAiConfiguration) {
  return pipe(consolidateWithAiEffect(prompt), Effect.provide(aiConsolidatorLayer(config)));
}
