import {Context, Effect, FileSystem, Path} from 'effect';
import type {CanonicalMutationGenerationTransition} from './mutation_generation.js';
import type {SystemInfo} from '@threadnote/platform/system';

export interface ResourceRecallInvalidationShape {
  readonly expire: (
    home: string,
    includeInactive: boolean,
    invalidatedUris: readonly string[],
    canonicalMutationGeneration: CanonicalMutationGenerationTransition,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path | SystemInfo>;
}

export class ResourceRecallInvalidation extends Context.Service<
  ResourceRecallInvalidation,
  ResourceRecallInvalidationShape
>()('@threadnote/store/resource/recall-invalidation/ResourceRecallInvalidation') {}
