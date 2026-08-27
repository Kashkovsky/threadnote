import {Schema} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {benchmarkMeasurement, type BenchmarkMeasurementV1} from './benchmark.js';

export const CONTEXT_BRIEF_CITATION_EVALUATION_VERSION = 1 as const;
export const CONTEXT_BRIEF_CITATION_EVALUATION_MAXIMUM_SCENARIOS = 128 as const;
export const CONTEXT_BRIEF_CITATION_EVALUATION_MAXIMUM_CITATIONS_PER_SCENARIO = 8 as const;
export const CONTEXT_BRIEF_CITATION_EVALUATION_MINIMUM_PERFORMANCE_SAMPLES = 5 as const;
export const CONTEXT_BRIEF_CITATION_EVALUATION_MAXIMUM_PERFORMANCE_SAMPLES = 64 as const;

export const CONTEXT_BRIEF_CITATION_STATUSES = ['exact', 'relocated', 'changed', 'deleted', 'unknown'] as const;
export const CONTEXT_BRIEF_CITATION_FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
export const CONTEXT_BRIEF_CITATION_WARNINGS = [
  'none',
  'stale-link',
  'stale-evidence',
  'unknown-evidence',
  'legacy-stale',
] as const;
export const CONTEXT_BRIEF_CITATION_SNAPSHOT_STATES = [
  'current-complete',
  'current-incomplete',
  'stale',
  'deferred',
  'missing',
  'failed',
  'unsupported',
] as const;
export const CONTEXT_BRIEF_CITATION_PERFORMANCE_PROFILE_IDS = ['local-100k', 'workset-50', 'workset-128'] as const;

export type ContextBriefCitationEvaluationStatus = (typeof CONTEXT_BRIEF_CITATION_STATUSES)[number];
export type ContextBriefCitationEvaluationFreshness = (typeof CONTEXT_BRIEF_CITATION_FRESHNESS)[number];
export type ContextBriefCitationEvaluationWarning = (typeof CONTEXT_BRIEF_CITATION_WARNINGS)[number];
export type ContextBriefCitationEvaluationSnapshotState = (typeof CONTEXT_BRIEF_CITATION_SNAPSHOT_STATES)[number];
export type ContextBriefCitationPerformanceProfileId = (typeof CONTEXT_BRIEF_CITATION_PERFORMANCE_PROFILE_IDS)[number];

export interface ContextBriefCitationEvaluationObservationV1 {
  readonly citationId: string;
  readonly expectedStatus: ContextBriefCitationEvaluationStatus;
  readonly observedStatus: ContextBriefCitationEvaluationStatus;
  /** Supported cases are expected to resolve authoritatively under complete current coverage. */
  readonly support: 'supported' | 'unsupported';
}

export interface ContextBriefCitationCaptureObservationV1 {
  readonly eligible: boolean;
  readonly milliseconds: number;
  readonly succeeded: boolean;
}

export interface ContextBriefCitationEvaluationScenarioV1 {
  readonly capture: ContextBriefCitationCaptureObservationV1;
  readonly citations: readonly ContextBriefCitationEvaluationObservationV1[];
  readonly crossRepositoryLeakage: boolean;
  readonly equivalenceKey?: string;
  readonly execution: 'clean' | 'incremental';
  readonly expectedFreshness: ContextBriefCitationEvaluationFreshness;
  readonly expectedWarning: ContextBriefCitationEvaluationWarning;
  readonly id: string;
  readonly legacy: boolean;
  readonly observedFreshness: ContextBriefCitationEvaluationFreshness;
  readonly observedWarning: ContextBriefCitationEvaluationWarning;
  readonly snapshotState: ContextBriefCitationEvaluationSnapshotState;
}

export interface ContextBriefCitationPerformanceSampleV1 {
  readonly addedPeakRssBytes: number;
  readonly cacheHits: number;
  readonly captureMilliseconds: number;
  readonly citationValidationMilliseconds: number;
  readonly citationsCaptured: number;
  readonly citationsValidated: number;
  readonly coldBuilds: number;
  readonly contextBriefMilliseconds: number;
  readonly databaseStatements: number;
  readonly estimatedTokens: number;
  readonly maintenanceOperations: number;
  readonly repositoryDatabasesOpened: number;
  readonly repositoriesValidated: number;
  readonly responseBytes: number;
  readonly sampleId: string;
}

export interface ContextBriefCitationPerformanceProfileV1 {
  readonly id: ContextBriefCitationPerformanceProfileId;
  readonly samples: readonly ContextBriefCitationPerformanceSampleV1[];
  readonly shape: {
    readonly citations: number;
    readonly citedRepositories: number;
    readonly repositoryMembers: number;
    readonly symbols?: number;
  };
}

export interface ContextBriefCitationEvaluationFixtureV1 {
  readonly id: string;
  readonly performanceProfiles: readonly ContextBriefCitationPerformanceProfileV1[];
  readonly scenarios: readonly ContextBriefCitationEvaluationScenarioV1[];
  readonly version: typeof CONTEXT_BRIEF_CITATION_EVALUATION_VERSION;
}

export interface ContextBriefCitationStatusMetricV1 {
  readonly expected: number;
  readonly f1: number;
  readonly observed: number;
  readonly precision: number;
  readonly recall: number;
  readonly status: ContextBriefCitationEvaluationStatus;
}

export interface ContextBriefCitationConfusionRowV1 {
  readonly expectedStatus: ContextBriefCitationEvaluationStatus;
  readonly observed: Readonly<Record<ContextBriefCitationEvaluationStatus, number>>;
}

export interface ContextBriefCitationEvaluationMetricsV1 {
  readonly aggregateFreshnessAccuracy: number;
  readonly captureCoverage: number;
  readonly changedDeletedRecall: number;
  readonly citationCount: number;
  readonly confusionMatrix: readonly ContextBriefCitationConfusionRowV1[];
  readonly crossRepositoryLeakageCount: number;
  readonly falseDeletedFromIncompleteCoverageCount: number;
  readonly falseFreshCitationCount: number;
  readonly falseFreshMemoryCount: number;
  readonly falseFreshRiskCount: number;
  readonly falseStaleMemoryCount: number;
  readonly incrementalCleanMismatchCount: number;
  readonly legacyParity: number;
  readonly macroF1: number;
  readonly nonCurrentAuthoritativeStatusCount: number;
  readonly relocationPrecision: number;
  readonly relocationRecall: number;
  readonly scenarioCount: number;
  readonly statusMetrics: readonly ContextBriefCitationStatusMetricV1[];
  readonly supportedUnknownRate: number;
  readonly unsupportedUnknownRate: number;
  readonly warningAccuracy: number;
  readonly warningCoverage: number;
}

export interface ContextBriefCitationPerformanceMetricsV1 {
  readonly addedPeakRssBytesMaximum: number;
  readonly cacheHitRate: number;
  readonly captureMilliseconds: BenchmarkMeasurementV1;
  readonly citationValidationMilliseconds: BenchmarkMeasurementV1;
  readonly coldBuilds: number;
  readonly contextBriefMilliseconds: BenchmarkMeasurementV1;
  readonly databaseStatements: number;
  readonly estimatedTokensMaximum: number;
  readonly id: ContextBriefCitationPerformanceProfileId;
  readonly maintenanceOperations: number;
  readonly maximumDatabaseOpenOverage: number;
  readonly responseBytesMaximum: number;
  readonly sampleCount: number;
}

export interface ContextBriefCitationReleaseGateV1 {
  readonly failures: readonly string[];
  readonly passed: boolean;
  readonly version: typeof CONTEXT_BRIEF_CITATION_EVALUATION_VERSION;
}

export interface ContextBriefCitationEvaluationResultV1 {
  readonly fixture: {
    readonly citationCount: number;
    readonly hash: string;
    readonly id: string;
    readonly performanceSampleCount: number;
    readonly scenarioCount: number;
  };
  readonly gate: ContextBriefCitationReleaseGateV1;
  readonly performance: readonly ContextBriefCitationPerformanceMetricsV1[];
  readonly quality: ContextBriefCitationEvaluationMetricsV1;
  readonly version: typeof CONTEXT_BRIEF_CITATION_EVALUATION_VERSION;
}

interface PerformanceProfileContract {
  readonly maximumAddedPeakRssBytes: number;
  readonly maximumCitationValidationP95Milliseconds: number;
  readonly maximumContextBriefP95Milliseconds: number;
  readonly maximumEstimatedTokens: number;
  readonly shape: ContextBriefCitationPerformanceProfileV1['shape'];
}

export const CONTEXT_BRIEF_CITATION_PERFORMANCE_CONTRACTS: Readonly<
  Record<ContextBriefCitationPerformanceProfileId, PerformanceProfileContract>
> = {
  'local-100k': {
    maximumAddedPeakRssBytes: 64 * 1024 * 1024,
    maximumCitationValidationP95Milliseconds: 250,
    maximumContextBriefP95Milliseconds: 1_500,
    maximumEstimatedTokens: 1_500,
    shape: {citations: 96, citedRepositories: 1, repositoryMembers: 1, symbols: 100_000},
  },
  'workset-50': {
    maximumAddedPeakRssBytes: 64 * 1024 * 1024,
    maximumCitationValidationP95Milliseconds: 500,
    maximumContextBriefP95Milliseconds: 3_000,
    maximumEstimatedTokens: 1_500,
    shape: {citations: 64, citedRepositories: 16, repositoryMembers: 50},
  },
  'workset-128': {
    maximumAddedPeakRssBytes: 64 * 1024 * 1024,
    maximumCitationValidationP95Milliseconds: 1_000,
    maximumContextBriefP95Milliseconds: 5_000,
    maximumEstimatedTokens: 1_500,
    shape: {citations: 96, citedRepositories: 32, repositoryMembers: 128},
  },
};

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const CitationObservationSchema = Schema.Struct({
  citationId: NonEmptyString,
  expectedStatus: Schema.Literals(CONTEXT_BRIEF_CITATION_STATUSES),
  observedStatus: Schema.Literals(CONTEXT_BRIEF_CITATION_STATUSES),
  support: Schema.Literals(['supported', 'unsupported']),
});

const ScenarioSchema = Schema.Struct({
  capture: Schema.Struct({
    eligible: Schema.Boolean,
    milliseconds: NonNegativeFinite,
    succeeded: Schema.Boolean,
  }),
  citations: Schema.Array(CitationObservationSchema),
  crossRepositoryLeakage: Schema.Boolean,
  equivalenceKey: Schema.optionalKey(NonEmptyString),
  execution: Schema.Literals(['clean', 'incremental']),
  expectedFreshness: Schema.Literals(CONTEXT_BRIEF_CITATION_FRESHNESS),
  expectedWarning: Schema.Literals(CONTEXT_BRIEF_CITATION_WARNINGS),
  id: NonEmptyString,
  legacy: Schema.Boolean,
  observedFreshness: Schema.Literals(CONTEXT_BRIEF_CITATION_FRESHNESS),
  observedWarning: Schema.Literals(CONTEXT_BRIEF_CITATION_WARNINGS),
  snapshotState: Schema.Literals(CONTEXT_BRIEF_CITATION_SNAPSHOT_STATES),
});

const PerformanceSampleSchema = Schema.Struct({
  addedPeakRssBytes: NonNegativeInteger,
  cacheHits: NonNegativeInteger,
  captureMilliseconds: NonNegativeFinite,
  citationValidationMilliseconds: NonNegativeFinite,
  citationsCaptured: NonNegativeInteger,
  citationsValidated: NonNegativeInteger,
  coldBuilds: NonNegativeInteger,
  contextBriefMilliseconds: NonNegativeFinite,
  databaseStatements: NonNegativeInteger,
  estimatedTokens: NonNegativeInteger,
  maintenanceOperations: NonNegativeInteger,
  repositoryDatabasesOpened: NonNegativeInteger,
  repositoriesValidated: NonNegativeInteger,
  responseBytes: NonNegativeInteger,
  sampleId: NonEmptyString,
});

const PerformanceProfileSchema = Schema.Struct({
  id: Schema.Literals(CONTEXT_BRIEF_CITATION_PERFORMANCE_PROFILE_IDS),
  samples: Schema.Array(PerformanceSampleSchema),
  shape: Schema.Struct({
    citations: NonNegativeInteger,
    citedRepositories: NonNegativeInteger,
    repositoryMembers: NonNegativeInteger,
    symbols: Schema.optionalKey(NonNegativeInteger),
  }),
});

export const ContextBriefCitationEvaluationFixtureSchemaV1 = Schema.Struct({
  id: NonEmptyString,
  performanceProfiles: Schema.Array(PerformanceProfileSchema),
  scenarios: Schema.Array(ScenarioSchema),
  version: Schema.Literal(CONTEXT_BRIEF_CITATION_EVALUATION_VERSION),
});

/** Decode an offline fixture and enforce the hard Context Brief and benchmark bounds. */
export function parseContextBriefCitationEvaluationFixtureV1(value: unknown): ContextBriefCitationEvaluationFixtureV1 {
  const fixture = Schema.decodeUnknownSync(ContextBriefCitationEvaluationFixtureSchemaV1)(
    value,
  ) as ContextBriefCitationEvaluationFixtureV1;
  if (
    fixture.scenarios.length === 0 ||
    fixture.scenarios.length > CONTEXT_BRIEF_CITATION_EVALUATION_MAXIMUM_SCENARIOS
  ) {
    throw new Error(`Citation evaluation requires 1-${CONTEXT_BRIEF_CITATION_EVALUATION_MAXIMUM_SCENARIOS} scenarios.`);
  }
  assertUnique(
    fixture.scenarios.map(scenario => scenario.id),
    'citation evaluation scenario IDs',
  );

  const expectedStatuses = new Set<ContextBriefCitationEvaluationStatus>();
  let hasIncompleteCoverage = false;
  let hasLegacy = false;
  const equivalenceGroups = new Map<string, ContextBriefCitationEvaluationScenarioV1[]>();
  for (const scenario of fixture.scenarios) {
    if (scenario.citations.length > CONTEXT_BRIEF_CITATION_EVALUATION_MAXIMUM_CITATIONS_PER_SCENARIO) {
      throw new Error(
        `Citation evaluation scenario ${scenario.id} exceeds ${CONTEXT_BRIEF_CITATION_EVALUATION_MAXIMUM_CITATIONS_PER_SCENARIO} citations.`,
      );
    }
    assertUnique(
      scenario.citations.map(citation => citation.citationId),
      `citation IDs for ${scenario.id}`,
    );
    if (scenario.legacy !== (scenario.citations.length === 0)) {
      throw new Error(`Citation evaluation scenario ${scenario.id} must be legacy exactly when it has no citations.`);
    }
    if (scenario.capture.succeeded && !scenario.capture.eligible) {
      throw new Error(`Citation evaluation scenario ${scenario.id} cannot capture an ineligible citation.`);
    }
    if (!scenario.legacy) {
      const expectedFreshness = aggregateCitationFreshness(scenario.citations.map(citation => citation.expectedStatus));
      if (scenario.expectedFreshness !== expectedFreshness) {
        throw new Error(
          `Citation evaluation scenario ${scenario.id} expected freshness must aggregate to ${expectedFreshness}.`,
        );
      }
      const expectedWarning = aggregateCitationWarning(scenario.citations.map(citation => citation.expectedStatus));
      if (scenario.expectedWarning !== expectedWarning) {
        throw new Error(
          `Citation evaluation scenario ${scenario.id} expected warning must aggregate to ${expectedWarning}.`,
        );
      }
    }
    for (const citation of scenario.citations) {
      if (citation.support === 'supported' && citation.expectedStatus === 'unknown') {
        throw new Error(`Citation evaluation scenario ${scenario.id} marks unresolved truth as supported.`);
      }
      if (citation.support === 'unsupported' && citation.expectedStatus !== 'unknown') {
        throw new Error(`Citation evaluation scenario ${scenario.id} requires unsupported truth to abstain.`);
      }
      if (scenario.snapshotState !== 'current-complete' && citation.expectedStatus !== 'unknown') {
        throw new Error(`Citation evaluation scenario ${scenario.id} requires non-current truth to abstain.`);
      }
    }
    if (scenario.legacy) hasLegacy = true;
    if (scenario.snapshotState === 'current-incomplete') hasIncompleteCoverage = true;
    for (const citation of scenario.citations) expectedStatuses.add(citation.expectedStatus);
    if (scenario.equivalenceKey !== undefined) {
      const group = equivalenceGroups.get(scenario.equivalenceKey) ?? [];
      group.push(scenario);
      equivalenceGroups.set(scenario.equivalenceKey, group);
    }
  }
  for (const status of CONTEXT_BRIEF_CITATION_STATUSES) {
    if (!expectedStatuses.has(status)) throw new Error(`Citation evaluation fixture is missing ${status} truth.`);
  }
  if (!hasIncompleteCoverage) throw new Error('Citation evaluation fixture requires an incomplete-coverage scenario.');
  if (!hasLegacy) throw new Error('Citation evaluation fixture requires a legacy-memory parity scenario.');
  for (const [key, scenarios] of equivalenceGroups) {
    if (
      scenarios.length !== 2 ||
      !scenarios.some(scenario => scenario.execution === 'clean') ||
      !scenarios.some(scenario => scenario.execution === 'incremental')
    ) {
      throw new Error(`Citation evaluation equivalence group ${key} requires one clean and one incremental scenario.`);
    }
    if (expectedOutcomeIdentity(scenarios[0]!) !== expectedOutcomeIdentity(scenarios[1]!)) {
      throw new Error(`Citation evaluation equivalence group ${key} must compare identical truth.`);
    }
  }

  if (fixture.performanceProfiles.length !== CONTEXT_BRIEF_CITATION_PERFORMANCE_PROFILE_IDS.length) {
    throw new Error('Citation evaluation fixture must contain every governed performance profile exactly once.');
  }
  assertUnique(
    fixture.performanceProfiles.map(profile => profile.id),
    'citation performance profile IDs',
  );
  for (const profileId of CONTEXT_BRIEF_CITATION_PERFORMANCE_PROFILE_IDS) {
    const profile = fixture.performanceProfiles.find(candidate => candidate.id === profileId);
    if (!profile) throw new Error(`Citation evaluation fixture is missing performance profile ${profileId}.`);
    const contract = CONTEXT_BRIEF_CITATION_PERFORMANCE_CONTRACTS[profileId];
    if (!samePerformanceShape(profile.shape, contract.shape)) {
      throw new Error(`Citation performance profile ${profileId} does not match its governed deterministic shape.`);
    }
    if (
      profile.samples.length < CONTEXT_BRIEF_CITATION_EVALUATION_MINIMUM_PERFORMANCE_SAMPLES ||
      profile.samples.length > CONTEXT_BRIEF_CITATION_EVALUATION_MAXIMUM_PERFORMANCE_SAMPLES
    ) {
      throw new Error(
        `Citation performance profile ${profileId} requires ${CONTEXT_BRIEF_CITATION_EVALUATION_MINIMUM_PERFORMANCE_SAMPLES}-${CONTEXT_BRIEF_CITATION_EVALUATION_MAXIMUM_PERFORMANCE_SAMPLES} samples.`,
      );
    }
    assertUnique(
      profile.samples.map(sample => sample.sampleId),
      `performance sample IDs for ${profileId}`,
    );
    for (const sample of profile.samples) {
      if (
        sample.citationsCaptured !== profile.shape.citations ||
        sample.citationsValidated !== profile.shape.citations
      ) {
        throw new Error(`Citation performance sample ${profileId}/${sample.sampleId} must exercise every citation.`);
      }
      if (sample.repositoriesValidated !== profile.shape.citedRepositories) {
        throw new Error(
          `Citation performance sample ${profileId}/${sample.sampleId} must exercise every cited repository.`,
        );
      }
      if (sample.cacheHits > sample.citationsValidated) {
        throw new Error(`Citation performance sample ${profileId}/${sample.sampleId} has impossible cache hits.`);
      }
    }
  }
  return fixture;
}

/** Aggregate required citations with the Context Brief v2 safety precedence. */
export function aggregateCitationFreshness(
  statuses: readonly ContextBriefCitationEvaluationStatus[],
): ContextBriefCitationEvaluationFreshness {
  if (statuses.some(status => status === 'changed' || status === 'deleted')) return 'stale';
  if (statuses.length === 0 || statuses.includes('unknown')) return 'unknown';
  return 'fresh';
}

/** Relocation is a stale link while changed/deleted are stale evidence. */
export function aggregateCitationWarning(
  statuses: readonly ContextBriefCitationEvaluationStatus[],
): Exclude<ContextBriefCitationEvaluationWarning, 'legacy-stale'> {
  if (statuses.some(status => status === 'changed' || status === 'deleted')) return 'stale-evidence';
  if (statuses.length === 0 || statuses.includes('unknown')) return 'unknown-evidence';
  if (statuses.includes('relocated')) return 'stale-link';
  return 'none';
}

/**
 * Canonical truth/shape bytes are stable across input ordering and candidate
 * observations. Runtime statuses, timings, and counters intentionally do not
 * relabel the fixture when comparing candidates.
 */
export function serializeContextBriefCitationEvaluationFixtureIdentity(
  input: ContextBriefCitationEvaluationFixtureV1,
): string {
  const fixture = parseContextBriefCitationEvaluationFixtureV1(input);
  const canonical = {
    id: fixture.id,
    performanceProfiles: fixture.performanceProfiles
      .map(profile => ({
        id: profile.id,
        sampleIds: profile.samples.map(sample => sample.sampleId).sort(),
        shape: profile.shape,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    scenarios: fixture.scenarios
      .map(scenario => ({
        captureEligible: scenario.capture.eligible,
        citations: scenario.citations
          .map(citation => ({
            citationId: citation.citationId,
            expectedStatus: citation.expectedStatus,
            support: citation.support,
          }))
          .sort((left, right) => left.citationId.localeCompare(right.citationId)),
        ...(scenario.equivalenceKey === undefined ? {} : {equivalenceKey: scenario.equivalenceKey}),
        execution: scenario.execution,
        expectedFreshness: scenario.expectedFreshness,
        expectedWarning: scenario.expectedWarning,
        id: scenario.id,
        legacy: scenario.legacy,
        snapshotState: scenario.snapshotState,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    version: fixture.version,
  };
  return `${JSON.stringify(canonical, undefined, 2)}\n`;
}

export function contextBriefCitationEvaluationFixtureHash(fixture: ContextBriefCitationEvaluationFixtureV1): string {
  return sha256HexSync(serializeContextBriefCitationEvaluationFixtureIdentity(fixture));
}

/** Evaluate correctness and bounded performance without network access or cold graph work. */
export function evaluateContextBriefCitationFixture(
  input: ContextBriefCitationEvaluationFixtureV1,
): ContextBriefCitationEvaluationResultV1 {
  const fixture = parseContextBriefCitationEvaluationFixtureV1(input);
  const scenarios = [...fixture.scenarios].sort((left, right) => left.id.localeCompare(right.id));
  const citations = scenarios.flatMap(scenario => scenario.citations.map(citation => ({citation, scenario})));
  const confusionMatrix = CONTEXT_BRIEF_CITATION_STATUSES.map(expectedStatus => {
    const matching = citations.filter(item => item.citation.expectedStatus === expectedStatus);
    return {
      expectedStatus,
      observed: Object.fromEntries(
        CONTEXT_BRIEF_CITATION_STATUSES.map(observedStatus => [
          observedStatus,
          matching.filter(item => item.citation.observedStatus === observedStatus).length,
        ]),
      ) as Readonly<Record<ContextBriefCitationEvaluationStatus, number>>,
    };
  });
  const statusMetrics = CONTEXT_BRIEF_CITATION_STATUSES.map(status => {
    const row = confusionMatrix.find(candidate => candidate.expectedStatus === status)!;
    const expected = Object.values(row.observed).reduce((total, count) => total + count, 0);
    const observed = confusionMatrix.reduce((total, candidate) => total + candidate.observed[status], 0);
    const correct = row.observed[status];
    const precision = score(correct, observed);
    const recall = score(correct, expected);
    return {
      expected,
      f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
      observed,
      precision,
      recall,
      status,
    } satisfies ContextBriefCitationStatusMetricV1;
  });
  const statusMetric = (status: ContextBriefCitationEvaluationStatus) =>
    statusMetrics.find(metric => metric.status === status)!;
  const supported = citations.filter(item => item.citation.support === 'supported');
  const unsupported = citations.filter(item => item.citation.support === 'unsupported');
  const legacy = scenarios.filter(scenario => scenario.legacy);
  const warningCases = scenarios.filter(scenario => scenario.expectedWarning !== 'none');
  const captureEligible = scenarios.filter(scenario => scenario.capture.eligible);
  const falseFreshCitationCount = citations.filter(
    ({citation}) =>
      (citation.expectedStatus === 'changed' ||
        citation.expectedStatus === 'deleted' ||
        citation.expectedStatus === 'unknown') &&
      (citation.observedStatus === 'exact' || citation.observedStatus === 'relocated'),
  ).length;
  const falseFreshMemoryCount = scenarios.filter(
    scenario => scenario.expectedFreshness !== 'fresh' && scenario.observedFreshness === 'fresh',
  ).length;
  const equivalenceGroups = new Map<string, ContextBriefCitationEvaluationScenarioV1[]>();
  for (const scenario of scenarios) {
    if (scenario.equivalenceKey === undefined) continue;
    equivalenceGroups.set(scenario.equivalenceKey, [
      ...(equivalenceGroups.get(scenario.equivalenceKey) ?? []),
      scenario,
    ]);
  }
  const incrementalCleanMismatchCount = [...equivalenceGroups.values()].filter(group => {
    const clean = group.find(scenario => scenario.execution === 'clean')!;
    const incremental = group.find(scenario => scenario.execution === 'incremental')!;
    return observedOutcomeIdentity(clean) !== observedOutcomeIdentity(incremental);
  }).length;
  const quality: ContextBriefCitationEvaluationMetricsV1 = {
    aggregateFreshnessAccuracy: score(
      scenarios.filter(scenario => scenario.expectedFreshness === scenario.observedFreshness).length,
      scenarios.length,
    ),
    captureCoverage: score(
      captureEligible.filter(scenario => scenario.capture.succeeded).length,
      captureEligible.length,
    ),
    changedDeletedRecall: Math.min(statusMetric('changed').recall, statusMetric('deleted').recall),
    citationCount: citations.length,
    confusionMatrix,
    crossRepositoryLeakageCount: scenarios.filter(scenario => scenario.crossRepositoryLeakage).length,
    falseDeletedFromIncompleteCoverageCount: citations.filter(
      ({citation, scenario}) =>
        (scenario.snapshotState === 'current-incomplete' || scenario.snapshotState === 'unsupported') &&
        citation.observedStatus === 'deleted',
    ).length,
    falseFreshCitationCount,
    falseFreshMemoryCount,
    falseFreshRiskCount: falseFreshCitationCount + falseFreshMemoryCount,
    falseStaleMemoryCount: scenarios.filter(
      scenario => scenario.expectedFreshness === 'fresh' && scenario.observedFreshness === 'stale',
    ).length,
    incrementalCleanMismatchCount,
    legacyParity: score(
      legacy.filter(scenario => scenario.expectedFreshness === scenario.observedFreshness).length,
      legacy.length,
    ),
    macroF1: statusMetrics.reduce((total, metric) => total + metric.f1, 0) / statusMetrics.length,
    nonCurrentAuthoritativeStatusCount: citations.filter(
      ({citation, scenario}) => scenario.snapshotState !== 'current-complete' && citation.observedStatus !== 'unknown',
    ).length,
    relocationPrecision: statusMetric('relocated').precision,
    relocationRecall: statusMetric('relocated').recall,
    scenarioCount: scenarios.length,
    statusMetrics,
    supportedUnknownRate: rate(
      supported.filter(item => item.citation.observedStatus === 'unknown').length,
      supported.length,
    ),
    unsupportedUnknownRate: rate(
      unsupported.filter(item => item.citation.observedStatus === 'unknown').length,
      unsupported.length,
    ),
    warningAccuracy: score(
      scenarios.filter(scenario => scenario.expectedWarning === scenario.observedWarning).length,
      scenarios.length,
    ),
    warningCoverage: score(
      warningCases.filter(scenario => scenario.observedWarning !== 'none').length,
      warningCases.length,
    ),
  };

  const performance = [...fixture.performanceProfiles]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(evaluatePerformanceProfile);
  const failures = evaluateReleaseGate(quality, performance);
  return {
    fixture: {
      citationCount: citations.length,
      hash: contextBriefCitationEvaluationFixtureHash(fixture),
      id: fixture.id,
      performanceSampleCount: performance.reduce((total, profile) => total + profile.sampleCount, 0),
      scenarioCount: scenarios.length,
    },
    gate: {failures, passed: failures.length === 0, version: CONTEXT_BRIEF_CITATION_EVALUATION_VERSION},
    performance,
    quality,
    version: CONTEXT_BRIEF_CITATION_EVALUATION_VERSION,
  };
}

function evaluatePerformanceProfile(
  profile: ContextBriefCitationPerformanceProfileV1,
): ContextBriefCitationPerformanceMetricsV1 {
  const samples = [...profile.samples].sort((left, right) => left.sampleId.localeCompare(right.sampleId));
  const totalValidated = samples.reduce((total, sample) => total + sample.citationsValidated, 0);
  return {
    addedPeakRssBytesMaximum: Math.max(...samples.map(sample => sample.addedPeakRssBytes)),
    cacheHitRate: rate(
      samples.reduce((total, sample) => total + sample.cacheHits, 0),
      totalValidated,
    ),
    captureMilliseconds: benchmarkMeasurement(
      'citation-capture',
      'milliseconds',
      samples.map(sample => sample.captureMilliseconds),
    ),
    citationValidationMilliseconds: benchmarkMeasurement(
      'citation-validation',
      'milliseconds',
      samples.map(sample => sample.citationValidationMilliseconds),
    ),
    coldBuilds: samples.reduce((total, sample) => total + sample.coldBuilds, 0),
    contextBriefMilliseconds: benchmarkMeasurement(
      'context-brief',
      'milliseconds',
      samples.map(sample => sample.contextBriefMilliseconds),
    ),
    databaseStatements: samples.reduce((total, sample) => total + sample.databaseStatements, 0),
    estimatedTokensMaximum: Math.max(...samples.map(sample => sample.estimatedTokens)),
    id: profile.id,
    maintenanceOperations: samples.reduce((total, sample) => total + sample.maintenanceOperations, 0),
    maximumDatabaseOpenOverage: Math.max(
      ...samples.map(sample => sample.repositoryDatabasesOpened - sample.repositoriesValidated),
    ),
    responseBytesMaximum: Math.max(...samples.map(sample => sample.responseBytes)),
    sampleCount: samples.length,
  };
}

function evaluateReleaseGate(
  quality: ContextBriefCitationEvaluationMetricsV1,
  performance: readonly ContextBriefCitationPerformanceMetricsV1[],
): readonly string[] {
  const failures: string[] = [];
  if (quality.falseFreshRiskCount !== 0) {
    failures.push(`false-fresh risk count ${quality.falseFreshRiskCount}; required 0`);
  }
  if (quality.falseDeletedFromIncompleteCoverageCount !== 0) {
    failures.push(
      `deleted statuses from incomplete/unsupported coverage ${quality.falseDeletedFromIncompleteCoverageCount}; required 0`,
    );
  }
  if (quality.crossRepositoryLeakageCount !== 0) {
    failures.push(`cross-repository/worktree leakage count ${quality.crossRepositoryLeakageCount}; required 0`);
  }
  if (quality.nonCurrentAuthoritativeStatusCount !== 0) {
    failures.push(
      `authoritative statuses from non-current/incomplete snapshots ${quality.nonCurrentAuthoritativeStatusCount}; required 0`,
    );
  }
  if (quality.changedDeletedRecall < 1) {
    failures.push(`changed/deleted recall ${formatRate(quality.changedDeletedRecall)}; required 1.000000`);
  }
  if (quality.legacyParity < 1) failures.push(`legacy parity ${formatRate(quality.legacyParity)}; required 1.000000`);
  if (quality.relocationPrecision < 1) {
    failures.push(`relocation precision ${formatRate(quality.relocationPrecision)}; required 1.000000`);
  }
  if (quality.relocationRecall < 0.95) {
    failures.push(`relocation recall ${formatRate(quality.relocationRecall)}; minimum 0.950000`);
  }
  if (quality.supportedUnknownRate > 0.05) {
    failures.push(`supported-case unknown rate ${formatRate(quality.supportedUnknownRate)}; maximum 0.050000`);
  }
  if (quality.macroF1 < 0.98) failures.push(`macro-F1 ${formatRate(quality.macroF1)}; minimum 0.980000`);
  if (quality.incrementalCleanMismatchCount !== 0) {
    failures.push(`incremental/clean mismatches ${quality.incrementalCleanMismatchCount}; required 0`);
  }

  for (const metrics of performance) {
    const contract = CONTEXT_BRIEF_CITATION_PERFORMANCE_CONTRACTS[metrics.id];
    if (metrics.citationValidationMilliseconds.p95 > contract.maximumCitationValidationP95Milliseconds) {
      failures.push(
        `${metrics.id} citation-validation p95 ${formatMilliseconds(metrics.citationValidationMilliseconds.p95)}; maximum ${formatMilliseconds(contract.maximumCitationValidationP95Milliseconds)}`,
      );
    }
    if (metrics.contextBriefMilliseconds.p95 > contract.maximumContextBriefP95Milliseconds) {
      failures.push(
        `${metrics.id} context-brief p95 ${formatMilliseconds(metrics.contextBriefMilliseconds.p95)}; maximum ${formatMilliseconds(contract.maximumContextBriefP95Milliseconds)}`,
      );
    }
    if (metrics.addedPeakRssBytesMaximum > contract.maximumAddedPeakRssBytes) {
      failures.push(
        `${metrics.id} added peak RSS ${metrics.addedPeakRssBytesMaximum}; maximum ${contract.maximumAddedPeakRssBytes} bytes`,
      );
    }
    if (metrics.estimatedTokensMaximum > contract.maximumEstimatedTokens) {
      failures.push(
        `${metrics.id} estimated tokens ${metrics.estimatedTokensMaximum}; maximum ${contract.maximumEstimatedTokens}`,
      );
    }
    if (metrics.maximumDatabaseOpenOverage > 0) {
      failures.push(
        `${metrics.id} database opens exceeded distinct validated repositories by ${metrics.maximumDatabaseOpenOverage}`,
      );
    }
    if (metrics.coldBuilds !== 0) failures.push(`${metrics.id} cold builds ${metrics.coldBuilds}; required 0`);
    if (metrics.maintenanceOperations !== 0) {
      failures.push(`${metrics.id} maintenance operations ${metrics.maintenanceOperations}; required 0`);
    }
  }
  return failures.sort();
}

function observedOutcomeIdentity(scenario: ContextBriefCitationEvaluationScenarioV1): string {
  return JSON.stringify({
    citations: scenario.citations
      .map(citation => ({citationId: citation.citationId, status: citation.observedStatus}))
      .sort((left, right) => left.citationId.localeCompare(right.citationId)),
    freshness: scenario.observedFreshness,
    warning: scenario.observedWarning,
  });
}

function expectedOutcomeIdentity(scenario: ContextBriefCitationEvaluationScenarioV1): string {
  return JSON.stringify({
    citations: scenario.citations
      .map(citation => ({citationId: citation.citationId, status: citation.expectedStatus, support: citation.support}))
      .sort((left, right) => left.citationId.localeCompare(right.citationId)),
    freshness: scenario.expectedFreshness,
    snapshotState: scenario.snapshotState,
    warning: scenario.expectedWarning,
  });
}

function samePerformanceShape(
  left: ContextBriefCitationPerformanceProfileV1['shape'],
  right: ContextBriefCitationPerformanceProfileV1['shape'],
): boolean {
  return (
    left.citations === right.citations &&
    left.citedRepositories === right.citedRepositories &&
    left.repositoryMembers === right.repositoryMembers &&
    left.symbols === right.symbols
  );
}

function score(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}.`);
    seen.add(value);
  }
}

function formatRate(value: number): string {
  return value.toFixed(6);
}

function formatMilliseconds(value: number): string {
  return `${value.toFixed(3)} ms`;
}
