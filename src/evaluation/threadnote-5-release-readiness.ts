import {
  parseThreadnote5ReleaseEvidenceV1,
  parseThreadnote5ReleaseReadinessFixtureV1,
  parseThreadnote5TrustedSourceV1,
  threadnote5ReleaseReadinessFixtureHash,
  type Threadnote5MeasurementV1,
  type Threadnote5MetricDefinitionV1,
  type Threadnote5ObservationV1,
  type Threadnote5ReleaseMetric,
  type Threadnote5ReleaseReadinessFixtureV1,
  type Threadnote5ReleaseScenario,
  type Threadnote5ScenarioContractV1,
  type Threadnote5SourceV1,
} from './threadnote-5-release-readiness-contract.js';

export interface Threadnote5ObservedMetricV1 {
  readonly sourceVersion: string;
  readonly state: 'observed';
  readonly value: number;
}

export type Threadnote5UnknownMetricReason =
  'baseline-unavailable' | 'baseline-untrusted' | 'capture-untrusted' | 'source-incomplete';

export interface Threadnote5UnknownMetricV1 {
  readonly reason: Threadnote5UnknownMetricReason;
  readonly sourceVersion: string;
  readonly state: 'unknown';
}

export type Threadnote5MetricValueV1 = Threadnote5ObservedMetricV1 | Threadnote5UnknownMetricV1;

export interface Threadnote5MetricComparisonV1 {
  readonly baseline: Threadnote5MetricValueV1;
  readonly candidate: Threadnote5MetricValueV1;
  readonly delta:
    | {
        readonly classification: 'improved' | 'regressed' | 'unchanged';
        readonly state: 'observed';
        readonly value: number;
      }
    | {readonly reason: Threadnote5UnknownMetricReason; readonly state: 'unknown'};
  readonly direction: 'higher' | 'lower';
  readonly id: Threadnote5ReleaseMetric;
  readonly threshold: number;
  readonly thresholdKind: 'maximum' | 'minimum';
  readonly thresholdPassed: boolean | null;
  readonly unit: 'milliseconds' | 'ratio' | 'tokens';
}

export interface Threadnote5ReleaseReadinessResultV1 {
  readonly candidate: Threadnote5SourceV1;
  readonly evidence: {
    readonly captureManifestTrusted: boolean;
    readonly captureMode: 'fixture-replay' | 'release-candidate';
    readonly hash: string;
  };
  readonly fixture: {readonly hash: string; readonly scenarioCount: number};
  readonly gate: {
    readonly insufficiencies: readonly string[];
    readonly qualityFailures: readonly string[];
    readonly status: 'failed' | 'passed' | 'unknown';
  };
  readonly metrics: readonly Threadnote5MetricComparisonV1[];
  readonly scenarios: readonly {
    readonly id: Threadnote5ReleaseScenario;
    readonly observationReceiptHash: string | null;
    readonly state: 'failed' | 'missing' | 'passed' | 'unknown';
  }[];
  readonly version: 1;
}

export function evaluateThreadnote5ReleaseReadiness(input: {
  readonly evidence: unknown;
  readonly expectedBaselineSource?: unknown;
  readonly expectedCandidateCommit: string;
  readonly expectedCandidateExecutableSha256: string;
  readonly expectedCaptureManifestSha256: string;
  readonly fixture: unknown;
}): Threadnote5ReleaseReadinessResultV1 {
  const fixture = parseThreadnote5ReleaseReadinessFixtureV1(input.fixture);
  const evidence = parseThreadnote5ReleaseEvidenceV1(input.evidence, fixture);
  assertExpectedCandidate(evidence.candidate, input);

  const qualityFailures: string[] = [];
  const insufficiencies: string[] = [];
  const captureTrusted = evidence.capture.manifestHash === input.expectedCaptureManifestSha256;
  if (!captureTrusted) qualityFailures.push('capture manifest does not match the trusted expected hash');
  const scenarios = fixture.scenarios.map(contract => {
    const observation = evidence.candidateObservations.find(item => item.scenario === contract.id);
    const state: 'failed' | 'missing' | 'passed' | 'unknown' = captureTrusted
      ? observationState(contract, observation)
      : 'unknown';
    if (state !== 'passed') qualityFailures.push(`candidate scenario ${contract.id} is ${state}`);
    return {id: contract.id, observationReceiptHash: observation?.receiptHash ?? null, state};
  });

  const candidateMetrics = captureTrusted
    ? aggregateMetrics(fixture, evidence.candidate, evidence.candidateObservations)
    : unknownMetrics(fixture, evidence.candidate.version, 'capture-untrusted');
  const expectedBaseline =
    input.expectedBaselineSource === undefined
      ? undefined
      : parseThreadnote5TrustedSourceV1(input.expectedBaselineSource, 'baseline');
  const baselineTrusted =
    evidence.baseline.state === 'available' &&
    expectedBaseline !== undefined &&
    sameSource(evidence.baseline.source, expectedBaseline);
  const baselineMetrics =
    evidence.baseline.state === 'unavailable'
      ? unknownMetrics(fixture, '4.7.x', 'baseline-unavailable')
      : captureTrusted && baselineTrusted
        ? aggregateMetrics(fixture, evidence.baseline.source, evidence.baseline.observations)
        : unknownMetrics(fixture, '4.7.x', captureTrusted ? 'baseline-untrusted' : 'capture-untrusted');
  const metrics = fixture.metrics.map(definition => {
    const candidate = candidateMetrics.get(definition.id)!;
    const baseline = baselineMetrics.get(definition.id)!;
    const thresholdPassed = candidate.state === 'observed' ? passesThreshold(definition, candidate.value) : null;
    if (thresholdPassed !== true) {
      qualityFailures.push(
        thresholdPassed === false
          ? `candidate metric ${definition.id} misses its ${definition.thresholdKind} threshold`
          : `candidate metric ${definition.id} is unknown`,
      );
    }
    return {
      baseline,
      candidate,
      delta: compareMetric(definition, baseline, candidate),
      direction: definition.direction,
      id: definition.id,
      threshold: definition.threshold,
      thresholdKind: definition.thresholdKind,
      thresholdPassed,
      unit: definition.unit,
    };
  });

  if (evidence.capture.manifest.mode !== 'release-candidate') {
    insufficiencies.push('sealed fixture replay is not production release evidence');
  } else {
    insufficiencies.push('production subsystem receipt verification is not implemented');
  }
  if (evidence.baseline.state === 'unavailable') {
    insufficiencies.push(`4.7.x baseline is unavailable: ${evidence.baseline.reason}`);
  } else if (!baselineTrusted) {
    insufficiencies.push('4.7.x baseline does not match a trusted expected source identity');
  } else {
    for (const [id, metric] of baselineMetrics) {
      if (metric.state === 'unknown') insufficiencies.push(`4.7.x baseline metric is unknown: ${id}`);
    }
  }
  const uniqueFailures = [...new Set(qualityFailures)].sort();
  const uniqueInsufficiencies = [...new Set(insufficiencies)].sort();
  return {
    candidate: evidence.candidate,
    evidence: {
      captureManifestTrusted: captureTrusted,
      captureMode: evidence.capture.manifest.mode,
      hash: evidence.evidenceHash,
    },
    fixture: {hash: threadnote5ReleaseReadinessFixtureHash(fixture), scenarioCount: fixture.scenarios.length},
    gate: {
      insufficiencies: uniqueInsufficiencies,
      qualityFailures: uniqueFailures,
      status: uniqueFailures.length > 0 ? 'failed' : uniqueInsufficiencies.length > 0 ? 'unknown' : 'passed',
    },
    metrics,
    scenarios,
    version: 1,
  };
}

function aggregateMetrics(
  fixture: Threadnote5ReleaseReadinessFixtureV1,
  source: Threadnote5SourceV1,
  observations: readonly Threadnote5ObservationV1[],
): ReadonlyMap<Threadnote5ReleaseMetric, Threadnote5MetricValueV1> {
  return new Map(
    fixture.metrics.map(definition => {
      const requiredScenarios = fixture.scenarios.filter(scenario => scenario.metricIds.includes(definition.id));
      const selected = requiredScenarios.map(contract => ({
        contract,
        observation: observations.find(item => item.scenario === contract.id),
      }));
      const measurements = selected.map(({contract, observation}) => {
        if (observation?.transcript.outcome !== 'passed') return undefined;
        const measurement = observation.transcript.measurements.find(item => item.id === definition.id);
        const minimum = contract.metricMinimums.find(item => item.id === definition.id);
        if (
          measurement === undefined ||
          minimum === undefined ||
          measurementEligibleCount(measurement) < minimum.minimumEligibleCount
        ) {
          return undefined;
        }
        return measurement;
      });
      if (measurements.some(measurement => measurement === undefined)) {
        return [
          definition.id,
          {
            reason: 'source-incomplete',
            sourceVersion: source.version,
            state: 'unknown',
          } satisfies Threadnote5UnknownMetricV1,
        ] as const;
      }
      return [
        definition.id,
        observedMetric(source.version, definition, measurements as Threadnote5MeasurementV1[]),
      ] as const;
    }),
  );
}

function observationState(
  contract: Threadnote5ScenarioContractV1,
  observation: Threadnote5ObservationV1 | undefined,
): 'failed' | 'missing' | 'passed' | 'unknown' {
  if (observation === undefined) return 'missing';
  if (observation.transcript.outcome !== 'passed') return observation.transcript.outcome;
  const measurements = new Map(observation.transcript.measurements.map(measurement => [measurement.id, measurement]));
  const hasMinimumTrials = contract.metricMinimums.every(minimum => {
    const measurement = measurements.get(minimum.id);
    return measurement !== undefined && measurementEligibleCount(measurement) >= minimum.minimumEligibleCount;
  });
  return hasMinimumTrials ? 'passed' : 'unknown';
}

function measurementEligibleCount(measurement: Threadnote5MeasurementV1): number {
  return 'sampleCount' in measurement ? measurement.sampleCount : measurement.eligibleCount;
}

function observedMetric(
  sourceVersion: string,
  definition: Threadnote5MetricDefinitionV1,
  measurements: readonly Threadnote5MeasurementV1[],
): Threadnote5MetricValueV1 {
  if (definition.kind === 'mean') {
    const aggregate = measurements.reduce(
      (result, measurement) => ({
        count: result.count + ('sampleCount' in measurement ? measurement.sampleCount : 0),
        total: result.total + ('total' in measurement ? measurement.total : 0),
      }),
      {count: 0, total: 0},
    );
    if (aggregate.count === 0) return {reason: 'source-incomplete', sourceVersion, state: 'unknown'};
    return {sourceVersion, state: 'observed', value: aggregate.total / aggregate.count};
  }
  const aggregate = measurements.reduce(
    (result, measurement) => ({
      eligible: result.eligible + ('eligibleCount' in measurement ? measurement.eligibleCount : 0),
      positive: result.positive + ('positiveCount' in measurement ? measurement.positiveCount : 0),
    }),
    {eligible: 0, positive: 0},
  );
  if (aggregate.eligible === 0) return {reason: 'source-incomplete', sourceVersion, state: 'unknown'};
  return {sourceVersion, state: 'observed', value: aggregate.positive / aggregate.eligible};
}

function unknownMetrics(
  fixture: Threadnote5ReleaseReadinessFixtureV1,
  sourceVersion: string,
  reason: Threadnote5UnknownMetricReason,
): ReadonlyMap<Threadnote5ReleaseMetric, Threadnote5MetricValueV1> {
  return new Map(
    fixture.metrics.map(definition => [
      definition.id,
      {reason, sourceVersion, state: 'unknown'} satisfies Threadnote5UnknownMetricV1,
    ]),
  );
}

function compareMetric(
  definition: Threadnote5MetricDefinitionV1,
  baseline: Threadnote5MetricValueV1,
  candidate: Threadnote5MetricValueV1,
): Threadnote5MetricComparisonV1['delta'] {
  if (baseline.state === 'unknown' || candidate.state === 'unknown') {
    return {
      reason:
        baseline.state === 'unknown'
          ? baseline.reason
          : candidate.state === 'unknown'
            ? candidate.reason
            : 'source-incomplete',
      state: 'unknown',
    };
  }
  const value = candidate.value - baseline.value;
  const classification =
    value === 0
      ? 'unchanged'
      : (definition.direction === 'higher' && value > 0) || (definition.direction === 'lower' && value < 0)
        ? 'improved'
        : 'regressed';
  return {classification, state: 'observed', value};
}

function passesThreshold(definition: Threadnote5MetricDefinitionV1, value: number): boolean {
  return definition.thresholdKind === 'maximum' ? value <= definition.threshold : value >= definition.threshold;
}

function assertExpectedCandidate(
  candidate: Threadnote5SourceV1,
  expected: {readonly expectedCandidateCommit: string; readonly expectedCandidateExecutableSha256: string},
): void {
  if (candidate.commit !== expected.expectedCandidateCommit) {
    throw new Error('Release-readiness evidence candidate commit does not match the requested candidate.');
  }
  if (candidate.executableSha256 !== expected.expectedCandidateExecutableSha256) {
    throw new Error('Release-readiness evidence executable hash does not match the requested candidate.');
  }
}

function sameSource(left: Threadnote5SourceV1, right: Threadnote5SourceV1): boolean {
  return (
    left.commit === right.commit &&
    left.executableSha256 === right.executableSha256 &&
    left.id === right.id &&
    left.version === right.version
  );
}
