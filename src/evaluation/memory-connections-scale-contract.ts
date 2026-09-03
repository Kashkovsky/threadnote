import {sha256HexSync} from '../crypto/sha256.js';
import {benchmarkMeasurement, type BenchmarkMeasurementV1} from './benchmark.js';
import {Predicate} from 'effect';

export const MEMORY_CONNECTIONS_SCALE_ID = 'memory-connections-one-hop-scale-v1' as const;
export const MEMORY_CONNECTIONS_SCALE_VERSION = 1 as const;
export const MEMORY_CONNECTIONS_SCALE_RELEASE_RUNNER_CLASS = 'github-hosted-macos-15-ARM64' as const;
export const MEMORY_CONNECTIONS_SCALE_SCENARIOS = ['incoming-hub', 'sparse-incoming', 'no-answer'] as const;
export type MemoryConnectionsScaleScenarioId = (typeof MEMORY_CONNECTIONS_SCALE_SCENARIOS)[number];
export type MemoryConnectionsScaleEvidenceClass = 'development-smoke' | 'release-scale';

export const MEMORY_CONNECTIONS_SCALE_FIXTURE = Object.freeze({
  project: 'threadnote',
  scenarios: [
    {
      expectedMemoryIds: Array.from({length: 8}, (_, index) => `tn_hub_${String(index).padStart(6, '0')}`),
      expectedTruncated: true,
      id: 'incoming-hub',
      premiseMemoryId: 'tn_scale_hub',
    },
    {
      expectedMemoryIds: ['tn_sparse_a', 'tn_sparse_b'],
      expectedTruncated: false,
      id: 'sparse-incoming',
      premiseMemoryId: 'tn_scale_sparse',
    },
    {
      expectedMemoryIds: [],
      expectedTruncated: false,
      id: 'no-answer',
      premiseMemoryId: 'tn_scale_empty',
    },
  ],
  seed: 'threadnote-memory-connections-one-hop-scale-v1-2026-08-31',
  unauthorizedProject: 'outside',
  user: 'memory-connections-scale',
} as const);

/** Changing corpus identity requires a complete source-reviewed hash update. */
export const MEMORY_CONNECTIONS_SCALE_APPROVED_FIXTURE_HASH =
  '136c49200cb5661faa60db25a682faa8793dcbb3cfe9da7387d396f32d0a5ee7' as const;

export interface MemoryConnectionsScaleBudgetV1 {
  readonly corpusMemoryCount: 100_000;
  readonly id: typeof MEMORY_CONNECTIONS_SCALE_ID;
  readonly maximumAddedPeakRssBytes: number;
  readonly maximumCanonicalRereadsPerLookup: 322;
  readonly maximumCorpusBytes: number;
  readonly maximumIndexBuildMilliseconds: number;
  readonly maximumLookupP95Milliseconds: 250;
  readonly maximumLookupSampleMilliseconds: 1_000;
  readonly maximumMaterializationMilliseconds: number;
  readonly maximumRawLinkRowsPerLookup: 257;
  readonly maximumRecallStorageBytes: number;
  readonly maximumResponseEstimatedTokens: 1_500;
  readonly minimumSamples: 25;
  readonly minimumWarmups: 5;
  readonly queryLimit: 8;
  readonly version: 1;
}

export const MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET: MemoryConnectionsScaleBudgetV1 = Object.freeze({
  corpusMemoryCount: 100_000,
  id: MEMORY_CONNECTIONS_SCALE_ID,
  maximumAddedPeakRssBytes: 3 * 1024 * 1024 * 1024,
  maximumCanonicalRereadsPerLookup: 322,
  maximumCorpusBytes: 256 * 1024 * 1024,
  maximumIndexBuildMilliseconds: 10 * 60 * 1_000,
  maximumLookupP95Milliseconds: 250,
  maximumLookupSampleMilliseconds: 1_000,
  maximumMaterializationMilliseconds: 5 * 60 * 1_000,
  maximumRawLinkRowsPerLookup: 257,
  maximumRecallStorageBytes: 2 * 1024 * 1024 * 1024,
  maximumResponseEstimatedTokens: 1_500,
  minimumSamples: 25,
  minimumWarmups: 5,
  queryLimit: 8,
  version: 1,
});

export interface MemoryConnectionsScaleConnectionReceiptEvidenceV1 {
  readonly currentness: string;
  readonly direction: string;
  readonly distance: number;
  readonly neighborMemoryId: string | null;
  readonly origin: string;
  readonly relationOrdinal: number;
  readonly relationType: string;
  readonly requestedOrdinal: number;
  readonly resolution: string;
  readonly sourceMemoryId: string | null;
  readonly targetMemoryId: string | null;
}

export interface MemoryConnectionsScalePremiseReceiptEvidenceV1 {
  readonly memoryId: string | null;
  readonly requestedOrdinal: number;
  readonly state: string;
}

export interface MemoryConnectionsScaleObservationV1 {
  readonly canonicalRereads: number;
  readonly estimatedTokens: number;
  readonly milliseconds: number;
  readonly omittedConnectionReceiptCount: number;
  readonly omittedPremiseReceiptCount: number;
  readonly projectedConnections: readonly MemoryConnectionsScaleConnectionReceiptEvidenceV1[];
  readonly projectedCoverageConnectionCount: number;
  readonly projectedCoveragePremiseCount: number;
  readonly projectedCoverageResultCount: number;
  readonly projectedConnectionCoverageTruncated: boolean;
  readonly projectedOutputTruncated: boolean;
  readonly projectedPremises: readonly MemoryConnectionsScalePremiseReceiptEvidenceV1[];
  readonly rawLinkRows: number;
  readonly retrievalTruncated: boolean;
  readonly returnedMemoryIds: readonly string[];
}

export interface MemoryConnectionsScaleScenarioCaptureV1 {
  readonly cold: MemoryConnectionsScaleObservationV1;
  readonly expectedMemoryIds: readonly string[];
  readonly expectedTruncated: boolean;
  readonly id: MemoryConnectionsScaleScenarioId;
  readonly samples: readonly MemoryConnectionsScaleObservationV1[];
  readonly warmups: readonly MemoryConnectionsScaleObservationV1[];
}

export interface MemoryConnectionsScaleCaptureV1 {
  readonly corpus: {
    readonly authorizedHubMemoryCount: number;
    readonly corpusBytes: number;
    readonly indexedMemoryCount: number;
    readonly materializedMemoryCount: number;
  };
  readonly fixtureHash: string;
  readonly resources: {
    readonly addedPeakRssBytes: number;
    readonly baselineRssBytes: number;
    readonly indexBuildMilliseconds: number;
    readonly materializationMilliseconds: number;
    readonly peakRssBytes: number;
    readonly recallDatabaseBytes: number;
    readonly recallStorageBytes: number;
  };
  readonly scenarios: readonly MemoryConnectionsScaleScenarioCaptureV1[];
}

export interface MemoryConnectionsScaleIdentityV1 {
  readonly builtArtifactSha256: string;
  readonly candidateCommit: string;
  readonly dirty: boolean;
  readonly invocationMode: MemoryConnectionsScaleEvidenceClass;
  readonly observedCommit: string;
  readonly runnerClass: string;
  readonly runtime: string;
}

export interface MemoryConnectionsScaleMetricsV1 {
  readonly boundedResultAccuracy: number;
  readonly duplicateResultCount: number;
  readonly incorrectConnectionCurrentnessCount: number;
  readonly incorrectConnectionReceiptIdentityCount: number;
  readonly incorrectConnectionResolutionCount: number;
  readonly incorrectPremiseReceiptIdentityCount: number;
  readonly incorrectPremiseStateCount: number;
  readonly lookupMilliseconds: BenchmarkMeasurementV1;
  readonly maximumCanonicalRereads: number;
  readonly maximumEstimatedTokens: number;
  readonly maximumRawLinkRows: number;
  readonly maximumReturnedMemories: number;
  readonly noAnswerAccuracy: number;
  readonly precision: number;
  readonly projectedConnectionCoverageAccuracy: number;
  readonly projectedOutputCompletenessAccuracy: number;
  readonly projectedReceiptAccountingAccuracy: number;
  readonly recall: number;
  readonly truncationAccuracy: number;
  readonly unexpectedReceiptIdentityCount: number;
  readonly unexpectedResultCount: number;
}

export interface MemoryConnectionsScaleArtifactV1 {
  readonly capture: MemoryConnectionsScaleCaptureV1;
  readonly createdAt: string;
  readonly evidenceClass: MemoryConnectionsScaleEvidenceClass;
  readonly gate: {readonly failures: readonly string[]; readonly passed: boolean};
  readonly identity: MemoryConnectionsScaleIdentityV1;
  readonly metrics: MemoryConnectionsScaleMetricsV1;
  readonly suite: typeof MEMORY_CONNECTIONS_SCALE_ID;
  readonly version: 1;
}

export function memoryConnectionsScaleFixtureHash(): string {
  return sha256HexSync(`${JSON.stringify(MEMORY_CONNECTIONS_SCALE_FIXTURE)}\n`);
}

export function memoryConnectionsScaleExpectedIds(id: MemoryConnectionsScaleScenarioId): readonly string[] {
  return MEMORY_CONNECTIONS_SCALE_FIXTURE.scenarios.find(scenario => scenario.id === id)!.expectedMemoryIds;
}

function expectedScaleConnectionReceipts(
  id: MemoryConnectionsScaleScenarioId,
): readonly MemoryConnectionsScaleConnectionReceiptEvidenceV1[] {
  const scenario = MEMORY_CONNECTIONS_SCALE_FIXTURE.scenarios.find(value => value.id === id)!;
  return scenario.expectedMemoryIds.map(memoryId => ({
    currentness: 'current',
    direction: 'incoming',
    distance: 1,
    neighborMemoryId: memoryId,
    origin: 'relation',
    relationOrdinal: 0,
    relationType: 'related_to',
    requestedOrdinal: 0,
    resolution: 'resolved',
    sourceMemoryId: memoryId,
    targetMemoryId: scenario.premiseMemoryId,
  }));
}

function connectionReceiptIdentityMatches(
  actual: MemoryConnectionsScaleConnectionReceiptEvidenceV1,
  expected: MemoryConnectionsScaleConnectionReceiptEvidenceV1 | undefined,
): boolean {
  return (
    expected !== undefined &&
    actual.direction === expected.direction &&
    actual.distance === expected.distance &&
    actual.neighborMemoryId === expected.neighborMemoryId &&
    actual.origin === expected.origin &&
    actual.relationOrdinal === expected.relationOrdinal &&
    actual.relationType === expected.relationType &&
    actual.requestedOrdinal === expected.requestedOrdinal &&
    actual.sourceMemoryId === expected.sourceMemoryId &&
    actual.targetMemoryId === expected.targetMemoryId
  );
}

export function parseMemoryConnectionsScaleBudgetV1(value: unknown): MemoryConnectionsScaleBudgetV1 {
  if (!Predicate.isObject(value)) invalid('budget must be an object');
  const budget = value;
  const expectedEntries = Object.entries(MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET);
  if (Object.keys(budget).length !== expectedEntries.length)
    invalid('budget fields do not match the approved contract');
  for (const [key, expected] of expectedEntries) {
    if (budget[key] !== expected) invalid(`budget ${key} does not match the reviewed value ${expected}`);
  }
  return {...MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET};
}

/** Recompute correctness and release eligibility from captured observations. */
export function evaluateMemoryConnectionsScaleCapture(input: {
  readonly budget: MemoryConnectionsScaleBudgetV1 | unknown;
  readonly capture: MemoryConnectionsScaleCaptureV1;
  readonly createdAt: string;
  readonly identity: MemoryConnectionsScaleIdentityV1;
}): MemoryConnectionsScaleArtifactV1 {
  const budget = parseMemoryConnectionsScaleBudgetV1(input.budget);
  const {capture, identity} = input;
  const releaseShape =
    identity.invocationMode === 'release-scale' &&
    identity.runnerClass === MEMORY_CONNECTIONS_SCALE_RELEASE_RUNNER_CLASS &&
    identity.candidateCommit === identity.observedCommit &&
    !identity.dirty &&
    /^[0-9a-f]{64}$/u.test(identity.builtArtifactSha256) &&
    capture.fixtureHash === MEMORY_CONNECTIONS_SCALE_APPROVED_FIXTURE_HASH &&
    capture.corpus.authorizedHubMemoryCount === budget.corpusMemoryCount - 6 &&
    capture.corpus.materializedMemoryCount === budget.corpusMemoryCount &&
    capture.corpus.indexedMemoryCount === budget.corpusMemoryCount &&
    capture.scenarios.every(
      scenario => scenario.warmups.length >= budget.minimumWarmups && scenario.samples.length >= budget.minimumSamples,
    );
  const evidenceClass: MemoryConnectionsScaleEvidenceClass = releaseShape ? 'release-scale' : 'development-smoke';
  const all = capture.scenarios.flatMap(scenario => [scenario.cold, ...scenario.warmups, ...scenario.samples]);
  const measured = capture.scenarios.flatMap(scenario => scenario.samples);
  let expectedCount = 0;
  let returnedCount = 0;
  let truePositiveCount = 0;
  let unexpectedResultCount = 0;
  let duplicateResultCount = 0;
  let unexpectedReceiptIdentityCount = 0;
  let incorrectConnectionCurrentnessCount = 0;
  let incorrectConnectionReceiptIdentityCount = 0;
  let incorrectConnectionResolutionCount = 0;
  let incorrectPremiseReceiptIdentityCount = 0;
  let incorrectPremiseStateCount = 0;
  for (const scenario of capture.scenarios) {
    const expected = new Set(scenario.expectedMemoryIds);
    const fixture = MEMORY_CONNECTIONS_SCALE_FIXTURE.scenarios.find(value => value.id === scenario.id)!;
    const expectedReceiptMemoryIds = new Set([...scenario.expectedMemoryIds, fixture.premiseMemoryId]);
    const expectedConnectionReceipts = expectedScaleConnectionReceipts(scenario.id);
    for (const observation of [scenario.cold, ...scenario.warmups, ...scenario.samples]) {
      expectedCount += expected.size;
      returnedCount += observation.returnedMemoryIds.length;
      truePositiveCount += observation.returnedMemoryIds.filter(id => expected.has(id)).length;
      unexpectedResultCount += observation.returnedMemoryIds.filter(id => !expected.has(id)).length;
      duplicateResultCount += observation.returnedMemoryIds.length - new Set(observation.returnedMemoryIds).size;
      for (const [index, receipt] of observation.projectedConnections.entries()) {
        if (receipt.currentness !== 'current') incorrectConnectionCurrentnessCount += 1;
        if (receipt.resolution !== 'resolved') incorrectConnectionResolutionCount += 1;
        if (!connectionReceiptIdentityMatches(receipt, expectedConnectionReceipts[index])) {
          incorrectConnectionReceiptIdentityCount += 1;
        }
        unexpectedReceiptIdentityCount += [receipt.neighborMemoryId, receipt.sourceMemoryId, receipt.targetMemoryId]
          .filter((memoryId): memoryId is string => memoryId !== null)
          .filter(memoryId => !expectedReceiptMemoryIds.has(memoryId)).length;
      }
      for (const receipt of observation.projectedPremises) {
        if (receipt.state !== 'current') incorrectPremiseStateCount += 1;
        if (receipt.memoryId !== fixture.premiseMemoryId || receipt.requestedOrdinal !== 0) {
          incorrectPremiseReceiptIdentityCount += 1;
        }
        if (receipt.memoryId !== null && !expectedReceiptMemoryIds.has(receipt.memoryId)) {
          unexpectedReceiptIdentityCount += 1;
        }
      }
    }
  }
  const noAnswer = capture.scenarios
    .filter(scenario => scenario.expectedMemoryIds.length === 0)
    .flatMap(scenario => [scenario.cold, ...scenario.warmups, ...scenario.samples]);
  const metrics: MemoryConnectionsScaleMetricsV1 = {
    boundedResultAccuracy: mean(all.map(value => (value.returnedMemoryIds.length <= budget.queryLimit ? 1 : 0))),
    duplicateResultCount,
    incorrectConnectionCurrentnessCount,
    incorrectConnectionReceiptIdentityCount,
    incorrectConnectionResolutionCount,
    incorrectPremiseReceiptIdentityCount,
    incorrectPremiseStateCount,
    lookupMilliseconds: benchmarkMeasurement(
      'memory-connections-one-hop',
      'milliseconds',
      measured.map(value => value.milliseconds),
    ),
    maximumCanonicalRereads: Math.max(0, ...all.map(value => value.canonicalRereads)),
    maximumEstimatedTokens: Math.max(0, ...all.map(value => value.estimatedTokens)),
    maximumRawLinkRows: Math.max(0, ...all.map(value => value.rawLinkRows)),
    maximumReturnedMemories: Math.max(0, ...all.map(value => value.returnedMemoryIds.length)),
    noAnswerAccuracy: mean(noAnswer.map(value => (value.returnedMemoryIds.length === 0 ? 1 : 0))),
    precision: ratio(truePositiveCount, returnedCount),
    projectedConnectionCoverageAccuracy: mean(
      capture.scenarios.flatMap(scenario =>
        [scenario.cold, ...scenario.warmups, ...scenario.samples].map(value =>
          projectedConnectionCoverageIsExact(value) ? 1 : 0,
        ),
      ),
    ),
    projectedOutputCompletenessAccuracy: mean(all.map(value => (value.projectedOutputTruncated ? 0 : 1))),
    projectedReceiptAccountingAccuracy: mean(
      capture.scenarios.flatMap(scenario =>
        [scenario.cold, ...scenario.warmups, ...scenario.samples].map(value =>
          value.projectedConnections.length + value.omittedConnectionReceiptCount ===
            scenario.expectedMemoryIds.length && value.projectedPremises.length + value.omittedPremiseReceiptCount === 1
            ? 1
            : 0,
        ),
      ),
    ),
    recall: ratio(truePositiveCount, expectedCount),
    truncationAccuracy: mean(
      capture.scenarios.flatMap(scenario =>
        [scenario.cold, ...scenario.warmups, ...scenario.samples].map(value =>
          value.retrievalTruncated === scenario.expectedTruncated ? 1 : 0,
        ),
      ),
    ),
    unexpectedReceiptIdentityCount,
    unexpectedResultCount,
  };
  const failures: string[] = [];
  if (evidenceClass !== 'release-scale') failures.push('artifact is a development smoke, not release-scale evidence');
  if (identity.dirty) failures.push('candidate checkout is dirty; required dirty=false');
  if (identity.candidateCommit !== identity.observedCommit)
    failures.push('candidate commit does not match observed HEAD');
  if (capture.fixtureHash !== MEMORY_CONNECTIONS_SCALE_APPROVED_FIXTURE_HASH)
    failures.push('fixture hash is not approved');
  exact(failures, 'materialized memory corpus', capture.corpus.materializedMemoryCount, budget.corpusMemoryCount);
  exact(failures, 'indexed memory corpus', capture.corpus.indexedMemoryCount, budget.corpusMemoryCount);
  exact(failures, 'authorized dense-hub corpus', capture.corpus.authorizedHubMemoryCount, budget.corpusMemoryCount - 6);
  if (capture.scenarios.map(value => value.id).join(',') !== MEMORY_CONNECTIONS_SCALE_SCENARIOS.join(',')) {
    failures.push('scale scenarios are missing or out of order');
  }
  for (const scenario of capture.scenarios) {
    if (scenario.expectedMemoryIds.join(',') !== memoryConnectionsScaleExpectedIds(scenario.id).join(',')) {
      failures.push(`${scenario.id} expected truth differs from the frozen fixture`);
    }
    if (scenario.samples.length < budget.minimumSamples) failures.push(`${scenario.id} has too few measured samples`);
    if (scenario.warmups.length < budget.minimumWarmups) failures.push(`${scenario.id} has too few warmups`);
  }
  minimum(failures, 'precision', metrics.precision, 1);
  minimum(failures, 'recall', metrics.recall, 1);
  minimum(failures, 'no-answer accuracy', metrics.noAnswerAccuracy, 1);
  minimum(failures, 'truncation accuracy', metrics.truncationAccuracy, 1);
  minimum(failures, 'projected connection coverage accuracy', metrics.projectedConnectionCoverageAccuracy, 1);
  minimum(failures, 'projected output completeness accuracy', metrics.projectedOutputCompletenessAccuracy, 1);
  minimum(failures, 'projected receipt accounting accuracy', metrics.projectedReceiptAccountingAccuracy, 1);
  minimum(failures, 'bounded-result accuracy', metrics.boundedResultAccuracy, 1);
  maximum(failures, 'lookup p95 milliseconds', metrics.lookupMilliseconds.p95, budget.maximumLookupP95Milliseconds);
  maximum(
    failures,
    'lookup maximum milliseconds',
    metrics.lookupMilliseconds.maximum,
    budget.maximumLookupSampleMilliseconds,
  );
  maximum(failures, 'response estimated tokens', metrics.maximumEstimatedTokens, budget.maximumResponseEstimatedTokens);
  maximum(
    failures,
    'canonical rereads per lookup',
    metrics.maximumCanonicalRereads,
    budget.maximumCanonicalRereadsPerLookup,
  );
  maximum(failures, 'raw link rows per lookup', metrics.maximumRawLinkRows, budget.maximumRawLinkRowsPerLookup);
  maximum(failures, 'corpus bytes', capture.corpus.corpusBytes, budget.maximumCorpusBytes);
  maximum(failures, 'added peak RSS bytes', capture.resources.addedPeakRssBytes, budget.maximumAddedPeakRssBytes);
  maximum(failures, 'recall storage bytes', capture.resources.recallStorageBytes, budget.maximumRecallStorageBytes);
  maximum(
    failures,
    'materialization milliseconds',
    capture.resources.materializationMilliseconds,
    budget.maximumMaterializationMilliseconds,
  );
  maximum(
    failures,
    'index build milliseconds',
    capture.resources.indexBuildMilliseconds,
    budget.maximumIndexBuildMilliseconds,
  );
  if (metrics.duplicateResultCount !== 0) failures.push('duplicate results must be zero');
  if (metrics.incorrectConnectionCurrentnessCount !== 0)
    failures.push('connection currentness must match the frozen current fixture');
  if (metrics.incorrectConnectionReceiptIdentityCount !== 0)
    failures.push('connection receipt identities and roles must match the frozen projected prefix');
  if (metrics.incorrectConnectionResolutionCount !== 0)
    failures.push('connection resolution must match the frozen resolved fixture');
  if (metrics.incorrectPremiseReceiptIdentityCount !== 0)
    failures.push('premise receipt identity and role must match the frozen fixture');
  if (metrics.incorrectPremiseStateCount !== 0)
    failures.push('premise currentness must match the frozen current fixture');
  if (metrics.unexpectedReceiptIdentityCount !== 0) failures.push('unexpected receipt identities must be zero');
  if (metrics.unexpectedResultCount !== 0) failures.push('unexpected results must be zero');
  return {
    capture,
    createdAt: new Date(input.createdAt).toISOString(),
    evidenceClass,
    gate: {failures: [...new Set(failures)].sort(), passed: failures.length === 0},
    identity,
    metrics,
    suite: MEMORY_CONNECTIONS_SCALE_ID,
    version: 1,
  };
}

function projectedConnectionCoverageIsExact(value: MemoryConnectionsScaleObservationV1): boolean {
  const returnedMemoryIds = new Set(value.returnedMemoryIds);
  const receiptBackedMemoryIds = new Set(
    value.projectedConnections.flatMap(connection =>
      connection.neighborMemoryId !== null && returnedMemoryIds.has(connection.neighborMemoryId)
        ? [connection.neighborMemoryId]
        : [],
    ),
  );
  const hasRequiredActionableBundle =
    value.returnedMemoryIds.length === 0 ||
    value.projectedConnections.some(
      connection =>
        connection.resolution === 'resolved' &&
        (connection.currentness === 'current' || connection.currentness === 'historical') &&
        connection.neighborMemoryId !== null &&
        returnedMemoryIds.has(connection.neighborMemoryId) &&
        value.projectedPremises.some(
          premise =>
            premise.requestedOrdinal === connection.requestedOrdinal &&
            (premise.state === 'current' || premise.state === 'historical'),
        ),
    );
  return (
    hasRequiredActionableBundle &&
    value.projectedConnectionCoverageTruncated ===
      (value.retrievalTruncated || value.omittedConnectionReceiptCount > 0 || value.omittedPremiseReceiptCount > 0) &&
    value.projectedCoverageConnectionCount === value.projectedConnections.length &&
    value.projectedCoveragePremiseCount === value.projectedPremises.length &&
    value.projectedCoverageResultCount === receiptBackedMemoryIds.size
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 1 : values.reduce((total, value) => total + value, 0) / values.length;
}

function exact(failures: string[], label: string, actual: number, expected: number): void {
  if (actual !== expected) failures.push(`${label} ${actual}; required ${expected}`);
}

function minimum(failures: string[], label: string, actual: number, expected: number): void {
  if (actual < expected) failures.push(`${label} ${actual}; minimum ${expected}`);
}

function maximum(failures: string[], label: string, actual: number, expected: number): void {
  if (actual > expected) failures.push(`${label} ${actual}; maximum ${expected}`);
}

function invalid(message: string): never {
  throw new Error(`Invalid memory-connections scale contract: ${message}.`);
}
