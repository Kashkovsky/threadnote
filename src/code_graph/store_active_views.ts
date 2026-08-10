import {Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {type CodeGraphActiveViewIdentity} from './store_models.js';
import {configureConnection, tableExists} from './store_session.js';

const ACTIVE_VIEW_IDENTITY_LIMIT_MAXIMUM = 64;

/** Cheap bounded pointer read for Manager's cross-process catalog revision. */
export const selectActiveViewIdentities = Effect.fn('codeGraph.selectActiveViewIdentities')(function* (limit: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(ACTIVE_VIEW_IDENTITY_LIMIT_MAXIMUM, limit))
    : ACTIVE_VIEW_IDENTITY_LIMIT_MAXIMUM;
  const removedViewsAvailable = yield* tableExists(sql, 'removed_views');
  const rows = yield* sql.unsafe<{
    readonly activated_at: string | null;
    readonly repository_id: string;
    readonly snapshot_id: string;
    readonly worktree_id: string;
  }>(
    `SELECT active_snapshots.activated_at, active_snapshots.snapshot_id,
       active_snapshots.worktree_id, snapshots.repository_id
     FROM active_snapshots
     JOIN snapshots ON snapshots.id = active_snapshots.snapshot_id
     WHERE snapshots.state = 'ready'
       ${
         removedViewsAvailable
           ? `AND NOT EXISTS (
                SELECT 1 FROM removed_views AS removed
                WHERE removed.worktree_id = active_snapshots.worktree_id
                  AND removed.expected_snapshot_id = active_snapshots.snapshot_id
              )`
           : ''
       }
     ORDER BY active_snapshots.activated_at DESC, active_snapshots.worktree_id
     LIMIT ?`,
    [boundedLimit],
  );
  return rows.map(
    row =>
      ({
        ...(typeof row.activated_at === 'string' ? {activatedAt: row.activated_at} : {}),
        repositoryId: row.repository_id,
        snapshotId: row.snapshot_id,
        worktreeId: row.worktree_id,
      }) satisfies CodeGraphActiveViewIdentity,
  );
});
