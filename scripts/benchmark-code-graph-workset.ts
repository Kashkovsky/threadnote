import {provideScriptLayer, scriptError, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {runCommandEffect} from '../src/effect/command.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {SystemInfo} from '../src/effect/system.js';
import {
  BENCHMARK_ARTIFACT_VERSION,
  parseBenchmarkArtifactV1,
  type BenchmarkArtifactV1,
} from '../src/evaluation/benchmark.js';
import {atomicWrite, printJson, scriptArguments} from './effect/script.js';
import {
  codeGraphWorksetBenchmarkBudgetFailures,
  codeGraphWorksetBenchmarkMeasurements,
  codeGraphWorksetBenchmarkSample,
  codeGraphWorksetRuntimeConfig,
  indexPreparedCodeGraphWorksetFixture,
  measureCodeGraphWorksetQuery,
  publishIndexedCodeGraphWorksetCatalog,
} from './support/code-graph-workset-harness.js';
import {
  CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES,
  prepareCodeGraphWorksetFixture,
  removePreparedCodeGraphWorksetFixture,
  type CodeGraphWorksetFixtureSize,
} from './support/code-graph-workset-fixture.js';

const DEFAULT_SAMPLES = 5;
const DEFAULT_WARMUPS = 1;
const BENCHMARK_QUERY_ID = 'symbol-resolve-tenant-session';

export interface CodeGraphWorksetBenchmarkArguments {
  readonly failOnBudget: boolean;
  readonly outputPath?: string;
  readonly samples: number;
  readonly sizes: readonly CodeGraphWorksetFixtureSize[];
  readonly warmups: number;
}

export function parseCodeGraphWorksetBenchmarkArguments(args: readonly string[]): CodeGraphWorksetBenchmarkArguments {
  let failOnBudget = false;
  let outputPath: string | undefined;
  let samples = DEFAULT_SAMPLES;
  let sizes: readonly CodeGraphWorksetFixtureSize[] = CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES;
  let warmups = DEFAULT_WARMUPS;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--fail-on-budget') failOnBudget = true;
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--samples') samples = integer(args[++index], argument, 1, 100);
    else if (argument === '--sizes') sizes = parseBenchmarkSizes(required(args[++index], argument));
    else if (argument === '--warmups') warmups = integer(args[++index], argument, 0, 100);
    else throw new ScriptError(`Unknown code graph workset benchmark option: ${argument}`);
  }
  return {failOnBudget, outputPath, samples, sizes, warmups};
}

export const benchmarkCodeGraphWorkset = Effect.scoped(
  Effect.gen(function* () {
    const options = parseCodeGraphWorksetBenchmarkArguments(yield* scriptArguments());
    const maximumSize = Math.max(...options.sizes) as CodeGraphWorksetFixtureSize;
    const prepared = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => prepareCodeGraphWorksetFixture({size: maximumSize, stateProfile: 'all-clean'}),
        catch: cause => scriptError(cause),
      }),
      fixture =>
        Effect.tryPromise({
          try: () => removePreparedCodeGraphWorksetFixture(fixture),
          catch: cause => scriptError(cause),
        }).pipe(Effect.catch(() => Effect.void)),
    );
    yield* indexPreparedCodeGraphWorksetFixture(prepared);
    const selectedWorksets = options.sizes.map(size => {
      const workset = prepared.plan.worksets.find(candidate => candidate.size === size);
      if (!workset) throw new ScriptError(`Fixture did not emit a size-${size} workset.`);
      return workset.name;
    });
    yield* publishIndexedCodeGraphWorksetCatalog(prepared, selectedWorksets);
    const config = codeGraphWorksetRuntimeConfig(prepared);
    const query = prepared.plan.queries.find(candidate => candidate.id === BENCHMARK_QUERY_ID);
    if (!query) return yield* Effect.fail(new ScriptError(`Fixture is missing benchmark query ${BENCHMARK_QUERY_ID}.`));

    const samples = [];
    for (const worksetSize of options.sizes) {
      const workset = prepared.plan.worksets.find(candidate => candidate.size === worksetSize);
      if (!workset) return yield* Effect.fail(new ScriptError(`Fixture did not emit a size-${worksetSize} workset.`));
      for (let warmup = 0; warmup < options.warmups; warmup += 1) {
        yield* measureCodeGraphWorksetQuery(config, workset.name, query.query);
      }
      for (let sample = 0; sample < options.samples; sample += 1) {
        const measured = yield* measureCodeGraphWorksetQuery(config, workset.name, query.query);
        samples.push(codeGraphWorksetBenchmarkSample(worksetSize, measured));
      }
    }

    const measurements = codeGraphWorksetBenchmarkMeasurements(samples);
    const system = yield* SystemInfo;
    const hardware = yield* system.hardwareInfo;
    const [commit, dirty] = yield* Effect.all(
      [sourceGit(['rev-parse', 'HEAD']), sourceGit(['status', '--porcelain'])],
      {
        concurrency: 2,
      },
    );
    const artifact: BenchmarkArtifactV1 = parseBenchmarkArtifactV1({
      createdAt: benchmarkCreatedAt(system.environment()),
      environment: {
        architecture: system.architecture,
        commit,
        cpu: hardware.cpuModel,
        dirty: dirty.length > 0,
        fixtureHash: prepared.identity.id,
        memoryBytes: hardware.memoryBytes,
        node: `bun/${system.runtimeVersion}`,
        operatingSystem: hardware.operatingSystem,
        packageManager: `bun/${system.runtimeVersion}`,
        runner: 'threadnote-code-graph-workset',
        runnerVersion: '1',
      },
      measurements,
      metadata: {
        agentTokenEstimate: 'utf8-bytes-divided-by-3; not a representative tokenizer count',
        catalogBytesRead: 0,
        currentRepositoryCap: 0,
        evidenceUnit: 'globally-ranked-v2-evidence-card',
        firstEvidenceSemantics: 'buffered-response; delivered time-to-first equals completion',
        requestedSizes: options.sizes.join(','),
        responseSurface: 'canonical Workset Search 2.0 structuredContent plus terse text',
        routingMode: 'complete indexed catalog with adaptive 4/4/16 deep expansion',
      },
      suite: 'code-graph-workset-v2',
      version: BENCHMARK_ARTIFACT_VERSION,
      warmups: options.warmups,
    });
    if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    yield* printJson(artifact);
    if (options.failOnBudget) {
      const failures = codeGraphWorksetBenchmarkBudgetFailures(measurements, options.sizes);
      if (failures.length > 0) return yield* Effect.fail(new ScriptError(failures.join('\n')));
    }
  }),
);

function parseBenchmarkSizes(value: string): readonly CodeGraphWorksetFixtureSize[] {
  const parts = value.split(',');
  if (parts.length === 0 || parts.some(part => !part.trim()))
    throw new ScriptError('--sizes requires comma-separated sizes.');
  const sizes = parts.map(part => Number(part.trim()));
  if (sizes.some(size => !Number.isSafeInteger(size) || size < 1)) {
    throw new ScriptError('--sizes requires positive integer sizes.');
  }
  if (new Set(sizes).size !== sizes.length) throw new ScriptError('--sizes sizes must be unique.');
  const allowed = new Set<number>(CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES);
  for (const size of sizes) {
    if (!allowed.has(size)) {
      throw new ScriptError(
        `--sizes only accepts benchmark sizes: ${CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES.join(', ')}. Received ${size}.`,
      );
    }
  }
  return [...sizes].sort((left, right) => left - right) as readonly CodeGraphWorksetFixtureSize[];
}

function integer(value: string | undefined, option: string, minimum: number, maximum: number): number {
  const parsed = Number(required(value, option));
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ScriptError(`${option} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ScriptError(`${option} requires a value.`);
  return value;
}

function benchmarkCreatedAt(environment: NodeJS.ProcessEnv): string {
  const epoch = environment.SOURCE_DATE_EPOCH;
  if (epoch === undefined) return new Date().toISOString();
  if (!/^\d+$/.test(epoch))
    throw new ScriptError('SOURCE_DATE_EPOCH must be a non-negative integer number of seconds.');
  const date = new Date(Number(epoch) * 1_000);
  if (!Number.isFinite(date.getTime())) throw new ScriptError('SOURCE_DATE_EPOCH is outside the supported date range.');
  return date.toISOString();
}

const sourceGit = Effect.fn('benchmarkCodeGraphWorkset.git')((args: readonly string[]) =>
  runCommandEffect('git', ['-C', process.cwd(), ...args], {maxOutputBytes: 1_048_576, timeoutMs: 30_000}).pipe(
    Effect.map(result => result.stdout.trim()),
  ),
);

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmarkCodeGraphWorkset, ApplicationLayer));
