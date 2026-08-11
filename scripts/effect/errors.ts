import {Effect, Layer} from 'effect';

/** Typed failure used at executable-script Effect boundaries. */
export class ScriptError extends Error {
  readonly _tag = 'ScriptError' as const;
}

export function scriptError(cause: unknown, fallback = 'Threadnote script operation failed.'): ScriptError {
  if (cause instanceof ScriptError) return cause;
  return new ScriptError(cause instanceof Error ? cause.message : fallback, {cause});
}

/** Build a script's terminal service graph with one scoped lifetime boundary. */
export function provideScriptLayer<A, E, R, Services, LayerError, LayerRequirements>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<Services, LayerError, LayerRequirements>,
) {
  return Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}
