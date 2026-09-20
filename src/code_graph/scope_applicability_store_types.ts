import type {CodeGraphScopeApplicabilityEvidence} from './scope_applicability.js';

/** Persisted applicability evidence paired with the active snapshot it admits. */
export type StoredCodeGraphScopeApplicability = CodeGraphScopeApplicabilityEvidence & {readonly snapshotId: string};
