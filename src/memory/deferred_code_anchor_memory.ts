import {Effect, Option} from 'effect';
import {sha256Hex} from '../effect/digest.js';
import {ResourceStore} from '../effect/resource-store.js';
import type {RuntimeConfig} from '../types.js';
import {canonicalMemoryDocumentContent, parseMemoryDocument, type MemoryRecord} from './document.js';

export interface DeferredMemoryObservation {
  readonly content: string;
  readonly hash: string;
  readonly record: MemoryRecord;
}

export function deferredCodeAnchorFinalizationVerified(expected: string, actual: string): boolean {
  return canonicalMemoryDocumentContent(actual) === canonicalMemoryDocumentContent(expected);
}

export const readDeferredMemoryObservation = Effect.fn('memoryCodeAnchor.readMemory')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
) {
  const store = yield* ResourceStore;
  const content = yield* store.read(resourceStoreLocation(config), memoryUri).pipe(
    Effect.map(Option.some),
    Effect.catchTag('ResourceNotFound', () => Effect.succeed(Option.none())),
  );
  if (Option.isNone(content)) return undefined;
  const record = parseMemoryDocument(memoryUri, content.value);
  if (!record) return undefined;
  return {
    content: content.value,
    hash: yield* memoryContentHash(content.value),
    record,
  } satisfies DeferredMemoryObservation;
});

export function reconcileInterruptedDeferredCodeAnchorCommit<A, E, R>(
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
  expectedMemory: string,
  cleanup: Effect.Effect<A, E, R>,
) {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const store = yield* ResourceStore;
      const actual = yield* store.read(resourceStoreLocation(config), memoryUri).pipe(Effect.option);
      if (Option.isNone(actual)) return;
      const record = parseMemoryDocument(memoryUri, actual.value);
      if (!record || !deferredCodeAnchorFinalizationVerified(expectedMemory, actual.value)) return;
      yield* cleanup;
    }).pipe(Effect.ignoreCause),
  );
}

export function memoryContentHash(content: string) {
  return sha256Hex(canonicalMemoryDocumentContent(content));
}

export function resourceStoreLocation(config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>) {
  return {account: config.account, home: config.agentContextHome, user: config.user} as const;
}
