import {Database} from 'bun:sqlite';
import {Effect} from 'effect';
import type * as SqlClient from 'effect/unstable/sql/SqlClient';
import type {CodeGraphDirectPersistentCapacityBoundary} from './disk_capacity.js';
import {
  codeGraphMaterializationSpoolPath,
  commitCodeGraphMaterializationSpoolBatch,
  configureCodeGraphMaterializationSpoolDatabase,
  initializeCodeGraphMaterializationSpoolDatabase,
  readCodeGraphMaterializationSpoolReadyPlan,
  sealCodeGraphMaterializationSpool,
  sortCodeGraphMaterializationSpoolSurfaces,
  type CodeGraphMaterializationSpoolHeader,
} from './materialization_spool.js';
import {codeGraphMaterializationSpoolApplyPlan} from './materialization_spool_apply_surfaces.js';
import {
  appendCodeGraphMaterializationSpoolFactBatch,
  prepareCodeGraphMaterializationSpoolFactBatch,
} from './materialization_spool_writer.js';
import {preparePersistedFullFactCapacity} from './store_build_preparation.js';
import {
  type ActivationStagingObserver,
  assertPersistentBuildOwner,
  registerPersistentMaterializationPlan,
  type CodeGraphWriterGate,
} from './store_build_core.js';
import {
  applyCodeGraphMaterializationSpoolSurfacePage,
  finalizeCodeGraphMaterializationSpoolReceipts,
  registerCodeGraphMaterializationSpoolApply,
  writeCodeGraphMaterializationSpoolSurfacePage,
} from './store_materialization_spool_apply.js';
import type {
  CodeGraphDirectPersistentCapacityProtector,
  CodeGraphMaterializationSpoolContext,
  CodeGraphMaterializationStorageObservation,
  CodeGraphStagingBatch,
} from './store_models.js';
import {partitionPersistedReferenceEdges} from './store_resolution_core.js';
import {persistedFullBatchFingerprint} from './store_staging_core.js';
import type {CodeGraphStoreRuntime} from './store_runtime.js';
import {classifyCodeGraphStoreFailure} from './store_failure.js';
import {codeGraphSqliteGet} from './sqlite_statement.js';
import {CODE_GRAPH_SCHEMA_VERSION, CodeGraphStoreError} from './types.js';

interface PersistentSpoolSnapshotRow {
  readonly extractor_set: string;
  readonly graph_content_id: string;
  readonly repository_id: string;
}

interface PreparedSpoolBatch {
  readonly prepared: ReturnType<typeof prepareCodeGraphMaterializationSpoolFactBatch>;
  readonly receipt: Parameters<typeof commitCodeGraphMaterializationSpoolBatch>[1];
}

export const appendPersistentMaterializationSpoolFactBatches = Effect.fn(
  'codeGraph.appendPersistentMaterializationSpoolFactBatches',
)(function* (
  runtime: CodeGraphStoreRuntime,
  databasePath: string,
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  batches: readonly CodeGraphStagingBatch[],
  context: CodeGraphMaterializationSpoolContext,
  observerForBatch: (batchIndex: number) => ActivationStagingObserver,
  persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
) {
  if (batches.length === 0) return;
  yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
  const header = yield* persistentSpoolHeader(runtime, databasePath, sql, snapshotId, context);
  const spoolPath = codeGraphMaterializationSpoolPath(runtime.path, context, snapshotId);
  const preparation = preparePersistedFullFactCapacity(batches);
  const prepared: PreparedSpoolBatch[] = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const full = preparation.batches[index];
    const partition = yield* Effect.try({
      try: () => partitionPersistedReferenceEdges(batch.edges, full.boundedReferences),
      catch: () => new CodeGraphStoreError('Persistent materialization spool edges could not be partitioned.'),
    });
    const spool = prepareCodeGraphMaterializationSpoolFactBatch({
      directEdges: partition.directEdges,
      monikers: batch.monikers ?? [],
      referenceEdges: partition.referenceEdges,
      references: full.boundedReferences,
      symbols: batch.symbols,
      termsBySymbol: full.symbolTerms,
    });
    prepared.push({
      prepared: spool,
      receipt: {
        batchId: yield* persistedFullBatchFingerprint(
          batch.symbols,
          batch.edges,
          full.boundedReferences,
          batch.monikers ?? [],
        ),
        batchIndex: batch.batchIndex,
        candidateCount: spool.references.reduce((total, reference) => total + reference.candidateCount, 0),
        edgeCount: batch.edges.length,
        factBytes: batch.finalFactBytes ?? 0,
        lookupCount: spool.lookup.length,
        referenceCount: full.boundedReferences.length,
        reexportCount: full.reexportsByReferenceBatch.reduce((total, rows) => total + rows.length, 0),
        rowCount: spool.rowCount,
        sourceBytes: batch.sourceBytes ?? 0,
        symbolCount: batch.symbols.length,
        termCount: spool.symbolTerms.length,
      },
    });
  }
  const append = usePersistentSpool(runtime, header, context, database => {
    for (const batch of prepared) {
      commitCodeGraphMaterializationSpoolBatch(
        database,
        batch.receipt,
        () => appendCodeGraphMaterializationSpoolFactBatch(database, batch.prepared),
        () => observePersistentMaterializationStorage(databasePath, spoolPath, context),
      );
    }
  });
  yield* persistentCapacityProtector ? persistentCapacityProtector(preparation.capacity, append) : append;
  for (const [index, entry] of prepared.entries()) {
    const batch = batches[index];
    const observer = observerForBatch(batch.batchIndex);
    for (const [stage, rows] of [
      ['validating', 3],
      ['symbols', entry.receipt.symbolCount],
      ['lookup-keys', entry.receipt.lookupCount],
      ['terms', entry.receipt.termCount],
      ['edges', entry.receipt.edgeCount],
      ['references', entry.receipt.referenceCount],
      ['reference-candidates', entry.receipt.candidateCount],
      ['reexports', entry.receipt.reexportCount],
      ['analysis', entry.receipt.symbolCount + entry.receipt.edgeCount],
      ['receipt', 1],
    ] as const) {
      yield* observer(stage, rows, true);
    }
    yield* observer('committing', 0, true);
    yield* observer('committed', 0, true);
  }
});

export const finalizePersistentMaterializationSpool = Effect.fn('codeGraph.finalizePersistentMaterializationSpool')(
  function* (
    runtime: CodeGraphStoreRuntime,
    databasePath: string,
    sql: SqlClient.SqlClient,
    snapshotId: string,
    ownerToken: string,
    expectedBatchCount: number,
    context: CodeGraphMaterializationSpoolContext,
    runWrite: CodeGraphWriterGate,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  ) {
    const protect = <A, E, R>(boundary: CodeGraphDirectPersistentCapacityBoundary, effect: Effect.Effect<A, E, R>) =>
      persistentCapacityProtector ? persistentCapacityProtector(boundary, effect) : effect;
    const header = yield* persistentSpoolHeader(runtime, databasePath, sql, snapshotId, context);
    const spoolPath = codeGraphMaterializationSpoolPath(runtime.path, context, snapshotId);
    yield* protect(
      {finalFactBytes: 0, operation: 'register persistent code graph materialization plan', rowCount: 2},
      runWrite(
        sql.withTransaction(registerPersistentMaterializationPlan(sql, snapshotId, ownerToken, expectedBatchCount)),
      ),
    );
    const sortBoundary = yield* usePersistentSpool(runtime, header, context, database => {
      sealCodeGraphMaterializationSpool(database, expectedBatchCount);
      const totals = codeGraphSqliteGet<{readonly fact_bytes: number | bigint; readonly row_count: number | bigint}>(
        database,
        'SELECT COALESCE(SUM(fact_bytes), 0) AS fact_bytes, COALESCE(SUM(row_count), 0) AS row_count FROM materialization_spool_batches',
      );
      if (totals === null) {
        throw new CodeGraphStoreError('Persistent materialization spool totals are missing.');
      }
      return {
        finalFactBytes: Number(totals.fact_bytes),
        operation: 'sort persistent code graph materialization spool',
        rowCount: Number(totals.row_count),
      } satisfies CodeGraphDirectPersistentCapacityBoundary;
    });
    const ready = yield* protect(
      sortBoundary,
      usePersistentSpool(runtime, header, context, database => {
        sortCodeGraphMaterializationSpoolSurfaces(database, () =>
          observePersistentMaterializationStorage(databasePath, spoolPath, context),
        );
        return readCodeGraphMaterializationSpoolReadyPlan(database);
      }),
    );
    const plan = codeGraphMaterializationSpoolApplyPlan(ready);
    const attached = Effect.gen(function* () {
      yield* protect(
        {finalFactBytes: 0, operation: 'register persistent code graph materialization plan', rowCount: plan.length},
        runWrite(
          registerCodeGraphMaterializationSpoolApply(sql, snapshotId, ownerToken, ready.spoolIdentity, plan, () =>
            observePersistentMaterializationStorageEffect(databasePath, spoolPath, context),
          ),
        ),
      );
      for (let surfaceIndex = 0; surfaceIndex < plan.length; surfaceIndex += 1) {
        for (;;) {
          const result = yield* protect(
            {finalFactBytes: 0, operation: 'apply persistent code graph materialization spool', rowCount: 50_000},
            runWrite(
              applyCodeGraphMaterializationSpoolSurfacePage(
                sql,
                snapshotId,
                ownerToken,
                ready.spoolIdentity,
                surfaceIndex,
                page => writeCodeGraphMaterializationSpoolSurfacePage(sql, snapshotId, surfaceIndex, page),
                () => observePersistentMaterializationStorageEffect(databasePath, spoolPath, context),
              ),
            ),
          );
          if (result.state === 'complete') break;
        }
      }
      yield* protect(
        {
          finalFactBytes: 0,
          operation: 'publish persistent code graph materialization spool receipts',
          rowCount: ready.batches.length,
        },
        runWrite(
          finalizeCodeGraphMaterializationSpoolReceipts(sql, snapshotId, ownerToken, ready.spoolIdentity, () =>
            observePersistentMaterializationStorageEffect(databasePath, spoolPath, context),
          ),
        ),
      );
    });
    yield* attachPersistentMaterializationSpool(sql, spoolPath);
    yield* attached.pipe(Effect.ensuring(sql.unsafe('DETACH DATABASE materialization_spool').pipe(Effect.orDie)));
    return spoolPath;
  },
);

export function materializationSpoolReadOnlyUri(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const uri = new URL(`file://${absolute}`);
  uri.searchParams.set('immutable', '1');
  uri.searchParams.set('mode', 'ro');
  return uri.href;
}

/**
 * SQLite URI filenames are disabled in some Bun platform builds. Prefer the
 * immutable read-only URI, then fall back to the already sealed and
 * identity-verified local sidecar path when ATTACH reports that the URI cannot
 * be opened. Every statement against this schema is a fixed SELECT; the main
 * graph database remains the only write target.
 */
export function attachPersistentMaterializationSpool(
  sql: SqlClient.SqlClient,
  spoolPath: string,
): Effect.Effect<'readonly-uri' | 'verified-path-fallback', unknown> {
  return sql.unsafe('ATTACH DATABASE ? AS materialization_spool', [materializationSpoolReadOnlyUri(spoolPath)]).pipe(
    Effect.as('readonly-uri' as const),
    Effect.catch(error =>
      classifyCodeGraphStoreFailure('register persistent code graph materialization plan', error).code ===
      'transient-io'
        ? sql
            .unsafe('ATTACH DATABASE ? AS materialization_spool', [spoolPath])
            .pipe(Effect.as('verified-path-fallback' as const))
        : Effect.fail(error),
    ),
  );
}

export const removePersistentMaterializationSpool = Effect.fn('codeGraph.removePersistentMaterializationSpool')(
  function* (runtime: CodeGraphStoreRuntime, spoolPath: string) {
    for (const candidate of [spoolPath, `${spoolPath}-journal`, `${spoolPath}-shm`, `${spoolPath}-wal`]) {
      if (yield* runtime.fs.exists(candidate)) yield* runtime.fs.remove(candidate);
    }
  },
);

const persistentSpoolHeader = Effect.fn('codeGraph.persistentSpoolHeader')(function* (
  runtime: CodeGraphStoreRuntime,
  databasePath: string,
  sql: SqlClient.SqlClient,
  snapshotId: string,
  context: CodeGraphMaterializationSpoolContext,
) {
  if (
    !/^[0-9a-f]{64}$/u.test(context.checkoutId) ||
    runtime.path.dirname(databasePath) !== context.repositoryRoot ||
    runtime.path.basename(context.repositoryRoot) !== context.checkoutId ||
    runtime.path.basename(databasePath) !== `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent materialization spool layout is invalid.'));
  }
  const rows = yield* sql.unsafe<PersistentSpoolSnapshotRow>(
    `SELECT repository_id, graph_content_id, extractor_set
     FROM snapshots WHERE id = ? AND state = 'building' LIMIT 2`,
    [snapshotId],
  );
  if (rows.length !== 1) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent materialization spool snapshot is invalid.'));
  }
  return {
    checkoutId: context.checkoutId,
    extractorSet: rows[0].extractor_set,
    graphContentId: rows[0].graph_content_id,
    repositoryId: rows[0].repository_id,
    snapshotId,
  };
});

function usePersistentSpool<Value>(
  runtime: CodeGraphStoreRuntime,
  header: CodeGraphMaterializationSpoolHeader,
  context: CodeGraphMaterializationSpoolContext,
  use: (database: Database) => Value,
): Effect.Effect<Value, CodeGraphStoreError> {
  const spoolPath = codeGraphMaterializationSpoolPath(runtime.path, context, header.snapshotId);
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => new Database(spoolPath, {create: true, strict: true}),
      catch: () => new CodeGraphStoreError('Persistent materialization spool could not be opened.'),
    }),
    database =>
      Effect.try({
        try: () => {
          configureCodeGraphMaterializationSpoolDatabase(database);
          initializeCodeGraphMaterializationSpoolDatabase(database, header);
          return use(database);
        },
        catch: () => new CodeGraphStoreError('Persistent materialization spool operation failed.'),
      }),
    database =>
      Effect.try({
        try: () => database.close(true),
        catch: () => new CodeGraphStoreError('Persistent materialization spool could not be closed.'),
      }),
  );
}

function observePersistentMaterializationStorageEffect(
  databasePath: string,
  spoolPath: string,
  context: CodeGraphMaterializationSpoolContext,
): Effect.Effect<void> {
  return Effect.sync(() => observePersistentMaterializationStorage(databasePath, spoolPath, context));
}

function observePersistentMaterializationStorage(
  databasePath: string,
  spoolPath: string,
  context: CodeGraphMaterializationSpoolContext,
): void {
  context.onStorageObservation?.(persistentMaterializationStorageObservation(databasePath, spoolPath));
}

export function persistentMaterializationStorageObservation(
  databasePath: string,
  spoolPath: string,
): CodeGraphMaterializationStorageObservation {
  const databaseBytes = bunFileBytes(databasePath);
  const journalBytes = bunFileBytes(`${databasePath}-journal`);
  const sharedMemoryBytes = bunFileBytes(`${databasePath}-shm`);
  const walBytes = bunFileBytes(`${databasePath}-wal`);
  const sidecarDatabaseBytes = bunFileBytes(spoolPath);
  const sidecarJournalBytes = bunFileBytes(`${spoolPath}-journal`);
  const sidecarSharedMemoryBytes = bunFileBytes(`${spoolPath}-shm`);
  const sidecarWalBytes = bunFileBytes(`${spoolPath}-wal`);
  return {
    databaseBytes,
    journalBytes,
    sharedMemoryBytes,
    sidecarDatabaseBytes,
    sidecarJournalBytes,
    sidecarSharedMemoryBytes,
    sidecarWalBytes,
    totalBytes:
      databaseBytes +
      journalBytes +
      sharedMemoryBytes +
      walBytes +
      sidecarDatabaseBytes +
      sidecarJournalBytes +
      sidecarSharedMemoryBytes +
      sidecarWalBytes,
    walBytes,
  };
}

function bunFileBytes(filePath: string): number {
  return Math.min(Bun.file(filePath).size, Number.MAX_SAFE_INTEGER);
}
