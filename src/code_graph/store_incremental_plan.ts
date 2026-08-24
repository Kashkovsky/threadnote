import {type CodeGraphSqlQueryStatement} from './store_visualization_sql.js';

/** @internal Changed paths must drive every persistent base-table probe. */
export function persistedIncrementalChangedFilesStatement(baseSnapshotId: string): CodeGraphSqlQueryStatement {
  return {
    parameters: [baseSnapshotId],
    text: `SELECT
      (SELECT COUNT(*) FROM activation_incremental_paths) AS expected,
      (
        SELECT COUNT(*)
        FROM activation_incremental_paths AS changed
        CROSS JOIN activation_files AS current ON current.path = changed.path
        CROSS JOIN snapshot_files AS base
          ON base.snapshot_id = ? AND base.path = current.path
      ) AS present`,
  };
}

/** @internal Changed paths must drive every persistent base-table probe. */
export function persistedIncrementalBaseSymbolsStatement(
  baseSnapshotId: string,
  rowLimit: number,
): CodeGraphSqlQueryStatement {
  return {
    parameters: [baseSnapshotId, rowLimit],
    text: `SELECT
      base.arity, base.exported, base.id, base.kind, base.language, base.lookup_keys_json, base.name,
      base.package_name, base.path, base.qualified_name, base.resolution_domain, base.resolution_scope_id
    FROM activation_files AS changed
    CROSS JOIN symbols AS base INDEXED BY symbols_path
      ON base.snapshot_id = ? AND base.path = changed.path
    ORDER BY base.id
    LIMIT ?`,
  };
}

/** @internal Changed paths must drive every persistent base-table probe. */
export function persistedIncrementalReexportMismatchStatement(baseSnapshotId: string): CodeGraphSqlQueryStatement {
  return {
    parameters: [baseSnapshotId, baseSnapshotId],
    text: `SELECT (
      EXISTS (
        SELECT source_path, local_name, target_path, imported_name
        FROM activation_reexport_provenance
        EXCEPT
        SELECT base.source_path, base.local_name, base.target_path, base.imported_name
        FROM activation_files AS changed
        CROSS JOIN snapshot_reexport_provenance AS base
          ON base.snapshot_id = ? AND base.source_path = changed.path
      )
      OR EXISTS (
        SELECT base.source_path, base.local_name, base.target_path, base.imported_name
        FROM activation_files AS changed
        CROSS JOIN snapshot_reexport_provenance AS base
          ON base.snapshot_id = ? AND base.source_path = changed.path
        EXCEPT
        SELECT source_path, local_name, target_path, imported_name
        FROM activation_reexport_provenance
      )
    ) AS mismatch`,
  };
}

/** @internal Changed paths must drive every persistent base-table probe. */
export function persistedIncrementalFactCountsStatement(baseSnapshotId: string): CodeGraphSqlQueryStatement {
  return {
    parameters: [baseSnapshotId],
    text: `SELECT
      base.file_count
        - (
            SELECT COUNT(*)
            FROM activation_incremental_paths AS changed
            CROSS JOIN snapshot_files AS file
              ON file.snapshot_id = base.id AND file.path = changed.path
          )
        + (SELECT COUNT(*) FROM activation_files) AS files,
      base.symbol_count
        - (
            SELECT COUNT(*)
            FROM activation_incremental_paths AS changed
            CROSS JOIN symbols AS symbol INDEXED BY symbols_path
              ON symbol.snapshot_id = base.id AND symbol.path = changed.path
          )
        + (SELECT COUNT(*) FROM activation_symbols) AS symbols,
      base.edge_count
        - (
            SELECT COUNT(*)
            FROM activation_incremental_paths AS changed
            CROSS JOIN edges AS edge INDEXED BY edges_evidence_path
              ON edge.snapshot_id = base.id AND edge.evidence_path = changed.path
          )
        + (SELECT COUNT(*) FROM activation_edges) AS edges
    FROM snapshots AS base
    WHERE base.id = ? AND base.state = 'ready'
      AND base.base_snapshot_id IS NULL
    LIMIT 1`,
  };
}

/** @internal Changed paths must drive every persistent base-table probe. */
export function persistedIncrementalFileDeletionsStatement(
  snapshotId: string,
  baseSnapshotId: string,
): CodeGraphSqlQueryStatement {
  return {
    parameters: [snapshotId, baseSnapshotId],
    text: `INSERT INTO snapshot_file_deletions (snapshot_id, path)
      SELECT ?, base.path
      FROM activation_incremental_paths AS changed
      CROSS JOIN snapshot_files AS base
        ON base.snapshot_id = ? AND base.path = changed.path
      WHERE NOT EXISTS (
        SELECT 1 FROM activation_files AS current WHERE current.path = base.path
      )`,
  };
}

/** @internal Changed paths must drive every persistent base-table probe. */
export function persistedIncrementalSymbolDeletionsStatement(
  snapshotId: string,
  baseSnapshotId: string,
): CodeGraphSqlQueryStatement {
  return {
    parameters: [snapshotId, baseSnapshotId],
    text: `INSERT INTO snapshot_symbol_deletions (snapshot_id, symbol_id)
      SELECT ?, base.id
      FROM activation_incremental_paths AS changed
      CROSS JOIN symbols AS base INDEXED BY symbols_path
        ON base.snapshot_id = ? AND base.path = changed.path
      WHERE NOT EXISTS (
        SELECT 1 FROM activation_symbols AS current WHERE current.id = base.id
      )`,
  };
}

/** @internal Changed paths must drive every persistent base-table probe. */
export function persistedIncrementalEdgeDeletionsStatement(
  snapshotId: string,
  baseSnapshotId: string,
): CodeGraphSqlQueryStatement {
  return {
    parameters: [snapshotId, baseSnapshotId],
    text: `INSERT INTO snapshot_edge_deletions (snapshot_id, edge_id)
      SELECT ?, base.id
      FROM activation_incremental_paths AS changed
      CROSS JOIN edges AS base INDEXED BY edges_evidence_path
        ON base.snapshot_id = ? AND base.evidence_path = changed.path
      WHERE NOT EXISTS (
        SELECT 1 FROM activation_edges AS current WHERE current.id = base.id
      )`,
  };
}
