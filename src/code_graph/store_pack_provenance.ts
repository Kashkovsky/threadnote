import {Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import type {CodeGraphLanguagePackProvenance} from './store_models.js';
import {CodeGraphStoreError} from './types.js';

export const recordSnapshotPackProvenance = Effect.fn('codeGraph.recordSnapshotPackProvenance')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  provenance: readonly CodeGraphLanguagePackProvenance[],
) {
  const ids = new Set<string>();
  for (const pack of provenance) {
    if (!pack.id || ids.has(pack.id)) {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph language-pack provenance is invalid.'));
    }
    ids.add(pack.id);
    yield* sql`
      INSERT INTO snapshot_pack_provenance (
        snapshot_id, pack_id, cache_identity, derivation_identity,
        resolution_domain, resolution_version
      ) VALUES (
        ${snapshotId}, ${pack.id}, ${pack.cacheIdentity}, ${pack.derivationIdentity},
        ${pack.resolutionDomain}, ${pack.resolutionVersion}
      )
    `;
  }
});
