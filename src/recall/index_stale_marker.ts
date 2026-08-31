import {Clock, Effect, FileSystem, Option} from 'effect';
import type {CanonicalMutationGenerationTransition} from '../effect/resource_mutation_generation.js';
import {SystemInfo} from '../effect/system.js';
import {mergeRecallIndexCanonicalMutationContinuity} from './index_freshness.js';
import {stripRecallAnchor} from './index_lexical.js';

const RECALL_STALE_MARKER_VERSION = 1;
const MAX_RECALL_INVALIDATED_URIS = 1_024;
let staleMarkerGenerationCounter = 0;

export interface RecallStaleMarker {
  readonly canonicalMutationGeneration?: string;
  readonly forceRefresh: boolean;
  readonly generation: string;
  readonly invalidatedUris: readonly string[];
  readonly previousCanonicalMutationGeneration?: string;
  readonly version: typeof RECALL_STALE_MARKER_VERSION;
}

export function readRecallStaleMarker(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<RecallStaleMarker | undefined, never> {
  return Effect.gen(function* () {
    const stalePath = `${path}.stale`;
    if (!(yield* fs.exists(stalePath).pipe(Effect.catch(() => Effect.succeed(false))))) {
      return undefined;
    }
    const raw = yield* fs.readFileString(stalePath).pipe(Effect.catch(() => Effect.succeed('present')));
    const legacyGeneration = raw.trim() || 'present';
    const value = Option.getOrUndefined(Option.liftThrowable((content: string): unknown => JSON.parse(content))(raw));
    if (
      typeof value === 'object' &&
      value !== null &&
      (value as {readonly version?: unknown}).version === RECALL_STALE_MARKER_VERSION &&
      typeof (value as {readonly generation?: unknown}).generation === 'string' &&
      (value as {readonly generation: string}).generation.length > 0 &&
      typeof (value as {readonly forceRefresh?: unknown}).forceRefresh === 'boolean' &&
      (!('canonicalMutationGeneration' in value) ||
        typeof (value as {readonly canonicalMutationGeneration?: unknown}).canonicalMutationGeneration === 'string') &&
      (!('previousCanonicalMutationGeneration' in value) ||
        typeof (value as {readonly previousCanonicalMutationGeneration?: unknown})
          .previousCanonicalMutationGeneration === 'string') &&
      Array.isArray((value as {readonly invalidatedUris?: unknown}).invalidatedUris) &&
      (value as {readonly invalidatedUris: readonly unknown[]}).invalidatedUris.every(uri => typeof uri === 'string')
    ) {
      const marker = value as RecallStaleMarker;
      return {
        ...(marker.canonicalMutationGeneration === undefined
          ? {}
          : {canonicalMutationGeneration: marker.canonicalMutationGeneration}),
        forceRefresh: marker.forceRefresh,
        generation: marker.generation,
        invalidatedUris: [...new Set(marker.invalidatedUris.map(stripRecallAnchor))],
        ...(marker.previousCanonicalMutationGeneration === undefined
          ? {}
          : {previousCanonicalMutationGeneration: marker.previousCanonicalMutationGeneration}),
        version: RECALL_STALE_MARKER_VERSION,
      };
    }
    return {
      forceRefresh: true,
      generation: legacyGeneration,
      invalidatedUris: [],
      version: RECALL_STALE_MARKER_VERSION,
    };
  });
}

export const writeRecallStaleGeneration = Effect.fn('recall.writeStaleGeneration')(function* (
  fs: FileSystem.FileSystem,
  path: string,
  invalidatedUris?: readonly string[],
  canonicalMutationGeneration?: CanonicalMutationGenerationTransition,
) {
  const system = yield* SystemInfo;
  const counter = yield* nextStaleMarkerGenerationCounter;
  const generation = `${yield* Clock.currentTimeMillis}:${system.processId}:${counter}`;
  const stalePath = `${path}.stale`;
  const previous = yield* readRecallStaleMarker(fs, path);
  const mergedInvalidatedUris = [
    ...new Set(
      [...(previous?.invalidatedUris ?? []), ...(invalidatedUris ?? [])]
        .map(stripRecallAnchor)
        .map(uri => uri.replace(/\/+$/, ''))
        .filter(Boolean),
    ),
  ];
  const previousHasPendingInvalidations =
    previous !== undefined && (previous.forceRefresh || previous.invalidatedUris.length > 0);
  const mutationContinuity = mergeRecallIndexCanonicalMutationContinuity(
    previous === undefined
      ? undefined
      : {
          ...(previous.canonicalMutationGeneration === undefined
            ? {}
            : {currentGeneration: previous.canonicalMutationGeneration}),
          pending: previousHasPendingInvalidations,
          ...(previous.previousCanonicalMutationGeneration === undefined
            ? {}
            : {previousGeneration: previous.previousCanonicalMutationGeneration}),
        },
    canonicalMutationGeneration,
  );
  const forceRefresh =
    invalidatedUris === undefined ||
    previous?.forceRefresh === true ||
    mergedInvalidatedUris.length > MAX_RECALL_INVALIDATED_URIS ||
    !mutationContinuity.continuous;
  const marker: RecallStaleMarker = {
    ...(mutationContinuity.currentGeneration === undefined
      ? {}
      : {canonicalMutationGeneration: mutationContinuity.currentGeneration}),
    forceRefresh,
    generation,
    invalidatedUris: forceRefresh ? [] : mergedInvalidatedUris,
    ...(mutationContinuity.previousGeneration === undefined
      ? {}
      : {previousCanonicalMutationGeneration: mutationContinuity.previousGeneration}),
    version: RECALL_STALE_MARKER_VERSION,
  };
  const temporaryPath = `${stalePath}.${system.processId}.${counter}.tmp`;
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(marker)}\n`, {mode: 0o600});
  yield* fs
    .rename(temporaryPath, stalePath)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.catch(() => Effect.void))));
  return generation;
});

export const clearRecallStaleMarkerInvalidations = Effect.fn('recall.clearStaleMarkerInvalidations')(function* (
  fs: FileSystem.FileSystem,
  path: string,
  observed: RecallStaleMarker,
) {
  const current = yield* readRecallStaleMarker(fs, path);
  if (current?.generation !== observed.generation) {
    return;
  }
  const system = yield* SystemInfo;
  const counter = yield* nextStaleMarkerGenerationCounter;
  const stalePath = `${path}.stale`;
  const temporaryPath = `${stalePath}.${system.processId}.${counter}.tmp`;
  const cleared: RecallStaleMarker = {
    ...(observed.canonicalMutationGeneration === undefined
      ? {}
      : {canonicalMutationGeneration: observed.canonicalMutationGeneration}),
    forceRefresh: false,
    generation: observed.generation,
    invalidatedUris: [],
    ...(observed.canonicalMutationGeneration === undefined
      ? {}
      : {previousCanonicalMutationGeneration: observed.canonicalMutationGeneration}),
    version: RECALL_STALE_MARKER_VERSION,
  };
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(cleared)}\n`, {mode: 0o600});
  yield* fs
    .rename(temporaryPath, stalePath)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.catch(() => Effect.void))));
});

const nextStaleMarkerGenerationCounter = Effect.sync(() => {
  staleMarkerGenerationCounter += 1;
  return staleMarkerGenerationCounter;
});
