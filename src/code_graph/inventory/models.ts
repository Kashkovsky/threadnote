import type {Effect} from 'effect';
import type {ProjectManifest} from '../../types.js';
import type {ResolvedCodeGraphIndexScope} from '../index_scope.js';
import type {CodeGraphWorkspace} from '../languages/types.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import type {CodeGraphInventoryFile, CodeGraphProgress} from '../types.js';
import type {CodeGraphInventoryPolicyExclusionSummary, CodeGraphInventoryReuseReceipt} from '../store/models.js';
import type {CodeGraphExtractionPlanMetrics} from '../progress/telemetry.js';

export interface CodeGraphInventory {
  readonly scopeProject?: Pick<ProjectManifest, 'graph' | 'uri'>;
  readonly scopeIncludeOpaqueCorpusAssets?: boolean;
  readonly scopeIncludeOverlay?: boolean;
  readonly scope?: ResolvedCodeGraphIndexScope;
  readonly scopeCatalogFingerprint?: string;
  readonly scopeInventoryFingerprint?: string;
  readonly scopeCommittedInventoryFingerprint?: string;
  readonly scopeExclusions?: {readonly bytes: number; readonly files: number};
  readonly committedFiles: readonly CodeGraphInventoryFile[];
  readonly committedParsedFiles: number;
  /** Privacy-safe, bounded inventory-level diagnostics. */
  readonly diagnostics?: readonly string[];
  readonly dirty: boolean;
  readonly files: readonly CodeGraphInventoryFile[];
  readonly overlayFingerprint?: string;
  readonly parsedFiles: number;
  readonly policyExclusions?: CodeGraphInventoryPolicyExclusionSummary;
  readonly reuseReceipt?: Omit<CodeGraphInventoryReuseReceipt, 'workspace'>;
  readonly skipped: number;
  /** Workspace derived from the same admitted resolution-context files, when the overlay did not change one. */
  readonly workspace?: CodeGraphWorkspace;
}

export interface CodeGraphOverlayObservation {
  readonly addedPaths: readonly string[];
  readonly changedPaths: readonly string[];
  readonly deletedPaths: readonly string[];
  readonly files: readonly CodeGraphObservedOverlayFile[];
  readonly untrackedPaths: readonly string[];
}

export interface CodeGraphObservedOverlayFile {
  readonly contentHash: string;
  readonly path: string;
  readonly size: number;
}

export interface CodeGraphBuildRequestObservation {
  readonly overlay: CodeGraphOverlayObservation;
  readonly state: {readonly dirty: boolean; readonly fingerprint?: string};
}

export interface CodeGraphInventoryOptions {
  /** A configured logical view. An absent graph block retains complete-repository behavior. */
  readonly project?: Pick<ProjectManifest, 'graph' | 'uri'>;
  /** @internal Metadata-only committed inputs for pre-admission applicability assessment. */
  readonly scopeObservationOnly?: boolean;
  readonly scopeObservation?: CodeGraphInventory;
  readonly cachedCommittedFileKeys?: ReadonlySet<string>;
  readonly includeOverlay?: boolean;
  /** Binary media is metadata-only structural evidence and may be deferred until vector indexing is requested. */
  readonly includeOpaqueCorpusAssets?: boolean;
  readonly languagePacks?: CodeGraphLanguagePackRegistryShape;
  /** Exact post-lock Git observation reused by inventory to avoid repeating diff and untracked scans. */
  readonly overlayObservation?: CodeGraphOverlayObservation;
  readonly onContentBatch?: (
    files: readonly CodeGraphInventoryFile[],
    context: CodeGraphContentBatchContext,
  ) => Effect.Effect<void, unknown>;
  /** Starts the worktree-only extraction counter before any effective overlay batch. */
  readonly onOverlayStart?: () => Effect.Effect<void>;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
}

export interface CodeGraphContentBatchContext {
  /** Eligible duplicate Git blobs expected across this committed inventory pass. */
  readonly blobReuseCounts?: ReadonlyMap<string, number>;
  /** Full path-free extraction denominator for this inventory pass. */
  readonly extractionPlan?: CodeGraphExtractionPlanMetrics;
  /** Counters remain at the last completed inventory boundary while this batch is extracted. */
  readonly progress: Extract<CodeGraphProgress, {readonly phase: 'scanning'}>;
  readonly readingMilliseconds: number;
  readonly sourceBytes: number;
}
