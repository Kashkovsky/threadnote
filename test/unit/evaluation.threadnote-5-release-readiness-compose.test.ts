import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as fc from 'fast-check';
import {describe, expect} from 'vitest';
import {threadnote5LocalAuthorityManifestHash} from '../../src/evaluation/threadnote-5-release-readiness-authority.js';
import {captureThreadnote5ReleaseCandidateV1} from '../../src/evaluation/threadnote-5-release-readiness-capture.js';
import {composeThreadnote5ReleaseReadinessEvidenceV1} from '../../src/evaluation/threadnote-5-release-readiness-compose.js';
import {
  parseThreadnote5ReleaseEvidenceV1,
  parseThreadnote5ReleaseReadinessFixtureV1,
  threadnote5BaselineEvidenceHash,
  threadnote5BaselineObservationHash,
} from '../../src/evaluation/threadnote-5-release-readiness-contract.js';
import fixtureJson from '../evaluation/fixtures/threadnote-5-task-loop-v1/fixture.json' with {type: 'json'};
import {
  PRODUCTION_CAPTURE_CANDIDATE,
  productionCaptureFixture,
} from '../helpers/threadnote-5-production-capture-fixture.js';

describe('Threadnote 5 baseline evidence composition', () => {
  effectIt.effect('joins a verified 4.7.8-only baseline and reseals deterministic candidate evidence', () =>
    Effect.sync(() => {
      const candidateEvidence = candidateCapture();
      const baselineEvidence = baselineCapture();
      const composed = compose(candidateEvidence, baselineEvidence);

      expect(
        parseThreadnote5ReleaseEvidenceV1(composed, parseThreadnote5ReleaseReadinessFixtureV1(fixtureJson)),
      ).toEqual(composed);
      expect(composed.baseline).toMatchObject({state: 'available'});
      expect(composed.capture.manifest.entries).toHaveLength(15);
      expect(composed.capture.manifest.entries.every(entry => entry.sourceHash !== undefined)).toBe(true);
    }),
  );

  effectIt.effect('rejects independent candidate, baseline, coverage, and hash mismatches', () =>
    Effect.sync(() => {
      const candidateEvidence = candidateCapture();
      const baselineEvidence = baselineCapture();
      expect(() =>
        compose(candidateEvidence, baselineEvidence, {expectedCandidateEvidenceSha256: 'f'.repeat(64)}),
      ).toThrow(/candidate evidence hash/iu);
      expect(() =>
        compose(candidateEvidence, baselineEvidence, {expectedBaselineEvidenceSha256: 'f'.repeat(64)}),
      ).toThrow(/baseline evidence hash/iu);
      expect(() =>
        compose(candidateEvidence, baselineEvidence, {
          expectedBaseline: {...baselineEvidence.source, executableSha256: '8'.repeat(64)},
        }),
      ).toThrow(/baseline identity/iu);
      expect(() =>
        compose(candidateEvidence, baselineEvidence, {
          expectedCandidate: {...PRODUCTION_CAPTURE_CANDIDATE, executableSha256: '9'.repeat(64)},
        }),
      ).toThrow(/candidate identity/iu);
      const incomplete = {
        ...candidateEvidence,
        candidateObservations: candidateEvidence.candidateObservations.slice(1),
      };
      expect(() => compose(incomplete, baselineEvidence)).toThrow(
        /capture manifest does not match|scenario coverage|transcript chain/u,
      );
    }),
  );

  effectIt.effect('canonicalizes baseline input order and produces the same joined evidence hash', () =>
    Effect.sync(() => {
      const candidateEvidence = candidateCapture();
      const baseline = baselineInput();
      const expected = compose(candidateEvidence, baselineCapture(baseline));
      fc.assert(
        fc.property(
          fc.shuffledSubarray(baseline.observations, {
            maxLength: baseline.observations.length,
            minLength: baseline.observations.length,
          }),
          observations => {
            const actual = compose(candidateEvidence, baselineCapture({...baseline, observations}));
            expect(actual).toEqual(expected);
          },
        ),
        {numRuns: 30},
      );
    }),
  );
});

function candidateCapture() {
  const fixture = productionCaptureFixture();
  const runtime = {
    executableSha256: PRODUCTION_CAPTURE_CANDIDATE.executableSha256,
    sourceCommit: PRODUCTION_CAPTURE_CANDIDATE.commit,
  };
  return captureThreadnote5ReleaseCandidateV1({
    authorityManifest: fixture.authorityManifest,
    candidate: PRODUCTION_CAPTURE_CANDIDATE,
    expectedAuthorityManifestSha256: threadnote5LocalAuthorityManifestHash(fixture.authorityManifest),
    fixture: fixtureJson,
    retainedSubsystemReceipts: fixture.records,
    runtimeBoundaries: fixtureJson.scenarios.map(item => ({
      postRuntime: runtime,
      preRuntime: runtime,
      scenario: item.id,
    })),
  }).evidence;
}

function baselineInput() {
  const source = {
    commit: '80ca4acdb7347a4d00b0381f3757a5ac984d9fbf',
    executableSha256: '4'.repeat(64),
    id: 'threadnote-4.7.x' as const,
    version: '4.7.8',
  };
  const runtime = {executableSha256: source.executableSha256, sourceCommit: source.commit};
  return {
    observations: Array.from({length: 10}, (_, index) => {
      const projection = {
        capturePlanSha256: '5'.repeat(64),
        contextBriefOutputSha256: `${index + 1}`.padStart(64, '0'),
        estimatedTokensToFirstCitedCorrectPlan: 1_400 + index,
        firstCitedPlanIndependentlyJudgedCorrect: true as const,
        firstCitedPlanSha256: `${index + 20}`.padStart(64, '0'),
        provenance: {
          judgeExecutableSha256: '7'.repeat(64),
          judgeId: 'independent-plan-judge',
          judgeProtocol: 'threadnote-5-baseline-judge' as const,
          judgeRequestSha256: `${index + 70}`.padStart(64, '0'),
          judgeResponseSha256: `${index + 80}`.padStart(64, '0'),
          judgmentReceiptSha256: `${index + 30}`.padStart(64, '0'),
          measurementReceiptSha256: `${index + 40}`.padStart(64, '0'),
          observerExecutableSha256: '6'.repeat(64),
          observerId: 'independent-agent-harness',
          observerProtocol: 'threadnote-5-baseline-observer' as const,
          observerRequestSha256: `${index + 50}`.padStart(64, '0'),
          observerResponseSha256: `${index + 60}`.padStart(64, '0'),
          version: 1 as const,
        },
        postRuntime: runtime,
        preRuntime: runtime,
        timeToFirstCitedCorrectPlanMilliseconds: 60_000 + index,
        trialId: `trial-${index}`,
        wrongMemoryEligible: true,
        wrongMemoryObserved: index === 0,
      };
      return {...projection, observationHash: threadnote5BaselineObservationHash(projection)};
    }),
    source,
  };
}

function baselineCapture(input = baselineInput()) {
  const projection = {
    ...input,
    suite: 'threadnote-5-baseline-evidence' as const,
    version: 1 as const,
  };
  return {...projection, evidenceHash: threadnote5BaselineEvidenceHash(projection)};
}

function compose(
  candidateEvidence: unknown,
  baselineEvidence: ReturnType<typeof baselineCapture>,
  overrides: Partial<Parameters<typeof composeThreadnote5ReleaseReadinessEvidenceV1>[0]> = {},
) {
  return composeThreadnote5ReleaseReadinessEvidenceV1({
    baselineEvidence,
    candidateEvidence,
    expectedBaseline: baselineEvidence.source,
    expectedBaselineEvidenceSha256: baselineEvidence.evidenceHash,
    expectedCandidate: PRODUCTION_CAPTURE_CANDIDATE,
    expectedCandidateEvidenceSha256: (candidateEvidence as {readonly evidenceHash: string}).evidenceHash,
    fixture: fixtureJson,
    ...overrides,
  });
}
