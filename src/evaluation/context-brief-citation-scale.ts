import {Clock, Context, Effect, FileSystem} from 'effect';
import {CodeGraphStore} from '../code_graph/store.js';
import type {CodeGraphStoreShape} from '../code_graph/store_shape.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {SystemInfo} from '../effect/system.js';
import {
  compileContextBriefWith,
  projectContextBrief,
  retrieveContextBriefMemoryEvidence,
  validateContextBriefMemoryCitations,
  type ContextBriefGraphEvidenceV1,
  type ContextBriefScopeV1,
} from '../context_brief/index.js';
import {getThreadnoteVersion} from '../version.js';
import {
  contextBriefCitationScaleGate,
  evaluateContextBriefCitationScaleProfile,
  type ContextBriefCitationScaleBudgetV1,
  type ContextBriefCitationScaleCountersV1,
  type ContextBriefCitationScaleObservationV1,
  type ContextBriefCitationScaleProfileId,
} from './context-brief-citation-scale-contract.js';
import {
  contextBriefCitationScaleProject,
  prepareContextBriefCitationScaleFixture,
  type ContextBriefCitationScalePreparedFixture,
  type ContextBriefCitationScalePreparedProfile,
} from './context-brief-citation-scale-fixture.js';

export interface ContextBriefCitationScaleRunOptions {
  readonly budget: ContextBriefCitationScaleBudgetV1;
  readonly builtArtifactSha256: string;
  readonly memoryCandidates: number;
  readonly profileIds: readonly ContextBriefCitationScaleProfileId[];
  readonly samples: number;
  readonly warmups: number;
}

export interface ContextBriefCitationScaleArtifactV1 {
  readonly createdAt: string;
  readonly environment: {
    readonly architecture: string;
    readonly commit: string;
    readonly cpu: string;
    readonly dirty: boolean;
    readonly memoryBytes: number;
    readonly operatingSystem: string;
    readonly runnerClass: string;
    readonly runtime: string;
    readonly sourceVersion: string;
  };
  readonly execution: {
    readonly builtArtifactSha256: string;
    readonly citationReceiptCache: 'cold-per-sample';
    readonly coldGraphBuilds: 0;
    readonly graphDatabaseSessionCounter: string;
    readonly graphSnapshots: 'real-sqlite-prebuilt-ready';
    readonly recallIndex: 'real-sqlite-prebuilt-before-timing';
    readonly timingScope: string;
  };
  readonly fixture: {
    readonly hash: string;
    readonly indexedMemoryCandidates: number;
    readonly legacyV1MemoryCandidates: number;
    readonly readyGraphSetupMilliseconds: number;
    readonly recallIndexBuildMilliseconds: number;
    readonly requestedMemoryCandidates: number;
    readonly worksetRepositoryIdentities: readonly [50, 128];
  };
  readonly gate: {readonly failures: readonly string[]; readonly passed: boolean};
  readonly profiles: readonly ReturnType<typeof evaluateContextBriefCitationScaleProfile>['result'][];
  readonly samples: number;
  readonly suite: 'context-brief-citations-scale-v1';
  readonly version: 1;
  readonly warmups: number;
}

/** Run production recall, validator, compiler, and projector paths from a bundled benchmark target. */
export const evaluateContextBriefCitationScale = Effect.fn('evaluation.contextBriefCitationScale')(function* (
  options: ContextBriefCitationScaleRunOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const graph = yield* ContextBriefCitationScaleGraphInstrumentation;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-brief-citation-scale-'});
  const fixture = yield* prepareContextBriefCitationScaleFixture(root, {
    budget: options.budget,
    memoryCandidates: options.memoryCandidates,
    profileIds: options.profileIds,
    runCount: 1 + options.warmups + options.samples,
  });
  const profileResults: ContextBriefCitationScaleArtifactV1['profiles'][number][] = [];
  const failures: string[] = [];
  for (const profileId of options.profileIds) {
    const cold = yield* runObservation(fixture, graph, profileId, 0);
    for (let index = 0; index < options.warmups; index += 1) {
      yield* runObservation(fixture, graph, profileId, index + 1);
    }
    const observations: ContextBriefCitationScaleObservationV1[] = [];
    for (let index = 0; index < options.samples; index += 1) {
      observations.push(yield* runObservation(fixture, graph, profileId, 1 + options.warmups + index));
      yield* Effect.yieldNow;
    }
    const evaluated = evaluateContextBriefCitationScaleProfile(options.budget, profileId, cold, observations);
    profileResults.push(evaluated.result);
    failures.push(...evaluated.failures);
  }
  const reviewedProfiles = options.budget.profiles.map(profile => profile.id);
  if (JSON.stringify(options.profileIds) !== JSON.stringify(reviewedProfiles)) {
    failures.push('reviewed scale evidence must execute local-100k, workset-50, and workset-128 in order');
  }
  if (fixture.indexedMemoryCandidates !== options.budget.corpusMemoryCandidates) {
    failures.push(
      `indexed memory corpus ${fixture.indexedMemoryCandidates}; required ${options.budget.corpusMemoryCandidates}`,
    );
  }
  if (options.samples < 25 || options.warmups < 5) {
    failures.push(
      `release-quality p95 requires at least 25 samples and 5 warmups; received ${options.samples}/${options.warmups}`,
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(options.builtArtifactSha256)) {
    failures.push('benchmark execution artifact digest is missing or malformed');
  }
  const [hardware, sourceVersion] = yield* Effect.all([system.hardwareInfo, getThreadnoteVersion()]);
  const commit = gitText(['rev-parse', 'HEAD']) || 'unknown';
  const dirty = gitText(['status', '--porcelain']).length > 0;
  const hash = sha256HexSync(
    JSON.stringify({
      budget: options.budget,
      indexedMemoryCandidates: fixture.indexedMemoryCandidates,
      legacyV1MemoryCandidates: fixture.legacyV1MemoryCandidates,
      profiles: profileResults.map(result => result.profile),
    }),
  );
  return {
    createdAt: new Date().toISOString(),
    environment: {
      architecture: system.architecture,
      commit,
      cpu: hardware.cpuModel,
      dirty,
      memoryBytes: hardware.memoryBytes,
      operatingSystem: hardware.operatingSystem,
      runnerClass: system.environment().THREADNOTE_BENCHMARK_RUNNER_CLASS ?? 'local-unpinned',
      runtime: `bun/${system.runtimeVersion}`,
      sourceVersion: `threadnote-${sourceVersion}`,
    },
    execution: {
      builtArtifactSha256: options.builtArtifactSha256,
      citationReceiptCache: 'cold-per-sample',
      coldGraphBuilds: 0,
      graphDatabaseSessionCounter:
        'instruments calls that reach the production CodeGraphStore.withSession implementation against real prebuilt SQLite files; OS file-descriptor opens are not separately counted',
      graphSnapshots: 'real-sqlite-prebuilt-ready',
      recallIndex: 'real-sqlite-prebuilt-before-timing',
      timingScope:
        'warm real SQLite recall retrieval plus production Git identity/status observation, graph SQLite session/lease/evidence reads, citation grouping/validation, Context Brief assembly, and projection; every sample uses unseen citation IDs; fixture creation, recall indexing, ready-snapshot activation, catalog publication, and cold graph indexing are excluded',
    },
    fixture: {
      hash,
      indexedMemoryCandidates: fixture.indexedMemoryCandidates,
      legacyV1MemoryCandidates: fixture.legacyV1MemoryCandidates,
      readyGraphSetupMilliseconds: fixture.readyGraphSetupMilliseconds,
      recallIndexBuildMilliseconds: fixture.recallIndexBuildMilliseconds,
      requestedMemoryCandidates: options.memoryCandidates,
      worksetRepositoryIdentities: [50, 128],
    },
    gate: contextBriefCitationScaleGate(failures),
    profiles: profileResults,
    samples: options.samples,
    suite: 'context-brief-citations-scale-v1',
    version: 1,
    warmups: options.warmups,
  } satisfies ContextBriefCitationScaleArtifactV1;
});

const runObservation = Effect.fn('evaluation.contextBriefCitationScaleObservation')(function* (
  fixture: ContextBriefCitationScalePreparedFixture,
  graph: ContextBriefCitationScaleGraphInstrumentationShape,
  profileId: ContextBriefCitationScaleProfileId,
  ordinal: number,
) {
  const system = yield* SystemInfo;
  const prepared = fixture.profiles.get(profileId)!;
  const token = fixture.runToken(profileId, ordinal);
  graph.reset();
  Bun.gc(true);
  const rssBefore = system.memoryUsage().rss;
  let peakRss = rssBefore;
  let memoryRetrievalMilliseconds = 0;
  let validationMilliseconds = 0;
  let selectedMemories = 0;
  let validationReceipts = 0;
  let exactValidationReceipts = 0;
  const observeRss = () => {
    peakRss = Math.max(peakRss, system.memoryUsage().rss);
  };
  const started = yield* Clock.currentTimeNanos;
  const brief = yield* compileContextBriefWith(
    {
      citationValidation: (scope, candidates, fence) =>
        Effect.gen(function* () {
          const phaseStarted = yield* Clock.currentTimeNanos;
          const validations = yield* validateContextBriefMemoryCitations(fixture.config, scope, candidates, fence);
          const phaseFinished = yield* Clock.currentTimeNanos;
          validationMilliseconds = Number(phaseFinished - phaseStarted) / 1_000_000;
          validationReceipts = validations.reduce((total, validation) => total + validation.receipts.length, 0);
          exactValidationReceipts = validations.reduce(
            (total, validation) => total + validation.receipts.filter(receipt => receipt.status === 'exact').length,
            0,
          );
          observeRss();
          return validations;
        }),
      graphEvidence: () => Effect.succeed(scaleGraphEvidence(prepared)),
      memoryEvidence: plan =>
        Effect.gen(function* () {
          const phaseStarted = yield* Clock.currentTimeNanos;
          const evidence = yield* retrieveContextBriefMemoryEvidence(fixture.config, plan);
          const phaseFinished = yield* Clock.currentTimeNanos;
          memoryRetrievalMilliseconds = Number(phaseFinished - phaseStarted) / 1_000_000;
          selectedMemories = evidence.candidates.length;
          observeRss();
          return evidence;
        }),
      projection: (logical, maximumEstimatedTokens) =>
        Effect.sync(() => {
          const projected = projectContextBrief(logical, maximumEstimatedTokens);
          observeRss();
          return projected;
        }),
    },
    {
      budgetTokens: fixtureBudgetTokens(prepared),
      mode: 'brief',
      scope: profileScope(prepared),
      task: token,
    },
  );
  const finished = yield* Clock.currentTimeNanos;
  observeRss();
  return {
    addedRssBytes: Math.max(0, peakRss - rssBefore),
    contextBriefMilliseconds: Number(finished - started) / 1_000_000,
    counters: graph.snapshot(),
    estimatedTokens: brief.measurement.estimatedTokens,
    exactValidationReceipts,
    memoryRetrievalMilliseconds,
    profile: profileId,
    selectedMemories,
    validationMilliseconds,
    validationReceipts,
  } satisfies ContextBriefCitationScaleObservationV1;
});

interface MutableCounters {
  activeViewFenceObservations: number;
  coldGraphBuilds: number;
  databasePaths: Set<string>;
  effectiveEvidenceBatches: number;
  leaseBalance: number;
  maintenanceRequests: number;
  peakLeaseBalance: number;
  productionStoreSessionCalls: number;
  snapshotLeaseAcquisitions: number;
  snapshotLeaseReleases: number;
  statusObservations: number;
}

export interface ContextBriefCitationScaleGraphInstrumentationShape {
  readonly instrumentStore: (store: CodeGraphStoreShape) => CodeGraphStoreShape;
  readonly recordColdGraphBuild: Effect.Effect<void>;
  readonly recordMaintenanceRequest: Effect.Effect<void>;
  readonly reset: () => void;
  readonly snapshot: () => ContextBriefCitationScaleCountersV1;
}

export class ContextBriefCitationScaleGraphInstrumentation extends Context.Service<
  ContextBriefCitationScaleGraphInstrumentation,
  ContextBriefCitationScaleGraphInstrumentationShape
>()('threadnote/evaluation/ContextBriefCitationScaleGraphInstrumentation') {}

/** Instrument the real graph store boundary without replacing any SQLite behavior. */
export function makeContextBriefCitationScaleGraphInstrumentation(): ContextBriefCitationScaleGraphInstrumentationShape {
  let counters = emptyCounters();
  const observeDatabasePath = (databasePath: string) => {
    counters.databasePaths.add(databasePath);
  };
  const instrumentStore = (store: CodeGraphStoreShape): CodeGraphStoreShape =>
    CodeGraphStore.of({
      ...store,
      acquireSnapshotLease: (databasePath, snapshotId, durationMilliseconds, options) =>
        Effect.sync(() => {
          observeDatabasePath(databasePath);
          counters.snapshotLeaseAcquisitions += 1;
          counters.leaseBalance += 1;
          counters.peakLeaseBalance = Math.max(counters.peakLeaseBalance, counters.leaseBalance);
        }).pipe(Effect.andThen(store.acquireSnapshotLease(databasePath, snapshotId, durationMilliseconds, options))),
      effectiveSnapshotCitationEvidence: (databasePath, snapshotId, request) =>
        Effect.sync(() => {
          observeDatabasePath(databasePath);
          counters.effectiveEvidenceBatches += 1;
        }).pipe(Effect.andThen(store.effectiveSnapshotCitationEvidence(databasePath, snapshotId, request))),
      loadActiveViewFence: (databasePath, worktreeId) =>
        Effect.sync(() => {
          observeDatabasePath(databasePath);
          counters.activeViewFenceObservations += 1;
        }).pipe(Effect.andThen(store.loadActiveViewFence(databasePath, worktreeId))),
      readySnapshot: (databasePath, worktreeId) =>
        Effect.sync(() => {
          observeDatabasePath(databasePath);
          counters.statusObservations += 1;
        }).pipe(Effect.andThen(store.readySnapshot(databasePath, worktreeId))),
      readySnapshotById: (databasePath, snapshotId) =>
        Effect.sync(() => {
          observeDatabasePath(databasePath);
          counters.statusObservations += 1;
        }).pipe(Effect.andThen(store.readySnapshotById(databasePath, snapshotId))),
      releaseSnapshotLease: (databasePath, token, options) =>
        store.releaseSnapshotLease(databasePath, token, options).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              observeDatabasePath(databasePath);
              counters.snapshotLeaseReleases += 1;
              counters.leaseBalance -= 1;
            }),
          ),
        ),
      withSession: (databasePath, effect, options) =>
        Effect.sync(() => {
          observeDatabasePath(databasePath);
          counters.productionStoreSessionCalls += 1;
        }).pipe(Effect.andThen(store.withSession(databasePath, effect, options))),
    });
  const snapshot = (): ContextBriefCitationScaleCountersV1 => ({
    activeViewFenceObservations: counters.activeViewFenceObservations,
    coldGraphBuilds: counters.coldGraphBuilds,
    distinctGraphDatabasePaths: counters.databasePaths.size,
    effectiveEvidenceBatches: counters.effectiveEvidenceBatches,
    leaseBalance: counters.leaseBalance,
    maintenanceRequests: counters.maintenanceRequests,
    peakLeaseBalance: counters.peakLeaseBalance,
    productionStoreSessionCalls: counters.productionStoreSessionCalls,
    snapshotLeaseAcquisitions: counters.snapshotLeaseAcquisitions,
    snapshotLeaseReleases: counters.snapshotLeaseReleases,
    statusObservations: counters.statusObservations,
  });
  return {
    instrumentStore,
    recordColdGraphBuild: Effect.sync(() => {
      counters.coldGraphBuilds += 1;
    }),
    recordMaintenanceRequest: Effect.sync(() => {
      counters.maintenanceRequests += 1;
    }),
    reset: () => {
      counters = emptyCounters();
    },
    snapshot,
  };
}

function scaleGraphEvidence(prepared: ContextBriefCitationScalePreparedProfile): ContextBriefGraphEvidenceV1 {
  const resolvedSnapshots = prepared.repositories.map(repository => ({
    commit: repository.status.identity.headCommit,
    dirty: false,
    freshness: 'fresh' as const,
    repositoryId: repository.repositoryId,
    repositoryKey: repository.name,
    snapshotId: repository.snapshotId,
  }));
  return {
    cards: [],
    citationValidationFence:
      prepared.generation === undefined
        ? {
            kind: 'repository',
            repositoryId: prepared.repositories[0]!.repositoryId,
            snapshotId: prepared.repositories[0]!.snapshotId,
          }
        : {generation: prepared.generation, kind: 'workset', workset: prepared.workset!.name},
    contracts: [],
    coverage: {
      complete: true,
      consideredRepositories: prepared.profile.worksetMembers,
      readyRepositories: prepared.profile.worksetMembers,
      requestedRepositories: prepared.profile.worksetMembers,
      states: {current: prepared.profile.worksetMembers},
    },
    gaps: [],
    resolvedSnapshots,
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    warnings: [],
  };
}

function profileScope(prepared: ContextBriefCitationScalePreparedProfile): ContextBriefScopeV1 {
  return prepared.profile.id === 'local-100k'
    ? {callerCwd: prepared.repositories[0]!.root, kind: 'repository', project: contextBriefCitationScaleProject()}
    : {kind: 'workset', name: prepared.workset!.name, project: contextBriefCitationScaleProject()};
}

function fixtureBudgetTokens(_prepared: ContextBriefCitationScalePreparedProfile): number {
  return 1_500;
}

function emptyCounters(): MutableCounters {
  return {
    activeViewFenceObservations: 0,
    coldGraphBuilds: 0,
    databasePaths: new Set(),
    effectiveEvidenceBatches: 0,
    leaseBalance: 0,
    maintenanceRequests: 0,
    peakLeaseBalance: 0,
    productionStoreSessionCalls: 0,
    snapshotLeaseAcquisitions: 0,
    snapshotLeaseReleases: 0,
    statusObservations: 0,
  };
}

function gitText(arguments_: readonly string[]): string {
  const result = Bun.spawnSync({cmd: ['git', ...arguments_], stderr: 'ignore', stdout: 'pipe'});
  return result.exitCode === 0 && result.stdout ? new TextDecoder().decode(result.stdout).trim() : '';
}
