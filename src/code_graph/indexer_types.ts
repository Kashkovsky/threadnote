import {Crypto, Effect, Option, Path} from 'effect';
import type {SystemInfoShape} from '../effect/system.js';
import type {CodeGraphDirectPersistentCapacityBoundary} from './disk_capacity.js';
import type {CodeGraphIncrementalWork} from './incremental_work.js';
import type {CodeGraphInventoryOptions} from './inventory.js';
import type {CodeGraphWorkspace} from './languages/types.js';
import type {CodeGraphBuilderAdmissionClass} from './builder_admission.js';
import type {CodeGraphResolutionPublicationAssessment} from './resolution_surface.js';
import type {CodeGraphMaintenanceCoordinatorShape} from './maintenance_coordinator.js';
import type {CodeGraphSqliteWriterSettings, CodeGraphSqliteWriterTuning} from './store.js';
import type {
  CodeGraphFileFacts,
  CodeGraphIndexSummary,
  CodeGraphInventoryFile,
  CodeGraphOverlayFallbackReason,
  CodeGraphSnapshot,
  RepositoryIdentityExpectation,
} from './types.js';

export type CodeGraphPersistentMaterializationTransactionBatchLimit = 1 | 4 | 8;

export interface CodeGraphIndexOptions extends CodeGraphInventoryOptions {
  /** @internal Home-global builder admission priority. CLI defaults to current-required. */
  readonly admissionClass?: CodeGraphBuilderAdmissionClass;
  readonly cwd: string;
  /** When false, skip blocking vector materialization after a ready structural snapshot. */
  readonly ensureVectors?: boolean;
  /** Exact graph target supplied by a trusted local administration surface. */
  readonly expectedIdentity?: RepositoryIdentityExpectation;
  readonly force?: boolean;
  /** Internal benchmark/correctness escape hatch; normal indexing keeps this enabled. */
  readonly incrementalOverlay?: boolean;
  /** @internal Records read-back PRAGMA values for controlled benchmark evidence. */
  readonly onSqliteWriterConfigured?: (settings: CodeGraphSqliteWriterSettings) => Effect.Effect<void, never>;
  /** @internal Benchmark-only physical transaction grouping; normal indexing uses four logical receipts. */
  readonly persistentMaterializationTransactionBatchLimit?: CodeGraphPersistentMaterializationTransactionBatchLimit;
  /** @internal Benchmark-only SQLite writer candidate; normal indexing leaves this unset. */
  readonly sqliteWriterTuning?: CodeGraphSqliteWriterTuning;
  /** @internal Deterministic fresh-capacity probe used by lifecycle fault tests. */
  readonly diskCapacityAvailableBytes?: (
    path: string,
    boundary: CodeGraphDirectPersistentCapacityBoundary,
  ) => Effect.Effect<number | undefined, unknown>;
  readonly threadnoteHome: string;
}

export interface DirectPersistentCapacityProtection {
  readonly availableDiskBytes: (
    path: string,
    boundary: CodeGraphDirectPersistentCapacityBoundary,
  ) => Effect.Effect<number | undefined, unknown>;
  readonly crypto: Crypto.Crypto;
  readonly maintenance: CodeGraphMaintenanceCoordinatorShape;
  readonly path: Path.Path;
  readonly system: SystemInfoShape;
  readonly temporaryDirectory: string;
  readonly walAutoCheckpointPages: number;
}

export function codeGraphIndexEnsuresVectors(options: {readonly ensureVectors?: boolean}): boolean {
  return options.ensureVectors !== false;
}

export interface CommittedBaseResult {
  readonly diagnostics: readonly string[];
  readonly leaseToken: Option.Option<string>;
  readonly snapshot: CodeGraphSnapshot;
  readonly stagingReusable: boolean;
  /** Present when this call performed or observed the committed-base build. */
  readonly summary?: CodeGraphIndexSummary;
}

export type IncrementalOverlayAssessment =
  | {
      readonly facts: readonly CodeGraphFileFacts[];
      readonly files: readonly CodeGraphInventoryFile[];
      readonly closureProjects?: number;
      readonly mode: 'eligible';
      readonly deletedPaths?: readonly string[];
      readonly resolutionClosure?: 'changed' | 'full' | 'project';
      readonly resolutionPublicationAssessment?: CodeGraphResolutionPublicationAssessment;
      readonly extractorTransition?: true;
      readonly reuse: 'persisted-base' | 'staged-base';
      readonly work: CodeGraphIncrementalWork;
    }
  | {
      readonly mode: 'fallback';
      readonly reason: CodeGraphOverlayFallbackReason;
      readonly resolutionPublicationAssessment?: CodeGraphResolutionPublicationAssessment;
    };

export type IncrementalOverlayPreassessment =
  | {
      readonly baseFileSetFingerprint: string;
      readonly committedWorkspace: CodeGraphWorkspace;
      readonly facts: readonly CodeGraphFileFacts[];
      readonly files: readonly CodeGraphInventoryFile[];
      readonly closureProjects?: number;
      readonly mode: 'compatible';
      readonly deletedPaths?: readonly string[];
      readonly resolutionClosure?: 'changed' | 'full' | 'project';
      readonly resolutionPublicationAssessment?: CodeGraphResolutionPublicationAssessment;
      readonly extractorTransition?: true;
    }
  | {
      readonly mode: 'fallback';
      readonly reason: CodeGraphOverlayFallbackReason;
      readonly resolutionPublicationAssessment?: CodeGraphResolutionPublicationAssessment;
    };

export type ReusableCleanSnapshotAttempt =
  | {
      readonly mode: 'complete';
      readonly summary: CodeGraphIndexSummary;
    }
  | {
      readonly mode: 'fallback';
      readonly reason: CodeGraphOverlayFallbackReason;
    };

export interface CodeGraphCommitLease {
  readonly leaseToken: string;
  readonly snapshot: CodeGraphSnapshot;
}

export interface CodeGraphIndexerShape {
  readonly ensureCommit: (
    options: Omit<CodeGraphIndexOptions, 'force' | 'includeOverlay'> & {readonly commit: string},
  ) => Effect.Effect<CodeGraphCommitLease, unknown>;
  readonly index: (options: CodeGraphIndexOptions) => Effect.Effect<CodeGraphIndexSummary, unknown>;
}
