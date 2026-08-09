import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Crypto, Effect, FileSystem, Option, Path} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {sha256HexSync} from '../crypto/sha256.js';
import {SystemInfo, type SystemInfoShape} from '../effect/system.js';
import {
  codeGraphVectorRetirementCapacityDemand,
  type CodeGraphDirectPersistentCapacityBoundary,
} from './disk_capacity.js';
import {codeGraphDiskReservationFilesystemKey, withCodeGraphDiskReservation} from './disk_reservation.js';
import {codeGraphDiskReservationLockPath, codeGraphDiskReservationRoot} from './layout.js';

export const CODE_GRAPH_VECTOR_RETIREMENT_PAGE_ROWS = 1_000;
export const CODE_GRAPH_VECTOR_RETIREMENT_PAGE_BYTES = 32 * 1_024 * 1_024;
export const CODE_GRAPH_VECTOR_RETIREMENT_PAGE_FIXED_ROWS = 5;
export const CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_ROWS = 8_192;
export const CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_BYTES = 4 * 1_024 * 1_024;

const MAXIMUM_SAFE_INTEGER_SQL = '9007199254740991';
const VECTOR_GENERATION_BYTES = 256;
const VECTOR_SNAPSHOT_BYTES = 1_024;
const VECTOR_MODEL_ID_BYTES = 256;
const VECTOR_MODEL_SHA256_BYTES = 64;
const VECTOR_CREATED_AT_BYTES = 64;
const VECTOR_SYMBOL_BYTES = 1_024;
const VECTOR_FINGERPRINT_BYTES = 1_024;
const VECTOR_RETIREMENT_TRIGGER_SQL_BYTES = 65_536;
const VECTOR_CORE_TABLE_NAMES = ['vector_generations', 'vector_pointers', 'vectors'] as const;
const VECTOR_RETIREMENT_TABLE_NAMES = ['vector_retirement_state', 'vector_generation_retirements'] as const;

function vectorGenerationManifestPredicate(alias: string): string {
  return `typeof(${alias}.generation) = 'text'
    AND length(CAST(${alias}.generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
    AND instr(${alias}.generation, char(0)) = 0
    AND typeof(${alias}.snapshot_id) = 'text'
    AND length(CAST(${alias}.snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
    AND instr(${alias}.snapshot_id, char(0)) = 0
    AND typeof(${alias}.model_id) = 'text'
    AND length(CAST(${alias}.model_id AS BLOB)) BETWEEN 1 AND ${VECTOR_MODEL_ID_BYTES}
    AND instr(${alias}.model_id, char(0)) = 0
    AND typeof(${alias}.model_sha256) = 'text'
    AND length(CAST(${alias}.model_sha256 AS BLOB)) = ${VECTOR_MODEL_SHA256_BYTES}
    AND ${alias}.model_sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(${alias}.dimensions) = 'integer'
    AND ${alias}.dimensions BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
    AND typeof(${alias}.template_version) = 'integer'
    AND ${alias}.template_version BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
    AND typeof(${alias}.count) = 'integer'
    AND ${alias}.count BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
    AND typeof(${alias}.state) = 'text'
    AND ${alias}.state IN ('building', 'ready')
    AND typeof(${alias}.created_at) = 'text'
    AND length(CAST(${alias}.created_at AS BLOB)) BETWEEN 1 AND ${VECTOR_CREATED_AT_BYTES}
    AND instr(${alias}.created_at, char(0)) = 0`;
}

export const CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vector_generations (
  generation TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_sha256 TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK(dimensions > 0),
  template_version INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK(count >= 0),
  state TEXT NOT NULL CHECK(state IN ('building', 'ready')),
  created_at TEXT NOT NULL
)`;

export const CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vector_pointers (
  worktree_id TEXT PRIMARY KEY,
  generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE
)`;

export const CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS vector_pointer_generation_lookup ON vector_pointers (generation)';

export const CODE_GRAPH_VECTORS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vectors (
  generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE,
  symbol_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (generation, symbol_id)
) WITHOUT ROWID`;

export const CODE_GRAPH_VECTOR_REUSE_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS vector_reuse_lookup ON vectors (generation, symbol_id, fingerprint)';

export const CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vector_retirement_state (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (
    typeof(singleton) = 'integer' AND singleton = 1
  ),
  admission_cursor TEXT CHECK (
    admission_cursor IS NULL OR (
      typeof(admission_cursor) = 'text'
      AND length(CAST(admission_cursor AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
      AND instr(admission_cursor, char(0)) = 0
    )
  ),
  generation_revision INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(generation_revision) = 'integer'
    AND generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
  ),
  admission_scan_revision INTEGER CHECK (
    admission_scan_revision IS NULL OR (
      typeof(admission_scan_revision) = 'integer'
      AND admission_scan_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
    )
  ),
  clean_generation_revision INTEGER CHECK (
    clean_generation_revision IS NULL OR (
      typeof(clean_generation_revision) = 'integer'
      AND clean_generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
    )
  ),
  pointer_delete_worktree_id TEXT,
  pointer_delete_generation TEXT,
  pointer_delete_snapshot_id TEXT,
  CHECK ((admission_cursor IS NULL) = (admission_scan_revision IS NULL)),
  CHECK (admission_scan_revision IS NULL OR admission_scan_revision <= generation_revision),
  CHECK (clean_generation_revision IS NULL OR clean_generation_revision <= generation_revision),
  CHECK (
    admission_scan_revision IS NULL
    OR clean_generation_revision IS NULL
    OR clean_generation_revision <= admission_scan_revision
  ),
  CHECK (
    clean_generation_revision IS NULL
    OR clean_generation_revision < generation_revision
    OR (admission_cursor IS NULL AND admission_scan_revision IS NULL)
  ),
  CHECK (
    (
      pointer_delete_worktree_id IS NULL
      AND pointer_delete_generation IS NULL
      AND pointer_delete_snapshot_id IS NULL
    ) OR (
      typeof(pointer_delete_worktree_id) = 'text'
      AND length(CAST(pointer_delete_worktree_id AS BLOB)) = 64
      AND pointer_delete_worktree_id NOT GLOB '*[^0-9a-f]*'
      AND typeof(pointer_delete_generation) = 'text'
      AND length(CAST(pointer_delete_generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
      AND instr(pointer_delete_generation, char(0)) = 0
      AND typeof(pointer_delete_snapshot_id) = 'text'
      AND length(CAST(pointer_delete_snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
      AND instr(pointer_delete_snapshot_id, char(0)) = 0
    )
  )
) WITHOUT ROWID`;

export const CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vector_generation_retirements (
  retirement_id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (
    typeof(retirement_id) = 'integer'
    AND retirement_id BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
  ),
  generation TEXT NOT NULL UNIQUE CHECK (
    typeof(generation) = 'text'
    AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
    AND instr(generation, char(0)) = 0
  ),
  snapshot_id TEXT NOT NULL CHECK (
    typeof(snapshot_id) = 'text'
    AND length(CAST(snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
    AND instr(snapshot_id, char(0)) = 0
  ),
  retired_by_worktree_id TEXT CHECK (
    retired_by_worktree_id IS NULL OR (
      typeof(retired_by_worktree_id) = 'text'
      AND length(CAST(retired_by_worktree_id AS BLOB)) = 64
      AND retired_by_worktree_id NOT GLOB '*[^0-9a-f]*'
    )
  ),
  page_revision INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(page_revision) = 'integer'
    AND page_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
  ),
  delete_authorized INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(delete_authorized) = 'integer' AND delete_authorized IN (0, 1)
  )
)`;

export const CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL = `CREATE INDEX IF NOT EXISTS vector_generation_retirement_association
   ON vector_generation_retirements (
     retired_by_worktree_id, snapshot_id, generation, retirement_id
   ) WHERE retired_by_worktree_id IS NOT NULL`;

const CORE_SCHEMA_TRIGGER_GUARD_SQL = `SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'index'
      AND name = 'vector_pointer_generation_lookup'
      AND tbl_name = 'vector_pointers'
    LIMIT 1
  ) OR (
    SELECT COUNT(*) FROM (
      SELECT seqno, cid, name, "desc", coll, "key"
      FROM pragma_index_xinfo('vector_pointer_generation_lookup')
      LIMIT 3
    )
  ) <> 2 OR (
    SELECT COUNT(*) FROM (
      SELECT seqno, cid, name, "desc", coll, "key"
      FROM pragma_index_xinfo('vector_pointer_generation_lookup')
      LIMIT 3
    ) WHERE (
      seqno = 0 AND name = 'generation' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
    ) OR (
      seqno = 1 AND cid = -1 AND name IS NULL AND "desc" = 0 AND coll = 'BINARY' AND "key" = 0
    )
  ) <> 2 OR NOT EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table'
      AND name = 'vectors'
      AND tbl_name = 'vectors'
    LIMIT 1
  ) OR (
    SELECT COUNT(*) FROM (
      SELECT seqno, cid, name, "desc", coll, "key"
      FROM pragma_index_xinfo('sqlite_autoindex_vectors_1')
      LIMIT 5
    )
  ) <> 4 OR (
    SELECT COUNT(*) FROM (
      SELECT seqno, cid, name, "desc", coll, "key"
      FROM pragma_index_xinfo('sqlite_autoindex_vectors_1')
      LIMIT 5
    ) WHERE (
      seqno = 0 AND name = 'generation' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
    ) OR (
      seqno = 1 AND name = 'symbol_id' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
    ) OR (
      seqno = 2 AND name = 'fingerprint' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 0
    ) OR (
      seqno = 3 AND name = 'vector' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 0
    )
  ) <> 4
  THEN RAISE(ABORT, 'code graph vector retirement authority is incompatible')
END;`;

const RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL = `${CORE_SCHEMA_TRIGGER_GUARD_SQL}
SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table'
      AND name = 'vector_retirement_state'
      AND tbl_name = 'vector_retirement_state'
      AND sql = ${sqliteStringLiteral(storedSchemaSql(CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL))}
    LIMIT 1
  ) OR NOT EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table'
      AND name = 'vector_generation_retirements'
      AND tbl_name = 'vector_generation_retirements'
      AND sql = ${sqliteStringLiteral(storedSchemaSql(CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL))}
    LIMIT 1
  ) OR NOT EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'index'
      AND name = 'vector_generation_retirement_association'
      AND tbl_name = 'vector_generation_retirements'
      AND sql = ${sqliteStringLiteral(storedSchemaSql(CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL))}
    LIMIT 1
  ) OR (
    SELECT COUNT(*) FROM (
      SELECT name, typeof(seq) AS seq_type, seq
      FROM sqlite_sequence
      WHERE name = 'vector_generation_retirements' COLLATE NOCASE
      LIMIT 2
    )
  ) <> 1 OR NOT EXISTS (
    SELECT 1 FROM sqlite_sequence
    WHERE name = 'vector_generation_retirements'
      AND typeof(seq) = 'integer'
      AND seq BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
      AND seq >= COALESCE((
        SELECT retirement_id
        FROM vector_generation_retirements
        ORDER BY retirement_id DESC
        LIMIT 1
      ), 0)
    LIMIT 1
  ) OR (
    SELECT COUNT(*) FROM (SELECT singleton FROM vector_retirement_state LIMIT 2)
  ) <> 1 OR NOT EXISTS (
    SELECT 1 FROM vector_retirement_state
    WHERE singleton = 1
      AND typeof(generation_revision) = 'integer'
      AND generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
      AND (
        (
          admission_cursor IS NULL
          AND admission_scan_revision IS NULL
        ) OR (
          typeof(admission_cursor) = 'text'
          AND length(CAST(admission_cursor AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
          AND instr(admission_cursor, char(0)) = 0
          AND typeof(admission_scan_revision) = 'integer'
          AND admission_scan_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
          AND admission_scan_revision <= generation_revision
        )
      )
      AND (
        clean_generation_revision IS NULL OR (
          typeof(clean_generation_revision) = 'integer'
          AND clean_generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
          AND clean_generation_revision <= generation_revision
        )
      )
      AND (
        admission_scan_revision IS NULL
        OR clean_generation_revision IS NULL
        OR clean_generation_revision <= admission_scan_revision
      )
      AND (
        clean_generation_revision IS NULL
        OR clean_generation_revision < generation_revision
        OR (admission_cursor IS NULL AND admission_scan_revision IS NULL)
      )
      AND (
        (
          pointer_delete_worktree_id IS NULL
          AND pointer_delete_generation IS NULL
          AND pointer_delete_snapshot_id IS NULL
        ) OR (
          typeof(pointer_delete_worktree_id) = 'text'
          AND length(CAST(pointer_delete_worktree_id AS BLOB)) = 64
          AND pointer_delete_worktree_id NOT GLOB '*[^0-9a-f]*'
          AND typeof(pointer_delete_generation) = 'text'
          AND length(CAST(pointer_delete_generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
          AND instr(pointer_delete_generation, char(0)) = 0
          AND typeof(pointer_delete_snapshot_id) = 'text'
          AND length(CAST(pointer_delete_snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
          AND instr(pointer_delete_snapshot_id, char(0)) = 0
        )
      )
    LIMIT 1
  )
  THEN RAISE(ABORT, 'code graph vector retirement marker authority is incompatible')
END;`;

const VECTOR_RETIREMENT_MARKER_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_marker_insert_guard
  BEFORE INSERT ON vector_generation_retirements
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    SELECT CASE
      WHEN NEW.retirement_id <> -1
        OR NEW.page_revision <> 0
        OR NEW.delete_authorized <> 0
        OR NOT EXISTS (
          SELECT 1 FROM vector_generations AS generation
          WHERE generation.generation = NEW.generation
            AND generation.snapshot_id = NEW.snapshot_id
            AND ${vectorGenerationManifestPredicate('generation')}
          LIMIT 1
        )
        OR EXISTS (
          SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
          WHERE generation = NEW.generation LIMIT 1
        )
      THEN RAISE(ABORT, 'code graph vector retirement marker is invalid')
    END;
  END`;

const VECTOR_RETIREMENT_MARKER_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_marker_update_guard
  BEFORE UPDATE ON vector_generation_retirements
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    SELECT CASE
      WHEN NEW.retirement_id <> OLD.retirement_id
        OR NEW.generation <> OLD.generation
        OR NEW.snapshot_id <> OLD.snapshot_id
        OR NEW.retired_by_worktree_id IS NOT OLD.retired_by_worktree_id
        OR NOT EXISTS (
          SELECT 1 FROM vector_generations AS generation
          WHERE generation.generation = OLD.generation
            AND generation.snapshot_id = OLD.snapshot_id
            AND ${vectorGenerationManifestPredicate('generation')}
          LIMIT 1
        )
        OR EXISTS (
          SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
          WHERE generation = OLD.generation LIMIT 1
        )
        OR NOT (
          (
            OLD.delete_authorized = 0
            AND NEW.delete_authorized = 0
            AND OLD.page_revision < ${MAXIMUM_SAFE_INTEGER_SQL}
            AND NEW.page_revision = OLD.page_revision + 1
          ) OR (
            OLD.delete_authorized = 0
            AND NEW.delete_authorized = 1
            AND NEW.page_revision = OLD.page_revision
            AND NOT EXISTS (
              SELECT 1 FROM vectors INDEXED BY sqlite_autoindex_vectors_1
              WHERE generation = OLD.generation LIMIT 1
            )
          )
        )
      THEN RAISE(ABORT, 'code graph vector retirement marker update is invalid')
    END;
  END`;

const VECTOR_RETIREMENT_MARKER_DELETE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_marker_delete_guard
  BEFORE DELETE ON vector_generation_retirements
  WHEN EXISTS (
    SELECT 1 FROM vector_generations WHERE generation = OLD.generation LIMIT 1
  )
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    SELECT RAISE(ABORT, 'code graph vector retirement marker is still authoritative');
  END`;

const POINTER_MANIFEST_TRIGGER_GUARD_SQL = `SELECT CASE
  WHEN typeof(NEW.worktree_id) <> 'text'
    OR length(CAST(NEW.worktree_id AS BLOB)) <> 64
    OR NEW.worktree_id GLOB '*[^0-9a-f]*'
    OR typeof(NEW.generation) <> 'text'
    OR length(CAST(NEW.generation AS BLOB)) NOT BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
    OR instr(NEW.generation, char(0)) <> 0
    OR NOT EXISTS (
      SELECT 1 FROM vector_generations AS generation
      WHERE generation.generation = NEW.generation
        AND ${vectorGenerationManifestPredicate('generation')}
      LIMIT 1
    )
  THEN RAISE(ABORT, 'code graph vector pointer manifest is invalid')
END;`;

const OLD_POINTER_MANIFEST_TRIGGER_GUARD_SQL = POINTER_MANIFEST_TRIGGER_GUARD_SQL.replaceAll('NEW.', 'OLD.');

const VECTOR_RETIREMENT_POINTER_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_pointer_insert_guard
  BEFORE INSERT ON vector_pointers
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    ${POINTER_MANIFEST_TRIGGER_GUARD_SQL}
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM vector_generation_retirements
        INDEXED BY sqlite_autoindex_vector_generation_retirements_1
      WHERE generation = NEW.generation LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation is retiring') END;
  END`;

const VECTOR_RETIREMENT_POINTER_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_pointer_update_guard
  BEFORE UPDATE ON vector_pointers
  WHEN NEW.worktree_id <> OLD.worktree_id OR NEW.generation <> OLD.generation
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    ${OLD_POINTER_MANIFEST_TRIGGER_GUARD_SQL}
    ${POINTER_MANIFEST_TRIGGER_GUARD_SQL}
    SELECT CASE WHEN NEW.worktree_id <> OLD.worktree_id
      THEN RAISE(ABORT, 'code graph vector pointer identity is immutable') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM vector_generation_retirements
        INDEXED BY sqlite_autoindex_vector_generation_retirements_1
      WHERE generation = NEW.generation LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation is retiring') END;
  END`;

const VECTOR_RETIREMENT_POINTER_DELETE_GUARD_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_pointer_delete_guard
  BEFORE DELETE ON vector_pointers
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    ${OLD_POINTER_MANIFEST_TRIGGER_GUARD_SQL}
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1
      FROM vector_retirement_state AS authority
      JOIN vector_generations AS generation
        ON generation.generation = OLD.generation
       AND generation.snapshot_id = authority.pointer_delete_snapshot_id
      WHERE authority.singleton = 1
        AND authority.pointer_delete_worktree_id = OLD.worktree_id
        AND authority.pointer_delete_generation = OLD.generation
      LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector pointer deletion is unauthorized') END;
  END`;

const VECTOR_RETIREMENT_POINTER_DELETE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_pointer_delete_mark
  AFTER DELETE ON vector_pointers
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    INSERT INTO vector_generation_retirements (
      generation, snapshot_id, retired_by_worktree_id
    )
    SELECT generation, snapshot_id, OLD.worktree_id
    FROM vector_generations
    WHERE generation = OLD.generation
      AND NOT EXISTS (
        SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
        WHERE generation = OLD.generation LIMIT 1
      );
    UPDATE vector_retirement_state
    SET pointer_delete_worktree_id = NULL,
        pointer_delete_generation = NULL,
        pointer_delete_snapshot_id = NULL
    WHERE singleton = 1
      AND pointer_delete_worktree_id = OLD.worktree_id
      AND pointer_delete_generation = OLD.generation;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM vector_retirement_state
      WHERE singleton = 1 AND pointer_delete_worktree_id IS NOT NULL
      LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector pointer deletion authority was not consumed') END;
  END`;

const VECTOR_RETIREMENT_POINTER_CHANGED_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_pointer_update_mark
  AFTER UPDATE OF generation ON vector_pointers
  WHEN NEW.generation <> OLD.generation AND NOT EXISTS (
    SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
    WHERE generation = OLD.generation LIMIT 1
  )
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    INSERT INTO vector_generation_retirements (
      generation, snapshot_id, retired_by_worktree_id
    )
    SELECT generation, snapshot_id, OLD.worktree_id
    FROM vector_generations
    WHERE generation = OLD.generation;
  END`;

const VECTOR_RETIREMENT_VECTOR_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_vector_insert_guard
  BEFORE INSERT ON vectors
  WHEN EXISTS (
    SELECT 1 FROM vector_generation_retirements
      INDEXED BY sqlite_autoindex_vector_generation_retirements_1
    WHERE generation = NEW.generation LIMIT 1
  )
  BEGIN
    SELECT RAISE(ABORT, 'code graph vector generation is retiring');
  END`;

const VECTOR_RETIREMENT_VECTOR_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_vector_update_guard
  BEFORE UPDATE ON vectors
  WHEN EXISTS (
    SELECT 1 FROM vector_generation_retirements
      INDEXED BY sqlite_autoindex_vector_generation_retirements_1
    WHERE generation = OLD.generation OR generation = NEW.generation
    LIMIT 1
  )
  BEGIN
    SELECT RAISE(ABORT, 'code graph vector generation is retiring');
  END`;

const VECTOR_RETIREMENT_GENERATION_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_generation_insert_guard
  BEFORE INSERT ON vector_generations
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM vector_generation_retirements WHERE generation = NEW.generation LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation is retiring') END;
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM vector_retirement_state
      WHERE singleton = 1 AND generation_revision < ${MAXIMUM_SAFE_INTEGER_SQL}
      LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation revision is exhausted') END;
    UPDATE vector_retirement_state
    SET generation_revision = generation_revision + 1
    WHERE singleton = 1;
  END`;

const VECTOR_RETIREMENT_GENERATION_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_generation_update_guard
  BEFORE UPDATE ON vector_generations
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM vector_generation_retirements
      WHERE generation = OLD.generation OR generation = NEW.generation
      LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation is retiring') END;
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM vector_retirement_state
      WHERE singleton = 1 AND generation_revision < ${MAXIMUM_SAFE_INTEGER_SQL}
      LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation revision is exhausted') END;
    UPDATE vector_retirement_state
    SET generation_revision = generation_revision + 1
    WHERE singleton = 1;
  END`;

const VECTOR_RETIREMENT_GENERATION_DELETE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_generation_delete_guard
  BEFORE DELETE ON vector_generations
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    SELECT CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM vector_generation_retirements
        WHERE generation = OLD.generation AND delete_authorized = 1
        LIMIT 1
      ) OR EXISTS (
        SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
        WHERE generation = OLD.generation LIMIT 1
      ) OR EXISTS (
        SELECT 1 FROM vectors INDEXED BY sqlite_autoindex_vectors_1
        WHERE generation = OLD.generation LIMIT 1
      )
      THEN RAISE(ABORT, 'code graph vector generation deletion is unauthorized')
    END;
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM vector_retirement_state
      WHERE singleton = 1 AND generation_revision < ${MAXIMUM_SAFE_INTEGER_SQL}
      LIMIT 1
    ) THEN RAISE(ABORT, 'code graph vector generation revision is exhausted') END;
    UPDATE vector_retirement_state
    SET generation_revision = generation_revision + 1
    WHERE singleton = 1;
  END`;

const VECTOR_RETIREMENT_GENERATION_DELETED_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS vector_retirement_generation_deleted_clear
  AFTER DELETE ON vector_generations
  BEGIN
    ${RETIREMENT_SCHEMA_TRIGGER_GUARD_SQL}
    DELETE FROM vector_generation_retirements
    WHERE generation = OLD.generation AND delete_authorized = 1;
  END`;

export const CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS = [
  {name: 'vector_retirement_marker_insert_guard', sql: VECTOR_RETIREMENT_MARKER_INSERT_TRIGGER_SQL},
  {name: 'vector_retirement_marker_update_guard', sql: VECTOR_RETIREMENT_MARKER_UPDATE_TRIGGER_SQL},
  {name: 'vector_retirement_marker_delete_guard', sql: VECTOR_RETIREMENT_MARKER_DELETE_TRIGGER_SQL},
  {name: 'vector_retirement_pointer_insert_guard', sql: VECTOR_RETIREMENT_POINTER_INSERT_TRIGGER_SQL},
  {name: 'vector_retirement_pointer_update_guard', sql: VECTOR_RETIREMENT_POINTER_UPDATE_TRIGGER_SQL},
  {name: 'vector_retirement_pointer_delete_guard', sql: VECTOR_RETIREMENT_POINTER_DELETE_GUARD_TRIGGER_SQL},
  {name: 'vector_retirement_pointer_delete_mark', sql: VECTOR_RETIREMENT_POINTER_DELETE_TRIGGER_SQL},
  {name: 'vector_retirement_pointer_update_mark', sql: VECTOR_RETIREMENT_POINTER_CHANGED_TRIGGER_SQL},
  {name: 'vector_retirement_vector_insert_guard', sql: VECTOR_RETIREMENT_VECTOR_INSERT_TRIGGER_SQL},
  {name: 'vector_retirement_vector_update_guard', sql: VECTOR_RETIREMENT_VECTOR_UPDATE_TRIGGER_SQL},
  {name: 'vector_retirement_generation_insert_guard', sql: VECTOR_RETIREMENT_GENERATION_INSERT_TRIGGER_SQL},
  {name: 'vector_retirement_generation_update_guard', sql: VECTOR_RETIREMENT_GENERATION_UPDATE_TRIGGER_SQL},
  {name: 'vector_retirement_generation_delete_guard', sql: VECTOR_RETIREMENT_GENERATION_DELETE_TRIGGER_SQL},
  {name: 'vector_retirement_generation_deleted_clear', sql: VECTOR_RETIREMENT_GENERATION_DELETED_TRIGGER_SQL},
] as const;

// sqlite_schema rows (tables, implicit/explicit indexes, triggers), the
// singleton state row, and sqlite_sequence authority published by r1. The
// fixed conservative count is versioned by the exact SQL byte constant below.
export const CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_ROWS = 24;
export const CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_BYTES = [
  CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL,
  CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL,
  ...CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS.map(trigger => trigger.sql),
].reduce((total, sql) => total + new TextEncoder().encode(storedSchemaSql(sql)).byteLength, 256);

export interface CodeGraphVectorRetirementMarker {
  readonly deleteAuthorized: boolean;
  readonly generation: string;
  readonly pageRevision: number;
  readonly retiredByWorktreeId?: string;
  readonly retirementId: number;
  readonly snapshotId: string;
}

export type CodeGraphVectorRetirementPreparationResult = {readonly state: 'prepared' | 'ready'};

export type CodeGraphVectorRetirementPageResult =
  | {readonly remaining: false; readonly rowsDeleted: 0; readonly state: 'stale'}
  | {readonly remaining: false; readonly rowsDeleted: number; readonly state: 'complete'}
  | {
      readonly marker: CodeGraphVectorRetirementMarker;
      readonly remaining: true;
      readonly rowsDeleted: number;
      readonly state: 'progress';
    };

export interface CodeGraphVectorRetirementPageInput {
  readonly epoch?: number;
  readonly generation: string;
  readonly requestedLimit?: number;
  readonly retirementId?: number;
}

export interface CodeGraphVectorRetirementCapacityProtector {
  <A, E, R>(
    boundary: CodeGraphDirectPersistentCapacityBoundary,
    transaction: Effect.Effect<A, E, R>,
    storage: CodeGraphVectorPageStorage,
  ): Effect.Effect<A, unknown, R>;
}

export interface CodeGraphVectorRetirementExecutionOptions {
  readonly capacityProtector: CodeGraphVectorRetirementCapacityProtector;
}

export interface CodeGraphVectorRetirementCapacityProtectionOptions {
  readonly availableDiskBytes?: (
    path: string,
    boundary: CodeGraphDirectPersistentCapacityBoundary,
  ) => Effect.Effect<number | undefined, unknown>;
  readonly databasePath: string;
  readonly claimMode?: 'nonblocking-one-attempt' | 'wait';
  readonly temporaryDirectory?: string;
  readonly threadnoteHome: string;
}

/** Builds the home-global receipt bracket used by vector schema/page writers. */
export const makeCodeGraphVectorRetirementCapacityProtector = Effect.fn(
  'codeGraph.makeVectorRetirementCapacityProtector',
)(function* (options: CodeGraphVectorRetirementCapacityProtectionOptions) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const temporaryDirectory = options.temporaryDirectory ?? system.tempDirectory;
  const protector: CodeGraphVectorRetirementCapacityProtector = (boundary, transaction, storage) =>
    withCodeGraphDiskReservation(
      {
        boundary,
        claimMode: options.claimMode,
        ledgerLockPath: codeGraphDiskReservationLockPath(path, options.threadnoteHome),
        ledgerRoot: codeGraphDiskReservationRoot(path, options.threadnoteHome),
        maintenance: Effect.void,
        observe: observeCodeGraphVectorRetirementCapacity({
          boundary,
          databasePath: options.databasePath,
          fs,
          path,
          probe: options.availableDiskBytes ?? ((target: string) => system.availableDiskBytes(target)),
          storage,
          system,
          temporaryDirectory,
        }),
      },
      transaction,
    ).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SystemInfo, system),
    );
  return protector;
});

const observeCodeGraphVectorRetirementCapacity = Effect.fn('codeGraph.observeVectorRetirementCapacity')(
  function* (input: {
    readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
    readonly databasePath: string;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly probe: (
      path: string,
      boundary: CodeGraphDirectPersistentCapacityBoundary,
    ) => Effect.Effect<number | undefined, unknown>;
    readonly system: SystemInfoShape;
    readonly storage: CodeGraphVectorPageStorage;
    readonly temporaryDirectory: string;
  }) {
    const durableRoot = input.path.dirname(input.databasePath);
    const [durableInfo, temporaryInfo, durableAvailableBytes, temporaryAvailableBytes, storage] = yield* Effect.all(
      [
        input.fs.stat(durableRoot).pipe(Effect.option),
        input.fs.stat(input.temporaryDirectory).pipe(Effect.option),
        input.probe(durableRoot, input.boundary).pipe(Effect.catch(() => Effect.succeed(undefined))),
        input.probe(input.temporaryDirectory, input.boundary).pipe(Effect.catch(() => Effect.succeed(undefined))),
        inspectCodeGraphVectorPageStorage(input.databasePath).pipe(Effect.option),
      ] as const,
      {concurrency: 2},
    );
    const pageStorage = Option.getOrUndefined(storage);
    if (pageStorage === undefined || !sameVectorPageStorage(input.storage, pageStorage)) {
      return yield* Effect.fail(new Error('Code graph vector page storage changed before reservation.'));
    }
    const durableDevice = Option.isSome(durableInfo) ? durableInfo.value.dev : undefined;
    const temporaryDevice = Option.isSome(temporaryInfo) ? temporaryInfo.value.dev : undefined;
    return {
      demand: codeGraphVectorRetirementCapacityDemand({
        finalFactBytes: input.boundary.finalFactBytes,
        lexicalFormatVersion: 1,
        operation: input.boundary.operation,
        pageSize: pageStorage?.pageSize ?? 0,
        rowCount: input.boundary.rowCount,
        walAutoCheckpointPages: pageStorage?.walAutoCheckpointPages ?? 0,
      }),
      durableAvailableBytes,
      durableFilesystemKey:
        codeGraphDiskReservationFilesystemKey(input.system.platform, durableDevice) ?? 'durable-filesystem-unknown',
      // SQLite freelist pages cannot fund the ordinary cursor's external
      // temp/final files, so the combined operation admits against raw space.
      freelistBytes:
        input.boundary.operation === 'maintain code graph vector retirement' ? 0 : (pageStorage?.freelistBytes ?? 0),
      temporaryAvailableBytes,
      temporaryFilesystemKey:
        codeGraphDiskReservationFilesystemKey(input.system.platform, temporaryDevice) ?? 'temporary-filesystem-unknown',
    };
  },
);

export type CodeGraphVectorRetirementPagePlan =
  | {readonly result: Extract<CodeGraphVectorRetirementPageResult, {readonly state: 'stale'}>; readonly state: 'stale'}
  | {
      readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
      readonly generation: string;
      readonly generationManifest: CodeGraphVectorGenerationManifest;
      readonly lastSymbolId?: string;
      readonly marker: CodeGraphVectorRetirementMarker;
      readonly requestedLimit: number;
      readonly selectedRowCount: number;
      readonly state: 'planned';
      readonly storage: CodeGraphVectorPageStorage;
    };

export interface CodeGraphVectorPointerRetirementInput {
  readonly expectedSnapshotId: string;
  readonly worktreeId: string;
}

interface CodeGraphVectorPointerRetirementObservation {
  readonly generationManifest: CodeGraphVectorGenerationManifest;
  readonly worktreeId: string;
}

export type CodeGraphVectorPointerRetirementPlan =
  | {readonly result: 0; readonly state: 'unchanged'}
  | {
      readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
      readonly input: CodeGraphVectorPointerRetirementInput;
      readonly observation: CodeGraphVectorPointerRetirementObservation;
      readonly state: 'planned';
      readonly storage: CodeGraphVectorPageStorage;
    };

const observeVectorPointerRetirement = Effect.fn('codeGraph.observeVectorPointerRetirement')(function* (
  sql: SqlClient.SqlClient,
  input: CodeGraphVectorPointerRetirementInput,
) {
  const rows = yield* sql.unsafe<{
    readonly generation: unknown;
    readonly snapshot_id: unknown;
    readonly worktree_id: unknown;
  }>(
    `SELECT
       CASE WHEN typeof(pointer.worktree_id) = 'text'
              AND length(CAST(pointer.worktree_id AS BLOB)) = 64
              AND pointer.worktree_id NOT GLOB '*[^0-9a-f]*'
            THEN pointer.worktree_id ELSE NULL END AS worktree_id,
       CASE WHEN typeof(pointer.generation) = 'text'
              AND length(CAST(pointer.generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
              AND instr(pointer.generation, char(0)) = 0
            THEN pointer.generation ELSE NULL END AS generation,
       CASE WHEN typeof(generation.snapshot_id) = 'text'
              AND length(CAST(generation.snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
              AND instr(generation.snapshot_id, char(0)) = 0
            THEN generation.snapshot_id ELSE NULL END AS snapshot_id
     FROM vector_pointers AS pointer
     JOIN vector_generations AS generation ON generation.generation = pointer.generation
     WHERE pointer.worktree_id = ?
     LIMIT 2`,
    [input.worktreeId],
  );
  if (rows.length === 0) return undefined;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.worktree_id !== input.worktreeId ||
    typeof row.generation !== 'string' ||
    typeof row.snapshot_id !== 'string'
  ) {
    return yield* Effect.fail(new Error('Code graph vector pointer retirement authority is invalid.'));
  }
  if (row.snapshot_id !== input.expectedSnapshotId) return undefined;
  const generationManifest = yield* inspectBoundedVectorGenerationManifest(sql, row.generation);
  if (generationManifest.snapshotId !== input.expectedSnapshotId) {
    return yield* Effect.fail(new Error('Code graph vector pointer retirement authority changed.'));
  }
  if ((yield* selectVectorRetirementMarker(sql, row.generation)) !== undefined) {
    return yield* Effect.fail(new Error('Code graph vector pointer retirement marker is already authoritative.'));
  }
  return {generationManifest, worktreeId: input.worktreeId} satisfies CodeGraphVectorPointerRetirementObservation;
});

function sameVectorPointerRetirementObservation(
  left: CodeGraphVectorPointerRetirementObservation,
  right: CodeGraphVectorPointerRetirementObservation,
): boolean {
  return (
    left.worktreeId === right.worktreeId &&
    sameVectorGenerationManifest(left.generationManifest, right.generationManifest)
  );
}

export const planCodeGraphVectorPointerRetirement = Effect.fn('codeGraph.planVectorPointerRetirement')(function* (
  databasePath: string,
  input: CodeGraphVectorPointerRetirementInput,
) {
  if (!/^[0-9a-f]{64}$/.test(input.worktreeId) || !validBoundedText(input.expectedSnapshotId, VECTOR_SNAPSHOT_BYTES)) {
    return yield* Effect.fail(new Error('Code graph vector pointer retirement target is invalid.'));
  }
  return yield* useExistingVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA foreign_keys = ON');
      yield* sql.unsafe('PRAGMA busy_timeout = 0');
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* Effect.fail(new Error('Code graph vector retirement schema is incompatible.'));
      }
      const observation = yield* observeVectorPointerRetirement(sql, input);
      if (observation === undefined) {
        return {result: 0, state: 'unchanged'} as const satisfies CodeGraphVectorPointerRetirementPlan;
      }
      return {
        boundary: {
          finalFactBytes:
            observation.generationManifest.finalFactBytes +
            new TextEncoder().encode(observation.generationManifest.generation).byteLength +
            new TextEncoder().encode(observation.generationManifest.snapshotId).byteLength +
            64 +
            512,
          operation: 'retire code graph vector pointer',
          rowCount: 4,
        },
        input,
        observation,
        state: 'planned',
        storage: yield* inspectVectorPageStorageSql(sql),
      } satisfies CodeGraphVectorPointerRetirementPlan;
    }),
  );
});

export const commitCodeGraphVectorPointerRetirement = Effect.fn('codeGraph.commitVectorPointerRetirement')(function* (
  databasePath: string,
  plan: Extract<CodeGraphVectorPointerRetirementPlan, {readonly state: 'planned'}>,
) {
  return yield* useExistingVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA foreign_keys = ON');
      yield* sql.unsafe('PRAGMA busy_timeout = 0');
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (
            !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
            (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready' ||
            !sameVectorPageStorage(plan.storage, yield* inspectVectorPageStorageSql(sql))
          ) {
            return yield* Effect.fail(new Error('Code graph vector pointer retirement authority changed.'));
          }
          const observed = yield* observeVectorPointerRetirement(sql, plan.input);
          if (observed === undefined) return 0;
          if (!sameVectorPointerRetirementObservation(plan.observation, observed)) {
            return yield* Effect.fail(new Error('Code graph vector pointer retirement plan changed.'));
          }
          yield* sql.unsafe(
            `UPDATE vector_retirement_state
             SET pointer_delete_worktree_id = ?,
                 pointer_delete_generation = ?,
                 pointer_delete_snapshot_id = ?
             WHERE singleton = 1
               AND pointer_delete_worktree_id IS NULL
               AND pointer_delete_generation IS NULL
               AND pointer_delete_snapshot_id IS NULL`,
            [plan.input.worktreeId, observed.generationManifest.generation, observed.generationManifest.snapshotId],
          );
          if ((yield* lastStatementChangeCount(sql)) !== 1) {
            return yield* Effect.fail(new Error('Code graph vector pointer retirement authority is busy.'));
          }
          yield* sql.unsafe('DELETE FROM vector_pointers WHERE worktree_id = ? AND generation = ?', [
            plan.input.worktreeId,
            observed.generationManifest.generation,
          ]);
          if ((yield* lastStatementChangeCount(sql)) !== 1) {
            return yield* Effect.fail(new Error('Code graph vector pointer retirement target changed.'));
          }
          const authority = yield* sql.unsafe(
            `SELECT 1 FROM vector_retirement_state
             WHERE singleton = 1
               AND pointer_delete_worktree_id IS NULL
               AND pointer_delete_generation IS NULL
               AND pointer_delete_snapshot_id IS NULL
             LIMIT 1`,
          );
          if (authority.length !== 1) {
            return yield* Effect.fail(new Error('Code graph vector pointer retirement authority was retained.'));
          }
          return 1;
        }),
      );
    }),
  );
});

export const retireCodeGraphVectorPointerWithCapacity = Effect.fn('codeGraph.retireVectorPointerWithCapacity')(
  function* (
    databasePath: string,
    input: CodeGraphVectorPointerRetirementInput,
    options: CodeGraphVectorRetirementExecutionOptions,
  ) {
    const plan = yield* planCodeGraphVectorPointerRetirement(databasePath, input);
    if (plan.state === 'unchanged') return plan.result;
    return yield* options.capacityProtector(
      plan.boundary,
      commitCodeGraphVectorPointerRetirement(databasePath, plan),
      plan.storage,
    );
  },
);

/**
 * Authorizes and consumes one exact pointer deletion in one transaction. The
 * credential is never committed: its AFTER trigger clears it after the exact
 * row is deleted, while every failure rolls the entire transaction back.
 */
export const deleteCodeGraphVectorPointerWithRetirement = Effect.fn('codeGraph.deleteVectorPointerWithRetirement')(
  function* (databasePath: string, input: CodeGraphVectorPointerRetirementInput) {
    if (
      !/^[0-9a-f]{64}$/.test(input.worktreeId) ||
      !validBoundedText(input.expectedSnapshotId, VECTOR_SNAPSHOT_BYTES)
    ) {
      return yield* Effect.fail(new Error('Code graph vector pointer retirement target is invalid.'));
    }
    return yield* useExistingVectorDatabase(
      databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('PRAGMA foreign_keys = ON');
        yield* sql.unsafe('PRAGMA busy_timeout = 0');
        if (
          !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
          (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
        ) {
          return yield* Effect.fail(new Error('Code graph vector retirement schema is incompatible.'));
        }
        return yield* deleteCodeGraphVectorPointerWithRetirementSql(sql, input);
      }),
    );
  },
);

export const deleteCodeGraphVectorPointerWithRetirementSql = Effect.fn(
  'codeGraph.deleteVectorPointerWithRetirementSql',
)(function* (sql: SqlClient.SqlClient, input: CodeGraphVectorPointerRetirementInput) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* Effect.fail(new Error('Code graph vector retirement schema is incompatible.'));
      }
      const rows = yield* sql.unsafe<{
        readonly generation: unknown;
        readonly snapshot_id: unknown;
      }>(
        `SELECT
           CASE
             WHEN typeof(pointer.generation) = 'text'
              AND length(CAST(pointer.generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
              AND instr(pointer.generation, char(0)) = 0
             THEN pointer.generation ELSE NULL
           END AS generation,
           CASE
             WHEN typeof(generation.snapshot_id) = 'text'
              AND length(CAST(generation.snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
              AND instr(generation.snapshot_id, char(0)) = 0
             THEN generation.snapshot_id ELSE NULL
           END AS snapshot_id
         FROM vector_pointers AS pointer
         JOIN vector_generations AS generation ON generation.generation = pointer.generation
         WHERE pointer.worktree_id = ?
         LIMIT 2`,
        [input.worktreeId],
      );
      if (rows.length === 0) return 0;
      const row = rows[0];
      if (rows.length !== 1 || typeof row?.generation !== 'string' || typeof row.snapshot_id !== 'string') {
        return yield* Effect.fail(new Error('Code graph vector pointer retirement authority is invalid.'));
      }
      if (row.snapshot_id !== input.expectedSnapshotId) return 0;
      yield* sql.unsafe(
        `UPDATE vector_retirement_state
         SET pointer_delete_worktree_id = ?,
             pointer_delete_generation = ?,
             pointer_delete_snapshot_id = ?
         WHERE singleton = 1
           AND pointer_delete_worktree_id IS NULL
           AND pointer_delete_generation IS NULL
           AND pointer_delete_snapshot_id IS NULL`,
        [input.worktreeId, row.generation, row.snapshot_id],
      );
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* Effect.fail(new Error('Code graph vector pointer retirement authority is busy.'));
      }
      yield* sql.unsafe('DELETE FROM vector_pointers WHERE worktree_id = ? AND generation = ?', [
        input.worktreeId,
        row.generation,
      ]);
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* Effect.fail(new Error('Code graph vector pointer retirement target changed.'));
      }
      const authority = yield* sql.unsafe(
        `SELECT 1 FROM vector_retirement_state
         WHERE singleton = 1
           AND pointer_delete_worktree_id IS NULL
           AND pointer_delete_generation IS NULL
           AND pointer_delete_snapshot_id IS NULL
         LIMIT 1`,
      );
      if (authority.length !== 1) {
        return yield* Effect.fail(new Error('Code graph vector pointer retirement authority was retained.'));
      }
      return 1;
    }),
  );
});

export function codeGraphVectorRetirementLegacyPointerProbeStatement() {
  return {
    parameters: [CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_ROWS + 1] as const,
    text: `SELECT
       CASE
         WHEN typeof(worktree_id) = 'text'
          AND length(CAST(worktree_id AS BLOB)) = 64
          AND worktree_id NOT GLOB '*[^0-9a-f]*'
         THEN worktree_id ELSE NULL
       END AS worktree_id,
       CASE
         WHEN typeof(generation) = 'text'
          AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
          AND instr(generation, char(0)) = 0
         THEN generation ELSE NULL
       END AS generation,
       length(CAST(worktree_id AS BLOB)) + length(CAST(generation AS BLOB)) AS identity_bytes
     FROM vector_pointers
     ORDER BY vector_pointers.worktree_id
     LIMIT ?`,
  };
}

/** @internal Frozen manifest for the released-v2 pointer-index bridge. */
export interface LegacyPointerIndexPlan {
  readonly finalFactBytes: number;
  readonly rows: readonly {readonly generation: string; readonly worktreeId: string}[];
  readonly storage: CodeGraphVectorPageStorage;
}

export type CodeGraphVectorRetirementPreparationPlan =
  | {readonly state: 'ready'}
  | {
      readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
      readonly coreState: 'missing-pointer-index' | 'ready';
      readonly legacy?: LegacyPointerIndexPlan;
      readonly retirementState: 'absent';
      readonly state: 'planned';
      readonly storage: CodeGraphVectorPageStorage;
    };

export const planCodeGraphVectorRetirementPreparation = Effect.fn('codeGraph.planVectorRetirementPreparation')(
  function* (databasePath: string) {
    const observed = yield* useExistingVectorDatabase(
      databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('PRAGMA foreign_keys = ON');
        yield* sql.unsafe('PRAGMA busy_timeout = 0');
        const versions = yield* sql.unsafe<{readonly user_version: unknown}>('PRAGMA user_version');
        if (versions.length !== 1 || versions[0]?.user_version !== 2) {
          return yield* Effect.fail(new Error('Code graph vector database version is unsupported.'));
        }
        const coreState = yield* codeGraphVectorCoreSchemaState(sql);
        if (coreState === 'incompatible') {
          return yield* Effect.fail(new Error('Code graph vector database authority is incompatible.'));
        }
        if (coreState === 'ready') {
          const retirementState = yield* codeGraphVectorRetirementSchemaState(sql);
          if (retirementState === 'ready') return {state: 'ready'} as const;
          if (retirementState === 'incompatible') {
            return yield* Effect.fail(new Error('Code graph vector retirement schema is incompatible.'));
          }
          return {
            coreState,
            retirementState: 'absent' as const,
            state: 'planned',
            storage: yield* inspectVectorPageStorageSql(sql),
          } as const;
        }
        if ((yield* codeGraphVectorRetirementSchemaState(sql)) !== 'absent') {
          return yield* Effect.fail(new Error('Code graph vector retirement authority is incomplete.'));
        }
        const legacy = yield* inspectLegacyPointerIndexPlan(sql);
        return {
          coreState,
          legacy,
          retirementState: 'absent' as const,
          state: 'planned',
          storage: legacy.storage,
        } as const;
      }),
    );
    if (observed.state === 'ready') return observed satisfies CodeGraphVectorRetirementPreparationPlan;
    const boundary: CodeGraphDirectPersistentCapacityBoundary = {
      finalFactBytes:
        CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_BYTES +
        (observed.coreState === 'missing-pointer-index'
          ? observed.legacy.finalFactBytes +
            new TextEncoder().encode(storedSchemaSql(CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL)).byteLength
          : 0),
      operation: 'prepare code graph vector retirement schema',
      rowCount:
        CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_ROWS +
        (observed.coreState === 'missing-pointer-index' ? observed.legacy.rows.length + 1 : 0),
    };
    return {...observed, boundary} satisfies CodeGraphVectorRetirementPreparationPlan;
  },
);

export const commitCodeGraphVectorRetirementPreparation = Effect.fn('codeGraph.commitVectorRetirementPreparation')(
  function* (
    databasePath: string,
    plan: Extract<CodeGraphVectorRetirementPreparationPlan, {readonly state: 'planned'}>,
  ) {
    return yield* useExistingVectorDatabase(
      databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('PRAGMA foreign_keys = ON');
        yield* sql.unsafe('PRAGMA busy_timeout = 0');
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const coreState = yield* codeGraphVectorCoreSchemaState(sql);
            if (
              coreState !== plan.coreState ||
              !sameVectorPageStorage(plan.storage, yield* inspectVectorPageStorageSql(sql))
            ) {
              return yield* Effect.fail(new Error('Code graph vector database authority changed during setup.'));
            }
            if ((yield* codeGraphVectorRetirementSchemaState(sql)) !== plan.retirementState) {
              return yield* Effect.fail(new Error('Code graph vector retirement authority changed during setup.'));
            }
            if (coreState === 'missing-pointer-index') {
              const revalidated = yield* inspectLegacyPointerIndexPlan(sql);
              if (plan.legacy === undefined || !sameLegacyPointerIndexPlan(plan.legacy, revalidated)) {
                return yield* Effect.fail(new Error('Code graph vector pointer index plan changed during setup.'));
              }
              yield* sql.unsafe('PRAGMA temp_store = MEMORY');
              yield* sql.unsafe(CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL);
            }
            const result = yield* publishCodeGraphVectorRetirementSchema(sql);
            if (!(yield* codeGraphVectorCoreSchemaCurrent(sql))) {
              return yield* Effect.fail(new Error('Code graph vector database authority changed during setup.'));
            }
            return result;
          }),
        );
      }),
    );
  },
);

export const prepareCodeGraphVectorRetirement = Effect.fn('codeGraph.prepareVectorRetirement')(function* (
  databasePath: string,
  options: CodeGraphVectorRetirementExecutionOptions,
) {
  const plan = yield* planCodeGraphVectorRetirementPreparation(databasePath);
  if (plan.state === 'ready') return plan;
  return yield* options.capacityProtector(
    plan.boundary,
    commitCodeGraphVectorRetirementPreparation(databasePath, plan),
    plan.storage,
  );
});

export const initializeCodeGraphVectorRetirementSchema = Effect.fn('codeGraph.initializeVectorRetirementSchema')(
  function* (sql: SqlClient.SqlClient) {
    if (!(yield* codeGraphVectorCoreSchemaCurrent(sql))) {
      return yield* Effect.fail(new Error('Code graph vector database authority is incompatible.'));
    }
    const state = yield* codeGraphVectorRetirementSchemaState(sql);
    if (state === 'ready') return {state: 'ready'} as const;
    if (state === 'incompatible') {
      return yield* Effect.fail(new Error('Code graph vector retirement schema is incompatible.'));
    }
    return yield* sql.withTransaction(publishCodeGraphVectorRetirementSchema(sql));
  },
);

export const requireCodeGraphVectorRetirementSchema = Effect.fn('codeGraph.requireVectorRetirementSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  if (
    !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
    (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
  ) {
    return yield* Effect.fail(new Error('Code graph vector retirement schema requires explicit preparation.'));
  }
});

const publishCodeGraphVectorRetirementSchema = Effect.fn('codeGraph.publishVectorRetirementSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL);
  yield* sql.unsafe('INSERT INTO vector_retirement_state (singleton, admission_cursor) VALUES (1, NULL)');
  yield* sql.unsafe(CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL);
  yield* sql.unsafe("INSERT INTO sqlite_sequence (name, seq) VALUES ('vector_generation_retirements', 0)");
  yield* sql.unsafe(CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL);
  for (const trigger of CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS) yield* sql.unsafe(trigger.sql);
  if ((yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready') {
    return yield* Effect.fail(new Error('Code graph vector retirement schema changed during setup.'));
  }
  return {state: 'prepared'} as const;
});

/** @internal Exact indexed selector used to freeze a bounded vector deletion page. */
export function codeGraphVectorRetirementPageStatement(generation: string, requestedLimit: number) {
  const limit = boundedRetirementLimit(requestedLimit);
  return {
    parameters: [generation, limit] as const,
    text: `SELECT
       CASE
         WHEN typeof(symbol_id) = 'text'
          AND length(CAST(symbol_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SYMBOL_BYTES}
          AND instr(symbol_id, char(0)) = 0
         THEN symbol_id ELSE NULL
       END AS symbol_id,
       length(CAST(symbol_id AS BLOB)) AS symbol_bytes,
       CASE
         WHEN typeof(fingerprint) = 'text'
          AND length(CAST(fingerprint AS BLOB)) BETWEEN 1 AND ${VECTOR_FINGERPRINT_BYTES}
          AND instr(fingerprint, char(0)) = 0
         THEN length(CAST(fingerprint AS BLOB)) ELSE NULL
       END AS fingerprint_bytes,
       CASE
         WHEN typeof(vector) = 'blob'
          AND length(vector) BETWEEN 1 AND ${CODE_GRAPH_VECTOR_RETIREMENT_PAGE_BYTES}
         THEN length(vector) ELSE NULL
       END AS vector_bytes
     FROM vectors INDEXED BY sqlite_autoindex_vectors_1
     WHERE generation = ?
     ORDER BY vectors.symbol_id
     LIMIT ?`,
  };
}

interface BoundedVectorRetirementPage {
  readonly finalFactBytes: number;
  readonly lastSymbolId?: string;
  readonly rowCount: number;
}

interface CodeGraphVectorGenerationManifest {
  readonly count: number;
  readonly createdAt: string;
  readonly dimensions: number;
  readonly finalFactBytes: number;
  readonly generation: string;
  readonly modelId: string;
  readonly modelSha256: string;
  readonly snapshotId: string;
  readonly state: 'building' | 'ready';
  readonly templateVersion: number;
}

export interface CodeGraphVectorPageStorage {
  readonly freelistBytes: number;
  readonly journalMode: 'delete' | 'wal';
  readonly pageSize: number;
  readonly walAutoCheckpointPages: number;
}

const inspectBoundedVectorRetirementPage = Effect.fn('codeGraph.inspectBoundedVectorRetirementPage')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  limit: number,
) {
  const statement = codeGraphVectorRetirementPageStatement(generation, limit);
  const manifests = yield* sql.unsafe<{
    readonly fingerprint_bytes: unknown;
    readonly symbol_bytes: unknown;
    readonly symbol_id: unknown;
    readonly vector_bytes: unknown;
  }>(statement.text, statement.parameters);
  const generationBytes = new TextEncoder().encode(generation).byteLength;
  let finalFactBytes = 0;
  let lastSymbolId: string | undefined;
  let rowCount = 0;
  for (const manifest of manifests) {
    if (
      typeof manifest.symbol_id !== 'string' ||
      !Number.isSafeInteger(manifest.symbol_bytes) ||
      !Number.isSafeInteger(manifest.fingerprint_bytes) ||
      !Number.isSafeInteger(manifest.vector_bytes)
    ) {
      return yield* Effect.fail(new Error('Code graph vector retirement manifest is invalid.'));
    }
    const rowBytes =
      Number(manifest.symbol_bytes) +
      Number(manifest.fingerprint_bytes) +
      Number(manifest.vector_bytes) +
      generationBytes +
      64;
    if (!Number.isSafeInteger(rowBytes) || rowBytes <= 0) {
      return yield* Effect.fail(new Error('Code graph vector retirement manifest is invalid.'));
    }
    if (finalFactBytes + rowBytes > CODE_GRAPH_VECTOR_RETIREMENT_PAGE_BYTES) break;
    finalFactBytes += rowBytes;
    lastSymbolId = manifest.symbol_id;
    rowCount += 1;
  }
  if (manifests.length > 0 && lastSymbolId === undefined) {
    return yield* Effect.fail(new Error('Code graph vector retirement page exceeds its byte bound.'));
  }
  return {finalFactBytes, lastSymbolId, rowCount} satisfies BoundedVectorRetirementPage;
});

const inspectBoundedVectorGenerationManifest = Effect.fn('codeGraph.inspectBoundedVectorGenerationManifest')(function* (
  sql: SqlClient.SqlClient,
  expectedGeneration: string,
) {
  const rows = yield* sql.unsafe<{
    readonly bounded_count: unknown;
    readonly bounded_created_at: unknown;
    readonly bounded_dimensions: unknown;
    readonly bounded_generation: unknown;
    readonly bounded_model_id: unknown;
    readonly bounded_model_sha256: unknown;
    readonly bounded_snapshot_id: unknown;
    readonly bounded_state: unknown;
    readonly bounded_template_version: unknown;
  }>(
    `SELECT
       CASE WHEN typeof(generation) = 'text'
              AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
              AND instr(generation, char(0)) = 0
            THEN generation ELSE NULL END AS bounded_generation,
       CASE WHEN typeof(snapshot_id) = 'text'
              AND length(CAST(snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
              AND instr(snapshot_id, char(0)) = 0
            THEN snapshot_id ELSE NULL END AS bounded_snapshot_id,
       CASE WHEN typeof(model_id) = 'text'
              AND length(CAST(model_id AS BLOB)) BETWEEN 1 AND ${VECTOR_MODEL_ID_BYTES}
              AND instr(model_id, char(0)) = 0
            THEN model_id ELSE NULL END AS bounded_model_id,
       CASE WHEN typeof(model_sha256) = 'text'
              AND length(CAST(model_sha256 AS BLOB)) = ${VECTOR_MODEL_SHA256_BYTES}
              AND model_sha256 NOT GLOB '*[^0-9a-f]*'
            THEN model_sha256 ELSE NULL END AS bounded_model_sha256,
       CASE WHEN typeof(dimensions) = 'integer'
              AND dimensions BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
            THEN dimensions ELSE NULL END AS bounded_dimensions,
       CASE WHEN typeof(template_version) = 'integer'
              AND template_version BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
            THEN template_version ELSE NULL END AS bounded_template_version,
       CASE WHEN typeof(count) = 'integer'
              AND count BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
            THEN count ELSE NULL END AS bounded_count,
       CASE WHEN typeof(state) = 'text' AND state IN ('building', 'ready')
            THEN state ELSE NULL END AS bounded_state,
       CASE WHEN typeof(created_at) = 'text'
              AND length(CAST(created_at AS BLOB)) BETWEEN 1 AND ${VECTOR_CREATED_AT_BYTES}
              AND instr(created_at, char(0)) = 0
            THEN created_at ELSE NULL END AS bounded_created_at
     FROM vector_generations
     WHERE generation = ?
     LIMIT 2`,
    [expectedGeneration],
  );
  const row = rows[0];
  if (
    rows.length !== 1 ||
    typeof row?.bounded_generation !== 'string' ||
    row.bounded_generation !== expectedGeneration ||
    typeof row.bounded_snapshot_id !== 'string' ||
    typeof row.bounded_model_id !== 'string' ||
    typeof row.bounded_model_sha256 !== 'string' ||
    !Number.isSafeInteger(row.bounded_dimensions) ||
    !Number.isSafeInteger(row.bounded_template_version) ||
    !Number.isSafeInteger(row.bounded_count) ||
    (row.bounded_state !== 'building' && row.bounded_state !== 'ready') ||
    typeof row.bounded_created_at !== 'string'
  ) {
    return yield* Effect.fail(new Error('Code graph vector generation manifest is invalid.'));
  }
  const strings = [
    row.bounded_generation,
    row.bounded_snapshot_id,
    row.bounded_model_id,
    row.bounded_model_sha256,
    row.bounded_state,
    row.bounded_created_at,
  ];
  const finalFactBytes = strings.reduce((total, value) => total + new TextEncoder().encode(value).byteLength, 128);
  if (!Number.isSafeInteger(finalFactBytes)) {
    return yield* Effect.fail(new Error('Code graph vector generation manifest is invalid.'));
  }
  return {
    count: Number(row.bounded_count),
    createdAt: row.bounded_created_at,
    dimensions: Number(row.bounded_dimensions),
    finalFactBytes,
    generation: row.bounded_generation,
    modelId: row.bounded_model_id,
    modelSha256: row.bounded_model_sha256,
    snapshotId: row.bounded_snapshot_id,
    state: row.bounded_state,
    templateVersion: Number(row.bounded_template_version),
  } satisfies CodeGraphVectorGenerationManifest;
});

function sameVectorGenerationManifest(
  left: CodeGraphVectorGenerationManifest,
  right: CodeGraphVectorGenerationManifest,
): boolean {
  return (
    left.count === right.count &&
    left.createdAt === right.createdAt &&
    left.dimensions === right.dimensions &&
    left.finalFactBytes === right.finalFactBytes &&
    left.generation === right.generation &&
    left.modelId === right.modelId &&
    left.modelSha256 === right.modelSha256 &&
    left.snapshotId === right.snapshotId &&
    left.state === right.state &&
    left.templateVersion === right.templateVersion
  );
}

export const planCodeGraphVectorRetirementPage = Effect.fn('codeGraph.planVectorRetirementPage')(function* (
  databasePath: string,
  input: CodeGraphVectorRetirementPageInput,
) {
  const expectedRetirementId = input.retirementId ?? input.epoch;
  if (
    !validBoundedText(input.generation, VECTOR_GENERATION_BYTES) ||
    !Number.isSafeInteger(expectedRetirementId) ||
    Number(expectedRetirementId) <= 0
  ) {
    return yield* Effect.fail(new Error('Code graph vector retirement candidate is invalid.'));
  }
  const requestedLimit = input.requestedLimit ?? CODE_GRAPH_VECTOR_RETIREMENT_PAGE_ROWS;
  const limit = boundedRetirementLimit(requestedLimit);
  return yield* useExistingVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA foreign_keys = ON');
      yield* sql.unsafe('PRAGMA busy_timeout = 0');
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* Effect.fail(new Error('Code graph vector retirement schema is incompatible.'));
      }
      const marker = yield* selectVectorRetirementMarker(sql, input.generation);
      if (marker === undefined || marker.retirementId !== expectedRetirementId) {
        return {
          result: {remaining: false, rowsDeleted: 0, state: 'stale'} as const,
          state: 'stale',
        } satisfies CodeGraphVectorRetirementPagePlan;
      }
      if (marker.deleteAuthorized) {
        return yield* Effect.fail(new Error('Code graph vector retirement authorization is invalid.'));
      }
      const pointers = yield* sql.unsafe(
        `SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
         WHERE generation = ? LIMIT 1`,
        [marker.generation],
      );
      if (pointers.length !== 0) {
        return yield* Effect.fail(new Error('Code graph vector retirement still has a live pointer.'));
      }
      const generationManifest = yield* inspectBoundedVectorGenerationManifest(sql, marker.generation);
      if (generationManifest.snapshotId !== marker.snapshotId) {
        return yield* Effect.fail(new Error('Code graph vector generation authority changed.'));
      }
      const page = yield* inspectBoundedVectorRetirementPage(sql, marker.generation, limit);
      return {
        boundary: {
          finalFactBytes:
            page.finalFactBytes + generationManifest.finalFactBytes + vectorRetirementPageAuthorityBytes(marker),
          operation: 'retire code graph vector generation',
          rowCount: page.rowCount + CODE_GRAPH_VECTOR_RETIREMENT_PAGE_FIXED_ROWS,
        },
        generation: marker.generation,
        generationManifest,
        ...(page.lastSymbolId === undefined ? {} : {lastSymbolId: page.lastSymbolId}),
        marker,
        requestedLimit: limit,
        selectedRowCount: page.rowCount,
        state: 'planned',
        storage: yield* inspectVectorPageStorageSql(sql),
      } satisfies CodeGraphVectorRetirementPagePlan;
    }),
  );
});

export const commitCodeGraphVectorRetirementPage = Effect.fn('codeGraph.commitVectorRetirementPage')(function* (
  databasePath: string,
  plan: Extract<CodeGraphVectorRetirementPagePlan, {readonly state: 'planned'}>,
) {
  return yield* useExistingVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA foreign_keys = ON');
      yield* sql.unsafe('PRAGMA busy_timeout = 0');
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (
            !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
            (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
          ) {
            return yield* Effect.fail(new Error('Code graph vector retirement schema is incompatible.'));
          }
          if (!sameVectorPageStorage(plan.storage, yield* inspectVectorPageStorageSql(sql))) {
            return yield* Effect.fail(new Error('Code graph vector page storage changed.'));
          }
          const marker = yield* selectVectorRetirementMarker(sql, plan.generation);
          if (
            marker === undefined ||
            marker.retirementId !== plan.marker.retirementId ||
            marker.pageRevision !== plan.marker.pageRevision ||
            marker.snapshotId !== plan.marker.snapshotId ||
            marker.retiredByWorktreeId !== plan.marker.retiredByWorktreeId
          ) {
            return {remaining: false, rowsDeleted: 0, state: 'stale'} as const;
          }
          if (marker.deleteAuthorized) {
            return yield* Effect.fail(new Error('Code graph vector retirement authorization is invalid.'));
          }
          const pointers = yield* sql.unsafe(
            `SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
             WHERE generation = ? LIMIT 1`,
            [marker.generation],
          );
          if (pointers.length !== 0) {
            return yield* Effect.fail(new Error('Code graph vector retirement still has a live pointer.'));
          }
          const generationManifest = yield* inspectBoundedVectorGenerationManifest(sql, marker.generation);
          if (!sameVectorGenerationManifest(plan.generationManifest, generationManifest)) {
            return yield* Effect.fail(new Error('Code graph vector generation manifest changed.'));
          }
          const page = yield* inspectBoundedVectorRetirementPage(sql, marker.generation, plan.requestedLimit);
          if (
            page.finalFactBytes + generationManifest.finalFactBytes + vectorRetirementPageAuthorityBytes(marker) !==
              plan.boundary.finalFactBytes ||
            page.rowCount !== plan.selectedRowCount ||
            page.lastSymbolId !== plan.lastSymbolId
          ) {
            return yield* Effect.fail(new Error('Code graph vector retirement page changed.'));
          }
          let rowsDeleted = 0;
          if (page.lastSymbolId !== undefined) {
            yield* sql.unsafe(
              `DELETE FROM vectors
               WHERE generation = ? AND symbol_id <= ?`,
              [marker.generation, page.lastSymbolId],
            );
            rowsDeleted = yield* lastStatementChangeCount(sql);
            if (rowsDeleted !== page.rowCount) {
              return yield* Effect.fail(new Error('Code graph vector retirement page changed.'));
            }
          }
          const remaining = yield* sql.unsafe(
            `SELECT 1 FROM vectors INDEXED BY sqlite_autoindex_vectors_1
             WHERE generation = ? LIMIT 1`,
            [marker.generation],
          );
          if (remaining.length !== 0) {
            yield* sql.unsafe(
              `UPDATE vector_generation_retirements
               SET page_revision = page_revision + 1
               WHERE generation = ? AND retirement_id = ?
                 AND page_revision = ? AND delete_authorized = 0`,
              [marker.generation, marker.retirementId, marker.pageRevision],
            );
            if ((yield* lastStatementChangeCount(sql)) !== 1) {
              return yield* Effect.fail(new Error('Code graph vector retirement marker changed.'));
            }
            return {
              marker: {...marker, pageRevision: marker.pageRevision + 1},
              remaining: true,
              rowsDeleted,
              state: 'progress',
            } as const;
          }
          yield* sql.unsafe(
            `UPDATE vector_generation_retirements
             SET delete_authorized = 1
             WHERE generation = ? AND retirement_id = ?
               AND page_revision = ? AND delete_authorized = 0`,
            [marker.generation, marker.retirementId, marker.pageRevision],
          );
          if ((yield* lastStatementChangeCount(sql)) !== 1) {
            return yield* Effect.fail(new Error('Code graph vector retirement authorization changed.'));
          }
          yield* sql.unsafe('DELETE FROM vector_generations WHERE generation = ?', [marker.generation]);
          if ((yield* lastStatementChangeCount(sql)) !== 1) {
            return yield* Effect.fail(new Error('Code graph vector retirement generation changed.'));
          }
          return {remaining: false, rowsDeleted, state: 'complete'} as const;
        }),
      );
    }),
  );
});

export const retireCodeGraphVectorGenerationPage = Effect.fn('codeGraph.retireVectorGenerationPage')(function* (
  databasePath: string,
  input: CodeGraphVectorRetirementPageInput,
  options: CodeGraphVectorRetirementExecutionOptions,
) {
  const plan = yield* planCodeGraphVectorRetirementPage(databasePath, input);
  if (plan.state === 'stale') return plan.result;
  return yield* options.capacityProtector(
    plan.boundary,
    commitCodeGraphVectorRetirementPage(databasePath, plan),
    plan.storage,
  );
});

interface CodeGraphVectorRetirementAdmissionObservation {
  readonly admissionScanRevision?: number;
  readonly candidate?: CodeGraphVectorGenerationManifest;
  readonly cleanGenerationRevision?: number;
  readonly cursor?: string;
  readonly generationRevision: number;
  readonly marker?: CodeGraphVectorRetirementMarker;
  readonly pointerPresent: boolean;
}

export type CodeGraphVectorRetirementAdmissionResult =
  | {readonly state: 'empty'}
  | {readonly generation: string; readonly marker?: CodeGraphVectorRetirementMarker; readonly state: 'admitted'}
  | {readonly generation: string; readonly state: 'advanced'}
  | {readonly state: 'restarted'}
  | {readonly state: 'wrapped'};

export type CodeGraphVectorRetirementAdmissionPlan =
  | {
      readonly result: Extract<CodeGraphVectorRetirementAdmissionResult, {readonly state: 'empty'}>;
      readonly state: 'empty';
    }
  | {
      readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
      readonly observation: CodeGraphVectorRetirementAdmissionObservation;
      readonly state: 'planned';
      readonly storage: CodeGraphVectorPageStorage;
    };

const observeVectorRetirementAdmission = Effect.fn('codeGraph.observeVectorRetirementAdmission')(function* (
  sql: SqlClient.SqlClient,
) {
  const states = yield* sql.unsafe<{
    readonly admission_cursor: unknown;
    readonly admission_scan_revision: unknown;
    readonly clean_generation_revision: unknown;
    readonly generation_revision: unknown;
  }>(
    `SELECT CASE
       WHEN admission_cursor IS NULL THEN NULL
       WHEN typeof(admission_cursor) = 'text'
        AND length(CAST(admission_cursor AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
        AND instr(admission_cursor, char(0)) = 0
       THEN admission_cursor ELSE 0
     END AS admission_cursor,
     CASE
       WHEN typeof(generation_revision) = 'integer'
        AND generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
       THEN generation_revision ELSE -1
     END AS generation_revision,
     CASE
       WHEN admission_scan_revision IS NULL THEN NULL
       WHEN typeof(admission_scan_revision) = 'integer'
        AND admission_scan_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
       THEN admission_scan_revision ELSE -1
     END AS admission_scan_revision,
     CASE
       WHEN clean_generation_revision IS NULL THEN NULL
       WHEN typeof(clean_generation_revision) = 'integer'
        AND clean_generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
       THEN clean_generation_revision ELSE -1
     END AS clean_generation_revision
     FROM vector_retirement_state WHERE singleton = 1 LIMIT 2`,
  );
  const rawCursor = states[0]?.admission_cursor;
  const rawGenerationRevision = states[0]?.generation_revision;
  const rawAdmissionScanRevision = states[0]?.admission_scan_revision;
  const rawCleanGenerationRevision = states[0]?.clean_generation_revision;
  if (
    states.length !== 1 ||
    (rawCursor !== null && (typeof rawCursor !== 'string' || !validBoundedText(rawCursor, VECTOR_GENERATION_BYTES))) ||
    !Number.isSafeInteger(rawGenerationRevision) ||
    Number(rawGenerationRevision) < 0 ||
    (rawAdmissionScanRevision !== null &&
      (!Number.isSafeInteger(rawAdmissionScanRevision) ||
        Number(rawAdmissionScanRevision) < 0 ||
        Number(rawAdmissionScanRevision) > Number(rawGenerationRevision))) ||
    (rawCleanGenerationRevision !== null &&
      (!Number.isSafeInteger(rawCleanGenerationRevision) ||
        Number(rawCleanGenerationRevision) < 0 ||
        Number(rawCleanGenerationRevision) > Number(rawGenerationRevision))) ||
    (rawCursor === null) !== (rawAdmissionScanRevision === null) ||
    (rawAdmissionScanRevision !== null &&
      rawCleanGenerationRevision !== null &&
      Number(rawCleanGenerationRevision) > Number(rawAdmissionScanRevision)) ||
    (rawCleanGenerationRevision !== null &&
      Number(rawCleanGenerationRevision) === Number(rawGenerationRevision) &&
      (rawCursor !== null || rawAdmissionScanRevision !== null))
  ) {
    return yield* Effect.fail(new Error('Code graph vector retirement admission state is invalid.'));
  }
  const cursor = typeof rawCursor === 'string' ? rawCursor : undefined;
  const generationRevision = Number(rawGenerationRevision);
  const admissionScanRevision = rawAdmissionScanRevision === null ? undefined : Number(rawAdmissionScanRevision);
  const cleanGenerationRevision = rawCleanGenerationRevision === null ? undefined : Number(rawCleanGenerationRevision);
  const revisionState = {
    ...(admissionScanRevision === undefined ? {} : {admissionScanRevision}),
    ...(cleanGenerationRevision === undefined ? {} : {cleanGenerationRevision}),
    cursor,
    generationRevision,
    pointerPresent: false,
  } satisfies CodeGraphVectorRetirementAdmissionObservation;
  if (
    (admissionScanRevision !== undefined && admissionScanRevision !== generationRevision) ||
    (cursor === undefined && cleanGenerationRevision === generationRevision)
  ) {
    return revisionState;
  }
  const rows = yield* sql.unsafe<{readonly generation: unknown}>(
    `SELECT CASE
       WHEN typeof(generation) = 'text'
        AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
        AND instr(generation, char(0)) = 0
       THEN generation ELSE NULL
     END AS generation
     FROM vector_generations
     WHERE generation > ?
     ORDER BY vector_generations.generation
     LIMIT 1`,
    [cursor ?? ''],
  );
  if (rows.length === 0) {
    return revisionState;
  }
  const generation = rows[0]?.generation;
  if (typeof generation !== 'string') {
    return yield* Effect.fail(new Error('Code graph vector retirement admission row is invalid.'));
  }
  const candidate = yield* inspectBoundedVectorGenerationManifest(sql, generation);
  const marker = yield* selectVectorRetirementMarker(sql, generation);
  const pointers = yield* sql.unsafe(
    `SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
     WHERE generation = ? LIMIT 1`,
    [generation],
  );
  if (marker !== undefined && pointers.length !== 0) {
    return yield* Effect.fail(new Error('Code graph vector retirement admission authority is invalid.'));
  }
  if (marker !== undefined && (marker.snapshotId !== candidate.snapshotId || marker.deleteAuthorized)) {
    return yield* Effect.fail(new Error('Code graph vector retirement admission marker is invalid.'));
  }
  return {
    ...(admissionScanRevision === undefined ? {} : {admissionScanRevision}),
    candidate,
    ...(cleanGenerationRevision === undefined ? {} : {cleanGenerationRevision}),
    cursor,
    generationRevision,
    ...(marker === undefined ? {} : {marker}),
    pointerPresent: pointers.length !== 0,
  } satisfies CodeGraphVectorRetirementAdmissionObservation;
});

function sameVectorRetirementAdmissionObservation(
  left: CodeGraphVectorRetirementAdmissionObservation,
  right: CodeGraphVectorRetirementAdmissionObservation,
): boolean {
  return (
    left.admissionScanRevision === right.admissionScanRevision &&
    left.cleanGenerationRevision === right.cleanGenerationRevision &&
    left.cursor === right.cursor &&
    left.generationRevision === right.generationRevision &&
    left.pointerPresent === right.pointerPresent &&
    ((left.candidate === undefined && right.candidate === undefined) ||
      (left.candidate !== undefined &&
        right.candidate !== undefined &&
        sameVectorGenerationManifest(left.candidate, right.candidate))) &&
    ((left.marker === undefined && right.marker === undefined) ||
      (left.marker !== undefined &&
        right.marker !== undefined &&
        sameVectorRetirementMarker(left.marker, right.marker)))
  );
}

function sameVectorRetirementMarker(
  left: CodeGraphVectorRetirementMarker,
  right: CodeGraphVectorRetirementMarker,
): boolean {
  return (
    left.deleteAuthorized === right.deleteAuthorized &&
    left.generation === right.generation &&
    left.pageRevision === right.pageRevision &&
    left.retiredByWorktreeId === right.retiredByWorktreeId &&
    left.retirementId === right.retirementId &&
    left.snapshotId === right.snapshotId
  );
}

const applyVectorRetirementAdmissionObservation = Effect.fn('codeGraph.applyVectorRetirementAdmissionObservation')(
  function* (sql: SqlClient.SqlClient, observed: CodeGraphVectorRetirementAdmissionObservation) {
    const exactStateParameters = [
      observed.cursor ?? null,
      observed.admissionScanRevision ?? null,
      observed.cleanGenerationRevision ?? null,
      observed.generationRevision,
    ] as const;
    if (
      observed.admissionScanRevision !== undefined &&
      observed.admissionScanRevision !== observed.generationRevision
    ) {
      yield* sql.unsafe(
        `UPDATE vector_retirement_state
         SET admission_cursor = NULL,
             admission_scan_revision = NULL,
             clean_generation_revision = NULL
         WHERE singleton = 1
           AND admission_cursor IS ?
           AND admission_scan_revision IS ?
           AND clean_generation_revision IS ?
           AND generation_revision = ?`,
        exactStateParameters,
      );
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* Effect.fail(new Error('Code graph vector retirement admission revision changed.'));
      }
      return {state: 'restarted'} as const;
    }
    if (observed.candidate === undefined) {
      if (observed.cursor === undefined && observed.cleanGenerationRevision === observed.generationRevision) {
        return {state: 'empty'} as const;
      }
      yield* sql.unsafe(
        `UPDATE vector_retirement_state
         SET admission_cursor = NULL,
             admission_scan_revision = NULL,
             clean_generation_revision = generation_revision
         WHERE singleton = 1
           AND admission_cursor IS ?
           AND admission_scan_revision IS ?
           AND clean_generation_revision IS ?
           AND generation_revision = ?`,
        exactStateParameters,
      );
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* Effect.fail(new Error('Code graph vector retirement admission cursor changed.'));
      }
      return {state: 'wrapped'} as const;
    }
    let marker = observed.marker;
    if (!observed.pointerPresent && marker === undefined) {
      yield* sql.unsafe(
        `INSERT INTO vector_generation_retirements (
           generation, snapshot_id, retired_by_worktree_id
         ) VALUES (?, ?, NULL)`,
        [observed.candidate.generation, observed.candidate.snapshotId],
      );
      marker = yield* selectVectorRetirementMarker(sql, observed.candidate.generation);
      if (marker === undefined) {
        return yield* Effect.fail(new Error('Code graph vector retirement marker was not published.'));
      }
    }
    yield* sql.unsafe(
      `UPDATE vector_retirement_state
       SET admission_cursor = ?,
           admission_scan_revision = CASE
             WHEN admission_scan_revision IS NULL THEN generation_revision
             ELSE admission_scan_revision
           END
       WHERE singleton = 1
         AND admission_cursor IS ?
         AND admission_scan_revision IS ?
         AND clean_generation_revision IS ?
         AND generation_revision = ?`,
      [observed.candidate.generation, ...exactStateParameters],
    );
    if ((yield* lastStatementChangeCount(sql)) !== 1) {
      return yield* Effect.fail(new Error('Code graph vector retirement admission cursor changed.'));
    }
    return marker === undefined
      ? ({generation: observed.candidate.generation, state: 'advanced'} as const)
      : ({generation: observed.candidate.generation, marker, state: 'admitted'} as const);
  },
);

export const planCodeGraphVectorRetirementAdmission = Effect.fn('codeGraph.planVectorRetirementAdmission')(function* (
  databasePath: string,
) {
  return yield* useExistingVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA foreign_keys = ON');
      yield* sql.unsafe('PRAGMA busy_timeout = 0');
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* Effect.fail(new Error('Code graph vector retirement schema is incompatible.'));
      }
      const observation: CodeGraphVectorRetirementAdmissionObservation = yield* observeVectorRetirementAdmission(sql);
      if (
        observation.candidate === undefined &&
        observation.cursor === undefined &&
        observation.cleanGenerationRevision === observation.generationRevision
      ) {
        return {result: {state: 'empty'}, state: 'empty'} as const satisfies CodeGraphVectorRetirementAdmissionPlan;
      }
      const insertsMarker =
        observation.candidate !== undefined && !observation.pointerPresent && observation.marker === undefined;
      const cursorBytes =
        observation.cursor === undefined ? 0 : new TextEncoder().encode(observation.cursor).byteLength;
      const candidateBytes = observation.candidate?.finalFactBytes ?? 0;
      const markerBytes = insertsMarker
        ? new TextEncoder().encode(observation.candidate!.generation).byteLength +
          new TextEncoder().encode(observation.candidate!.snapshotId).byteLength +
          256
        : 0;
      return {
        boundary: {
          finalFactBytes: cursorBytes + candidateBytes + markerBytes + 256,
          operation: 'admit code graph vector retirement',
          rowCount: insertsMarker ? 4 : 1,
        },
        observation,
        state: 'planned',
        storage: yield* inspectVectorPageStorageSql(sql),
      } satisfies CodeGraphVectorRetirementAdmissionPlan;
    }),
  );
});

export const commitCodeGraphVectorRetirementAdmission = Effect.fn('codeGraph.commitVectorRetirementAdmission')(
  function* (databasePath: string, plan: Extract<CodeGraphVectorRetirementAdmissionPlan, {readonly state: 'planned'}>) {
    return yield* useExistingVectorDatabase(
      databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('PRAGMA foreign_keys = ON');
        yield* sql.unsafe('PRAGMA busy_timeout = 0');
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            if (
              !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
              (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready' ||
              !sameVectorPageStorage(plan.storage, yield* inspectVectorPageStorageSql(sql))
            ) {
              return yield* Effect.fail(new Error('Code graph vector retirement admission authority changed.'));
            }
            const observed: CodeGraphVectorRetirementAdmissionObservation =
              yield* observeVectorRetirementAdmission(sql);
            if (!sameVectorRetirementAdmissionObservation(plan.observation, observed)) {
              return yield* Effect.fail(new Error('Code graph vector retirement admission plan changed.'));
            }
            return yield* applyVectorRetirementAdmissionObservation(sql, observed);
          }),
        );
      }),
    );
  },
);

export const admitOneCodeGraphVectorRetirementWithCapacity = Effect.fn(
  'codeGraph.admitOneVectorRetirementWithCapacity',
)(function* (databasePath: string, options: CodeGraphVectorRetirementExecutionOptions) {
  const plan = yield* planCodeGraphVectorRetirementAdmission(databasePath);
  if (plan.state === 'empty') return plan.result;
  return yield* options.capacityProtector(
    plan.boundary,
    commitCodeGraphVectorRetirementAdmission(databasePath, plan),
    plan.storage,
  );
});

export interface CodeGraphVectorRetirementMarkerSelector {
  readonly afterGeneration?: string;
  readonly retiredByWorktreeId?: string;
  readonly snapshotId?: string;
}

/** @internal Singleton revision proof used only by the sealed ordinary-lane verifier. */
export function codeGraphVectorRetirementCleanRevisionProbeStatement() {
  return {
    parameters: [] as const,
    text: `SELECT CASE
       WHEN admission_cursor IS NULL
        AND admission_scan_revision IS NULL
        AND typeof(generation_revision) = 'integer'
        AND generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
        AND typeof(clean_generation_revision) = 'integer'
        AND clean_generation_revision = generation_revision
       THEN 1 ELSE 0
     END AS clean
     FROM vector_retirement_state
       INDEXED BY sqlite_autoindex_vector_retirement_state_1
     WHERE singleton = 1
     LIMIT 2`,
  };
}

export type CodeGraphVectorRetirementWorkInspection =
  {readonly state: 'admission'} | {readonly generation: string; readonly state: 'marker'} | {readonly state: 'clean'};

export interface CodeGraphVectorSnapshotUsage {
  readonly activePointerCount: number;
  /** Canonical path-free digest of every matching generation manifest and active pointer. */
  readonly evidenceDigest: string;
  readonly generationCount: number;
}

const CODE_GRAPH_VECTOR_SNAPSHOT_USAGE_LIMIT = 1_024;

/**
 * Read-only bounded evidence for selected snapshot deletion. An inactive
 * generation is retained for ordinary paged vector retirement, while any
 * pointer still joined to the snapshot makes physical graph deletion unsafe.
 */
export const inspectCodeGraphVectorSnapshotUsage = Effect.fn('codeGraph.inspectVectorSnapshotUsage')(function* (
  databasePath: string,
  snapshotId: string,
) {
  if (!validBoundedText(snapshotId, VECTOR_SNAPSHOT_BYTES)) {
    return yield* Effect.fail(new Error('Code graph vector snapshot identity is invalid.'));
  }
  return yield* useReadOnlyVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA busy_timeout = 0');
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* Effect.fail(new Error('Code graph vector retirement schema is incompatible.'));
      }
      const boundedLimit = CODE_GRAPH_VECTOR_SNAPSHOT_USAGE_LIMIT + 1;
      const generationRows = yield* sql.unsafe<{
        readonly count: unknown;
        readonly created_at: unknown;
        readonly dimensions: unknown;
        readonly generation: unknown;
        readonly model_id: unknown;
        readonly model_sha256: unknown;
        readonly state: unknown;
        readonly template_version: unknown;
      }>(
        `SELECT generation, model_id, model_sha256, dimensions, template_version, count, state, created_at
         FROM vector_generations
         WHERE snapshot_id = ?
         ORDER BY generation
         LIMIT ?`,
        [snapshotId, boundedLimit],
      );
      const pointerRows = yield* sql.unsafe<{
        readonly generation: unknown;
        readonly worktree_id: unknown;
      }>(
        `SELECT pointer.generation, pointer.worktree_id
         FROM vector_pointers AS pointer
         JOIN vector_generations AS generation ON generation.generation = pointer.generation
         WHERE generation.snapshot_id = ?
         ORDER BY pointer.generation, pointer.worktree_id
         LIMIT ?`,
        [snapshotId, boundedLimit],
      );
      if (
        generationRows.length > CODE_GRAPH_VECTOR_SNAPSHOT_USAGE_LIMIT ||
        pointerRows.length > CODE_GRAPH_VECTOR_SNAPSHOT_USAGE_LIMIT
      ) {
        return yield* Effect.fail(new Error('Code graph vector snapshot evidence exceeded its bound.'));
      }
      const generations = generationRows.map(row => {
        if (
          typeof row.generation !== 'string' ||
          !validBoundedText(row.generation, VECTOR_GENERATION_BYTES) ||
          typeof row.model_id !== 'string' ||
          !validBoundedText(row.model_id, VECTOR_MODEL_ID_BYTES) ||
          typeof row.model_sha256 !== 'string' ||
          !/^[0-9a-f]{64}$/u.test(row.model_sha256) ||
          !Number.isSafeInteger(row.dimensions) ||
          Number(row.dimensions) <= 0 ||
          !Number.isSafeInteger(row.template_version) ||
          Number(row.template_version) < 0 ||
          !Number.isSafeInteger(row.count) ||
          Number(row.count) < 0 ||
          (row.state !== 'building' && row.state !== 'ready') ||
          typeof row.created_at !== 'string' ||
          !validBoundedText(row.created_at, VECTOR_CREATED_AT_BYTES)
        ) {
          return undefined;
        }
        return [
          row.generation,
          row.model_id,
          row.model_sha256,
          Number(row.dimensions),
          Number(row.template_version),
          Number(row.count),
          row.state,
          row.created_at,
        ] as const;
      });
      const pointers = pointerRows.map(row => {
        if (
          typeof row.generation !== 'string' ||
          !validBoundedText(row.generation, VECTOR_GENERATION_BYTES) ||
          typeof row.worktree_id !== 'string' ||
          !/^[0-9a-f]{64}$/u.test(row.worktree_id)
        ) {
          return undefined;
        }
        return [row.generation, row.worktree_id] as const;
      });
      if (generations.some(row => row === undefined) || pointers.some(row => row === undefined)) {
        return yield* Effect.fail(new Error('Code graph vector snapshot evidence is invalid.'));
      }
      return {
        activePointerCount: pointers.length,
        evidenceDigest: sha256HexSync(
          `code-graph-vector-snapshot-usage-v1\n${JSON.stringify({generations, pointers, snapshotId})}`,
        ),
        generationCount: generations.length,
      } satisfies CodeGraphVectorSnapshotUsage;
    }),
  );
});

/** @internal Bounded read-only clean predicate for a fully locked model. */
export const inspectCodeGraphVectorRetirementWork = Effect.fn('codeGraph.inspectVectorRetirementWork')(function* (
  databasePath: string,
) {
  return yield* useReadOnlyVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* Effect.fail(new Error('Code graph vector retirement schema is incompatible.'));
      }
      const revisionStatement = codeGraphVectorRetirementCleanRevisionProbeStatement();
      const revisionRows = yield* sql.unsafe<{readonly clean: unknown}>(
        revisionStatement.text,
        revisionStatement.parameters,
      );
      if (revisionRows.length !== 1 || (revisionRows[0]?.clean !== 0 && revisionRows[0]?.clean !== 1)) {
        return yield* Effect.fail(new Error('Code graph vector retirement clean revision is invalid.'));
      }
      if (revisionRows[0].clean === 0) return {state: 'admission'} as const;

      const markerStatement = codeGraphVectorRetirementMarkerPageStatement({});
      const markerRows = yield* sql.unsafe<{readonly generation: unknown; readonly retirement_id: unknown}>(
        markerStatement.text,
        markerStatement.parameters,
      );
      if (markerRows.length === 0) return {state: 'clean'} as const;
      const generation = markerRows[0]?.generation;
      const retirementId = markerRows[0]?.retirement_id;
      if (typeof generation !== 'string' || !Number.isSafeInteger(retirementId) || Number(retirementId) <= 0) {
        return yield* Effect.fail(new Error('Code graph vector retirement marker probe is invalid.'));
      }
      const marker = yield* selectVectorRetirementMarker(sql, generation);
      if (marker === undefined || marker.retirementId !== retirementId) {
        return yield* Effect.fail(new Error('Code graph vector retirement marker authority changed.'));
      }
      return {generation, state: 'marker'} as const;
    }),
  );
});

/** @internal Exact indexed selector shared by the residual and ordinary vector lanes. */
export function codeGraphVectorRetirementMarkerPageStatement(input: CodeGraphVectorRetirementMarkerSelector) {
  const afterGeneration = input.afterGeneration ?? '';
  if (input.retiredByWorktreeId === undefined && input.snapshotId === undefined) {
    return {
      parameters: [afterGeneration] as const,
      text: `SELECT
         CASE WHEN typeof(generation) = 'text'
                AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
                AND instr(generation, char(0)) = 0
              THEN generation ELSE NULL END AS generation,
         CASE WHEN typeof(retirement_id) = 'integer'
                AND retirement_id BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
              THEN retirement_id ELSE NULL END AS retirement_id
       FROM vector_generation_retirements
         INDEXED BY sqlite_autoindex_vector_generation_retirements_1
       WHERE generation > ?
       ORDER BY vector_generation_retirements.generation
       LIMIT 1`,
    };
  }
  return {
    parameters: [input.retiredByWorktreeId, input.snapshotId, afterGeneration] as const,
    text: `SELECT
       CASE WHEN typeof(generation) = 'text'
              AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
              AND instr(generation, char(0)) = 0
            THEN generation ELSE NULL END AS generation,
       CASE WHEN typeof(retirement_id) = 'integer'
              AND retirement_id BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
            THEN retirement_id ELSE NULL END AS retirement_id
     FROM vector_generation_retirements
       INDEXED BY vector_generation_retirement_association
     WHERE retired_by_worktree_id = ?
       AND snapshot_id = ?
       AND generation > ?
     ORDER BY vector_generation_retirements.generation,
              vector_generation_retirements.retirement_id
     LIMIT 1`,
  };
}

export const selectCodeGraphVectorRetirementMarkerCandidate = Effect.fn(
  'codeGraph.selectVectorRetirementMarkerCandidate',
)(function* (databasePath: string, input: CodeGraphVectorRetirementMarkerSelector = {}) {
  if (
    (input.afterGeneration !== undefined && !validBoundedText(input.afterGeneration, VECTOR_GENERATION_BYTES)) ||
    (input.retiredByWorktreeId === undefined) !== (input.snapshotId === undefined) ||
    (input.retiredByWorktreeId !== undefined && !/^[0-9a-f]{64}$/.test(input.retiredByWorktreeId)) ||
    (input.snapshotId !== undefined && !validBoundedText(input.snapshotId, VECTOR_SNAPSHOT_BYTES))
  ) {
    return yield* Effect.fail(new Error('Code graph vector retirement marker selector is invalid.'));
  }
  return yield* useReadOnlyVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* Effect.fail(new Error('Code graph vector retirement schema is incompatible.'));
      }
      const statement = codeGraphVectorRetirementMarkerPageStatement(input);
      const rows = yield* sql.unsafe<{readonly generation: unknown; readonly retirement_id: unknown}>(
        statement.text,
        statement.parameters,
      );
      if (rows.length === 0) return undefined;
      const generation = rows[0]?.generation;
      const retirementId = rows[0]?.retirement_id;
      if (typeof generation !== 'string' || !Number.isSafeInteger(retirementId) || Number(retirementId) <= 0) {
        return yield* Effect.fail(new Error('Code graph vector retirement marker selector is invalid.'));
      }
      const marker = yield* selectVectorRetirementMarker(sql, generation);
      if (
        marker === undefined ||
        marker.retirementId !== retirementId ||
        (input.retiredByWorktreeId !== undefined &&
          (marker.retiredByWorktreeId !== input.retiredByWorktreeId || marker.snapshotId !== input.snapshotId))
      ) {
        return yield* Effect.fail(new Error('Code graph vector retirement marker authority changed.'));
      }
      return marker;
    }),
  );
});

/** @internal Existing-transaction seam used only by deterministic schema-race tests. */
export const admitOneCodeGraphVectorRetirement = Effect.fn('codeGraph.admitVectorRetirement')(function* (
  sql: SqlClient.SqlClient,
) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* Effect.fail(new Error('Code graph vector retirement schema is incompatible.'));
      }
      const observed = yield* observeVectorRetirementAdmission(sql);
      return yield* applyVectorRetirementAdmissionObservation(sql, observed);
    }),
  );
});

interface ExpectedVectorIndexColumn {
  readonly cid: number;
  readonly coll: 'BINARY';
  readonly desc: 0;
  readonly key: 0 | 1;
  readonly name: string | null;
}

interface ExpectedVectorIndex {
  readonly columns: readonly ExpectedVectorIndexColumn[];
  readonly name: string;
  readonly origin: 'c' | 'pk' | 'u';
  readonly partial: 0 | 1;
  readonly unique: 0 | 1;
}

interface ExpectedVectorForeignKey {
  readonly from: string;
  readonly id: number;
  readonly match: 'NONE';
  readonly onDelete: 'CASCADE' | 'NO ACTION';
  readonly onUpdate: 'NO ACTION';
  readonly seq: number;
  readonly table: string;
  readonly to: string;
}

const rowIdPayload = {cid: -1, coll: 'BINARY', desc: 0, key: 0, name: null} as const;

const VECTOR_GENERATION_INDEXES = [
  {
    columns: [{cid: 0, coll: 'BINARY', desc: 0, key: 1, name: 'generation'}, rowIdPayload],
    name: 'sqlite_autoindex_vector_generations_1',
    origin: 'pk',
    partial: 0,
    unique: 1,
  },
] as const satisfies readonly ExpectedVectorIndex[];

const VECTOR_POINTER_PRIMARY_INDEX = {
  columns: [{cid: 0, coll: 'BINARY', desc: 0, key: 1, name: 'worktree_id'}, rowIdPayload],
  name: 'sqlite_autoindex_vector_pointers_1',
  origin: 'pk',
  partial: 0,
  unique: 1,
} as const satisfies ExpectedVectorIndex;

const VECTOR_POINTER_INDEXES_WITHOUT_GENERATION = [VECTOR_POINTER_PRIMARY_INDEX] as const;
const VECTOR_POINTER_INDEXES = [
  VECTOR_POINTER_PRIMARY_INDEX,
  {
    columns: [{cid: 1, coll: 'BINARY', desc: 0, key: 1, name: 'generation'}, rowIdPayload],
    name: 'vector_pointer_generation_lookup',
    origin: 'c',
    partial: 0,
    unique: 0,
  },
] as const satisfies readonly ExpectedVectorIndex[];

const VECTOR_ROW_INDEXES = [
  {
    columns: [
      {cid: 0, coll: 'BINARY', desc: 0, key: 1, name: 'generation'},
      {cid: 1, coll: 'BINARY', desc: 0, key: 1, name: 'symbol_id'},
      {cid: 2, coll: 'BINARY', desc: 0, key: 0, name: 'fingerprint'},
      {cid: 3, coll: 'BINARY', desc: 0, key: 0, name: 'vector'},
    ],
    name: 'sqlite_autoindex_vectors_1',
    origin: 'pk',
    partial: 0,
    unique: 1,
  },
  {
    columns: [
      {cid: 0, coll: 'BINARY', desc: 0, key: 1, name: 'generation'},
      {cid: 1, coll: 'BINARY', desc: 0, key: 1, name: 'symbol_id'},
      {cid: 2, coll: 'BINARY', desc: 0, key: 1, name: 'fingerprint'},
    ],
    name: 'vector_reuse_lookup',
    origin: 'c',
    partial: 0,
    unique: 0,
  },
] as const satisfies readonly ExpectedVectorIndex[];

const VECTOR_RETIREMENT_STATE_INDEXES = [
  {
    columns: [
      {cid: 0, coll: 'BINARY', desc: 0, key: 1, name: 'singleton'},
      {cid: 1, coll: 'BINARY', desc: 0, key: 0, name: 'admission_cursor'},
      {cid: 2, coll: 'BINARY', desc: 0, key: 0, name: 'generation_revision'},
      {cid: 3, coll: 'BINARY', desc: 0, key: 0, name: 'admission_scan_revision'},
      {cid: 4, coll: 'BINARY', desc: 0, key: 0, name: 'clean_generation_revision'},
      {cid: 5, coll: 'BINARY', desc: 0, key: 0, name: 'pointer_delete_worktree_id'},
      {cid: 6, coll: 'BINARY', desc: 0, key: 0, name: 'pointer_delete_generation'},
      {cid: 7, coll: 'BINARY', desc: 0, key: 0, name: 'pointer_delete_snapshot_id'},
    ],
    name: 'sqlite_autoindex_vector_retirement_state_1',
    origin: 'pk',
    partial: 0,
    unique: 1,
  },
] as const satisfies readonly ExpectedVectorIndex[];

const VECTOR_RETIREMENT_MARKER_INDEXES = [
  {
    columns: [{cid: 1, coll: 'BINARY', desc: 0, key: 1, name: 'generation'}, rowIdPayload],
    name: 'sqlite_autoindex_vector_generation_retirements_1',
    origin: 'u',
    partial: 0,
    unique: 1,
  },
  {
    columns: [
      {cid: 3, coll: 'BINARY', desc: 0, key: 1, name: 'retired_by_worktree_id'},
      {cid: 2, coll: 'BINARY', desc: 0, key: 1, name: 'snapshot_id'},
      {cid: 1, coll: 'BINARY', desc: 0, key: 1, name: 'generation'},
      {cid: 0, coll: 'BINARY', desc: 0, key: 1, name: 'retirement_id'},
      rowIdPayload,
    ],
    name: 'vector_generation_retirement_association',
    origin: 'c',
    partial: 1,
    unique: 0,
  },
] as const satisfies readonly ExpectedVectorIndex[];

const VECTOR_POINTER_FOREIGN_KEYS = [
  {
    from: 'generation',
    id: 0,
    match: 'NONE',
    onDelete: 'CASCADE',
    onUpdate: 'NO ACTION',
    seq: 0,
    table: 'vector_generations',
    to: 'generation',
  },
] as const satisfies readonly ExpectedVectorForeignKey[];

const VECTOR_ROW_FOREIGN_KEYS = VECTOR_POINTER_FOREIGN_KEYS;

const boundedVectorUserTableNames = Effect.fn('codeGraph.boundedVectorUserTableNames')(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql.unsafe<{readonly name: unknown}>(
    `SELECT CASE
       WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 128 THEN name ELSE NULL
     END AS name
     FROM sqlite_master
     WHERE type = 'table' AND name NOT GLOB 'sqlite_*'
     LIMIT ?`,
    [VECTOR_CORE_TABLE_NAMES.length + VECTOR_RETIREMENT_TABLE_NAMES.length + 1],
  );
  if (rows.some(row => typeof row.name !== 'string')) return undefined;
  return rows.map(row => String(row.name));
});

function sameStringSet(observed: readonly string[] | undefined, expected: readonly string[]): boolean {
  return (
    observed !== undefined &&
    observed.length === expected.length &&
    [...observed].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

const exactVectorIndexSet = Effect.fn('codeGraph.exactVectorIndexSet')(function* (
  sql: SqlClient.SqlClient,
  tableName: string,
  expected: readonly ExpectedVectorIndex[],
) {
  const rows = yield* sql.unsafe<{
    readonly name: unknown;
    readonly origin: unknown;
    readonly partial: unknown;
    readonly unique_value: unknown;
  }>(
    `SELECT
       CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 128 THEN name ELSE NULL END AS name,
       CASE WHEN origin IN ('c', 'pk', 'u') THEN origin ELSE NULL END AS origin,
       partial,
       "unique" AS unique_value
     FROM pragma_index_list(${sqliteStringLiteral(tableName)})
     LIMIT ?`,
    [expected.length + 1],
  );
  if (rows.length !== expected.length) return false;
  const byName = [...expected].sort((left, right) => left.name.localeCompare(right.name));
  const observed = [...rows].sort((left, right) => String(left.name).localeCompare(String(right.name)));
  for (let index = 0; index < byName.length; index += 1) {
    const definition = byName[index]!;
    const row = observed[index];
    if (
      row?.name !== definition.name ||
      row.origin !== definition.origin ||
      row.partial !== definition.partial ||
      row.unique_value !== definition.unique
    ) {
      return false;
    }
    const columns = yield* sql.unsafe<{
      readonly cid: unknown;
      readonly coll: unknown;
      readonly desc_value: unknown;
      readonly key_value: unknown;
      readonly name: unknown;
      readonly seqno: unknown;
    }>(
      `SELECT seqno, cid,
              CASE WHEN name IS NULL THEN NULL
                   WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 128 THEN name
                   ELSE 0 END AS name,
              "desc" AS desc_value,
              CASE WHEN coll = 'BINARY' THEN coll ELSE NULL END AS coll,
              "key" AS key_value
       FROM pragma_index_xinfo(${sqliteStringLiteral(definition.name)})
       LIMIT ?`,
      [definition.columns.length + 1],
    );
    if (
      columns.length !== definition.columns.length ||
      columns.some((column, columnIndex) => {
        const expectedColumn = definition.columns[columnIndex];
        return (
          column.seqno !== columnIndex ||
          column.cid !== expectedColumn?.cid ||
          column.name !== expectedColumn.name ||
          column.desc_value !== expectedColumn.desc ||
          column.coll !== expectedColumn.coll ||
          column.key_value !== expectedColumn.key
        );
      })
    ) {
      return false;
    }
  }
  return true;
});

const exactVectorForeignKeys = Effect.fn('codeGraph.exactVectorForeignKeys')(function* (
  sql: SqlClient.SqlClient,
  tableName: string,
  expected: readonly ExpectedVectorForeignKey[],
) {
  const rows = yield* sql.unsafe<{
    readonly from_column: unknown;
    readonly id: unknown;
    readonly match_value: unknown;
    readonly on_delete: unknown;
    readonly on_update: unknown;
    readonly seq: unknown;
    readonly table_name: unknown;
    readonly to_column: unknown;
  }>(
    `SELECT id, seq,
            CASE WHEN typeof("table") = 'text' AND length(CAST("table" AS BLOB)) <= 128
                 THEN "table" ELSE NULL END AS table_name,
            CASE WHEN typeof("from") = 'text' AND length(CAST("from" AS BLOB)) <= 128
                 THEN "from" ELSE NULL END AS from_column,
            CASE WHEN typeof("to") = 'text' AND length(CAST("to" AS BLOB)) <= 128
                 THEN "to" ELSE NULL END AS to_column,
            on_update, on_delete, "match" AS match_value
     FROM pragma_foreign_key_list(${sqliteStringLiteral(tableName)})
     LIMIT ?`,
    [expected.length + 1],
  );
  return (
    rows.length === expected.length &&
    rows.every((row, index) => {
      const definition = expected[index];
      return (
        row.id === definition?.id &&
        row.seq === definition.seq &&
        row.table_name === definition.table &&
        row.from_column === definition.from &&
        row.to_column === definition.to &&
        row.on_update === definition.onUpdate &&
        row.on_delete === definition.onDelete &&
        row.match_value === definition.match
      );
    })
  );
});

const codeGraphVectorCoreSchemaState = Effect.fn('codeGraph.vectorCoreSchemaState')(function* (
  sql: SqlClient.SqlClient,
) {
  const expected = [
    {name: 'vector_generations', sql: CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL, type: 'table'},
    {name: 'vector_pointers', sql: CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL, type: 'table'},
    {name: 'vectors', sql: CODE_GRAPH_VECTORS_TABLE_SQL, type: 'table'},
    {name: 'vector_reuse_lookup', sql: CODE_GRAPH_VECTOR_REUSE_INDEX_SQL, type: 'index'},
  ] as const;
  for (const object of expected) {
    const rows = yield* boundedSchemaObjects(sql, object.name, 2);
    if (
      rows.length !== 1 ||
      rows[0]?.name !== object.name ||
      rows[0]?.type !== object.type ||
      normalizeSchemaDefinition(String(rows[0]?.sql ?? '')) !== normalizeSchemaDefinition(object.sql)
    ) {
      return 'incompatible' as const;
    }
  }
  const userTables = yield* boundedVectorUserTableNames(sql);
  const allowedTables = new Set<string>([...VECTOR_CORE_TABLE_NAMES, ...VECTOR_RETIREMENT_TABLE_NAMES]);
  if (
    userTables === undefined ||
    VECTOR_CORE_TABLE_NAMES.some(name => !userTables.includes(name)) ||
    userTables.some(name => !allowedTables.has(name))
  ) {
    return 'incompatible' as const;
  }
  if (
    !(yield* exactVectorIndexSet(sql, 'vector_generations', VECTOR_GENERATION_INDEXES)) ||
    !(yield* exactVectorIndexSet(sql, 'vectors', VECTOR_ROW_INDEXES)) ||
    !(yield* exactVectorForeignKeys(sql, 'vector_generations', [])) ||
    !(yield* exactVectorForeignKeys(sql, 'vector_pointers', VECTOR_POINTER_FOREIGN_KEYS)) ||
    !(yield* exactVectorForeignKeys(sql, 'vectors', VECTOR_ROW_FOREIGN_KEYS))
  ) {
    return 'incompatible' as const;
  }
  const pointerIndexesReady = yield* exactVectorIndexSet(sql, 'vector_pointers', VECTOR_POINTER_INDEXES);
  const pointerIndexesLegacy = yield* exactVectorIndexSet(
    sql,
    'vector_pointers',
    VECTOR_POINTER_INDEXES_WITHOUT_GENERATION,
  );
  if (!pointerIndexesReady && !pointerIndexesLegacy) return 'incompatible' as const;
  const pointerIndex = yield* boundedSchemaObjects(sql, 'vector_pointer_generation_lookup', 2);
  if (pointerIndex.length === 0) {
    return pointerIndexesLegacy ? ('missing-pointer-index' as const) : ('incompatible' as const);
  }
  if (
    pointerIndex.length !== 1 ||
    pointerIndex[0]?.name !== 'vector_pointer_generation_lookup' ||
    pointerIndex[0]?.type !== 'index' ||
    normalizeSchemaDefinition(String(pointerIndex[0]?.sql ?? '')) !==
      normalizeSchemaDefinition(CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL)
  ) {
    return 'incompatible' as const;
  }
  return pointerIndexesReady ? ('ready' as const) : ('incompatible' as const);
});

const codeGraphVectorCoreSchemaCurrent = Effect.fn('codeGraph.vectorCoreSchemaCurrent')(function* (
  sql: SqlClient.SqlClient,
) {
  return (yield* codeGraphVectorCoreSchemaState(sql)) === 'ready';
});

const inspectLegacyPointerIndexPlan = Effect.fn('codeGraph.inspectLegacyVectorPointerIndexPlan')(function* (
  sql: SqlClient.SqlClient,
) {
  const statement = codeGraphVectorRetirementLegacyPointerProbeStatement();
  const observed = yield* sql.unsafe<{
    readonly generation: unknown;
    readonly identity_bytes: unknown;
    readonly worktree_id: unknown;
  }>(statement.text, statement.parameters);
  if (observed.length > CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_ROWS) {
    return yield* Effect.fail(new Error('Code graph vector pointer index exceeds its bounded migration limit.'));
  }
  let finalFactBytes = 0;
  const rows: Array<{readonly generation: string; readonly worktreeId: string}> = [];
  for (const row of observed) {
    if (
      typeof row.worktree_id !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.worktree_id) ||
      typeof row.generation !== 'string' ||
      !validBoundedText(row.generation, VECTOR_GENERATION_BYTES) ||
      !Number.isSafeInteger(row.identity_bytes) ||
      Number(row.identity_bytes) <= 64
    ) {
      return yield* Effect.fail(new Error('Code graph vector pointer index manifest is invalid.'));
    }
    finalFactBytes += Number(row.identity_bytes);
    if (!Number.isSafeInteger(finalFactBytes) || finalFactBytes > CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_BYTES) {
      return yield* Effect.fail(new Error('Code graph vector pointer index exceeds its bounded byte limit.'));
    }
    rows.push({generation: row.generation, worktreeId: row.worktree_id});
  }
  return {finalFactBytes, rows, storage: yield* inspectVectorPageStorageSql(sql)} satisfies LegacyPointerIndexPlan;
});

function sameLegacyPointerIndexPlan(left: LegacyPointerIndexPlan, right: LegacyPointerIndexPlan): boolean {
  return (
    left.finalFactBytes === right.finalFactBytes &&
    sameVectorPageStorage(left.storage, right.storage) &&
    left.rows.length === right.rows.length &&
    left.rows.every(
      (row, index) =>
        row.worktreeId === right.rows[index]?.worktreeId && row.generation === right.rows[index]?.generation,
    )
  );
}

const codeGraphVectorRetirementSchemaState = Effect.fn('codeGraph.vectorRetirementSchemaState')(function* (
  sql: SqlClient.SqlClient,
) {
  const expected = [
    {name: 'vector_retirement_state', sql: CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL, type: 'table'},
    {name: 'vector_generation_retirements', sql: CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL, type: 'table'},
    {
      name: 'vector_generation_retirement_association',
      sql: CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL,
      type: 'index',
    },
    ...CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS.map(trigger => ({
      name: trigger.name,
      sql: trigger.sql,
      type: 'trigger' as const,
    })),
  ];
  const observed: Array<'absent' | 'current' | 'incompatible'> = [];
  for (const object of expected) {
    const rows = yield* boundedSchemaObjects(sql, object.name, 2);
    if (rows.length === 0) {
      observed.push('absent');
      continue;
    }
    observed.push(
      rows.length === 1 &&
        rows[0]?.name === object.name &&
        rows[0]?.type === object.type &&
        normalizeSchemaDefinition(String(rows[0]?.sql ?? '')) === normalizeSchemaDefinition(object.sql)
        ? 'current'
        : 'incompatible',
    );
  }
  const triggerRows = yield* sql.unsafe<{readonly name: unknown; readonly tbl_name: unknown}>(
    `SELECT
       CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 128 THEN name ELSE NULL END AS name,
       CASE WHEN typeof(tbl_name) = 'text' AND length(CAST(tbl_name AS BLOB)) <= 64 THEN tbl_name ELSE NULL END AS tbl_name
     FROM sqlite_master
     WHERE type = 'trigger'
       AND tbl_name COLLATE NOCASE IN (
         'vector_retirement_state',
         'vector_generation_retirements',
         'vector_generations',
         'vector_pointers',
         'vectors'
       )
     LIMIT ?`,
    [CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS.length + 1],
  );
  if (observed.every(state => state === 'absent')) {
    const userTables = yield* boundedVectorUserTableNames(sql);
    const sequenceTable = yield* boundedSchemaObjects(sql, 'sqlite_sequence', 2);
    return triggerRows.length === 0 && sequenceTable.length === 0 && sameStringSet(userTables, VECTOR_CORE_TABLE_NAMES)
      ? ('absent' as const)
      : ('incompatible' as const);
  }
  if (!observed.every(state => state === 'current')) return 'incompatible' as const;
  const userTables = yield* boundedVectorUserTableNames(sql);
  if (
    !sameStringSet(userTables, [...VECTOR_CORE_TABLE_NAMES, ...VECTOR_RETIREMENT_TABLE_NAMES]) ||
    !(yield* exactVectorIndexSet(sql, 'vector_retirement_state', VECTOR_RETIREMENT_STATE_INDEXES)) ||
    !(yield* exactVectorIndexSet(sql, 'vector_generation_retirements', VECTOR_RETIREMENT_MARKER_INDEXES)) ||
    !(yield* exactVectorForeignKeys(sql, 'vector_retirement_state', [])) ||
    !(yield* exactVectorForeignKeys(sql, 'vector_generation_retirements', []))
  ) {
    return 'incompatible' as const;
  }
  const expectedTriggerNames = [
    ...CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS.map(
      trigger => `${trigger.name}\0${vectorRetirementTriggerTarget(trigger.name)}`,
    ),
  ].sort();
  const observedTriggerNames = triggerRows
    .map(row =>
      typeof row.name === 'string' && typeof row.tbl_name === 'string' ? `${row.name}\0${row.tbl_name}` : '',
    )
    .sort();
  if (
    observedTriggerNames.length !== expectedTriggerNames.length ||
    observedTriggerNames.some((name, index) => name !== expectedTriggerNames[index])
  ) {
    return 'incompatible' as const;
  }
  const stateRows = yield* sql.unsafe<{
    readonly admission_cursor: unknown;
    readonly admission_scan_revision: unknown;
    readonly clean_generation_revision: unknown;
    readonly generation_revision: unknown;
    readonly pointer_delete_present: unknown;
    readonly singleton: unknown;
  }>(
    `SELECT singleton,
            CASE
              WHEN admission_cursor IS NULL THEN NULL
              WHEN typeof(admission_cursor) = 'text'
               AND length(CAST(admission_cursor AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
               AND instr(admission_cursor, char(0)) = 0
              THEN admission_cursor ELSE 0
            END AS admission_cursor,
            CASE
              WHEN typeof(generation_revision) = 'integer'
               AND generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
              THEN generation_revision ELSE NULL
            END AS generation_revision,
            CASE
              WHEN admission_scan_revision IS NULL THEN NULL
              WHEN typeof(admission_scan_revision) = 'integer'
               AND admission_scan_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
              THEN admission_scan_revision ELSE -1
            END AS admission_scan_revision,
            CASE
              WHEN clean_generation_revision IS NULL THEN NULL
              WHEN typeof(clean_generation_revision) = 'integer'
               AND clean_generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
              THEN clean_generation_revision ELSE -1
            END AS clean_generation_revision,
            CASE
              WHEN pointer_delete_worktree_id IS NULL
               AND pointer_delete_generation IS NULL
               AND pointer_delete_snapshot_id IS NULL
              THEN 0 ELSE 1
            END AS pointer_delete_present
     FROM vector_retirement_state LIMIT 2`,
  );
  if (
    stateRows.length !== 1 ||
    stateRows[0]?.singleton !== 1 ||
    !Number.isSafeInteger(stateRows[0]?.generation_revision) ||
    Number(stateRows[0]?.generation_revision) < 0 ||
    (stateRows[0]?.admission_scan_revision !== null &&
      (!Number.isSafeInteger(stateRows[0]?.admission_scan_revision) ||
        Number(stateRows[0]?.admission_scan_revision) < 0 ||
        Number(stateRows[0]?.admission_scan_revision) > Number(stateRows[0]?.generation_revision))) ||
    (stateRows[0]?.clean_generation_revision !== null &&
      (!Number.isSafeInteger(stateRows[0]?.clean_generation_revision) ||
        Number(stateRows[0]?.clean_generation_revision) < 0 ||
        Number(stateRows[0]?.clean_generation_revision) > Number(stateRows[0]?.generation_revision))) ||
    (stateRows[0]?.admission_cursor === null) !== (stateRows[0]?.admission_scan_revision === null) ||
    (stateRows[0]?.admission_scan_revision !== null &&
      stateRows[0]?.clean_generation_revision !== null &&
      Number(stateRows[0]?.clean_generation_revision) > Number(stateRows[0]?.admission_scan_revision)) ||
    (stateRows[0]?.clean_generation_revision !== null &&
      Number(stateRows[0]?.clean_generation_revision) === Number(stateRows[0]?.generation_revision) &&
      (stateRows[0]?.admission_cursor !== null || stateRows[0]?.admission_scan_revision !== null)) ||
    stateRows[0]?.pointer_delete_present !== 0 ||
    (stateRows[0]?.admission_cursor !== null &&
      (typeof stateRows[0]?.admission_cursor !== 'string' ||
        !validBoundedText(stateRows[0].admission_cursor, VECTOR_GENERATION_BYTES)))
  ) {
    return 'incompatible' as const;
  }
  const sequenceRows = yield* sql.unsafe<{
    readonly name: unknown;
    readonly seq: unknown;
    readonly seq_type: unknown;
  }>(
    `SELECT
       CASE WHEN typeof(name) = 'text'
              AND name = 'vector_generation_retirements'
            THEN name ELSE NULL END AS name,
       CASE
         WHEN typeof(seq) = 'integer' AND seq BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
         THEN seq ELSE NULL
       END AS seq,
       typeof(seq) AS seq_type
     FROM sqlite_sequence
     WHERE name = 'vector_generation_retirements' COLLATE NOCASE
     LIMIT 2`,
  );
  const maximumRows = yield* sql.unsafe<{readonly maximum: unknown}>(
    `SELECT CASE
       WHEN typeof(retirement_id) = 'integer'
        AND retirement_id BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
       THEN retirement_id ELSE NULL
     END AS maximum
     FROM vector_generation_retirements
     ORDER BY retirement_id DESC
     LIMIT 1`,
  );
  const maximum = maximumRows.length === 0 ? null : maximumRows[0]?.maximum;
  if (
    sequenceRows.length !== 1 ||
    sequenceRows[0]?.name !== 'vector_generation_retirements' ||
    sequenceRows[0]?.seq_type !== 'integer' ||
    !Number.isSafeInteger(sequenceRows[0]?.seq) ||
    Number(sequenceRows[0]?.seq) < 0 ||
    (maximum !== null &&
      (!Number.isSafeInteger(maximum) || Number(maximum) <= 0 || Number(sequenceRows[0]?.seq) < Number(maximum)))
  ) {
    return 'incompatible' as const;
  }
  return 'ready' as const;
});

const selectVectorRetirementMarker = Effect.fn('codeGraph.selectVectorRetirementMarker')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
) {
  const rows = yield* sql.unsafe<{
    readonly delete_authorized: unknown;
    readonly generation: unknown;
    readonly page_revision: unknown;
    readonly retired_by_worktree_id: unknown;
    readonly retirement_id: unknown;
    readonly snapshot_id: unknown;
  }>(
    `SELECT
       CASE
         WHEN typeof(retirement_id) = 'integer'
          AND retirement_id BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
         THEN retirement_id ELSE NULL
       END AS retirement_id,
       CASE
         WHEN typeof(generation) = 'text'
          AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
          AND instr(generation, char(0)) = 0
         THEN generation ELSE NULL
       END AS generation,
       CASE
         WHEN typeof(snapshot_id) = 'text'
          AND length(CAST(snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
          AND instr(snapshot_id, char(0)) = 0
         THEN snapshot_id ELSE NULL
       END AS snapshot_id,
       CASE
         WHEN retired_by_worktree_id IS NULL THEN NULL
         WHEN typeof(retired_by_worktree_id) = 'text'
          AND length(CAST(retired_by_worktree_id AS BLOB)) = 64
          AND retired_by_worktree_id NOT GLOB '*[^0-9a-f]*'
         THEN retired_by_worktree_id ELSE 0
       END AS retired_by_worktree_id,
       CASE
         WHEN typeof(page_revision) = 'integer'
          AND page_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
         THEN page_revision ELSE NULL
       END AS page_revision,
       CASE
         WHEN typeof(delete_authorized) = 'integer' AND delete_authorized IN (0, 1)
         THEN delete_authorized ELSE NULL
       END AS delete_authorized
     FROM vector_generation_retirements
     WHERE generation = ? LIMIT 2`,
    [generation],
  );
  if (rows.length === 0) return undefined;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !Number.isSafeInteger(row?.retirement_id) ||
    Number(row?.retirement_id) <= 0 ||
    typeof row?.generation !== 'string' ||
    !validBoundedText(row.generation, VECTOR_GENERATION_BYTES) ||
    typeof row?.snapshot_id !== 'string' ||
    !validBoundedText(row.snapshot_id, VECTOR_SNAPSHOT_BYTES) ||
    (row?.retired_by_worktree_id !== null &&
      (typeof row?.retired_by_worktree_id !== 'string' || !/^[0-9a-f]{64}$/.test(row.retired_by_worktree_id))) ||
    !Number.isSafeInteger(row?.page_revision) ||
    Number(row?.page_revision) < 0 ||
    (row?.delete_authorized !== 0 && row?.delete_authorized !== 1)
  ) {
    return yield* Effect.fail(new Error('Code graph vector retirement marker is invalid.'));
  }
  return {
    deleteAuthorized: row.delete_authorized === 1,
    generation: row.generation,
    pageRevision: Number(row.page_revision),
    ...(typeof row.retired_by_worktree_id === 'string' ? {retiredByWorktreeId: row.retired_by_worktree_id} : {}),
    retirementId: Number(row.retirement_id),
    snapshotId: row.snapshot_id,
  } satisfies CodeGraphVectorRetirementMarker;
});

export const selectCodeGraphVectorRetirementMarker = selectVectorRetirementMarker;

function useExistingVectorDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    effect.pipe(
      Effect.provide(
        SqliteClient.layer({
          create: false,
          disableWAL: true,
          filename: databasePath,
          readwrite: true,
        }),
      ),
    ),
  ) as Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>>;
}

function vectorRetirementTriggerTarget(
  name: (typeof CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS)[number]['name'],
): string {
  if (name.includes('_marker_')) return 'vector_generation_retirements';
  if (name.includes('_pointer_')) return 'vector_pointers';
  if (name.includes('_generation_')) return 'vector_generations';
  return 'vectors';
}

function useReadOnlyVectorDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    effect.pipe(
      Effect.provide(
        SqliteClient.layer({
          create: false,
          disableWAL: true,
          filename: databasePath,
          readonly: true,
          readwrite: false,
        }),
      ),
    ),
  ) as Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>>;
}

/** @internal Read-only frozen pager tuple for a separately protected cursor publication. */
export const inspectCodeGraphVectorPageStorage = Effect.fn('codeGraph.inspectVectorPageStorage')(function* (
  databasePath: string,
) {
  return yield* useReadOnlyVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* inspectVectorPageStorageSql(sql);
    }),
  );
});

const inspectVectorPageStorageSql = Effect.fn('codeGraph.inspectVectorPageStorageSql')(function* (
  sql: SqlClient.SqlClient,
) {
  const [pageSizeRows, freelistRows, walRows, journalRows] = yield* Effect.all(
    [
      sql.unsafe<{readonly page_size: unknown}>('PRAGMA page_size'),
      sql.unsafe<{readonly freelist_count: unknown}>('PRAGMA freelist_count'),
      sql.unsafe<{readonly wal_autocheckpoint: unknown}>('PRAGMA wal_autocheckpoint'),
      sql.unsafe<{readonly journal_mode: unknown}>('PRAGMA journal_mode'),
    ] as const,
    {concurrency: 1},
  );
  const pageSize = pageSizeRows[0]?.page_size;
  const freelistPages = freelistRows[0]?.freelist_count;
  const walAutoCheckpointPages = walRows[0]?.wal_autocheckpoint;
  const journalMode = journalRows[0]?.journal_mode;
  if (
    !Number.isSafeInteger(pageSize) ||
    Number(pageSize) <= 0 ||
    !Number.isSafeInteger(freelistPages) ||
    Number(freelistPages) < 0 ||
    !Number.isSafeInteger(walAutoCheckpointPages) ||
    Number(walAutoCheckpointPages) <= 0 ||
    (journalMode !== 'delete' && journalMode !== 'wal')
  ) {
    return yield* Effect.fail(new Error('Code graph vector page storage is invalid.'));
  }
  const freelistBytes = Number(pageSize) * Number(freelistPages);
  if (!Number.isSafeInteger(freelistBytes)) {
    return yield* Effect.fail(new Error('Code graph vector page storage is invalid.'));
  }
  return {
    freelistBytes,
    journalMode,
    pageSize: Number(pageSize),
    walAutoCheckpointPages: Number(walAutoCheckpointPages),
  } as const satisfies CodeGraphVectorPageStorage;
});

function sameVectorPageStorage(left: CodeGraphVectorPageStorage, right: CodeGraphVectorPageStorage): boolean {
  return (
    left.freelistBytes === right.freelistBytes &&
    left.pageSize === right.pageSize &&
    left.walAutoCheckpointPages === right.walAutoCheckpointPages &&
    left.journalMode === right.journalMode
  );
}

function vectorRetirementPageAuthorityBytes(marker: CodeGraphVectorRetirementMarker): number {
  return (
    new TextEncoder().encode(marker.generation).byteLength +
    new TextEncoder().encode(marker.snapshotId).byteLength +
    (marker.retiredByWorktreeId === undefined ? 0 : 64) +
    256
  );
}

function boundedRetirementLimit(requestedLimit: number): number {
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error('Code graph vector retirement page limit is invalid.');
  }
  return Math.min(requestedLimit, CODE_GRAPH_VECTOR_RETIREMENT_PAGE_ROWS);
}

function validBoundedText(value: string, maximumBytes: number): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

const boundedSchemaObjects = Effect.fn('codeGraph.boundedVectorSchemaObjects')(function* (
  sql: SqlClient.SqlClient,
  name: string,
  limit: number,
) {
  return yield* sql.unsafe<{
    readonly name: unknown;
    readonly sql: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, type,
            CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= ? THEN sql ELSE NULL END AS sql
     FROM sqlite_master
     WHERE name = ? COLLATE NOCASE
     LIMIT ?`,
    [VECTOR_RETIREMENT_TRIGGER_SQL_BYTES, name, limit],
  );
});

function normalizeSchemaDefinition(value: string): string {
  const quoted: string[] = [];
  let unquoted = '';
  for (let index = 0; index < value.length; index += 1) {
    const opener = value[index]!;
    const closer = opener === '[' ? ']' : opener;
    if (opener !== "'" && opener !== '"' && opener !== '`' && opener !== '[') {
      unquoted += opener;
      continue;
    }
    const start = index;
    for (index += 1; index < value.length; index += 1) {
      if (value[index] !== closer) continue;
      if (closer !== ']' && value[index + 1] === closer) {
        index += 1;
        continue;
      }
      break;
    }
    quoted.push(value.slice(start, Math.min(index + 1, value.length)));
    unquoted += `\u0000${quoted.length - 1}\u0000`;
  }
  return unquoted
    .toLowerCase()
    .replace(/\bif not exists\b/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),])\s*/gu, '$1')
    .trim()
    .split('\u0000')
    .map((segment, index) => (index % 2 === 1 ? (quoted[Number(segment)] ?? '') : segment))
    .join('');
}

function storedSchemaSql(value: string): string {
  return value.replace(/^CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS/u, 'CREATE $1');
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const lastStatementChangeCount = Effect.fn('codeGraph.vectorRetirementChangeCount')(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql.unsafe<{readonly count: unknown}>('SELECT changes() AS count');
  const count = rows[0]?.count;
  if (!Number.isSafeInteger(count) || Number(count) < 0) {
    return yield* Effect.fail(new Error('Code graph vector retirement change count is invalid.'));
  }
  return Number(count);
});
