import type {CodeGraphStoreShape} from '@threadnote/graph/store';
import type {CodeGraphSnapshot, RepositoryIdentity} from '@threadnote/graph/types';

/** Current-runtime owner evidence for store-focused tests without a status reporter. */
export function claimPersistentBuildForTest(
  store: CodeGraphStoreShape,
  databasePath: string,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
) {
  return store.claimPersistentBuild(databasePath, identity, snapshot, {
    logicalSnapshotId: `cgsn_${'0'.repeat(40)}`,
    owner: {
      buildId: '00000000-0000-0000',
      processId: process.pid,
    },
  });
}
