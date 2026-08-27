import {Effect} from 'effect';
import {assertMemoryDocumentSchemaWritable, parseMemoryDocument, type MemoryRecord} from './memory_document.js';
import {
  attemptSync,
  localMemoryPathForUri,
  MemoryOperationError,
  NATIVE_RESOURCE_BACKEND,
  readTextIfExists,
  resourceExists,
} from './memory_migrations.js';
import type {RuntimeConfig} from './types.js';

export const assertPersonalMemoryDestinationWritable = Effect.fn('memory.assertPersonalMemoryDestinationWritable')(
  function* (config: RuntimeConfig, memoryUri: string, replaceUri: string | undefined) {
    if (!(yield* resourceExists(NATIVE_RESOURCE_BACKEND, config, memoryUri))) return undefined;
    const destination = yield* readCanonicalMemory(config, memoryUri);
    if (!destination) {
      return yield* Effect.fail(
        new MemoryOperationError(`Existing destination ${memoryUri} is not a readable canonical memory.`),
      );
    }
    yield* attemptSync(() => assertMemoryDocumentSchemaWritable(destination.content));
    if (!replaceUri) {
      return yield* Effect.fail(
        new MemoryOperationError(
          `Memory ${memoryUri} already exists. Re-run with --replace ${memoryUri} to update it explicitly.`,
        ),
      );
    }
    if (replaceUri !== memoryUri) {
      return yield* Effect.fail(new MemoryOperationError(`Replacement destination already exists: ${memoryUri}.`));
    }
    return destination;
  },
);

export const assertCurrentReplacementWritable = Effect.fn('memory.assertCurrentReplacementWritable')(function* (
  config: RuntimeConfig,
  replaceUri: string,
  expectedContent: string | undefined,
  alreadyRead?: MemoryRecord,
) {
  const current = alreadyRead ?? (yield* readCanonicalMemory(config, replaceUri));
  if (!current) return yield* Effect.fail(new MemoryOperationError(`Memory ${replaceUri} no longer exists.`));
  yield* attemptSync(() => assertMemoryDocumentSchemaWritable(current.content));
  if (expectedContent !== undefined && current.content !== expectedContent) {
    return yield* Effect.fail(
      new MemoryOperationError(
        `Memory ${replaceUri} changed while its replacement was being prepared. Retry the update.`,
      ),
    );
  }
  return current;
});

/** Exact raw-byte CAS for callers whose source text must not change at rewrite time. */
export const assertCurrentReplacementRawContent = Effect.fn('memory.assertCurrentReplacementRawContent')(function* (
  config: RuntimeConfig,
  replaceUri: string,
  expectedRawContent: string,
) {
  const path = yield* localMemoryPathForUri(config, replaceUri);
  const current = path ? yield* readTextIfExists(path) : undefined;
  if (current === undefined) {
    return yield* Effect.fail(new MemoryOperationError(`Memory ${replaceUri} no longer exists.`));
  }
  if (current !== expectedRawContent) {
    return yield* Effect.fail(
      new MemoryOperationError(
        `Memory ${replaceUri} changed while its replacement was being prepared. Retry the update.`,
      ),
    );
  }
});

const readCanonicalMemory = Effect.fn('memory.readCanonicalDestination')(function* (
  config: RuntimeConfig,
  uri: string,
) {
  const path = yield* localMemoryPathForUri(config, uri);
  if (!path) return undefined;
  const content = yield* readTextIfExists(path);
  return content ? parseMemoryDocument(uri, content) : undefined;
});
