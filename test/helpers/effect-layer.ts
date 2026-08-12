import {Effect, Layer} from 'effect';

/**
 * Builds a test layer at the call site and keeps its resources scoped to the
 * returned Effect. This preserves per-example lifecycle and the precedence of
 * nested pipe operators while avoiding application-entrypoint provisioning.
 */
export function provideTestLayer<Services, LayerError, LayerRequirements>(
  layer: Layer.Layer<Services, LayerError, LayerRequirements>,
) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}
