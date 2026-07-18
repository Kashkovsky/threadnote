import {expect, it} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import {describe} from 'vitest';
import {
  AiConsolidator,
  consolidateWithAiEffect,
  EFFECT_AI_API_KEY_ENV,
  EFFECT_AI_API_URL_ENV,
  EFFECT_AI_ENABLED_ENV,
  EFFECT_AI_MODEL_ENV,
  effectAiConfiguration,
} from '../../src/effect/ai-consolidator.js';

describe('Effect AI consolidator', () => {
  it('requires explicit opt-in', () => {
    expect(effectAiConfiguration({[EFFECT_AI_MODEL_ENV]: 'gpt-4.1-mini'})).toBeUndefined();
  });

  it('loads an explicitly enabled OpenAI-compatible provider', () => {
    expect(
      effectAiConfiguration({
        [EFFECT_AI_API_KEY_ENV]: 'test-key',
        [EFFECT_AI_API_URL_ENV]: 'http://localhost:11434/v1',
        [EFFECT_AI_ENABLED_ENV]: 'true',
        [EFFECT_AI_MODEL_ENV]: 'local-model',
      }),
    ).toEqual({apiKey: 'test-key', apiUrl: 'http://localhost:11434/v1', model: 'local-model'});
  });

  it.effect('keeps application code provider-independent', () =>
    consolidateWithAiEffect('combine these memories').pipe(
      Effect.provide(
        Layer.succeed(AiConsolidator, {
          consolidate: prompt => Effect.succeed(`draft:${prompt}`),
        }),
      ),
      Effect.tap(draft => Effect.sync(() => expect(draft).toBe('draft:combine these memories'))),
    ),
  );
});
