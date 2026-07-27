import {Cause, Clock, Crypto, Effect, FileSystem, Option, Path} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {SEED_STATE_FILE} from '../constants.js';
import {sha256Hex} from '../effect/digest.js';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {scanFilesWithinBoundary} from '../effect/safe_scan.js';
import {SystemInfo} from '../effect/system.js';
import {parseSeedManifest, uriSegment} from '../manifest.js';
import {
  boundedMemoryAuthority,
  boundedMemoryTrust,
  parseMemoryDocument,
  type MemoryRelation,
} from '../memory_document.js';
import {redactSensitiveText} from '../scrubber.js';
import {canonicalResourceUri, parseResourceId} from '../storage/resource-id.js';
import type {ProjectManifest} from '../types.js';
import {expandPath, globToRegExp} from '../utils.js';
import {recallDocumentTerms, type RecallCandidate, type RecallCorpusStatistics} from './rank.js';

interface RecallIndexSource {
  readonly modifiedAt?: string;
  readonly path: string;
  readonly size: number;
  readonly uri: string;
}

interface RecallIndexPosting {
  readonly documentLength: number;
  readonly fieldWeight: number;
  readonly termFrequency: number;
  readonly uri: string;
}

interface CanonicalResourcePolicy {
  readonly entryKeyByUri: ReadonlyMap<string, string>;
  readonly sourcePathByUri: ReadonlyMap<string, string>;
}

interface SeedStateEntry {
  readonly mtimeMs: number;
  readonly size: number;
}

interface RecallIndexConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

export interface RecallIndexData {
  readonly candidates: readonly RecallCandidate[];
  readonly corpusStatistics: RecallCorpusStatistics;
  readonly generation: string;
}

export type RecallIndexProgress =
  | {
      readonly completed: number;
      readonly phase: 'indexing';
      readonly scanned: number;
      readonly total: number;
    }
  | {
      readonly completed: number;
      readonly phase: 'writing';
      readonly removed: number;
      readonly total: number;
    }
  | {
      readonly documentCount: number;
      readonly phase: 'activating';
    };

export interface RecallIndexQueryDiagnostics {
  readonly postingRows: number;
  readonly postingStatements: number;
  readonly queryTerms: number;
}

interface RecallDocumentRow {
  readonly candidate_json: string;
  readonly id: number;
  readonly uri: string;
}

interface RecallDocumentSourceRow extends RecallDocumentRow {
  readonly authority_policy_key: string | null;
  readonly source_modified_at: string | null;
  readonly source_path: string;
  readonly source_size: number;
}

interface RecallMetadataRow {
  readonly key: string;
  readonly value: string;
}

interface RecallPostingRow {
  readonly document_id: number;
  readonly document_length: number;
  readonly field_weight: number;
  readonly term: string;
  readonly term_frequency: number;
  readonly uri: string;
}

interface RecallTermStatisticRow {
  readonly document_frequency: number;
  readonly term: string;
}

interface RecallQueryTermStatistics {
  readonly documentCount: number;
  readonly documentFrequency: Readonly<Record<string, number>>;
}

interface IndexedRecallSource {
  readonly candidate: RecallCandidate;
  readonly documentLength: number;
  readonly postings: ReadonlyMap<string, RecallIndexPosting>;
  readonly source: RecallIndexSource;
}

const RECALL_INDEX_DATABASE_VERSION = 2;
const RECALL_INDEX_POINTER_VERSION = 1;
const ACTIVE_DATABASE_FILENAME = `active-v${RECALL_INDEX_DATABASE_VERSION}.sqlite`;
const INACTIVE_DATABASE_FILENAME = `with-inactive-v${RECALL_INDEX_DATABASE_VERSION}.sqlite`;
const CACHE_VALIDATION_INTERVAL_MILLISECONDS = 30_000;
const MAX_INDEXED_FILE_BYTES = 512 * 1_024;
const DEFAULT_QUERY_RESULT_LIMIT = 100;
const QUERY_POSTING_POOL_MULTIPLIER = 5;
const MINIMUM_QUERY_POSTING_POOL = 500;
const MAX_QUERY_TERMS = 32;
const POSTING_IDENTIFIER_WEIGHT = 4;
const POSTING_TITLE_WEIGHT = 3;
const POSTING_TOPIC_WEIGHT = 2;
const POSTING_KEYWORD_WEIGHT = 2;
const POSTING_PROJECT_WEIGHT = 1;
const POSTING_BODY_WEIGHT = 1;
const POSTING_BM25_SATURATION = 1.2;
const POSTING_BM25_LENGTH_NORMALIZATION = 0.75;
const POSTING_BM25_IDF_SMOOTHING = 0.5;
const SEED_FILE_MTIME_TOLERANCE_MILLISECONDS = 1;
const TEXT_EXTENSIONS = new Set(['.json', '.md', '.mdx', '.txt', '.yaml', '.yml']);
const IDENTIFIER_PATTERN = /[a-z0-9][a-z0-9_.-]{2,}/gi;
let staleGenerationCounter = 0;

interface RecallIndexPointer {
  readonly database: string;
  readonly version: typeof RECALL_INDEX_POINTER_VERSION;
}

class RecallIndexCorrupt extends Error {
  override readonly name = 'RecallIndexCorrupt';
}

class RecallIndexSchemaIncompatible extends Error {
  override readonly name = 'RecallIndexSchemaIncompatible';
}

interface LoadRecallIndexOptions {
  readonly allowedUriScopes?: readonly string[];
  readonly forceRefresh?: boolean;
  readonly includeInactive: boolean;
  readonly limit?: number;
  readonly onQueryDiagnostics?: (diagnostics: RecallIndexQueryDiagnostics) => Effect.Effect<void, unknown>;
  readonly onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>;
  readonly project?: string;
  readonly query?: string;
  readonly requiredUris?: readonly string[];
}

interface LoadRecallIndexBatchOptions {
  readonly forceRefresh?: boolean;
  readonly includeInactive: boolean;
  readonly onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>;
  readonly selections: readonly Omit<LoadRecallIndexOptions, 'forceRefresh' | 'includeInactive'>[];
}

const loadRecallIndexDataInternal = Effect.fn('recall.loadIndexDataInternal')(function* (
  config: RecallIndexConfig,
  options: LoadRecallIndexOptions | LoadRecallIndexBatchOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const fixedDatabasePath = recallIndexDatabasePath(pathService, config.agentContextHome, options.includeInactive);
  yield* fs.makeDirectory(pathService.dirname(fixedDatabasePath), {recursive: true, mode: 0o700});
  const databasePath = yield* resolveActiveRecallDatabasePath(
    fs,
    pathService,
    config.agentContextHome,
    options.includeInactive,
  );
  return yield* executeRecallIndexQuery(databasePath, fixedDatabasePath, config, options).pipe(
    Effect.catchCause(firstCause =>
      isRecoverableRecallIndexCause(firstCause)
        ? recoverRecallIndex(fs, pathService, databasePath, fixedDatabasePath, config, options, firstCause)
        : Effect.failCause(firstCause),
    ),
  );
});

const executeRecallIndexQuery = Effect.fn('recall.executeIndexQuery')(function* (
  databasePath: string,
  staleMarkerBasePath: string,
  config: RecallIndexConfig,
  options: LoadRecallIndexOptions | LoadRecallIndexBatchOptions,
  prepareForActivation = false,
  indexLockHeld = false,
) {
  return yield* useRecallDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* initializeRecallDatabase(sql);
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      yield* fs.chmod(databasePath, 0o600);
      yield* ensureRecallDatabaseFresh(
        sql,
        fs,
        pathService,
        databasePath,
        staleMarkerBasePath,
        config,
        options,
        indexLockHeld,
      );
      const metadata = yield* loadRecallMetadata(sql);
      const generation = metadata.get('content_generation') ?? '';
      const corpusStatistics = yield* loadRecallCorpusStatistics(sql, recallStatisticTerms(options));
      const result =
        'selections' in options
          ? yield* Effect.forEach(
              options.selections,
              selection =>
                selectRecallIndexData(sql, corpusStatistics, generation, {
                  ...selection,
                  includeInactive: options.includeInactive,
                }),
              {concurrency: 1},
            )
          : yield* selectRecallIndexData(sql, corpusStatistics, generation, options);
      if (prepareForActivation) {
        yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)');
        yield* sql.unsafe('PRAGMA journal_mode = DELETE');
      }
      return result;
    }),
  );
});

const recoverRecallIndex = Effect.fn('recall.recoverIndex')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  failedDatabasePath: string,
  staleMarkerBasePath: string,
  config: RecallIndexConfig,
  options: LoadRecallIndexOptions | LoadRecallIndexBatchOptions,
  firstCause: Cause.Cause<unknown>,
) {
  return yield* withRecallIndexLock(fs, path, config.agentContextHome, options.includeInactive, () =>
    Effect.gen(function* () {
      const activePath = yield* resolveActiveRecallDatabasePath(
        fs,
        path,
        config.agentContextHome,
        options.includeInactive,
      );
      if (activePath !== failedDatabasePath) {
        return yield* executeRecallIndexQuery(activePath, staleMarkerBasePath, config, options);
      }
      const system = yield* SystemInfo;
      const generation = `${yield* Clock.currentTimeMillis}-${system.processId}-${nextRecallGenerationCounter()}`;
      const root = recallIndexRoot(path, config.agentContextHome);
      const relativeDatabasePath = path.join(
        'generations',
        `${options.includeInactive ? 'with-inactive' : 'active'}-${generation}.sqlite`,
      );
      const replacementPath = path.join(root, relativeDatabasePath);
      yield* fs.makeDirectory(path.dirname(replacementPath), {recursive: true, mode: 0o700});
      const replacementOptions = {...options, forceRefresh: true};
      const rebuilt = yield* executeRecallIndexQuery(
        replacementPath,
        staleMarkerBasePath,
        config,
        replacementOptions,
        true,
        true,
      ).pipe(
        Effect.catchCause(secondCause =>
          Effect.fail(
            new Error(
              `Lexical recall index recovery failed: ${Cause.pretty(firstCause)}; replacement failed: ${Cause.pretty(secondCause)}`,
            ),
          ),
        ),
        Effect.ensuring(removeRecallDatabaseAuxiliaryFiles(fs, replacementPath).pipe(Effect.catch(() => Effect.void))),
      );
      yield* writeActiveRecallDatabasePointer(
        fs,
        path,
        config.agentContextHome,
        options.includeInactive,
        relativeDatabasePath,
      );
      return rebuilt;
    }),
  );
});

export const loadRecallIndexData = Effect.fn('recall.loadIndexData')(function* (
  config: RecallIndexConfig,
  options: LoadRecallIndexOptions,
) {
  return (yield* loadRecallIndexDataInternal(config, options)) as RecallIndexData;
});

export const loadRecallIndexDataBatch = Effect.fn('recall.loadIndexDataBatch')(function* (
  config: RecallIndexConfig,
  options: LoadRecallIndexBatchOptions,
) {
  return (yield* loadRecallIndexDataInternal(config, options)) as readonly RecallIndexData[];
});

export const loadRecallIndex = Effect.fn('recall.loadIndex')(function* (
  config: RecallIndexConfig,
  options: LoadRecallIndexOptions,
) {
  return (yield* loadRecallIndexData(config, options)).candidates;
});

export const clearRecallIndexMemoryCache = Effect.fn('recall.clearMemoryCache')(function* () {
  // SQLite owns its page cache and every operation uses a scoped connection.
  yield* Effect.void;
});

export const expireRecallIndexValidation = Effect.fn('recall.expireValidation')(function* (
  agentContextHome: string,
  includeInactive: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const databasePath = recallIndexDatabasePath(pathService, agentContextHome, includeInactive);
  yield* fs.makeDirectory(pathService.dirname(databasePath), {recursive: true, mode: 0o700});
  yield* writeStaleGeneration(fs, databasePath);
});

const selectRecallIndexData = Effect.fn('recall.selectIndexData')(function* (
  sql: SqlClient.SqlClient,
  corpusStatistics: RecallCorpusStatistics,
  generation: string,
  options: LoadRecallIndexOptions,
) {
  if (options.query === undefined) {
    const rows =
      options.allowedUriScopes?.length || options.limit !== undefined || options.project !== undefined
        ? yield* selectDocumentSample(sql, options.allowedUriScopes, options.project, options.limit)
        : yield* sql<RecallDocumentRow>`SELECT id, uri, candidate_json FROM documents ORDER BY uri`;
    return {
      candidates: rows.map(decodeCandidateRow),
      corpusStatistics,
      generation,
    } satisfies RecallIndexData;
  }
  const selected: RecallCandidate[] = [];
  const selectedIds = new Set<number>();
  const requiredUris = [...new Set((options.requiredUris ?? []).map(stripRecallAnchor))];
  if (requiredUris.length > 0) {
    const requiredRows = yield* selectDocumentsByUris(sql, requiredUris);
    const rowByUri = new Map(requiredRows.map(row => [row.uri, row]));
    for (const uri of requiredUris) {
      const row = rowByUri.get(uri);
      if (row && recallUriMatchesScopes(row.uri, options.allowedUriScopes) && !selectedIds.has(row.id)) {
        selectedIds.add(row.id);
        selected.push(decodeCandidateRow(row));
      }
    }
  }
  const resultLimit = options.limit ?? DEFAULT_QUERY_RESULT_LIMIT;
  const postingPoolLimit = Math.max(MINIMUM_QUERY_POSTING_POOL, resultLimit * QUERY_POSTING_POOL_MULTIPLIER);
  const indexedQueryTerms = [...new Set(indexTerms(options.query))];
  const queryTermStatistics = yield* loadRecallQueryTermStatistics(
    sql,
    indexedQueryTerms,
    corpusStatistics,
    options.allowedUriScopes,
  );
  const queryTerms = selectQueryTerms(indexedQueryTerms, queryTermStatistics);
  const postingRows = yield* selectTopPostingsByTerms(
    sql,
    queryTerms,
    options.allowedUriScopes,
    postingPoolLimit,
    corpusStatistics,
  );
  yield* options.onQueryDiagnostics?.({
    postingRows: postingRows.length,
    postingStatements: queryTerms.length === 0 ? 0 : 1,
    queryTerms: queryTerms.length,
  }) ?? Effect.void;
  const scores = new Map<number, number>();
  for (const posting of postingRows) {
    const score = postingLexicalScore(
      {
        documentLength: posting.document_length,
        fieldWeight: posting.field_weight,
        termFrequency: posting.term_frequency,
      },
      posting.term,
      corpusStatistics,
    );
    scores.set(posting.document_id, (scores.get(posting.document_id) ?? 0) + score);
  }
  const uriByDocumentId = new Map(postingRows.map(posting => [posting.document_id, posting.uri]));
  const rankedIds = [...scores]
    .sort(
      ([leftId, leftScore], [rightId, rightScore]) =>
        rightScore - leftScore || (uriByDocumentId.get(leftId) ?? '').localeCompare(uriByDocumentId.get(rightId) ?? ''),
    )
    .slice(0, resultLimit)
    .map(([documentId]) => documentId);
  const rankedRows = yield* selectDocumentsByIds(sql, rankedIds);
  const rowById = new Map(rankedRows.map(row => [row.id, row]));
  for (const documentId of rankedIds) {
    const row = rowById.get(documentId);
    if (row && !selectedIds.has(documentId)) {
      selectedIds.add(documentId);
      selected.push(decodeCandidateRow(row));
    }
  }
  return {candidates: selected, corpusStatistics, generation} satisfies RecallIndexData;
});

function candidatePostings(candidate: RecallCandidate): ReadonlyMap<string, RecallIndexPosting> {
  const weights = new Map<string, number>();
  const add = (value: string | readonly string[] | undefined, weight: number): void => {
    if (value === undefined) {
      return;
    }
    for (const term of new Set(indexTerms(typeof value === 'string' ? value : value.join(' ')))) {
      weights.set(term, Math.max(weight, weights.get(term) ?? 0));
    }
  };
  add(candidate.text, POSTING_BODY_WEIGHT);
  add(candidate.fields?.project, POSTING_PROJECT_WEIGHT);
  add(candidate.fields?.topic, POSTING_TOPIC_WEIGHT);
  add(candidate.fields?.keywords, POSTING_KEYWORD_WEIGHT);
  add(candidate.fields?.title, POSTING_TITLE_WEIGHT);
  add(candidate.fields?.identifiers, POSTING_IDENTIFIER_WEIGHT);
  const documentTerms = recallDocumentTerms(candidate);
  const termFrequencies = new Map<string, number>();
  for (const term of documentTerms) {
    termFrequencies.set(term, (termFrequencies.get(term) ?? 0) + 1);
  }
  return new Map(
    [...weights].map(([term, fieldWeight]) => [
      term,
      {
        documentLength: documentTerms.length,
        fieldWeight,
        termFrequency: termFrequencies.get(term) ?? 1,
        uri: stripRecallAnchor(candidate.uri),
      },
    ]),
  );
}

function postingLexicalScore(
  posting: Pick<RecallIndexPosting, 'documentLength' | 'fieldWeight' | 'termFrequency'>,
  term: string,
  corpusStatistics: RecallCorpusStatistics,
): number {
  const inverseDocumentFrequency = postingInverseDocumentFrequency(term, corpusStatistics);
  const denominator =
    posting.termFrequency +
    POSTING_BM25_SATURATION *
      (1 -
        POSTING_BM25_LENGTH_NORMALIZATION +
        POSTING_BM25_LENGTH_NORMALIZATION *
          (posting.documentLength / Math.max(1, corpusStatistics.averageDocumentLength)));
  const bm25 = inverseDocumentFrequency * ((posting.termFrequency * (POSTING_BM25_SATURATION + 1)) / denominator);
  return bm25 + posting.fieldWeight / POSTING_IDENTIFIER_WEIGHT;
}

function postingInverseDocumentFrequency(term: string, corpusStatistics: RecallCorpusStatistics): number {
  const documentCount = Math.max(1, corpusStatistics.documentCount);
  const documentsWithTerm = ownRecordValue(corpusStatistics.documentFrequency, term) ?? 0;
  return Math.log(
    1 +
      (documentCount - documentsWithTerm + POSTING_BM25_IDF_SMOOTHING) /
        (documentsWithTerm + POSTING_BM25_IDF_SMOOTHING),
  );
}

function selectQueryTerms(terms: readonly string[], statistics: RecallQueryTermStatistics): readonly string[] {
  const documentCount = Math.max(1, statistics.documentCount);
  return [...new Set(terms)]
    .map(term => ({frequency: ownRecordValue(statistics.documentFrequency, term) ?? 0, term}))
    .filter(item => item.frequency > 0)
    .sort((left, right) => {
      const leftIdf = Math.log(
        1 +
          (documentCount - left.frequency + POSTING_BM25_IDF_SMOOTHING) / (left.frequency + POSTING_BM25_IDF_SMOOTHING),
      );
      const rightIdf = Math.log(
        1 +
          (documentCount - right.frequency + POSTING_BM25_IDF_SMOOTHING) /
            (right.frequency + POSTING_BM25_IDF_SMOOTHING),
      );
      return rightIdf - leftIdf || left.term.localeCompare(right.term);
    })
    .slice(0, MAX_QUERY_TERMS)
    .map(item => item.term);
}

export function recallUriMatchesScopes(uri: string, scopes: readonly string[] | undefined): boolean {
  if (scopes === undefined || scopes.length === 0) {
    return true;
  }
  const documentUri = stripRecallAnchor(uri);
  const normalizedScopes = normalizeRecallUriScopes(scopes);
  return normalizedScopes.some(scope => documentUri === scope || documentUri.startsWith(`${scope}/`));
}

function stripRecallAnchor(uri: string): string {
  return uri.replace(/#.*$/, '');
}

function normalizeRecallUriScopes(scopes: readonly string[]): readonly string[] {
  return [...new Set(scopes.map(scope => stripRecallAnchor(scope).replace(/\/+$/, '').trim()).filter(Boolean))];
}

export function recallIndexDatabaseFilename(includeInactive: boolean): string {
  return includeInactive ? INACTIVE_DATABASE_FILENAME : ACTIVE_DATABASE_FILENAME;
}

function recallIndexDatabasePath(path: Path.Path, home: string, includeInactive: boolean): string {
  return path.join(recallIndexRoot(path, home), recallIndexDatabaseFilename(includeInactive));
}

function recallIndexRoot(path: Path.Path, home: string): string {
  return path.join(home, 'indexes', 'lexical');
}

function recallIndexPointerPath(path: Path.Path, home: string, includeInactive: boolean): string {
  const databaseName = recallIndexDatabaseFilename(includeInactive).replace(/\.sqlite$/, '');
  return path.join(recallIndexRoot(path, home), `${databaseName}.pointer.json`);
}

const resolveActiveRecallDatabasePath = Effect.fn('recall.resolveActiveDatabasePath')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  includeInactive: boolean,
) {
  const fixedPath = recallIndexDatabasePath(path, home, includeInactive);
  const pointerPath = recallIndexPointerPath(path, home, includeInactive);
  if (!(yield* fs.exists(pointerPath))) {
    return fixedPath;
  }
  const raw = yield* fs.readFileString(pointerPath);
  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw) as Partial<RecallIndexPointer>,
    catch: cause => new RecallIndexCorrupt(`Lexical index pointer is invalid: ${String(cause)}`),
  }).pipe(Effect.option);
  if (Option.isNone(parsed)) {
    return fixedPath;
  }
  const pointer = parsed.value;
  const relative = pointer.database?.replaceAll('\\', '/');
  if (
    pointer.version !== RECALL_INDEX_POINTER_VERSION ||
    !relative ||
    !relative.startsWith('generations/') ||
    relative.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
    !relative.endsWith('.sqlite')
  ) {
    return fixedPath;
  }
  const databasePath = path.join(recallIndexRoot(path, home), ...relative.split('/'));
  if (!(yield* fs.exists(databasePath))) {
    return fixedPath;
  }
  return databasePath;
});

const writeActiveRecallDatabasePointer = Effect.fn('recall.writeActiveDatabasePointer')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  includeInactive: boolean,
  database: string,
) {
  const system = yield* SystemInfo;
  const pointerPath = recallIndexPointerPath(path, home, includeInactive);
  const temporaryPath = `${pointerPath}.${system.processId}.${nextRecallGenerationCounter()}.tmp`;
  const pointer: RecallIndexPointer = {
    database: database.replaceAll('\\', '/'),
    version: RECALL_INDEX_POINTER_VERSION,
  };
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(pointer, undefined, 2)}\n`, {mode: 0o600});
  yield* fs
    .rename(temporaryPath, pointerPath)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.catch(() => Effect.void))));
});

function useRecallDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, R> {
  return Effect.scoped(effect.pipe(Effect.provide(SqliteClient.layer({filename: databasePath}))));
}

const initializeRecallDatabase = Effect.fn('recall.initializeDatabase')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      uri TEXT UNIQUE NOT NULL,
      project TEXT,
      source_path TEXT NOT NULL,
      source_modified_at TEXT,
      source_size INTEGER NOT NULL CHECK (source_size >= 0),
      authority_policy_key TEXT,
      candidate_json TEXT NOT NULL,
      document_length INTEGER NOT NULL CHECK (document_length >= 0)
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS postings (
      term TEXT NOT NULL,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      field_weight REAL NOT NULL CHECK (field_weight >= 0),
      term_frequency INTEGER NOT NULL CHECK (term_frequency > 0),
      PRIMARY KEY (term, document_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS term_statistics (
      term TEXT PRIMARY KEY NOT NULL,
      document_frequency INTEGER NOT NULL CHECK (document_frequency > 0)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_uri ON documents(uri)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_modified_uri ON documents(source_modified_at DESC, uri)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS documents_project_modified_uri ON documents(project, source_modified_at DESC, uri)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS postings_document_id ON postings(document_id)');
  yield* sql`
    INSERT INTO metadata (key, value)
    VALUES ('schema_version', ${String(RECALL_INDEX_DATABASE_VERSION)})
    ON CONFLICT(key) DO NOTHING
  `;
  yield* sql`INSERT INTO metadata (key, value) VALUES ('mutation_sequence', '0') ON CONFLICT(key) DO NOTHING`;
  for (const table of ['documents', 'postings', 'term_statistics'] as const) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      yield* sql.unsafe(`
        CREATE TRIGGER IF NOT EXISTS ${table}_integrity_${operation.toLowerCase()}
        AFTER ${operation} ON ${table}
        BEGIN
          UPDATE metadata
          SET value = CAST(value AS INTEGER) + 1
          WHERE key = 'mutation_sequence';
        END
      `);
    }
  }
  const rows = yield* sql<RecallMetadataRow>`SELECT key, value FROM metadata WHERE key = 'schema_version'`;
  if (rows[0]?.value !== String(RECALL_INDEX_DATABASE_VERSION)) {
    return yield* Effect.fail(
      new RecallIndexSchemaIncompatible(
        `Unsupported lexical index schema ${rows[0]?.value ?? 'unknown'}; expected ${RECALL_INDEX_DATABASE_VERSION}.`,
      ),
    );
  }
});

const ensureRecallDatabaseFresh = Effect.fn('recall.ensureDatabaseFresh')(function* (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  databasePath: string,
  staleMarkerBasePath: string,
  config: RecallIndexConfig,
  options: Pick<LoadRecallIndexOptions, 'forceRefresh' | 'includeInactive' | 'onProgress'>,
  indexLockHeld = false,
) {
  const metadata = yield* loadRecallMetadata(sql);
  const staleGeneration = yield* readStaleGeneration(fs, staleMarkerBasePath);
  const now = yield* Clock.currentTimeMillis;
  if (
    options.forceRefresh !== true &&
    recallMetadataIntegrityIsCurrent(metadata) &&
    metadata.get('initialized') === 'true' &&
    metadata.get('stale_generation') === (staleGeneration ?? '') &&
    now - numericMetadata(metadata, 'validated_at') < CACHE_VALIDATION_INTERVAL_MILLISECONDS
  ) {
    return;
  }
  const refresh = Effect.gen(function* () {
    const lockedMetadata = yield* loadRecallMetadata(sql);
    const lockedStaleGeneration = yield* readStaleGeneration(fs, staleMarkerBasePath);
    const lockedNow = yield* Clock.currentTimeMillis;
    if (
      options.forceRefresh !== true &&
      recallMetadataIntegrityIsCurrent(lockedMetadata) &&
      lockedMetadata.get('initialized') === 'true' &&
      lockedMetadata.get('stale_generation') === (lockedStaleGeneration ?? '') &&
      lockedNow - numericMetadata(lockedMetadata, 'validated_at') < CACHE_VALIDATION_INTERVAL_MILLISECONDS
    ) {
      return;
    }
    const repairLogicalCorruption =
      lockedMetadata.get('initialized') === 'true' && !recallMetadataIntegrityIsCurrent(lockedMetadata);
    yield* refreshRecallDatabase(
      sql,
      fs,
      path,
      databasePath,
      staleMarkerBasePath,
      config,
      options.includeInactive,
      options.forceRefresh === true || repairLogicalCorruption,
      options.onProgress,
    );
  });
  yield* indexLockHeld
    ? refresh
    : withRecallIndexLock(fs, path, config.agentContextHome, options.includeInactive, () => refresh);
});

const refreshRecallDatabase = Effect.fn('recall.refreshDatabase')(function* (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  databasePath: string,
  staleMarkerBasePath: string,
  config: RecallIndexConfig,
  includeInactive: boolean,
  forceRefresh: boolean,
  onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>,
) {
  const staleGeneration = yield* readStaleGeneration(fs, staleMarkerBasePath);
  const canonicalResourcePolicy = yield* loadCanonicalResourcePolicy(config);
  const sources = yield* scanRecallSources(fs, path, config, includeInactive);
  const storedRows = yield* sql<RecallDocumentSourceRow>`
    SELECT
      id,
      uri,
      source_path,
      source_modified_at,
      source_size,
      authority_policy_key,
      candidate_json
    FROM documents
    ORDER BY uri
  `;
  const storedByUri = new Map(storedRows.map(row => [row.uri, row]));
  const sourceUris = new Set(sources.map(source => source.uri));
  const removedUris = storedRows.map(row => row.uri).filter(uri => !sourceUris.has(uri));
  const changedSources = sources.filter(source => {
    const stored = storedByUri.get(source.uri);
    return (
      forceRefresh ||
      !stored ||
      !sameStoredSource(stored, source) ||
      stored.authority_policy_key !== (canonicalResourcePolicy.entryKeyByUri.get(source.uri) ?? null)
    );
  });
  const indexedSources: IndexedRecallSource[] = [];
  yield* onProgress?.({completed: 0, phase: 'indexing', scanned: sources.length, total: changedSources.length}) ??
    Effect.void;
  for (const batch of chunkValues(changedSources, 64)) {
    indexedSources.push(
      ...(yield* Effect.forEach(
        batch,
        source =>
          Effect.gen(function* () {
            const content = yield* fs.readFileString(source.path);
            const canonicalResource = yield* verifyCanonicalResource(fs, source.uri, content, canonicalResourcePolicy);
            const candidate = indexCandidate(source.uri, content, canonicalResource);
            const postings = candidatePostings(candidate);
            return {
              candidate,
              documentLength: recallDocumentTerms(candidate).length,
              postings,
              source,
            } satisfies IndexedRecallSource;
          }),
        {concurrency: 16},
      )),
    );
    yield* onProgress?.({
      completed: indexedSources.length,
      phase: 'indexing',
      scanned: sources.length,
      total: changedSources.length,
    }) ?? Effect.void;
  }
  const changedUris = new Set([...removedUris, ...changedSources.map(source => source.uri)]);
  const previousMetadata = yield* loadRecallMetadata(sql);
  const previousContentGeneration = previousMetadata.get('content_generation');
  const contentGeneration =
    changedUris.size === 0 && previousContentGeneration
      ? previousContentGeneration
      : yield* sha256Hex(
          JSON.stringify({
            changed: indexedSources.map(indexed => ({
              candidate: indexed.candidate,
              uri: indexed.source.uri,
            })),
            previous: previousContentGeneration ?? null,
            removed: removedUris,
          }),
        );
  const replacedDocumentIds = storedRows.filter(row => changedUris.has(row.uri)).map(row => row.id);
  const affectedTerms = new Set(yield* selectPostingTermsByDocumentIds(sql, replacedDocumentIds));
  for (const indexed of indexedSources) {
    for (const term of indexed.postings.keys()) {
      affectedTerms.add(term);
    }
  }
  const previousValidatedAt = numericMetadata(previousMetadata, 'validated_at');
  const now = yield* Clock.currentTimeMillis;
  yield* onProgress?.({completed: 0, phase: 'writing', removed: removedUris.length, total: indexedSources.length}) ??
    Effect.void;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const uris of chunkValues([...removedUris, ...changedSources.map(source => source.uri)], 400)) {
        yield* sql`DELETE FROM documents WHERE ${sql.in('uri', uris)}`;
      }
      for (const batch of chunkValues(indexedSources, 50)) {
        yield* sql.unsafe(
          `INSERT INTO documents (
            uri,
            project,
            source_path,
            source_modified_at,
            source_size,
            authority_policy_key,
            candidate_json,
            document_length
          ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          batch.flatMap(indexed => [
            stripRecallAnchor(indexed.candidate.uri),
            indexed.candidate.fields?.project?.trim().toLowerCase() || null,
            indexed.source.path,
            indexed.source.modifiedAt ?? null,
            indexed.source.size,
            canonicalResourcePolicy.entryKeyByUri.get(indexed.source.uri) ?? null,
            JSON.stringify(indexed.candidate),
            indexed.documentLength,
          ]),
        );
      }
      const insertedIdByUri = new Map<string, number>();
      for (const uris of chunkValues(
        indexedSources.map(indexed => stripRecallAnchor(indexed.candidate.uri)),
        400,
      )) {
        const rows = yield* sql<{readonly id: number; readonly uri: string}>`
          SELECT id, uri FROM documents WHERE ${sql.in('uri', uris)}
        `;
        rows.forEach(row => insertedIdByUri.set(row.uri, row.id));
      }
      let postingBatch: Array<readonly [string, number, number, number]> = [];
      const flushPostings = () => {
        if (postingBatch.length === 0) return Effect.void;
        const current = postingBatch;
        postingBatch = [];
        return sql.unsafe(
          `INSERT INTO postings (term, document_id, field_weight, term_frequency)
           VALUES ${current.map(() => '(?, ?, ?, ?)').join(', ')}`,
          current.flat(),
        );
      };
      let writtenDocuments = 0;
      for (const indexed of indexedSources) {
        const documentId = insertedIdByUri.get(stripRecallAnchor(indexed.candidate.uri));
        if (documentId === undefined) {
          return yield* Effect.fail(new Error(`Could not resolve inserted document ${indexed.candidate.uri}.`));
        }
        for (const [term, posting] of indexed.postings) {
          postingBatch.push([term, documentId, posting.fieldWeight, posting.termFrequency]);
          if (postingBatch.length >= 400) yield* flushPostings();
        }
        writtenDocuments += 1;
        if (writtenDocuments % 50 === 0 || writtenDocuments === indexedSources.length) {
          yield* onProgress?.({
            completed: writtenDocuments,
            phase: 'writing',
            removed: removedUris.length,
            total: indexedSources.length,
          }) ?? Effect.void;
        }
      }
      yield* flushPostings();
      for (const terms of chunkValues([...affectedTerms], 400)) {
        yield* sql`DELETE FROM term_statistics WHERE ${sql.in('term', terms)}`;
        yield* sql`
          INSERT INTO term_statistics (term, document_frequency)
          SELECT term, COUNT(*) FROM postings
          WHERE ${sql.in('term', terms)}
          GROUP BY term
        `;
      }
      const aggregate = yield* sql<{
        readonly document_count: number;
        readonly total_document_length: number | null;
      }>`
        SELECT COUNT(*) AS document_count, COALESCE(SUM(document_length), 0) AS total_document_length
        FROM documents
      `;
      const documentCount = aggregate[0]?.document_count ?? 0;
      const totalDocumentLength = aggregate[0]?.total_document_length ?? 0;
      const metadataEntries = [
        ['content_generation', contentGeneration],
        ['document_count', String(documentCount)],
        ['include_inactive', includeInactive ? 'true' : 'false'],
        ['initialized', 'true'],
        ['stale_generation', staleGeneration ?? ''],
        ['total_document_length', String(totalDocumentLength)],
        ['validated_at', String(Math.max(now, previousValidatedAt + 1))],
      ] as const;
      yield* sql.unsafe(
        `INSERT INTO metadata (key, value) VALUES ${metadataEntries.map(() => '(?, ?)').join(', ')}
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        metadataEntries.flat(),
      );
      yield* sql.unsafe(`
        INSERT INTO metadata (key, value)
        SELECT 'integrity_sequence', value FROM metadata WHERE key = 'mutation_sequence'
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      yield* onProgress?.({documentCount, phase: 'activating'}) ?? Effect.void;
    }),
  );
  yield* fs.chmod(databasePath, 0o600);
  yield* removeLegacyRecallCaches(fs, path, config.agentContextHome);
});

function scanRecallSources(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RecallIndexConfig,
  includeInactive: boolean,
) {
  return Effect.gen(function* () {
    const sources: RecallIndexSource[] = [];
    for (const root of recallIndexRoots(config, path)) {
      if (!(yield* fs.exists(root.path))) continue;
      const files = yield* scanFilesWithinBoundary(fs, root.path, root.path, {
        includeDirectory: candidate => !excludedDirectory(candidate, includeInactive),
        includeFile: candidate => !excludedFile(candidate),
      });
      const rootId = parseResourceId(root.uri);
      sources.push(
        ...files
          .filter(file => file.size <= MAX_INDEXED_FILE_BYTES)
          .map(file => {
            const relativeSegments = path
              .relative(root.path, file.path)
              .split(path.sep)
              .map(segment => segment.normalize('NFC'));
            return {
              modifiedAt: file.modifiedAt?.toISOString(),
              path: file.path,
              size: file.size,
              uri: canonicalResourceUri(rootId.namespace, [...rootId.segments, ...relativeSegments]),
            };
          }),
      );
    }
    return sources.sort((left, right) => left.uri.localeCompare(right.uri));
  });
}

function loadRecallMetadata(sql: SqlClient.SqlClient) {
  return sql<RecallMetadataRow>`SELECT key, value FROM metadata`.pipe(
    Effect.map(rows => new Map(rows.map(row => [row.key, row.value]))),
  );
}

function numericMetadata(metadata: ReadonlyMap<string, string>, key: string): number {
  const value = Number(metadata.get(key) ?? '0');
  return Number.isFinite(value) ? value : 0;
}

const loadRecallCorpusStatistics = Effect.fn('recall.loadCorpusStatistics')(function* (
  sql: SqlClient.SqlClient,
  terms: readonly string[],
) {
  const [metadata, rows] = yield* Effect.all(
    [
      loadRecallMetadata(sql),
      terms.length === 0
        ? Effect.succeed<readonly RecallTermStatisticRow[]>([])
        : Effect.gen(function* () {
            const selected: RecallTermStatisticRow[] = [];
            for (const batch of chunkValues(terms, 400)) {
              selected.push(
                ...(yield* sql<RecallTermStatisticRow>`
                  SELECT term, document_frequency FROM term_statistics WHERE ${sql.in('term', batch)}
                `),
              );
            }
            return selected;
          }),
    ],
    {concurrency: 2},
  );
  const documentCount = numericMetadata(metadata, 'document_count');
  const totalDocumentLength = numericMetadata(metadata, 'total_document_length');
  return {
    averageDocumentLength: documentCount === 0 ? 1 : totalDocumentLength / documentCount,
    documentCount,
    documentFrequency: Object.assign(
      Object.create(null) as Record<string, number>,
      Object.fromEntries(rows.map(row => [row.term, row.document_frequency])),
    ),
    totalDocumentLength,
  } satisfies RecallCorpusStatistics;
});

function recallStatisticTerms(options: LoadRecallIndexOptions | LoadRecallIndexBatchOptions): readonly string[] {
  const queries =
    'selections' in options
      ? options.selections.flatMap(selection => (selection.query === undefined ? [] : [selection.query]))
      : options.query === undefined
        ? []
        : [options.query];
  return [...new Set(queries.flatMap(indexTerms))];
}

function selectDocumentsByUris(sql: SqlClient.SqlClient, uris: readonly string[]) {
  return selectDocumentRows(sql, 'uri', uris);
}

function selectDocumentsByIds(sql: SqlClient.SqlClient, ids: readonly number[]) {
  return selectDocumentRows(sql, 'id', ids);
}

function selectDocumentSample(
  sql: SqlClient.SqlClient,
  allowedUriScopes: readonly string[] | undefined,
  project: string | undefined,
  limit: number | undefined,
) {
  const normalizedLimit = limit === undefined ? undefined : Math.max(0, Math.floor(limit));
  if (normalizedLimit === 0) return Effect.succeed<readonly RecallDocumentRow[]>([]);
  const scope = recallUriScopePredicate('d', allowedUriScopes);
  const normalizedProject = project?.trim().toLowerCase();
  const projectPredicate = normalizedProject ? ' AND d.project = ?' : '';
  const bounded = normalizedLimit === undefined ? '' : ' LIMIT ?';
  const order = normalizedLimit === undefined ? 'd.uri' : 'd.source_modified_at DESC, d.uri';
  return sql.unsafe<RecallDocumentRow>(
    `SELECT d.id, d.uri, d.candidate_json
     FROM documents AS d
     WHERE ${scope.sql}${projectPredicate}
     ORDER BY ${order}${bounded}`,
    [
      ...scope.params,
      ...(normalizedProject ? [normalizedProject] : []),
      ...(normalizedLimit === undefined ? [] : [normalizedLimit]),
    ],
  );
}

function selectDocumentRows(sql: SqlClient.SqlClient, column: 'id' | 'uri', values: readonly (number | string)[]) {
  return Effect.gen(function* () {
    const rows: RecallDocumentRow[] = [];
    for (const batch of chunkValues(values, 400)) {
      rows.push(
        ...(yield* sql<RecallDocumentRow>`
          SELECT id, uri, candidate_json FROM documents WHERE ${sql.in(column, batch)}
        `),
      );
    }
    return rows;
  });
}

function loadRecallQueryTermStatistics(
  sql: SqlClient.SqlClient,
  terms: readonly string[],
  corpusStatistics: RecallCorpusStatistics,
  allowedUriScopes: readonly string[] | undefined,
) {
  if (!allowedUriScopes || allowedUriScopes.length === 0) {
    return Effect.succeed<RecallQueryTermStatistics>({
      documentCount: corpusStatistics.documentCount,
      documentFrequency: corpusStatistics.documentFrequency,
    });
  }
  return Effect.gen(function* () {
    const scope = recallUriScopePredicate('d', allowedUriScopes);
    const documentCountRows = yield* sql.unsafe<{readonly document_count: number}>(
      `SELECT COUNT(*) AS document_count FROM documents AS d INDEXED BY documents_uri WHERE ${scope.sql}`,
      scope.params,
    );
    const frequencies: RecallTermStatisticRow[] = [];
    for (const batch of chunkValues(terms, 300)) {
      if (batch.length === 0) continue;
      frequencies.push(
        ...(yield* sql.unsafe<RecallTermStatisticRow>(
          `SELECT p.term, COUNT(*) AS document_frequency
           FROM documents AS d INDEXED BY documents_uri
           INNER JOIN postings AS p ON p.document_id = d.id
           WHERE p.term IN (${batch.map(() => '?').join(', ')})
             AND ${scope.sql}
           GROUP BY p.term`,
          [...batch, ...scope.params],
        )),
      );
    }
    return {
      documentCount: documentCountRows[0]?.document_count ?? 0,
      documentFrequency: Object.assign(
        Object.create(null) as Record<string, number>,
        Object.fromEntries(frequencies.map(row => [row.term, row.document_frequency])),
      ),
    } satisfies RecallQueryTermStatistics;
  });
}

function selectTopPostingsByTerms(
  sql: SqlClient.SqlClient,
  terms: readonly string[],
  allowedUriScopes: readonly string[] | undefined,
  postingPoolLimit: number,
  corpusStatistics: RecallCorpusStatistics,
) {
  if (terms.length === 0) return Effect.succeed<readonly RecallPostingRow[]>([]);
  const scope = recallUriScopePredicate('d', allowedUriScopes);
  const queryTermValues = terms.map(() => '(?, ?)').join(', ');
  const queryTermParameters = terms.flatMap(term => [term, postingInverseDocumentFrequency(term, corpusStatistics)]);
  const fromClause = scope.restricted
    ? `documents AS d INDEXED BY documents_uri
       INNER JOIN postings AS p ON p.document_id = d.id
       INNER JOIN query_terms AS q ON q.term = p.term`
    : `query_terms AS q
       INNER JOIN postings AS p ON p.term = q.term
       INNER JOIN documents AS d ON d.id = p.document_id`;
  return sql.unsafe<RecallPostingRow>(
    `WITH query_terms(term, inverse_document_frequency) AS (
       VALUES ${queryTermValues}
     ),
     scored AS (
       SELECT
         p.term,
         p.document_id,
         p.field_weight,
         p.term_frequency,
         d.document_length,
         d.uri,
         (
           q.inverse_document_frequency * (
             (CAST(p.term_frequency AS REAL) * ?)
             / (
               CAST(p.term_frequency AS REAL)
               + ? * (
                 ?
                 + ? * (CAST(d.document_length AS REAL) / ?)
               )
             )
           )
           + CAST(p.field_weight AS REAL) / ?
         ) AS score
       FROM ${fromClause}
       WHERE ${scope.sql}
     ),
     ranked AS (
       SELECT
         term,
         document_id,
         field_weight,
         term_frequency,
         document_length,
         uri,
         ROW_NUMBER() OVER (
           PARTITION BY term
           ORDER BY score DESC, field_weight DESC, uri ASC
         ) AS term_rank
       FROM scored
     )
     SELECT term, document_id, field_weight, term_frequency, document_length, uri
     FROM ranked
     WHERE term_rank <= ?
     ORDER BY term ASC, term_rank ASC`,
    [
      ...queryTermParameters,
      POSTING_BM25_SATURATION + 1,
      POSTING_BM25_SATURATION,
      1 - POSTING_BM25_LENGTH_NORMALIZATION,
      POSTING_BM25_LENGTH_NORMALIZATION,
      Math.max(1, corpusStatistics.averageDocumentLength),
      POSTING_IDENTIFIER_WEIGHT,
      ...scope.params,
      postingPoolLimit,
    ],
  );
}

function recallUriScopePredicate(
  alias: string,
  allowedUriScopes: readonly string[] | undefined,
): {readonly params: readonly string[]; readonly restricted: boolean; readonly sql: string} {
  if (allowedUriScopes === undefined || allowedUriScopes.length === 0) {
    return {params: [], restricted: false, sql: '1 = 1'};
  }
  const scopes = normalizeRecallUriScopes(allowedUriScopes);
  if (scopes.length === 0) return {params: [], restricted: true, sql: '0 = 1'};
  const params: string[] = [];
  const clauses = scopes.map(scope => {
    const prefix = `${scope}/`;
    params.push(scope, prefix, `${scope}0`);
    return `(${alias}.uri = ? OR (${alias}.uri >= ? AND ${alias}.uri < ?))`;
  });
  return {params, restricted: true, sql: `(${clauses.join(' OR ')})`};
}

function selectPostingTermsByDocumentIds(sql: SqlClient.SqlClient, documentIds: readonly number[]) {
  return Effect.gen(function* () {
    const terms = new Set<string>();
    for (const batch of chunkValues(documentIds, 400)) {
      const rows = yield* sql<{readonly term: string}>`
        SELECT DISTINCT term FROM postings WHERE ${sql.in('document_id', batch)}
      `;
      rows.forEach(row => terms.add(row.term));
    }
    return [...terms];
  });
}

function decodeCandidateRow(row: RecallDocumentRow): RecallCandidate {
  let value: unknown;
  try {
    value = JSON.parse(row.candidate_json);
  } catch (cause) {
    throw new RecallIndexCorrupt(`Lexical index candidate ${row.uri} is invalid: ${String(cause)}`);
  }
  if (!recallCandidateIsValid(value) || stripRecallAnchor(value.uri) !== row.uri) {
    throw new RecallIndexCorrupt(`Lexical index candidate ${row.uri} is invalid.`);
  }
  return value;
}

function sameStoredSource(stored: RecallDocumentSourceRow, source: RecallIndexSource): boolean {
  return (
    stored.source_modified_at === (source.modifiedAt ?? null) &&
    stored.source_path === source.path &&
    stored.source_size === source.size &&
    stored.uri === source.uri
  );
}

function withRecallIndexLock<A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  includeInactive: boolean,
  effect: () => Effect.Effect<A, E, R>,
) {
  return withExclusiveFileLock(
    fs,
    path.join(home, 'locks', 'indexes', 'lexical', `${recallIndexDatabaseFilename(includeInactive)}.lock`),
    {
      heartbeatIntervalMilliseconds: 10_000,
      retryIntervalMilliseconds: 100,
      staleAfterMilliseconds: 60_000,
      waitTimeoutMilliseconds: 120_000,
    },
    Effect.suspend(effect),
  );
}

function removeRecallDatabaseAuxiliaryFiles(fs: FileSystem.FileSystem, databasePath: string) {
  return Effect.forEach([`${databasePath}-shm`, `${databasePath}-wal`], target => fs.remove(target, {force: true}), {
    concurrency: 1,
    discard: true,
  });
}

function recallMetadataIntegrityIsCurrent(metadata: ReadonlyMap<string, string>): boolean {
  const mutationSequence = metadata.get('mutation_sequence');
  return mutationSequence !== undefined && mutationSequence === metadata.get('integrity_sequence');
}

function isRecoverableRecallIndexCause(cause: Cause.Cause<unknown>): boolean {
  const squashed = Cause.squash(cause);
  if (squashed instanceof RecallIndexCorrupt || squashed instanceof RecallIndexSchemaIncompatible) {
    return true;
  }
  return /database disk image is malformed|file is not a database|database schema is corrupt|malformed database schema/i.test(
    Cause.pretty(cause),
  );
}

function nextRecallGenerationCounter(): number {
  staleGenerationCounter += 1;
  return staleGenerationCounter;
}

function removeLegacyRecallCaches(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return Effect.gen(function* () {
    const cacheRoot = path.join(home, 'cache');
    if (!(yield* fs.exists(cacheRoot))) return;
    const entries = yield* fs.readDirectory(cacheRoot);
    for (const entry of entries) {
      if (/^recall-index-v[0-9]+(?:-with-inactive)?\.json(?:\.stale)?$/.test(entry)) {
        yield* fs.remove(path.join(cacheRoot, entry), {force: true});
      }
    }
  });
}

function chunkValues<Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] {
  const chunks: Value[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function recallIndexRoots(
  config: RecallIndexConfig,
  pathService: Path.Path,
): readonly {readonly path: string; readonly uri: string}[] {
  const storageRoot = pathService.join(config.agentContextHome, 'data', config.account);
  return [
    {path: pathService.join(storageRoot, 'resources'), uri: 'threadnote://resources'},
    {
      path: pathService.join(storageRoot, 'user', uriSegment(config.user), 'memories'),
      uri: `threadnote://user/${uriSegment(config.user)}/memories`,
    },
  ];
}

function excludedDirectory(path: string, includeInactive: boolean): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.includes('/agent-artifacts/packs/')) {
    return true;
  }
  return !includeInactive && (normalized.includes('/archived/') || normalized.includes('/superseded/'));
}

function excludedFile(path: string): boolean {
  const extensionIndex = path.lastIndexOf('.');
  const extension = extensionIndex === -1 ? '' : path.slice(extensionIndex).toLowerCase();
  const normalized = path.replaceAll('\\', '/');
  return (
    !TEXT_EXTENSIONS.has(extension) ||
    /\/\.(?:abstract|overview)\.md$/.test(normalized) ||
    normalized.includes('/agent-artifacts/packs/')
  );
}

function indexCandidate(uri: string, content: string, canonicalResource: boolean): RecallCandidate {
  const memory = parseMemoryDocument(uri, content);
  const text = redactSensitiveText(memory?.body ?? content);
  const fields = {
    identifiers: identifiers(text),
    keywords: memory?.metadata.keywords,
    project: memory?.metadata.project ?? resourceProject(uri),
    title: firstHeading(text) ?? uriBasename(uri),
    topic: memory?.metadata.topic ?? uriTopic(uri),
  };
  return {
    authority: boundedMemoryAuthority(uri, memory?.metadata, {canonicalResource}),
    fields,
    kind: memory?.metadata.kind,
    relations: memoryRelations(memory),
    status: memory?.metadata.status,
    text: indexTerms(text).join(' '),
    timestamp: memory?.metadata.timestamp,
    trust: boundedMemoryTrust(uri, memory?.metadata, {canonicalResource}),
    uri,
    validFrom: memory?.metadata.validFrom,
    validTo: memory?.metadata.validTo,
  };
}

function memoryRelations(memory: ReturnType<typeof parseMemoryDocument>): readonly MemoryRelation[] | undefined {
  if (!memory) {
    return undefined;
  }
  const relations: MemoryRelation[] = [
    ...(memory.metadata.relations ?? []),
    ...(memory.metadata.references ?? []).map(uri => ({type: 'references' as const, uri})),
    ...(memory.metadata.evidence ?? [])
      .filter(evidence => evidence.startsWith('threadnote://'))
      .map(uri => ({type: 'evidence_for' as const, uri})),
    ...(memory.metadata.supersedes ? [{type: 'supersedes' as const, uri: memory.metadata.supersedes}] : []),
  ];
  return relations.length > 0 ? relations : undefined;
}

function indexTerms(value: string): readonly string[] {
  const terms: string[] = [];
  for (const match of value.matchAll(IDENTIFIER_PATTERN)) {
    const raw = match[0];
    const original = raw.toLowerCase();
    terms.push(original);
    terms.push(
      ...raw
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[._/-]+/)
        .map(term => term.toLowerCase())
        .filter(term => term.length >= 2),
    );
  }
  return terms;
}

function identifiers(value: string): readonly string[] {
  return [
    ...new Set(
      [...value.matchAll(IDENTIFIER_PATTERN)]
        .map(match => match[0].toLowerCase())
        .filter(term => /[0-9_.-]/.test(term)),
    ),
  ].slice(0, 64);
}

function firstHeading(value: string): string | undefined {
  return /^#{1,3}\s+(.+)$/m.exec(value)?.[1]?.trim();
}

function resourceProject(uri: string): string | undefined {
  return /^threadnote:\/\/resources\/repos\/([^/]+)/.exec(uri)?.[1];
}

function uriTopic(uri: string): string {
  return uriBasename(uri).replace(/\.[a-z0-9]+$/i, '');
}

function uriBasename(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

function readStaleGeneration(fs: FileSystem.FileSystem, path: string): Effect.Effect<string | null, never> {
  return Effect.gen(function* () {
    const stalePath = `${path}.stale`;
    if (!(yield* fs.exists(stalePath).pipe(Effect.catch(() => Effect.succeed(false))))) {
      return null;
    }
    return yield* fs.readFileString(stalePath).pipe(
      Effect.map(value => value.trim() || 'present'),
      Effect.catch(() => Effect.succeed('present')),
    );
  });
}

const writeStaleGeneration = Effect.fn('recall.writeStaleGeneration')(function* (
  fs: FileSystem.FileSystem,
  path: string,
) {
  const system = yield* SystemInfo;
  const counter = yield* Effect.sync(() => {
    staleGenerationCounter += 1;
    return staleGenerationCounter;
  });
  const generation = `${yield* Clock.currentTimeMillis}:${system.processId}:${counter}`;
  const stalePath = `${path}.stale`;
  const temporaryPath = `${stalePath}.${system.processId}.${counter}.tmp`;
  yield* fs.writeFileString(temporaryPath, `${generation}\n`, {mode: 0o600});
  yield* fs
    .rename(temporaryPath, stalePath)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.catch(() => Effect.void))));
  return generation;
});

function loadCanonicalResourcePolicy(
  config: RecallIndexConfig,
): Effect.Effect<CanonicalResourcePolicy, never, Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo> {
  if (!config.manifestPath) {
    return Effect.succeed({entryKeyByUri: new Map(), sourcePathByUri: new Map()});
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const manifestRaw = yield* fs.readFileString(config.manifestPath as string);
    const manifest = yield* Effect.try({
      try: () => parseSeedManifest(manifestRaw, config.manifestPath as string),
      catch: cause => cause,
    });
    const seedStateRaw = yield* fs.readFileString(pathService.join(config.agentContextHome, SEED_STATE_FILE));
    const seedState = yield* Effect.try({
      try: () => parseSeedState(seedStateRaw),
      catch: cause => cause,
    });
    const entryKeyByUri = new Map<string, string>();
    const sourcePathByUri = new Map<string, string>();
    for (const [uri, recorded] of [...seedState].sort(([left], [right]) => left.localeCompare(right))) {
      const source = yield* resolveSeededResourceSource(fs, manifest.projects, uri, recorded);
      if (!source) {
        continue;
      }
      const match = seededResourceMatch(manifest.projects, uri);
      if (!match) {
        continue;
      }
      sourcePathByUri.set(uri, source);
      entryKeyByUri.set(
        uri,
        yield* sha256Hex(
          JSON.stringify({
            project: {
              path: yield* expandPath(match.project.path),
              seed: [...match.project.seed],
              uri: normalizedResourceRoot(match.project.uri),
            },
            recorded,
            source,
            uri,
          }),
        ),
      );
    }
    return {entryKeyByUri, sourcePathByUri};
  }).pipe(
    Effect.catch(() =>
      Effect.succeed({
        entryKeyByUri: new Map<string, string>(),
        sourcePathByUri: new Map<string, string>(),
      }),
    ),
  );
}

function parseSeedState(raw: string): ReadonlyMap<string, SeedStateEntry> {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('files' in value) ||
    typeof value.files !== 'object' ||
    value.files === null
  ) {
    return new Map();
  }
  const entries: Array<[string, SeedStateEntry]> = [];
  for (const [uri, entry] of Object.entries(value.files)) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'mtimeMs' in entry &&
      typeof entry.mtimeMs === 'number' &&
      Number.isFinite(entry.mtimeMs) &&
      'size' in entry &&
      typeof entry.size === 'number' &&
      Number.isFinite(entry.size)
    ) {
      entries.push([uri, {mtimeMs: entry.mtimeMs, size: entry.size}]);
    }
  }
  return new Map(entries);
}

function resolveSeededResourceSource(
  fs: FileSystem.FileSystem,
  projects: readonly ProjectManifest[],
  uri: string,
  recorded: SeedStateEntry,
): Effect.Effect<string | undefined, never, Path.Path | SystemInfo> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const match = seededResourceMatch(projects, uri);
    if (!match) {
      return undefined;
    }
    const projectRoot = yield* expandPath(match.project.path);
    const sourcePath = pathService.join(projectRoot, ...match.relativePath.split('/'));
    const relativeSourcePath = pathService.relative(projectRoot, sourcePath);
    if (
      relativeSourcePath === '' ||
      relativeSourcePath.startsWith(`..${pathService.sep}`) ||
      relativeSourcePath === '..' ||
      pathService.isAbsolute(relativeSourcePath)
    ) {
      return undefined;
    }
    const [realProjectRoot, realSourcePath, info] = yield* Effect.all([
      fs.realPath(projectRoot),
      fs.realPath(sourcePath),
      fs.stat(sourcePath),
    ]);
    const realRelativePath = pathService.relative(realProjectRoot, realSourcePath);
    if (
      realRelativePath.startsWith(`..${pathService.sep}`) ||
      realRelativePath === '..' ||
      pathService.isAbsolute(realRelativePath) ||
      info.type !== 'File' ||
      Number(info.size) !== recorded.size
    ) {
      return undefined;
    }
    const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime();
    if (modifiedAt === undefined || Math.abs(modifiedAt - recorded.mtimeMs) > SEED_FILE_MTIME_TOLERANCE_MILLISECONDS) {
      return undefined;
    }
    return sourcePath;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

function seededResourceMatch(
  projects: readonly ProjectManifest[],
  uri: string,
): {readonly project: ProjectManifest; readonly relativePath: string} | undefined {
  for (const project of projects) {
    const root = normalizedResourceRoot(project.uri);
    if (!uri.startsWith(`${root}/`)) {
      continue;
    }
    const relativePath = uri.slice(root.length + 1).replaceAll('\\', '/');
    if (
      relativePath.length === 0 ||
      relativePath.startsWith('/') ||
      relativePath.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
      !project.seed.some(pattern => globToRegExp(pattern.replaceAll('\\', '/')).test(relativePath))
    ) {
      continue;
    }
    return {project, relativePath};
  }
  return undefined;
}

function normalizedResourceRoot(uri: string): string {
  return stripRecallAnchor(uri).replace(/\/+$/, '');
}

function verifyCanonicalResource(
  fs: FileSystem.FileSystem,
  uri: string,
  indexedContent: string,
  policy: CanonicalResourcePolicy,
): Effect.Effect<boolean, never> {
  const sourcePath = policy.sourcePathByUri.get(uri);
  if (!sourcePath) {
    return Effect.succeed(false);
  }
  return fs.readFileString(sourcePath).pipe(
    Effect.map(sourceContent => sourceContent === indexedContent),
    Effect.catch(() => Effect.succeed(false)),
  );
}

function recallCandidateIsValid(value: unknown): value is RecallCandidate {
  if (!isPlainRecord(value) || typeof value.uri !== 'string' || typeof value.text !== 'string') {
    return false;
  }
  const stringValues = ['authority', 'kind', 'status', 'timestamp', 'trust', 'validFrom', 'validTo'] as const;
  if (stringValues.some(key => value[key] !== undefined && typeof value[key] !== 'string')) {
    return false;
  }
  const numberValues = ['feedback', 'reranker', 'semantic'] as const;
  if (numberValues.some(key => value[key] !== undefined && !isFiniteNumber(value[key]))) {
    return false;
  }
  if (value.exactTerms !== undefined && !isStringArray(value.exactTerms)) {
    return false;
  }
  if (value.fields !== undefined) {
    if (!isPlainRecord(value.fields)) return false;
    const fields = value.fields;
    if (
      !['project', 'title', 'topic'].every(key => fields[key] === undefined || typeof fields[key] === 'string') ||
      !['identifiers', 'keywords'].every(key => fields[key] === undefined || isStringArray(fields[key]))
    ) {
      return false;
    }
  }
  return (
    value.relations === undefined ||
    (Array.isArray(value.relations) &&
      value.relations.every(
        relation => isPlainRecord(relation) && typeof relation.type === 'string' && typeof relation.uri === 'string',
      ))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function ownRecordValue<Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
