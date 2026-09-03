import {Effect, Option, Schema} from 'effect';
import {verifyIndexInput} from './indexer_materialization.js';
import {WorktreeChangedDuringIndex} from './indexer_shared.js';
import {reserveCodeGraphRetainedBase} from './retained_base_reservation.js';
import type {CodeGraphStoreShape} from './store.js';
import type {RepositoryIdentity} from './types.js';

const CODE_GRAPH_RETAINED_BASE_LEASE_MILLISECONDS = 45 * 60_000;

export const verifyCommittedIndexInput = Effect.fn('codeGraph.verifyCommittedIndexInput')(function* (input: {
  readonly databasePath: string;
  readonly identity: RepositoryIdentity;
  readonly physicalSnapshotId?: string;
  readonly requestedOverlay?: {readonly dirty: boolean; readonly fingerprint?: string};
  readonly snapshotId: string;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
}) {
  return yield* verifyIndexInput(input.identity, true, input.threadnoteHome, input.requestedOverlay).pipe(
    Effect.catchIf(
      cause => Schema.is(WorktreeChangedDuringIndex)(cause),
      cause =>
        Effect.gen(function* () {
          const lease = yield* input.store
            .acquireSnapshotLease(input.databasePath, input.snapshotId, CODE_GRAPH_RETAINED_BASE_LEASE_MILLISECONDS, {
              retainedBase: true,
            })
            .pipe(Effect.option);
          if (Option.isNone(lease)) return yield* cause;
          const reserved = yield* reserveCodeGraphRetainedBase({
            durationMilliseconds: CODE_GRAPH_RETAINED_BASE_LEASE_MILLISECONDS,
            physicalSnapshotId: input.physicalSnapshotId ?? input.snapshotId,
            threadnoteHome: input.threadnoteHome,
          }).pipe(Effect.orElseSucceed(() => false));
          if (!reserved) {
            yield* input.store.releaseSnapshotLease(input.databasePath, lease.value).pipe(Effect.ignore);
          }
          return yield* cause;
        }),
    ),
  );
});
