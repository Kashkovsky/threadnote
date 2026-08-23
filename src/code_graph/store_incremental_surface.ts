import {Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM} from './fact_budget.js';
import {hasSameCodeGraphResolutionSurface, type CodeGraphResolutionSurfaceSymbol} from './resolution_surface.js';

interface PersistedIncrementalSurfaceSymbolRow {
  readonly arity: unknown;
  readonly exported: unknown;
  readonly id: unknown;
  readonly kind: unknown;
  readonly language: unknown;
  readonly lookup_keys_json: unknown;
  readonly name: unknown;
  readonly package_name: unknown;
  readonly path: unknown;
  readonly qualified_name: unknown;
  readonly resolution_domain: unknown;
  readonly resolution_scope_id: unknown;
}

// One changed-file overlay is admitted only when its complete attributed facts
// fit the 8 MiB transaction ceiling. Sixty-four bytes is deliberately below
// the JSON size of the required symbol fields, so this cap cannot reject an
// admitted overlay while keeping corrupt staging tables bounded.
const PERSISTED_INCREMENTAL_SURFACE_MAX_SYMBOL_ROWS = Math.floor(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM / 64);

const persistedIncrementalSurfaceMatches = Effect.fn('codeGraph.persistedIncrementalSurfaceMatches')(function* (
  sql: SqlClient.SqlClient,
  baseSnapshotId: string,
) {
  const changedFiles = yield* sql<{readonly expected: number; readonly present: number}>`
    SELECT
      (SELECT COUNT(*) FROM activation_incremental_paths) AS expected,
      (
        SELECT COUNT(*)
        FROM activation_incremental_paths AS changed
        JOIN activation_files AS current ON current.path = changed.path
        JOIN snapshot_files AS base
          ON base.snapshot_id = ${baseSnapshotId} AND base.path = current.path
      ) AS present
  `;
  if (Number(changedFiles[0]?.expected ?? 0) !== Number(changedFiles[0]?.present ?? -1)) return false;
  const rowLimit = PERSISTED_INCREMENTAL_SURFACE_MAX_SYMBOL_ROWS + 1;
  const currentRows = yield* sql<PersistedIncrementalSurfaceSymbolRow>`
    SELECT
      arity, exported, id, kind, language, lookup_keys_json, name,
      package_name, path, qualified_name, resolution_domain, resolution_scope_id
    FROM activation_symbols
    ORDER BY id
    LIMIT ${rowLimit}
  `;
  const baseRows = yield* sql<PersistedIncrementalSurfaceSymbolRow>`
    SELECT
      base.arity, base.exported, base.id, base.kind, base.language, base.lookup_keys_json, base.name,
      base.package_name, base.path, base.qualified_name, base.resolution_domain, base.resolution_scope_id
    FROM symbols AS base
    JOIN activation_files AS changed ON changed.path = base.path
    WHERE base.snapshot_id = ${baseSnapshotId}
    ORDER BY base.id
    LIMIT ${rowLimit}
  `;
  if (
    currentRows.length > PERSISTED_INCREMENTAL_SURFACE_MAX_SYMBOL_ROWS ||
    baseRows.length > PERSISTED_INCREMENTAL_SURFACE_MAX_SYMBOL_ROWS
  ) {
    return false;
  }
  const currentSymbols = decodePersistedIncrementalSurfaceSymbols(currentRows);
  const baseSymbols = decodePersistedIncrementalSurfaceSymbols(baseRows);
  if (
    currentSymbols === undefined ||
    baseSymbols === undefined ||
    !hasSameCodeGraphResolutionSurface(baseSymbols, currentSymbols)
  ) {
    return false;
  }
  // Sparse raw-fact attribution can be more conservative than the original
  // full batch. Require exact changed-path re-export publication in SQLite so
  // an optimistic preassessment falls closed before persisted-delta reuse.
  const reexportMismatch = yield* sql<{readonly mismatch: number}>`
    SELECT (
      EXISTS (
        SELECT source_path, local_name, target_path, imported_name
        FROM activation_reexport_provenance
        EXCEPT
        SELECT base.source_path, base.local_name, base.target_path, base.imported_name
        FROM snapshot_reexport_provenance AS base
        JOIN activation_files AS changed ON changed.path = base.source_path
        WHERE base.snapshot_id = ${baseSnapshotId}
      )
      OR EXISTS (
        SELECT base.source_path, base.local_name, base.target_path, base.imported_name
        FROM snapshot_reexport_provenance AS base
        JOIN activation_files AS changed ON changed.path = base.source_path
        WHERE base.snapshot_id = ${baseSnapshotId}
        EXCEPT
        SELECT source_path, local_name, target_path, imported_name
        FROM activation_reexport_provenance
      )
    ) AS mismatch
  `;
  return Number(reexportMismatch[0]?.mismatch ?? 1) === 0;
});

function decodePersistedIncrementalSurfaceSymbols(
  rows: readonly PersistedIncrementalSurfaceSymbolRow[],
): readonly CodeGraphResolutionSurfaceSymbol[] | undefined {
  const symbols: CodeGraphResolutionSurfaceSymbol[] = [];
  for (const row of rows) {
    const symbol = decodePersistedIncrementalSurfaceSymbol(row);
    if (symbol === undefined) return undefined;
    symbols.push(symbol);
  }
  return symbols;
}

function decodePersistedIncrementalSurfaceSymbol(
  row: PersistedIncrementalSurfaceSymbolRow,
): CodeGraphResolutionSurfaceSymbol | undefined {
  if (
    !isNonEmptyString(row.id) ||
    !isNonEmptyString(row.kind) ||
    !isNonEmptyString(row.language) ||
    !isNonEmptyString(row.name) ||
    !isNonEmptyString(row.path) ||
    !isNonEmptyString(row.qualified_name) ||
    (row.exported !== 0 && row.exported !== 1) ||
    (row.arity !== null && (typeof row.arity !== 'number' || !Number.isSafeInteger(row.arity) || row.arity < 0)) ||
    !isOptionalString(row.package_name) ||
    !isOptionalString(row.resolution_domain) ||
    !isOptionalString(row.resolution_scope_id)
  ) {
    return undefined;
  }
  const lookupKeys = decodePersistedIncrementalLookupKeys(row.lookup_keys_json);
  if (lookupKeys === undefined) return undefined;
  return {
    ...(row.arity === null ? {} : {arity: row.arity}),
    exported: row.exported === 1,
    id: row.id,
    kind: row.kind,
    language: row.language,
    lookupKeys,
    name: row.name,
    ...(row.package_name === null ? {} : {packageName: row.package_name}),
    path: row.path,
    qualifiedName: row.qualified_name,
    ...(row.resolution_domain === null ? {} : {resolutionDomain: row.resolution_domain}),
    ...(row.resolution_scope_id === null ? {} : {resolutionScopeId: row.resolution_scope_id}),
  };
}

function decodePersistedIncrementalLookupKeys(value: unknown): readonly string[] | undefined {
  if (typeof value !== 'string' || value.length > CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some(key => typeof key !== 'string' || key.length === 0 || key.length > 4_096) ||
      new Set(parsed).size !== parsed.length
    ) {
      return undefined;
    }
    return parsed as string[];
  } catch {
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is null | string {
  return value === null || typeof value === 'string';
}

export {persistedIncrementalSurfaceMatches};
