import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Database} from 'bun:sqlite';
import {Effect, Exit, FileSystem, Path} from 'effect';
import {sha256HexSync} from '../src/crypto/sha256.js';
import {codeGraphLayout} from '../src/code_graph/layout.js';
import {CodeGraphIndexer} from '../src/code_graph/indexer.js';
import {resolveRepositoryIdentity} from '../src/code_graph/repository.js';
import {CodeGraphStore, type StoredCodeGraph} from '../src/code_graph/store.js';
import type {CodeGraphProgress} from '../src/code_graph/types.js';
import {runCommandEffect} from '../src/effect/command.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {
  processResourceUsageMaxRssBytes,
  SystemInfo,
  type ProcessResourceUsageRuntime,
  type SystemInfoShape,
} from '../src/effect/system.js';
import {
  BENCHMARK_ARTIFACT_VERSION,
  benchmarkMeasurement,
  parseBenchmarkArtifactV1,
  type BenchmarkArtifactV1,
} from '../src/evaluation/benchmark.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import type {BenchmarkRuntimeProvenance, BenchmarkStorageEnvironment} from './benchmark-code-graph.js';
import {
  CODE_GRAPH_HEAVY_TAIL_GENERATED_TYPESCRIPT_PATH,
  CODE_GRAPH_HEAVY_TAIL_PROFILE,
  CODE_GRAPH_HEAVY_TAIL_SMOKE_PROFILE,
  codeGraphHeavyTailEligibleFiles,
  parseCodeGraphHeavyTailProfile,
  prepareCodeGraphHeavyTailFixture,
  type CodeGraphHeavyTailProfile,
} from './code-graph-heavy-tail-fixture.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const CHILD_OUTPUT_LIMIT_BYTES = 1_048_576;

export interface HeavyTailLanguageTelemetry {
  readonly degradedFiles: number;
  readonly factsBytes: number;
  readonly files: number;
  readonly parseMilliseconds: number;
  readonly persistenceMilliseconds: number;
  readonly requestMilliseconds: number;
  readonly relations: number;
  readonly sourceBytes: number;
  readonly symbols: number;
}

export interface HeavyTailSlowFile {
  readonly bytes: number;
  readonly factsBytes: number;
  readonly language: string;
  readonly parseMilliseconds: number;
  readonly path: string;
  readonly requestMilliseconds: number;
}

export interface HeavyTailExtractionUtilization {
  /** Wall time during which at least one parser request was active. */
  readonly activeWallMilliseconds: number;
  /** Sum of parent-observed request durations divided by active wall time. */
  readonly averageConcurrency: number;
  readonly peakConcurrency: number;
  /** Sum of parent-observed request durations, including worker and JSON-line IPC. */
  readonly requestMilliseconds: number;
}

export interface HeavyTailChildRun {
  readonly cache: {
    readonly factsBytes: number;
    readonly files: number;
    readonly lowSignalJsonFactsBytes: number;
  };
  readonly cpuMilliseconds: number;
  readonly durationMilliseconds: number;
  readonly extraction: HeavyTailExtractionUtilization;
  readonly graph?: {
    readonly digest: string;
    readonly edges: number;
    readonly files: number;
    readonly generatedTypeScriptTailPreserved: boolean;
    readonly lowSignalJsonSymbols: number;
    readonly pathologicalTypeScriptTails: number;
    readonly symbols: number;
    readonly textlessSvgSymbols: number;
  };
  readonly interruptedAfterPersistedFiles?: number;
  readonly languages: Readonly<Record<string, HeavyTailLanguageTelemetry>>;
  readonly peakRssBytes: number;
  readonly readingMilliseconds: number;
  readonly reusedFiles?: number;
  readonly slowFiles: readonly HeavyTailSlowFile[];
  readonly state: 'complete' | 'interrupted';
  readonly version: 2;
  readonly workerCount: number;
}

export interface CodeGraphHeavyTailBenchmarkArtifact {
  readonly assertions: {
    readonly interruptionRetainedCache: true;
    readonly lowSignalJsonExcluded: true;
    readonly parallelMatchesSingle: true;
    readonly sixWorkersMatchSingle: true;
    readonly pathologicalTypeScriptSurfacePreserved: true;
    readonly resumeMatchesClean: true;
    readonly resumeReusedCache: true;
    readonly textlessSvgExcluded: true;
    readonly eightWorkersMatchSingle: true;
  };
  readonly createdAt: string;
  readonly environment: {
    readonly architecture: string;
    readonly availableBytes?: number;
    readonly commit: string;
    readonly cpu: string;
    readonly dirty: boolean;
    readonly memoryBytes: number;
    readonly minimumFreeBytes?: number;
    readonly operatingSystem: string;
    readonly provenance?: BenchmarkRuntimeProvenance;
    readonly runtime: string;
    readonly runnerClass: string;
    readonly runnerIdentity: string;
    readonly storage?: BenchmarkStorageEnvironment;
  };
  readonly profile: CodeGraphHeavyTailProfile;
  readonly ratchetArtifact: BenchmarkArtifactV1;
  readonly runs: {
    readonly eightWorkers: HeavyTailChildRun;
    readonly interrupted: HeavyTailChildRun;
    readonly parallel: HeavyTailChildRun;
    readonly resumed: HeavyTailChildRun;
    readonly sixWorkers: HeavyTailChildRun;
    readonly single: HeavyTailChildRun;
  };
  readonly suite: 'code-graph-large-monorepo-heavy-tail-v2';
  readonly version: 3;
}

export interface LegacyCodeGraphHeavyTailBenchmarkArtifact extends Omit<
  CodeGraphHeavyTailBenchmarkArtifact,
  'ratchetArtifact' | 'version'
> {
  readonly ratchetArtifact?: undefined;
  readonly version: 2;
}

export type AnyCodeGraphHeavyTailBenchmarkArtifact =
  CodeGraphHeavyTailBenchmarkArtifact | LegacyCodeGraphHeavyTailBenchmarkArtifact;

export interface HeavyTailGovernanceEvidence {
  readonly availableBytes: number;
  readonly minimumFreeBytes: number;
  readonly runtimeProvenance: BenchmarkRuntimeProvenance;
  readonly storage: BenchmarkStorageEnvironment;
}

export interface CodeGraphHeavyTailBenchmarkArguments {
  readonly child: boolean;
  readonly governed: boolean;
  readonly home?: string;
  readonly interruptAfterPersistedFiles?: number;
  readonly minimumFreeGiB: number;
  readonly outputPath?: string;
  readonly profilePath?: string;
  readonly ratchetPath?: string;
  readonly repository?: string;
  readonly smoke: boolean;
  readonly workers?: number;
}

const benchmark = Effect.scoped(
  Effect.gen(function* () {
    const args = parseCodeGraphHeavyTailBenchmarkArguments(yield* scriptArguments());
    if (args.child) return yield* runChild(args);
    return yield* runParent(args);
  }),
);

const runParent = Effect.fn('benchmarkCodeGraphHeavyTail.parent')(function* (
  args: CodeGraphHeavyTailBenchmarkArguments,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const sourceRoot = path.resolve(yield* path.fromFileUrl(new URL('..', import.meta.url)));
  const governance = args.governed
    ? yield* prepareHeavyTailGovernance(system, sourceRoot, args.minimumFreeGiB)
    : undefined;
  const ratchet = args.ratchetPath === undefined ? undefined : yield* readJsonFile(args.ratchetPath);
  if (ratchet !== undefined) {
    const {validateCodeGraphBenchmarkRatchet} = yield* Effect.promise(() => import('./benchmark-code-graph.js'));
    validateCodeGraphBenchmarkRatchet(ratchet);
  }
  const profile = args.smoke ? CODE_GRAPH_HEAVY_TAIL_SMOKE_PROFILE : CODE_GRAPH_HEAVY_TAIL_PROFILE;
  const fixture = yield* prepareCodeGraphHeavyTailFixture(profile);
  const profilePath = path.join(fixture.root, 'profile.json');
  yield* fs.writeFileString(profilePath, `${JSON.stringify(profile)}\n`);

  const childScript = yield* path.fromFileUrl(new URL('./benchmark-code-graph-heavy-tail.ts', import.meta.url));
  const single = yield* spawnChild({
    childScript,
    home: path.join(fixture.root, 'home-single'),
    name: 'single',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: 1,
  });
  const parallel = yield* spawnChild({
    childScript,
    home: path.join(fixture.root, 'home-parallel'),
    name: 'parallel',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: profile.parallelWorkers,
  });
  const sixWorkers = yield* spawnChild({
    childScript,
    home: path.join(fixture.root, 'home-six-workers'),
    name: 'six-workers',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: 6,
  });
  const eightWorkers = yield* spawnChild({
    childScript,
    home: path.join(fixture.root, 'home-eight-workers'),
    name: 'eight-workers',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: 8,
  });
  const resumeHome = path.join(fixture.root, 'home-resume');
  const interrupted = yield* spawnChild({
    childScript,
    home: resumeHome,
    interruptAfterPersistedFiles: profile.interruptAfterPersistedFiles,
    name: 'interrupted',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: profile.parallelWorkers,
  });
  const resumed = yield* spawnChild({
    childScript,
    home: resumeHome,
    name: 'resumed',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: profile.parallelWorkers,
  });

  validateCompletedRun('single-worker', single, profile);
  validateCompletedRun('parallel-worker', parallel, profile);
  validateCompletedRun('six-worker', sixWorkers, profile);
  validateCompletedRun('eight-worker', eightWorkers, profile);
  validateCompletedRun('resumed', resumed, profile);
  if (interrupted.state !== 'interrupted' || interrupted.cache.files < 1) {
    return yield* Effect.fail(new ScriptError('The interruption run did not retain any durable parser cache rows.'));
  }
  if ((resumed.reusedFiles ?? 0) < 1) {
    return yield* Effect.fail(new ScriptError('The resumed run did not reuse facts persisted before interruption.'));
  }
  if (single.graph!.digest !== parallel.graph!.digest) {
    return yield* Effect.fail(new ScriptError('Single-worker and parallel code graphs differ.'));
  }
  if (single.graph!.digest !== sixWorkers.graph!.digest) {
    return yield* Effect.fail(new ScriptError('Single-worker and six-worker code graphs differ.'));
  }
  if (single.graph!.digest !== eightWorkers.graph!.digest) {
    return yield* Effect.fail(new ScriptError('Single-worker and eight-worker code graphs differ.'));
  }
  if (single.graph!.digest !== resumed.graph!.digest) {
    return yield* Effect.fail(new ScriptError('Interrupted/resumed and clean code graphs differ.'));
  }

  const hardware = yield* system.hardwareInfo;
  const [commit, dirty] =
    governance === undefined
      ? yield* Effect.all([git(sourceRoot, ['rev-parse', 'HEAD']), git(sourceRoot, ['status', '--porcelain'])], {
          concurrency: 2,
        })
      : [governance.runtimeProvenance.sourceCommit, ''];
  if (governance !== undefined) {
    const {validateBenchmarkRuntimeProvenance} = yield* Effect.promise(() => import('./benchmark-code-graph.js'));
    const finalProvenance = yield* validateBenchmarkRuntimeProvenance(sourceRoot);
    if (JSON.stringify(finalProvenance) !== JSON.stringify(governance.runtimeProvenance)) {
      return yield* Effect.fail(
        new ScriptError('Heavy-tail benchmark source/runtime provenance changed during the run.'),
      );
    }
  }
  const baseArtifact = {
    assertions: {
      interruptionRetainedCache: true,
      lowSignalJsonExcluded: true,
      parallelMatchesSingle: true,
      sixWorkersMatchSingle: true,
      pathologicalTypeScriptSurfacePreserved: true,
      resumeMatchesClean: true,
      resumeReusedCache: true,
      textlessSvgExcluded: true,
      eightWorkersMatchSingle: true,
    },
    createdAt: new Date().toISOString(),
    environment: {
      architecture: system.architecture,
      ...(governance === undefined
        ? {}
        : {
            availableBytes: governance.availableBytes,
            minimumFreeBytes: governance.minimumFreeBytes,
            provenance: governance.runtimeProvenance,
            storage: governance.storage,
          }),
      commit,
      cpu: hardware.cpuModel,
      dirty: dirty.length > 0,
      memoryBytes: hardware.memoryBytes,
      operatingSystem: hardware.operatingSystem,
      runtime: `bun/${system.runtimeVersion}`,
      runnerClass: process.env.THREADNOTE_BENCHMARK_RUNNER_CLASS?.trim() || 'local-unclassified',
      runnerIdentity: process.env.THREADNOTE_BENCHMARK_RUNNER_ID?.trim() || 'local',
    },
    profile,
    runs: {eightWorkers, interrupted, parallel, resumed, sixWorkers, single},
    suite: 'code-graph-large-monorepo-heavy-tail-v2',
    version: 3,
  } satisfies Omit<CodeGraphHeavyTailBenchmarkArtifact, 'ratchetArtifact'>;
  const artifact: CodeGraphHeavyTailBenchmarkArtifact = {
    ...baseArtifact,
    ratchetArtifact: codeGraphHeavyTailRatchetArtifact(baseArtifact, system.platform, governance),
  };
  parseCodeGraphHeavyTailBenchmarkArtifact(artifact);
  if (args.outputPath) yield* atomicWrite(args.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  yield* printJson(artifact);
  if (ratchet !== undefined) {
    const {enforceCodeGraphBenchmarkRatchet} = yield* Effect.promise(() => import('./benchmark-code-graph.js'));
    return yield* Effect.try({
      catch: cause =>
        cause instanceof ScriptError
          ? cause
          : new ScriptError(`Heavy-tail performance ratchet failed: ${String(cause)}`),
      try: () => enforceCodeGraphBenchmarkRatchet(artifact.ratchetArtifact, ratchet),
    });
  }
});

const prepareHeavyTailGovernance = Effect.fn('benchmarkCodeGraphHeavyTail.prepareGovernance')(function* (
  system: SystemInfoShape,
  sourceRoot: string,
  minimumFreeGiB: number,
) {
  const minimumFreeBytes = minimumFreeGiB * 1_073_741_824;
  const {benchmarkStorageEnvironment, validateBenchmarkRuntimeProvenance} = yield* Effect.promise(
    () => import('./benchmark-code-graph.js'),
  );
  const [runtimeProvenance, storage, availableBytes] = yield* Effect.all(
    [
      validateBenchmarkRuntimeProvenance(sourceRoot),
      benchmarkStorageEnvironment(system.tempDirectory),
      system.availableDiskBytes(system.tempDirectory),
    ],
    {concurrency: 3},
  );
  if (availableBytes === undefined || availableBytes < minimumFreeBytes) {
    return yield* Effect.fail(
      new ScriptError(
        `Governed heavy-tail benchmark requires at least ${minimumFreeGiB} GiB free on its temporary filesystem.`,
      ),
    );
  }
  if (storage.medium !== 'solid-state') {
    return yield* Effect.fail(
      new ScriptError(`Governed heavy-tail benchmark requires solid-state storage; detected ${storage.medium}.`),
    );
  }
  if (system.platform === 'darwin' && storage.location !== 'internal') {
    return yield* Effect.fail(
      new ScriptError(
        `Governed heavy-tail benchmark requires the internal macOS device; detected ${storage.location}.`,
      ),
    );
  }
  return {availableBytes, minimumFreeBytes, runtimeProvenance, storage} satisfies HeavyTailGovernanceEvidence;
});

export function codeGraphHeavyTailRatchetArtifact(
  artifact: Omit<CodeGraphHeavyTailBenchmarkArtifact, 'ratchetArtifact'>,
  runtimePlatform: string,
  governance?: HeavyTailGovernanceEvidence,
): BenchmarkArtifactV1 {
  const runs = [
    ['single', artifact.runs.single],
    ['parallel', artifact.runs.parallel],
    ['six-workers', artifact.runs.sixWorkers],
    ['eight-workers', artifact.runs.eightWorkers],
    ['interrupted', artifact.runs.interrupted],
    ['resumed', artifact.runs.resumed],
  ] as const;
  const measurements = runs.flatMap(([name, run]) =>
    heavyTailRunMeasurements(name, run, name !== 'interrupted' && name !== 'resumed'),
  );
  measurements.push(
    benchmarkMeasurement('parallel-duration-reduction', 'percent', [
      nonNegativePercentReduction(
        artifact.runs.single.durationMilliseconds,
        artifact.runs.parallel.durationMilliseconds,
      ),
    ]),
    benchmarkMeasurement('parallel-active-wall-reduction', 'percent', [
      nonNegativePercentReduction(
        artifact.runs.single.extraction.activeWallMilliseconds,
        artifact.runs.parallel.extraction.activeWallMilliseconds,
      ),
    ]),
    benchmarkMeasurement('resume-retained-cache-coverage', 'percent', [
      percentage(artifact.runs.resumed.reusedFiles ?? 0, artifact.runs.interrupted.cache.files),
    ]),
  );
  const fixtureHash = `code-graph-heavy-tail-v1:${sha256HexSync(JSON.stringify(artifact.profile))}`;
  const ratchetArtifact: BenchmarkArtifactV1 = {
    createdAt: artifact.createdAt,
    environment: {
      architecture: artifact.environment.architecture,
      commit: artifact.environment.commit,
      cpu: artifact.environment.cpu,
      dirty: artifact.environment.dirty,
      fixtureHash,
      memoryBytes: artifact.environment.memoryBytes,
      node: artifact.environment.runtime,
      operatingSystem: artifact.environment.operatingSystem,
      packageManager: artifact.environment.runtime,
      runner: 'threadnote-code-graph-heavy-tail',
      runnerVersion: '3',
    },
    measurements,
    metadata: {
      automaticParserWorkers: artifact.profile.parallelWorkers,
      governed: governance !== undefined,
      graphDigest: artifact.runs.single.graph?.digest ?? 'missing',
      minimumFreeGiB: governance === undefined ? 0 : governance.minimumFreeBytes / 1_073_741_824,
      profile: `${artifact.profile.id}-v${artifact.profile.version}`,
      runnerClass: artifact.environment.runnerClass,
      runnerIdentity: artifact.environment.runnerIdentity,
      runtimePlatform,
      storageFilesystem: governance?.storage.filesystem ?? 'unverified',
      storageLocation: governance?.storage.location ?? 'unverified',
      storageMedium: governance?.storage.medium ?? 'unverified',
      vectorEnabled: false,
      workerCapacities: '1,4,6,8',
    },
    suite: 'threadnote-code-graph-heavy-tail',
    version: BENCHMARK_ARTIFACT_VERSION,
    warmups: 0,
  };
  return parseBenchmarkArtifactV1(ratchetArtifact);
}

interface HeavyTailMeasurementRatchet {
  readonly maximum?: number;
  readonly minimum?: number;
  readonly p95Maximum?: number;
  readonly samplesMinimum: 1;
  readonly unit: BenchmarkArtifactV1['measurements'][number]['unit'];
}

const HEAVY_TAIL_RATCHET_RELATIVE_HEADROOM = 0.15;
const HEAVY_TAIL_RATCHET_MILLISECOND_NOISE_HEADROOM = 5;

export interface CodeGraphHeavyTailRatchet {
  readonly environment: Readonly<Record<string, boolean | number | string>>;
  readonly measurements: Readonly<Record<string, HeavyTailMeasurementRatchet>>;
  readonly metadata: Readonly<Record<string, boolean | number | string>>;
  readonly suite: 'threadnote-code-graph-heavy-tail';
  readonly version: 1;
}

export function createCodeGraphHeavyTailRatchet(
  artifacts: readonly CodeGraphHeavyTailBenchmarkArtifact[],
): CodeGraphHeavyTailRatchet {
  if (artifacts.length < 3) throw new ScriptError('Heavy-tail ratchet generation requires at least three artifacts.');
  const standards = artifacts.map(artifact => parseBenchmarkArtifactV1(artifact.ratchetArtifact));
  const first = standards[0];
  const generationIdentity = governedHeavyTailRatchetGenerationIdentity(artifacts[0], first);
  const firstNames = first.measurements.map(measurement => measurement.name).sort();
  for (let index = 1; index < standards.length; index += 1) {
    const artifact = standards[index];
    const names = artifact.measurements.map(measurement => measurement.name).sort();
    if (
      artifact.suite !== first.suite ||
      JSON.stringify(names) !== JSON.stringify(firstNames) ||
      artifact.environment.architecture !== first.environment.architecture ||
      artifact.environment.cpu !== first.environment.cpu ||
      artifact.environment.fixtureHash !== first.environment.fixtureHash ||
      artifact.environment.memoryBytes !== first.environment.memoryBytes ||
      artifact.environment.node !== first.environment.node ||
      artifact.environment.operatingSystem !== first.environment.operatingSystem ||
      artifact.environment.packageManager !== first.environment.packageManager ||
      artifact.environment.runner !== first.environment.runner ||
      artifact.environment.runnerVersion !== first.environment.runnerVersion ||
      JSON.stringify(artifact.metadata) !== JSON.stringify(first.metadata)
    ) {
      throw new ScriptError('Heavy-tail ratchet artifacts do not share one governed runner and fixture contract.');
    }
    if (governedHeavyTailRatchetGenerationIdentity(artifacts[index], artifact) !== generationIdentity) {
      throw new ScriptError('Heavy-tail ratchet artifacts do not share one exact source/runtime/storage contract.');
    }
  }
  if (standards.some(artifact => artifact.environment.dirty || artifact.metadata.governed !== true)) {
    throw new ScriptError('Heavy-tail ratchet generation requires clean governed artifacts.');
  }
  const measurements: Record<string, HeavyTailMeasurementRatchet> = {};
  for (const name of firstNames) {
    const samples = standards.map(artifact => artifact.measurements.find(measurement => measurement.name === name)!);
    const unit = samples[0].unit;
    if (samples.some(sample => sample.unit !== unit || sample.samples !== 1)) {
      throw new ScriptError(`Heavy-tail ratchet measurement ${name} has inconsistent samples or units.`);
    }
    measurements[name] = heavyTailMeasurementRatchet(
      name,
      unit,
      samples.map(sample => sample.p50),
    );
  }
  return {
    environment: {
      architecture: first.environment.architecture,
      cpu: first.environment.cpu,
      dirty: false,
      fixtureHash: first.environment.fixtureHash,
      memoryBytes: first.environment.memoryBytes,
      node: first.environment.node,
      operatingSystem: first.environment.operatingSystem,
      packageManager: first.environment.packageManager,
      runner: first.environment.runner,
      runnerVersion: first.environment.runnerVersion,
    },
    measurements,
    metadata: first.metadata,
    suite: 'threadnote-code-graph-heavy-tail',
    version: 1,
  };
}

function governedHeavyTailRatchetGenerationIdentity(
  artifact: CodeGraphHeavyTailBenchmarkArtifact,
  standard: BenchmarkArtifactV1,
): string {
  const {availableBytes, commit, minimumFreeBytes, provenance, storage} = artifact.environment;
  if (
    standard.environment.commit !== commit ||
    standard.metadata.governed !== true ||
    provenance === undefined ||
    provenance.sourceCommit !== commit ||
    storage === undefined ||
    availableBytes === undefined ||
    minimumFreeBytes === undefined ||
    minimumFreeBytes < 120 * 1_073_741_824 ||
    availableBytes < minimumFreeBytes ||
    storage.filesystem === 'unknown' ||
    storage.medium !== 'solid-state' ||
    (standard.metadata.runtimePlatform === 'darwin' && storage.location !== 'internal') ||
    standard.metadata.minimumFreeGiB !== minimumFreeBytes / 1_073_741_824 ||
    standard.metadata.storageFilesystem !== storage.filesystem ||
    standard.metadata.storageLocation !== storage.location ||
    standard.metadata.storageMedium !== storage.medium
  ) {
    throw new ScriptError('Heavy-tail ratchet generation requires complete exact governed provenance.');
  }
  return JSON.stringify({commit, minimumFreeBytes, provenance, storage});
}

function heavyTailMeasurementRatchet(
  name: string,
  unit: BenchmarkArtifactV1['measurements'][number]['unit'],
  values: readonly number[],
): HeavyTailMeasurementRatchet {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const base = {samplesMinimum: 1 as const, unit};
  const scheduleDependentResume = name.startsWith('interrupted-') || name.startsWith('resumed-');
  if (name.endsWith('-extraction-average-concurrency') && !scheduleDependentResume) {
    return {...base, minimum: floorThreshold(minimum * 0.9)};
  }
  if (name.endsWith('-duration-reduction') || name.endsWith('-active-wall-reduction')) {
    return {...base, minimum: floorThreshold(minimum * 0.8)};
  }
  if (name === 'resume-retained-cache-coverage') return {...base, maximum: 100, minimum: 100};
  if (name.endsWith('-interrupted-after-persisted-files')) {
    return {
      ...base,
      maximum: codeGraphHeavyTailEligibleFiles(CODE_GRAPH_HEAVY_TAIL_PROFILE),
      minimum: CODE_GRAPH_HEAVY_TAIL_PROFILE.interruptAfterPersistedFiles,
    };
  }
  if (name === 'resumed-reused-files') {
    return {
      ...base,
      maximum: codeGraphHeavyTailEligibleFiles(CODE_GRAPH_HEAVY_TAIL_PROFILE),
      minimum: CODE_GRAPH_HEAVY_TAIL_PROFILE.interruptAfterPersistedFiles,
    };
  }
  if (name.endsWith('-reused-files')) {
    return {...base, maximum, minimum};
  }
  if (name === 'interrupted-cache-files') {
    return {
      ...base,
      maximum: codeGraphHeavyTailEligibleFiles(CODE_GRAPH_HEAVY_TAIL_PROFILE),
      minimum: CODE_GRAPH_HEAVY_TAIL_PROFILE.interruptAfterPersistedFiles,
    };
  }
  if (name.endsWith('-extraction-peak-concurrency') && scheduleDependentResume) {
    return {...base, maximum};
  }
  if (name.endsWith('-extraction-peak-concurrency') || deterministicHeavyTailMeasurement(name)) {
    return {...base, maximum, minimum};
  }
  if (unit === 'bytes' && name.endsWith('-source-bytes')) return {...base, maximum, minimum};
  if (unit === 'milliseconds') {
    return {
      ...base,
      p95Maximum:
        maximum === 0
          ? 0
          : Math.ceil(
              Math.max(
                maximum * (1 + HEAVY_TAIL_RATCHET_RELATIVE_HEADROOM),
                maximum + HEAVY_TAIL_RATCHET_MILLISECOND_NOISE_HEADROOM,
              ),
            ),
    };
  }
  if (unit === 'bytes') {
    return {...base, p95Maximum: Math.ceil(maximum * (1 + HEAVY_TAIL_RATCHET_RELATIVE_HEADROOM))};
  }
  return {...base, maximum: Math.ceil(maximum * 1.05)};
}

function deterministicHeavyTailMeasurement(name: string): boolean {
  return (
    name.includes('-graph-') ||
    name.endsWith('-cache-files') ||
    name.endsWith('-cache-low-signal-json-facts-bytes') ||
    name.endsWith('-degraded-files') ||
    name.endsWith('-files') ||
    name.endsWith('-relations') ||
    name.endsWith('-symbols')
  );
}

function floorThreshold(value: number): number {
  return Math.floor(value * 1_000) / 1_000;
}

function heavyTailRunMeasurements(
  name: string,
  run: HeavyTailChildRun,
  includeLanguageTelemetry: boolean,
): ReturnType<typeof benchmarkMeasurement>[] {
  const measurements = [
    benchmarkMeasurement(`${name}-duration`, 'milliseconds', [run.durationMilliseconds]),
    benchmarkMeasurement(`${name}-cpu`, 'milliseconds', [run.cpuMilliseconds]),
    benchmarkMeasurement(`${name}-peak-rss`, 'bytes', [run.peakRssBytes]),
    benchmarkMeasurement(`${name}-reading`, 'milliseconds', [run.readingMilliseconds]),
    benchmarkMeasurement(`${name}-extraction-active-wall`, 'milliseconds', [run.extraction.activeWallMilliseconds]),
    benchmarkMeasurement(`${name}-extraction-average-concurrency`, 'count', [run.extraction.averageConcurrency]),
    benchmarkMeasurement(`${name}-extraction-peak-concurrency`, 'count', [run.extraction.peakConcurrency]),
    benchmarkMeasurement(`${name}-extraction-request`, 'milliseconds', [run.extraction.requestMilliseconds]),
    benchmarkMeasurement(`${name}-cache-files`, 'count', [run.cache.files]),
    benchmarkMeasurement(`${name}-cache-facts-bytes`, 'bytes', [run.cache.factsBytes]),
    benchmarkMeasurement(`${name}-cache-low-signal-json-facts-bytes`, 'bytes', [run.cache.lowSignalJsonFactsBytes]),
  ];
  if (run.interruptedAfterPersistedFiles !== undefined) {
    measurements.push(
      benchmarkMeasurement(`${name}-interrupted-after-persisted-files`, 'count', [run.interruptedAfterPersistedFiles]),
    );
  }
  if (run.reusedFiles !== undefined) {
    measurements.push(benchmarkMeasurement(`${name}-reused-files`, 'count', [run.reusedFiles]));
  }
  const languages = includeLanguageTelemetry ? Object.entries(run.languages) : [];
  for (const [language, telemetry] of languages.sort(([left], [right]) => left.localeCompare(right))) {
    const prefix = `${name}-language-${language}`;
    measurements.push(
      benchmarkMeasurement(`${prefix}-degraded-files`, 'count', [telemetry.degradedFiles]),
      benchmarkMeasurement(`${prefix}-facts-bytes`, 'bytes', [telemetry.factsBytes]),
      benchmarkMeasurement(`${prefix}-files`, 'count', [telemetry.files]),
      benchmarkMeasurement(`${prefix}-parse`, 'milliseconds', [telemetry.parseMilliseconds]),
      benchmarkMeasurement(`${prefix}-persistence`, 'milliseconds', [telemetry.persistenceMilliseconds]),
      benchmarkMeasurement(`${prefix}-request`, 'milliseconds', [telemetry.requestMilliseconds]),
      benchmarkMeasurement(`${prefix}-relations`, 'count', [telemetry.relations]),
      benchmarkMeasurement(`${prefix}-source-bytes`, 'bytes', [telemetry.sourceBytes]),
      benchmarkMeasurement(`${prefix}-symbols`, 'count', [telemetry.symbols]),
    );
  }
  if (run.graph !== undefined) {
    measurements.push(
      benchmarkMeasurement(`${name}-graph-edges`, 'count', [run.graph.edges]),
      benchmarkMeasurement(`${name}-graph-files`, 'count', [run.graph.files]),
      benchmarkMeasurement(`${name}-graph-generated-tail-preserved`, 'count', [
        run.graph.generatedTypeScriptTailPreserved ? 1 : 0,
      ]),
      benchmarkMeasurement(`${name}-graph-low-signal-json-symbols`, 'count', [run.graph.lowSignalJsonSymbols]),
      benchmarkMeasurement(`${name}-graph-pathological-typescript-tails`, 'count', [
        run.graph.pathologicalTypeScriptTails,
      ]),
      benchmarkMeasurement(`${name}-graph-symbols`, 'count', [run.graph.symbols]),
      benchmarkMeasurement(`${name}-graph-textless-svg-symbols`, 'count', [run.graph.textlessSvgSymbols]),
    );
  }
  return measurements;
}

function nonNegativePercentReduction(baseline: number, candidate: number): number {
  return Math.max(0, percentage(baseline - candidate, baseline));
}

function percentage(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : (numerator / denominator) * 100;
}

const runChild = Effect.fn('benchmarkCodeGraphHeavyTail.child')(function* (args: CodeGraphHeavyTailBenchmarkArguments) {
  const outputPath = required(args.outputPath, '--output');
  const repository = required(args.repository, '--repository');
  const home = required(args.home, '--home');
  const profilePath = required(args.profilePath, '--profile-file');
  const workerCount = args.workers ?? 1;
  parseCodeGraphHeavyTailProfile(yield* readJsonFile(profilePath));
  const path = yield* Path.Path;
  const indexer = yield* CodeGraphIndexer;
  const store = yield* CodeGraphStore;
  const identity = yield* resolveRepositoryIdentity(repository);
  const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
  const progress = new HeavyTailProgressTelemetry();
  const startedAt = process.hrtime.bigint();
  const startedCpu = process.cpuUsage();
  let interruptedAfterPersistedFiles: number | undefined;
  const exit = yield* Effect.exit(
    indexer.index({
      cwd: repository,
      onProgress: event =>
        Effect.sync(() => {
          progress.observe(event);
          if (
            args.interruptAfterPersistedFiles !== undefined &&
            event.phase === 'scanning' &&
            event.activity?.stage === 'persisting' &&
            event.activity.persistMilliseconds !== undefined
          ) {
            const persisted = progress.persistedFiles;
            if (persisted >= args.interruptAfterPersistedFiles) {
              interruptedAfterPersistedFiles = persisted;
              return true;
            }
          }
          return false;
        }).pipe(
          Effect.flatMap(shouldInterrupt =>
            shouldInterrupt ? Effect.fail(new ScriptError('Expected heavy-tail benchmark interruption.')) : Effect.void,
          ),
        ),
      threadnoteHome: home,
    }),
  );
  const durationMilliseconds = Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND;
  const cpu = process.cpuUsage(startedCpu);
  const cache = databaseCacheTelemetry(layout.databasePath);

  if (Exit.isFailure(exit)) {
    if (interruptedAfterPersistedFiles === undefined) return yield* Effect.failCause(exit.cause);
    const artifact: HeavyTailChildRun = {
      cache,
      cpuMilliseconds: (cpu.user + cpu.system) / 1_000,
      durationMilliseconds,
      extraction: progress.extraction(),
      interruptedAfterPersistedFiles,
      languages: progress.languages(),
      peakRssBytes: processPeakRssBytes(),
      readingMilliseconds: progress.readingMilliseconds,
      slowFiles: progress.slowFiles(),
      state: 'interrupted',
      version: 2,
      workerCount,
    };
    parseHeavyTailChildRun(artifact);
    yield* atomicWrite(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    return;
  }
  if (args.interruptAfterPersistedFiles !== undefined) {
    return yield* Effect.fail(new ScriptError('The heavy-tail benchmark completed before its requested interruption.'));
  }
  const summary = exit.value;
  const graph = yield* store.loadGraph(layout.databasePath, summary.snapshot.id);
  const graphShape = heavyTailGraphShape(graph);
  const artifact: HeavyTailChildRun = {
    cache,
    cpuMilliseconds: (cpu.user + cpu.system) / 1_000,
    durationMilliseconds,
    extraction: progress.extraction(),
    graph: {
      ...graphShape,
      files: summary.snapshot.fileCount,
    },
    languages: progress.languages(),
    peakRssBytes: processPeakRssBytes(),
    readingMilliseconds: progress.readingMilliseconds,
    reusedFiles: summary.reusedFiles,
    slowFiles: progress.slowFiles(),
    state: 'complete',
    version: 2,
    workerCount,
  };
  parseHeavyTailChildRun(artifact);
  yield* atomicWrite(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
});

class HeavyTailProgressTelemetry {
  readonly #activeExtractions = new Map<string, number>();
  readonly #extractionIntervals: Array<{readonly end: number; readonly start: number}> = [];
  readonly #languages = new Map<string, MutableLanguageTelemetry>();
  readonly #slowFiles: HeavyTailSlowFile[] = [];
  #peakExtractionConcurrency = 0;
  persistedFiles = 0;
  readingMilliseconds = 0;

  observe(progress: CodeGraphProgress): void {
    if (progress.phase !== 'scanning') return;
    this.readingMilliseconds = Math.max(this.readingMilliseconds, progress.timings?.readingMilliseconds ?? 0);
    const activity = progress.activity;
    if (!activity) return;
    const now = performance.now();
    if (activity.stage === 'extracting' && activity.parseMilliseconds === undefined) {
      if (!this.#activeExtractions.has(activity.path)) this.#activeExtractions.set(activity.path, now);
      this.#peakExtractionConcurrency = Math.max(this.#peakExtractionConcurrency, this.#activeExtractions.size);
      return;
    }
    const language = this.#languages.get(activity.language) ?? {
      degradedFiles: 0,
      factsBytes: 0,
      files: 0,
      parseMilliseconds: 0,
      persistenceMilliseconds: 0,
      requestMilliseconds: 0,
      relations: 0,
      sourceBytes: 0,
      symbols: 0,
    };
    this.#languages.set(activity.language, language);
    if (activity.stage === 'extracting' && activity.parseMilliseconds !== undefined) {
      const startedAt = this.#activeExtractions.get(activity.path) ?? now;
      this.#activeExtractions.delete(activity.path);
      const requestMilliseconds = Math.max(0, now - startedAt);
      this.#extractionIntervals.push({end: now, start: startedAt});
      language.files += 1;
      language.factsBytes += activity.factsBytes ?? 0;
      language.sourceBytes += activity.bytes;
      language.parseMilliseconds += activity.parseMilliseconds;
      language.requestMilliseconds += requestMilliseconds;
      language.symbols += activity.symbols ?? 0;
      language.relations += activity.relations ?? 0;
      if (activity.degraded) language.degradedFiles += 1;
      this.#slowFiles.push({
        bytes: activity.bytes,
        factsBytes: activity.factsBytes ?? 0,
        language: activity.language,
        parseMilliseconds: activity.parseMilliseconds,
        path: activity.path,
        requestMilliseconds,
      });
    }
    if (activity.stage === 'persisting' && activity.persistMilliseconds !== undefined) {
      language.persistenceMilliseconds += activity.persistMilliseconds;
      this.persistedFiles += activity.batchCompleted;
    }
  }

  languages(): Readonly<Record<string, HeavyTailLanguageTelemetry>> {
    return Object.fromEntries([...this.#languages.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  extraction(): HeavyTailExtractionUtilization {
    const intervals = [...this.#extractionIntervals].sort(
      (left, right) => left.start - right.start || left.end - right.end,
    );
    let activeWallMilliseconds = 0;
    let currentStart: number | undefined;
    let currentEnd: number | undefined;
    for (const interval of intervals) {
      if (currentStart === undefined || currentEnd === undefined) {
        currentStart = interval.start;
        currentEnd = interval.end;
      } else if (interval.start <= currentEnd) {
        currentEnd = Math.max(currentEnd, interval.end);
      } else {
        activeWallMilliseconds += currentEnd - currentStart;
        currentStart = interval.start;
        currentEnd = interval.end;
      }
    }
    if (currentStart !== undefined && currentEnd !== undefined) activeWallMilliseconds += currentEnd - currentStart;
    const requestMilliseconds = intervals.reduce((total, interval) => total + interval.end - interval.start, 0);
    return {
      activeWallMilliseconds,
      averageConcurrency: activeWallMilliseconds === 0 ? 0 : requestMilliseconds / activeWallMilliseconds,
      peakConcurrency: this.#peakExtractionConcurrency,
      requestMilliseconds,
    };
  }

  slowFiles(): readonly HeavyTailSlowFile[] {
    return [...this.#slowFiles]
      .sort((left, right) => right.parseMilliseconds - left.parseMilliseconds || left.path.localeCompare(right.path))
      .slice(0, 10);
  }
}

interface MutableLanguageTelemetry {
  degradedFiles: number;
  factsBytes: number;
  files: number;
  parseMilliseconds: number;
  persistenceMilliseconds: number;
  requestMilliseconds: number;
  relations: number;
  sourceBytes: number;
  symbols: number;
}

function heavyTailGraphShape(graph: StoredCodeGraph) {
  const canonical = {
    edges: [...graph.edges].sort((left, right) => left.id.localeCompare(right.id)),
    symbols: [...graph.symbols].sort((left, right) => left.id.localeCompare(right.id)),
  };
  return {
    digest: sha256HexSync(JSON.stringify(canonical)),
    edges: graph.edges.length,
    generatedTypeScriptTailPreserved: graph.symbols.some(
      symbol =>
        symbol.path === CODE_GRAPH_HEAVY_TAIL_GENERATED_TYPESCRIPT_PATH && symbol.name === 'GeneratedSurfaceTail',
    ),
    lowSignalJsonSymbols: graph.symbols.filter(symbol => /^test\/__snapshots__\/.*\.snapshot\.json$/.test(symbol.path))
      .length,
    pathologicalTypeScriptTails: graph.symbols.filter(
      symbol => symbol.path.startsWith('src/pathological-') && symbol.name.startsWith('PreservedTail'),
    ).length,
    symbols: graph.symbols.length,
    textlessSvgSymbols: graph.symbols.filter(symbol => /^assets\/icons\/icon-\d+\.svg$/.test(symbol.path)).length,
  } satisfies Omit<NonNullable<HeavyTailChildRun['graph']>, 'files'>;
}

function validateCompletedRun(name: string, run: HeavyTailChildRun, profile: CodeGraphHeavyTailProfile): void {
  if (run.state !== 'complete' || !run.graph) throw new ScriptError(`${name} heavy-tail run did not complete.`);
  if (run.graph.lowSignalJsonSymbols !== 0 || run.cache.lowSignalJsonFactsBytes !== 0) {
    throw new ScriptError(`${name} heavy-tail run admitted excluded low-signal JSON.`);
  }
  if (run.graph.pathologicalTypeScriptTails !== profile.pathologicalTypeScriptFiles) {
    throw new ScriptError(`${name} heavy-tail run lost declarations after pathological TypeScript calls.`);
  }
  if (!run.graph.generatedTypeScriptTailPreserved) {
    throw new ScriptError(`${name} heavy-tail run lost declarations from generated TypeScript surface extraction.`);
  }
  if (run.graph.textlessSvgSymbols !== 0) {
    throw new ScriptError(`${name} heavy-tail run admitted excluded textless SVG.`);
  }
  if (run.graph.files !== codeGraphHeavyTailEligibleFiles(profile)) {
    throw new ScriptError(`${name} heavy-tail run indexed ${run.graph.files} files; expected fixture shape mismatch.`);
  }
  if (Object.values(run.languages).some(language => language.degradedFiles > 0)) {
    throw new ScriptError(`${name} heavy-tail run degraded one or more parser files.`);
  }
}

function databaseCacheTelemetry(databasePath: string): HeavyTailChildRun['cache'] {
  const database = new Database(databasePath, {readonly: true});
  try {
    const total = database
      .query('SELECT COUNT(*) AS files, COALESCE(SUM(length(facts_json)), 0) AS factsBytes FROM file_blobs')
      .get() as {readonly factsBytes: number; readonly files: number};
    const json = database
      .query(
        "SELECT COALESCE(SUM(length(facts_json)), 0) AS factsBytes FROM file_blobs WHERE path_hint LIKE 'test/__snapshots__/%'",
      )
      .get() as {readonly factsBytes: number};
    return {
      factsBytes: Number(total.factsBytes),
      files: Number(total.files),
      lowSignalJsonFactsBytes: Number(json.factsBytes),
    };
  } finally {
    database.close();
  }
}

const spawnChild = Effect.fn('benchmarkCodeGraphHeavyTail.spawnChild')(function* (options: {
  readonly childScript: string;
  readonly home: string;
  readonly interruptAfterPersistedFiles?: number;
  readonly name: string;
  readonly profilePath: string;
  readonly repository: string;
  readonly root: string;
  readonly workers: number;
}) {
  const path = yield* Path.Path;
  const outputPath = path.join(options.root, `${options.name}.json`);
  const command = [
    process.execPath,
    options.childScript,
    '--child',
    '--repository',
    options.repository,
    '--home',
    options.home,
    '--profile-file',
    options.profilePath,
    '--workers',
    String(options.workers),
    '--output',
    outputPath,
  ];
  if (options.interruptAfterPersistedFiles !== undefined) {
    command.push('--interrupt-after-files', String(options.interruptAfterPersistedFiles));
  }
  const child = Bun.spawn({
    cmd: command,
    env: {...process.env, THREADNOTE_CODE_GRAPH_PARSER_WORKERS: String(options.workers)},
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
    Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
  );
  if (exitCode !== 0) {
    return yield* Effect.fail(
      new ScriptError(
        `${options.name} heavy-tail child exited with ${exitCode}.\n` +
          boundedOutput('stdout', stdout) +
          boundedOutput('stderr', stderr),
      ),
    );
  }
  return parseHeavyTailChildRun(yield* readJsonFile(outputPath));
});

export function parseHeavyTailChildRun(value: unknown): HeavyTailChildRun {
  if (typeof value !== 'object' || value === null)
    throw new ScriptError('Heavy-tail child artifact must be an object.');
  const artifact = value as Partial<HeavyTailChildRun>;
  if (
    artifact.version !== 2 ||
    !['complete', 'interrupted'].includes(artifact.state ?? '') ||
    !positiveInteger(artifact.workerCount) ||
    !nonNegativeNumber(artifact.durationMilliseconds) ||
    !nonNegativeNumber(artifact.cpuMilliseconds) ||
    !nonNegativeInteger(artifact.peakRssBytes) ||
    !nonNegativeNumber(artifact.readingMilliseconds) ||
    typeof artifact.cache !== 'object' ||
    artifact.cache === null ||
    !nonNegativeInteger(artifact.cache.files) ||
    !nonNegativeInteger(artifact.cache.factsBytes) ||
    !nonNegativeInteger(artifact.cache.lowSignalJsonFactsBytes) ||
    !validExtractionUtilization(artifact.extraction, Number(artifact.workerCount)) ||
    typeof artifact.languages !== 'object' ||
    artifact.languages === null ||
    Object.values(artifact.languages).some(language => !validLanguageTelemetry(language)) ||
    !Array.isArray(artifact.slowFiles) ||
    artifact.slowFiles.some(file => !validSlowFile(file))
  ) {
    throw new ScriptError('Heavy-tail child artifact is invalid.');
  }
  if (artifact.state === 'complete' && artifact.graph === undefined) {
    throw new ScriptError('Completed heavy-tail child artifact must include a graph shape.');
  }
  if (artifact.state === 'interrupted' && !positiveInteger(artifact.interruptedAfterPersistedFiles)) {
    throw new ScriptError('Interrupted heavy-tail child artifact must include its durable interruption point.');
  }
  if (artifact.state === 'interrupted' && artifact.interruptedAfterPersistedFiles !== artifact.cache.files) {
    throw new ScriptError('Interrupted heavy-tail child artifact has inconsistent durable cache accounting.');
  }
  return artifact as HeavyTailChildRun;
}

export function parseCodeGraphHeavyTailBenchmarkArtifact(value: unknown): AnyCodeGraphHeavyTailBenchmarkArtifact {
  if (typeof value !== 'object' || value === null)
    throw new ScriptError('Heavy-tail benchmark artifact must be an object.');
  const artifact = value as Partial<AnyCodeGraphHeavyTailBenchmarkArtifact>;
  if (
    (artifact.version !== 2 && artifact.version !== 3) ||
    artifact.suite !== 'code-graph-large-monorepo-heavy-tail-v2' ||
    typeof artifact.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(artifact.createdAt)) ||
    typeof artifact.runs !== 'object' ||
    artifact.runs === null
  ) {
    throw new ScriptError('Heavy-tail benchmark artifact is invalid.');
  }
  parseCodeGraphHeavyTailProfile(artifact.profile);
  parseHeavyTailChildRun(artifact.runs.single);
  parseHeavyTailChildRun(artifact.runs.parallel);
  parseHeavyTailChildRun(artifact.runs.sixWorkers);
  parseHeavyTailChildRun(artifact.runs.eightWorkers);
  parseHeavyTailChildRun(artifact.runs.interrupted);
  parseHeavyTailChildRun(artifact.runs.resumed);
  if (artifact.version === 3) {
    const ratchetArtifact = parseBenchmarkArtifactV1(artifact.ratchetArtifact);
    if (
      ratchetArtifact.suite !== 'threadnote-code-graph-heavy-tail' ||
      ratchetArtifact.environment.commit !== artifact.environment?.commit
    ) {
      throw new ScriptError('Heavy-tail benchmark ratchet artifact is inconsistent.');
    }
  }
  return artifact as AnyCodeGraphHeavyTailBenchmarkArtifact;
}

export function parseCodeGraphHeavyTailBenchmarkArguments(
  args: readonly string[],
): CodeGraphHeavyTailBenchmarkArguments {
  let child = false;
  let governed = false;
  let home: string | undefined;
  let interruptAfterPersistedFiles: number | undefined;
  let minimumFreeGiB = 120;
  let outputPath: string | undefined;
  let profilePath: string | undefined;
  let ratchetPath: string | undefined;
  let repository: string | undefined;
  let smoke = false;
  let workers: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--child') child = true;
    else if (argument === '--governed') governed = true;
    else if (argument === '--home') home = required(args[++index], argument);
    else if (argument === '--interrupt-after-files') {
      interruptAfterPersistedFiles = integer(args[++index], argument, 1);
    } else if (argument === '--minimum-free-gib') minimumFreeGiB = integer(args[++index], argument, 1);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--profile-file') profilePath = required(args[++index], argument);
    else if (argument === '--ratchet') ratchetPath = required(args[++index], argument);
    else if (argument === '--repository') repository = required(args[++index], argument);
    else if (argument === '--smoke') smoke = true;
    else if (argument === '--workers') workers = integer(args[++index], argument, 1, 8);
    else throw new ScriptError(`Unknown heavy-tail benchmark option: ${argument}`);
  }
  if (child && (governed || minimumFreeGiB !== 120 || ratchetPath !== undefined || smoke)) {
    throw new ScriptError('Parent-only heavy-tail benchmark options cannot be used with --child.');
  }
  if (
    !child &&
    [home, profilePath, repository, workers, interruptAfterPersistedFiles].some(value => value !== undefined)
  ) {
    throw new ScriptError('Child-only heavy-tail benchmark options require --child.');
  }
  if (governed && minimumFreeGiB < 120) {
    throw new ScriptError('--governed requires --minimum-free-gib of at least 120.');
  }
  if (governed && outputPath === undefined) {
    throw new ScriptError('--governed requires --output so exact evidence is retained.');
  }
  if (governed && smoke) throw new ScriptError('--governed cannot be combined with --smoke.');
  if (ratchetPath !== undefined && (!governed || outputPath === undefined)) {
    throw new ScriptError('--ratchet requires --governed and --output.');
  }
  return {
    child,
    governed,
    home,
    interruptAfterPersistedFiles,
    minimumFreeGiB,
    outputPath,
    profilePath,
    ratchetPath,
    repository,
    smoke,
    workers,
  };
}

function integer(
  value: string | undefined,
  option: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number.parseInt(required(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ScriptError(`${option} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ScriptError(`${option} requires a value.`);
  return value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validExtractionUtilization(value: unknown, workerCount: number): value is HeavyTailExtractionUtilization {
  if (typeof value !== 'object' || value === null) return false;
  const extraction = value as Partial<HeavyTailExtractionUtilization>;
  return (
    nonNegativeNumber(extraction.activeWallMilliseconds) &&
    nonNegativeNumber(extraction.averageConcurrency) &&
    nonNegativeInteger(extraction.peakConcurrency) &&
    nonNegativeNumber(extraction.requestMilliseconds) &&
    extraction.averageConcurrency <= workerCount + 1e-6 &&
    extraction.peakConcurrency <= workerCount &&
    extraction.requestMilliseconds + 1e-6 >= extraction.activeWallMilliseconds
  );
}

function validLanguageTelemetry(value: unknown): value is HeavyTailLanguageTelemetry {
  if (typeof value !== 'object' || value === null) return false;
  const language = value as Partial<HeavyTailLanguageTelemetry>;
  return (
    nonNegativeInteger(language.degradedFiles) &&
    nonNegativeInteger(language.factsBytes) &&
    nonNegativeInteger(language.files) &&
    nonNegativeNumber(language.parseMilliseconds) &&
    nonNegativeNumber(language.persistenceMilliseconds) &&
    nonNegativeNumber(language.requestMilliseconds) &&
    nonNegativeInteger(language.relations) &&
    nonNegativeInteger(language.sourceBytes) &&
    nonNegativeInteger(language.symbols) &&
    language.degradedFiles <= language.files &&
    language.requestMilliseconds + 1e-6 >= language.parseMilliseconds
  );
}

function validSlowFile(value: unknown): value is HeavyTailSlowFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<HeavyTailSlowFile>;
  return (
    nonNegativeInteger(file.bytes) &&
    nonNegativeInteger(file.factsBytes) &&
    typeof file.language === 'string' &&
    nonNegativeNumber(file.parseMilliseconds) &&
    typeof file.path === 'string' &&
    nonNegativeNumber(file.requestMilliseconds) &&
    file.requestMilliseconds + 1e-6 >= file.parseMilliseconds
  );
}

function boundedOutput(label: string, output: string): string {
  if (!output) return '';
  const bytes = new TextEncoder().encode(output);
  const bounded =
    bytes.byteLength <= CHILD_OUTPUT_LIMIT_BYTES
      ? output
      : new TextDecoder().decode(bytes.slice(bytes.byteLength - CHILD_OUTPUT_LIMIT_BYTES));
  return `${label}:\n${bounded}\n`;
}

function processPeakRssBytes(): number {
  const maxRss = process.resourceUsage().maxRSS;
  const runtime: ProcessResourceUsageRuntime = 'bun' in process.versions ? 'bun' : 'node';
  return processResourceUsageMaxRssBytes(maxRss, process.platform, runtime);
}

const git = Effect.fn('benchmarkCodeGraphHeavyTail.git')((cwd: string, args: readonly string[]) =>
  runCommandEffect('git', ['-C', cwd, ...args], {maxOutputBytes: 1_048_576, timeoutMs: 30_000}).pipe(
    Effect.map(result => result.stdout.trim()),
  ),
);

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmark, ApplicationLayer));
