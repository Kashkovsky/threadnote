import {Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY} from './store_removed_view_schema_contracts.js';
import {removedViewCleanupSchemaState} from './store_removed_view_schema_inspection.js';
import {codeGraphPersistentExtensionSchemaCompatible} from './store_schema_inspection.js';
import {CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION, CodeGraphStoreError} from './types.js';
import {
  codeGraphRemovedViewCleanupSchemaAdmission,
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
  if (
    revisions.length !== 1 ||
    (revision !== '7' && revision !== '8' && revision !== String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION))
  ) {
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
  if (revision !== String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)) {
    yield* sql`
      UPDATE schema_metadata
      SET value = ${String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)}
      WHERE key = 'persistent_extension_schema_revision' AND value = ${revision!}
    `;
    if ((yield* lastStatementChangeCount(sql)) !== 1) {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph cleanup schema revision changed during setup.'));
    }
  }
  if (!(yield* codeGraphRemovedViewCleanupSchemaAdmission(sql)).current) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is unavailable.'));
  }
  return wasCurrent && revision === String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)
    ? ({state: 'ready'} as const)
    : ({index: 'removed_view_cleanup_due', state: 'prepared'} as const);
});

const prepareWorktreeReconciliationIndex = Effect.fn('codeGraph.prepareWorktreeReconciliationIndex')(function* (
  sql: SqlClient.SqlClient,
) {
  const preflightReady = yield* preflightRemovedViewCleanupSchema(sql).pipe(
    Effect.as(true),
    Effect.catch(error => (error instanceof CodeGraphStoreError ? Effect.succeed(false) : Effect.fail(error))),
  );
  if (!preflightReady || !(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, false, false))) {
    return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, false))) {
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
  const cleanup = yield* prepareRemovedViewCleanupExtension(sql);
  if (cleanup.state !== 'ready') return cleanup;
  return {state: 'ready'} as const;
});

export {prepareRemovedViewCleanupExtension, prepareWorktreeReconciliationIndex};
