import {Effect} from 'effect';
import type {
  CodeGraphDirectPersistentCapacityProtector,
  CodeGraphMaterializedShardAssociationBatch,
  CodeGraphMaterializedShardCacheBatch,
  CodeGraphStoreShape,
} from './store.js';

interface CodeGraphMaterializedShardWriteQueueInput {
  readonly databasePath: string;
  readonly onAssociation: (elapsedMilliseconds: number) => void;
  readonly onCachePersistence: (elapsedMilliseconds: number, recordInAttribution: boolean) => void;
  readonly ownerToken: string;
  readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
  readonly snapshotId: string;
  readonly store: Pick<
    CodeGraphStoreShape,
    'associateMaterializedFileShardBatches' | 'cacheMaterializedFileShardBatches'
  >;
  readonly transactionBatchLimit: 1 | 4;
}

/** Keeps logical attribution batches inside one bounded physical-write queue. */
export function makeCodeGraphMaterializedShardWriteQueue(input: CodeGraphMaterializedShardWriteQueueInput) {
  const cacheBatches: CodeGraphMaterializedShardCacheBatch[] = [];
  const associationBatches: CodeGraphMaterializedShardAssociationBatch[] = [];

  const flushCaches = (recordInAttribution = true) =>
    Effect.gen(function* () {
      if (cacheBatches.length === 0) return;
      const group = cacheBatches.splice(0, cacheBatches.length);
      const startedAt = performance.now();
      yield* input.store.cacheMaterializedFileShardBatches(
        input.databasePath,
        group,
        input.persistentCapacityProtector,
      );
      input.onCachePersistence(performance.now() - startedAt, recordInAttribution);
    });

  const flushAssociations = (recordCacheInAttribution = true) =>
    Effect.gen(function* () {
      yield* flushCaches(recordCacheInAttribution);
      if (associationBatches.length === 0) return;
      const group = associationBatches.splice(0, associationBatches.length);
      const startedAt = performance.now();
      yield* input.store.associateMaterializedFileShardBatches(
        input.databasePath,
        input.snapshotId,
        input.ownerToken,
        group,
        input.persistentCapacityProtector,
      );
      input.onAssociation(performance.now() - startedAt);
    });

  return {
    enqueueAssociation(batch: CodeGraphMaterializedShardAssociationBatch): boolean {
      associationBatches.push(batch);
      return associationBatches.length >= input.transactionBatchLimit;
    },
    enqueueCache(batch: CodeGraphMaterializedShardCacheBatch): boolean {
      cacheBatches.push(batch);
      return cacheBatches.length >= input.transactionBatchLimit;
    },
    flushAssociations,
    flushCaches,
  } as const;
}
