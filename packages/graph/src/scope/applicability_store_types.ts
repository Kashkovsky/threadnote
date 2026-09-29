import type {CodeGraphScopeApplicabilityEvidence} from './applicability.js';

/** Persisted applicability evidence paired with the active snapshot it admits. */
export type StoredCodeGraphScopeApplicability = CodeGraphScopeApplicabilityEvidence & {readonly snapshotId: string};

/** Immutable project-membership proof stored with a scoped ready snapshot. */
export interface StoredCodeGraphScopeReceipt {
  readonly closureDigest: string;
  readonly completeness: 'complete' | 'partial';
  readonly definitionDigest: string;
  readonly includedProjectIds: readonly string[];
  readonly rootProjectIds: readonly string[];
  readonly scopeKey: string;
  readonly snapshotId: string;
}
