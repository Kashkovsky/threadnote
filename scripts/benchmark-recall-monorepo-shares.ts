import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Clock, Effect} from 'effect';
import {runCommandEffect} from '../src/effect/command.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {SystemInfo} from '../src/effect/system.js';
import {benchmarkMeasurement} from '../src/evaluation/benchmark.js';
import {
  createMonorepoShareRecallStressFixture,
  monorepoShareRecallStressCandidates,
  runMonorepoShareRecallStressPass,
  summarizeMonorepoShareRecallStressPass,
  type MonorepoShareRecallStressMode,
  type MonorepoShareRecallStressOptions,
} from '../src/evaluation/recall-monorepo-stress.js';
import {RECALL_RANKER_VERSION} from '../src/recall/rank.js';
import {getThreadnoteVersion} from '../src/version.js';
import {atomicWrite, fixtureHash, printJson, scriptArguments} from './effect/script.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const MODES = ['full-corpus', 'workspace-prefiltered'] as const satisfies readonly MonorepoShareRecallStressMode[];
const MAXIMUM_PHYSICAL_CANDIDATES = 250_000;

const benchmarkRecallMonorepoShares = Effect.gen(function* () {
  const system = yield* SystemInfo;
  const options = parseArguments(yield* scriptArguments());
  const fixture = createMonorepoShareRecallStressFixture(options.fixture);
  const candidatesByMode = new Map(MODES.map(mode => [mode, monorepoShareRecallStressCandidates(fixture, mode)]));

  for (let index = 0; index < options.warmups; index += 1) {
    for (const mode of MODES) runMonorepoShareRecallStressPass(fixture, candidatesByMode.get(mode)!);
  }

  const durations = new Map(MODES.map(mode => [mode, [] as number[]]));
  for (let index = 0; index < options.samples; index += 1) {
    for (const mode of MODES) {
      const startedAt = yield* Clock.currentTimeNanos;
      runMonorepoShareRecallStressPass(fixture, candidatesByMode.get(mode)!);
      const finishedAt = yield* Clock.currentTimeNanos;
      durations.get(mode)!.push(Number(finishedAt - startedAt) / NANOSECONDS_PER_MILLISECOND);
    }
    yield* Effect.yieldNow;
  }

  const summaries = Object.fromEntries(
    MODES.map(mode => {
      const candidates = candidatesByMode.get(mode)!;
      const ranked = runMonorepoShareRecallStressPass(fixture, candidates);
      return [mode, summarizeMonorepoShareRecallStressPass(fixture, mode, candidates, ranked)];
    }),
  );
  const [commit, status, hardware, sourceVersion, hash] = yield* Effect.all(
    [
      git(['rev-parse', 'HEAD']),
      git(['status', '--porcelain']),
      system.hardwareInfo,
      getThreadnoteVersion(),
      fixtureHash(JSON.stringify(fixture)),
    ],
    {concurrency: 'unbounded'},
  );
  const artifact = {
    createdAt: new Date().toISOString(),
    environment: {
      architecture: system.architecture,
      commit,
      cpu: hardware.cpuModel,
      dirty: status.length > 0,
      fixtureHash: hash,
      memoryBytes: hardware.memoryBytes,
      operatingSystem: hardware.operatingSystem,
      runtime: `bun/${system.runtimeVersion}`,
    },
    measurements: MODES.map(mode => benchmarkMeasurement(`${mode}-rank-latency`, 'milliseconds', durations.get(mode)!)),
    metadata: {
      rankerVersion: RECALL_RANKER_VERSION,
      sourceVersion: `threadnote-${sourceVersion}`,
    },
    shape: {
      ...fixture.options,
      personalCopies: fixture.options.packages * fixture.options.logicalMemoriesPerPackage,
      physicalCandidates: fixture.candidates.length,
      targetWorkspaceScope: fixture.targetWorkspaceScope,
    },
    summaries,
    suite: 'recall-monorepo-shares',
    version: 1,
    warmups: options.warmups,
  };
  if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  yield* printJson(artifact);
});

interface BenchmarkOptions {
  readonly fixture: MonorepoShareRecallStressOptions;
  readonly outputPath?: string;
  readonly samples: number;
  readonly warmups: number;
}

function parseArguments(args: readonly string[]): BenchmarkOptions {
  let packages = 64;
  let logicalMemoriesPerPackage = 24;
  let shareAliasesPerMemory = 3;
  let targetPackage = 0;
  let topK = 5;
  let seed = 0x4_02_07;
  let samples = 10;
  let warmups = 2;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--packages') packages = positiveInteger(args[++index], argument);
    else if (argument === '--logical-per-package') {
      logicalMemoriesPerPackage = positiveInteger(args[++index], argument);
    } else if (argument === '--share-aliases') shareAliasesPerMemory = nonNegativeInteger(args[++index], argument);
    else if (argument === '--target-package') targetPackage = nonNegativeInteger(args[++index], argument);
    else if (argument === '--top-k') topK = positiveInteger(args[++index], argument);
    else if (argument === '--seed') seed = positiveInteger(args[++index], argument);
    else if (argument === '--samples') samples = positiveInteger(args[++index], argument);
    else if (argument === '--warmups') warmups = nonNegativeInteger(args[++index], argument);
    else if (argument === '--output') outputPath = requiredValue(args[++index], argument);
    else throw new ScriptError(`Unknown monorepo/share recall benchmark option: ${argument}`);
  }
  if (targetPackage >= packages) throw new ScriptError('--target-package must be smaller than --packages');
  const physicalCandidates = packages * logicalMemoriesPerPackage * (shareAliasesPerMemory + 1);
  if (!Number.isSafeInteger(physicalCandidates) || physicalCandidates > MAXIMUM_PHYSICAL_CANDIDATES) {
    throw new ScriptError(
      `Generated workload must not exceed ${MAXIMUM_PHYSICAL_CANDIDATES.toLocaleString('en-US')} physical candidates.`,
    );
  }
  return {
    fixture: {logicalMemoriesPerPackage, packages, seed, shareAliasesPerMemory, targetPackage, topK},
    outputPath,
    samples,
    warmups,
  };
}

const git = Effect.fn('benchmark.git')((arguments_: readonly string[]) =>
  runCommandEffect('git', arguments_, {timeoutMs: 30_000}).pipe(Effect.map(result => result.stdout.trim())),
);

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = nonNegativeInteger(value, option);
  if (parsed < 1) throw new ScriptError(`${option} requires a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, option: string): number {
  const parsed = Number.parseInt(requiredValue(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ScriptError(`${option} requires a non-negative integer`);
  }
  return parsed;
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ScriptError(`${option} requires a value`);
  return value;
}

BunRuntime.runMain(provideScriptLayer(benchmarkRecallMonorepoShares, ApplicationLayer));
