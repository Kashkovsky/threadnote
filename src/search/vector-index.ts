import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Clock, Crypto, Effect, FileSystem, Layer, Option, Path, Result, Schema} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {LocalModelRuntime} from '../effect/ai/local-model-runtime.js';
import {sha256Hex} from '../effect/digest.js';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {LocalModelCatalog, type LocalModelManifest} from '../models/catalog.js';
import {LocalModelStore} from '../models/store.js';
import {readModelSelection} from '../models/selection.js';
import type {RecallCandidate} from '../recall/rank.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {chunkRecallDocument, RECALL_CHUNKER_VERSION, type RecallChunk} from './chunker.js';
import {normalizeVector, type VectorSearchResult} from './vector-search.js';

class VectorIndexOperationError extends Error {
  readonly _tag = 'VectorIndexOperationError' as const;
}

const VECTOR_INDEX_DATABASE_VERSION = 4;
const VECTOR_INDEX_EMBED_BATCH_SIZE = 256;
const VECTOR_INDEX_PAGE_SIZE = 400;
const VECTOR_INDEX_INSERT_BATCH_SIZE = 100;
const VECTOR_INDEX_DATABASE_FILENAME = `vectors-v${VECTOR_INDEX_DATABASE_VERSION}.sqlite`;
const VECTOR_INDEX_SCHEMA_COLUMNS = {
  vector_aliases: ['generation', 'uri', 'representative_uri'],
  vector_chunks: ['generation', 'chunk_id', 'uri', 'fingerprint', 'vector_id'],
  vector_generations: [
    'generation',
    'job_id',
    'corpus_generation',
    'model_id',
    'model_sha256',
    'dimensions',
    'embedding_recipe',
    'chunker_version',
    'normalized',
    'chunk_count',
    'state',
    'created_at',
  ],
  vector_pointer: ['singleton', 'generation'],
  vector_values: ['id', 'vector_key', 'vector'],
} as const;

interface VectorGenerationRow {
  readonly actual_chunk_count: number;
  readonly chunk_count: number;
  readonly chunker_version: number;
  readonly corpus_generation: string | null;
  readonly created_at: string;
  readonly dimensions: number;
  readonly embedding_recipe: string;
  readonly generation: string;
  readonly job_id: string;
  readonly model_id: string;
  readonly model_sha256: string;
  readonly normalized: 'l2';
  readonly state: 'building' | 'ready';
}

interface VectorRow {
  readonly chunk_id: string;
  readonly fingerprint: string;
  readonly uri: string;
  readonly vector: unknown;
}

interface DesiredVectorChunk extends RecallChunk {
  readonly vectorKey: string;
}

interface SemanticChunkMatch extends VectorSearchResult {
  readonly uri: string;
}

interface VectorAliasRow {
  readonly representative_uri: string;
  readonly uri: string;
}

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

export class VectorIndexCorrupt extends Schema.TaggedErrorClass<VectorIndexCorrupt>()('VectorIndexCorrupt', {
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class VectorCorpusGenerationChanged extends Schema.TaggedErrorClass<VectorCorpusGenerationChanged>()(
  'VectorCorpusGenerationChanged',
  {
    message: Schema.String,
    modelId: Schema.String,
    requestedGeneration: Schema.String,
  },
) {}

export type VectorIndexProgress =
  | {
      readonly completed: number;
      readonly phase: 'embedding';
      readonly reused: number;
      readonly total: number;
    }
  | {
      readonly chunkCount: number;
      readonly phase: 'activating';
    };

interface VectorCorpusGenerationOptions<R> {
  readonly corpusGeneration?: string;
  readonly currentCorpusGeneration?: () => Effect.Effect<Option.Option<string>, unknown, R>;
}

interface VectorIndexBuildOptions<R> extends VectorCorpusGenerationOptions<R> {
  readonly onProgress?: (progress: VectorIndexProgress) => Effect.Effect<void, unknown>;
}

interface SemanticScoreOptions<R> extends VectorCorpusGenerationOptions<R> {
  readonly limit?: number;
}

const verifyCurrentCorpusGeneration = Effect.fn('vectorIndex.verifyCurrentCorpusGeneration')(function* <R = never>(
  manifest: LocalModelManifest,
  options: VectorCorpusGenerationOptions<R>,
) {
  if (options.currentCorpusGeneration === undefined) return;
  const requestedGeneration = options.corpusGeneration;
  if (requestedGeneration === undefined) {
    return yield* Effect.fail(
      new VectorIndexOperationError('A vector corpus-generation fence requires a requested generation.'),
    );
  }
  const currentGeneration = yield* options.currentCorpusGeneration();
  if (Option.isSome(currentGeneration) && currentGeneration.value === requestedGeneration) return;
  return yield* Effect.fail(
    new VectorCorpusGenerationChanged({
      message: 'The lexical recall corpus changed while vector work was in progress.',
      modelId: manifest.id,
      requestedGeneration,
    }),
  );
});

const verifySelectedCorpusGeneration = Effect.fn('vectorIndex.verifySelectedCorpusGeneration')(function* <R = never>(
  active: VectorGenerationRow,
  manifest: LocalModelManifest,
  options: VectorCorpusGenerationOptions<R>,
) {
  const requestedGeneration = options.corpusGeneration;
  if (requestedGeneration !== undefined && active.corpus_generation !== requestedGeneration) {
    return yield* Effect.fail(
      new VectorCorpusGenerationChanged({
        message: 'The active vector index no longer matches the requested lexical recall corpus.',
        modelId: manifest.id,
        requestedGeneration,
      }),
    );
  }
  yield* verifyCurrentCorpusGeneration(manifest, options);
});

export const rebuildVectorIndex = Effect.fn('vectorIndex.rebuild')(function* <R = never>(
  config: {readonly agentContextHome: string},
  manifest: LocalModelManifest,
  candidates: readonly RecallCandidate[],
  options: VectorIndexBuildOptions<R> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withVectorIndexLock(fs, path, config.agentContextHome, manifest.id, () =>
    rebuildVectorIndexUnlocked(config, manifest, candidates, options),
  );
});

export const ensureVectorIndex = Effect.fn('vectorIndex.ensure')(function* <R = never>(
  config: {readonly agentContextHome: string},
  manifest: LocalModelManifest,
  candidates: readonly RecallCandidate[],
  options: VectorIndexBuildOptions<R> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const chunks = candidates.flatMap(candidate => chunkRecallDocument(candidate.uri, candidate.text));
  const current = yield* currentVectorIndexStatus(config.agentContextHome, manifest, chunks, options).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (current) {
    yield* verifyCurrentCorpusGeneration(manifest, options);
    return current;
  }
  return yield* withVectorIndexLock(fs, path, config.agentContextHome, manifest.id, () =>
    Effect.gen(function* () {
      const lockedCurrent = yield* currentVectorIndexStatus(config.agentContextHome, manifest, chunks, options).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (lockedCurrent) {
        yield* verifyCurrentCorpusGeneration(manifest, options);
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
  const active = yield* readActiveVectorGeneration(home, manifest).pipe(Effect.catch(() => Effect.succeed(undefined)));
  return active ? generationMatchesCorpus(active, manifest, corpusGeneration) : false;
});

const currentVectorIndexStatus = Effect.fn('vectorIndex.currentStatus')(function* <R = never>(
  home: string,
  manifest: LocalModelManifest,
  chunks: readonly RecallChunk[],
  options: VectorIndexBuildOptions<R>,
) {
  const active = yield* readActiveVectorGeneration(home, manifest);
  if (!active) return undefined;
  const current = options.corpusGeneration
    ? generationMatchesCorpus(active, manifest, options.corpusGeneration)
    : yield* vectorGenerationMatchesChunks(home, manifest, active.generation, chunks);
  if (!current) return undefined;
  return {
    chunkCount: active.chunk_count,
    createdAt: active.created_at,
    dimensions: active.dimensions,
    embeddedChunkCount: 0,
    generation: active.generation,
    modelId: manifest.id,
    ready: true,
    reusedChunkCount: active.chunk_count,
  } satisfies VectorIndexStatus;
});

const rebuildVectorIndexUnlocked = Effect.fn('vectorIndex.rebuildUnlocked')(function* <R = never>(
  config: {readonly agentContextHome: string},
  manifest: LocalModelManifest,
  candidates: readonly RecallCandidate[],
  options: VectorIndexBuildOptions<R> = {},
  preparedChunks?: readonly RecallChunk[],
) {
  yield* verifyCurrentCorpusGeneration(manifest, options);
  if (manifest.role !== 'embedding' || !manifest.dimensions) {
    return yield* Effect.fail(new VectorIndexOperationError(`Model ${manifest.id} is not an embedding model.`));
  }
  const dimensions = manifest.dimensions;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const runtime = yield* LocalModelRuntime;
  const store = yield* LocalModelStore;
  const installed = yield* store.verify(config.agentContextHome, manifest);
  const chunks = preparedChunks ?? candidates.flatMap(candidate => chunkRecallDocument(candidate.uri, candidate.text));
  const aliases = candidates
    .flatMap(candidate =>
      [candidate.uri, ...(candidate.equivalentUris ?? [])].map(uri => ({representativeUri: candidate.uri, uri})),
    )
    .sort((left, right) => left.uri.localeCompare(right.uri));
  const recipe = embeddingRecipe(manifest);
  const desiredChunks = chunks.map(chunk => ({
    ...chunk,
    vectorKey: vectorKeyForChunk(recipe, chunk),
  }));
  const root = vectorModelRoot(path, config.agentContextHome, manifest.id);
  const databasePath = vectorDatabasePath(path, config.agentContextHome, manifest.id);
  const jobId = yield* sha256Hex(
    JSON.stringify({
      chunkerVersion: RECALL_CHUNKER_VERSION,
      chunks: chunks.map(chunk => ({fingerprint: chunk.fingerprint, id: chunk.id, uri: chunk.uri})),
      aliases,
      corpusGeneration: options.corpusGeneration ?? null,
      dimensions: manifest.dimensions,
      modelSha256: manifest.sha256,
      promptPrefix: manifest.promptPrefixes?.document ?? '',
    }),
  );
  yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  yield* initializeVectorDatabaseWithRecovery(fs, databasePath);

  const status = yield* useVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeVectorDatabase(sql);
      const activeResult = yield* selectActiveGeneration(sql).pipe(Effect.result);
      const active =
        Result.isSuccess(activeResult) &&
        activeResult.success !== undefined &&
        generationIsCompatible(activeResult.success, manifest)
          ? activeResult.success
          : undefined;
      if (!active && (Result.isFailure(activeResult) || activeResult.success !== undefined)) {
        yield* sql.unsafe('DELETE FROM vector_pointer');
      }
      yield* sql`DELETE FROM vector_generations WHERE state = 'building' AND job_id <> ${jobId}`;
      yield* prepareDesiredChunks(sql, desiredChunks);

      let building: VectorGenerationRow | undefined = yield* selectGenerationByJob(sql, jobId);
      if (building && !generationIsCompatible(building, manifest)) {
        yield* sql`DELETE FROM vector_generations WHERE generation = ${building.generation}`;
        building = undefined;
      }
      if (!building) {
        const generation = `${yield* Clock.currentTimeMillis}-${(yield* crypto.randomUUIDv4).slice(0, 8)}`;
        yield* sql`
          INSERT INTO vector_generations (
            generation,
            job_id,
            corpus_generation,
            model_id,
            model_sha256,
            dimensions,
            embedding_recipe,
            chunker_version,
            normalized,
            chunk_count,
            state,
            created_at
          ) VALUES (
            ${generation},
            ${jobId},
            ${options.corpusGeneration ?? null},
            ${manifest.id},
            ${manifest.sha256},
            ${manifest.dimensions},
            ${recipe},
            ${RECALL_CHUNKER_VERSION},
            'l2',
            0,
            'building',
            ${new Date(yield* Clock.currentTimeMillis).toISOString()}
          )
        `;
        building = yield* selectGenerationByJob(sql, jobId);
      }
      if (!building) {
        return yield* Effect.fail(
          new VectorIndexOperationError(`Could not create vector generation for ${manifest.id}.`),
        );
      }

      yield* replaceVectorAliases(sql, building.generation, aliases);
      yield* removeUndesiredVectorRows(sql, building.generation);
      yield* mapReusableVectorRows(sql, building.generation);
      yield* removeInvalidVectorRows(sql, building.generation, dimensions);
      yield* pruneUnreferencedVectorValues(sql);

      const reusableChunkCount = yield* countVectorRows(sql, building.generation);
      if (building.state === 'ready' && reusableChunkCount === chunks.length) {
        yield* options.onProgress?.({
          completed: 0,
          phase: 'embedding',
          reused: reusableChunkCount,
          total: 0,
        }) ?? Effect.void;
        yield* options.onProgress?.({chunkCount: reusableChunkCount, phase: 'activating'}) ?? Effect.void;
        yield* activateVectorGenerationFenced(
          sql,
          building.generation,
          reusableChunkCount,
          options.corpusGeneration,
          manifest,
          options,
        );
        yield* pruneVectorGenerations(sql, building.generation);
        yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)');
        return vectorStatus(building, manifest.id, reusableChunkCount, 0, reusableChunkCount);
      }

      yield* sql`
        UPDATE vector_generations
        SET state = 'building', chunk_count = ${reusableChunkCount}
        WHERE generation = ${building.generation}
      `;
      const missingTotal = chunks.length - reusableChunkCount;
      let embeddedChunkCount = 0;
      yield* options.onProgress?.({
        completed: embeddedChunkCount,
        phase: 'embedding',
        reused: reusableChunkCount,
        total: missingTotal,
      }) ?? Effect.void;

      for (let pageStart = 0; pageStart < desiredChunks.length; pageStart += VECTOR_INDEX_PAGE_SIZE) {
        const page = desiredChunks.slice(pageStart, pageStart + VECTOR_INDEX_PAGE_SIZE);
        const existingIds = yield* selectExistingChunkIds(
          sql,
          building.generation,
          page.map(chunk => chunk.id),
        );
        const missing = page.filter(chunk => !existingIds.has(chunk.id));
        for (let start = 0; start < missing.length; start += VECTOR_INDEX_EMBED_BATCH_SIZE) {
          const batch = missing.slice(start, start + VECTOR_INDEX_EMBED_BATCH_SIZE);
          const vectors = yield* runtime.embedMany({
            inputs: batch.map(chunk => `${manifest.promptPrefixes?.document ?? ''}${chunk.content}`),
            manifest,
            modelPath: installed.path,
          });
          yield* verifyCurrentCorpusGeneration(manifest, options);
          const rows = batch.map(
            (chunk, index) =>
              [
                building!.generation,
                chunk.id,
                chunk.uri,
                chunk.fingerprint,
                chunk.vectorKey,
                encodeVector(normalizeVector(vectors[index]!), dimensions),
              ] as const,
          );
          yield* insertVectorRows(sql, rows);
          embeddedChunkCount += batch.length;
          yield* options.onProgress?.({
            completed: embeddedChunkCount,
            phase: 'embedding',
            reused: reusableChunkCount,
            total: missingTotal,
          }) ?? Effect.void;
        }
      }

      const finalChunkCount = yield* countVectorRows(sql, building.generation);
      if (finalChunkCount !== chunks.length) {
        return yield* Effect.fail(
          new VectorIndexOperationError(
            `Vector generation ${building.generation} has ${finalChunkCount}/${chunks.length} chunks.`,
          ),
        );
      }
      yield* options.onProgress?.({chunkCount: finalChunkCount, phase: 'activating'}) ?? Effect.void;
      yield* activateVectorGenerationFenced(
        sql,
        building.generation,
        finalChunkCount,
        options.corpusGeneration,
        manifest,
        options,
      );
      yield* pruneVectorGenerations(sql, building.generation);
      yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)');
      return vectorStatus(building, manifest.id, finalChunkCount, embeddedChunkCount, reusableChunkCount);
    }),
  );
  yield* removeLegacyVectorSidecars(fs, path, root);
  return status;
});

export const selectedSemanticScores = Effect.fn('vectorIndex.selectedSemanticScores')(function* <R = never>(
  config: {readonly agentContextHome: string},
  query: string,
  options: SemanticScoreOptions<R> = {},
) {
  const selection = yield* readModelSelection(config.agentContextHome);
  const modelId = selection.roles.embedding;
  if (!modelId) return undefined;
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(modelId);
  if (!manifest.dimensions || manifest.role !== 'embedding') return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = vectorDatabasePath(path, config.agentContextHome, manifest.id);
  if (!(yield* fs.exists(databasePath))) return undefined;
  const store = yield* LocalModelStore;
  const runtime = yield* LocalModelRuntime;
  const status = yield* store.status(config.agentContextHome, manifest);
  if (!status.installed) return undefined;

  const activeBeforeInference = yield* readActiveVectorGeneration(config.agentContextHome, manifest);
  if (!activeBeforeInference) return undefined;
  yield* verifySelectedCorpusGeneration(activeBeforeInference, manifest, options);
  const normalizedQuery =
    activeBeforeInference.chunk_count === 0
      ? Option.none<readonly number[]>()
      : Option.some(
          normalizeVector(
            (yield* runtime.embedMany({
              inputs: [`${manifest.promptPrefixes?.query ?? ''}${query}`],
              manifest,
              modelPath: status.path,
            }))[0]!,
          ),
        );

  const scores = yield* useVectorDatabaseReadOnly(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* validateVectorDatabase(sql);
          const active = yield* selectActiveGeneration(sql);
          if (!active || !generationIsCompatible(active, manifest)) return undefined;
          yield* verifySelectedCorpusGeneration(active, manifest, options);
          if (active.chunk_count === 0) return new Map<string, number>();
          if (Option.isNone(normalizedQuery)) {
            return yield* Effect.fail(
              new VectorIndexOperationError('The active vector corpus changed shape during semantic scoring.'),
            );
          }
          const limit = Math.min(active.chunk_count, options.limit ?? 500);
          let cursor = '';
          let best: readonly SemanticChunkMatch[] = [];
          for (;;) {
            const rows = yield* sql.unsafe<VectorRow>(
              `SELECT chunk.chunk_id, chunk.uri, chunk.fingerprint, value.vector
               FROM vector_chunks AS chunk
               JOIN vector_values AS value ON value.id = chunk.vector_id
               WHERE chunk.generation = ? AND chunk.chunk_id > ?
               ORDER BY chunk.chunk_id
               LIMIT ?`,
              [active.generation, cursor, VECTOR_INDEX_PAGE_SIZE],
            );
            if (rows.length === 0) break;
            const pageMatches = yield* Effect.try({
              try: () => searchEncodedVectorRows(normalizedQuery.value, rows, active.dimensions, limit),
              catch: cause =>
                new VectorIndexCorrupt({
                  message: cause instanceof Error ? cause.message : String(cause),
                  modelId: manifest.id,
                }),
            });
            best = mergeSemanticMatches(best, pageMatches, limit);
            cursor = rows.at(-1)!.chunk_id;
            if (rows.length < VECTOR_INDEX_PAGE_SIZE) break;
          }
          const scores = new Map<string, number>();
          for (const result of best) {
            scores.set(result.uri, Math.max(scores.get(result.uri) ?? 0, Math.max(0, result.score)));
          }
          const aliases = yield* loadVectorAliasesForRepresentatives(sql, active.generation, [...scores.keys()]);
          for (const alias of aliases) {
            const score = scores.get(alias.representative_uri);
            if (score !== undefined) scores.set(alias.uri, Math.max(scores.get(alias.uri) ?? 0, score));
          }
          return scores;
        }),
      );
    }),
  ).pipe(
    // Effect's generator inference does not retain the tagged error introduced by
    // the paged synchronous scorer, so make the public failure channel explicit.
    Effect.mapError(error => error as typeof error | VectorCorpusGenerationChanged | VectorIndexCorrupt),
  );
  // The SQLite transaction pins the vector snapshot. Re-check the independently
  // changing lexical corpus after releasing that read snapshot so a long paged
  // scan cannot return scores for a corpus that was superseded mid-query.
  yield* verifyCurrentCorpusGeneration(manifest, options);
  return scores;
});

export const vectorIndexStatus = Effect.fn('vectorIndex.status')(function* (
  home: string,
  manifest: LocalModelManifest,
  candidates?: readonly RecallCandidate[],
) {
  const active = yield* readActiveVectorGeneration(home, manifest).pipe(Effect.result);
  if (Result.isFailure(active)) {
    return {
      chunkCount: 0,
      modelId: manifest.id,
      ready: false,
      reason: active.failure instanceof Error ? active.failure.message : String(active.failure),
    } satisfies VectorIndexStatus;
  }
  if (!active.success) {
    return {chunkCount: 0, modelId: manifest.id, ready: false, reason: 'not built'} satisfies VectorIndexStatus;
  }
  const vectorIntegrity = yield* validateVectorGenerationRows(
    home,
    manifest,
    active.success.generation,
    active.success.dimensions,
  ).pipe(Effect.result);
  if (Result.isFailure(vectorIntegrity)) {
    return {
      chunkCount: active.success.chunk_count,
      dimensions: active.success.dimensions,
      modelId: manifest.id,
      ready: false,
      reason:
        vectorIntegrity.failure instanceof Error ? vectorIntegrity.failure.message : String(vectorIntegrity.failure),
    } satisfies VectorIndexStatus;
  }
  if (
    candidates &&
    !(yield* vectorGenerationMatchesChunks(
      home,
      manifest,
      active.success.generation,
      candidates.flatMap(candidate => chunkRecallDocument(candidate.uri, candidate.text)),
    ))
  ) {
    return {
      chunkCount: active.success.chunk_count,
      dimensions: active.success.dimensions,
      modelId: manifest.id,
      ready: false,
      reason: 'stale; canonical documents changed',
    } satisfies VectorIndexStatus;
  }
  return {
    chunkCount: active.success.chunk_count,
    createdAt: active.success.created_at,
    dimensions: active.success.dimensions,
    generation: active.success.generation,
    modelId: manifest.id,
    ready: true,
  } satisfies VectorIndexStatus;
});

export const purgeVectorIndex = Effect.fn('vectorIndex.purge')(function* (home: string, modelId: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withVectorIndexLock(fs, path, home, modelId, () =>
    Effect.gen(function* () {
      const root = vectorModelRoot(path, home, modelId);
      if (!(yield* fs.exists(root))) return false;
      yield* fs.remove(root, {recursive: true});
      return true;
    }),
  );
});

export function vectorIndexDatabaseFilename(): string {
  return VECTOR_INDEX_DATABASE_FILENAME;
}

const readActiveVectorGeneration = Effect.fn('vectorIndex.readActive')(function* (
  home: string,
  manifest: LocalModelManifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = vectorDatabasePath(path, home, manifest.id);
  if (!(yield* fs.exists(databasePath))) return undefined;
  return yield* useVectorDatabaseReadOnly(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* validateVectorDatabase(sql);
      const active = yield* selectActiveGeneration(sql);
      if (active && !generationIsCompatible(active, manifest)) {
        return yield* Effect.fail(
          new VectorIndexOperationError(`Vector index ${manifest.id}/${active.generation} is incompatible.`),
        );
      }
      return active;
    }),
  );
});

const vectorGenerationMatchesChunks = Effect.fn('vectorIndex.generationMatchesChunks')(function* (
  home: string,
  manifest: LocalModelManifest,
  generation: string,
  chunks: readonly RecallChunk[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = vectorDatabasePath(path, home, manifest.id);
  if (!(yield* fs.exists(databasePath))) return false;
  return yield* useVectorDatabaseReadOnly(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* validateVectorDatabase(sql);
      const expected = new Map(chunks.map(chunk => [chunk.id, chunk]));
      if (expected.size !== chunks.length) return false;
      let cursor = '';
      let count = 0;
      for (;;) {
        const rows = yield* sql.unsafe<Omit<VectorRow, 'vector'>>(
          `SELECT chunk_id, uri, fingerprint
           FROM vector_chunks
           WHERE generation = ? AND chunk_id > ?
           ORDER BY chunk_id
           LIMIT ?`,
          [generation, cursor, VECTOR_INDEX_PAGE_SIZE],
        );
        if (rows.length === 0) break;
        for (const row of rows) {
          const chunk = expected.get(row.chunk_id);
          if (!chunk || chunk.uri !== row.uri || chunk.fingerprint !== row.fingerprint) return false;
          count += 1;
        }
        cursor = rows.at(-1)!.chunk_id;
        if (rows.length < VECTOR_INDEX_PAGE_SIZE) break;
      }
      return count === chunks.length;
    }),
  );
});

const validateVectorGenerationRows = Effect.fn('vectorIndex.validateGenerationRows')(function* (
  home: string,
  manifest: LocalModelManifest,
  generation: string,
  dimensions: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = vectorDatabasePath(path, home, manifest.id);
  if (!(yield* fs.exists(databasePath))) {
    return yield* Effect.fail(new VectorIndexOperationError(`Vector database for ${manifest.id} is missing.`));
  }
  yield* useVectorDatabaseReadOnly(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* validateVectorDatabase(sql);
      let cursor = '';
      for (;;) {
        const rows = yield* sql.unsafe<VectorRow>(
          `SELECT chunk.chunk_id, chunk.uri, chunk.fingerprint, value.vector
           FROM vector_chunks AS chunk
           JOIN vector_values AS value ON value.id = chunk.vector_id
           WHERE chunk.generation = ? AND chunk.chunk_id > ?
           ORDER BY chunk.chunk_id
           LIMIT ?`,
          [generation, cursor, VECTOR_INDEX_PAGE_SIZE],
        );
        if (rows.length === 0) break;
        for (const row of rows) {
          const cause = encodedVectorValidationFailure(row.vector, dimensions);
          if (cause !== undefined) {
            return yield* Effect.fail(
              new VectorIndexOperationError(
                `Vector chunk ${row.chunk_id} is corrupt: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
            );
          }
        }
        cursor = rows.at(-1)!.chunk_id;
        if (rows.length < VECTOR_INDEX_PAGE_SIZE) break;
      }
    }),
  );
});

const initializeVectorDatabaseWithRecovery = Effect.fn('vectorIndex.initializeWithRecovery')(function* (
  fs: FileSystem.FileSystem,
  databasePath: string,
) {
  const initialize = useVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      yield* initializeVectorDatabase(yield* SqlClient.SqlClient);
    }),
  );
  yield* initialize.pipe(
    Effect.catchCause(() =>
      removeVectorDatabaseFiles(fs, databasePath).pipe(
        Effect.andThen(
          useVectorDatabase(
            databasePath,
            Effect.gen(function* () {
              yield* initializeVectorDatabase(yield* SqlClient.SqlClient);
            }),
          ),
        ),
      ),
    ),
  );
});

const initializeVectorDatabase = Effect.fn('vectorIndex.initializeDatabase')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  yield* sql.unsafe('PRAGMA journal_mode = WAL');
  const versions = yield* sql.unsafe<{readonly user_version: number}>('PRAGMA user_version');
  const version = Number(versions[0]?.user_version ?? 0);
  if (version !== 0 && version !== VECTOR_INDEX_DATABASE_VERSION) {
    yield* sql.unsafe('DROP TABLE IF EXISTS vector_pointer');
    yield* sql.unsafe('DROP TABLE IF EXISTS vector_aliases');
    yield* sql.unsafe('DROP TABLE IF EXISTS vector_chunks');
    yield* sql.unsafe('DROP TABLE IF EXISTS vector_generations');
    yield* sql.unsafe('DROP TABLE IF EXISTS vector_values');
  }
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS vector_generations (
      generation TEXT PRIMARY KEY,
      job_id TEXT UNIQUE NOT NULL,
      corpus_generation TEXT,
      model_id TEXT NOT NULL,
      model_sha256 TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK(dimensions > 0),
      embedding_recipe TEXT NOT NULL,
      chunker_version INTEGER NOT NULL CHECK(chunker_version > 0),
      normalized TEXT NOT NULL CHECK(normalized = 'l2'),
      chunk_count INTEGER NOT NULL CHECK(chunk_count >= 0),
      state TEXT NOT NULL CHECK(state IN ('building', 'ready')),
      created_at TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS vector_pointer (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      generation TEXT NOT NULL REFERENCES vector_generations(generation)
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS vector_values (
      id INTEGER PRIMARY KEY,
      vector_key TEXT UNIQUE NOT NULL,
      vector BLOB NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS vector_chunks (
      generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE,
      chunk_id TEXT NOT NULL,
      uri TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      vector_id INTEGER NOT NULL REFERENCES vector_values(id),
      PRIMARY KEY (generation, chunk_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS vector_aliases (
      generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE,
      uri TEXT NOT NULL,
      representative_uri TEXT NOT NULL,
      PRIMARY KEY (generation, uri)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS vector_chunks_by_value ON vector_chunks (vector_id)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS vector_aliases_by_representative ON vector_aliases (generation, representative_uri, uri)',
  );
  yield* sql.unsafe(`PRAGMA user_version = ${VECTOR_INDEX_DATABASE_VERSION}`);
  yield* validateVectorDatabaseStructure(sql);
});

const validateVectorDatabase = Effect.fn('vectorIndex.validateDatabase')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  const versions = yield* sql.unsafe<{readonly user_version: number}>('PRAGMA user_version');
  const version = Number(versions[0]?.user_version ?? 0);
  if (version !== VECTOR_INDEX_DATABASE_VERSION) {
    return yield* Effect.fail(
      new VectorIndexOperationError(
        `Unsupported vector index schema ${version}; expected ${VECTOR_INDEX_DATABASE_VERSION}.`,
      ),
    );
  }
  yield* validateVectorDatabaseStructure(sql);
});

const validateVectorDatabaseStructure = Effect.fn('vectorIndex.validateDatabaseStructure')(function* (
  sql: SqlClient.SqlClient,
) {
  for (const [table, expected] of Object.entries(VECTOR_INDEX_SCHEMA_COLUMNS)) {
    const rows = yield* sql.unsafe<{readonly name: string}>(`PRAGMA table_info('${table}')`);
    const actual = rows.map(row => row.name);
    if (actual.length !== expected.length || actual.some((column, index) => column !== expected[index])) {
      return yield* Effect.fail(
        new VectorIndexOperationError(
          `Vector index table ${table} has invalid columns: ${actual.length > 0 ? actual.join(', ') : '(missing)'}.`,
        ),
      );
    }
  }
});

const selectActiveGeneration = Effect.fn('vectorIndex.selectActiveGeneration')(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql.unsafe<VectorGenerationRow>(
    `SELECT
       generation.*,
       (SELECT COUNT(*) FROM vector_chunks WHERE vector_chunks.generation = generation.generation)
         AS actual_chunk_count
     FROM vector_pointer AS pointer
     JOIN vector_generations AS generation ON generation.generation = pointer.generation
     WHERE pointer.singleton = 1 AND generation.state = 'ready'
     LIMIT 1`,
  );
  const active = rows[0];
  if (!active) return undefined;
  assertVectorGeneration(active);
  if (Number(active.actual_chunk_count) !== Number(active.chunk_count)) {
    return yield* Effect.fail(
      new VectorIndexOperationError(
        `Vector generation ${active.generation} contains ${active.actual_chunk_count}/${active.chunk_count} chunks.`,
      ),
    );
  }
  return active;
});

const selectGenerationByJob = Effect.fn('vectorIndex.selectGenerationByJob')(function* (
  sql: SqlClient.SqlClient,
  jobId: string,
) {
  const rows = yield* sql.unsafe<VectorGenerationRow>(
    `SELECT
       generation.*,
       (SELECT COUNT(*) FROM vector_chunks WHERE vector_chunks.generation = generation.generation)
         AS actual_chunk_count
     FROM vector_generations AS generation
     WHERE generation.job_id = ?
     LIMIT 1`,
    [jobId],
  );
  const generation = rows[0];
  if (generation) assertVectorGeneration(generation);
  return generation;
});

const prepareDesiredChunks = Effect.fn('vectorIndex.prepareDesiredChunks')(function* (
  sql: SqlClient.SqlClient,
  chunks: readonly DesiredVectorChunk[],
) {
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS desired_vector_chunks (
      chunk_id TEXT PRIMARY KEY,
      uri TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      vector_key TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('DELETE FROM desired_vector_chunks');
  for (let start = 0; start < chunks.length; start += VECTOR_INDEX_INSERT_BATCH_SIZE) {
    const batch = chunks.slice(start, start + VECTOR_INDEX_INSERT_BATCH_SIZE);
    yield* sql.unsafe(
      `INSERT INTO desired_vector_chunks (chunk_id, uri, fingerprint, vector_key)
       VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')}`,
      batch.flatMap(chunk => [chunk.id, chunk.uri, chunk.fingerprint, chunk.vectorKey]),
    );
  }
});

const replaceVectorAliases = Effect.fn('vectorIndex.replaceAliases')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  aliases: readonly {readonly representativeUri: string; readonly uri: string}[],
) {
  yield* sql`DELETE FROM vector_aliases WHERE generation = ${generation}`;
  for (let start = 0; start < aliases.length; start += VECTOR_INDEX_INSERT_BATCH_SIZE) {
    const batch = aliases.slice(start, start + VECTOR_INDEX_INSERT_BATCH_SIZE);
    yield* sql.unsafe(
      `INSERT INTO vector_aliases (generation, uri, representative_uri)
       VALUES ${batch.map(() => '(?, ?, ?)').join(', ')}`,
      batch.flatMap(alias => [generation, alias.uri, alias.representativeUri]),
    );
  }
});

const loadVectorAliasesForRepresentatives = Effect.fn('vectorIndex.loadAliasesForRepresentatives')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  representativeUris: readonly string[],
) {
  const aliases: VectorAliasRow[] = [];
  for (let start = 0; start < representativeUris.length; start += VECTOR_INDEX_INSERT_BATCH_SIZE) {
    const batch = representativeUris.slice(start, start + VECTOR_INDEX_INSERT_BATCH_SIZE);
    aliases.push(
      ...(yield* sql.unsafe<VectorAliasRow>(
        `SELECT uri, representative_uri
         FROM vector_aliases
         WHERE generation = ? AND representative_uri IN (${batch.map(() => '?').join(', ')})
         ORDER BY representative_uri, uri`,
        [generation, ...batch],
      )),
    );
  }
  return aliases;
});

const removeUndesiredVectorRows = Effect.fn('vectorIndex.removeUndesiredRows')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
) {
  yield* sql.unsafe(
    `DELETE FROM vector_chunks
     WHERE generation = ?
       AND NOT EXISTS (
         SELECT 1
         FROM desired_vector_chunks AS desired
         WHERE desired.chunk_id = vector_chunks.chunk_id
           AND desired.uri = vector_chunks.uri
           AND desired.fingerprint = vector_chunks.fingerprint
       )`,
    [generation],
  );
});

const mapReusableVectorRows = Effect.fn('vectorIndex.mapReusableRows')(function* (
  sql: SqlClient.SqlClient,
  buildingGeneration: string,
) {
  yield* sql.unsafe(
    `INSERT OR IGNORE INTO vector_chunks (generation, chunk_id, uri, fingerprint, vector_id)
     SELECT ?, desired.chunk_id, desired.uri, desired.fingerprint, value.id
     FROM desired_vector_chunks AS desired
     JOIN vector_values AS value ON value.vector_key = desired.vector_key`,
    [buildingGeneration],
  );
});

const removeInvalidVectorRows = Effect.fn('vectorIndex.removeInvalidRows')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  dimensions: number,
) {
  let cursor = '';
  for (;;) {
    const rows = yield* sql.unsafe<VectorRow>(
      `SELECT chunk.chunk_id, chunk.uri, chunk.fingerprint, value.vector
       FROM vector_chunks AS chunk
       JOIN vector_values AS value ON value.id = chunk.vector_id
       WHERE chunk.generation = ? AND chunk.chunk_id > ?
       ORDER BY chunk.chunk_id
       LIMIT ?`,
      [generation, cursor, VECTOR_INDEX_PAGE_SIZE],
    );
    if (rows.length === 0) break;
    const invalid: string[] = [];
    for (const row of rows) {
      if (encodedVectorValidationFailure(row.vector, dimensions) !== undefined) invalid.push(row.chunk_id);
    }
    if (invalid.length > 0) {
      yield* sql.unsafe(
        `DELETE FROM vector_chunks
         WHERE generation = ? AND chunk_id IN (${invalid.map(() => '?').join(', ')})`,
        [generation, ...invalid],
      );
    }
    cursor = rows.at(-1)!.chunk_id;
    if (rows.length < VECTOR_INDEX_PAGE_SIZE) break;
  }
});

const selectExistingChunkIds = Effect.fn('vectorIndex.selectExistingChunkIds')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  chunkIds: readonly string[],
) {
  if (chunkIds.length === 0) return new Set<string>();
  const rows = yield* sql.unsafe<{readonly chunk_id: string}>(
    `SELECT chunk_id
     FROM vector_chunks
     WHERE generation = ? AND chunk_id IN (${chunkIds.map(() => '?').join(', ')})`,
    [generation, ...chunkIds],
  );
  return new Set(rows.map(row => row.chunk_id));
});

function insertVectorRows(
  sql: SqlClient.SqlClient,
  rows: readonly (readonly [string, string, string, string, string, Uint8Array])[],
) {
  return Effect.gen(function* () {
    for (let start = 0; start < rows.length; start += VECTOR_INDEX_INSERT_BATCH_SIZE) {
      const batch = rows.slice(start, start + VECTOR_INDEX_INSERT_BATCH_SIZE);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* insertVectorValues(
            sql,
            batch.map(row => [row[4], row[5]] as const),
          );
          const values = yield* sql.unsafe<{readonly id: number; readonly vector_key: string}>(
            `SELECT id, vector_key
             FROM vector_values
             WHERE vector_key IN (${batch.map(() => '?').join(', ')})`,
            batch.map(row => row[4]),
          );
          const idByKey = new Map(values.map(value => [value.vector_key, Number(value.id)]));
          const mappings = batch.map(row => {
            const vectorId = idByKey.get(row[4]);
            if (vectorId === undefined) {
              throw new VectorIndexOperationError(`Could not resolve stored vector ${row[4]}.`);
            }
            return [row[0], row[1], row[2], row[3], vectorId] as const;
          });
          yield* sql.unsafe(
            `INSERT OR REPLACE INTO vector_chunks (generation, chunk_id, uri, fingerprint, vector_id)
             VALUES ${mappings.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
            mappings.flat(),
          );
        }),
      );
    }
  });
}

function insertVectorValues(sql: SqlClient.SqlClient, rows: readonly (readonly [string, Uint8Array])[]) {
  return Effect.gen(function* () {
    for (let start = 0; start < rows.length; start += VECTOR_INDEX_INSERT_BATCH_SIZE) {
      const batch = rows.slice(start, start + VECTOR_INDEX_INSERT_BATCH_SIZE);
      yield* sql.unsafe(
        `INSERT INTO vector_values (vector_key, vector)
         VALUES ${batch.map(() => '(?, ?)').join(', ')}
         ON CONFLICT(vector_key) DO UPDATE SET vector = excluded.vector`,
        batch.flat(),
      );
    }
  });
}

const pruneUnreferencedVectorValues = Effect.fn('vectorIndex.pruneUnreferencedValues')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(
    `DELETE FROM vector_values
     WHERE NOT EXISTS (
       SELECT 1
       FROM vector_chunks
       WHERE vector_chunks.vector_id = vector_values.id
     )`,
  );
});

const countVectorRows = Effect.fn('vectorIndex.countRows')(function* (sql: SqlClient.SqlClient, generation: string) {
  const rows = yield* sql.unsafe<{readonly count: number}>(
    'SELECT COUNT(*) AS count FROM vector_chunks WHERE generation = ?',
    [generation],
  );
  return Number(rows[0]?.count ?? 0);
});

const activateVectorGenerationFenced = Effect.fn('vectorIndex.activateGenerationFenced')(function* <R = never>(
  sql: SqlClient.SqlClient,
  generation: string,
  chunkCount: number,
  corpusGeneration: string | undefined,
  manifest: LocalModelManifest,
  options: VectorCorpusGenerationOptions<R>,
) {
  yield* verifyCurrentCorpusGeneration(manifest, options);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        UPDATE vector_generations
        SET
          state = 'ready',
          chunk_count = ${chunkCount},
          corpus_generation = ${corpusGeneration ?? null}
        WHERE generation = ${generation}
      `;
      // Keep the vector write transaction open across the last pre-commit
      // observation. The post-commit check below handles the remaining
      // cross-database gap without ever pruning the previous generation first.
      yield* verifyCurrentCorpusGeneration(manifest, options);
      yield* sql`
        INSERT INTO vector_pointer (singleton, generation)
        VALUES (1, ${generation})
        ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation
      `;
    }),
  );
  const postActivationFence = yield* verifyCurrentCorpusGeneration(manifest, options).pipe(Effect.result);
  if (Result.isFailure(postActivationFence)) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe('DELETE FROM vector_pointer WHERE singleton = 1 AND generation = ?', [generation]);
        yield* sql`UPDATE vector_generations SET state = 'building' WHERE generation = ${generation}`;
      }),
    );
    return yield* Effect.fail(postActivationFence.failure);
  }
});

const pruneVectorGenerations = Effect.fn('vectorIndex.pruneGenerations')(function* (
  sql: SqlClient.SqlClient,
  activeGeneration: string,
) {
  yield* sql`DELETE FROM vector_generations WHERE state = 'building'`;
  yield* sql.unsafe('DELETE FROM vector_generations WHERE state = ? AND generation <> ?', ['ready', activeGeneration]);
  yield* pruneUnreferencedVectorValues(sql);
});

function vectorStatus(
  generation: VectorGenerationRow,
  modelId: string,
  chunkCount: number,
  embeddedChunkCount: number,
  reusedChunkCount: number,
): VectorIndexStatus {
  return {
    chunkCount,
    createdAt: generation.created_at,
    dimensions: generation.dimensions,
    embeddedChunkCount,
    generation: generation.generation,
    modelId,
    ready: true,
    reusedChunkCount,
  };
}

function encodeVector(vector: readonly number[], dimensions: number): Uint8Array {
  if (vector.length !== dimensions) {
    throw new VectorIndexOperationError(`Vector has ${vector.length} dimensions; expected ${dimensions}.`);
  }
  const bytes = new Uint8Array(dimensions * 4);
  const view = new DataView(bytes.buffer);
  let squaredMagnitude = 0;
  for (const [index, component] of vector.entries()) {
    if (!Number.isFinite(component)) throw new VectorIndexOperationError('Vector contains a non-finite component.');
    squaredMagnitude += component * component;
    view.setFloat32(index * 4, component, true);
  }
  if (Math.abs(Math.sqrt(squaredMagnitude) - 1) > 0.001) {
    throw new VectorIndexOperationError('Vector is not L2-normalized.');
  }
  return bytes;
}

function validateEncodedVector(value: unknown, dimensions: number): void {
  const bytes = bytesFromSqlBlob(value);
  if (bytes.byteLength !== dimensions * 4) {
    throw new VectorIndexOperationError(`Stored vector has ${bytes.byteLength} bytes; expected ${dimensions * 4}.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let squaredMagnitude = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const component = view.getFloat32(index * 4, true);
    if (!Number.isFinite(component)) {
      throw new VectorIndexOperationError('Stored vector contains a non-finite component.');
    }
    squaredMagnitude += component * component;
  }
  if (Math.abs(Math.sqrt(squaredMagnitude) - 1) > 0.002) {
    throw new VectorIndexOperationError('Stored vector is not L2-normalized.');
  }
}

function encodedVectorValidationFailure(value: unknown, dimensions: number): unknown | undefined {
  try {
    validateEncodedVector(value, dimensions);
    return undefined;
  } catch (cause) {
    return cause;
  }
}

function bytesFromSqlBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new VectorIndexOperationError('Stored vector is not a binary SQLite value.');
}

function mergeSemanticMatches(
  left: readonly SemanticChunkMatch[],
  right: readonly SemanticChunkMatch[],
  limit: number,
): readonly SemanticChunkMatch[] {
  return [...left, ...right].sort(compareVectorMatches).slice(0, limit);
}

function searchEncodedVectorRows(
  normalizedQuery: readonly number[],
  rows: readonly VectorRow[],
  dimensions: number,
  limit: number,
): readonly SemanticChunkMatch[] {
  if (normalizedQuery.length !== dimensions) {
    throw new VectorIndexOperationError(
      `Query vector has ${normalizedQuery.length} dimensions; expected ${dimensions}.`,
    );
  }
  const matches: SemanticChunkMatch[] = [];
  for (const row of rows) {
    const bytes = bytesFromSqlBlob(row.vector);
    if (bytes.byteLength !== dimensions * 4) {
      throw new VectorIndexOperationError(
        `Stored vector ${row.chunk_id} has ${bytes.byteLength} bytes; expected ${dimensions * 4}.`,
      );
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let score = 0;
    let squaredMagnitude = 0;
    for (let index = 0; index < dimensions; index += 1) {
      const component = view.getFloat32(index * 4, true);
      if (!Number.isFinite(component)) {
        throw new VectorIndexOperationError(`Stored vector ${row.chunk_id} contains a non-finite component.`);
      }
      squaredMagnitude += component * component;
      score += normalizedQuery[index]! * component;
    }
    if (Math.abs(Math.sqrt(squaredMagnitude) - 1) > 0.002) {
      throw new VectorIndexOperationError(`Stored vector ${row.chunk_id} is not L2-normalized.`);
    }
    matches.push({
      id: row.chunk_id,
      score: Math.max(-1, Math.min(1, score)),
      uri: row.uri,
    });
  }
  return matches.sort(compareVectorMatches).slice(0, Math.min(limit, matches.length));
}

function compareVectorMatches(left: VectorSearchResult, right: VectorSearchResult): number {
  return right.score - left.score || compareCodeUnits(left.id, right.id);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function generationMatchesCorpus(
  generation: VectorGenerationRow,
  manifest: LocalModelManifest,
  corpusGeneration: string,
): boolean {
  return generation.corpus_generation === corpusGeneration && generationIsCompatible(generation, manifest);
}

function generationIsCompatible(generation: VectorGenerationRow, manifest: LocalModelManifest): boolean {
  return (
    generation.model_id === manifest.id &&
    generation.model_sha256 === manifest.sha256 &&
    generation.dimensions === manifest.dimensions &&
    generation.embedding_recipe === embeddingRecipe(manifest) &&
    generation.chunker_version === RECALL_CHUNKER_VERSION &&
    generation.normalized === 'l2'
  );
}

function embeddingRecipe(manifest: LocalModelManifest): string {
  // Native backend/offload policy is intentionally excluded: the frozen Darwin
  // compatibility fixture verifies that it preserves this embedding space.
  return sha256HexSync(
    [
      'threadnote-recall-embedding-v1',
      manifest.sha256,
      String(manifest.dimensions ?? 0),
      manifest.promptPrefixes?.document ?? '',
      'l2',
    ].join('\0'),
  );
}

function vectorKeyForChunk(recipe: string, chunk: RecallChunk): string {
  return sha256HexSync(`${recipe}\0${chunk.fingerprint}`);
}

function assertVectorGeneration(generation: VectorGenerationRow): void {
  if (
    !generation.generation ||
    !/^[0-9]+-[a-f0-9-]+$/.test(generation.generation) ||
    !/^[0-9a-f]{64}$/.test(generation.job_id) ||
    !generation.model_id ||
    !/^[0-9a-f]{64}$/.test(generation.model_sha256) ||
    !/^[0-9a-f]{64}$/.test(generation.embedding_recipe) ||
    !Number.isInteger(generation.dimensions) ||
    generation.dimensions <= 0 ||
    !Number.isInteger(generation.chunker_version) ||
    generation.chunker_version <= 0 ||
    generation.normalized !== 'l2' ||
    !Number.isInteger(Number(generation.chunk_count)) ||
    Number(generation.chunk_count) < 0 ||
    !Number.isInteger(Number(generation.actual_chunk_count)) ||
    Number(generation.actual_chunk_count) < 0 ||
    !['building', 'ready'].includes(generation.state) ||
    !generation.created_at
  ) {
    throw new VectorIndexOperationError(
      `Vector generation ${generation.generation || '<unknown>'} metadata is invalid.`,
    );
  }
}

function vectorDatabasePath(path: Path.Path, home: string, modelId: string): string {
  return path.join(vectorModelRoot(path, home, modelId), VECTOR_INDEX_DATABASE_FILENAME);
}

function vectorModelRoot(path: Path.Path, home: string, modelId: string): string {
  return path.join(home, 'indexes', 'vectors', modelId);
}

function useVectorDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    Layer.build(SqliteClient.layer({filename: databasePath})).pipe(
      Effect.flatMap(context => effect.pipe(Effect.provide(context))),
    ),
  );
}

function useVectorDatabaseReadOnly<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    Layer.build(
      SqliteClient.layer({
        create: false,
        disableWAL: true,
        filename: databasePath,
        readonly: true,
        readwrite: false,
      }),
    ).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
  );
}

function removeVectorDatabaseFiles(fs: FileSystem.FileSystem, databasePath: string): Effect.Effect<void, never> {
  return Effect.all(
    [databasePath, `${databasePath}-shm`, `${databasePath}-wal`].map(candidate =>
      fs.remove(candidate, {force: true}).pipe(Effect.catch(() => Effect.void)),
    ),
    {discard: true},
  ).pipe(Effect.asVoid);
}

const removeLegacyVectorSidecars = Effect.fn('vectorIndex.removeLegacySidecars')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) {
  for (const legacy of ['active.json', 'generations', 'staging']) {
    yield* fs.remove(path.join(root, legacy), {force: true, recursive: true}).pipe(Effect.catch(() => Effect.void));
  }
  for (let version = 1; version < VECTOR_INDEX_DATABASE_VERSION; version += 1) {
    yield* removeVectorDatabaseFiles(fs, path.join(root, `vectors-v${version}.sqlite`));
  }
});

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

export function chunksForRecallCandidates(candidates: readonly RecallCandidate[]): readonly RecallChunk[] {
  return candidates.flatMap(candidate => chunkRecallDocument(candidate.uri, candidate.text));
}
