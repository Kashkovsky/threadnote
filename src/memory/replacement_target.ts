import {Effect} from 'effect';
import {uriSegment} from '../manifest.js';
import {resolveMemoryReplacementTarget} from '../recall/memory_identity.js';
import type {RuntimeConfig} from '../types.js';
import {parseMemoryDocument} from './document.js';
import {localMemoryPathForUri, readTextIfExists} from './migrations.js';
import type {StoreMemoryOptions} from './store_contract.js';

export const resolveLocalMemoryReplacementTarget = Effect.fn('memory.resolveLocalReplacement')(function* (
  config: RuntimeConfig,
  requestedUri: string,
) {
  const target = yield* resolveMemoryReplacementTarget(
    config,
    requestedUri,
    [`threadnote://user/${uriSegment(config.user)}/memories`],
    uri =>
      Effect.gen(function* () {
        const path = yield* localMemoryPathForUri(config, uri);
        if (!path) return [];
        const content = yield* readTextIfExists(path);
        const record = content ? parseMemoryDocument(uri, content) : undefined;
        return record ? [record] : [];
      }),
  );
  return {...target, memoryId: target.record?.metadata.memoryId ?? target.expectedMemoryId};
});

export const resolveStoreMemoryReplacementOptions = Effect.fn('memory.resolveStoreReplacement')(function* (
  config: RuntimeConfig,
  options: StoreMemoryOptions,
) {
  if (!options.replaceUri) return options;
  const replacement = yield* resolveLocalMemoryReplacementTarget(config, options.replaceUri);
  const memoryId = options.expectedReplaceMemoryId ?? replacement.memoryId ?? options.metadata.memoryId;
  return {
    ...options,
    expectedReplaceContent: options.expectedReplaceContent ?? replacement.record?.content,
    expectedReplaceMemoryId: memoryId,
    metadata: memoryId === options.metadata.memoryId ? options.metadata : {...options.metadata, memoryId},
    replaceUri: replacement.canonicalUri,
  } satisfies StoreMemoryOptions;
});
