import {Clock, Crypto, Effect, FileSystem, Path, Result} from 'effect';
import {sha256Hex} from '../effect/digest.js';
import {LocalModelRuntime} from '../effect/ai/local-model-runtime.js';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {LocalModelCatalog, type LocalModelManifest} from '../models/catalog.js';
import {LocalModelStore} from '../models/store.js';
import {readModelSelection} from '../models/selection.js';
import type {RecallCandidate} from '../recall/rank.js';
import {chunkRecallDocument, RECALL_CHUNKER_VERSION, type RecallChunk} from './chunker.js';
import {normalizeVector, searchExactVectors} from './vector-search.js';
import {
  decodeVectorSidecar,
  encodeVectorSidecar,
  type VectorSidecar,
  type VectorSidecarEntry,
} from './vector-sidecar.js';

const VECTOR_INDEX_POINTER_VERSION = 1 as const;
const VECTOR_INDEX_EMBED_BATCH_SIZE = 256;
interface VectorIndexPointer {
  readonly chunkCount?: number;
  readonly chunkerVersion?: number;
  readonly corpusGeneration?: string;
  readonly createdAt: string;
  readonly dimensions?: number;
  readonly generation: string;
  readonly modelSha256?: string;
  readonly sidecarSha256: string;
  readonly version: typeof VECTOR_INDEX_POINTER_VERSION;
}

interface CachedVectorSidecar {
  readonly generation: string;
  readonly sidecar: VectorSidecar;
  readonly sidecarSha256: string;
}

const decodedVectorSidecarByModel = new Map<string, CachedVectorSidecar>();

export interface VectorIndexStatus {
  readonly chunkCount: number;
  readonly createdAt?: string;
  readonly dimensions?: number;
  readonly embeddedChunkCount?: number;
  readonly generation?: string;
  readonly modelId: string;
  readonly ready: boolean;
  readonly reason?: string;
  readonly reusedChunkCount?: number;
}

interface VectorIndexBuildOptions {
  readonly corpusGeneration?: string;
}

export const rebuildVectorIndex = Effect.fn('vectorIndex.rebuild')(function* (
  config: {readonly agentContextHome: string},
  manifest: LocalModelManifest,
  candidates: readonly RecallCandidate[],
  options: VectorIndexBuildOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withVectorIndexLock(fs, path, config.agentContextHome, manifest.id, () =>
    rebuildVectorIndexUnlocked(config, manifest, candidates, options),
  );
});

export const ensureVectorIndex = Effect.fn('vectorIndex.ensure')(function* (
  config: {readonly agentContextHome: string},
  manifest: LocalModelManifest,
  candidates: readonly RecallCandidate[],
  options: VectorIndexBuildOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const chunks = candidates.flatMap(candidate => chunkRecallDocument(candidate.uri, candidate.text));
  const current = yield* currentVectorIndexStatus(config.agentContextHome, manifest, chunks, options).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (current) {
    return current;
  }
  return yield* withVectorIndexLock(fs, path, config.agentContextHome, manifest.id, () =>
    Effect.gen(function* () {
      const lockedCurrent = yield* currentVectorIndexStatus(config.agentContextHome, manifest, chunks, options).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (lockedCurrent) {
        return lockedCurrent;
      }
      return yield* rebuildVectorIndexUnlocked(config, manifest, candidates, options, chunks);
    }),
  );
});

export const vectorIndexMatchesGeneration = Effect.fn('vectorIndex.matchesGeneration')(function* (
  home: string,
  manifest: LocalModelManifest,
  corpusGeneration: string,
) {
  const active = yield* readActiveVectorSidecar(home, manifest).pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (!active) return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pointer = yield* readVectorPointer(path, fs, home, manifest.id);
  return pointerMatchesCorpus(pointer, manifest, corpusGeneration);
});

const currentVectorIndexStatus = Effect.fn('vectorIndex.currentStatus')(function* (
  home: string,
  manifest: LocalModelManifest,
  chunks: readonly RecallChunk[],
  options: VectorIndexBuildOptions,
) {
  const active = yield* readActiveVectorSidecar(home, manifest);
  if (!active) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pointer = yield* readVectorPointer(path, fs, home, manifest.id);
  const current = options.corpusGeneration
    ? pointerMatchesCorpus(pointer, manifest, options.corpusGeneration)
    : vectorSidecarMatchesChunks(active, chunks);
  if (!current) return undefined;
  return {
    chunkCount: active.entries.length,
    createdAt: pointer?.createdAt,
    dimensions: active.metadata.dimensions,
    embeddedChunkCount: 0,
    generation: pointer?.generation,
    modelId: manifest.id,
    ready: true,
    reusedChunkCount: active.entries.length,
  } satisfies VectorIndexStatus;
});

const rebuildVectorIndexUnlocked = Effect.fn('vectorIndex.rebuildUnlocked')(function* (
  config: {readonly agentContextHome: string},
  manifest: LocalModelManifest,
  candidates: readonly RecallCandidate[],
  options: VectorIndexBuildOptions = {},
  preparedChunks?: readonly RecallChunk[],
) {
  if (manifest.role !== 'embedding' || !manifest.dimensions) {
    return yield* Effect.fail(new Error(`Model ${manifest.id} is not an embedding model.`));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runtime = yield* LocalModelRuntime;
  const store = yield* LocalModelStore;
  const installed = yield* store.verify(config.agentContextHome, manifest);
  const chunks = preparedChunks ?? candidates.flatMap(candidate => chunkRecallDocument(candidate.uri, candidate.text));
  const root = vectorModelRoot(path, config.agentContextHome, manifest.id);
  const jobId = yield* sha256Hex(
    `${manifest.sha256}\n${RECALL_CHUNKER_VERSION}\n${chunks.map(chunk => chunk.id).join('\n')}`,
  );
  const checkpointRoot = path.join(root, 'staging', jobId, 'batches');
  const [active, checkpoint] = yield* Effect.all(
    [
      readActiveVectorSidecar(config.agentContextHome, manifest).pipe(Effect.catch(() => Effect.succeed(undefined))),
      readCompatibleCheckpoints(fs, path, checkpointRoot, manifest).pipe(
        Effect.catch(() => Effect.succeed({batchCount: 0, entries: [] as readonly VectorSidecarEntry[]})),
      ),
    ],
    {concurrency: 2},
  );
  const vectorByChunk = new Map<string, readonly number[]>();
  for (const entry of [...(active?.entries ?? []), ...checkpoint.entries]) {
    vectorByChunk.set(chunkReuseKey(entry.uri, entry.fingerprint), entry.vector);
  }
  const reusableChunkCount = chunks.filter(chunk =>
    vectorByChunk.has(chunkReuseKey(chunk.uri, chunk.fingerprint)),
  ).length;
  let embeddedChunkCount = 0;
  const missing = chunks.filter(chunk => !vectorByChunk.has(chunkReuseKey(chunk.uri, chunk.fingerprint)));
  for (let start = 0; start < missing.length; start += VECTOR_INDEX_EMBED_BATCH_SIZE) {
    const batch = missing.slice(start, start + VECTOR_INDEX_EMBED_BATCH_SIZE);
    const vectors = yield* runtime.embedMany({
      inputs: batch.map(chunk => `${manifest.promptPrefixes?.document ?? ''}${chunk.content}`),
      manifest,
      modelPath: installed.path,
    });
    for (const [index, chunk] of batch.entries()) {
      vectorByChunk.set(chunkReuseKey(chunk.uri, chunk.fingerprint), normalizeVector(vectors[index]!));
    }
    embeddedChunkCount += batch.length;
    const checkpointEntries = batch.map(chunk => ({
      fingerprint: chunk.fingerprint,
      id: chunk.id,
      uri: chunk.uri,
      vector: vectorByChunk.get(chunkReuseKey(chunk.uri, chunk.fingerprint))!,
    }));
    yield* writeCheckpointAtomically(
      fs,
      path,
      path.join(
        checkpointRoot,
        `batch-${String(checkpoint.batchCount + start / VECTOR_INDEX_EMBED_BATCH_SIZE).padStart(8, '0')}.bin`,
      ),
      sidecarForEntries(manifest, manifest.dimensions, checkpointEntries),
    );
  }
  const entries: VectorSidecarEntry[] = chunks.map(chunk => ({
    fingerprint: chunk.fingerprint,
    id: chunk.id,
    uri: chunk.uri,
    vector: vectorByChunk.get(chunkReuseKey(chunk.uri, chunk.fingerprint))!,
  }));
  const sidecar = sidecarForEntries(manifest, manifest.dimensions, entries);
  const encoded = encodeVectorSidecar(sidecar);
  const generation = `${yield* Clock.currentTimeMillis}-${(yield* crypto.randomUUIDv4).slice(0, 8)}`;
  const generationDirectory = path.join(root, 'generations', generation);
  const sidecarPath = path.join(generationDirectory, 'vectors.bin');
  yield* fs.makeDirectory(generationDirectory, {recursive: true, mode: 0o700});
  yield* fs.writeFile(sidecarPath, encoded, {mode: 0o600});
  const pointer: VectorIndexPointer = {
    chunkCount: entries.length,
    chunkerVersion: RECALL_CHUNKER_VERSION,
    corpusGeneration: options.corpusGeneration,
    createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
    dimensions: manifest.dimensions,
    generation,
    modelSha256: manifest.sha256,
    sidecarSha256: yield* sha256Hex(encoded),
    version: VECTOR_INDEX_POINTER_VERSION,
  };
  yield* writePointerAtomically(fs, path, root, pointer);
  yield* Effect.sync(() =>
    decodedVectorSidecarByModel.set(vectorSidecarCacheKey(path, config.agentContextHome, manifest.id), {
      generation,
      sidecar,
      sidecarSha256: pointer.sidecarSha256,
    }),
  );
  yield* fs.remove(path.join(root, 'staging'), {force: true, recursive: true});
  yield* pruneVectorGenerations(fs, path, root, generation);
  return {
    chunkCount: entries.length,
    createdAt: pointer.createdAt,
    dimensions: manifest.dimensions,
    embeddedChunkCount,
    generation,
    modelId: manifest.id,
    ready: true,
    reusedChunkCount: reusableChunkCount,
  } satisfies VectorIndexStatus;
});

export const selectedSemanticScores = Effect.fn('vectorIndex.selectedSemanticScores')(function* (
  config: {readonly agentContextHome: string},
  query: string,
  options: {readonly limit?: number} = {},
) {
  const selection = yield* readModelSelection(config.agentContextHome);
  const modelId = selection.roles.embedding;
  if (!modelId) return undefined;
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(modelId);
  if (!manifest.dimensions || manifest.role !== 'embedding') return undefined;
  const loaded = yield* readActiveVectorSidecar(config.agentContextHome, manifest);
  if (!loaded) return undefined;
  const store = yield* LocalModelStore;
  const runtime = yield* LocalModelRuntime;
  const status = yield* store.status(config.agentContextHome, manifest);
  if (!status.installed) return undefined;
  const [queryVector] = yield* runtime.embedMany({
    inputs: [`${manifest.promptPrefixes?.query ?? ''}${query}`],
    manifest,
    modelPath: status.path,
  });
  const results = searchExactVectors(
    queryVector!,
    loaded.entries.map(entry => ({id: entry.id, vector: entry.vector})),
    {
      dimensions: manifest.dimensions,
      limit: Math.min(loaded.entries.length, options.limit ?? 500),
    },
  );
  const entryById = new Map(loaded.entries.map(entry => [entry.id, entry]));
  const scores = new Map<string, number>();
  for (const result of results) {
    const uri = entryById.get(result.id)?.uri;
    if (!uri) continue;
    scores.set(uri, Math.max(scores.get(uri) ?? 0, Math.max(0, result.score)));
  }
  return scores;
});

export const vectorIndexStatus = Effect.fn('vectorIndex.status')(function* (
  home: string,
  manifest: LocalModelManifest,
  candidates?: readonly RecallCandidate[],
) {
  const sidecar = yield* readActiveVectorSidecar(home, manifest).pipe(Effect.result);
  if (Result.isFailure(sidecar)) {
    return {
      chunkCount: 0,
      modelId: manifest.id,
      ready: false,
      reason: sidecar.failure instanceof Error ? sidecar.failure.message : String(sidecar.failure),
    } satisfies VectorIndexStatus;
  }
  if (!sidecar.success) {
    return {chunkCount: 0, modelId: manifest.id, ready: false, reason: 'not built'} satisfies VectorIndexStatus;
  }
  if (
    candidates &&
    !vectorSidecarMatchesChunks(
      sidecar.success,
      candidates.flatMap(candidate => chunkRecallDocument(candidate.uri, candidate.text)),
    )
  ) {
    return {
      chunkCount: sidecar.success.entries.length,
      dimensions: sidecar.success.metadata.dimensions,
      modelId: manifest.id,
      ready: false,
      reason: 'stale; canonical documents changed',
    } satisfies VectorIndexStatus;
  }
  const path = yield* Path.Path;
  const pointer = yield* readVectorPointer(path, yield* FileSystem.FileSystem, home, manifest.id);
  return {
    chunkCount: sidecar.success.entries.length,
    createdAt: pointer?.createdAt,
    dimensions: sidecar.success.metadata.dimensions,
    generation: pointer?.generation,
    modelId: manifest.id,
    ready: true,
  } satisfies VectorIndexStatus;
});

export const purgeVectorIndex = Effect.fn('vectorIndex.purge')(function* (home: string, modelId: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = vectorModelRoot(path, home, modelId);
  yield* Effect.sync(() => decodedVectorSidecarByModel.delete(vectorSidecarCacheKey(path, home, modelId)));
  if (!(yield* fs.exists(root))) return false;
  yield* fs.remove(root, {recursive: true});
  return true;
});

const readActiveVectorSidecar = Effect.fn('vectorIndex.readActive')(function* (
  home: string,
  manifest: LocalModelManifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pointer = yield* readVectorPointer(path, fs, home, manifest.id);
  if (!pointer) return undefined;
  const cacheKey = vectorSidecarCacheKey(path, home, manifest.id);
  const cached = yield* Effect.sync(() => decodedVectorSidecarByModel.get(cacheKey));
  if (
    cached?.generation === pointer.generation &&
    cached.sidecarSha256 === pointer.sidecarSha256 &&
    vectorSidecarIsCompatible(cached.sidecar, manifest)
  ) {
    return cached.sidecar;
  }
  const sidecarPath = path.join(
    vectorModelRoot(path, home, manifest.id),
    'generations',
    pointer.generation,
    'vectors.bin',
  );
  const bytes = yield* fs.readFile(sidecarPath);
  if ((yield* sha256Hex(bytes)) !== pointer.sidecarSha256) {
    return yield* Effect.fail(new Error(`Vector index ${manifest.id}/${pointer.generation} checksum does not match.`));
  }
  const sidecar = decodeVectorSidecar(bytes);
  if (!vectorSidecarIsCompatible(sidecar, manifest)) {
    return yield* Effect.fail(new Error(`Vector index ${manifest.id}/${pointer.generation} is incompatible.`));
  }
  yield* Effect.sync(() =>
    decodedVectorSidecarByModel.set(cacheKey, {
      generation: pointer.generation,
      sidecar,
      sidecarSha256: pointer.sidecarSha256,
    }),
  );
  return sidecar;
});

function readCompatibleSidecar(fs: FileSystem.FileSystem, sidecarPath: string, manifest: LocalModelManifest) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(sidecarPath))) return undefined;
    const sidecar = decodeVectorSidecar(yield* fs.readFile(sidecarPath));
    if (!vectorSidecarIsCompatible(sidecar, manifest)) {
      return undefined;
    }
    return sidecar;
  });
}

function readCompatibleCheckpoints(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  checkpointRoot: string,
  manifest: LocalModelManifest,
) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(checkpointRoot))) {
      return {batchCount: 0, entries: [] as readonly VectorSidecarEntry[]};
    }
    const names = (yield* fs.readDirectory(checkpointRoot)).filter(name => /^batch-[0-9]{8}\.bin$/.test(name)).sort();
    const entries: VectorSidecarEntry[] = [];
    for (const name of names) {
      const sidecar = yield* readCompatibleSidecar(fs, path.join(checkpointRoot, name), manifest);
      if (!sidecar) {
        return yield* Effect.fail(new Error(`Vector checkpoint ${name} is incompatible.`));
      }
      entries.push(...sidecar.entries);
    }
    return {batchCount: names.length, entries};
  });
}

function writeCheckpointAtomically(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  checkpointPath: string,
  sidecar: VectorSidecar,
) {
  return Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(checkpointPath), {recursive: true, mode: 0o700});
    const temporary = `${checkpointPath}.tmp`;
    yield* fs.writeFile(temporary, encodeVectorSidecar(sidecar), {mode: 0o600});
    yield* fs.rename(temporary, checkpointPath);
  });
}

function sidecarForEntries(
  manifest: LocalModelManifest,
  dimensions: number,
  entries: readonly VectorSidecarEntry[],
): VectorSidecar {
  return {
    entries,
    metadata: {
      chunkerVersion: RECALL_CHUNKER_VERSION,
      dimensions,
      modelId: manifest.id,
      modelSha256: manifest.sha256,
      normalized: 'l2',
    },
    version: 1,
  };
}

function chunkReuseKey(uri: string, fingerprint: string): string {
  return `${uri}\u0000${fingerprint}`;
}

function readVectorPointer(path: Path.Path, fs: FileSystem.FileSystem, home: string, modelId: string) {
  return Effect.gen(function* () {
    const pointerPath = path.join(vectorModelRoot(path, home, modelId), 'active.json');
    if (!(yield* fs.exists(pointerPath))) return undefined;
    const raw = yield* fs.readFileString(pointerPath);
    const parsed = Result.try(() => JSON.parse(raw) as unknown);
    if (Result.isFailure(parsed) || !isVectorPointer(parsed.success)) {
      return yield* Effect.fail(new Error(`Vector index pointer for ${modelId} is invalid.`));
    }
    return parsed.success;
  });
}

function writePointerAtomically(fs: FileSystem.FileSystem, path: Path.Path, root: string, pointer: VectorIndexPointer) {
  return Effect.gen(function* () {
    const target = path.join(root, 'active.json');
    const temporary = path.join(root, `.active.${pointer.generation}.tmp`);
    yield* fs.writeFileString(temporary, `${JSON.stringify(pointer, undefined, 2)}\n`, {mode: 0o600});
    yield* fs.rename(temporary, target);
  });
}

function pruneVectorGenerations(fs: FileSystem.FileSystem, path: Path.Path, root: string, active: string) {
  return Effect.gen(function* () {
    const generationsRoot = path.join(root, 'generations');
    const generations = [...(yield* fs.readDirectory(generationsRoot))].sort().reverse();
    for (const generation of generations.filter(value => value !== active).slice(1)) {
      yield* fs.remove(path.join(generationsRoot, generation), {recursive: true});
    }
  });
}

function vectorModelRoot(path: Path.Path, home: string, modelId: string): string {
  return path.join(home, 'indexes', 'vectors', modelId);
}

function withVectorIndexLock<A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  modelId: string,
  effect: () => Effect.Effect<A, E, R>,
) {
  return withExclusiveFileLock(
    fs,
    path.join(home, 'locks', 'indexes', 'vectors', `${modelId}.lock`),
    {
      heartbeatIntervalMilliseconds: 10_000,
      retryIntervalMilliseconds: 100,
      staleAfterMilliseconds: 60_000,
      waitTimeoutMilliseconds: 120_000,
    },
    Effect.suspend(effect),
  );
}

function vectorSidecarMatchesChunks(sidecar: VectorSidecar, chunks: readonly RecallChunk[]): boolean {
  if (sidecar.entries.length !== chunks.length) return false;
  const expectedById = new Map(chunks.map(chunk => [chunk.id, chunk]));
  return sidecar.entries.every(entry => {
    const expected = expectedById.get(entry.id);
    return expected?.fingerprint === entry.fingerprint && expected.uri === entry.uri;
  });
}

function vectorSidecarCacheKey(path: Path.Path, home: string, modelId: string): string {
  return `${path.resolve(home)}\u0000${modelId}`;
}

function vectorSidecarIsCompatible(sidecar: VectorSidecar, manifest: LocalModelManifest): boolean {
  return (
    sidecar.metadata.modelId === manifest.id &&
    sidecar.metadata.modelSha256 === manifest.sha256 &&
    sidecar.metadata.dimensions === manifest.dimensions &&
    sidecar.metadata.chunkerVersion === RECALL_CHUNKER_VERSION
  );
}

function pointerMatchesCorpus(
  pointer: VectorIndexPointer | undefined,
  manifest: LocalModelManifest,
  corpusGeneration: string,
): boolean {
  return (
    pointer?.corpusGeneration === corpusGeneration &&
    pointer.modelSha256 === manifest.sha256 &&
    pointer.dimensions === manifest.dimensions &&
    pointer.chunkerVersion === RECALL_CHUNKER_VERSION &&
    pointer.chunkCount !== undefined &&
    pointer.chunkCount >= 0
  );
}

function isVectorPointer(value: unknown): value is VectorIndexPointer {
  if (typeof value !== 'object' || value === null) return false;
  const pointer = value as Partial<VectorIndexPointer>;
  return (
    pointer.version === VECTOR_INDEX_POINTER_VERSION &&
    typeof pointer.createdAt === 'string' &&
    typeof pointer.generation === 'string' &&
    /^[0-9]+-[a-f0-9-]+$/.test(pointer.generation) &&
    typeof pointer.sidecarSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(pointer.sidecarSha256) &&
    (pointer.chunkCount === undefined || (Number.isInteger(pointer.chunkCount) && pointer.chunkCount >= 0)) &&
    (pointer.chunkerVersion === undefined || Number.isInteger(pointer.chunkerVersion)) &&
    (pointer.corpusGeneration === undefined || typeof pointer.corpusGeneration === 'string') &&
    (pointer.dimensions === undefined || (Number.isInteger(pointer.dimensions) && pointer.dimensions > 0)) &&
    (pointer.modelSha256 === undefined || /^[0-9a-f]{64}$/.test(pointer.modelSha256))
  );
}

export function chunksForRecallCandidates(candidates: readonly RecallCandidate[]): readonly RecallChunk[] {
  return candidates.flatMap(candidate => chunkRecallDocument(candidate.uri, candidate.text));
}
