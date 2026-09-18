import {sha256HexSync} from '../../src/crypto/sha256.js';
import {
  APPROVED_THREADNOTE_5_METRICS,
  APPROVED_THREADNOTE_5_SCENARIOS,
  parseThreadnote5ReleaseEvidenceV1,
  parseThreadnote5ReleaseReadinessFixtureV1,
  threadnote5CaptureManifestForEvidence,
  threadnote5CaptureManifestHash,
  threadnote5ObservationReceiptHash,
  threadnote5ObservationTranscriptHash,
  threadnote5ReleaseEvidenceHash,
  threadnote5ReleaseReadinessFixtureHash,
  threadnote5SourceHash,
  type Threadnote5BaselineV1,
  type Threadnote5EvidenceClass,
  type Threadnote5MeasurementV1,
  type Threadnote5ObservationV1,
  type Threadnote5ReleaseEvidenceV1,
  type Threadnote5ReleaseMetric,
  type Threadnote5SourceV1,
} from '../../src/evaluation/threadnote-5-release-readiness-contract.js';
import {evaluateThreadnote5ReleaseReadiness} from '../../src/evaluation/threadnote-5-release-readiness.js';
import {
  threadnote5BaselineTrialLedger,
  threadnote5BaselineTrialLedgerHash,
} from '../../src/evaluation/threadnote-5-release-readiness-baseline-ledger.js';
import {verifyThreadnote5LocalSubsystemReceipts} from '../../src/evaluation/threadnote-5-release-readiness-receipts.js';
import * as fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import fixtureJson from '../evaluation/fixtures/threadnote-5-task-loop-v1/fixture.json' with {type: 'json'};

const fixture = parseThreadnote5ReleaseReadinessFixtureV1(fixtureJson);
const CANDIDATE: Threadnote5SourceV1 = {
  commit: '1'.repeat(40),
  executableSha256: '2'.repeat(64),
  id: 'threadnote-5.0.0',
  version: `5.0.0-local.g${'1'.repeat(40)}`,
};
const BASELINE: Threadnote5SourceV1 = {
  commit: '3'.repeat(40),
  executableSha256: '4'.repeat(64),
  id: 'threadnote-4.7.x',
  version: '4.7.9',
};

describe('Threadnote 5 release-readiness evidence', () => {
  it('freezes the complete offline scenario, subsystem, and metric contract', () => {
    expect(fixture.networkAllowed).toBe(false);
    expect(fixture.scenarios).toEqual(APPROVED_THREADNOTE_5_SCENARIOS);
    expect(fixture.metrics).toEqual(APPROVED_THREADNOTE_5_METRICS);
    expect(fixture.scenarios.map(item => item.id)).toEqual([
      'solo',
      'two-agent',
      'git-shared',
      'offline',
      'dirty-worktree',
      'interrupted-resumed',
      'upgrade-downgrade',
      'provider-neutral-proposal',
      'verified-procedures',
      'health-maintenance',
      'structured-closeout',
      'stale-citation',
      'contradiction-triage',
      'projection-drift',
      'output-budgets',
    ]);
  });

  it('keeps a trusted sealed replay and absent 4.7.x baseline explicitly unknown', () => {
    const evidence = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
    const result = evaluate(evidence);

    expect(result.scenarios.every(item => item.state === 'passed')).toBe(true);
    expect(result.metrics.every(item => item.thresholdPassed === true)).toBe(true);
    expect(result.metrics.every(item => item.baseline.state === 'unknown' && item.delta.state === 'unknown')).toBe(
      true,
    );
    expect(result.evidence.captureManifestTrusted).toBe(true);
    expect(result.gate).toEqual({
      insufficiencies: [
        '4.7.x baseline is unavailable: not-captured',
        'sealed fixture replay is not production release evidence',
      ],
      qualityFailures: [],
      status: 'unknown',
    });
  });

  it('compares only an exact independently supplied baseline identity', () => {
    const baseline: Threadnote5BaselineV1 = {
      observations: observationsFor(BASELINE, 'baseline'),
      source: BASELINE,
      state: 'available',
    };
    const evidence = evidenceBundle({baseline, mode: 'fixture-replay'});
    const result = evaluate(evidence, BASELINE);

    expect(result.gate).toEqual({
      insufficiencies: ['sealed fixture replay is not production release evidence'],
      qualityFailures: [],
      status: 'unknown',
    });
    expect(
      result.metrics.map(item => [
        item.id,
        item.delta.state,
        item.delta.state === 'observed' && item.delta.classification,
      ]),
    ).toEqual([
      ['time-to-first-cited-correct-plan', 'observed', 'improved'],
      ['estimated-tokens-to-first-cited-correct-plan', 'observed', 'improved'],
      ['setup-success-rate', 'observed', 'improved'],
      ['wrong-memory-rate', 'observed', 'improved'],
      ['second-agent-reuse-rate', 'observed', 'improved'],
      ['knowledge-delta-completion-rate', 'observed', 'improved'],
      ['health-resolution-rate', 'observed', 'improved'],
    ]);
  });

  it('keeps malformed retained receipt inputs unknown', () => {
    const baseline: Threadnote5BaselineV1 = {
      observations: observationsFor(BASELINE, 'baseline'),
      source: BASELINE,
      state: 'available',
    };
    const evidence = evidenceBundle({baseline, mode: 'release-candidate'});
    const records = [{}];
    const result = evaluateWithManifest(evidence, evidence.capture.manifestHash, BASELINE, records);

    expect(result.gate).toMatchObject({
      insufficiencies: ['production subsystem receipt verification is records-invalid'],
      status: 'failed',
    });
    expect(result.evidence.productionReceiptVerification).toMatchObject({reason: 'records-invalid', state: 'unknown'});

    expect(
      verifyThreadnote5LocalSubsystemReceipts({
        candidate: CANDIDATE,
        observations: evidence.candidateObservations,
        retainedRecords: [...records].reverse(),
      }),
    ).toMatchObject({reason: 'records-invalid', state: 'unknown'});
  });

  it('requires at least 9 successful activation attempts out of the 10-attempt minimum', () => {
    const sufficient = rewriteScenarioMeasurements(
      evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'}),
      'solo',
      measurement =>
        measurement.id === 'setup-success-rate' && 'eligibleCount' in measurement
          ? {...measurement, positiveCount: 9}
          : measurement,
    );
    const sufficientResult = evaluate(sufficient);

    expect(sufficientResult.scenarios.find(item => item.id === 'solo')?.state).toBe('passed');
    expect(sufficientResult.metrics.find(item => item.id === 'setup-success-rate')).toMatchObject({
      candidate: {state: 'observed', value: 0.9},
      thresholdPassed: true,
    });

    const belowThreshold = rewriteScenarioMeasurements(sufficient, 'solo', measurement =>
      measurement.id === 'setup-success-rate' && 'eligibleCount' in measurement
        ? {...measurement, positiveCount: 8}
        : measurement,
    );
    const belowThresholdResult = evaluate(belowThreshold);

    expect(belowThresholdResult.scenarios.find(item => item.id === 'solo')?.state).toBe('passed');
    expect(belowThresholdResult.metrics.find(item => item.id === 'setup-success-rate')).toMatchObject({
      candidate: {state: 'observed', value: 0.8},
      thresholdPassed: false,
    });
    expect(belowThresholdResult.gate.status).toBe('failed');
  });

  it('keeps every undersized metric contribution unknown even when its apparent value passes', () => {
    fc.assert(
      fc.property(fc.integer({max: 9, min: 1}), eligibleCount => {
        const undersized = rewriteScenarioMeasurements(
          evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'}),
          'solo',
          measurement => {
            if ('sampleCount' in measurement) {
              const perSample = measurement.total / measurement.sampleCount;
              return {...measurement, sampleCount: eligibleCount, total: perSample * eligibleCount};
            }
            return {
              ...measurement,
              eligibleCount,
              positiveCount: measurement.id === 'wrong-memory-rate' ? 0 : eligibleCount,
            };
          },
        );
        const result = evaluate(undersized);
        const soloMetricIds = new Set(fixture.scenarios.find(item => item.id === 'solo')!.metricIds);

        expect(result.scenarios.find(item => item.id === 'solo')?.state).toBe('unknown');
        expect(
          result.metrics
            .filter(metric => soloMetricIds.has(metric.id))
            .every(metric => metric.candidate.state === 'unknown' && metric.thresholdPassed === null),
        ).toBe(true);
        expect(result.gate.status).toBe('failed');
        expect(result.gate.qualityFailures).toContain('candidate scenario solo is unknown');
      }),
      {numRuns: 25},
    );
  });

  it('keeps unrelated candidate lanes observed when exactly one scenario lane is undersized', () => {
    const undersized = rewriteScenarioMeasurements(
      evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'}),
      'solo',
      measurement =>
        measurement.id === 'setup-success-rate' && 'eligibleCount' in measurement
          ? {...measurement, eligibleCount: 9, positiveCount: 9}
          : measurement,
    );
    const result = evaluate(undersized);

    expect(result.scenarios.find(item => item.id === 'solo')?.state).toBe('unknown');
    expect(result.metrics.find(item => item.id === 'setup-success-rate')).toMatchObject({
      candidate: {reason: 'source-incomplete', state: 'unknown'},
      thresholdPassed: null,
    });
    expect(
      result.metrics
        .filter(metric =>
          [
            'time-to-first-cited-correct-plan',
            'estimated-tokens-to-first-cited-correct-plan',
            'wrong-memory-rate',
          ].includes(metric.id),
        )
        .every(metric => metric.candidate.state === 'observed'),
    ).toBe(true);
  });

  it('keeps unrelated trusted-baseline lanes observed when exactly one baseline lane is undersized', () => {
    const baseline: Threadnote5BaselineV1 = {
      observations: observationsFor(BASELINE, 'baseline'),
      source: BASELINE,
      state: 'available',
    };
    const evidence = rewriteBaselineScenarioMeasurements(
      evidenceBundle({baseline, mode: 'fixture-replay'}),
      'solo',
      measurement =>
        measurement.id === 'setup-success-rate' && 'eligibleCount' in measurement
          ? {...measurement, eligibleCount: 9, positiveCount: 9}
          : measurement,
    );
    const result = evaluate(evidence, BASELINE);

    expect(result.metrics.find(item => item.id === 'setup-success-rate')).toMatchObject({
      baseline: {reason: 'source-incomplete', state: 'unknown'},
      delta: {reason: 'source-incomplete', state: 'unknown'},
    });
    expect(
      result.metrics
        .filter(metric => metric.id !== 'setup-success-rate')
        .every(metric => metric.baseline.state === 'observed' && metric.delta.state === 'observed'),
    ).toBe(true);
    expect(result.gate.insufficiencies).toContain('4.7.x baseline metric is unknown: setup-success-rate');
  });

  it('withholds every comparison when the baseline identity is absent or mismatched', () => {
    const baseline: Threadnote5BaselineV1 = {
      observations: observationsFor(BASELINE, 'baseline'),
      source: BASELINE,
      state: 'available',
    };
    const evidence = evidenceBundle({baseline, mode: 'fixture-replay'});
    for (const expectedBaselineSource of [
      undefined,
      {...BASELINE, executableSha256: '9'.repeat(64)},
      {...BASELINE, commit: '8'.repeat(40)},
      {...BASELINE, version: '4.7.8'},
    ]) {
      const result = evaluate(evidence, expectedBaselineSource);
      expect(
        result.metrics.every(metric => metric.baseline.state === 'unknown' && metric.delta.state === 'unknown'),
      ).toBe(true);
      expect(result.gate.insufficiencies).toContain('4.7.x baseline does not match a trusted expected source identity');
    }
  });

  it('requires an independently supplied 4.7 trial-ledger hash when a ledger is requested', () => {
    const baseline: Threadnote5BaselineV1 = {
      observations: observationsFor(BASELINE, 'baseline'),
      source: BASELINE,
      state: 'available',
    };
    const evidence = evidenceBundle({baseline, mode: 'fixture-replay'});
    const ledger = threadnote5BaselineTrialLedger(baseline.source, baseline.observations);
    const trusted = evaluateThreadnote5ReleaseReadiness({
      baselineTrialLedger: ledger,
      evidence,
      expectedBaselineSource: BASELINE,
      expectedBaselineTrialLedgerSha256: threadnote5BaselineTrialLedgerHash(ledger),
      expectedCandidateCommit: CANDIDATE.commit,
      expectedCandidateExecutableSha256: CANDIDATE.executableSha256,
      expectedCaptureManifestSha256: evidence.capture.manifestHash,
      fixture,
    });
    expect(trusted.metrics.every(metric => metric.baseline.state === 'observed')).toBe(true);

    const missing = evaluateThreadnote5ReleaseReadiness({
      evidence,
      expectedBaselineSource: BASELINE,
      expectedCandidateCommit: CANDIDATE.commit,
      expectedCandidateExecutableSha256: CANDIDATE.executableSha256,
      expectedCaptureManifestSha256: evidence.capture.manifestHash,
      fixture,
    });
    expect(missing.metrics.every(metric => metric.baseline.state === 'unknown')).toBe(true);

    const untrusted = evaluateThreadnote5ReleaseReadiness({
      baselineTrialLedger: ledger,
      evidence,
      expectedBaselineSource: BASELINE,
      expectedBaselineTrialLedgerSha256: 'f'.repeat(64),
      expectedCandidateCommit: CANDIDATE.commit,
      expectedCandidateExecutableSha256: CANDIDATE.executableSha256,
      expectedCaptureManifestSha256: evidence.capture.manifestHash,
      fixture,
    });
    expect(untrusted.metrics.every(metric => metric.baseline.state === 'unknown')).toBe(true);
  });

  it('fails closed when a candidate scenario is missing', () => {
    const original = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
    const candidateObservations = rechainObservations(
      original.candidateObservations.filter(item => item.scenario !== 'dirty-worktree'),
    );
    const incomplete = resealEvidence({...withoutEvidenceHash(original), candidateObservations});
    const result = evaluate(incomplete);

    expect(result.scenarios.find(item => item.id === 'dirty-worktree')?.state).toBe('missing');
    expect(result.gate.status).toBe('failed');
    expect(result.gate.qualityFailures).toContain('candidate scenario dirty-worktree is missing');
  });

  it('rejects tampered transcripts, runtime drift, and scenario-mislabeled attestations', () => {
    const evidence = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
    const first = evidence.candidateObservations[0];
    const tamperedObservation = {
      ...first,
      transcript: {
        ...first.transcript,
        measurements: first.transcript.measurements.map((measurement, index) =>
          index === 0 && 'total' in measurement ? {...measurement, total: measurement.total + 1} : measurement,
        ),
      },
    };
    expect(() =>
      parseThreadnote5ReleaseEvidenceV1(
        resealEvidence({
          ...withoutEvidenceHash(evidence),
          candidateObservations: [tamperedObservation, ...evidence.candidateObservations.slice(1)],
        }),
        fixture,
      ),
    ).toThrow(/transcript digest does not match/u);

    const driftedBase = {
      ...withoutReceiptHash(first),
      attestation: {
        ...first.attestation,
        postRuntime: {...first.attestation.postRuntime, executableSha256: '9'.repeat(64)},
      },
    };
    const drifted = {...driftedBase, receiptHash: threadnote5ObservationReceiptHash(driftedBase)};
    expect(() =>
      parseThreadnote5ReleaseEvidenceV1(
        resealEvidence({
          ...withoutEvidenceHash(evidence),
          candidateObservations: [drifted, ...evidence.candidateObservations.slice(1)],
        }),
        fixture,
      ),
    ).toThrow(/post-run runtime does not match/u);

    const mislabeledBase = {...withoutReceiptHash(first), scenario: 'two-agent' as const};
    const mislabeled = {...mislabeledBase, receiptHash: threadnote5ObservationReceiptHash(mislabeledBase)};
    expect(() =>
      parseThreadnote5ReleaseEvidenceV1(
        resealEvidence({
          ...withoutEvidenceHash(evidence),
          candidateObservations: [mislabeled, ...evidence.candidateObservations.slice(1)],
        }),
        fixture,
      ),
    ).toThrow(/transcript assertions are mislabeled/u);
  });

  it('withholds candidate metrics when a self-consistent rewritten manifest is not independently trusted', () => {
    const original = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
    const originalTrustedHash = original.capture.manifestHash;
    const first = original.candidateObservations[0];
    const transcript = {
      ...first.transcript,
      measurements: first.transcript.measurements.map(measurement =>
        'total' in measurement ? {...measurement, total: measurement.total + measurement.sampleCount} : measurement,
      ),
    };
    const transcriptDigest = threadnote5ObservationTranscriptHash(transcript);
    const base = {
      ...withoutReceiptHash(first),
      attestation: {...first.attestation, transcriptDigest},
      transcript,
    };
    const rewritten = {...base, receiptHash: threadnote5ObservationReceiptHash(base)};
    const candidateObservations = rechainObservations([rewritten, ...original.candidateObservations.slice(1)]);
    const relabeled = resealEvidence({...withoutEvidenceHash(original), candidateObservations});
    const result = evaluateWithManifest(relabeled, originalTrustedHash);

    expect(result.evidence.captureManifestTrusted).toBe(false);
    expect(
      result.metrics.every(metric => metric.candidate.state === 'unknown' && metric.delta.state === 'unknown'),
    ).toBe(true);
    expect(result.gate.qualityFailures).toContain('capture manifest does not match the trusted expected hash');
  });

  it('rejects content-bearing fields and inexact candidate versions', () => {
    const evidence = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
    expect(() => parseThreadnote5ReleaseEvidenceV1({...evidence, rawLog: 'forbidden'}, fixture)).toThrow(
      /unsupported or missing fields/u,
    );
    expect(() =>
      parseThreadnote5ReleaseEvidenceV1(
        {
          ...evidence,
          candidate: {...evidence.candidate, version: '5.0.0-local'},
        },
        fixture,
      ),
    ).toThrow(/candidate version is invalid/u);
  });

  it('has order-independent deterministic evidence hashes', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...fixture.scenarios.keys()], {
          minLength: fixture.scenarios.length,
          maxLength: fixture.scenarios.length,
        }),
        order => {
          const evidence = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
          const reordered = order.map(index => evidence.candidateObservations[index]);
          expect(
            threadnote5ReleaseEvidenceHash({...withoutEvidenceHash(evidence), candidateObservations: reordered}),
          ).toBe(evidence.evidenceHash);
          expect(parseThreadnote5ReleaseEvidenceV1({...evidence, candidateObservations: reordered}, fixture)).toEqual(
            evidence,
          );
        },
      ),
      {numRuns: 50},
    );
  });

  it('detects bounded numeric tampering for every measured scenario', () => {
    const measuredOrdinals = fixture.scenarios.flatMap((scenario, index) =>
      scenario.metricIds.length > 0 ? [index] : [],
    );
    fc.assert(
      fc.property(fc.constantFrom(...measuredOrdinals), index => {
        const evidence = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
        const selected = evidence.candidateObservations[index];
        const measurement = selected.transcript.measurements[0];
        const changed =
          'total' in measurement
            ? {...measurement, total: measurement.total + 1}
            : {...measurement, positiveCount: measurement.positiveCount === 0 ? 1 : measurement.positiveCount - 1};
        const tampered = {
          ...evidence,
          candidateObservations: evidence.candidateObservations.map((item, ordinal) =>
            ordinal === index
              ? {
                  ...item,
                  transcript: {...item.transcript, measurements: [changed, ...item.transcript.measurements.slice(1)]},
                }
              : item,
          ),
        };
        expect(() => parseThreadnote5ReleaseEvidenceV1(tampered, fixture)).toThrow(/transcript digest does not match/u);
      }),
      {numRuns: 50},
    );
  });
});

function evaluate(evidence: Threadnote5ReleaseEvidenceV1, expectedBaselineSource?: unknown) {
  return evaluateWithManifest(evidence, evidence.capture.manifestHash, expectedBaselineSource);
}

function evaluateWithManifest(
  evidence: Threadnote5ReleaseEvidenceV1,
  expectedCaptureManifestSha256: string,
  expectedBaselineSource?: unknown,
  retainedSubsystemReceiptRecords?: unknown,
) {
  const baselineLedger =
    evidence.baseline.state === 'available'
      ? threadnote5BaselineTrialLedger(evidence.baseline.source, evidence.baseline.observations)
      : undefined;
  return evaluateThreadnote5ReleaseReadiness({
    ...(baselineLedger === undefined
      ? {}
      : {
          baselineTrialLedger: baselineLedger,
          expectedBaselineTrialLedgerSha256: threadnote5BaselineTrialLedgerHash(baselineLedger),
        }),
    evidence,
    expectedBaselineSource,
    expectedCandidateCommit: CANDIDATE.commit,
    expectedCandidateExecutableSha256: CANDIDATE.executableSha256,
    expectedCaptureManifestSha256,
    fixture,
    retainedSubsystemReceiptRecords,
  });
}

function evidenceBundle(input: {
  readonly baseline: Threadnote5BaselineV1;
  readonly mode: Threadnote5EvidenceClass;
}): Threadnote5ReleaseEvidenceV1 {
  const fixtureHash = threadnote5ReleaseReadinessFixtureHash(fixture);
  const candidateObservations = observationsFor(CANDIDATE, 'candidate');
  const adapterId =
    input.mode === 'fixture-replay'
      ? ('sealed-fixture-replay-v1' as const)
      : ('threadnote-5-local-task-loop-adapter-v1' as const);
  const manifest = threadnote5CaptureManifestForEvidence({
    adapterId,
    baseline: input.baseline,
    candidateObservations,
    fixtureHash,
    mode: input.mode,
  });
  return sealEvidence({
    baseline: input.baseline,
    candidate: CANDIDATE,
    candidateObservations,
    capture: {manifest, manifestHash: threadnote5CaptureManifestHash(manifest)},
    fixtureHash,
    suite: 'threadnote-5-release-readiness-evidence',
    version: 1,
  });
}

function observationsFor(source: Threadnote5SourceV1, variant: 'baseline' | 'candidate'): Threadnote5ObservationV1[] {
  const sourceHash = threadnote5SourceHash(source);
  let previousTranscriptDigest: string | null = null;
  return fixture.scenarios.map((contract, index) => {
    const transcript = {
      assertionResults: contract.requiredAssertions.map(id => ({id, observed: true})),
      measurements: contract.metricIds.map(id => measurementFor(id, variant)),
      outcome: 'passed' as const,
      reason: null,
    };
    const transcriptDigest = threadnote5ObservationTranscriptHash(transcript);
    const base = {
      attestation: {
        postRuntime: {executableSha256: source.executableSha256, sourceCommit: source.commit},
        preRuntime: {executableSha256: source.executableSha256, sourceCommit: source.commit},
        previousTranscriptDigest,
        subsystemReceipts: contract.subsystems.map(kind => ({
          digest: sha256HexSync(`${sourceHash}\0${contract.id}\0${kind}`),
          kind,
        })),
        transcriptDigest,
      },
      observationId: `obs_${sha256HexSync(`${sourceHash}\0${contract.id}\0${index}`).slice(0, 32)}`,
      scenario: contract.id,
      sourceHash,
      transcript,
      version: 1 as const,
    };
    previousTranscriptDigest = transcriptDigest;
    return {...base, receiptHash: threadnote5ObservationReceiptHash(base)};
  });
}

function measurementFor(id: Threadnote5ReleaseMetric, variant: 'baseline' | 'candidate'): Threadnote5MeasurementV1 {
  if (id === 'time-to-first-cited-correct-plan') {
    return {id, sampleCount: 10, total: variant === 'candidate' ? 300_000 : 600_000};
  }
  if (id === 'estimated-tokens-to-first-cited-correct-plan') {
    return {id, sampleCount: 10, total: variant === 'candidate' ? 10_000 : 14_000};
  }
  const positiveCount =
    id === 'wrong-memory-rate'
      ? variant === 'candidate'
        ? 0
        : 1
      : variant === 'candidate'
        ? 10
        : id === 'second-agent-reuse-rate'
          ? 5
          : 8;
  return {eligibleCount: 10, id, positiveCount};
}

function unavailableBaseline(): Threadnote5BaselineV1 {
  return {reason: 'not-captured', sourceFamily: '4.7.x', state: 'unavailable'};
}

function resealEvidence(evidence: Omit<Threadnote5ReleaseEvidenceV1, 'evidenceHash'>): Threadnote5ReleaseEvidenceV1 {
  const manifest = threadnote5CaptureManifestForEvidence({
    adapterId: evidence.capture.manifest.adapterId,
    baseline: evidence.baseline,
    candidateObservations: evidence.candidateObservations,
    fixtureHash: evidence.fixtureHash,
    mode: evidence.capture.manifest.mode,
  });
  return sealEvidence({
    ...evidence,
    capture: {manifest, manifestHash: threadnote5CaptureManifestHash(manifest)},
  });
}

function sealEvidence(evidence: Omit<Threadnote5ReleaseEvidenceV1, 'evidenceHash'>): Threadnote5ReleaseEvidenceV1 {
  return {...evidence, evidenceHash: threadnote5ReleaseEvidenceHash(evidence)};
}

function withoutEvidenceHash(
  evidence: Threadnote5ReleaseEvidenceV1,
): Omit<Threadnote5ReleaseEvidenceV1, 'evidenceHash'> {
  const {evidenceHash: _, ...rest} = evidence;
  return rest;
}

function withoutReceiptHash(observation: Threadnote5ObservationV1): Omit<Threadnote5ObservationV1, 'receiptHash'> {
  const {receiptHash: _, ...rest} = observation;
  return rest;
}

function rewriteScenarioMeasurements(
  evidence: Threadnote5ReleaseEvidenceV1,
  scenario: Threadnote5ObservationV1['scenario'],
  rewrite: (measurement: Threadnote5MeasurementV1) => Threadnote5MeasurementV1,
): Threadnote5ReleaseEvidenceV1 {
  const candidateObservations = rewriteObservationMeasurements(evidence.candidateObservations, scenario, rewrite);
  return resealEvidence({...withoutEvidenceHash(evidence), candidateObservations});
}

function rewriteBaselineScenarioMeasurements(
  evidence: Threadnote5ReleaseEvidenceV1,
  scenario: Threadnote5ObservationV1['scenario'],
  rewrite: (measurement: Threadnote5MeasurementV1) => Threadnote5MeasurementV1,
): Threadnote5ReleaseEvidenceV1 {
  if (evidence.baseline.state !== 'available') throw new Error('test baseline must be available');
  const baseline = {
    ...evidence.baseline,
    observations: rewriteObservationMeasurements(evidence.baseline.observations, scenario, rewrite),
  };
  return resealEvidence({...withoutEvidenceHash(evidence), baseline});
}

function rewriteObservationMeasurements(
  observations: readonly Threadnote5ObservationV1[],
  scenario: Threadnote5ObservationV1['scenario'],
  rewrite: (measurement: Threadnote5MeasurementV1) => Threadnote5MeasurementV1,
): Threadnote5ObservationV1[] {
  return rechainObservations(
    observations.map(observation => {
      if (observation.scenario !== scenario) return observation;
      const transcript = {
        ...observation.transcript,
        measurements: observation.transcript.measurements.map(rewrite),
      };
      const base = {
        ...withoutReceiptHash(observation),
        attestation: {
          ...observation.attestation,
          transcriptDigest: threadnote5ObservationTranscriptHash(transcript),
        },
        transcript,
      };
      return {...base, receiptHash: threadnote5ObservationReceiptHash(base)};
    }),
  );
}

function rechainObservations(observations: readonly Threadnote5ObservationV1[]): Threadnote5ObservationV1[] {
  let previousTranscriptDigest: string | null = null;
  return observations.map(observation => {
    const base = {
      ...withoutReceiptHash(observation),
      attestation: {...observation.attestation, previousTranscriptDigest},
    };
    previousTranscriptDigest = observation.attestation.transcriptDigest;
    return {...base, receiptHash: threadnote5ObservationReceiptHash(base)};
  });
}
