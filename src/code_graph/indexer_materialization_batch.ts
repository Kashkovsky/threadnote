import {Effect} from 'effect';
import type {CodeGraphMonikerV1} from './cross_repository/types.js';
import type {PersistentMaterializationTransactionCandidate} from './indexer_materialization.js';
import type {CodeGraphSecondaryIndexRestorationProgressCallback} from './store_models.js';
import type {
  CodeGraphEdge,
  CodeGraphInventoryFile,
  CodeGraphMaterializationActivity,
  CodeGraphMaterializationMetrics,
  CodeGraphMaterializationRows,
  CodeGraphProgress,
  CodeGraphReference,
  CodeGraphSymbol,
} from './types.js';

export interface PendingMaterializationBatch extends PersistentMaterializationTransactionCandidate {
  readonly attributionMilliseconds: number;
  readonly batchCachedFactBytes: number;
  readonly batchFiles: readonly CodeGraphInventoryFile[];
  readonly batchIndex: number;
  readonly edges: readonly CodeGraphEdge[];
  readonly loadingMilliseconds: number;
  readonly monikers: readonly CodeGraphMonikerV1[];
  readonly references: readonly CodeGraphReference[];
  rows: CodeGraphMaterializationRows;
  readonly stageMilliseconds: Map<string, number>;
  readonly symbols: readonly CodeGraphSymbol[];
}

export function secondaryIndexRestorationReporter(input: {
  readonly batchCompleted: number;
  readonly batchTotal: number;
  readonly completed: number;
  readonly metrics: () => CodeGraphMaterializationMetrics;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly refreshStorageFiles: () => Effect.Effect<void, unknown>;
  readonly reused: number;
  readonly stageMilliseconds: Partial<Record<CodeGraphMaterializationActivity['stage'], number>>;
  readonly total: number;
}): CodeGraphSecondaryIndexRestorationProgressCallback {
  return progress => {
    input.stageMilliseconds['restoring-indexes'] = progress.elapsedMilliseconds;
    return input.refreshStorageFiles().pipe(
      Effect.andThen(
        input.onProgress?.({
          activity: {
            batchCompleted: input.batchCompleted,
            batchTotal: input.batchTotal,
            elapsedMilliseconds: progress.elapsedMilliseconds,
            sourceBytes: 0,
            stage: 'restoring-indexes',
            stageElapsedMilliseconds: progress.elapsedMilliseconds,
          },
          completed: input.completed,
          metrics: input.metrics(),
          phase: 'materializing',
          reused: input.reused,
          total: input.total,
          unit: 'files',
        }) ?? Effect.void,
      ),
      Effect.ignore,
    );
  };
}
