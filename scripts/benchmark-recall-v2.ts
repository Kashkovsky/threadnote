import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {arch, cpus, homedir, platform, release, totalmem} from 'node:os';
import {dirname, resolve} from 'node:path';
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';
import {
  BENCHMARK_ARTIFACT_VERSION,
  benchmarkMeasurement,
  parseBenchmarkArtifactV1,
  type BenchmarkArtifactV1,
} from '../src/evaluation/benchmark.js';
import {createRecallEvaluationFixtureV2, expandRecallEvaluationFixtureV2} from '../src/evaluation/recall-fixture.js';
import {rankRecallCandidates} from '../src/recall/rank.js';

const options = parseArguments(process.argv.slice(2));
const fixture = expandRecallEvaluationFixtureV2(createRecallEvaluationFixtureV2(), options.documentCount, options.seed);
const fixtureHash = createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
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
const eventLoopDelay = monitorEventLoopDelay({resolution: 10});
const cpuStartedAt = process.cpuUsage();
eventLoopDelay.enable();
for (let index = 0; index < options.samples; index += 1) {
  const startedAt = performance.now();
  const result = runQuery();
  durations.push(performance.now() - startedAt);
  if (!result.results[0]) throw new Error('Recall benchmark returned no result');
  const memory = process.memoryUsage();
  rss.push(memory.rss);
  externalMemory.push(memory.external);
  heapUsed.push(memory.heapUsed);
  await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
}
eventLoopDelay.disable();
const cpu = process.cpuUsage(cpuStartedAt);
const latency = benchmarkMeasurement('hybrid-rank-one-query', 'milliseconds', durations);
const throughput = durations.map(duration => 1_000 / duration);

const artifact: BenchmarkArtifactV1 = {
  createdAt: new Date().toISOString(),
  environment: {
    architecture: arch(),
    commit: git(['rev-parse', 'HEAD']),
    cpu: cpus()[0]?.model ?? 'unknown',
    dirty: git(['status', '--porcelain']).length > 0,
    fixtureHash,
    memoryBytes: totalmem(),
    node: process.version,
    operatingSystem: `${platform()} ${release()}`,
    packageManager: `npm/${execFileSync('npm', ['--version'], {encoding: 'utf8'}).trim()}`,
    runner: 'threadnote-recall-e2e',
    runnerVersion: '1',
  },
  measurements: [
    latency,
    benchmarkMeasurement('hybrid-rank-throughput', 'operations_per_second', throughput),
    benchmarkMeasurement('process-rss', 'bytes', rss),
    benchmarkMeasurement('process-external-memory', 'bytes', externalMemory),
    benchmarkMeasurement('process-heap-used', 'bytes', heapUsed),
    benchmarkMeasurement('process-cpu-time-per-query', 'milliseconds', [
      (cpu.user + cpu.system) / 1_000 / options.samples,
    ]),
    benchmarkMeasurement('event-loop-delay-p95', 'milliseconds', [
      Number.isFinite(eventLoopDelay.percentile(95)) ? eventLoopDelay.percentile(95) / 1_000_000 : 0,
    ]),
  ],
  metadata: {
    documents: fixture.documents.length,
    homeRedacted: homedir().length > 0,
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
const json = `${JSON.stringify(artifact, undefined, 2)}\n`;
if (options.outputPath) {
  const target = resolve(options.outputPath);
  const temporary = `${target}.tmp-${process.pid}`;
  await mkdir(dirname(target), {recursive: true});
  await writeFile(temporary, json, 'utf8');
  await rename(temporary, target);
}
process.stdout.write(json);

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

function git(args: readonly string[]): string {
  return execFileSync('git', args, {encoding: 'utf8'}).trim();
}

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
