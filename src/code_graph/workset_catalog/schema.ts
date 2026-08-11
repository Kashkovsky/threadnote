import {Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION} from './layout.js';
import {CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION, CodeGraphWorksetCatalogError} from './types.js';

export const configureCodeGraphWorksetCatalogReadConnection = Effect.fn(
  'codeGraphWorksetCatalog.configureReadConnection',
)(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  yield* sql.unsafe('PRAGMA query_only = ON');
});

export const configureCodeGraphWorksetCatalogWriteConnection = Effect.fn(
  'codeGraphWorksetCatalog.configureWriteConnection',
)(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  yield* sql.unsafe('PRAGMA journal_mode = WAL');
  yield* sql.unsafe('PRAGMA synchronous = FULL');
  yield* sql.unsafe('PRAGMA wal_autocheckpoint = 1000');
});

export const initializeCodeGraphWorksetCatalogSchema = Effect.fn('codeGraphWorksetCatalog.initializeSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* configureCodeGraphWorksetCatalogWriteConnection(sql);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS catalog_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql`
    INSERT INTO catalog_metadata (key, value)
    VALUES ('schema_version', ${String(CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION)})
    ON CONFLICT(key) DO NOTHING
  `;
  yield* sql`
    INSERT INTO catalog_metadata (key, value)
    VALUES ('projector_version', ${String(CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION)})
    ON CONFLICT(key) DO NOTHING
  `;
  const schemaVersion = yield* readCodeGraphWorksetCatalogMetadataInteger(sql, 'schema_version');
  if (schemaVersion !== CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION) {
    return yield* Effect.fail(
      new CodeGraphWorksetCatalogError(
        'incompatible',
        `Workset catalog schema ${String(schemaVersion ?? 'unknown')} is incompatible with ${CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION}.`,
      ),
    );
  }
  const projectorVersion = yield* readCodeGraphWorksetCatalogMetadataInteger(sql, 'projector_version');
  if (projectorVersion !== CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION) {
    return yield* Effect.fail(
      new CodeGraphWorksetCatalogError(
        'incompatible',
        `Workset catalog projector ${String(projectorVersion ?? 'unknown')} is incompatible with ${CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION}.`,
      ),
    );
  }
  yield* createCodeGraphWorksetCatalogTables(sql);
  yield* sql.unsafe(`PRAGMA user_version = ${CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION}`);
});

export const inspectCodeGraphWorksetCatalogSchemaVersion = Effect.fn('codeGraphWorksetCatalog.inspectSchemaVersion')(
  function* (sql: SqlClient.SqlClient) {
    return yield* readCodeGraphWorksetCatalogMetadataInteger(sql, 'schema_version');
  },
);

function createCodeGraphWorksetCatalogTables(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS repository_snapshots (
        projection_digest TEXT PRIMARY KEY NOT NULL CHECK(length(projection_digest) = 64),
        repository_id TEXT NOT NULL CHECK(length(repository_id) = 64),
        checkout_id TEXT NOT NULL CHECK(length(checkout_id) = 64),
        worktree_id TEXT NOT NULL CHECK(length(worktree_id) = 64),
        snapshot_id TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64),
        commit_id TEXT NOT NULL CHECK(length(commit_id) IN (40, 64)),
        extractor_generation INTEGER NOT NULL CHECK(extractor_generation > 0),
        projector_version INTEGER NOT NULL CHECK(projector_version > 0),
        component_count INTEGER NOT NULL CHECK(component_count >= 0),
        symbol_count INTEGER NOT NULL CHECK(symbol_count >= 0),
        state TEXT NOT NULL CHECK(state IN ('staging', 'ready')),
        created_at TEXT NOT NULL,
        UNIQUE(checkout_id, worktree_id, snapshot_id, projector_version)
      )
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS routing_symbols (
        projection_digest TEXT NOT NULL REFERENCES repository_snapshots(projection_digest) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        language TEXT NOT NULL,
        exported INTEGER NOT NULL CHECK(exported IN (0, 1)),
        package_name TEXT,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        span_line INTEGER NOT NULL CHECK(span_line >= 0),
        span_column INTEGER NOT NULL CHECK(span_column >= 0),
        span_end_line INTEGER NOT NULL CHECK(span_end_line >= span_line),
        span_end_column INTEGER NOT NULL CHECK(span_end_column >= 0),
        PRIMARY KEY (projection_digest, node_id)
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS routing_lookup_keys (
        projection_digest TEXT NOT NULL,
        node_id TEXT NOT NULL,
        lookup_key TEXT NOT NULL,
        PRIMARY KEY (projection_digest, node_id, lookup_key),
        FOREIGN KEY (projection_digest, node_id)
          REFERENCES routing_symbols(projection_digest, node_id) ON DELETE CASCADE
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS routing_terms (
        projection_digest TEXT NOT NULL,
        node_id TEXT NOT NULL,
        term TEXT NOT NULL,
        weight REAL NOT NULL CHECK(weight > 0 AND weight <= 1000),
        PRIMARY KEY (projection_digest, node_id, term),
        FOREIGN KEY (projection_digest, node_id)
          REFERENCES routing_symbols(projection_digest, node_id) ON DELETE CASCADE
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS workset_generations (
        id TEXT PRIMARY KEY NOT NULL,
        workset_name TEXT NOT NULL,
        manifest_digest TEXT NOT NULL CHECK(length(manifest_digest) = 64),
        generation_digest TEXT NOT NULL UNIQUE CHECK(length(generation_digest) = 64),
        state TEXT NOT NULL CHECK(state IN ('staging', 'ready', 'retired')),
        member_count INTEGER NOT NULL CHECK(member_count >= 0),
        created_at TEXT NOT NULL,
        published_at TEXT
      )
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS workset_generation_members (
        generation_id TEXT NOT NULL REFERENCES workset_generations(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        repository_key TEXT NOT NULL,
        repository_id TEXT NOT NULL CHECK(length(repository_id) = 64),
        snapshot_id TEXT NOT NULL,
        projection_digest TEXT NOT NULL REFERENCES repository_snapshots(projection_digest),
        PRIMARY KEY (generation_id, ordinal),
        UNIQUE (generation_id, repository_key)
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS published_worksets (
        workset_name TEXT PRIMARY KEY NOT NULL,
        generation_id TEXT NOT NULL UNIQUE REFERENCES workset_generations(id),
        published_at TEXT NOT NULL
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS routing_symbols_qualified_name
      ON routing_symbols(qualified_name, projection_digest, node_id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS routing_symbols_name
      ON routing_symbols(name, projection_digest, node_id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS routing_symbols_package_path
      ON routing_symbols(package_name, path, projection_digest, node_id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS routing_lookup_keys_exact
      ON routing_lookup_keys(lookup_key, projection_digest, node_id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS routing_terms_term
      ON routing_terms(term, weight DESC, projection_digest, node_id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS workset_generations_retirement
      ON workset_generations(state, created_at, id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS workset_generation_members_projection
      ON workset_generation_members(projection_digest, generation_id)
    `);
  });
}

function readCodeGraphWorksetCatalogMetadataInteger(sql: SqlClient.SqlClient, key: string) {
  return sql.unsafe<{readonly value: unknown}>('SELECT value FROM catalog_metadata WHERE key = ? LIMIT 1', [key]).pipe(
    Effect.map(rows => {
      const value = rows[0]?.value;
      if (typeof value !== 'string' || !/^\d{1,9}$/u.test(value)) return undefined;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    }),
  );
}
