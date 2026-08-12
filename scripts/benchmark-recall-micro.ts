import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {bench, do_not_optimize, run} from 'mitata';
import {Effect} from 'effect';
import {runCommandEffect} from '../src/effect/command.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {SystemInfo} from '../src/effect/system.js';
import {createBenchmarkFixture, runBenchmarkQuery} from './benchmark-target.js';
import {atomicWrite, fixtureHash, printJson, scriptArguments} from './effect/script.js';

const DEFAULT_BENCHMARK_SIZES = [200, 1_000, 10_000] as const;
const EXTENDED_BENCHMARK_SIZES = [...DEFAULT_BENCHMARK_SIZES, 100_000] as const;

const benchmarkRecall = Effect.gen(function* () {
  const system = yield* SystemInfo;
  const arguments_ = yield* scriptArguments();
  const sizes =
    system.environment().THREADNOTE_BENCHMARK_100K === '1' ? EXTENDED_BENCHMARK_SIZES : DEFAULT_BENCHMARK_SIZES;
  const fixtures = new Map(sizes.map(size => [size, createBenchmarkFixture(size)]));
  yield* Effect.sync(() => {
    for (const size of sizes) {
      const fixture = fixtures.get(size)!;
      bench(`hybrid rank one query / ${size} documents`, () => {
        do_not_optimize(runBenchmarkQuery(fixture));
      }).gc('once');
    }
  });

  const outputIndex = arguments_.indexOf('--output');
  const emitJson = arguments_.includes('--json') || outputIndex !== -1;
  const result = yield* Effect.tryPromise({
    try: () => run({format: emitJson ? 'quiet' : undefined, throw: true}),
    catch: cause => new ScriptError('Recall microbenchmark failed.', {cause}),
  });
  if (!emitJson) return;

  const [commit, status, fixtureEntries, hardware] = yield* Effect.all(
    [
      git(['rev-parse', 'HEAD']),
      git(['status', '--porcelain']),
      Effect.forEach([...fixtures], ([size, fixture]) =>
        fixtureHash(JSON.stringify(fixture)).pipe(Effect.map(hash => [String(size), hash] as const)),
      ),
      system.hardwareInfo,
    ],
    {concurrency: 'unbounded'},
  );
  const artifact = {
    benchmarks: result.benchmarks.flatMap(trial =>
      trial.runs.map(runResult => ({
        arguments: runResult.args,
        error: runResult.error ? String(runResult.error) : undefined,
        name: runResult.name,
        statistics: runResult.stats
          ? {
              averageNanoseconds: runResult.stats.avg,
              heap: runResult.stats.heap,
              maximumNanoseconds: runResult.stats.max,
              minimumNanoseconds: runResult.stats.min,
              p50Nanoseconds: runResult.stats.p50,
              p99Nanoseconds: runResult.stats.p99,
              samples: runResult.stats.ticks,
            }
          : undefined,
      })),
    ),
    createdAt: new Date().toISOString(),
    environment: {
      architecture: system.architecture,
      commit,
      cpu: hardware.cpuModel,
      dirty: status.length > 0,
      memoryBytes: hardware.memoryBytes,
      operatingSystem: hardware.operatingSystem,
      packageManager: `bun/${system.runtimeVersion}`,
      runtime: result.context.runtime,
    },
    fixtures: Object.fromEntries(fixtureEntries),
    runner: {name: 'mitata', version: '1.0.34'},
    version: 1,
  };
  if (outputIndex !== -1) {
    const outputPath = arguments_[outputIndex + 1];
    if (!outputPath) return yield* Effect.fail(new ScriptError('--output requires a path'));
    yield* atomicWrite(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  }
  if (arguments_.includes('--json') || outputIndex === -1) {
    yield* printJson(artifact);
  }
});

const git = Effect.fn('benchmark.git')((arguments_: readonly string[]) =>
  runCommandEffect('git', arguments_, {timeoutMs: 30_000}).pipe(Effect.map(result => result.stdout.trim())),
);

BunRuntime.runMain(provideScriptLayer(benchmarkRecall, ApplicationLayer));
