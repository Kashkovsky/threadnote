import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Clock, Context, Crypto, Effect, FileSystem, Layer, Option, Path} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import * as SqlError from 'effect/unstable/sql/SqlError';
import {SystemInfo} from '../effect/system.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphProvenance,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  CodeGraphQueryNode,
  RepositoryIdentity,
} from './types.js';
import {CODE_GRAPH_SCHEMA_VERSION, CodeGraphBudgetExceeded, CodeGraphStoreError} from './types.js';

const MAX_CODE_GRAPH_LEXICAL_TERMS = 4_000_000;

interface SnapshotRow {
  readonly base_snapshot_id: unknown;
  readonly commit_id: string;
  readonly completed_at: unknown;
  readonly dirty: number;
  readonly edge_count: number;
  readonly extractor_set: string;
  readonly file_count: number;
  readonly id: string;
  readonly overlay_fingerprint: unknown;
  readonly repository_id: string;
  readonly state: CodeGraphSnapshot['state'];
  readonly symbol_count: number;
  readonly worktree_id: string;
}

interface SymbolRow {
  readonly content_hash: string;
  readonly documentation: unknown;
  readonly exported: number;
  readonly id: string;
  readonly kind: string;
  readonly language: string;
  readonly name: string;
  readonly package_name: unknown;
  readonly path: string;
  readonly qualified_name: string;
  readonly signature: unknown;
  readonly span_json: string;
}

interface EdgeRow {
  readonly confidence: number;
  readonly evidence_path: string;
  readonly evidence_span_json: string;
  readonly id: string;
  readonly provenance: CodeGraphEdge['provenance'];
  readonly relation: CodeGraphEdge['relation'];
  readonly source_id: unknown;
  readonly source_name: string;
  readonly target_id: unknown;
  readonly target_name: string;
}

interface FileBlobRow {
  readonly content_hash: string;
  readonly facts_json: string;
}

export interface StoredCodeGraph {
  readonly edges: readonly CodeGraphEdge[];
  readonly snapshot: CodeGraphSnapshot;
  readonly symbols: readonly CodeGraphSymbol[];
}

export interface CodeGraphEdgeCursor {
  readonly id: string;
  readonly relation: string;
  readonly sourceName: string;
  readonly targetName: string;
}

export interface CodeGraphSymbolCursor {
  readonly id: string;
  readonly path: string;
  readonly qualifiedName: string;
}

export interface CodeGraphDatabaseHealth {
  readonly activeSnapshots: number;
  readonly buildingSnapshots: number;
  readonly cachedFileBlobs: number;
  readonly failedSnapshots: number;
  readonly foreignKeyViolations: number;
  readonly integrity: 'corrupt' | 'incompatible' | 'ok';
  readonly readySnapshots: number;
  readonly schemaVersion?: number;
}

export interface CodeGraphDatabaseRepair {
  readonly removedSnapshots: number;
}

export interface CodeGraphStoreShape {
  readonly withSession: <A, E, R>(
    databasePath: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CodeGraphStoreError, R>;
  readonly activate: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    files: readonly CodeGraphInventoryFile[],
    symbols: readonly CodeGraphSymbol[],
    edges: readonly CodeGraphEdge[],
    cacheExtractorSet: string,
    pruneCache: boolean,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly cacheFacts: (
    databasePath: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphFileFacts[],
    extractorSet: string,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly cachedFactCounts: (
    databasePath: string,
    files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
    extractorSet: string,
  ) => Effect.Effect<{readonly edges: number; readonly files: number; readonly symbols: number}, CodeGraphStoreError>;
  readonly acquireSnapshotLease: (
    databasePath: string,
    snapshotId: string,
    durationMilliseconds: number,
  ) => Effect.Effect<string, CodeGraphStoreError>;
  readonly promote: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshotId: string,
    activeWorktreeIds: ReadonlySet<string>,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly initialize: (databasePath: string) => Effect.Effect<void, CodeGraphStoreError>;
  readonly diagnose: (databasePath: string) => Effect.Effect<CodeGraphDatabaseHealth | undefined, CodeGraphStoreError>;
  readonly cachedCommittedFileKeys: (
    databasePath: string,
    extractorSet: string,
  ) => Effect.Effect<ReadonlySet<string>, CodeGraphStoreError>;
  readonly loadCachedFacts: (
    databasePath: string,
    files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
    extractorSet: string,
  ) => Effect.Effect<ReadonlyMap<string, CodeGraphFileFacts>, CodeGraphStoreError>;
  readonly loadGraph: (databasePath: string, snapshotId: string) => Effect.Effect<StoredCodeGraph, CodeGraphStoreError>;
  readonly loadSymbols: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreError>;
  readonly loadEdgePage: (
    databasePath: string,
    snapshotId: string,
    cursor: CodeGraphEdgeCursor | undefined,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphEdge[], CodeGraphStoreError>;
  readonly loadSymbolPage: (
    databasePath: string,
    snapshotId: string,
    cursor: CodeGraphSymbolCursor | undefined,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreError>;
  readonly edgesForNodes: (
    databasePath: string,
    snapshotId: string,
    nodeIds: readonly string[],
    direction: 'both' | 'incoming' | 'outgoing',
    limit: number,
    allowedProvenances: readonly CodeGraphProvenance[],
  ) => Effect.Effect<readonly CodeGraphEdge[], CodeGraphStoreError>;
  readonly findSymbolsByPathAndName: (
    databasePath: string,
    snapshotId: string,
    path: string,
    name: string,
  ) => Effect.Effect<readonly CodeGraphQueryNode[], CodeGraphStoreError>;
  readonly markBuilding: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly markFailed: (
    databasePath: string,
    snapshotId: string,
    summary: string,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly readySnapshot: (
    databasePath: string,
    worktreeId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreError>;
  readonly readySnapshotById: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreError>;
  readonly readySnapshotForCommit: (
    databasePath: string,
    repositoryId: string,
    commit: string,
    extractorSet?: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreError>;
  readonly reconcileWorktrees: (
    databasePath: string,
    activeWorktreeIds: ReadonlySet<string>,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly pruneCachedFacts: (databasePath: string) => Effect.Effect<void, CodeGraphStoreError>;
  readonly repair: (databasePath: string) => Effect.Effect<CodeGraphDatabaseRepair | undefined, CodeGraphStoreError>;
  readonly releaseSnapshotLease: (databasePath: string, token: string) => Effect.Effect<void, CodeGraphStoreError>;
  readonly searchSymbols: (
    databasePath: string,
    snapshotId: string,
    query: string,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphQueryNode[], CodeGraphStoreError>;
  readonly searchSymbolsMany: (
    databasePath: string,
    snapshotId: string,
    queries: readonly string[],
    limit: number,
  ) => Effect.Effect<readonly (readonly CodeGraphQueryNode[])[], CodeGraphStoreError>;
  readonly searchSymbolsByPaths: (
    databasePath: string,
    snapshotId: string,
    paths: readonly string[],
    limitPerPath: number,
  ) => Effect.Effect<readonly (readonly CodeGraphQueryNode[])[], CodeGraphStoreError>;
  readonly symbolsByIds: (
    databasePath: string,
    snapshotId: string,
    ids: readonly string[],
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreError>;
}

interface CodeGraphDatabaseSessionShape {
  readonly databasePath: string;
  readonly sql: SqlClient.SqlClient;
}

class CodeGraphDatabaseSession extends Context.Service<CodeGraphDatabaseSession, CodeGraphDatabaseSessionShape>()(
  'threadnote/codeGraph/CodeGraphDatabaseSession',
) {}

export class CodeGraphStore extends Context.Service<CodeGraphStore, CodeGraphStoreShape>()(
  'threadnote/codeGraph/CodeGraphStore',
) {
  static readonly layer = Layer.effect(
    CodeGraphStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const system = yield* SystemInfo;
      const prepare = (databasePath: string) =>
        fs
          .makeDirectory(path.dirname(databasePath), {recursive: true, mode: 0o700})
          .pipe(Effect.mapError(cause => storeError('prepare code graph database', cause)));
      return CodeGraphStore.of({
        withSession: (databasePath, effect) =>
          useDatabaseDirect(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* configureConnection(sql);
              return yield* effect.pipe(Effect.provideService(CodeGraphDatabaseSession, {databasePath, sql}));
            }),
          ).pipe(
            Effect.catchTag('SqlError', cause =>
              Effect.fail(storeError('use code graph database session', cause as SqlError.SqlError)),
            ),
          ),
        acquireSnapshotLease: (databasePath, snapshotId, durationMilliseconds) =>
          Effect.gen(function* () {
            const token = `${system.processId}:${yield* crypto.randomUUIDv4}`;
            return yield* prepare(databasePath).pipe(
              Effect.andThen(useDatabase(databasePath, acquireSnapshotLease(snapshotId, durationMilliseconds, token))),
              Effect.mapError(cause => storeError('acquire code graph snapshot lease', cause)),
            );
          }).pipe(Effect.mapError(cause => storeError('acquire code graph snapshot lease', cause))),
        activate: (databasePath, identity, snapshot, files, symbols, edges, cacheExtractorSet, pruneCache) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* initializeSchema(sql);
                  yield* activateSnapshot(
                    sql,
                    identity,
                    snapshot,
                    files,
                    symbols,
                    edges,
                    cacheExtractorSet,
                    pruneCache,
                  );
                }),
              ),
            ),
            Effect.mapError(cause => storeError('activate code graph snapshot', cause)),
          ),
        cacheFacts: (databasePath, files, facts, extractorSet) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
                  if (Option.isNone(session) || session.value.databasePath !== databasePath) {
                    yield* initializeSchema(sql);
                  }
                  yield* sql.withTransaction(storeFreshFacts(sql, files, facts, extractorSet));
                }),
              ),
            ),
            Effect.mapError(cause => storeError('cache code graph file facts', cause)),
          ),
        cachedFactCounts: (databasePath, files, extractorSet) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectCachedFactCounts(files, extractorSet))),
            Effect.mapError(cause => storeError('count cached code graph facts', cause)),
          ),
        promote: (databasePath, identity, snapshotId, activeWorktreeIds) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, promoteSnapshot(identity, snapshotId, activeWorktreeIds))),
            Effect.mapError(cause => storeError('promote code graph snapshot', cause)),
          ),
        initialize: databasePath =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  yield* initializeSchema(yield* SqlClient.SqlClient);
                }),
              ),
            ),
            Effect.mapError(cause => storeError('initialize code graph database', cause)),
          ),
        diagnose: databasePath =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, diagnoseDatabase()) : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('diagnose code graph database', cause)),
          ),
        cachedCommittedFileKeys: (databasePath, extractorSet) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useDatabase(databasePath, selectCachedCommittedFileKeys(extractorSet))
                : Effect.succeed(new Set<string>()),
            ),
            Effect.mapError(cause => storeError('load cached code graph file keys', cause)),
          ),
        edgesForNodes: (databasePath, snapshotId, nodeIds, direction, limit, allowedProvenances) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(databasePath, selectEdgesForNodes(snapshotId, nodeIds, direction, limit, allowedProvenances)),
            ),
            Effect.mapError(cause => storeError('load code graph adjacency', cause)),
          ),
        findSymbolsByPathAndName: (databasePath, snapshotId, sourcePath, name) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectSymbolsByPathAndName(snapshotId, sourcePath, name))),
            Effect.mapError(cause => storeError('resolve qualified code graph symbol', cause)),
          ),
        loadCachedFacts: (databasePath, files, extractorSet) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectCachedFacts(files, extractorSet))),
            Effect.mapError(cause => storeError('load cached code graph facts', cause)),
          ),
        loadGraph: (databasePath, snapshotId) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectStoredGraph(snapshotId))),
            Effect.mapError(cause => storeError('load code graph snapshot', cause)),
          ),
        loadSymbols: (databasePath, snapshotId) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectStoredSymbols(snapshotId))),
            Effect.mapError(cause => storeError('load code graph snapshot symbols', cause)),
          ),
        loadEdgePage: (databasePath, snapshotId, cursor, limit) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectEdgePage(snapshotId, cursor, limit))),
            Effect.mapError(cause => storeError('load code graph edge page', cause)),
          ),
        loadSymbolPage: (databasePath, snapshotId, cursor, limit) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectSymbolPage(snapshotId, cursor, limit))),
            Effect.mapError(cause => storeError('load code graph symbol page', cause)),
          ),
        markBuilding: (databasePath, identity, snapshot) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* initializeSchema(sql);
                  yield* upsertRepository(sql, identity);
                  yield* sql`
                    INSERT INTO snapshots (
                      id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set,
                      dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at
                    ) VALUES (
                      ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
                      ${snapshot.baseSnapshotId ?? null}, ${snapshot.extractorSet}, ${snapshot.dirty ? 1 : 0},
                      ${snapshot.overlayFingerprint ?? null}, 'building', 0, 0, 0, ${new Date().toISOString()}
                    )
                    ON CONFLICT(id) DO NOTHING
                  `;
                }),
              ),
            ),
            Effect.mapError(cause => storeError('start code graph snapshot', cause)),
          ),
        markFailed: (databasePath, snapshotId, summary) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* configureConnection(sql);
                  yield* sql`
                    UPDATE snapshots
                    SET state = 'failed', failure_summary = ${summary.slice(0, 2_000)}, completed_at = ${new Date().toISOString()}
                    WHERE id = ${snapshotId}
                      AND state IN ('building', 'ready')
                      AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
                  `;
                }),
              ),
            ),
            Effect.mapError(cause => storeError('fail code graph snapshot', cause)),
          ),
        readySnapshot: (databasePath, worktreeId) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, selectReadySnapshot(worktreeId)) : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load ready code graph snapshot', cause)),
          ),
        readySnapshotById: (databasePath, snapshotId) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, selectReadySnapshotById(snapshotId)) : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load ready code graph snapshot by identity', cause)),
          ),
        readySnapshotForCommit: (databasePath, repositoryId, commit, extractorSet) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useDatabase(databasePath, selectReadySnapshotForCommit(repositoryId, commit, extractorSet))
                : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load ready code graph snapshot for commit', cause)),
          ),
        reconcileWorktrees: (databasePath, activeWorktreeIds) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useDatabase(
                    databasePath,
                    Effect.gen(function* () {
                      const sql = yield* SqlClient.SqlClient;
                      yield* configureConnection(sql);
                      yield* sql.withTransaction(reconcileActiveWorktrees(sql, activeWorktreeIds));
                      yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)');
                    }),
                  )
                : Effect.void,
            ),
            Effect.mapError(cause => storeError('reconcile code graph worktrees', cause)),
          ),
        pruneCachedFacts: databasePath =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useDatabase(
                    databasePath,
                    Effect.gen(function* () {
                      const sql = yield* SqlClient.SqlClient;
                      yield* configureConnection(sql);
                      yield* sql.withTransaction(pruneUnreferencedFileBlobs(sql));
                    }),
                  )
                : Effect.void,
            ),
            Effect.mapError(cause => storeError('prune cached code graph facts', cause)),
          ),
        repair: databasePath =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, repairDatabase()) : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('repair code graph database', cause)),
          ),
        releaseSnapshotLease: (databasePath, token) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists => (exists ? useDatabase(databasePath, releaseSnapshotLease(token)) : Effect.void)),
            Effect.mapError(cause => storeError('release code graph snapshot lease', cause)),
          ),
        searchSymbols: (databasePath, snapshotId, query, limit) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectSearchSymbols(snapshotId, query, limit))),
            Effect.mapError(cause => storeError('search code graph symbols', cause)),
          ),
        searchSymbolsMany: (databasePath, snapshotId, queries, limit) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectSearchSymbolsMany(snapshotId, queries, limit))),
            Effect.mapError(cause => storeError('search code graph symbols', cause)),
          ),
        searchSymbolsByPaths: (databasePath, snapshotId, sourcePaths, limitPerPath) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectSymbolsByPaths(snapshotId, sourcePaths, limitPerPath))),
            Effect.mapError(cause => storeError('search code graph symbols by path', cause)),
          ),
        symbolsByIds: (databasePath, snapshotId, ids) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectSymbolsByIds(snapshotId, ids))),
            Effect.mapError(cause => storeError('load code graph symbols', cause)),
          ),
      });
    }),
  );
}

function useDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.serviceOption(CodeGraphDatabaseSession).pipe(
    Effect.flatMap(session =>
      Option.isSome(session) && session.value.databasePath === databasePath
        ? effect.pipe(Effect.provideService(SqlClient.SqlClient, session.value.sql))
        : useDatabaseDirect(databasePath, effect),
    ),
  ) as Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>>;
}

function useDatabaseDirect<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(effect.pipe(Effect.provide(SqliteClient.layer({filename: databasePath})))) as Effect.Effect<
    A,
    E,
    Exclude<R, SqlClient.SqlClient>
  >;
}

const configureConnection = Effect.fn('codeGraph.configureConnection')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
});

const initializeSchema = Effect.fn('codeGraph.initializeSchema')(function* (sql: SqlClient.SqlClient) {
  yield* configureConnection(sql);
  yield* sql.unsafe('PRAGMA journal_mode = WAL');
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      object_format TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      worktree_id TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      base_snapshot_id TEXT,
      extractor_set TEXT NOT NULL,
      dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
      overlay_fingerprint TEXT,
      state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'failed', 'retired')),
      file_count INTEGER NOT NULL CHECK (file_count >= 0),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      failure_summary TEXT
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS active_snapshots (
      worktree_id TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      activated_at TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_leases (
      token TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_files (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      mode TEXT NOT NULL,
      size INTEGER NOT NULL CHECK (size >= 0),
      source TEXT NOT NULL CHECK (source IN ('commit', 'worktree')),
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_file_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS file_blobs (
      content_hash TEXT NOT NULL,
      extractor_set TEXT NOT NULL,
      path_hint TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (content_hash, extractor_set, path_hint)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS symbols (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      package_name TEXT,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      signature TEXT,
      documentation TEXT,
      span_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_symbol_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      symbol_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, symbol_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS edges (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      source_id TEXT,
      source_name TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_edge_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, edge_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS symbol_terms (
      snapshot_id TEXT NOT NULL,
      term TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (snapshot_id, term, symbol_id),
      FOREIGN KEY (snapshot_id, symbol_id) REFERENCES symbols(snapshot_id, id) ON DELETE CASCADE
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshots_worktree_state ON snapshots(worktree_id, state)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshots_commit ON snapshots(repository_id, commit_id)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshot_leases_expiry ON snapshot_leases(expires_at)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshot_files_blob ON snapshot_files(path, content_hash)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_name ON symbols(snapshot_id, name)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_path ON symbols(snapshot_id, path)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_name_nocase ON symbols(snapshot_id, name COLLATE NOCASE)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS symbols_qualified_nocase ON symbols(snapshot_id, qualified_name COLLATE NOCASE)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_path_nocase ON symbols(snapshot_id, path COLLATE NOCASE)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS symbols_export_order ON symbols(snapshot_id, path, qualified_name, id)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS edges_source ON edges(snapshot_id, source_id, relation)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS edges_target ON edges(snapshot_id, target_id, relation)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS edges_export_order ON edges(snapshot_id, source_name, relation, target_name, id)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS terms_lookup ON symbol_terms(snapshot_id, term, weight DESC)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS terms_symbol ON symbol_terms(snapshot_id, symbol_id)');
  yield* sql`
    INSERT INTO schema_metadata (key, value)
    VALUES ('schema_version', ${String(CODE_GRAPH_SCHEMA_VERSION)})
    ON CONFLICT(key) DO NOTHING
  `;
  const rows = yield* sql<{readonly value: string}>`
    SELECT value FROM schema_metadata WHERE key = 'schema_version'
  `;
  if (rows[0]?.value !== String(CODE_GRAPH_SCHEMA_VERSION)) {
    return yield* Effect.fail(
      new CodeGraphStoreError(
        `Code graph schema ${rows[0]?.value ?? 'unknown'} is incompatible with ${CODE_GRAPH_SCHEMA_VERSION}.`,
      ),
    );
  }
});

const diagnoseDatabase = Effect.fn('codeGraph.diagnoseDatabase')(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  const integrityRows = yield* sql.unsafe<{readonly integrity_check: string}>('PRAGMA integrity_check(10)');
  const schemaRows = yield* sql<{readonly value: string}>`
    SELECT value FROM schema_metadata WHERE key = 'schema_version'
  `;
  const schemaVersion = Number.parseInt(schemaRows[0]?.value ?? '', 10);
  const stateRows = yield* sql<{readonly count: number; readonly state: CodeGraphSnapshot['state']}>`
    SELECT state, COUNT(*) AS count FROM snapshots GROUP BY state
  `;
  const activeRows = yield* sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM active_snapshots`;
  const cacheRows = yield* sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM file_blobs`;
  const foreignKeyRows = yield* sql.unsafe('PRAGMA foreign_key_check');
  const counts = new Map(stateRows.map(row => [row.state, Number(row.count)]));
  const integrityOk =
    integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok' && foreignKeyRows.length === 0;
  return {
    activeSnapshots: Number(activeRows[0]?.count ?? 0),
    buildingSnapshots: counts.get('building') ?? 0,
    cachedFileBlobs: Number(cacheRows[0]?.count ?? 0),
    failedSnapshots: counts.get('failed') ?? 0,
    foreignKeyViolations: foreignKeyRows.length,
    integrity:
      !Number.isSafeInteger(schemaVersion) || schemaVersion !== CODE_GRAPH_SCHEMA_VERSION
        ? 'incompatible'
        : integrityOk
          ? 'ok'
          : 'corrupt',
    readySnapshots: counts.get('ready') ?? 0,
    schemaVersion: Number.isSafeInteger(schemaVersion) ? schemaVersion : undefined,
  } satisfies CodeGraphDatabaseHealth;
});

const repairDatabase = Effect.fn('codeGraph.repairDatabase')(function* () {
  const sql = yield* SqlClient.SqlClient;
  const health = yield* diagnoseDatabase();
  if (health.integrity !== 'ok') {
    return yield* Effect.fail(
      new CodeGraphStoreError(`Code graph database is ${health.integrity}; discard and rebuild it.`),
    );
  }
  const candidates = health.buildingSnapshots + health.failedSnapshots;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (candidates > 0) {
        yield* sql`
          DELETE FROM snapshots
          WHERE state IN ('building', 'failed')
        `;
      }
      yield* pruneUnreferencedFileBlobs(sql);
    }),
  );
  return {removedSnapshots: candidates} satisfies CodeGraphDatabaseRepair;
});

const acquireSnapshotLease = Effect.fn('codeGraph.acquireSnapshotLease')(function* (
  snapshotId: string,
  durationMilliseconds: number,
  token: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const duration = Math.max(1_000, Math.min(60 * 60_000, Math.floor(durationMilliseconds)));
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM snapshot_leases WHERE expires_at <= ${now}`;
      const ready = yield* sql<{readonly id: string}>`
        SELECT id FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
      `;
      if (!ready[0]) {
        return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} is no longer available.`));
      }
      yield* sql`
        INSERT INTO snapshot_leases (token, snapshot_id, expires_at)
        VALUES (${token}, ${snapshotId}, ${now + duration})
      `;
    }),
  );
  return token;
});

const releaseSnapshotLease = Effect.fn('codeGraph.releaseSnapshotLease')(function* (token: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  yield* sql`DELETE FROM snapshot_leases WHERE token = ${token}`;
});

const activateSnapshot = Effect.fn('codeGraph.activateSnapshot')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  files: readonly CodeGraphInventoryFile[],
  inputSymbols: readonly CodeGraphSymbol[],
  inputEdges: readonly CodeGraphEdge[],
  cacheExtractorSet: string,
  pruneCache: boolean,
) {
  const symbols = inputSymbols;
  const edges = inputEdges;
  const baseSnapshotId = snapshot.baseSnapshotId;
  if (baseSnapshotId) {
    const base = yield* sql<{readonly id: string}>`
      SELECT id FROM snapshots WHERE id = ${baseSnapshotId} AND state = 'ready' LIMIT 1
    `;
    if (!base[0]) {
      return yield* Effect.fail(
        new CodeGraphStoreError(`Base snapshot ${baseSnapshotId} is not ready for a dirty overlay.`),
      );
    }
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* upsertRepository(sql, identity);
      const existing = yield* sql<{readonly state: CodeGraphSnapshot['state']}>`
        SELECT state FROM snapshots WHERE id = ${snapshot.id} LIMIT 1
      `;
      if (existing[0]?.state !== 'ready') {
        const startedAt = new Date().toISOString();
        const completedAt = snapshot.completedAt ?? startedAt;
        yield* sql`DELETE FROM snapshots WHERE id = ${snapshot.id}`;
        yield* sql`
          INSERT INTO snapshots (
            id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set,
            dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at
          ) VALUES (
            ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
            ${snapshot.baseSnapshotId ?? null}, ${snapshot.extractorSet}, ${snapshot.dirty ? 1 : 0},
            ${snapshot.overlayFingerprint ?? null}, 'ready', ${files.length}, ${symbols.length}, ${edges.length},
            ${startedAt}, ${completedAt}
          )
        `;
        if (!baseSnapshotId) {
          yield* assertLexicalTermBudget(symbols, 0);
          yield* insertSnapshotFiles(sql, snapshot.id, files);
          yield* insertSnapshotSymbols(sql, snapshot.id, symbols);
          yield* insertSymbolTerms(sql, snapshot.id, symbols);
          yield* insertSnapshotEdges(sql, snapshot.id, edges);
        } else {
          yield* prepareActivationTables(sql);
          yield* stageActivationFiles(sql, files);
          yield* stageActivationSymbols(sql, symbols);
          yield* stageActivationEdges(sql, edges);
          yield* identifyChangedSymbols(sql, baseSnapshotId);
          const changedSymbolRows = yield* sql<{readonly id: string}>`
            SELECT id FROM activation_changed_symbol_ids
          `;
          const changedSymbolIds = new Set(changedSymbolRows.map(row => row.id));
          const retainedTermCount = yield* sql<{readonly count: number}>`
            SELECT COUNT(*) AS count
            FROM symbol_terms AS base_terms
            WHERE base_terms.snapshot_id = ${baseSnapshotId}
              AND EXISTS (
                SELECT 1 FROM activation_symbols AS current
                WHERE current.id = base_terms.symbol_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM activation_changed_symbol_ids AS changed
                WHERE changed.id = base_terms.symbol_id
              )
          `;
          yield* assertLexicalTermBudget(symbols, Number(retainedTermCount[0]?.count ?? 0), changedSymbolIds);
          yield* sql`
            INSERT INTO snapshot_files (
              snapshot_id, path, content_hash, language, mode, size, source
            )
            SELECT ${snapshot.id}, current.path, current.content_hash, current.language,
              current.mode, current.size, current.source
            FROM activation_files AS current
            LEFT JOIN snapshot_files AS base
              ON base.snapshot_id = ${baseSnapshotId} AND base.path = current.path
            WHERE base.path IS NULL
               OR base.content_hash IS NOT current.content_hash
               OR base.language IS NOT current.language
               OR base.mode IS NOT current.mode
               OR base.size IS NOT current.size
               OR base.source IS NOT current.source
          `;
          yield* sql`
            INSERT INTO snapshot_file_deletions (snapshot_id, path)
            SELECT ${snapshot.id}, base.path
            FROM snapshot_files AS base
            WHERE base.snapshot_id = ${baseSnapshotId}
              AND NOT EXISTS (SELECT 1 FROM activation_files AS current WHERE current.path = base.path)
          `;
          yield* sql`
            INSERT INTO symbols (
              snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
              package_name, exported, signature, documentation, span_json
            )
            SELECT ${snapshot.id}, current.id, current.content_hash, current.kind, current.name,
              current.qualified_name, current.path, current.language, current.package_name,
              current.exported, current.signature, current.documentation, current.span_json
            FROM activation_symbols AS current
            JOIN activation_changed_symbol_ids AS changed ON changed.id = current.id
          `;
          yield* insertSymbolTerms(sql, snapshot.id, symbols, changedSymbolIds);
          yield* sql`
            INSERT INTO snapshot_symbol_deletions (snapshot_id, symbol_id)
            SELECT ${snapshot.id}, base.id
            FROM symbols AS base
            WHERE base.snapshot_id = ${baseSnapshotId}
              AND NOT EXISTS (SELECT 1 FROM activation_symbols AS current WHERE current.id = base.id)
          `;
          yield* sql`
            INSERT INTO edges (
              snapshot_id, id, source_id, source_name, relation, target_id, target_name,
              provenance, confidence, evidence_path, evidence_span_json
            )
            SELECT ${snapshot.id}, current.id, current.source_id, current.source_name,
              current.relation, current.target_id, current.target_name, current.provenance,
              current.confidence, current.evidence_path, current.evidence_span_json
            FROM activation_edges AS current
            LEFT JOIN edges AS base
              ON base.snapshot_id = ${baseSnapshotId} AND base.id = current.id
            WHERE base.id IS NULL
               OR base.source_id IS NOT current.source_id
               OR base.source_name IS NOT current.source_name
               OR base.relation IS NOT current.relation
               OR base.target_id IS NOT current.target_id
               OR base.target_name IS NOT current.target_name
               OR base.provenance IS NOT current.provenance
               OR base.confidence IS NOT current.confidence
               OR base.evidence_path IS NOT current.evidence_path
               OR base.evidence_span_json IS NOT current.evidence_span_json
          `;
          yield* sql`
            INSERT INTO snapshot_edge_deletions (snapshot_id, edge_id)
            SELECT ${snapshot.id}, base.id
            FROM edges AS base
            WHERE base.snapshot_id = ${baseSnapshotId}
              AND NOT EXISTS (SELECT 1 FROM activation_edges AS current WHERE current.id = base.id)
          `;
        }
      }
      if (pruneCache) {
        yield* sql`
          DELETE FROM file_blobs
          WHERE extractor_set != ${cacheExtractorSet}
             OR NOT EXISTS (
               SELECT 1
               FROM snapshot_files
               WHERE snapshot_files.path = file_blobs.path_hint
                 AND snapshot_files.content_hash = file_blobs.content_hash
             )
        `;
      }
    }),
  );
  yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)');
});

function assertLexicalTermBudget(
  symbols: readonly CodeGraphSymbol[],
  retainedTermCount: number,
  includedSymbolIds?: ReadonlySet<string>,
) {
  return Effect.gen(function* () {
    let nextTermCount = retainedTermCount;
    for (const symbol of symbols) {
      if (includedSymbolIds && !includedSymbolIds.has(symbol.id)) continue;
      nextTermCount += symbolTerms(symbol).length;
      if (nextTermCount > MAX_CODE_GRAPH_LEXICAL_TERMS) {
        return yield* Effect.fail(
          new CodeGraphBudgetExceeded(`Code graph exceeds ${MAX_CODE_GRAPH_LEXICAL_TERMS} normalized lexical terms.`),
        );
      }
    }
  });
}

function insertSnapshotFiles(sql: SqlClient.SqlClient, snapshotId: string, files: readonly CodeGraphInventoryFile[]) {
  return Effect.gen(function* () {
    for (const batch of chunk(files, 400)) {
      yield* sql.unsafe(
        `INSERT INTO snapshot_files (
          snapshot_id, path, content_hash, language, mode, size, source
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(file => [
          snapshotId,
          file.path,
          file.contentHash,
          file.language,
          file.mode,
          file.size,
          file.source,
        ]),
      );
    }
  });
}

function insertSnapshotSymbols(sql: SqlClient.SqlClient, snapshotId: string, symbols: readonly CodeGraphSymbol[]) {
  return Effect.gen(function* () {
    for (const batch of chunk(symbols, 300)) {
      yield* sql.unsafe(
        `INSERT INTO symbols (
          snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
          package_name, exported, signature, documentation, span_json
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(symbol => [
          snapshotId,
          symbol.id,
          symbol.contentHash,
          symbol.kind,
          symbol.name,
          symbol.qualifiedName,
          symbol.path,
          symbol.language,
          symbol.packageName ?? null,
          symbol.exported ? 1 : 0,
          symbol.signature ?? null,
          symbol.documentation ?? null,
          JSON.stringify(symbol.span),
        ]),
      );
    }
  });
}

function insertSymbolTerms(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  symbols: readonly CodeGraphSymbol[],
  includedSymbolIds?: ReadonlySet<string>,
) {
  return Effect.gen(function* () {
    let termBatch: Array<readonly [string, string, string, number]> = [];
    for (const symbol of symbols) {
      if (includedSymbolIds && !includedSymbolIds.has(symbol.id)) continue;
      for (const [term, weight] of symbolTerms(symbol)) {
        termBatch.push([snapshotId, term, symbol.id, weight]);
      }
      if (termBatch.length < 200) continue;
      yield* sql.unsafe(
        `INSERT INTO symbol_terms (snapshot_id, term, symbol_id, weight)
         VALUES ${termBatch.map(() => '(?, ?, ?, ?)').join(', ')}`,
        termBatch.flat(),
      );
      termBatch = [];
    }
    if (termBatch.length > 0) {
      yield* sql.unsafe(
        `INSERT INTO symbol_terms (snapshot_id, term, symbol_id, weight)
         VALUES ${termBatch.map(() => '(?, ?, ?, ?)').join(', ')}`,
        termBatch.flat(),
      );
    }
  });
}

function insertSnapshotEdges(sql: SqlClient.SqlClient, snapshotId: string, edges: readonly CodeGraphEdge[]) {
  return Effect.gen(function* () {
    for (const batch of chunk(edges, 300)) {
      yield* sql.unsafe(
        `INSERT INTO edges (
          snapshot_id, id, source_id, source_name, relation, target_id, target_name,
          provenance, confidence, evidence_path, evidence_span_json
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(edge => [
          snapshotId,
          edge.id,
          edge.sourceId ?? null,
          edge.sourceName,
          edge.relation,
          edge.targetId ?? null,
          edge.targetName,
          edge.provenance,
          edge.confidence,
          edge.evidencePath,
          JSON.stringify(edge.evidenceSpan),
        ]),
      );
    }
  });
}

function storeFreshFacts(
  sql: SqlClient.SqlClient,
  files: readonly CodeGraphInventoryFile[],
  cacheFacts: readonly CodeGraphFileFacts[],
  cacheExtractorSet: string,
) {
  return Effect.gen(function* () {
    const createdAt = new Date().toISOString();
    const filesByPath = new Map(files.map(file => [file.path, file]));
    for (const fileFacts of cacheFacts) {
      const file = filesByPath.get(fileFacts.path);
      if (!file) {
        return yield* Effect.fail(
          new CodeGraphStoreError(`Fresh parser facts do not match the indexed file inventory: ${fileFacts.path}.`),
        );
      }
      yield* sql`
        INSERT INTO file_blobs (content_hash, extractor_set, path_hint, facts_json, created_at)
        VALUES (
          ${file.contentHash}, ${cacheExtractorSet}, ${file.path},
          ${JSON.stringify(fileFacts)}, ${createdAt}
        )
        ON CONFLICT(content_hash, extractor_set, path_hint) DO UPDATE SET
          facts_json = excluded.facts_json,
          created_at = excluded.created_at
      `;
    }
  });
}

const prepareActivationTables = Effect.fn('codeGraph.prepareActivationTables')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_files (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      mode TEXT NOT NULL,
      size INTEGER NOT NULL,
      source TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_symbols (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      package_name TEXT,
      exported INTEGER NOT NULL,
      signature TEXT,
      documentation TEXT,
      span_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      source_name TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(
    'CREATE TEMP TABLE IF NOT EXISTS activation_changed_symbol_ids (id TEXT PRIMARY KEY) WITHOUT ROWID',
  );
  yield* sql.unsafe('DELETE FROM activation_files');
  yield* sql.unsafe('DELETE FROM activation_symbols');
  yield* sql.unsafe('DELETE FROM activation_edges');
  yield* sql.unsafe('DELETE FROM activation_changed_symbol_ids');
});

function stageActivationFiles(sql: SqlClient.SqlClient, files: readonly CodeGraphInventoryFile[]) {
  return Effect.gen(function* () {
    for (const batch of chunk(files, 400)) {
      yield* sql.unsafe(
        `INSERT OR REPLACE INTO activation_files (
          path, content_hash, language, mode, size, source
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(file => [file.path, file.contentHash, file.language, file.mode, file.size, file.source]),
      );
    }
  });
}

function stageActivationSymbols(sql: SqlClient.SqlClient, symbols: readonly CodeGraphSymbol[]) {
  return Effect.gen(function* () {
    for (const batch of chunk(symbols, 300)) {
      yield* sql.unsafe(
        `INSERT OR REPLACE INTO activation_symbols (
          id, content_hash, kind, name, qualified_name, path, language, package_name,
          exported, signature, documentation, span_json
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(symbol => [
          symbol.id,
          symbol.contentHash,
          symbol.kind,
          symbol.name,
          symbol.qualifiedName,
          symbol.path,
          symbol.language,
          symbol.packageName ?? null,
          symbol.exported ? 1 : 0,
          symbol.signature ?? null,
          symbol.documentation ?? null,
          JSON.stringify(symbol.span),
        ]),
      );
    }
  });
}

function stageActivationEdges(sql: SqlClient.SqlClient, edges: readonly CodeGraphEdge[]) {
  return Effect.gen(function* () {
    for (const batch of chunk(edges, 300)) {
      yield* sql.unsafe(
        `INSERT OR REPLACE INTO activation_edges (
          id, source_id, source_name, relation, target_id, target_name, provenance,
          confidence, evidence_path, evidence_span_json
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(edge => [
          edge.id,
          edge.sourceId ?? null,
          edge.sourceName,
          edge.relation,
          edge.targetId ?? null,
          edge.targetName,
          edge.provenance,
          edge.confidence,
          edge.evidencePath,
          JSON.stringify(edge.evidenceSpan),
        ]),
      );
    }
  });
}

const identifyChangedSymbols = Effect.fn('codeGraph.identifyChangedSymbols')(function* (
  sql: SqlClient.SqlClient,
  baseSnapshotId: string | undefined,
) {
  if (!baseSnapshotId) {
    yield* sql.unsafe('INSERT INTO activation_changed_symbol_ids (id) SELECT id FROM activation_symbols');
    return;
  }
  yield* sql`
    INSERT INTO activation_changed_symbol_ids (id)
    SELECT current.id
    FROM activation_symbols AS current
    LEFT JOIN symbols AS base
      ON base.snapshot_id = ${baseSnapshotId} AND base.id = current.id
    WHERE base.id IS NULL
       OR base.content_hash IS NOT current.content_hash
       OR base.kind IS NOT current.kind
       OR base.name IS NOT current.name
       OR base.qualified_name IS NOT current.qualified_name
       OR base.path IS NOT current.path
       OR base.language IS NOT current.language
       OR base.package_name IS NOT current.package_name
       OR base.exported IS NOT current.exported
       OR base.signature IS NOT current.signature
       OR base.documentation IS NOT current.documentation
       OR base.span_json IS NOT current.span_json
  `;
});

const promoteSnapshot = Effect.fn('codeGraph.promoteSnapshot')(function* (
  identity: RepositoryIdentity,
  snapshotId: string,
  activeWorktreeIds: ReadonlySet<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const retainedWorktreeIds = [...new Set([...activeWorktreeIds, identity.worktreeId])];
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const candidate = yield* sql<{readonly id: string}>`
        SELECT id FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
      `;
      if (!candidate[0]) {
        return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} cannot be promoted.`));
      }
      yield* sql`
        DELETE FROM active_snapshots
        WHERE NOT (${sql.in('worktree_id', retainedWorktreeIds)})
      `;
      yield* sql`
        INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
        VALUES (${identity.worktreeId}, ${snapshotId}, ${new Date().toISOString()})
        ON CONFLICT(worktree_id) DO UPDATE SET
          snapshot_id = excluded.snapshot_id,
          activated_at = excluded.activated_at
      `;
      yield* retireUnusedSnapshots(sql);
      yield* pruneUnreferencedFileBlobs(sql);
    }),
  );
  yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)');
});

const reconcileActiveWorktrees = Effect.fn('codeGraph.reconcileActiveWorktrees')(function* (
  sql: SqlClient.SqlClient,
  activeWorktreeIds: ReadonlySet<string>,
) {
  const retained = [...activeWorktreeIds];
  if (retained.length === 0) yield* sql`DELETE FROM active_snapshots`;
  else {
    yield* sql`
      DELETE FROM active_snapshots
      WHERE NOT (${sql.in('worktree_id', retained)})
    `;
  }
  yield* retireUnusedSnapshots(sql);
  yield* pruneUnreferencedFileBlobs(sql);
});

const retireUnusedSnapshots = Effect.fn('codeGraph.retireUnusedSnapshots')(function* (sql: SqlClient.SqlClient) {
  const now = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM snapshot_leases WHERE expires_at <= ${now}`;
  yield* sql`
    UPDATE snapshots
    SET state = 'retired'
    WHERE state = 'ready'
      AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
      AND id NOT IN (SELECT snapshot_id FROM snapshot_leases)
      AND id NOT IN (
        SELECT base_snapshot_id FROM snapshots
        WHERE base_snapshot_id IS NOT NULL
          AND id IN (SELECT snapshot_id FROM active_snapshots UNION SELECT snapshot_id FROM snapshot_leases)
      )
  `;
  for (const table of ['symbol_terms', 'edges', 'symbols', 'snapshot_files'] as const) {
    yield* sql.unsafe(`
      DELETE FROM ${table}
      WHERE snapshot_id IN (
        SELECT id FROM snapshots
        WHERE state = 'retired'
          AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
          AND id NOT IN (SELECT snapshot_id FROM snapshot_leases)
      )
    `);
  }
  yield* sql`
    DELETE FROM snapshots
    WHERE state = 'retired'
      AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
      AND id NOT IN (SELECT snapshot_id FROM snapshot_leases)
  `;
});

const pruneUnreferencedFileBlobs = Effect.fn('codeGraph.pruneUnreferencedFileBlobs')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`
    DELETE FROM file_blobs
    WHERE NOT EXISTS (
      SELECT 1
      FROM snapshot_files
      WHERE snapshot_files.path = file_blobs.path_hint
        AND snapshot_files.content_hash = file_blobs.content_hash
    )
  `;
});

const selectReadySnapshot = Effect.fn('codeGraph.selectReadySnapshot')(function* (worktreeId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<SnapshotRow>`
    SELECT snapshots.*
    FROM active_snapshots
    JOIN snapshots ON snapshots.id = active_snapshots.snapshot_id
    WHERE active_snapshots.worktree_id = ${worktreeId}
      AND snapshots.state = 'ready'
    LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectReadySnapshotById = Effect.fn('codeGraph.selectReadySnapshotById')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectReadySnapshotForCommit = Effect.fn('codeGraph.selectReadySnapshotForCommit')(function* (
  repositoryId: string,
  commit: string,
  extractorSet?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<SnapshotRow>`
    SELECT *
    FROM snapshots
    WHERE repository_id = ${repositoryId}
      AND commit_id = ${commit}
      AND dirty = 0
      AND (${extractorSet ?? null} IS NULL OR extractor_set = ${extractorSet ?? null})
      AND state = 'ready'
    ORDER BY completed_at DESC, id
    LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectCachedFacts = Effect.fn('codeGraph.selectCachedFacts')(function* (
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  extractorSet: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const output = new Map<string, CodeGraphFileFacts>();
  for (const batch of chunk(files, 300)) {
    const rows = yield* selectFileBlobBatch(sql, batch, extractorSet);
    for (const row of rows) {
      try {
        output.set(row.path_hint, JSON.parse(row.facts_json) as CodeGraphFileFacts);
      } catch {
        // A malformed cache row is disposable and will be replaced after extraction.
      }
    }
  }
  return output;
});

const selectCachedFactCounts = Effect.fn('codeGraph.selectCachedFactCounts')(function* (
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  extractorSet: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const matchedPaths = new Set<string>();
  let edges = 0;
  let symbols = 0;
  for (const batch of chunk(files, 300)) {
    const rows = yield* selectFileBlobBatch(sql, batch, extractorSet);
    for (const row of rows) {
      try {
        const facts = JSON.parse(row.facts_json) as Partial<CodeGraphFileFacts>;
        if (!Array.isArray(facts.edges) || !Array.isArray(facts.symbols)) continue;
        matchedPaths.add(row.path_hint);
        edges += facts.edges.length;
        symbols += facts.symbols.length;
      } catch {
        // A malformed cache row is disposable and will be replaced after extraction.
      }
    }
  }
  return {edges, files: matchedPaths.size, symbols};
});

function selectFileBlobBatch(
  sql: SqlClient.SqlClient,
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  extractorSet: string,
) {
  if (files.length === 0) return Effect.succeed([] as readonly (FileBlobRow & {readonly path_hint: string})[]);
  return sql.unsafe<FileBlobRow & {readonly path_hint: string}>(
    `SELECT content_hash, path_hint, facts_json
     FROM file_blobs
     WHERE extractor_set = ?
       AND (${files.map(() => '(content_hash = ? AND path_hint = ?)').join(' OR ')})`,
    [extractorSet, ...files.flatMap(file => [file.contentHash, file.path])],
  );
}

const selectCachedCommittedFileKeys = Effect.fn('codeGraph.selectCachedCommittedFileKeys')(function* (
  extractorSet: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<{readonly content_hash: string; readonly path_hint: string}>`
    SELECT content_hash, path_hint
    FROM file_blobs
    WHERE extractor_set = ${extractorSet}
      AND json_valid(facts_json)
  `;
  return new Set(rows.map(row => `${row.path_hint}\0${row.content_hash}`));
});

const selectStoredGraph = Effect.fn('codeGraph.selectStoredGraph')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const snapshots = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots WHERE id = ${snapshotId} AND state = 'ready'
  `;
  const snapshot = snapshots[0];
  if (!snapshot) return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} was not found.`));
  const baseSnapshotId = Option.getOrUndefined(sqlTextOption(snapshot.base_snapshot_id));
  const [symbolRows, edgeRows] = yield* Effect.all(
    [
      selectAllEffectiveSymbols(sql, snapshotId, baseSnapshotId),
      selectAllEffectiveEdges(sql, snapshotId, baseSnapshotId),
    ],
    {concurrency: 1},
  );
  return {
    edges: edgeRows.map(edgeFromRow),
    snapshot: snapshotFromRow(snapshot),
    symbols: symbolRows.map(symbolFromRow),
  } satisfies StoredCodeGraph;
});

const selectStoredSymbols = Effect.fn('codeGraph.selectStoredSymbols')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return (yield* selectAllEffectiveSymbols(sql, snapshotId, baseSnapshotId)).map(symbolFromRow);
});

function effectiveSymbolsCte(): string {
  return `WITH effective_symbols AS (
    SELECT current_symbols.*
    FROM symbols AS current_symbols
    WHERE current_symbols.snapshot_id = ?
    UNION ALL
    SELECT base_symbols.*
    FROM symbols AS base_symbols
    WHERE base_symbols.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM symbols AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_symbol_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
      )
  )`;
}

function effectiveEdgesCte(): string {
  return `WITH effective_edges AS (
    SELECT current_edges.*
    FROM edges AS current_edges
    WHERE current_edges.snapshot_id = ?
    UNION ALL
    SELECT base_edges.*
    FROM edges AS base_edges
    WHERE base_edges.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM edges AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_edge_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
      )
  )`;
}

function effectiveSnapshotParameters(snapshotId: string, baseSnapshotId: string | undefined): readonly string[] {
  return [snapshotId, baseSnapshotId ?? '', snapshotId, snapshotId];
}

const selectBaseSnapshotId = Effect.fn('codeGraph.selectBaseSnapshotId')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  const rows = yield* sql<{readonly base_snapshot_id: unknown}>`
    SELECT base_snapshot_id FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
  `;
  if (!rows[0]) return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} was not found.`));
  return Option.getOrUndefined(sqlTextOption(rows[0].base_snapshot_id));
});

function selectAllEffectiveSymbols(sql: SqlClient.SqlClient, snapshotId: string, baseSnapshotId: string | undefined) {
  return sql.unsafe<SymbolRow>(
    `${effectiveSymbolsCte()}
     SELECT * FROM effective_symbols
     ORDER BY path, qualified_name, id`,
    effectiveSnapshotParameters(snapshotId, baseSnapshotId),
  );
}

function selectAllEffectiveEdges(sql: SqlClient.SqlClient, snapshotId: string, baseSnapshotId: string | undefined) {
  return sql.unsafe<EdgeRow>(
    `${effectiveEdgesCte()}
     SELECT * FROM effective_edges
     ORDER BY source_name, relation, target_name, id`,
    effectiveSnapshotParameters(snapshotId, baseSnapshotId),
  );
}

const selectSymbolPage = Effect.fn('codeGraph.selectSymbolPage')(function* (
  snapshotId: string,
  cursor: CodeGraphSymbolCursor | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = cursor
    ? yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         WHERE (path, qualified_name, id) > (?, ?, ?)
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [
          ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
          cursor.path,
          cursor.qualifiedName,
          cursor.id,
          boundedPageLimit(limit),
        ],
      )
    : yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), boundedPageLimit(limit)],
      );
  return rows.map(symbolFromRow);
});

const selectEdgePage = Effect.fn('codeGraph.selectEdgePage')(function* (
  snapshotId: string,
  cursor: CodeGraphEdgeCursor | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = cursor
    ? yield* sql.unsafe<EdgeRow>(
        `${effectiveEdgesCte()}
         SELECT * FROM effective_edges
         WHERE (source_name, relation, target_name, id) > (?, ?, ?, ?)
         ORDER BY source_name, relation, target_name, id
         LIMIT ?`,
        [
          ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
          cursor.sourceName,
          cursor.relation,
          cursor.targetName,
          cursor.id,
          boundedPageLimit(limit),
        ],
      )
    : yield* sql.unsafe<EdgeRow>(
        `${effectiveEdgesCte()}
         SELECT * FROM effective_edges
         ORDER BY source_name, relation, target_name, id
         LIMIT ?`,
        [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), boundedPageLimit(limit)],
      );
  return rows.map(edgeFromRow);
});

const selectSearchSymbols = Effect.fn('codeGraph.selectSearchSymbols')(function* (
  snapshotId: string,
  query: string,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return yield* selectSearchSymbolsWithSql(sql, snapshotId, baseSnapshotId, query, limit);
});

const selectSearchSymbolsWithSql = Effect.fn('codeGraph.selectSearchSymbolsWithSql')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string | undefined,
  query: string,
  limit: number,
) {
  const effectiveParameters = effectiveSnapshotParameters(snapshotId, baseSnapshotId);
  const terms = normalizedTerms(query).slice(0, 24);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const candidateLimit = Math.min(2_000, Math.max(100, safeLimit * 20));
  const termRows =
    terms.length === 0
      ? []
      : yield* sql.unsafe<SymbolRow & {readonly score: number}>(
          `${effectiveSymbolsCte()},
           effective_terms AS (
             SELECT current_terms.*
             FROM symbol_terms AS current_terms
             WHERE current_terms.snapshot_id = ?
             UNION ALL
             SELECT base_terms.*
             FROM symbol_terms AS base_terms
             WHERE base_terms.snapshot_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM symbols AS overrides
                 WHERE overrides.snapshot_id = ? AND overrides.id = base_terms.symbol_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM snapshot_symbol_deletions AS deletions
                 WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_terms.symbol_id
               )
           ),
           candidates AS (
             SELECT symbol_id, SUM(weight) AS score
             FROM effective_terms
             WHERE term IN (${terms.map(() => '?').join(', ')})
             GROUP BY symbol_id
             ORDER BY score DESC, symbol_id
             LIMIT ?
           )
           SELECT symbols.*, candidates.score
           FROM candidates
           JOIN effective_symbols AS symbols
             ON symbols.id = candidates.symbol_id`,
          [...effectiveParameters, ...effectiveParameters, ...terms, candidateLimit],
        );
  const exactRows = yield* sql.unsafe<SymbolRow & {readonly score: number}>(
    `${effectiveSymbolsCte()}
     SELECT symbols.*,
       CASE
         WHEN name = ? COLLATE NOCASE THEN 100
         WHEN qualified_name = ? COLLATE NOCASE THEN 90
         ELSE 80
       END AS score
     FROM effective_symbols AS symbols
     WHERE (
         name = ? COLLATE NOCASE OR
         qualified_name = ? COLLATE NOCASE OR
         path = ? COLLATE NOCASE
       )
     LIMIT ?`,
    [...effectiveParameters, query, query, query, query, query, safeLimit],
  );
  const byId = new Map<string, SymbolRow & {readonly score: number}>();
  for (const row of [...termRows, ...exactRows]) {
    const current = byId.get(row.id);
    if (!current || row.score > current.score) byId.set(row.id, row);
  }
  return [...byId.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.exported - left.exported ||
        left.name.localeCompare(right.name) ||
        left.path.localeCompare(right.path) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, safeLimit)
    .map(row => ({...symbolFromRow(row), score: Math.max(0, Math.min(1, row.score / 100))}));
});

const selectSearchSymbolsMany = Effect.fn('codeGraph.selectSearchSymbolsMany')(function* (
  snapshotId: string,
  queries: readonly string[],
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return yield* Effect.forEach(
    queries,
    query => selectSearchSymbolsWithSql(sql, snapshotId, baseSnapshotId, query, limit),
    {concurrency: 1},
  );
});

const selectSymbolsByPaths = Effect.fn('codeGraph.selectSymbolsByPaths')(function* (
  snapshotId: string,
  paths: readonly string[],
  limitPerPath: number,
) {
  if (paths.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const normalizedPaths = [...new Set(paths)];
  const grouped = new Map<string, CodeGraphQueryNode[]>();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limitPerPath)));
  for (const pathBatch of chunk(normalizedPaths, 300)) {
    const rows = yield* sql.unsafe<SymbolRow & {readonly path_rank: number}>(
      `${effectiveSymbolsCte()},
       ranked_symbols AS (
         SELECT effective_symbols.*,
           ROW_NUMBER() OVER (
             PARTITION BY path
             ORDER BY exported DESC, qualified_name, id
           ) AS path_rank
         FROM effective_symbols
         WHERE path IN (${pathBatch.map(() => '?').join(', ')})
       )
       SELECT * FROM ranked_symbols
       WHERE path_rank <= ?
       ORDER BY path, path_rank`,
      [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), ...pathBatch, safeLimit],
    );
    for (const row of rows) {
      const values = grouped.get(row.path) ?? [];
      values.push({...symbolFromRow(row), score: 1});
      grouped.set(row.path, values);
    }
  }
  return paths.map(sourcePath => grouped.get(sourcePath) ?? []);
});

const selectSymbolsByPathAndName = Effect.fn('codeGraph.selectSymbolsByPathAndName')(function* (
  snapshotId: string,
  sourcePath: string,
  name: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = yield* sql.unsafe<SymbolRow>(
    `${effectiveSymbolsCte()}
     SELECT *
     FROM effective_symbols
     WHERE path = ? COLLATE NOCASE
       AND (name = ? COLLATE NOCASE OR qualified_name = ? COLLATE NOCASE)
     ORDER BY exported DESC, qualified_name, id
     LIMIT 20`,
    [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), sourcePath, name, name],
  );
  return rows.map(row => ({...symbolFromRow(row), score: 1}));
});

const selectSymbolsByIds = Effect.fn('codeGraph.selectSymbolsByIds')(function* (
  snapshotId: string,
  ids: readonly string[],
) {
  if (ids.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const output: CodeGraphSymbol[] = [];
  for (const values of chunk([...new Set(ids)], 400)) {
    const rows = yield* sql.unsafe<SymbolRow>(
      `${effectiveSymbolsCte()}
       SELECT * FROM effective_symbols
       WHERE id IN (${values.map(() => '?').join(', ')})
       ORDER BY path, qualified_name, id`,
      [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), ...values],
    );
    output.push(...rows.map(symbolFromRow));
  }
  return output;
});

const selectEdgesForNodes = Effect.fn('codeGraph.selectEdgesForNodes')(function* (
  snapshotId: string,
  nodeIds: readonly string[],
  direction: 'both' | 'incoming' | 'outgoing',
  limit: number,
  allowedProvenances: readonly CodeGraphProvenance[],
) {
  if (nodeIds.length === 0 || limit <= 0 || allowedProvenances.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const ids = [...new Set(nodeIds)].slice(0, 500);
  const sourceClause = `source_id IN (${ids.map(() => '?').join(', ')})`;
  const targetClause = `target_id IN (${ids.map(() => '?').join(', ')})`;
  const adjacency =
    direction === 'incoming'
      ? {parameters: ids, where: targetClause}
      : direction === 'outgoing'
        ? {parameters: ids, where: sourceClause}
        : {parameters: [...ids, ...ids], where: `(${sourceClause} OR ${targetClause})`};
  const authority = `AND provenance IN (${allowedProvenances.map(() => '?').join(', ')})`;
  const rows = yield* sql.unsafe<EdgeRow>(
    `${effectiveEdgesCte()}
     SELECT * FROM effective_edges
     WHERE ${adjacency.where}
       ${authority}
     ORDER BY
       CASE provenance WHEN 'declared' THEN 0 WHEN 'resolved' THEN 1 WHEN 'syntactic' THEN 2 ELSE 3 END,
       confidence DESC, source_name, relation, target_name, id
     LIMIT ?`,
    [
      ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
      ...adjacency.parameters,
      ...allowedProvenances,
      Math.min(5_000, Math.floor(limit)),
    ],
  );
  return rows.map(edgeFromRow);
});

const upsertRepository = Effect.fn('codeGraph.upsertRepository')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
) {
  const now = new Date().toISOString();
  yield* sql`
    INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
    VALUES (${identity.repositoryId}, ${identity.displayName}, ${identity.objectFormat}, ${now}, ${now})
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      object_format = excluded.object_format,
      last_used_at = excluded.last_used_at
  `;
});

function symbolTerms(symbol: CodeGraphSymbol): readonly (readonly [string, number])[] {
  const weighted = new Map<string, number>();
  addTerms(weighted, symbol.name, 5);
  addTerms(weighted, symbol.qualifiedName, 4);
  addTerms(weighted, symbol.path, 3);
  addTerms(weighted, symbol.packageName ?? '', 3);
  addTerms(weighted, symbol.signature ?? '', 2);
  addTerms(weighted, symbol.documentation ?? '', 1);
  return [...weighted].sort(([left], [right]) => left.localeCompare(right));
}

function addTerms(target: Map<string, number>, value: string, weight: number): void {
  for (const term of normalizedTerms(value)) {
    target.set(term, Math.max(target.get(term) ?? 0, weight));
  }
}

export function normalizedTerms(value: string): readonly string[] {
  const expanded = value
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  return [...new Set(expanded.match(/[\p{L}\p{N}_$.-]{2,}/gu) ?? [])].slice(0, 32);
}

function snapshotFromRow(row: SnapshotRow): CodeGraphSnapshot {
  return {
    baseSnapshotId: Option.getOrUndefined(sqlTextOption(row.base_snapshot_id)),
    commit: row.commit_id,
    completedAt: Option.getOrUndefined(sqlTextOption(row.completed_at)),
    dirty: row.dirty === 1,
    edgeCount: row.edge_count,
    extractorSet: row.extractor_set,
    fileCount: row.file_count,
    id: row.id,
    overlayFingerprint: Option.getOrUndefined(sqlTextOption(row.overlay_fingerprint)),
    repositoryId: row.repository_id,
    state: row.state,
    symbolCount: row.symbol_count,
    worktreeId: row.worktree_id,
  };
}

function symbolFromRow(row: SymbolRow): CodeGraphSymbol {
  return {
    contentHash: row.content_hash,
    documentation: Option.getOrUndefined(sqlTextOption(row.documentation)),
    exported: row.exported === 1,
    id: row.id,
    kind: row.kind,
    language: row.language,
    name: row.name,
    packageName: Option.getOrUndefined(sqlTextOption(row.package_name)),
    path: row.path,
    qualifiedName: row.qualified_name,
    signature: Option.getOrUndefined(sqlTextOption(row.signature)),
    span: JSON.parse(row.span_json) as CodeGraphSymbol['span'],
  };
}

function edgeFromRow(row: EdgeRow): CodeGraphEdge {
  return {
    confidence: row.confidence,
    evidencePath: row.evidence_path,
    evidenceSpan: JSON.parse(row.evidence_span_json) as CodeGraphEdge['evidenceSpan'],
    id: row.id,
    provenance: row.provenance,
    relation: row.relation,
    sourceId: Option.getOrUndefined(sqlTextOption(row.source_id)),
    sourceName: row.source_name,
    targetId: Option.getOrUndefined(sqlTextOption(row.target_id)),
    targetName: row.target_name,
  };
}

function sqlTextOption(value: unknown): Option.Option<string> {
  return typeof value === 'string' ? Option.some(value) : Option.none();
}

function boundedPageLimit(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(2_000, value)) : 500;
}

function* chunk<const Value>(values: readonly Value[], size: number): Generator<readonly Value[]> {
  for (let index = 0; index < values.length; index += size) yield values.slice(index, index + size);
}

function storeError(operation: string, cause: unknown): CodeGraphStoreError {
  if (cause instanceof CodeGraphStoreError) return cause;
  return new CodeGraphStoreError(`${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
}
