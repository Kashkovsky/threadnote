import {Effect, FileSystem, Path} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {forEachFileWithinBoundary} from '../effect/safe_scan.js';
import {uriSegment} from '../manifest.js';
import {canonicalResourceUri, parseResourceId} from '../storage/resource-id.js';
import {normalizeRecallProject} from './eligibility.js';
import {recallApprovedAuthoritative} from './index_eligibility.js';
import type {RecallIndexPosting} from './index_lexical.js';
import {stripRecallAnchor} from './index_lexical.js';
import {normalizeRecallWorkspaceScope} from './index_scope.js';
import {normalizedRecallRecordedAt} from './index_selection.js';
import {recallCandidateLogicalCorpusKey, type RecallCandidate} from './rank.js';

export interface RecallIndexSource {
  readonly modifiedAt?: string;
  readonly path: string;
  readonly size: number;
  readonly uri: string;
}

export interface CanonicalResourcePolicy {
  readonly entryKeyByUri: ReadonlyMap<string, string>;
  readonly sourcePathByUri: ReadonlyMap<string, string>;
}

export interface IndexedRecallSource {
  readonly candidate: RecallCandidate;
  readonly documentLength: number;
  readonly exactSearchText: string;
  readonly postings: ReadonlyMap<string, RecallIndexPosting>;
  readonly source: RecallIndexSource;
}

interface RecallRefreshSourceInsert extends RecallIndexSource {
  readonly authorityPolicyKey: string | null;
  readonly invalidated: boolean;
}

interface RecallRefreshSourceRow {
  readonly source_modified_at: string | null;
  readonly source_path: string;
  readonly source_size: number;
  readonly uri: string;
}

interface RecallRefreshIndexedGenerationRow {
  readonly candidate_json: string;
  readonly uri: string;
}

interface RecallRefreshConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly user: string;
}

// Keep decoded source text, candidate JSON, exact-search text, and postings
// comfortably below the scale gate even when every file reaches the 512 KiB
// indexing limit. Source metadata is cheap enough to use a larger scan batch.
const RECALL_REFRESH_INDEX_PAGE_SIZE = 8;
const RECALL_REFRESH_GENERATION_PAGE_SIZE = 16;
const RECALL_REFRESH_SOURCE_PAGE_SIZE = 256;
const MAX_INDEXED_FILE_BYTES = 512 * 1_024;
const TEXT_EXTENSIONS = new Set(['.json', '.md', '.mdx', '.txt', '.yaml', '.yml']);

export const RECALL_REFRESH_AFFECTED_TERM_TABLE = 'recall_refresh_affected_terms';
export const RECALL_REFRESH_INDEXED_DOCUMENT_TABLE = 'recall_refresh_indexed_documents';
export const RECALL_REFRESH_INDEXED_POSTING_TABLE = 'recall_refresh_indexed_postings';
export const RECALL_REFRESH_REPLACED_DOCUMENT_TABLE = 'recall_refresh_replaced_documents';
export const RECALL_REFRESH_SOURCE_TABLE = 'recall_refresh_sources';

export const scanRecallSources = Effect.fn('recall.scanSources')(function* (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RecallRefreshConfig,
  includeInactive: boolean,
  canonicalResourcePolicy: CanonicalResourcePolicy,
  invalidatedUris: ReadonlySet<string>,
) {
  yield* prepareRecallSourceScan(sql);
  let pendingSources: RecallRefreshSourceInsert[] = [];
  let scannedSourceCount = 0;
  let skippedOversizedDocumentCount = 0;
  const flushPendingSources = () => {
    if (pendingSources.length === 0) return Effect.void;
    const batch = pendingSources;
    pendingSources = [];
    return sql.unsafe(
      `INSERT INTO ${RECALL_REFRESH_SOURCE_TABLE} (
        uri, source_path, source_modified_at, source_size, authority_policy_key, invalidated
      ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
      batch.flatMap(source => [
        source.uri,
        source.path,
        source.modifiedAt ?? null,
        source.size,
        source.authorityPolicyKey,
        source.invalidated ? 1 : 0,
      ]),
    );
  };
  for (const root of recallIndexRoots(config, path)) {
    const rootId = parseResourceId(root.uri);
    yield* forEachFileWithinBoundary(
      fs,
      root.path,
      root.path,
      {
        includeDirectory: candidate => !excludedDirectory(candidate, includeInactive),
        includeFile: candidate => !excludedFile(candidate),
      },
      file =>
        Effect.gen(function* () {
          if (file.size > MAX_INDEXED_FILE_BYTES) {
            skippedOversizedDocumentCount += 1;
            return;
          }
          const relativeSegments = path
            .relative(root.path, file.path)
            .split(path.sep)
            .map(segment => segment.normalize('NFC'));
          const uri = canonicalResourceUri(rootId.namespace, [...rootId.segments, ...relativeSegments]);
          pendingSources.push({
            authorityPolicyKey: canonicalResourcePolicy.entryKeyByUri.get(uri) ?? null,
            invalidated: invalidatedUris.has(uri),
            modifiedAt: file.modifiedAt?.toISOString(),
            path: file.path,
            size: file.size,
            uri,
          });
          scannedSourceCount += 1;
          if (pendingSources.length >= RECALL_REFRESH_SOURCE_PAGE_SIZE) yield* flushPendingSources();
        }),
    );
  }
  yield* flushPendingSources();
  return {scannedSourceCount, skippedOversizedDocumentCount};
});

export function countRecallSourceChanges(sql: SqlClient.SqlClient, forceRefresh: boolean) {
  return sql
    .unsafe<{readonly changed_source_count: number; readonly removed_source_count: number}>(
      `SELECT
        (SELECT COUNT(*) FROM temp.${RECALL_REFRESH_SOURCE_TABLE} AS source
         LEFT JOIN documents AS document ON document.uri = source.uri
         WHERE (? = 1 OR source.invalidated = 1 OR document.id IS NULL
           OR document.source_path <> source.source_path
           OR document.source_modified_at IS NOT source.source_modified_at
           OR document.source_size <> source.source_size
           OR document.authority_policy_key IS NOT source.authority_policy_key)) AS changed_source_count,
        (SELECT COUNT(*) FROM documents AS document
         LEFT JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS source ON source.uri = document.uri
         WHERE source.uri IS NULL) AS removed_source_count`,
      [forceRefresh ? 1 : 0],
    )
    .pipe(
      Effect.map(rows => ({
        changedSourceCount: rows[0]?.changed_source_count ?? 0,
        removedSourceCount: rows[0]?.removed_source_count ?? 0,
      })),
    );
}

export function forEachChangedRecallSourcePage<A, E, R>(
  sql: SqlClient.SqlClient,
  forceRefresh: boolean,
  visitPage: (page: readonly RecallIndexSource[]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    let cursor: string | undefined;
    while (true) {
      const cursorPredicate = cursor === undefined ? '' : 'AND source.uri COLLATE BINARY > ? COLLATE BINARY';
      const rows = yield* sql.unsafe<RecallRefreshSourceRow>(
        `SELECT source.uri, source.source_path, source.source_modified_at, source.source_size
         FROM temp.${RECALL_REFRESH_SOURCE_TABLE} AS source
         LEFT JOIN documents AS document ON document.uri = source.uri
         WHERE (? = 1 OR source.invalidated = 1 OR document.id IS NULL
           OR document.source_path <> source.source_path
           OR document.source_modified_at IS NOT source.source_modified_at
           OR document.source_size <> source.source_size
           OR document.authority_policy_key IS NOT source.authority_policy_key)
         ${cursorPredicate}
         ORDER BY source.uri COLLATE BINARY LIMIT ?`,
        cursor === undefined
          ? [forceRefresh ? 1 : 0, RECALL_REFRESH_INDEX_PAGE_SIZE]
          : [forceRefresh ? 1 : 0, cursor, RECALL_REFRESH_INDEX_PAGE_SIZE],
      );
      if (rows.length === 0) break;
      yield* visitPage(
        rows.map(row => ({
          modifiedAt: row.source_modified_at ?? undefined,
          path: row.source_path,
          size: row.source_size,
          uri: row.uri,
        })),
      );
      cursor = rows.at(-1)?.uri;
      if (rows.length < RECALL_REFRESH_INDEX_PAGE_SIZE) break;
    }
  });
}

export function insertIndexedRecallSources(sql: SqlClient.SqlClient, indexedSources: readonly IndexedRecallSource[]) {
  return Effect.gen(function* () {
    if (indexedSources.length === 0) return;
    yield* sql.unsafe(
      `INSERT INTO temp.${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE} (
        uri, project, approved_authoritative, workspace_scope, recorded_at,
        candidate_json, logical_key, document_length, exact_search_text
      ) VALUES ${indexedSources.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      indexedSources.flatMap(indexed => [
        stripRecallAnchor(indexed.candidate.uri),
        normalizeRecallProject(indexed.candidate.fields?.project) ?? null,
        recallApprovedAuthoritative(indexed.candidate.authority, indexed.candidate.trust) ? 1 : 0,
        normalizeRecallWorkspaceScope(indexed.candidate.fields?.workspaceScope) ?? null,
        normalizedRecallRecordedAt(indexed.candidate.timestamp),
        JSON.stringify(indexed.candidate),
        recallCandidateLogicalCorpusKey(indexed.candidate),
        indexed.documentLength,
        indexed.exactSearchText,
      ]),
    );
    let postingBatch: Array<readonly [string, string, number, number]> = [];
    const flushPostings = () => {
      if (postingBatch.length === 0) return Effect.void;
      const current = postingBatch;
      postingBatch = [];
      return sql.unsafe(
        `INSERT INTO temp.${RECALL_REFRESH_INDEXED_POSTING_TABLE} (
          uri, term, field_weight, term_frequency
        ) VALUES ${current.map(() => '(?, ?, ?, ?)').join(', ')}`,
        current.flat(),
      );
    };
    for (const indexed of indexedSources) {
      for (const [term, posting] of indexed.postings) {
        postingBatch.push([indexed.source.uri, term, posting.fieldWeight, posting.termFrequency]);
        if (postingBatch.length >= 400) yield* flushPostings();
      }
    }
    yield* flushPostings();
  });
}

export function hashRecallRefreshGeneration(sql: SqlClient.SqlClient, previousContentGeneration: string | undefined) {
  return Effect.gen(function* () {
    const hash = new Bun.CryptoHasher('sha256');
    hash.update('{"changed":[');
    let first = true;
    let cursor: string | undefined;
    while (true) {
      const predicate = cursor === undefined ? '' : 'WHERE uri COLLATE BINARY > ? COLLATE BINARY';
      const rows = yield* sql.unsafe<RecallRefreshIndexedGenerationRow>(
        `SELECT uri, candidate_json FROM temp.${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE}
         ${predicate} ORDER BY uri COLLATE BINARY LIMIT ?`,
        cursor === undefined ? [RECALL_REFRESH_GENERATION_PAGE_SIZE] : [cursor, RECALL_REFRESH_GENERATION_PAGE_SIZE],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        hash.update(`${first ? '' : ','}{"candidate":${row.candidate_json},"uri":${JSON.stringify(row.uri)}}`);
        first = false;
      }
      cursor = rows.at(-1)?.uri;
      if (rows.length < RECALL_REFRESH_GENERATION_PAGE_SIZE) break;
    }
    hash.update(`],"previous":${JSON.stringify(previousContentGeneration ?? null)},"removed":[`);
    first = true;
    cursor = undefined;
    while (true) {
      const predicate: string = cursor === undefined ? '' : 'AND document.uri COLLATE BINARY > ? COLLATE BINARY';
      const rows: readonly {readonly uri: string}[] = yield* sql.unsafe<{readonly uri: string}>(
        `SELECT document.uri FROM documents AS document
         LEFT JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS source ON source.uri = document.uri
         WHERE source.uri IS NULL ${predicate}
         ORDER BY document.uri COLLATE BINARY LIMIT ?`,
        cursor === undefined ? [RECALL_REFRESH_SOURCE_PAGE_SIZE] : [cursor, RECALL_REFRESH_SOURCE_PAGE_SIZE],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        hash.update(`${first ? '' : ','}${JSON.stringify(row.uri)}`);
        first = false;
      }
      cursor = rows.at(-1)?.uri;
      if (rows.length < RECALL_REFRESH_SOURCE_PAGE_SIZE) break;
    }
    hash.update(']}');
    return hash.digest('hex');
  });
}

export function stageRecallRefreshAffectedTerms(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql.unsafe(`
      INSERT INTO temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE} (document_id)
      SELECT document.id FROM documents AS document
      LEFT JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS source ON source.uri = document.uri
      LEFT JOIN temp.${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE} AS indexed ON indexed.uri = document.uri
      WHERE source.uri IS NULL OR indexed.uri IS NOT NULL
    `);
    yield* sql.unsafe(`
      INSERT OR IGNORE INTO temp.${RECALL_REFRESH_AFFECTED_TERM_TABLE} (term)
      SELECT posting.term FROM postings AS posting
      INNER JOIN temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE} AS replaced
        ON replaced.document_id = posting.document_id
    `);
    yield* sql.unsafe(`
      INSERT OR IGNORE INTO temp.${RECALL_REFRESH_AFFECTED_TERM_TABLE} (term)
      SELECT term FROM temp.${RECALL_REFRESH_INDEXED_POSTING_TABLE}
    `);
  });
}

export function dropRecallSourceScan(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    for (const table of [
      RECALL_REFRESH_REPLACED_DOCUMENT_TABLE,
      RECALL_REFRESH_AFFECTED_TERM_TABLE,
      RECALL_REFRESH_INDEXED_POSTING_TABLE,
      RECALL_REFRESH_INDEXED_DOCUMENT_TABLE,
      RECALL_REFRESH_SOURCE_TABLE,
    ]) {
      yield* sql.unsafe(`DROP TABLE IF EXISTS temp.${table}`);
    }
  });
}

function prepareRecallSourceScan(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql.unsafe('PRAGMA temp_store = FILE');
    yield* dropRecallSourceScan(sql);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_SOURCE_TABLE} (
      uri TEXT PRIMARY KEY NOT NULL, source_path TEXT NOT NULL, source_modified_at TEXT,
      source_size INTEGER NOT NULL CHECK (source_size >= 0), authority_policy_key TEXT,
      invalidated INTEGER NOT NULL CHECK (invalidated IN (0, 1))) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE} (
      uri TEXT PRIMARY KEY NOT NULL, project TEXT,
      approved_authoritative INTEGER NOT NULL CHECK (approved_authoritative IN (0, 1)),
      workspace_scope TEXT, recorded_at TEXT, candidate_json TEXT NOT NULL, logical_key TEXT NOT NULL,
      document_length INTEGER NOT NULL CHECK (document_length >= 0), exact_search_text TEXT NOT NULL) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_INDEXED_POSTING_TABLE} (
      uri TEXT NOT NULL, term TEXT NOT NULL, field_weight REAL NOT NULL CHECK (field_weight >= 0),
      term_frequency INTEGER NOT NULL CHECK (term_frequency > 0), PRIMARY KEY (uri, term)) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_AFFECTED_TERM_TABLE} (
      term TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE} (
      document_id INTEGER PRIMARY KEY NOT NULL) WITHOUT ROWID`);
  });
}

function recallIndexRoots(config: RecallRefreshConfig, path: Path.Path) {
  const storageRoot = path.join(config.agentContextHome, 'data', config.account);
  return [
    {path: path.join(storageRoot, 'resources'), uri: 'threadnote://resources'},
    {
      path: path.join(storageRoot, 'user', uriSegment(config.user), 'memories'),
      uri: `threadnote://user/${uriSegment(config.user)}/memories`,
    },
  ];
}

function excludedDirectory(path: string, includeInactive: boolean): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.includes('/agent-artifacts/packs/')) return true;
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
