import {Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY} from './store_removed_view_schema_contracts.js';
import {
  removedViewCleanupRecordedRevision,
  removedViewCleanupSchemaState,
} from './store_removed_view_schema_inspection.js';
import {
  codeGraphPersistentExtensionSchemaCompatible,
  inspectPersistentExtensionTables,
} from './store_schema_inspection.js';
import {CodeGraphStoreError} from './types.js';
import {
  CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION,
  codeGraphPersistentSchemaIsCurrent,
  codeGraphPersistentSchemaMigrationPending,
  codeGraphPersistentSchemaSupports,
  planCodeGraphPersistentSchemaUpgrade,
} from './store/schema_revision.js';
import {
  codeGraphRemovedViewCleanupSchemaAdmission,
  codeGraphSchemaMigrationPreservesIncompleteSnapshots,
  ensureRemovedViewCleanupSchema,
  preflightRemovedViewCleanupSchema,
} from './store_schema_migration.js';
import {codeGraphWorktreeReconciliationSchemaCompatible} from './store_reconciliation.js';
import {removedViewCleanupSchemaCurrent} from './store_schema_core.js';
import {lastStatementChangeCount} from './store_activation_core.js';
import {
  CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES,
  codeGraphReconciliationIndexState,
} from './store_reconciliation_core.js';
import {initializeRoutineMaintenanceSchema} from './store_leases.js';
import {prepareCodeGraphSnapshotFileCitationSchema} from './store_file_alias_schema.js';

export const CODE_GRAPH_EXPLICIT_SCHEMA_PREPARATION_STEP_LIMIT = 8;

/** @internal Indexed cursor-page statement retained for query-plan and high-cardinality regressions. */

const prepareRemovedViewCleanupExtension = Effect.fn('codeGraph.prepareRemovedViewCleanupExtension')(function* (
  sql: SqlClient.SqlClient,
) {
  const preflightReady = yield* preflightRemovedViewCleanupSchema(sql).pipe(
    Effect.as(true),
    Effect.catch(error => (error instanceof CodeGraphStoreError ? Effect.succeed(false) : Effect.fail(error))),
  );
  if (!preflightReady) return {reason: 'incompatible-schema', state: 'deferred'} as const;
  if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, true, false))) {
    return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  const revisions = yield* sql<{readonly value: string}>`
    SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'
  `;
  const revision = revisions[0]?.value;
  if (revisions.length !== 1 || !codeGraphPersistentSchemaSupports(revision, 'explicit-cleanup-preparation')) {
    return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  if (!(yield* codeGraphPersistentExtensionSchemaCompatible(sql))) {
    return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  const wasCurrent = yield* removedViewCleanupSchemaCurrent(sql);
  yield* ensureRemovedViewCleanupSchema(sql);
  if (!wasCurrent) {
    yield* sql`
      INSERT INTO schema_metadata (key, value)
      VALUES (${REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY}, '0')
    `;
  }
  if (!codeGraphPersistentSchemaIsCurrent(revision)) {
    yield* sql`
      UPDATE schema_metadata
      SET value = ${String(CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION)}
      WHERE key = 'persistent_extension_schema_revision' AND value = ${revision}
    `;
    if ((yield* lastStatementChangeCount(sql)) !== 1) {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph cleanup schema revision changed during setup.'));
    }
  }
  if (!(yield* codeGraphRemovedViewCleanupSchemaAdmission(sql)).current) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is unavailable.'));
  }
  return wasCurrent && codeGraphPersistentSchemaIsCurrent(revision)
    ? ({state: 'ready'} as const)
    : ({index: 'removed_view_cleanup_due', state: 'prepared'} as const);
});

const prepareWorktreeReconciliationIndex = Effect.fn('codeGraph.prepareWorktreeReconciliationIndex')(function* (
  sql: SqlClient.SqlClient,
) {
  if (!(yield* initializeRoutineMaintenanceSchema(sql))) {
    return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  const preflightReady = yield* preflightRemovedViewCleanupSchema(sql).pipe(
    Effect.as(true),
    Effect.catch(error => (error instanceof CodeGraphStoreError ? Effect.succeed(false) : Effect.fail(error))),
  );
  if (!preflightReady || !(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, false, false))) {
    return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  const revision = yield* removedViewCleanupRecordedRevision(sql);
  const recordedRevision = revision.state === 'recorded' ? revision.value : undefined;
  const citationPreparation = yield* prepareCodeGraphSnapshotFileCitationSchema(sql, recordedRevision);
  if (citationPreparation.state === 'incompatible') {
    return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  if (citationPreparation.state === 'prepared') return citationPreparation;
  const snapshotFileCitationSchema = citationPreparation.citationSchema;
  const citationMigrationPreservesSnapshots = codeGraphSchemaMigrationPreservesIncompleteSnapshots(
    recordedRevision,
    snapshotFileCitationSchema,
    citationPreparation.state === 'ready' ? 'current' : 'missing',
  );
  const extensionInspections = yield* inspectPersistentExtensionTables(sql);
  const snapshotPreservingSchemaMigration =
    citationMigrationPreservesSnapshots &&
    extensionInspections.every(inspection => inspection.exists && inspection.compatible);
  const revisionPlan = planCodeGraphPersistentSchemaUpgrade(recordedRevision);
  const checkpointExtensionMigration =
    citationMigrationPreservesSnapshots &&
    revisionPlan.state === 'upgrade' &&
    revisionPlan.route === 'extend-checkpoint-import' &&
    extensionInspections.every(inspection =>
      inspection.group === 'checkpoint' ? !inspection.exists || inspection.compatible : inspection.compatible,
    );
  if (
    !(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, false)) &&
    !snapshotPreservingSchemaMigration &&
    !checkpointExtensionMigration
  ) {
    const cleanupState = yield* removedViewCleanupSchemaState(sql);
    if (cleanupState !== 'absent') return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  const states = yield* Effect.forEach(
    CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES,
    index => codeGraphReconciliationIndexState(sql, index).pipe(Effect.map(state => ({index, state}))),
    {concurrency: 1},
  );
  if (states.some(observation => observation.state === 'incompatible')) {
    return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  const missing = states.find(observation => observation.state === 'missing');
  if (missing !== undefined) {
    yield* sql.unsafe(missing.index.definition);
    if ((yield* codeGraphReconciliationIndexState(sql, missing.index)) !== 'ready') {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph reconciliation index changed during setup.'));
    }
    return {index: missing.index.name, state: 'prepared'} as const;
  }
  if (snapshotPreservingSchemaMigration || checkpointExtensionMigration) return {state: 'migration-ready'} as const;
  if (codeGraphPersistentSchemaMigrationPending(recordedRevision)) {
    return {state: 'migration-ready'} as const;
  }
  const cleanup = yield* prepareRemovedViewCleanupExtension(sql);
  if (cleanup.state !== 'ready') return cleanup;
  return {state: 'ready'} as const;
});

const prepareWorktreeReconciliationIndexesBounded = Effect.fn('codeGraph.prepareWorktreeReconciliationIndexesBounded')(
  function* (sql: SqlClient.SqlClient) {
    let preparation = yield* prepareWorktreeReconciliationIndex(sql);
    for (
      let step = 1;
      preparation.state === 'prepared' && step < CODE_GRAPH_EXPLICIT_SCHEMA_PREPARATION_STEP_LIMIT;
      step += 1
    ) {
      preparation = yield* prepareWorktreeReconciliationIndex(sql);
    }
    return preparation;
  },
);

export {
  prepareRemovedViewCleanupExtension,
  prepareWorktreeReconciliationIndex,
  prepareWorktreeReconciliationIndexesBounded,
};
