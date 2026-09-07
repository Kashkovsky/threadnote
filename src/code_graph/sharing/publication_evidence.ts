import type {CodeGraphIndexSummary} from '../types.js';
import type {Sha256Digest} from './digest.js';

const MAX_RESULT_DIGESTS = 128;

export type GraphPublisherHydrationEvidence =
  | {readonly status: 'completed'; readonly hydratedResults: number}
  | {readonly status: 'failed'; readonly hydratedResults: null};

/** Local diagnostics only. Cache hydration and aggregate reuse do not prove per-worker attribution. */
export interface GraphPublisherContributionEvidence {
  readonly canonicalInputPolicy: 'publisher-recompute';
  readonly hydration: GraphPublisherHydrationEvidence;
  readonly index: {
    readonly reusedFiles: number;
    readonly skippedFiles: number;
    readonly snapshotId: string;
    readonly totalFiles: number;
  };
  readonly resultDigestsTruncated: boolean;
  readonly resultManifestDigests: readonly Sha256Digest[];
  readonly selectedResults: number;
  /** Receipt integrity and schema checks only; contributor identity and semantics are not authenticated. */
  readonly verifiedResults: number;
}

export function graphPublisherContributionEvidence(input: {
  readonly hydration: GraphPublisherHydrationEvidence;
  readonly index: Pick<CodeGraphIndexSummary, 'reusedFiles' | 'skippedFiles'> & {
    readonly snapshot: Pick<CodeGraphIndexSummary['snapshot'], 'id' | 'fileCount'>;
  };
  readonly selectedResults: number;
  readonly verifiedResultDigests: readonly Sha256Digest[];
}): GraphPublisherContributionEvidence {
  return {
    canonicalInputPolicy: 'publisher-recompute',
    hydration: input.hydration,
    index: {
      reusedFiles: input.index.reusedFiles,
      skippedFiles: input.index.skippedFiles,
      snapshotId: input.index.snapshot.id,
      totalFiles: input.index.snapshot.fileCount,
    },
    resultDigestsTruncated: input.verifiedResultDigests.length > MAX_RESULT_DIGESTS,
    resultManifestDigests: [...input.verifiedResultDigests].sort().slice(0, MAX_RESULT_DIGESTS),
    selectedResults: input.selectedResults,
    verifiedResults: input.verifiedResultDigests.length,
  };
}
