import {sha256HexSync} from '../crypto/sha256.js';
import {benchmarkMeasurement, type BenchmarkMeasurementV1} from './benchmark.js';

export const CONTEXT_BRIEF_CITATION_RUNTIME_EVALUATION_VERSION = 1 as const;

export const CONTEXT_BRIEF_CITATION_RUNTIME_SCENARIO_KINDS = [
  'exact',
  'relocated',
  'changed',
  'deleted',
  'ambiguous',
  'incomplete',
  'cross-repository',
  'legacy-v1',
] as const;

export type ContextBriefCitationRuntimeScenarioKind = (typeof CONTEXT_BRIEF_CITATION_RUNTIME_SCENARIO_KINDS)[number];
export type ContextBriefCitationRuntimeStatus = 'changed' | 'deleted' | 'exact' | 'relocated' | 'unknown';
export type ContextBriefCitationRuntimeFreshness = 'fresh' | 'stale' | 'unknown';
export type ContextBriefCitationRuntimeWarning = 'none' | 'stale-link' | 'stale-memory' | 'unknown-memory-freshness';

export interface ContextBriefCitationRuntimeScenarioV1 {
  readonly currentCommit: string;
  readonly currentSnapshotId: string;
  readonly equivalenceKey?: string;
  readonly execution: 'clean' | 'incremental';
  readonly expectedFreshness: ContextBriefCitationRuntimeFreshness;
  readonly expectedRecallCount: number;
  readonly expectedStatus?: ContextBriefCitationRuntimeStatus;
  readonly expectedWarning: ContextBriefCitationRuntimeWarning;
  readonly id: string;
  readonly kind: ContextBriefCitationRuntimeScenarioKind;
  readonly snapshotState: 'current-complete' | 'current-incomplete';
}

export interface ContextBriefCitationRuntimeFixtureV1 {
  readonly expectedContractHash: string;
  readonly id: string;
  readonly scenarios: readonly ContextBriefCitationRuntimeScenarioV1[];
  readonly source: {
    readonly content: string;
    readonly expectedCitationId: string;
    readonly extractorSet: string;
    readonly foreignRepositoryId: string;
    readonly graphContentId: string;
    readonly path: string;
    readonly repositoryId: string;
    readonly sourceCommit: string;
    readonly sourceSnapshotId: string;
  };
  readonly thresholds: {
    readonly maximumBriefP95Milliseconds: number;
    readonly maximumEstimatedTokens: number;
    readonly maximumValidationP95Milliseconds: number;
  };
  readonly version: typeof CONTEXT_BRIEF_CITATION_RUNTIME_EVALUATION_VERSION;
}

export interface ContextBriefCitationRuntimeObservationV1 {
  readonly capture: {
    readonly citationId?: string;
    readonly milliseconds: number;
    readonly succeeded: boolean;
  };
  readonly contextBriefMilliseconds: number;
  readonly estimatedTokens: number;
  readonly id: string;
  readonly execution: ContextBriefCitationRuntimeScenarioV1['execution'];
  readonly leaseBalance: number;
  readonly maintenanceRequests: number;
  readonly observedFreshness: ContextBriefCitationRuntimeFreshness;
  readonly observedRecallCount: number;
  readonly observedStatus?: ContextBriefCitationRuntimeStatus;
  readonly observedWarning: ContextBriefCitationRuntimeWarning;
  readonly snapshotState: ContextBriefCitationRuntimeScenarioV1['snapshotState'];
  readonly validationEvidenceCalls: number;
  readonly validationMilliseconds: number;
}

export interface ContextBriefCitationRuntimeEvaluationResultV1 {
  readonly contract: {
    readonly expectedHash: string;
    readonly matched: boolean;
    readonly observedHash: string;
  };
  readonly fixture: {
    readonly hash: string;
    readonly id: string;
    readonly scenarioCount: number;
  };
  readonly gate: {
    readonly failures: readonly string[];
    readonly passed: boolean;
  };
  readonly measurements: {
    readonly captureMilliseconds: BenchmarkMeasurementV1;
    readonly contextBriefMilliseconds: BenchmarkMeasurementV1;
    readonly validationMilliseconds: BenchmarkMeasurementV1;
  };
  readonly observations: readonly ContextBriefCitationRuntimeObservationV1[];
  readonly quality: {
    readonly falseFreshRiskCount: number;
    readonly incompleteFalseDeletedCount: number;
    readonly incrementalCleanMismatchCount: number;
    readonly legacyRecallContinuity: number;
    readonly maximumEstimatedTokens: number;
    readonly crossRepositoryLeakageCount: number;
    readonly scenarioAccuracy: number;
  };
  readonly version: typeof CONTEXT_BRIEF_CITATION_RUNTIME_EVALUATION_VERSION;
}

const APPROVED_THRESHOLDS: ContextBriefCitationRuntimeFixtureV1['thresholds'] = {
  maximumBriefP95Milliseconds: 1_500,
  maximumEstimatedTokens: 1_500,
  maximumValidationP95Milliseconds: 250,
};
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const CONTENT_ID = /^cgc_[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const SNAPSHOT_ID = /^cgsn_[0-9a-f]{40}$/u;
const CITATION_ID = /^tncc_[0-9a-f]{40}$/u;

/** Parse the reviewed runtime fixture and reject silent release-gate weakening. */
export function parseContextBriefCitationRuntimeFixtureV1(value: unknown): ContextBriefCitationRuntimeFixtureV1 {
  const fixture = record(value, 'runtime fixture');
  exactKeys(fixture, ['expectedContractHash', 'id', 'scenarios', 'source', 'thresholds', 'version'], 'runtime fixture');
  if (fixture.version !== CONTEXT_BRIEF_CITATION_RUNTIME_EVALUATION_VERSION) invalid('version must be 1');
  const id = nonEmptyString(fixture.id, 'fixture id');
  const expectedContractHash = matchingString(fixture.expectedContractHash, HASH, 'expected contract hash');
  const source = parseSource(fixture.source);
  const thresholds = parseThresholds(fixture.thresholds);
  if (!Array.isArray(fixture.scenarios)) invalid('scenarios must be an array');
  const scenarios = fixture.scenarios.map(parseScenario);
  if (scenarios.length !== CONTEXT_BRIEF_CITATION_RUNTIME_SCENARIO_KINDS.length + 1) {
    invalid(`scenarios must contain exactly ${CONTEXT_BRIEF_CITATION_RUNTIME_SCENARIO_KINDS.length + 1} cases`);
  }
  assertUnique(
    scenarios.map(scenario => scenario.id),
    'scenario ids',
  );
  assertUnique(
    scenarios.map(scenario => scenario.currentSnapshotId),
    'current snapshot ids',
  );
  for (const kind of CONTEXT_BRIEF_CITATION_RUNTIME_SCENARIO_KINDS) {
    if (!scenarios.some(scenario => scenario.kind === kind)) invalid(`missing ${kind} scenario`);
  }
  const equivalenceGroups = new Map<string, ContextBriefCitationRuntimeScenarioV1[]>();
  for (const scenario of scenarios) {
    if (scenario.equivalenceKey === undefined) continue;
    equivalenceGroups.set(scenario.equivalenceKey, [
      ...(equivalenceGroups.get(scenario.equivalenceKey) ?? []),
      scenario,
    ]);
  }
  if (equivalenceGroups.size === 0) invalid('a clean/incremental equivalence group is required');
  for (const [key, group] of equivalenceGroups) {
    if (
      group.length !== 2 ||
      !group.some(scenario => scenario.execution === 'clean') ||
      !group.some(scenario => scenario.execution === 'incremental') ||
      group.some(scenario => scenario.kind !== 'exact')
    ) {
      invalid(`equivalence group ${key} must contain one clean and one incremental exact scenario`);
    }
  }
  return {expectedContractHash, id, scenarios, source, thresholds, version: 1};
}

/** Stable fixture identity: runtime timings never relabel reviewed truth. */
export function contextBriefCitationRuntimeFixtureHash(fixture: ContextBriefCitationRuntimeFixtureV1): string {
  return sha256HexSync(canonicalJson(parseContextBriefCitationRuntimeFixtureV1(fixture)));
}

export function finalizeContextBriefCitationRuntimeEvaluation(
  fixtureInput: ContextBriefCitationRuntimeFixtureV1,
  observationsInput: readonly ContextBriefCitationRuntimeObservationV1[],
): ContextBriefCitationRuntimeEvaluationResultV1 {
  const fixture = parseContextBriefCitationRuntimeFixtureV1(fixtureInput);
  const observations = [...observationsInput].sort((left, right) => left.id.localeCompare(right.id));
  assertUnique(
    observations.map(observation => observation.id),
    'observation ids',
  );
  const expectedContract = fixture.scenarios
    .map(scenario => expectedContractObservation(fixture, scenario))
    .sort((left, right) => left.id.localeCompare(right.id));
  const observedContract = observations.map(observedContractObservation);
  const derivedExpectedHash = sha256HexSync(canonicalJson(expectedContract));
  const expectedHash = fixture.expectedContractHash;
  const observedHash = sha256HexSync(canonicalJson(observedContract));
  const byId = new Map(observations.map(observation => [observation.id, observation]));
  const falseFreshRiskCount = fixture.scenarios.reduce((count, scenario) => {
    const observed = byId.get(scenario.id);
    if (!observed) return count;
    const memoryRisk = scenario.expectedFreshness !== 'fresh' && observed.observedFreshness === 'fresh' ? 1 : 0;
    const citationRisk =
      (scenario.expectedStatus === 'changed' ||
        scenario.expectedStatus === 'deleted' ||
        scenario.expectedStatus === 'unknown') &&
      (observed.observedStatus === 'exact' || observed.observedStatus === 'relocated')
        ? 1
        : 0;
    return count + memoryRisk + citationRisk;
  }, 0);
  const incompleteFalseDeletedCount = observations.filter(
    observation => observation.snapshotState === 'current-incomplete' && observation.observedStatus === 'deleted',
  ).length;
  const crossRepositoryLeakageCount = fixture.scenarios.filter(scenario => {
    if (scenario.kind !== 'cross-repository') return false;
    const status = byId.get(scenario.id)?.observedStatus;
    return status !== undefined && status !== 'unknown';
  }).length;
  const equivalenceGroups = new Map<string, ContextBriefCitationRuntimeScenarioV1[]>();
  for (const scenario of fixture.scenarios) {
    if (scenario.equivalenceKey === undefined) continue;
    equivalenceGroups.set(scenario.equivalenceKey, [
      ...(equivalenceGroups.get(scenario.equivalenceKey) ?? []),
      scenario,
    ]);
  }
  const incrementalCleanMismatchCount = [...equivalenceGroups.values()].filter(group => {
    const clean = byId.get(group.find(scenario => scenario.execution === 'clean')!.id);
    const incremental = byId.get(group.find(scenario => scenario.execution === 'incremental')!.id);
    return runtimeOutcome(clean) !== runtimeOutcome(incremental);
  }).length;
  const legacyScenarios = fixture.scenarios.filter(scenario => scenario.kind === 'legacy-v1');
  const legacyRecallContinuity = ratio(
    legacyScenarios.filter(scenario => byId.get(scenario.id)?.observedRecallCount === scenario.expectedRecallCount)
      .length,
    legacyScenarios.length,
  );
  const scenarioAccuracy = ratio(
    expectedContract.filter(expected =>
      observedContract.some(observed => canonicalJson(observed) === canonicalJson(expected)),
    ).length,
    expectedContract.length,
  );
  const maximumEstimatedTokens = Math.max(0, ...observations.map(observation => observation.estimatedTokens));
  const measurements = {
    captureMilliseconds: benchmarkMeasurement(
      'context-brief-citation-runtime-capture',
      'milliseconds',
      observations
        .filter(observation => observation.capture.succeeded)
        .map(observation => observation.capture.milliseconds),
    ),
    contextBriefMilliseconds: benchmarkMeasurement(
      'context-brief-citation-runtime-total',
      'milliseconds',
      observations.map(observation => observation.contextBriefMilliseconds),
    ),
    validationMilliseconds: benchmarkMeasurement(
      'context-brief-citation-runtime-validation',
      'milliseconds',
      observations
        .filter(observation => observation.capture.succeeded)
        .map(observation => observation.validationMilliseconds),
    ),
  };
  const failures = [
    observations.length === fixture.scenarios.length
      ? ''
      : `runtime observation count ${observations.length}; required ${fixture.scenarios.length}`,
    derivedExpectedHash === expectedHash ? '' : 'reviewed runtime contract hash does not match fixture truth',
    expectedHash === observedHash ? '' : 'runtime observations differ from the reviewed deterministic contract',
    falseFreshRiskCount === 0 ? '' : `false-fresh risk count ${falseFreshRiskCount}; required 0`,
    incompleteFalseDeletedCount === 0
      ? ''
      : `deleted statuses from incomplete coverage ${incompleteFalseDeletedCount}; required 0`,
    crossRepositoryLeakageCount === 0
      ? ''
      : `cross-repository authoritative leakage ${crossRepositoryLeakageCount}; required 0`,
    incrementalCleanMismatchCount === 0
      ? ''
      : `clean/incremental runtime mismatch count ${incrementalCleanMismatchCount}; required 0`,
    legacyRecallContinuity === 1 ? '' : `legacy-v1 recall continuity ${legacyRecallContinuity}; required 1`,
    maximumEstimatedTokens <= fixture.thresholds.maximumEstimatedTokens
      ? ''
      : `Context Brief token maximum ${maximumEstimatedTokens}; limit ${fixture.thresholds.maximumEstimatedTokens}`,
    measurements.validationMilliseconds.p95 <= fixture.thresholds.maximumValidationP95Milliseconds
      ? ''
      : `citation validation p95 ${measurements.validationMilliseconds.p95}ms; limit ${fixture.thresholds.maximumValidationP95Milliseconds}ms`,
    measurements.contextBriefMilliseconds.p95 <= fixture.thresholds.maximumBriefP95Milliseconds
      ? ''
      : `Context Brief p95 ${measurements.contextBriefMilliseconds.p95}ms; limit ${fixture.thresholds.maximumBriefP95Milliseconds}ms`,
    observations.every(observation => observation.leaseBalance === 0)
      ? ''
      : 'runtime evaluation leaked at least one graph snapshot lease',
    observations.every(observation => observation.maintenanceRequests === 0)
      ? ''
      : 'runtime evaluation requested forbidden graph maintenance',
    observations
      .filter(observation => observation.snapshotState === 'current-incomplete')
      .every(observation => observation.validationEvidenceCalls === 0)
      ? ''
      : 'incomplete graph coverage reached authoritative citation evidence',
  ].filter(Boolean);
  return {
    contract: {expectedHash, matched: expectedHash === observedHash, observedHash},
    fixture: {
      hash: contextBriefCitationRuntimeFixtureHash(fixture),
      id: fixture.id,
      scenarioCount: fixture.scenarios.length,
    },
    gate: {failures, passed: failures.length === 0},
    measurements,
    observations,
    quality: {
      falseFreshRiskCount,
      incompleteFalseDeletedCount,
      incrementalCleanMismatchCount,
      legacyRecallContinuity,
      maximumEstimatedTokens,
      crossRepositoryLeakageCount,
      scenarioAccuracy,
    },
    version: 1,
  };
}

function expectedContractObservation(
  fixture: ContextBriefCitationRuntimeFixtureV1,
  scenario: ContextBriefCitationRuntimeScenarioV1,
) {
  return {
    captureSucceeded: scenario.kind !== 'legacy-v1',
    ...(scenario.kind === 'legacy-v1' ? {} : {citationId: fixture.source.expectedCitationId}),
    expectedFreshness: scenario.expectedFreshness,
    expectedRecallCount: scenario.expectedRecallCount,
    ...(scenario.expectedStatus === undefined ? {} : {expectedStatus: scenario.expectedStatus}),
    expectedWarning: scenario.expectedWarning,
    execution: scenario.execution,
    id: scenario.id,
    snapshotState: scenario.snapshotState,
  };
}

function observedContractObservation(observation: ContextBriefCitationRuntimeObservationV1) {
  return {
    captureSucceeded: observation.capture.succeeded,
    ...(observation.capture.citationId === undefined ? {} : {citationId: observation.capture.citationId}),
    expectedFreshness: observation.observedFreshness,
    expectedRecallCount: observation.observedRecallCount,
    ...(observation.observedStatus === undefined ? {} : {expectedStatus: observation.observedStatus}),
    expectedWarning: observation.observedWarning,
    execution: observation.execution,
    id: observation.id,
    snapshotState: observation.snapshotState,
  };
}

function parseSource(value: unknown): ContextBriefCitationRuntimeFixtureV1['source'] {
  const source = record(value, 'source');
  exactKeys(
    source,
    [
      'content',
      'expectedCitationId',
      'extractorSet',
      'foreignRepositoryId',
      'graphContentId',
      'path',
      'repositoryId',
      'sourceCommit',
      'sourceSnapshotId',
    ],
    'source',
  );
  const parsed = {
    content: nonEmptyString(source.content, 'source content'),
    expectedCitationId: matchingString(source.expectedCitationId, CITATION_ID, 'expected citation id'),
    extractorSet: nonEmptyString(source.extractorSet, 'extractor set'),
    foreignRepositoryId: matchingString(source.foreignRepositoryId, HASH, 'foreign repository id'),
    graphContentId: matchingString(source.graphContentId, CONTENT_ID, 'graph content id'),
    path: nonEmptyString(source.path, 'source path'),
    repositoryId: matchingString(source.repositoryId, HASH, 'repository id'),
    sourceCommit: matchingString(source.sourceCommit, COMMIT, 'source commit'),
    sourceSnapshotId: matchingString(source.sourceSnapshotId, SNAPSHOT_ID, 'source snapshot id'),
  };
  if (
    parsed.path.startsWith('/') ||
    parsed.path.includes('\\') ||
    parsed.path.split('/').some(part => !part || part === '..')
  ) {
    invalid('source path must be repository-relative');
  }
  return parsed;
}

function parseThresholds(value: unknown): ContextBriefCitationRuntimeFixtureV1['thresholds'] {
  const thresholds = record(value, 'thresholds');
  exactKeys(
    thresholds,
    ['maximumBriefP95Milliseconds', 'maximumEstimatedTokens', 'maximumValidationP95Milliseconds'],
    'thresholds',
  );
  const parsed = {
    maximumBriefP95Milliseconds: positiveNumber(thresholds.maximumBriefP95Milliseconds, 'maximum brief p95'),
    maximumEstimatedTokens: positiveInteger(thresholds.maximumEstimatedTokens, 'maximum estimated tokens'),
    maximumValidationP95Milliseconds: positiveNumber(
      thresholds.maximumValidationP95Milliseconds,
      'maximum validation p95',
    ),
  };
  if (canonicalJson(parsed) !== canonicalJson(APPROVED_THRESHOLDS)) invalid('thresholds differ from the approved gate');
  return parsed;
}

function parseScenario(value: unknown): ContextBriefCitationRuntimeScenarioV1 {
  const scenario = record(value, 'scenario');
  exactKeys(
    scenario,
    [
      'currentCommit',
      'currentSnapshotId',
      'equivalenceKey',
      'execution',
      'expectedFreshness',
      'expectedRecallCount',
      'expectedStatus',
      'expectedWarning',
      'id',
      'kind',
      'snapshotState',
    ],
    'scenario',
  );
  const kind = literal(scenario.kind, CONTEXT_BRIEF_CITATION_RUNTIME_SCENARIO_KINDS, 'scenario kind');
  const expectedStatus =
    scenario.expectedStatus === undefined
      ? undefined
      : literal(
          scenario.expectedStatus,
          ['changed', 'deleted', 'exact', 'relocated', 'unknown'] as const,
          'expected status',
        );
  const parsed: ContextBriefCitationRuntimeScenarioV1 = {
    currentCommit: matchingString(scenario.currentCommit, COMMIT, 'current commit'),
    currentSnapshotId: matchingString(scenario.currentSnapshotId, SNAPSHOT_ID, 'current snapshot id'),
    ...(scenario.equivalenceKey === undefined
      ? {}
      : {equivalenceKey: nonEmptyString(scenario.equivalenceKey, 'equivalence key')}),
    execution: literal(scenario.execution, ['clean', 'incremental'] as const, 'scenario execution'),
    expectedFreshness: literal(
      scenario.expectedFreshness,
      ['fresh', 'stale', 'unknown'] as const,
      'expected freshness',
    ),
    expectedRecallCount: positiveInteger(scenario.expectedRecallCount, 'expected recall count'),
    ...(expectedStatus === undefined ? {} : {expectedStatus}),
    expectedWarning: literal(
      scenario.expectedWarning,
      ['none', 'stale-link', 'stale-memory', 'unknown-memory-freshness'] as const,
      'expected warning',
    ),
    id: nonEmptyString(scenario.id, 'scenario id'),
    kind,
    snapshotState: literal(
      scenario.snapshotState,
      ['current-complete', 'current-incomplete'] as const,
      'snapshot state',
    ),
  };
  assertScenarioTruth(parsed);
  return parsed;
}

function assertScenarioTruth(scenario: ContextBriefCitationRuntimeScenarioV1): void {
  const truth = {
    ambiguous: ['unknown', 'unknown', 'unknown-memory-freshness', 'current-complete'],
    changed: ['changed', 'stale', 'stale-memory', 'current-complete'],
    'cross-repository': ['unknown', 'unknown', 'unknown-memory-freshness', 'current-complete'],
    deleted: ['deleted', 'stale', 'stale-memory', 'current-complete'],
    exact: ['exact', 'fresh', 'none', 'current-complete'],
    incomplete: ['unknown', 'unknown', 'unknown-memory-freshness', 'current-incomplete'],
    relocated: ['relocated', 'fresh', 'stale-link', 'current-complete'],
    'legacy-v1': [undefined, 'unknown', 'unknown-memory-freshness', 'current-complete'],
  } as const satisfies Readonly<
    Record<
      ContextBriefCitationRuntimeScenarioKind,
      readonly [
        ContextBriefCitationRuntimeStatus | undefined,
        ContextBriefCitationRuntimeFreshness,
        ContextBriefCitationRuntimeWarning,
        ContextBriefCitationRuntimeScenarioV1['snapshotState'],
      ]
    >
  >;
  const expected = truth[scenario.kind];
  if (
    scenario.expectedStatus !== expected[0] ||
    scenario.expectedFreshness !== expected[1] ||
    scenario.expectedWarning !== expected[2] ||
    scenario.snapshotState !== expected[3] ||
    scenario.expectedRecallCount !== 1
  ) {
    invalid(`scenario ${scenario.id} does not match the frozen ${scenario.kind} truth`);
  }
}

function runtimeOutcome(observation: ContextBriefCitationRuntimeObservationV1 | undefined): string {
  if (observation === undefined) return 'missing';
  return canonicalJson({
    freshness: observation.observedFreshness,
    recallCount: observation.observedRecallCount,
    status: observation.observedStatus,
    warning: observation.observedWarning,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(object)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Runtime citation contract contains an unsupported value.');
  return encoded;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].filter(key => value[key] !== undefined || Object.hasOwn(value, key)).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value as Values[number];
}

function matchingString(value: unknown, pattern: RegExp, label: string): string {
  const parsed = nonEmptyString(value, label);
  if (!pattern.test(parsed)) invalid(`${label} is invalid`);
  return parsed;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${label} must be a positive integer`);
  return value as number;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) invalid(`${label} must be positive`);
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function invalid(message: string): never {
  throw new Error(`Invalid Context Brief citation runtime fixture: ${message}.`);
}
