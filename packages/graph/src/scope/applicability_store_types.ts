import type {CodeGraphScopeApplicabilityEvidence} from './applicability.js';

/** Persisted applicability evidence paired with the active snapshot it admits. */
export type StoredCodeGraphScopeApplicability = CodeGraphScopeApplicabilityEvidence & {readonly snapshotId: string};
