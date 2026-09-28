import {Layer} from 'effect';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {expireRecallIndexValidation} from './index.js';

export const recallResourceInvalidationLayer = Layer.succeed(
  ResourceRecallInvalidation,
  ResourceRecallInvalidation.of({
    expire: (home, includeInactive, invalidatedUris, canonicalMutationGeneration) =>
      expireRecallIndexValidation(home, includeInactive, invalidatedUris, canonicalMutationGeneration),
  }),
);
