import {Effect} from 'effect';
import {sha256Hex as sha256} from '@threadnote/platform/digest';

export const managerGraphViewRemovalApprovalDigest = Effect.fn('manager.graphViewRemovalApprovalDigest')(
  function* (target: {
    readonly checkoutId: string;
    readonly scopeId?: string;
    readonly snapshotId: string;
    readonly worktreeId: string;
  }) {
    return `sha256:${yield* sha256(
      JSON.stringify({
        action: 'remove-view',
        checkoutId: target.checkoutId,
        expectedSnapshotId: target.snapshotId,
        ...(target.scopeId === undefined ? {} : {scopeId: target.scopeId}),
        version: 2,
        worktreeId: target.worktreeId,
      }),
    )}`;
  },
);
