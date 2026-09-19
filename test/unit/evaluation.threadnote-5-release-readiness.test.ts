import {sha256HexSync} from '../../src/crypto/sha256.js';
import {
  APPROVED_THREADNOTE_5_BASELINE_COMPARISON,
  APPROVED_THREADNOTE_5_METRICS,
  APPROVED_THREADNOTE_5_SCENARIOS,
  THREADNOTE_5_BASELINE_COMPARABLE_METRICS,
  THREADNOTE_5_BASELINE_COMMIT,
  THREADNOTE_5_BASELINE_NOT_APPLICABLE_METRICS,
  parseThreadnote5BaselineEvidenceV1,
  parseThreadnote5ReleaseEvidenceV1,
  parseThreadnote5ReleaseReadinessFixtureV1,
  threadnote5BaselineEvidenceHash,
  threadnote5BaselineObservationHash,
  threadnote5CaptureManifestForEvidence,
  threadnote5CaptureManifestHash,
  threadnote5ObservationReceiptHash,
  threadnote5ObservationTranscriptHash,
  parseThreadnote5TrustedSourceV1,
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
import {threadnote5BaselineTrialLedgerHash} from '../../src/evaluation/threadnote-5-release-readiness-baseline-ledger.js';
import {
  THREADNOTE_5_LOCAL_RECEIPT_ADAPTERS,
  verifyThreadnote5LocalSubsystemReceipts,
} from '../../src/evaluation/threadnote-5-release-readiness-receipts.js';
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
  commit: THREADNOTE_5_BASELINE_COMMIT,
  executableSha256: '4'.repeat(64),
  id: 'threadnote-4.7.x',
  version: '4.7.8',
};

describe('Threadnote 5 release-readiness evidence', () => {
  it('declares Group 1 source adapters and their fail-closed external authority seams', () => {
    expect(THREADNOTE_5_LOCAL_RECEIPT_ADAPTERS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          acceptedScenarios: ['solo', 'output-budgets'],
          kind: 'context-brief',
          requiredAuthority: ['context-brief-plan-citation-authority'],
        }),
        expect.objectContaining({acceptedScenarios: ['dirty-worktree'], kind: 'context-check'}),
        expect.objectContaining({
          acceptedScenarios: ['projection-drift'],
          kind: 'guidance',
          requiredAuthority: ['guidance-stale-precondition-rejection-authority'],
        }),
        expect.objectContaining({
          acceptedScenarios: ['upgrade-downgrade'],
          kind: 'migration',
          requiredAuthority: ['migration-execution-authority'],
        }),
      ]),
    );
    expect(new Set(THREADNOTE_5_LOCAL_RECEIPT_ADAPTERS.map(adapter => adapter.kind)).size).toBe(
      THREADNOTE_5_LOCAL_RECEIPT_ADAPTERS.length,
    );
  });

  it('freezes the complete offline scenario, subsystem, and metric contract', () => {
    expect(fixture.baselineComparison).toEqual(APPROVED_THREADNOTE_5_BASELINE_COMPARISON);
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
    expect(() =>
      parseThreadnote5ReleaseReadinessFixtureV1({
        ...fixtureJson,
        baselineComparison: {
          ...fixtureJson.baselineComparison,
          comparableMetricIds: [...fixtureJson.baselineComparison.comparableMetricIds, 'setup-success-rate'],
        },
      }),
    ).toThrow(/baseline comparison policy differs/u);
  });

  it('keeps a trusted sealed replay and absent 4.7.x baseline explicitly unknown', () => {
    const evidence = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
    const result = evaluate(evidence);

    expect(result.scenarios.every(item => item.state === 'passed')).toBe(true);
    expect(result.metrics.every(item => item.thresholdPassed === true)).toBe(true);
    expect(
      result.metrics
        .filter(item => THREADNOTE_5_BASELINE_COMPARABLE_METRICS.includes(item.id as never))
        .every(item => item.baseline.state === 'unknown' && item.delta.state === 'unknown'),
    ).toBe(true);
    expect(
      result.metrics
        .filter(item => THREADNOTE_5_BASELINE_NOT_APPLICABLE_METRICS.includes(item.id as never))
        .every(item => item.baseline.state === 'not-applicable' && item.delta.state === 'not-applicable'),
    ).toBe(true);
    expect(result.evidence.captureManifestTrusted).toBe(true);
    expect(result.gate).toEqual({
      insufficiencies: [
        '4.7.8 baseline is unavailable: not-captured',
        'sealed fixture replay is not production release evidence',
      ],
      qualityFailures: [],
      status: 'unknown',
    });
  });

  it('keeps a passing candidate independent from trusted not-applicable baseline lanes', () => {
    const baseline = availableBaseline();
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
      ['setup-success-rate', 'not-applicable', false],
      ['wrong-memory-rate', 'observed', 'improved'],
      ['second-agent-reuse-rate', 'not-applicable', false],
      ['knowledge-delta-completion-rate', 'not-applicable', false],
      ['health-resolution-rate', 'not-applicable', false],
    ]);
    expect(result.metrics.every(item => item.thresholdPassed === true)).toBe(true);
    expect(result.gate.qualityFailures).toEqual([]);
  });

  it('keeps candidate threshold failures dominant when trusted baseline lanes are not applicable', () => {
    const baseline = availableBaseline();
    const failing = rewriteScenarioMeasurements(
      evidenceBundle({baseline, mode: 'fixture-replay'}),
      'solo',
      measurement =>
        measurement.id === 'setup-success-rate' && 'eligibleCount' in measurement
          ? {...measurement, positiveCount: 8}
          : measurement,
    );
    const result = evaluate(failing, BASELINE);

    expect(result.metrics.find(item => item.id === 'setup-success-rate')).toMatchObject({
      baseline: {state: 'not-applicable'},
      delta: {state: 'not-applicable'},
      thresholdPassed: false,
    });
    expect(result.gate.status).toBe('failed');
    expect(result.gate.qualityFailures).toContain('candidate metric setup-success-rate misses its minimum threshold');
  });

  it('keeps malformed retained receipt inputs unknown', () => {
    const baseline = availableBaseline();
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

  it('withholds every comparison when the baseline identity is absent or mismatched', () => {
    const baseline = availableBaseline();
    const evidence = evidenceBundle({baseline, mode: 'fixture-replay'});
    for (const expectedBaselineSource of [undefined, {...BASELINE, executableSha256: '9'.repeat(64)}]) {
      const result = evaluate(evidence, expectedBaselineSource);
      expect(
        result.metrics
          .filter(metric => THREADNOTE_5_BASELINE_COMPARABLE_METRICS.includes(metric.id as never))
          .every(metric => metric.baseline.state === 'unknown' && metric.delta.state === 'unknown'),
      ).toBe(true);
      expect(result.gate.insufficiencies).toContain(
        '4.7.8 baseline does not match its trusted identity, executable, and ledger',
      );
    }
  });

  it('rejects any baseline release other than exact Threadnote 4.7.8', () => {
    for (const source of [
      {...BASELINE, commit: '8'.repeat(40)},
      {...BASELINE, version: '4.7.7'},
      {...BASELINE, version: '4.7.9'},
    ]) {
      expect(() => parseThreadnote5TrustedSourceV1(source, 'baseline')).toThrow(/exact 4\.7\.8 release/u);
    }
  });

  it('rejects observer or judge provenance that impersonates the baseline source identity', () => {
    const evidence = availableBaseline().evidence;
    const {evidenceHash: _, ...unsealedEvidence} = evidence;
    for (const role of ['judgeId', 'observerId'] as const) {
      const [first, ...remaining] = evidence.observations;
      const {observationHash: _observationHash, ...unsealed} = first;
      const changed = {
        ...unsealed,
        provenance: {...unsealed.provenance, [role]: evidence.source.id},
      };
      const observations = [{...changed, observationHash: threadnote5BaselineObservationHash(changed)}, ...remaining];
      const projection = {...unsealedEvidence, observations};
      expect(() =>
        parseThreadnote5BaselineEvidenceV1({
          ...projection,
          evidenceHash: threadnote5BaselineEvidenceHash(projection),
        }),
      ).toThrow(/source, observer, and judge identities/u);
    }
  });

  it('requires an independently supplied 4.7 trial-ledger hash when a ledger is requested', () => {
    const baseline = availableBaseline();
    const evidence = evidenceBundle({baseline, mode: 'fixture-replay'});
    const ledger = baseline.evidence;
    const trusted = evaluateThreadnote5ReleaseReadiness({
      baselineTrialLedger: {ledger, ledgerHash: ledger.evidenceHash, version: 2},
      evidence,
      expectedBaselineSource: BASELINE,
      expectedBaselineTrialLedgerSha256: ledger.evidenceHash,
      expectedCandidateCommit: CANDIDATE.commit,
      expectedCandidateExecutableSha256: CANDIDATE.executableSha256,
      expectedCaptureManifestSha256: evidence.capture.manifestHash,
      fixture,
    });
    expect(
      trusted.metrics
        .filter(metric => THREADNOTE_5_BASELINE_COMPARABLE_METRICS.includes(metric.id as never))
        .every(metric => metric.baseline.state === 'observed' && metric.delta.state === 'observed'),
    ).toBe(true);
    expect(
      trusted.metrics
        .filter(metric => THREADNOTE_5_BASELINE_NOT_APPLICABLE_METRICS.includes(metric.id as never))
        .every(metric => metric.baseline.state === 'not-applicable' && metric.delta.state === 'not-applicable'),
    ).toBe(true);

    const missing = evaluateThreadnote5ReleaseReadiness({
      evidence,
      expectedBaselineSource: BASELINE,
      expectedCandidateCommit: CANDIDATE.commit,
      expectedCandidateExecutableSha256: CANDIDATE.executableSha256,
      expectedCaptureManifestSha256: evidence.capture.manifestHash,
      fixture,
    });
    expect(
      missing.metrics
        .filter(metric => THREADNOTE_5_BASELINE_COMPARABLE_METRICS.includes(metric.id as never))
        .every(metric => metric.baseline.state === 'unknown'),
    ).toBe(true);

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
    expect(
      untrusted.metrics
        .filter(metric => THREADNOTE_5_BASELINE_COMPARABLE_METRICS.includes(metric.id as never))
        .every(metric => metric.baseline.state === 'unknown'),
    ).toBe(true);
  });

  it('continues to accept the historical baseline trial-ledger v1 when its metrics match', () => {
    const baseline = availableBaseline();
    const evidence = evidenceBundle({baseline, mode: 'fixture-replay'});
    const ledger = legacyLedgerFor(baseline.evidence);
    const ledgerHash = threadnote5BaselineTrialLedgerHash(ledger);
    const result = evaluateThreadnote5ReleaseReadiness({
      baselineTrialLedger: {ledger, ledgerHash, version: 1},
      evidence,
      expectedBaselineSource: BASELINE,
      expectedBaselineTrialLedgerSha256: ledgerHash,
      expectedCandidateCommit: CANDIDATE.commit,
      expectedCandidateExecutableSha256: CANDIDATE.executableSha256,
      expectedCaptureManifestSha256: evidence.capture.manifestHash,
      fixture,
    });

    expect(
      result.metrics
        .filter(metric => THREADNOTE_5_BASELINE_COMPARABLE_METRICS.includes(metric.id as never))
        .every(metric => metric.baseline.state === 'observed'),
    ).toBe(true);
  });

  it('rejects baseline evidence wrapped with the historical v1 label and a trial ledger wrapped with v2', () => {
    const baseline = availableBaseline();
    const evidence = evidenceBundle({baseline, mode: 'fixture-replay'});
    const legacyLedger = legacyLedgerFor(baseline.evidence);
    const legacyHash = threadnote5BaselineTrialLedgerHash(legacyLedger);
    const crossLabeled = [
      {
        baselineTrialLedger: {ledger: baseline.evidence, ledgerHash: baseline.evidence.evidenceHash, version: 1},
        expectedBaselineTrialLedgerSha256: baseline.evidence.evidenceHash,
      },
      {
        baselineTrialLedger: {ledger: legacyLedger, ledgerHash: legacyHash, version: 2},
        expectedBaselineTrialLedgerSha256: legacyHash,
      },
    ];

    for (const ledger of crossLabeled) {
      const result = evaluateThreadnote5ReleaseReadiness({
        ...ledger,
        evidence,
        expectedBaselineSource: BASELINE,
        expectedCandidateCommit: CANDIDATE.commit,
        expectedCandidateExecutableSha256: CANDIDATE.executableSha256,
        expectedCaptureManifestSha256: evidence.capture.manifestHash,
        fixture,
      });
      expect(
        result.metrics
          .filter(metric => THREADNOTE_5_BASELINE_COMPARABLE_METRICS.includes(metric.id as never))
          .every(metric => metric.baseline.state === 'unknown'),
      ).toBe(true);
    }
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
    expect(result.metrics.every(metric => metric.candidate.state === 'unknown')).toBe(true);
    expect(
      result.metrics
        .filter(metric => THREADNOTE_5_BASELINE_COMPARABLE_METRICS.includes(metric.id as never))
        .every(metric => metric.delta.state === 'unknown'),
    ).toBe(true);
    expect(
      result.metrics
        .filter(metric => THREADNOTE_5_BASELINE_NOT_APPLICABLE_METRICS.includes(metric.id as never))
        .every(metric => metric.delta.state === 'not-applicable'),
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

  it('accepts only commit-bound prerelease local candidate versions', () => {
    const evidence = evidenceBundle({baseline: unavailableBaseline(), mode: 'fixture-replay'});
    const prerelease = `5.0.0-beta.1.local.g${CANDIDATE.commit}`;
    expect(
      parseThreadnote5ReleaseEvidenceV1(withCandidateVersion(evidence, prerelease), fixture).candidate.version,
    ).toBe(prerelease);
    for (const version of [
      `5.0.0-beta.1.local.g${'9'.repeat(40)}`,
      `5.0.1-beta.1.local.g${CANDIDATE.commit}`,
      `5.0.0-beta.1-local.g${CANDIDATE.commit}`,
      `5.0.0-alpha.1.local.g${CANDIDATE.commit}`,
      `5.0.0-beta.2.local.g${CANDIDATE.commit}`,
      `5.0.0-rc.1.local.g${CANDIDATE.commit}`,
      `5.0.0-preview.local.g${CANDIDATE.commit}`,
    ]) {
      expect(() => parseThreadnote5ReleaseEvidenceV1(withCandidateVersion(evidence, version), fixture)).toThrow(
        /candidate version is invalid/u,
      );
    }
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
  const baselineLedger = evidence.baseline.state === 'available' ? evidence.baseline.evidence : undefined;
  return evaluateThreadnote5ReleaseReadiness({
    ...(baselineLedger === undefined
      ? {}
      : {
          baselineTrialLedger: baselineLedger,
          expectedBaselineTrialLedgerSha256: baselineLedger.evidenceHash,
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

function observationsFor(source: Threadnote5SourceV1, variant: 'candidate'): Threadnote5ObservationV1[] {
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

function measurementFor(id: Threadnote5ReleaseMetric, _variant: 'candidate'): Threadnote5MeasurementV1 {
  if (id === 'time-to-first-cited-correct-plan') {
    return {id, sampleCount: 10, total: 300_000};
  }
  if (id === 'estimated-tokens-to-first-cited-correct-plan') {
    return {id, sampleCount: 10, total: 10_000};
  }
  const positiveCount = id === 'wrong-memory-rate' ? 0 : 10;
  return {eligibleCount: 10, id, positiveCount};
}

function unavailableBaseline(): Threadnote5BaselineV1 {
  return {reason: 'not-captured', sourceFamily: '4.7.x', state: 'unavailable'};
}

function availableBaseline(): Extract<Threadnote5BaselineV1, {readonly state: 'available'}> {
  const runtime = {executableSha256: BASELINE.executableSha256, sourceCommit: BASELINE.commit};
  const observations = Array.from({length: 10}, (_, index) => {
    const observation = {
      capturePlanSha256: '5'.repeat(64),
      contextBriefOutputSha256: sha256HexSync(`baseline-output-${index}`),
      estimatedTokensToFirstCitedCorrectPlan: 1_400,
      firstCitedPlanIndependentlyJudgedCorrect: true as const,
      firstCitedPlanSha256: sha256HexSync(`baseline-plan-${index}`),
      provenance: {
        judgeExecutableSha256: '7'.repeat(64),
        judgeId: 'independent-plan-judge',
        judgeProtocol: 'threadnote-5-baseline-judge' as const,
        judgeRequestSha256: sha256HexSync(`baseline-judge-request-${index}`),
        judgeResponseSha256: sha256HexSync(`baseline-judge-response-${index}`),
        judgmentReceiptSha256: sha256HexSync(`baseline-judgment-${index}`),
        measurementReceiptSha256: sha256HexSync(`baseline-measurement-${index}`),
        observerExecutableSha256: '6'.repeat(64),
        observerId: 'independent-agent-harness',
        observerProtocol: 'threadnote-5-baseline-observer' as const,
        observerRequestSha256: sha256HexSync(`baseline-request-${index}`),
        observerResponseSha256: sha256HexSync(`baseline-response-${index}`),
        version: 1 as const,
      },
      postRuntime: runtime,
      preRuntime: runtime,
      timeToFirstCitedCorrectPlanMilliseconds: 60_000,
      trialId: `trial-${index}`,
      wrongMemoryEligible: true,
      wrongMemoryObserved: index === 0,
    };
    return {...observation, observationHash: threadnote5BaselineObservationHash(observation)};
  });
  const projection = {
    observations,
    source: BASELINE,
    suite: 'threadnote-5-baseline-evidence' as const,
    version: 1 as const,
  };
  return {evidence: {...projection, evidenceHash: threadnote5BaselineEvidenceHash(projection)}, state: 'available'};
}

function legacyLedgerFor(evidence: Extract<Threadnote5BaselineV1, {readonly state: 'available'}>['evidence']) {
  return {
    observations: evidence.observations
      .map((observation, index) => ({
        measurements: [
          {
            id: 'time-to-first-cited-correct-plan' as const,
            sampleCount: 1,
            total: observation.timeToFirstCitedCorrectPlanMilliseconds,
          },
          {
            id: 'estimated-tokens-to-first-cited-correct-plan' as const,
            sampleCount: 1,
            total: observation.estimatedTokensToFirstCitedCorrectPlan,
          },
          {
            eligibleCount: observation.wrongMemoryEligible ? 1 : 0,
            id: 'wrong-memory-rate' as const,
            positiveCount: observation.wrongMemoryObserved ? 1 : 0,
          },
        ],
        outcome: 'passed' as const,
        receiptHash: sha256HexSync(`legacy-receipt-${index}`),
        scenario: APPROVED_THREADNOTE_5_SCENARIOS[index].id,
        transcriptDigest: sha256HexSync(`legacy-transcript-${index}`),
      }))
      .sort((left, right) =>
        left.scenario === right.scenario
          ? left.receiptHash.localeCompare(right.receiptHash)
          : left.scenario.localeCompare(right.scenario),
      ),
    source: evidence.source,
    version: 1 as const,
  };
}

function resealEvidence(evidence: Omit<Threadnote5ReleaseEvidenceV1, 'evidenceHash'>): Threadnote5ReleaseEvidenceV1 {
  const manifest = threadnote5CaptureManifestForEvidence({
    adapterId: evidence.capture.manifest.adapterId,
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

function withCandidateVersion(evidence: Threadnote5ReleaseEvidenceV1, version: string): Threadnote5ReleaseEvidenceV1 {
  const candidate = {...evidence.candidate, version};
  const sourceHash = threadnote5SourceHash(candidate);
  const candidateObservations = evidence.candidateObservations.map(observation => {
    const base = {...withoutReceiptHash(observation), sourceHash};
    return {...base, receiptHash: threadnote5ObservationReceiptHash(base)};
  });
  return resealEvidence({...withoutEvidenceHash(evidence), candidate, candidateObservations});
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
