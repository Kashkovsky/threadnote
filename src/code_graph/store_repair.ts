import {Clock, Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {type CodeGraphDatabaseRepair} from './store_models.js';
import {CodeGraphStoreError} from './types.js';
import {diagnoseDatabase} from './store_diagnostics.js';
import {pruneRetiredSnapshotRows} from './store_retirement.js';
import {pruneUnreferencedFileBlobs} from './store_cleanup_core.js';

/** Exact read-only admission shared by cleanup writers and both health paths. */

const repairDatabase = Effect.fn('codeGraph.repairDatabase')(function* (dryRun: boolean) {
  const sql = yield* SqlClient.SqlClient;
  const health = yield* diagnoseDatabase();
  if (health.integrity !== 'ok') {
    return yield* Effect.fail(
      new CodeGraphStoreError(`Code graph database is ${health.integrity}; discard and rebuild it.`),
    );
  }
  const now = yield* Clock.currentTimeMillis;
  if (dryRun) {
    const candidates = yield* sql<{readonly count: number}>`
      SELECT COUNT(*) AS count
      FROM snapshots AS snapshot
      WHERE snapshot.state IN ('building', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_leases AS lease
          WHERE lease.snapshot_id = snapshot.id AND lease.expires_at > ${now}
        )
    `;
    return {removedSnapshots: Number(candidates[0]?.count ?? 0)} satisfies CodeGraphDatabaseRepair;
  }
  const candidates = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM snapshots AS snapshot
    WHERE snapshot.state IN ('building', 'failed')
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_leases AS lease
        WHERE lease.snapshot_id = snapshot.id AND lease.expires_at > ${now}
      )
  `;
  const removedSnapshots = Number(candidates[0]?.count ?? 0);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // Reuse the bounded retired-snapshot collector. A direct full build can
      // own tens of millions of rows, so cascading it from one repair DELETE
      // would recreate the same long heartbeat gap that direct staging avoids.
      yield* sql`
        UPDATE snapshots
        SET state = 'retired'
        WHERE state IN ('building', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_leases AS lease
            WHERE lease.snapshot_id = snapshots.id AND lease.expires_at > ${now}
          )
      `;
    }),
  );
  yield* pruneRetiredSnapshotRows();
  yield* sql.withTransaction(pruneUnreferencedFileBlobs(sql));
  return {removedSnapshots} satisfies CodeGraphDatabaseRepair;
});

export {repairDatabase};
