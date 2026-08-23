import type {CodeGraphMonikerV1} from './cross_repository/types.js';
import type {BoundedCodeGraphFact} from './fact_budget.js';
import type {PersistentMaterializationTransactionCandidate} from './indexer_materialization.js';
import {CodeGraphIndexOperationError} from './indexer_shared.js';
import type {
  CodeGraphEdge,
  CodeGraphInventoryFile,
  CodeGraphMaterializationRows,
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

export function preparedFactsByPath(
  batches: readonly (readonly BoundedCodeGraphFact[])[],
  files: readonly CodeGraphInventoryFile[],
): ReadonlyMap<string, BoundedCodeGraphFact> {
  const byPath = new Map(batches.flatMap(batch => batch.map(value => [value.facts.path, value] as const)));
  if (byPath.size !== files.length || files.some(file => !byPath.has(file.path))) {
    throw new CodeGraphIndexOperationError('Final code graph fact preparation changed the materialization file set.');
  }
  return byPath;
}
