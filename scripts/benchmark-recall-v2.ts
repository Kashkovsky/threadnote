import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Clock, Effect} from 'effect';
import {runCommandEffect} from '../src/effect/command.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {SystemInfo} from '../src/effect/system.js';
import {
  BENCHMARK_ARTIFACT_VERSION,
  benchmarkMeasurement,
  parseBenchmarkArtifactV1,
  type BenchmarkArtifactV1,
} from '../src/evaluation/benchmark.js';
import {
  createRecallEvaluationFixtureV2,
  expandRecallEvaluationFixtureV2,
  serializeRecallEvaluationFixtureV2Identity,
} from '../src/evaluation/recall-fixture.js';
import {rankRecallCandidates} from '../src/recall/rank.js';
import {atomicWrite, fixtureHash, printJson, scriptArguments} from './effect/script.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

const benchmarkRecall = Effect.gen(function* () {
  const system = yield* SystemInfo;
  const options = parseArguments(yield* scriptArguments());
  const fixture = expandRecallEvaluationFixtureV2(
    createRecallEvaluationFixtureV2(),
    options.documentCount,
    options.seed,
  );
  const hash = yield* fixtureHash(serializeRecallEvaluationFixtureV2Identity(fixture));
  const query = fixture.queries[0]!;
  const runQuery = () =>
    rankRecallCandidates(query.query, fixture.documents, {
      now: query.now ? new Date(query.now) : undefined,
      project: query.project,
      seedUris: query.seedUris,
    });

  for (let index = 0; index < options.warmups; index += 1) runQuery();
  const durations: number[] = [];
  const rss: number[] = [];
  const externalMemory: number[] = [];
  const heapUsed: number[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    const startedAt = yield* Clock.currentTimeNanos;
    const result = runQuery();
    const finishedAt = yield* Clock.currentTimeNanos;
    durations.push(Number(finishedAt - startedAt) / NANOSECONDS_PER_MILLISECOND);
    if (!result.results[0]) return yield* Effect.fail(new Error('Recall benchmark returned no result'));
    const memory = system.memoryUsage();
    rss.push(memory.rss);
    externalMemory.push(memory.external);
    heapUsed.push(memory.heapUsed);
    yield* Effect.yieldNow;
  }
  const latency = benchmarkMeasurement('hybrid-rank-one-query', 'milliseconds', durations);
  const throughput = durations.map(duration => 1_000 / duration);
  const [commit, status, hardware] = yield* Effect.all(
    [git(['rev-parse', 'HEAD']), git(['status', '--porcelain']), system.hardwareInfo()],
    {
      concurrency: 'unbounded',
    },
  );

  const artifact: BenchmarkArtifactV1 = {
    createdAt: new Date().toISOString(),
    environment: {
      architecture: system.architecture,
      commit,
      cpu: hardware.cpuModel,
      dirty: status.length > 0,
      fixtureHash: hash,
      memoryBytes: hardware.memoryBytes,
      node: `bun/${system.runtimeVersion}`,
      operatingSystem: hardware.operatingSystem,
      packageManager: `bun/${system.runtimeVersion}`,
      runner: 'threadnote-recall-e2e',
      runnerVersion: '2',
    },
    measurements: [
      latency,
      benchmarkMeasurement('hybrid-rank-throughput', 'operations_per_second', throughput),
      benchmarkMeasurement('process-rss', 'bytes', rss),
      benchmarkMeasurement('process-external-memory', 'bytes', externalMemory),
      benchmarkMeasurement('process-heap-used', 'bytes', heapUsed),
    ],
    metadata: {
      documents: fixture.documents.length,
      homeRedacted: system.homeDirectory.length > 0,
      queries: fixture.queries.length,
      sampleProfile: options.samples < 10 ? 'scale-boundary' : 'standard',
      seed: options.seed,
      sourceVersion: 'threadnote-3.0.3',
    },
    suite: 'recall-v2',
    version: BENCHMARK_ARTIFACT_VERSION,
    warmups: options.warmups,
  };
  parseBenchmarkArtifactV1(artifact);
  if (options.outputPath) {
    yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  }
  yield* printJson(artifact);
});

interface BenchmarkOptions {
  readonly documentCount: number;
  readonly outputPath?: string;
  readonly samples: number;
  readonly seed: number;
  readonly warmups: number;
}

function parseArguments(args: readonly string[]): BenchmarkOptions {
  let documentCount = 10_000;
  let outputPath: string | undefined;
  let samples = 25;
  let seed = 0x4_00_00;
  let warmups = 5;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--documents') documentCount = positiveInteger(args[++index], argument);
    else if (argument === '--output') outputPath = requiredValue(args[++index], argument);
    else if (argument === '--samples') samples = positiveInteger(args[++index], argument);
    else if (argument === '--seed') seed = positiveInteger(args[++index], argument);
    else if (argument === '--warmups') warmups = nonNegativeInteger(args[++index], argument);
    else throw new Error(`Unknown recall benchmark option: ${argument}`);
  }
  return {documentCount, outputPath, samples, seed, warmups};
}

const git = Effect.fn('benchmark.git')((arguments_: readonly string[]) =>
  runCommandEffect('git', arguments_, {timeoutMs: 30_000}).pipe(Effect.map(result => result.stdout.trim())),
);

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = nonNegativeInteger(value, option);
  if (parsed < 1) throw new Error(`${option} requires a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, option: string): number {
  const parsed = Number.parseInt(requiredValue(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${option} requires a non-negative integer`);
  }
  return parsed;
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new Error(`${option} requires a value`);
  return value;
}

BunRuntime.runMain(benchmarkRecall.pipe(Effect.provide(ApplicationLayer)));
