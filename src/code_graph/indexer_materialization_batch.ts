import type {CodeGraphMonikerV1} from './cross_repository/types.js';
import type {PersistentMaterializationTransactionCandidate} from './indexer_materialization.js';
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
