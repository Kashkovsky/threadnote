import type {Database} from 'bun:sqlite';
import type {CodeGraphDirectPersistentCapacityBoundary} from '../../disk/capacity.js';
import {codeGraphSqliteAll, codeGraphSqliteGet} from '../../sqlite_statement.js';
import {CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES} from './surfaces.js';

export interface CodeGraphSpoolSortSurfaceLoad {
  readonly bytes: number;
  readonly rows: number;
}

/** Sorting commits one surface at a time, so only the largest pending surface is live. */
export function codeGraphSpoolSortCapacityBoundary(
  loads: readonly CodeGraphSpoolSortSurfaceLoad[],
): CodeGraphDirectPersistentCapacityBoundary {
  return {
    finalFactBytes: loads.reduce((largest, load) => Math.max(largest, load.bytes), 0),
    operation: 'sort persistent code graph materialization spool',
    rowCount: loads.reduce((largest, load) => Math.max(largest, load.rows), 0),
    transientFilesystem: 'temporary',
  };
}

/** Count the actual UTF-8 payload of the raw surfaces instead of every batch's facts. */
export function observeCodeGraphSpoolSortCapacity(database: Database): CodeGraphDirectPersistentCapacityBoundary {
  const pending = new Set(
    codeGraphSqliteAll<{readonly name: string}>(
      database,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'materialization_raw_%'",
    ).map(row => row.name),
  );
  const loads = CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.flatMap(surface => {
    const table = `materialization_raw_${surface.name}`;
    if (!pending.has(table)) return [];
    const payload = surface.columns.map(column => `COALESCE(LENGTH(CAST(${column} AS BLOB)), 0)`).join(' + ');
    const row = codeGraphSqliteGet<{
      readonly bytes: bigint | number;
      readonly rows: bigint | number;
    }>(database, `SELECT COALESCE(SUM(${payload}), 0) AS bytes, COUNT(*) AS rows FROM ${table}`);
    if (row === null) throw new Error('Code graph materialization spool sort capacity is unavailable.');
    return [{bytes: Number(row.bytes), rows: Number(row.rows)}];
  });
  return codeGraphSpoolSortCapacityBoundary(loads);
}
