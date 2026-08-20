import {Cause, Clock, Crypto, Effect, FileSystem, Layer, Option, Path} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
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
import {errorMessage, expandPath, globToRegExp} from '../utils.js';
import {
  POSTING_BM25_LENGTH_NORMALIZATION,
  POSTING_BM25_SATURATION,
  POSTING_IDENTIFIER_WEIGHT,
  candidatePostings,
  identifiers,
  indexTerms,
  postingInverseDocumentFrequency,
  postingLexicalScore,
  selectQueryTerms,
  stripRecallAnchor,
  type RecallIndexPosting,
} from './index_lexical.js';
import {
  deduplicateLogicalRecallCandidates,
  recallCandidateLogicalCorpusKey,
  recallMemoryContentHash,
  recallDocumentTerms,
  type RecallCandidate,
  type RecallCorpusStatistics,
} from './rank.js';
import {normalizeRecallSearchText} from './tokenize.js';
import {removeLegacyRecallIndexArtifacts} from './index_cleanup.js';
import {boundedRecallPhysicalCandidateLimit, recallStatisticTerms} from './index_query.js';
import * as RecallIndexIdentity from './index_identity.js';
import {
  combineRecallSqlPredicates,
  normalizeRecallWorkspaceScope,
  recallUriMatchesScopes,
  recallUriScopePredicate,
  recallWorkspaceScopeMatches,
  recallWorkspaceScopePredicate,
  type RecallWorkspaceScopeMode,
} from './index_scope.js';
import {
  recallProjectMatches,
  recallProjectPredicate,
  recallQuerySelectionIsExhaustive,
  recallSelectionHasDocuments,
  selectRecallDocumentSample,
  selectRecallQueryTermStatistics,
} from './index_selection.js';

export {recallUriMatchesScopes} from './index_scope.js';

class RecallIndexOperationError extends Error {
  readonly _tag = 'RecallIndexOperationError' as const;
}

interface RecallIndexSource {
  readonly modifiedAt?: string;
  readonly path: string;
  readonly size: number;
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
  /** True only when the query selection proves that no matching candidate was truncated. */
  readonly queryExhaustive: boolean;
}

export interface RecallExactMatch {
  readonly terms: readonly string[];
  readonly uri: string;
}

export interface RecallIndexStatus {
  readonly databasePath?: string;
  readonly documentCount: number;
  readonly generation?: string;
  readonly ready: boolean;
  readonly reason?: string;
  readonly skippedOversizedDocumentCount?: number;
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

interface IndexedRecallSource {
  readonly candidate: RecallCandidate;
  readonly documentLength: number;
  readonly exactSearchText: string;
  readonly postings: ReadonlyMap<string, RecallIndexPosting>;
  readonly source: RecallIndexSource;
}

const RECALL_INDEX_DATABASE_VERSION = 6;
const RECALL_INDEX_POINTER_VERSION = 1;
const RECALL_STALE_MARKER_VERSION = 1;
const ACTIVE_DATABASE_FILENAME = `active-v${RECALL_INDEX_DATABASE_VERSION}.sqlite`;
const INACTIVE_DATABASE_FILENAME = `with-inactive-v${RECALL_INDEX_DATABASE_VERSION}.sqlite`;
const CACHE_VALIDATION_INTERVAL_MILLISECONDS = 30_000;
const MAX_RECALL_INVALIDATED_URIS = 1_024;
const MAX_INDEXED_FILE_BYTES = 512 * 1_024;
const DEFAULT_QUERY_RESULT_LIMIT = 100;
const QUERY_POSTING_POOL_MULTIPLIER = 5;
const MINIMUM_QUERY_POSTING_POOL = 500;
const SEED_FILE_MTIME_TOLERANCE_MILLISECONDS = 1;
const TEXT_EXTENSIONS = new Set(['.json', '.md', '.mdx', '.txt', '.yaml', '.yml']);
let staleGenerationCounter = 0;

interface RecallIndexPointer {
  readonly database: string;
  readonly version: typeof RECALL_INDEX_POINTER_VERSION;
}

interface RecallStaleMarker {
  readonly forceRefresh: boolean;
  readonly generation: string;
  readonly invalidatedUris: readonly string[];
  readonly version: typeof RECALL_STALE_MARKER_VERSION;
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
  readonly workspaceScope?: string;
  /** Select the protected hierarchy by default, or only scopes outside it for the bounded challenger lane. */
  readonly workspaceScopeMode?: RecallWorkspaceScopeMode;
}

interface LoadRecallIndexBatchOptions {
  readonly forceRefresh?: boolean;
  readonly includeInactive: boolean;
  readonly onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>;
  readonly selections: readonly Omit<LoadRecallIndexOptions, 'forceRefresh' | 'includeInactive'>[];
}

interface LoadRecallExactMatchesOptions {
  readonly forceRefresh?: boolean;
  readonly includeInactive: boolean;
  readonly limitPerTerm?: number;
  readonly onProgress?: (progress: RecallIndexProgress) => Effect.Effect<void, unknown>;
  readonly terms: readonly string[];
  readonly uriScopes: readonly string[];
}

const loadRecallIndexDataInternal = Effect.fn('recall.loadIndexDataInternal')(function* (
  config: RecallIndexConfig,
  options: LoadRecallIndexOptions | LoadRecallIndexBatchOptions | LoadRecallExactMatchesOptions,
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
  options: LoadRecallIndexOptions | LoadRecallIndexBatchOptions | LoadRecallExactMatchesOptions,
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
      const loadIdentityConflicts = RecallIndexIdentity.createRecallIdentityConflictLoader(sql);
      const selectData = (selection: LoadRecallIndexOptions) =>
        selectRecallIndexData(sql, corpusStatistics, generation, selection, loadIdentityConflicts);
      const result =
        'terms' in options
          ? yield* selectRecallExactMatches(sql, options)
          : 'selections' in options
            ? yield* Effect.forEach(
                options.selections,
                selection => selectData({...selection, includeInactive: options.includeInactive}),
                {concurrency: 1},
              )
            : yield* selectData(options);
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
  options: LoadRecallIndexOptions | LoadRecallIndexBatchOptions | LoadRecallExactMatchesOptions,
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
            new RecallIndexOperationError(
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

export const loadRecallExactMatches = Effect.fn('recall.loadExactMatches')(function* (
  config: RecallIndexConfig,
  options: LoadRecallExactMatchesOptions,
) {
  return (yield* loadRecallIndexDataInternal(config, options)) as readonly RecallExactMatch[];
});

export const recallIndexStatus = Effect.fn('recall.indexStatus')(function* (
  config: RecallIndexConfig,
  includeInactive = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixedDatabasePath = recallIndexDatabasePath(path, config.agentContextHome, includeInactive);
  const databasePath = yield* resolveActiveRecallDatabasePath(fs, path, config.agentContextHome, includeInactive);
  if (!(yield* fs.exists(databasePath))) {
    return {
      databasePath,
      documentCount: 0,
      ready: false,
      reason: 'not built; run `threadnote repair`',
    } satisfies RecallIndexStatus;
  }
  return yield* useRecallDatabaseReadOnly(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const metadata = yield* loadRecallMetadata(sql);
      if (metadata.get('schema_version') !== String(RECALL_INDEX_DATABASE_VERSION)) {
        return {
          databasePath,
          documentCount: 0,
          ready: false,
          reason: `unsupported schema ${metadata.get('schema_version') ?? 'unknown'}; run \`threadnote repair\``,
        } satisfies RecallIndexStatus;
      }
      if (metadata.get('initialized') !== 'true') {
        return {
          databasePath,
          documentCount: 0,
          ready: false,
          reason: 'not initialized; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      if (!RecallIndexIdentity.recallIndexMetadataIsCurrent(metadata)) {
        return {
          databasePath,
          documentCount: numericMetadata(metadata, 'document_count'),
          ready: false,
          reason: 'integrity sequence mismatch; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      const staleMarker = yield* readStaleMarker(fs, fixedDatabasePath);
      if (metadata.get('stale_generation') !== (staleMarker?.generation ?? '')) {
        return {
          databasePath,
          documentCount: numericMetadata(metadata, 'document_count'),
          generation: metadata.get('content_generation'),
          ready: false,
          reason: 'canonical documents changed; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      const rows = yield* sql<{readonly document_count: number}>`SELECT COUNT(*) AS document_count FROM documents`;
      const documentCount = Number(rows[0]?.document_count ?? 0);
      if (!Number.isSafeInteger(documentCount) || documentCount < 0) {
        return {
          databasePath,
          documentCount: 0,
          ready: false,
          reason: 'invalid document count; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      if (numericMetadata(metadata, 'document_count') !== documentCount) {
        return {
          databasePath,
          documentCount,
          ready: false,
          reason: 'document count metadata mismatch; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      const generation = metadata.get('content_generation');
      if (!generation) {
        return {
          databasePath,
          documentCount,
          ready: false,
          reason: 'missing content generation; run `threadnote repair`',
        } satisfies RecallIndexStatus;
      }
      return {
        databasePath,
        documentCount,
        generation,
        ready: true,
        skippedOversizedDocumentCount: numericMetadata(metadata, 'oversized_document_count'),
      } satisfies RecallIndexStatus;
    }),
  ).pipe(
    Effect.catch(cause =>
      Effect.succeed({
        databasePath,
        documentCount: 0,
        ready: false,
        reason: `unreadable: ${errorMessage(cause)}; run \`threadnote repair\``,
      } satisfies RecallIndexStatus),
    ),
  );
});

export const currentRecallCorpusGeneration = Effect.fn('recall.currentCorpusGeneration')(function* (
  config: RecallIndexConfig,
) {
  const status = yield* recallIndexStatus(config, false);
  return status.ready ? Option.fromUndefinedOr(status.generation) : Option.none<string>();
});

export const clearRecallIndexMemoryCache = Effect.fn('recall.clearMemoryCache')(function* () {
  // SQLite owns its page cache and every operation uses a scoped connection.
  yield* Effect.void;
});

export const expireRecallIndexValidation = Effect.fn('recall.expireValidation')(function* (
  agentContextHome: string,
  includeInactive: boolean,
  invalidatedUris?: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const databasePath = recallIndexDatabasePath(pathService, agentContextHome, includeInactive);
  yield* fs.makeDirectory(pathService.dirname(databasePath), {recursive: true, mode: 0o700});
  yield* writeStaleGeneration(fs, databasePath, invalidatedUris);
});

const selectRecallIndexData = Effect.fn('recall.selectIndexData')(function* (
  sql: SqlClient.SqlClient,
  corpusStatistics: RecallCorpusStatistics,
  generation: string,
  options: LoadRecallIndexOptions,
  loadIdentityConflicts: ReturnType<typeof RecallIndexIdentity.createRecallIdentityConflictLoader>,
) {
  if (options.query === undefined) {
    const rows =
      options.allowedUriScopes?.length ||
      options.limit !== undefined ||
      options.project !== undefined ||
      options.workspaceScope !== undefined
        ? yield* selectRecallDocumentSample(sql, options)
        : yield* sql<RecallDocumentRow>`SELECT id, uri, candidate_json FROM documents ORDER BY uri`;
    const logicalCandidates = deduplicateLogicalRecallCandidates(rows.map(decodeCandidateRow));
    const candidates = options.limit === undefined ? logicalCandidates : logicalCandidates.slice(0, options.limit);
    const identityConflicts = yield* loadIdentityConflicts(
      options.allowedUriScopes,
      candidates.flatMap(candidate => (candidate.memoryId ? [candidate.memoryId] : [])),
    );
    return {
      candidates: RecallIndexIdentity.markRecallIdentityConflicts(candidates, identityConflicts),
      corpusStatistics,
      generation,
      queryExhaustive: options.limit === undefined,
    } satisfies RecallIndexData;
  }
  const selected: RecallCandidate[] = [];
  const selectedIds = new Set<number>();
  const requiredUris = [...new Set((options.requiredUris ?? []).map(stripRecallAnchor))];
  if (requiredUris.length > 0) {
    const requiredRows = yield* selectDocumentRows(sql, 'uri', requiredUris);
    const rowByUri = new Map(requiredRows.map(row => [row.uri, row]));
    for (const uri of requiredUris) {
      const row = rowByUri.get(uri);
      if (!row || selectedIds.has(row.id) || !recallUriMatchesScopes(row.uri, options.allowedUriScopes)) continue;
      const candidate = decodeCandidateRow(row);
      if (
        recallProjectMatches(options.project, candidate.fields?.project) &&
        recallWorkspaceScopeMatches(
          options.workspaceScope,
          candidate.fields?.workspaceScope,
          options.workspaceScopeMode,
        )
      ) {
        selectedIds.add(row.id);
        selected.push(candidate);
      }
    }
  }
  const resultLimit = options.limit ?? DEFAULT_QUERY_RESULT_LIMIT;
  const postingPoolLimit = Math.max(MINIMUM_QUERY_POSTING_POOL, resultLimit * QUERY_POSTING_POOL_MULTIPLIER);
  const indexedQueryTerms = [...new Set(indexTerms(options.query))];
  const siblingWorkspaceSelection = options.workspaceScopeMode === 'sibling' && options.workspaceScope !== undefined;
  if (siblingWorkspaceSelection && !(yield* recallSelectionHasDocuments(sql, options))) {
    return {
      candidates: [],
      corpusStatistics,
      generation,
      queryExhaustive: true,
    } satisfies RecallIndexData;
  }
  const queryCorpusStatistics = siblingWorkspaceSelection
    ? corpusStatistics
    : yield* selectRecallQueryTermStatistics(sql, indexedQueryTerms, corpusStatistics, options);
  const queryTerms = selectQueryTerms(indexedQueryTerms, queryCorpusStatistics);
  const postingCorpusStatistics =
    options.workspaceScope === undefined && options.project === undefined
      ? corpusStatistics
      : siblingWorkspaceSelection
        ? corpusStatistics
        : queryCorpusStatistics;
  const postingRows = yield* selectTopPostingsByTerms(
    sql,
    queryTerms,
    options.allowedUriScopes,
    options.project,
    options.workspaceScope,
    options.workspaceScopeMode,
    postingPoolLimit,
    postingCorpusStatistics,
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
      postingCorpusStatistics,
    );
    scores.set(posting.document_id, (scores.get(posting.document_id) ?? 0) + score);
  }
  const uriByDocumentId = new Map(postingRows.map(posting => [posting.document_id, posting.uri]));
  const rankedIds = [...scores]
    .sort(
      ([leftId, leftScore], [rightId, rightScore]) =>
        rightScore - leftScore || (uriByDocumentId.get(leftId) ?? '').localeCompare(uriByDocumentId.get(rightId) ?? ''),
    )
    .map(([documentId]) => documentId);
  const candidateDecodeLimit = boundedRecallPhysicalCandidateLimit(resultLimit);
  const boundedRankedIds = rankedIds.slice(0, candidateDecodeLimit);
  const rankedRows = yield* selectDocumentRows(sql, 'id', boundedRankedIds);
  const rowById = new Map(rankedRows.map(row => [row.id, row]));
  for (const documentId of boundedRankedIds) {
    const row = rowById.get(documentId);
    if (row && !selectedIds.has(documentId)) {
      selectedIds.add(documentId);
      selected.push(decodeCandidateRow(row));
    }
  }
  const deduplicated = deduplicateLogicalRecallCandidates(selected);
  const requiredUriSet = new Set(requiredUris);
  const requiredCandidates = deduplicated.filter(candidate =>
    [candidate.uri, ...(candidate.equivalentUris ?? [])].some(uri => requiredUriSet.has(stripRecallAnchor(uri))),
  );
  const rankedCandidates = deduplicated
    .filter(candidate => !requiredCandidates.includes(candidate))
    .slice(0, resultLimit);
  const candidates = [...requiredCandidates, ...rankedCandidates];
  const queryExhaustive = recallQuerySelectionIsExhaustive({
    candidateDecodeLimit,
    deduplicatedCandidateCount: deduplicated.length,
    documentFrequency: queryCorpusStatistics.documentFrequency,
    indexedQueryTerms,
    postingPoolLimit,
    postingTerms: postingRows.map(posting => posting.term),
    queryTerms,
    rankedDocumentCount: rankedIds.length,
    resultLimit,
  });
  const identityConflicts = yield* loadIdentityConflicts(
    options.allowedUriScopes,
    candidates.flatMap(candidate => (candidate.memoryId ? [candidate.memoryId] : [])),
  );
  return {
    candidates: RecallIndexIdentity.markRecallIdentityConflicts(candidates, identityConflicts),
    corpusStatistics,
    generation,
    queryExhaustive,
  } satisfies RecallIndexData;
});

const selectRecallExactMatches = Effect.fn('recall.selectExactMatches')(function* (
  sql: SqlClient.SqlClient,
  options: LoadRecallExactMatchesOptions,
) {
  const terms = [
    ...new Map(
      options.terms
        .map(term => term.trim())
        .filter(Boolean)
        .map(term => [term.toLocaleLowerCase(), term] as const),
    ).values(),
  ];
  const scopes = [...new Set(options.uriScopes.map(stripRecallAnchor))];
  const limitPerTerm = Math.max(0, Math.floor(options.limitPerTerm ?? 25));
  if (terms.length === 0 || scopes.length === 0 || limitPerTerm === 0) {
    return [] satisfies readonly RecallExactMatch[];
  }
  const matchedTermsByUri = new Map<string, Set<string>>();
  for (const scopeUri of scopes) {
    const scope = recallUriScopePredicate('d', [scopeUri]);
    for (const term of terms) {
      const phrase = `"${normalizeRecallSearchText(term).replaceAll('"', '""')}"`;
      const rows = yield* sql.unsafe<{readonly uri: string}>(
        `SELECT d.uri
         FROM exact_search
         INNER JOIN documents AS d ON d.id = exact_search.rowid
         WHERE exact_search MATCH ?
           AND ${scope.sql}
         ORDER BY d.uri
         LIMIT ?`,
        [phrase, ...scope.params, limitPerTerm],
      );
      for (const row of rows) {
        const matched = matchedTermsByUri.get(row.uri) ?? new Set<string>();
        matched.add(term);
        matchedTermsByUri.set(row.uri, matched);
      }
    }
  }
  return [...matchedTermsByUri]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([uri, matched]) => ({
      terms: terms.filter(term => matched.has(term)),
      uri,
    })) satisfies readonly RecallExactMatch[];
});

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
  return Effect.scoped(
    Layer.build(SqliteClient.layer({filename: databasePath})).pipe(
      Effect.flatMap(context => effect.pipe(Effect.provide(context))),
    ),
  );
}

function useRecallDatabaseReadOnly<A, E, R>(
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
      workspace_scope TEXT,
      source_path TEXT NOT NULL,
      source_modified_at TEXT,
      source_size INTEGER NOT NULL CHECK (source_size >= 0),
      authority_policy_key TEXT,
      candidate_json TEXT NOT NULL,
      logical_key TEXT NOT NULL,
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
  yield* sql.unsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS exact_search USING fts5(
      content,
      content = '',
      contentless_delete = 1,
      tokenize = 'trigram'
    )
  `);
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_uri ON documents(uri)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_logical_key ON documents(logical_key)');
  yield* RecallIndexIdentity.initializeRecallIdentityIndex(sql);
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_modified_uri ON documents(source_modified_at DESC, uri)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS documents_project_modified_uri ON documents(project, source_modified_at DESC, uri)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS documents_workspace_scope_uri ON documents(workspace_scope, uri)');
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
  const staleMarker = yield* readStaleMarker(fs, staleMarkerBasePath);
  const now = yield* Clock.currentTimeMillis;
  if (
    options.forceRefresh !== true &&
    RecallIndexIdentity.recallIndexMetadataIsCurrent(metadata) &&
    metadata.get('initialized') === 'true' &&
    metadata.get('stale_generation') === (staleMarker?.generation ?? '') &&
    now - numericMetadata(metadata, 'validated_at') < CACHE_VALIDATION_INTERVAL_MILLISECONDS
  ) {
    return;
  }
  const refresh = Effect.gen(function* () {
    const lockedMetadata = yield* loadRecallMetadata(sql);
    const lockedStaleMarker = yield* readStaleMarker(fs, staleMarkerBasePath);
    const lockedNow = yield* Clock.currentTimeMillis;
    if (
      options.forceRefresh !== true &&
      RecallIndexIdentity.recallIndexMetadataIsCurrent(lockedMetadata) &&
      lockedMetadata.get('initialized') === 'true' &&
      lockedMetadata.get('stale_generation') === (lockedStaleMarker?.generation ?? '') &&
      lockedNow - numericMetadata(lockedMetadata, 'validated_at') < CACHE_VALIDATION_INTERVAL_MILLISECONDS
    ) {
      return;
    }
    const repairLogicalCorruption =
      lockedMetadata.get('initialized') === 'true' && !RecallIndexIdentity.recallIndexMetadataIsCurrent(lockedMetadata);
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
  const staleMarker = yield* readStaleMarker(fs, staleMarkerBasePath);
  const staleGeneration = staleMarker?.generation;
  const canonicalResourcePolicy = yield* loadCanonicalResourcePolicy(config);
  const sourceScan = yield* scanRecallSources(fs, path, config, includeInactive);
  const sources = sourceScan.sources;
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
  const previousMetadata = yield* loadRecallMetadata(sql);
  const markerChanged = previousMetadata.get('stale_generation') !== (staleGeneration ?? '');
  const invalidatedUris = markerChanged ? new Set(staleMarker?.invalidatedUris ?? []) : new Set<string>();
  const forceFromMarker = markerChanged && staleMarker?.forceRefresh === true;
  const storedByUri = new Map(storedRows.map(row => [row.uri, row]));
  const sourceUris = new Set(sources.map(source => source.uri));
  const removedUris = storedRows.map(row => row.uri).filter(uri => !sourceUris.has(uri));
  const changedSources = sources.filter(source => {
    const stored = storedByUri.get(source.uri);
    return (
      forceRefresh ||
      forceFromMarker ||
      invalidatedUris.has(source.uri) ||
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
              exactSearchText: normalizeRecallSearchText(redactSensitiveText(content)),
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
      for (const documentIds of chunkValues(replacedDocumentIds, 400)) {
        yield* sql`DELETE FROM exact_search WHERE ${sql.in('rowid', documentIds)}`;
      }
      for (const uris of chunkValues([...removedUris, ...changedSources.map(source => source.uri)], 400)) {
        yield* sql`DELETE FROM documents WHERE ${sql.in('uri', uris)}`;
      }
      for (const batch of chunkValues(indexedSources, 50)) {
        yield* sql.unsafe(
          `INSERT INTO documents (
            uri,
            project,
            workspace_scope,
            source_path,
            source_modified_at,
            source_size,
            authority_policy_key,
            candidate_json,
            logical_key,
            document_length
          ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          batch.flatMap(indexed => [
            stripRecallAnchor(indexed.candidate.uri),
            indexed.candidate.fields?.project?.trim().toLowerCase() || null,
            normalizeRecallWorkspaceScope(indexed.candidate.fields?.workspaceScope) ?? null,
            indexed.source.path,
            indexed.source.modifiedAt ?? null,
            indexed.source.size,
            canonicalResourcePolicy.entryKeyByUri.get(indexed.source.uri) ?? null,
            JSON.stringify(indexed.candidate),
            recallCandidateLogicalCorpusKey(indexed.candidate),
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
      for (const batch of chunkValues(indexedSources, 50)) {
        yield* sql.unsafe(
          `INSERT INTO exact_search (rowid, content)
           VALUES ${batch.map(() => '(?, ?)').join(', ')}`,
          batch.flatMap(indexed => {
            const documentId = insertedIdByUri.get(stripRecallAnchor(indexed.candidate.uri));
            if (documentId === undefined) {
              throw new RecallIndexOperationError(`Could not resolve exact-search document ${indexed.candidate.uri}.`);
            }
            return [documentId, indexed.exactSearchText];
          }),
        );
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
          return yield* Effect.fail(
            new RecallIndexOperationError(`Could not resolve inserted document ${indexed.candidate.uri}.`),
          );
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
      yield* RecallIndexIdentity.rebuildRecallIdentityConflicts(sql);
      for (const terms of chunkValues([...affectedTerms], 400)) {
        yield* sql`DELETE FROM term_statistics WHERE ${sql.in('term', terms)}`;
        yield* sql`
          INSERT INTO term_statistics (term, document_frequency)
          SELECT p.term, COUNT(DISTINCT d.logical_key)
          FROM postings AS p
          INNER JOIN documents AS d ON d.id = p.document_id
          WHERE ${sql.in('term', terms)}
          GROUP BY p.term
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
      const logicalAggregate = yield* sql<{
        readonly document_count: number;
        readonly total_document_length: number | null;
      }>`
        SELECT COUNT(*) AS document_count, COALESCE(SUM(document_length), 0) AS total_document_length
        FROM (
          SELECT logical_key, MAX(document_length) AS document_length
          FROM documents
          GROUP BY logical_key
        )
      `;
      const logicalDocumentCount = logicalAggregate[0]?.document_count ?? 0;
      const logicalTotalDocumentLength = logicalAggregate[0]?.total_document_length ?? 0;
      const metadataEntries = [
        ['content_generation', contentGeneration],
        ['document_count', String(documentCount)],
        ['include_inactive', includeInactive ? 'true' : 'false'],
        ['initialized', 'true'],
        ['memory_identity_conflict_generation', contentGeneration],
        ['logical_document_count', String(logicalDocumentCount)],
        ['logical_total_document_length', String(logicalTotalDocumentLength)],
        ['oversized_document_count', String(sourceScan.skippedOversizedDocumentCount)],
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
  if (markerChanged && staleMarker) {
    yield* clearStaleMarkerInvalidations(fs, staleMarkerBasePath, staleMarker).pipe(Effect.catch(() => Effect.void));
  }
  yield* removeLegacyRecallIndexArtifacts(fs, path, config.agentContextHome, RECALL_INDEX_DATABASE_VERSION);
});

function scanRecallSources(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RecallIndexConfig,
  includeInactive: boolean,
) {
  return Effect.gen(function* () {
    const sources: RecallIndexSource[] = [];
    let skippedOversizedDocumentCount = 0;
    for (const root of recallIndexRoots(config, path)) {
      if (!(yield* fs.exists(root.path))) continue;
      const files = yield* scanFilesWithinBoundary(fs, root.path, root.path, {
        includeDirectory: candidate => !excludedDirectory(candidate, includeInactive),
        includeFile: candidate => !excludedFile(candidate),
      });
      const eligibleFiles = files.filter(file => file.size <= MAX_INDEXED_FILE_BYTES);
      skippedOversizedDocumentCount += files.length - eligibleFiles.length;
      const rootId = parseResourceId(root.uri);
      sources.push(
        ...eligibleFiles.map(file => {
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
    return {
      skippedOversizedDocumentCount,
      sources: sources.sort((left, right) => left.uri.localeCompare(right.uri)),
    };
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
  const documentCount = numericMetadata(metadata, 'logical_document_count');
  const totalDocumentLength = numericMetadata(metadata, 'logical_total_document_length');
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

function selectTopPostingsByTerms(
  sql: SqlClient.SqlClient,
  terms: readonly string[],
  allowedUriScopes: readonly string[] | undefined,
  project: string | undefined,
  workspaceScope: string | undefined,
  workspaceScopeMode: RecallWorkspaceScopeMode | undefined,
  postingPoolLimit: number,
  corpusStatistics: RecallCorpusStatistics,
) {
  if (terms.length === 0) return Effect.succeed<readonly RecallPostingRow[]>([]);
  const uriScope = recallUriScopePredicate('d', allowedUriScopes);
  const workspace = recallWorkspaceScopePredicate('d', workspaceScope, workspaceScopeMode);
  const scope = combineRecallSqlPredicates(uriScope, recallProjectPredicate('d', project), workspace);
  const queryTermValues = terms.map(() => '(?, ?)').join(', ');
  const queryTermParameters = terms.flatMap(term => [term, postingInverseDocumentFrequency(term, corpusStatistics)]);
  const indexHint = uriScope.restricted
    ? ' INDEXED BY documents_uri'
    : workspace.restricted
      ? ' INDEXED BY documents_workspace_scope_uri'
      : '';
  const postingsFirst = workspaceScopeMode === 'sibling';
  const fromClause =
    scope.restricted && !postingsFirst
      ? `documents AS d${indexHint}
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
  return (
    !includeInactive &&
    (normalized.includes('/archived/') || normalized.includes('/expired/') || normalized.includes('/superseded/'))
  );
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
    workspaceScope: memory?.metadata.workspaceScope,
  };
  return {
    authority: boundedMemoryAuthority(uri, memory?.metadata, {canonicalResource}),
    contentHash: memory ? recallMemoryContentHash(memory.body) : undefined,
    fields,
    kind: memory?.metadata.kind,
    memoryId: memory?.metadata.memoryId,
    relations: memoryRelations(memory),
    status: memory?.metadata.status,
    text,
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

function readStaleMarker(fs: FileSystem.FileSystem, path: string): Effect.Effect<RecallStaleMarker | undefined, never> {
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
      Array.isArray((value as {readonly invalidatedUris?: unknown}).invalidatedUris) &&
      (value as {readonly invalidatedUris: readonly unknown[]}).invalidatedUris.every(uri => typeof uri === 'string')
    ) {
      const marker = value as RecallStaleMarker;
      return {
        forceRefresh: marker.forceRefresh,
        generation: marker.generation,
        invalidatedUris: [...new Set(marker.invalidatedUris.map(stripRecallAnchor))],
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

const writeStaleGeneration = Effect.fn('recall.writeStaleGeneration')(function* (
  fs: FileSystem.FileSystem,
  path: string,
  invalidatedUris?: readonly string[],
) {
  const system = yield* SystemInfo;
  const counter = yield* Effect.sync(() => {
    staleGenerationCounter += 1;
    return staleGenerationCounter;
  });
  const generation = `${yield* Clock.currentTimeMillis}:${system.processId}:${counter}`;
  const stalePath = `${path}.stale`;
  const previous = yield* readStaleMarker(fs, path);
  const mergedInvalidatedUris = [
    ...new Set(
      [...(previous?.invalidatedUris ?? []), ...(invalidatedUris ?? [])]
        .map(stripRecallAnchor)
        .map(uri => uri.replace(/\/+$/, ''))
        .filter(Boolean),
    ),
  ];
  const forceRefresh =
    invalidatedUris === undefined ||
    previous?.forceRefresh === true ||
    mergedInvalidatedUris.length > MAX_RECALL_INVALIDATED_URIS;
  const marker: RecallStaleMarker = {
    forceRefresh,
    generation,
    invalidatedUris: forceRefresh ? [] : mergedInvalidatedUris,
    version: RECALL_STALE_MARKER_VERSION,
  };
  const temporaryPath = `${stalePath}.${system.processId}.${counter}.tmp`;
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(marker)}\n`, {mode: 0o600});
  yield* fs
    .rename(temporaryPath, stalePath)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.catch(() => Effect.void))));
  return generation;
});

const clearStaleMarkerInvalidations = Effect.fn('recall.clearStaleMarkerInvalidations')(function* (
  fs: FileSystem.FileSystem,
  path: string,
  observed: RecallStaleMarker,
) {
  const current = yield* readStaleMarker(fs, path);
  if (current?.generation !== observed.generation) {
    return;
  }
  const system = yield* SystemInfo;
  const counter = yield* Effect.sync(() => {
    staleGenerationCounter += 1;
    return staleGenerationCounter;
  });
  const stalePath = `${path}.stale`;
  const temporaryPath = `${stalePath}.${system.processId}.${counter}.tmp`;
  const cleared: RecallStaleMarker = {
    forceRefresh: false,
    generation: observed.generation,
    invalidatedUris: [],
    version: RECALL_STALE_MARKER_VERSION,
  };
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(cleared)}\n`, {mode: 0o600});
  yield* fs
    .rename(temporaryPath, stalePath)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.catch(() => Effect.void))));
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
      catch: cause => new RecallIndexOperationError(cause instanceof Error ? cause.message : String(cause), {cause}),
    });
    const seedStateRaw = yield* fs.readFileString(pathService.join(config.agentContextHome, SEED_STATE_FILE));
    const seedState = yield* Effect.try({
      try: () => parseSeedState(seedStateRaw),
      catch: cause => new RecallIndexOperationError(cause instanceof Error ? cause.message : String(cause), {cause}),
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
  const stringValues = [
    'authority',
    'contentHash',
    'kind',
    'memoryId',
    'status',
    'timestamp',
    'trust',
    'validFrom',
    'validTo',
  ] as const;
  if (stringValues.some(key => value[key] !== undefined && typeof value[key] !== 'string')) {
    return false;
  }
  const numberValues = ['feedback', 'reranker', 'semantic'] as const;
  if (numberValues.some(key => value[key] !== undefined && !isFiniteNumber(value[key]))) {
    return false;
  }
  if (value.identityConflict !== undefined && typeof value.identityConflict !== 'boolean') {
    return false;
  }
  if (value.exactTerms !== undefined && !isStringArray(value.exactTerms)) {
    return false;
  }
  if (value.equivalentUris !== undefined && !isStringArray(value.equivalentUris)) {
    return false;
  }
  if (value.fields !== undefined) {
    if (!isPlainRecord(value.fields)) return false;
    const fields = value.fields;
    if (
      !['project', 'title', 'topic', 'workspaceScope'].every(
        key => fields[key] === undefined || typeof fields[key] === 'string',
      ) ||
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
