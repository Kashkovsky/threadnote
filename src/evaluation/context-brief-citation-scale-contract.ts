import {benchmarkMeasurement, type BenchmarkMeasurementV1} from './benchmark.js';

export const CONTEXT_BRIEF_CITATION_SCALE_VERSION = 1 as const;
export const CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS = ['local-100k', 'workset-50', 'workset-128'] as const;

export type ContextBriefCitationScaleProfileId = (typeof CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS)[number];

export interface ContextBriefCitationScaleProfileV1 {
  readonly citationCount: number;
  readonly citedRepositories: number;
  readonly id: ContextBriefCitationScaleProfileId;
  readonly maximumBriefP95Milliseconds: number;
  readonly maximumValidationP95Milliseconds: number;
  readonly selectedMemories: number;
  readonly worksetMembers: number;
}

export interface ContextBriefCitationScaleBudgetV1 {
  readonly corpusMemoryCandidates: number;
  readonly id: string;
  readonly maximumAddedRssBytes: number;
  readonly maximumCitationsPerBrief: number;
  readonly maximumEstimatedTokens: number;
  readonly profiles: readonly ContextBriefCitationScaleProfileV1[];
  readonly version: typeof CONTEXT_BRIEF_CITATION_SCALE_VERSION;
}

export interface ContextBriefCitationScaleCountersV1 {
  readonly activeViewFenceObservations: number;
  readonly coldGraphBuilds: number;
  readonly distinctGraphDatabasePaths: number;
  readonly effectiveEvidenceBatches: number;
  readonly leaseBalance: number;
  readonly maintenanceRequests: number;
  readonly peakLeaseBalance: number;
  /** Calls reaching the production store's real SQLite session boundary. */
  readonly productionStoreSessionCalls: number;
  readonly snapshotLeaseAcquisitions: number;
  readonly snapshotLeaseReleases: number;
  readonly statusObservations: number;
}

export interface ContextBriefCitationScaleObservationV1 {
  readonly addedRssBytes: number;
  readonly contextBriefMilliseconds: number;
  readonly counters: ContextBriefCitationScaleCountersV1;
  readonly estimatedTokens: number;
  readonly exactValidationReceipts: number;
  readonly memoryRetrievalMilliseconds: number;
  readonly profile: ContextBriefCitationScaleProfileId;
  readonly selectedMemories: number;
  readonly validationMilliseconds: number;
  readonly validationReceipts: number;
}

export interface ContextBriefCitationScaleProfileResultV1 {
  readonly coldReadyGraphObservation: ContextBriefCitationScaleObservationV1;
  readonly counters: {
    readonly maximumActiveViewFenceObservations: number;
    readonly maximumDistinctGraphDatabasePaths: number;
    readonly maximumEffectiveEvidenceBatches: number;
    readonly maximumLeaseBalance: number;
    readonly maximumMaintenanceRequests: number;
    readonly maximumPeakLeaseBalance: number;
    readonly maximumProductionStoreSessionCalls: number;
    readonly maximumStatusObservations: number;
  };
  readonly measurements: {
    readonly addedRssBytes: BenchmarkMeasurementV1;
    readonly contextBriefMilliseconds: BenchmarkMeasurementV1;
    readonly memoryRetrievalMilliseconds: BenchmarkMeasurementV1;
    readonly validationMilliseconds: BenchmarkMeasurementV1;
  };
  readonly observations: readonly ContextBriefCitationScaleObservationV1[];
  readonly profile: ContextBriefCitationScaleProfileV1;
  readonly samples: number;
}

export interface ContextBriefCitationScaleGateV1 {
  readonly failures: readonly string[];
  readonly passed: boolean;
}

const EXACT_PROFILE_SHAPES: Readonly<
  Record<
    ContextBriefCitationScaleProfileId,
    Pick<
      ContextBriefCitationScaleProfileV1,
      'citationCount' | 'citedRepositories' | 'selectedMemories' | 'worksetMembers'
    >
  >
> = {
  'local-100k': {citationCount: 96, citedRepositories: 1, selectedMemories: 24, worksetMembers: 1},
  'workset-50': {citationCount: 64, citedRepositories: 16, selectedMemories: 16, worksetMembers: 50},
  'workset-128': {citationCount: 96, citedRepositories: 32, selectedMemories: 24, worksetMembers: 128},
};

/** Parse the checked release envelope and reject silent shape or budget weakening. */
export function parseContextBriefCitationScaleBudgetV1(value: unknown): ContextBriefCitationScaleBudgetV1 {
  const budget = record(value, 'scale budget');
  exactKeys(budget, [
    'corpusMemoryCandidates',
    'id',
    'maximumAddedRssBytes',
    'maximumCitationsPerBrief',
    'maximumEstimatedTokens',
    'profiles',
    'version',
  ]);
  if (budget.version !== 1) invalid('version must be 1');
  if (budget.id !== 'context-brief-citations-scale-v1') invalid('id is not the reviewed scale contract');
  if (budget.corpusMemoryCandidates !== 100_000) invalid('corpusMemoryCandidates must be 100000');
  if (budget.maximumCitationsPerBrief !== 96) invalid('maximumCitationsPerBrief must be 96');
  if (budget.maximumEstimatedTokens !== 1_500) invalid('maximumEstimatedTokens must be 1500');
  if (budget.maximumAddedRssBytes !== 64 * 1_024 * 1_024) invalid('maximumAddedRssBytes must be 64 MiB');
  if (!Array.isArray(budget.profiles) || budget.profiles.length !== CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS.length) {
    invalid('profiles must contain the three reviewed profiles');
  }
  const profiles = budget.profiles.map(parseProfile);
  for (const id of CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS) {
    if (profiles.filter(profile => profile.id === id).length !== 1) invalid(`profile ${id} must appear exactly once`);
  }
  return {
    corpusMemoryCandidates: 100_000,
    id: 'context-brief-citations-scale-v1',
    maximumAddedRssBytes: 64 * 1_024 * 1_024,
    maximumCitationsPerBrief: 96,
    maximumEstimatedTokens: 1_500,
    profiles: CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS.map(id => profiles.find(profile => profile.id === id)!),
    version: 1,
  };
}

/** Aggregate repeated warm-ready observations and enforce safety, fan-out, and latency bounds. */
export function evaluateContextBriefCitationScaleProfile(
  budget: ContextBriefCitationScaleBudgetV1,
  profileId: ContextBriefCitationScaleProfileId,
  coldReadyGraphObservation: ContextBriefCitationScaleObservationV1,
  observations: readonly ContextBriefCitationScaleObservationV1[],
): {readonly failures: readonly string[]; readonly result: ContextBriefCitationScaleProfileResultV1} {
  const profile = budget.profiles.find(candidate => candidate.id === profileId);
  if (!profile) throw new Error(`Unknown scale profile ${profileId}`);
  if (observations.length === 0) throw new Error(`Scale profile ${profileId} requires measured samples.`);
  const all = [coldReadyGraphObservation, ...observations];
  const measurements = {
    addedRssBytes: measurement(
      'added-rss',
      observations.map(observation => observation.addedRssBytes),
      'bytes',
    ),
    contextBriefMilliseconds: measurement(
      'context-brief-total',
      observations.map(observation => observation.contextBriefMilliseconds),
      'milliseconds',
    ),
    memoryRetrievalMilliseconds: measurement(
      'memory-retrieval',
      observations.map(observation => observation.memoryRetrievalMilliseconds),
      'milliseconds',
    ),
    validationMilliseconds: measurement(
      'citation-validation',
      observations.map(observation => observation.validationMilliseconds),
      'milliseconds',
    ),
  };
  const counters = {
    maximumActiveViewFenceObservations: maximum(all, observation => observation.counters.activeViewFenceObservations),
    maximumDistinctGraphDatabasePaths: maximum(all, observation => observation.counters.distinctGraphDatabasePaths),
    maximumEffectiveEvidenceBatches: maximum(all, observation => observation.counters.effectiveEvidenceBatches),
    maximumLeaseBalance: maximum(all, observation => observation.counters.leaseBalance),
    maximumMaintenanceRequests: maximum(all, observation => observation.counters.maintenanceRequests),
    maximumPeakLeaseBalance: maximum(all, observation => observation.counters.peakLeaseBalance),
    maximumProductionStoreSessionCalls: maximum(all, observation => observation.counters.productionStoreSessionCalls),
    maximumStatusObservations: maximum(all, observation => observation.counters.statusObservations),
  };
  const failures = [
    ...all.flatMap((observation, index) => observationFailures(profile, budget, observation, index)),
    coldReadyGraphObservation.counters.effectiveEvidenceBatches === profile.citedRepositories
      ? ''
      : `${profile.id} cold ready-graph evidence batches ${coldReadyGraphObservation.counters.effectiveEvidenceBatches}; expected ${profile.citedRepositories}`,
    measurements.validationMilliseconds.p95 <= profile.maximumValidationP95Milliseconds
      ? ''
      : `${profile.id} validation p95 ${measurements.validationMilliseconds.p95.toFixed(1)}ms exceeds ${profile.maximumValidationP95Milliseconds}ms`,
    measurements.contextBriefMilliseconds.p95 <= profile.maximumBriefP95Milliseconds
      ? ''
      : `${profile.id} brief p95 ${measurements.contextBriefMilliseconds.p95.toFixed(1)}ms exceeds ${profile.maximumBriefP95Milliseconds}ms`,
    measurements.addedRssBytes.maximum <= budget.maximumAddedRssBytes
      ? ''
      : `${profile.id} added RSS ${measurements.addedRssBytes.maximum} exceeds ${budget.maximumAddedRssBytes}`,
  ].filter(Boolean);
  return {
    failures,
    result: {coldReadyGraphObservation, counters, measurements, observations, profile, samples: observations.length},
  };
}

export function contextBriefCitationScaleGate(failures: readonly string[]): ContextBriefCitationScaleGateV1 {
  const stable = [...new Set(failures)].sort();
  return {failures: stable, passed: stable.length === 0};
}

function parseProfile(value: unknown): ContextBriefCitationScaleProfileV1 {
  const profile = record(value, 'scale profile');
  exactKeys(profile, [
    'citationCount',
    'citedRepositories',
    'id',
    'maximumBriefP95Milliseconds',
    'maximumValidationP95Milliseconds',
    'selectedMemories',
    'worksetMembers',
  ]);
  if (!CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS.includes(profile.id as ContextBriefCitationScaleProfileId)) {
    invalid('profile id is unsupported');
  }
  const id = profile.id as ContextBriefCitationScaleProfileId;
  const expected = EXACT_PROFILE_SHAPES[id];
  for (const key of ['citationCount', 'citedRepositories', 'selectedMemories', 'worksetMembers'] as const) {
    if (profile[key] !== expected[key]) invalid(`${id} ${key} does not match the reviewed shape`);
  }
  const maximumValidationP95Milliseconds = positiveInteger(profile.maximumValidationP95Milliseconds, 'validation p95');
  const maximumBriefP95Milliseconds = positiveInteger(profile.maximumBriefP95Milliseconds, 'brief p95');
  const maximum = id === 'local-100k' ? [250, 1_500] : id === 'workset-50' ? [500, 3_000] : [1_000, 5_000];
  if (maximumValidationP95Milliseconds !== maximum[0] || maximumBriefP95Milliseconds !== maximum[1]) {
    invalid(`${id} latency budget does not match the reviewed release target`);
  }
  return {...expected, id, maximumBriefP95Milliseconds, maximumValidationP95Milliseconds};
}

function observationFailures(
  profile: ContextBriefCitationScaleProfileV1,
  budget: ContextBriefCitationScaleBudgetV1,
  observation: ContextBriefCitationScaleObservationV1,
  index: number,
): readonly string[] {
  const prefix = `${profile.id} observation ${index}`;
  const counters = observation.counters;
  const expectedStatusObservations = profile.citedRepositories * (profile.id === 'local-100k' ? 2 : 1);
  const expectedActiveViewFenceObservations = profile.id === 'local-100k' ? 0 : profile.citedRepositories * 2;
  return [
    observation.profile === profile.id ? '' : `${prefix} has wrong profile ${observation.profile}`,
    observation.selectedMemories === profile.selectedMemories
      ? ''
      : `${prefix} selected ${observation.selectedMemories}/${profile.selectedMemories} memories`,
    observation.validationReceipts === profile.citationCount
      ? ''
      : `${prefix} returned ${observation.validationReceipts}/${profile.citationCount} validation receipts`,
    observation.exactValidationReceipts === profile.citationCount
      ? ''
      : `${prefix} returned ${observation.exactValidationReceipts}/${profile.citationCount} exact validation receipts`,
    observation.estimatedTokens <= budget.maximumEstimatedTokens
      ? ''
      : `${prefix} emitted ${observation.estimatedTokens}/${budget.maximumEstimatedTokens} estimated tokens`,
    counters.productionStoreSessionCalls === profile.citedRepositories
      ? ''
      : `${prefix} opened ${counters.productionStoreSessionCalls} production graph-store sessions; expected ${profile.citedRepositories} (one per cited repository)`,
    counters.distinctGraphDatabasePaths === profile.citedRepositories
      ? ''
      : `${prefix} touched ${counters.distinctGraphDatabasePaths}/${profile.citedRepositories} cited graph databases`,
    counters.effectiveEvidenceBatches === profile.citedRepositories
      ? ''
      : `${prefix} issued ${counters.effectiveEvidenceBatches}/${profile.citedRepositories} repository evidence batches`,
    counters.statusObservations === expectedStatusObservations
      ? ''
      : `${prefix} made ${counters.statusObservations}/${expectedStatusObservations} snapshot status observations`,
    counters.activeViewFenceObservations === expectedActiveViewFenceObservations
      ? ''
      : `${prefix} made ${counters.activeViewFenceObservations}/${expectedActiveViewFenceObservations} active-view fence observations`,
    counters.snapshotLeaseAcquisitions === profile.citedRepositories &&
    counters.snapshotLeaseReleases === profile.citedRepositories &&
    counters.leaseBalance === 0
      ? ''
      : `${prefix} acquired/released ${counters.snapshotLeaseAcquisitions}/${counters.snapshotLeaseReleases} snapshot leases; expected ${profile.citedRepositories}/${profile.citedRepositories}`,
    counters.peakLeaseBalance <= 4 ? '' : `${prefix} exceeded validator concurrency 4`,
    counters.coldGraphBuilds === 0 ? '' : `${prefix} started cold graph indexing`,
    counters.maintenanceRequests === 0 ? '' : `${prefix} requested graph maintenance`,
  ].filter(Boolean);
}

function measurement(
  suffix: string,
  values: readonly number[],
  unit: BenchmarkMeasurementV1['unit'],
): BenchmarkMeasurementV1 {
  return benchmarkMeasurement(`context-brief-citations-scale-${suffix}`, unit, values);
}

function maximum(
  values: readonly ContextBriefCitationScaleObservationV1[],
  select: (value: ContextBriefCitationScaleObservationV1) => number,
): number {
  return Math.max(0, ...values.map(select));
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${label} must be a positive integer`);
  return value as number;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) invalid('contains unsupported or missing fields');
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function invalid(detail: string): never {
  throw new Error(`Invalid Context Brief citation scale contract: ${detail}.`);
}
