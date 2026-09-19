import {
  parseThreadnote5BaselineEvidenceV1,
  parseThreadnote5ReleaseEvidenceV1,
  parseThreadnote5ReleaseReadinessFixtureV1,
  parseThreadnote5TrustedSourceV1,
  threadnote5CaptureManifestForEvidence,
  threadnote5CaptureManifestHash,
  threadnote5ReleaseEvidenceHash,
  THREADNOTE_5_RELEASE_EVIDENCE_SUITE,
  THREADNOTE_5_RELEASE_READINESS_VERSION,
  THREADNOTE_5_RELEASE_SCENARIOS,
  type Threadnote5ReleaseEvidenceV1,
} from './threadnote-5-release-readiness-contract.js';
import {canonicalJson} from '../code_graph/checkpoint/canonical_json.js';

/** Combines separately verified historical observations with an exact v5 candidate. */
export function composeThreadnote5ReleaseReadinessEvidenceV1(input: {
  readonly baselineEvidence: unknown;
  readonly candidateEvidence: unknown;
  readonly expectedBaseline: unknown;
  readonly expectedBaselineEvidenceSha256: string;
  readonly expectedCandidate: unknown;
  readonly expectedCandidateEvidenceSha256: string;
  readonly fixture: unknown;
}): Threadnote5ReleaseEvidenceV1 {
  const fixture = parseThreadnote5ReleaseReadinessFixtureV1(input.fixture);
  const candidateEvidence = parseThreadnote5ReleaseEvidenceV1(input.candidateEvidence, fixture);
  const baselineEvidence = parseThreadnote5BaselineEvidenceV1(input.baselineEvidence);
  const expectedBaseline = parseThreadnote5TrustedSourceV1(input.expectedBaseline, 'baseline');
  const expectedCandidate = parseThreadnote5TrustedSourceV1(input.expectedCandidate, 'candidate');

  if (candidateEvidence.evidenceHash !== input.expectedCandidateEvidenceSha256) {
    throw new Error('Candidate evidence hash does not match the independently supplied expected hash.');
  }
  if (baselineEvidence.evidenceHash !== input.expectedBaselineEvidenceSha256) {
    throw new Error('Baseline evidence hash does not match the independently supplied expected hash.');
  }
  if (canonicalJson(baselineEvidence.source) !== canonicalJson(expectedBaseline)) {
    throw new Error('Baseline identity does not match the independently supplied exact baseline.');
  }
  if (canonicalJson(candidateEvidence.candidate) !== canonicalJson(expectedCandidate)) {
    throw new Error('Candidate identity does not match the independently supplied exact candidate.');
  }
  if (candidateEvidence.baseline.state !== 'unavailable') {
    throw new Error('Candidate evidence must not already embed baseline observations.');
  }
  if (
    candidateEvidence.capture.manifest.mode !== 'release-candidate' ||
    candidateEvidence.candidateObservations.length !== THREADNOTE_5_RELEASE_SCENARIOS.length ||
    new Set(candidateEvidence.candidateObservations.map(observation => observation.scenario)).size !==
      THREADNOTE_5_RELEASE_SCENARIOS.length
  ) {
    throw new Error('Candidate evidence does not have complete exact-candidate scenario coverage.');
  }
  if (baselineEvidence.observations.filter(observation => observation.wrongMemoryEligible).length < 10) {
    throw new Error('Baseline evidence lacks ten wrong-memory-eligible observations.');
  }

  const baseline = {evidence: baselineEvidence, state: 'available'} as const;
  const manifest = threadnote5CaptureManifestForEvidence({
    adapterId: candidateEvidence.capture.manifest.adapterId,
    candidateObservations: candidateEvidence.candidateObservations,
    fixtureHash: candidateEvidence.fixtureHash,
    mode: candidateEvidence.capture.manifest.mode,
  });
  const projection = {
    baseline,
    candidate: candidateEvidence.candidate,
    candidateObservations: candidateEvidence.candidateObservations,
    capture: {manifest, manifestHash: threadnote5CaptureManifestHash(manifest)},
    fixtureHash: candidateEvidence.fixtureHash,
    suite: THREADNOTE_5_RELEASE_EVIDENCE_SUITE,
    version: THREADNOTE_5_RELEASE_READINESS_VERSION,
  } as const;
  return parseThreadnote5ReleaseEvidenceV1(
    {...projection, evidenceHash: threadnote5ReleaseEvidenceHash(projection)},
    fixture,
  );
}
