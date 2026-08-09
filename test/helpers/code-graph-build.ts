import type {CodeGraphStoreShape} from '../../src/code_graph/store.js';
import type {CodeGraphSnapshot, RepositoryIdentity} from '../../src/code_graph/types.js';

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
