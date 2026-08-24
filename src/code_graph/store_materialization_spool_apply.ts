import {Effect} from 'effect';
import type * as SqlClient from 'effect/unstable/sql/SqlClient';
import {codeGraphMaterializationApplyPages} from './materialization_spool.js';
import {CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES} from './materialization_spool_surfaces.js';
import {assertPersistentBuildOwner} from './store_build_core.js';
import {CodeGraphStoreError} from './types.js';

export interface CodeGraphMaterializationSpoolSurfacePlan {
  readonly name: string;
  readonly rowCount: number;
}

export interface CodeGraphMaterializationSpoolApplyPageResult {
  readonly afterRowid?: number;
  readonly rowCount: number;
  readonly state: 'applied' | 'complete';
  readonly surfaceIndex: number;
  readonly surfaceName: string;
}

interface MaterializationSpoolSurfaceRow {
  readonly applied_row_count: number;
  readonly complete: number;
  readonly next_page_index: number;
  readonly row_count: number;
  readonly spool_identity: string;
  readonly surface_index: number;
  readonly surface_name: string;
}

export const registerCodeGraphMaterializationSpoolApply = Effect.fn('codeGraph.registerMaterializationSpoolApply')(
  function* (
    sql: SqlClient.SqlClient,
    snapshotId: string,
    ownerToken: string,
    spoolIdentity: string,
    surfaces: readonly CodeGraphMaterializationSpoolSurfacePlan[],
  ) {
    validateApplyIdentity(spoolIdentity);
    validateSurfacePlan(surfaces);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
        const existing = yield* readSurfaceRows(sql, snapshotId);
        if (existing.length > 0) {
          if (!surfaceRowsMatch(existing, spoolIdentity, surfaces)) {
            return yield* Effect.fail(
              new CodeGraphStoreError('Persistent materialization spool apply plan changed; discard and rebuild it.'),
            );
          }
          return 'resumed' as const;
        }
        yield* sql.unsafe(
          `INSERT INTO building_materialization_spool_surfaces (
           snapshot_id, surface_index, spool_identity, surface_name, row_count,
           next_page_index, applied_row_count, complete
         ) VALUES ${surfaces.map(() => '(?, ?, ?, ?, ?, 0, 0, ?)').join(', ')}`,
          surfaces.flatMap((surface, index) => [
            snapshotId,
            index,
            spoolIdentity,
            surface.name,
            surface.rowCount,
            surface.rowCount === 0 ? 1 : 0,
          ]),
        );
        return 'registered' as const;
      }),
    );
  },
);

export const applyCodeGraphMaterializationSpoolSurfacePage = Effect.fn(
  'codeGraph.applyMaterializationSpoolSurfacePage',
)(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  spoolIdentity: string,
  surfaceIndex: number,
  writePage: (page: {readonly afterRowid: number; readonly rowCount: number}) => Effect.Effect<void, unknown>,
) {
  validateApplyIdentity(spoolIdentity);
  if (
    !Number.isSafeInteger(surfaceIndex) ||
    surfaceIndex < 0 ||
    surfaceIndex >= CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent materialization spool surface index is invalid.'));
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
      const rows = yield* readSurfaceRows(sql, snapshotId);
      const expected = CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES[surfaceIndex]!;
      const current = rows[surfaceIndex];
      if (
        rows.length !== CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length ||
        current === undefined ||
        current.surface_index !== surfaceIndex ||
        current.surface_name !== expected.name ||
        current.spool_identity !== spoolIdentity ||
        rows.some(row => row.spool_identity !== spoolIdentity) ||
        rows.slice(0, surfaceIndex).some(row => row.complete !== 1)
      ) {
        return yield* Effect.fail(new CodeGraphStoreError('Persistent materialization spool apply state is invalid.'));
      }
      if (current.complete === 1) {
        return {
          rowCount: current.row_count,
          state: 'complete',
          surfaceIndex,
          surfaceName: current.surface_name,
        } satisfies CodeGraphMaterializationSpoolApplyPageResult;
      }
      const pages = codeGraphMaterializationApplyPages(current.row_count);
      const page = pages[current.next_page_index];
      if (page === undefined) {
        return yield* Effect.fail(new CodeGraphStoreError('Persistent materialization spool apply cursor is invalid.'));
      }
      yield* writePage(page).pipe(
        Effect.mapError(() => new CodeGraphStoreError('Persistent materialization spool page could not be applied.')),
      );
      const changes = yield* sql.unsafe<{readonly count: number | bigint}>('SELECT changes() AS count');
      const inserted = Number(changes[0]?.count ?? -1);
      if (inserted !== page.rowCount) {
        return yield* Effect.fail(
          new CodeGraphStoreError(
            `Persistent materialization spool page lost ${Math.max(0, page.rowCount - inserted)} row(s).`,
          ),
        );
      }
      const appliedRowCount = current.applied_row_count + inserted;
      const complete = appliedRowCount === current.row_count ? 1 : 0;
      yield* sql.unsafe(
        `UPDATE building_materialization_spool_surfaces
         SET next_page_index = next_page_index + 1,
             applied_row_count = ?,
             complete = ?
         WHERE snapshot_id = ? AND surface_index = ? AND spool_identity = ?
           AND next_page_index = ? AND applied_row_count = ? AND complete = 0`,
        [
          appliedRowCount,
          complete,
          snapshotId,
          surfaceIndex,
          spoolIdentity,
          current.next_page_index,
          current.applied_row_count,
        ],
      );
      const updates = yield* sql.unsafe<{readonly count: number | bigint}>('SELECT changes() AS count');
      if (Number(updates[0]?.count ?? 0) !== 1) {
        return yield* Effect.fail(new CodeGraphStoreError('Persistent materialization spool apply cursor changed.'));
      }
      return {
        afterRowid: page.afterRowid,
        rowCount: page.rowCount,
        state: 'applied',
        surfaceIndex,
        surfaceName: current.surface_name,
      } satisfies CodeGraphMaterializationSpoolApplyPageResult;
    }),
  );
});

export const assertCodeGraphMaterializationSpoolApplyComplete = Effect.fn(
  'codeGraph.assertMaterializationSpoolApplyComplete',
)(function* (sql: SqlClient.SqlClient, snapshotId: string, ownerToken: string, spoolIdentity: string) {
  validateApplyIdentity(spoolIdentity);
  yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
  const rows = yield* readSurfaceRows(sql, snapshotId);
  if (
    rows.length !== CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length ||
    rows.some(
      (row, index) =>
        row.surface_index !== index ||
        row.surface_name !== CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES[index]!.name ||
        row.spool_identity !== spoolIdentity ||
        row.complete !== 1 ||
        row.applied_row_count !== row.row_count,
    )
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent materialization spool apply is incomplete.'));
  }
});

function readSurfaceRows(sql: SqlClient.SqlClient, snapshotId: string) {
  return sql.unsafe<MaterializationSpoolSurfaceRow>(
    `SELECT surface_index, spool_identity, surface_name, row_count,
       next_page_index, applied_row_count, complete
     FROM building_materialization_spool_surfaces
     WHERE snapshot_id = ?
     ORDER BY surface_index`,
    [snapshotId],
  );
}

function validateApplyIdentity(spoolIdentity: string): void {
  if (!/^[0-9a-f]{64}$/u.test(spoolIdentity)) {
    throw new CodeGraphStoreError('Persistent materialization spool identity is invalid.');
  }
}

function validateSurfacePlan(surfaces: readonly CodeGraphMaterializationSpoolSurfacePlan[]): void {
  if (
    surfaces.length !== CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length ||
    surfaces.some(
      (surface, index) =>
        surface.name !== CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES[index]!.name ||
        !Number.isSafeInteger(surface.rowCount) ||
        surface.rowCount < 0,
    )
  ) {
    throw new CodeGraphStoreError('Persistent materialization spool surface plan is invalid.');
  }
}

function surfaceRowsMatch(
  rows: readonly MaterializationSpoolSurfaceRow[],
  spoolIdentity: string,
  surfaces: readonly CodeGraphMaterializationSpoolSurfacePlan[],
): boolean {
  return (
    rows.length === surfaces.length &&
    rows.every(
      (row, index) =>
        row.surface_index === index &&
        row.spool_identity === spoolIdentity &&
        row.surface_name === surfaces[index]!.name &&
        row.row_count === surfaces[index]!.rowCount &&
        Number.isSafeInteger(row.next_page_index) &&
        row.next_page_index >= 0 &&
        Number.isSafeInteger(row.applied_row_count) &&
        row.applied_row_count >= 0 &&
        row.applied_row_count <= row.row_count &&
        (row.complete === 0 || (row.complete === 1 && row.applied_row_count === row.row_count)),
    )
  );
}
