import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Clock, Effect, FileSystem, Path} from 'effect';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from '../src/code_graph/indexer.js';
import type {CodeGraphIndexSummary, CodeGraphProgress} from '../src/code_graph/types.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {SystemInfo} from '../src/effect/system.js';
import {atomicWrite, printJson, scriptArguments} from './effect/script.js';
import {prepareGeneratedCodeGraphFixture} from './code-graph-fixture.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

interface DirtyOverlayBenchmarkOptions {
  readonly outputPath?: string;
  readonly samples: number;
  readonly scaleSymbols: number;
}

interface DirtyOverlayObservation {
  readonly cpuMilliseconds: number;
  readonly durationMilliseconds: number;
  readonly edges: number;
  readonly fallbackReason?: string;
  readonly materializationMilliseconds: number;
  readonly materializationMode: string;
  readonly stagedFiles: number;
  readonly symbols: number;
  readonly totalFiles: number;
}

const benchmarkCodeGraphDirtyOverlay = Effect.scoped(
  Effect.gen(function* () {
    const options = parseArguments(yield* scriptArguments());
    const system = yield* SystemInfo;
    const hardware = yield* system.hardwareInfo;
    const indexer = yield* CodeGraphIndexer;
    const incremental: DirtyOverlayObservation[] = [];
    const full: DirtyOverlayObservation[] = [];

    for (let sample = 0; sample < options.samples; sample += 1) {
      const order = sample % 2 === 0 ? ([false, true] as const) : ([true, false] as const);
      for (const enabled of order) {
        const observation = yield* Effect.scoped(runDirtyOverlayIndex(indexer, options.scaleSymbols, enabled));
        (enabled ? incremental : full).push(observation);
      }
    }

    for (let index = 0; index < options.samples; index += 1) {
      const incrementalSample = incremental[index]!;
      const fullSample = full[index]!;
      if (
        incrementalSample.symbols !== fullSample.symbols ||
        incrementalSample.edges !== fullSample.edges ||
        incrementalSample.totalFiles !== fullSample.totalFiles
      ) {
        return yield* Effect.fail(
          new ScriptError(`Dirty-overlay benchmark graph shape diverged in sample ${index + 1}.`),
        );
      }
    }

    const incrementalDuration = summarize(incremental.map(sample => sample.durationMilliseconds));
    const fullDuration = summarize(full.map(sample => sample.durationMilliseconds));
    const incrementalMaterialization = summarize(incremental.map(sample => sample.materializationMilliseconds));
    const fullMaterialization = summarize(full.map(sample => sample.materializationMilliseconds));
    const artifact = {
      createdAt: new Date().toISOString(),
      environment: {
        architecture: system.architecture,
        cpu: hardware.cpuModel,
        memoryBytes: hardware.memoryBytes,
        operatingSystem: hardware.operatingSystem,
        runtime: `bun/${system.runtimeVersion}`,
      },
      fixture: {
        bodyOnlyModifiedFiles: 1,
        targetSymbols: options.scaleSymbols,
      },
      measurements: {
        full: {
          cpuMilliseconds: summarize(full.map(sample => sample.cpuMilliseconds)),
          durationMilliseconds: fullDuration,
          materializationMilliseconds: fullMaterialization,
          stagedFiles: full[0]?.stagedFiles ?? 0,
        },
        incremental: {
          cpuMilliseconds: summarize(incremental.map(sample => sample.cpuMilliseconds)),
          durationMilliseconds: incrementalDuration,
          materializationMilliseconds: incrementalMaterialization,
          stagedFiles: incremental[0]?.stagedFiles ?? 0,
        },
        improvement: {
          durationPercent: percentReduction(fullDuration.mean, incrementalDuration.mean),
          materializationPercent: percentReduction(fullMaterialization.mean, incrementalMaterialization.mean),
        },
      },
      observations: {full, incremental},
      samples: options.samples,
      version: 1,
    };
    if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    yield* printJson(artifact);
  }),
);

const runDirtyOverlayIndex = Effect.fn('benchmarkCodeGraphDirtyOverlay.run')(function* (
  indexer: CodeGraphIndexerShape,
  scaleSymbols: number,
  incrementalOverlay: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prepared = yield* prepareGeneratedCodeGraphFixture(scaleSymbols, false);
  const changedPath = path.join(prepared.repository, 'src/module-00000.ts');
  const committed = yield* fs.readFileString(changedPath);
  if (!committed.includes('return 0;')) {
    return yield* Effect.fail(new ScriptError('Dirty-overlay benchmark fixture lost its body-only edit marker.'));
  }
  yield* fs.writeFileString(changedPath, committed.replace('return 0;', 'return 1000000;'));

  let materializationStarted: bigint | undefined;
  let materializationNanoseconds = 0n;
  const observeProgress = (progress: CodeGraphProgress) =>
    Clock.currentTimeNanos.pipe(
      Effect.tap(now =>
        Effect.sync(() => {
          if (progress.phase === 'materializing') {
            materializationStarted ??= now;
          } else if (materializationStarted !== undefined) {
            materializationNanoseconds += now - materializationStarted;
            materializationStarted = undefined;
          }
        }),
      ),
    );
  const started = yield* Clock.currentTimeNanos;
  const cpuStarted = process.cpuUsage();
  const summary = yield* indexer.index({
    cwd: prepared.repository,
    incrementalOverlay,
    onProgress: observeProgress,
    threadnoteHome: prepared.home,
  });
  const finished = yield* Clock.currentTimeNanos;
  if (materializationStarted !== undefined) materializationNanoseconds += finished - materializationStarted;
  validateMaterialization(summary, incrementalOverlay);
  const cpu = process.cpuUsage(cpuStarted);
  return {
    cpuMilliseconds: (cpu.system + cpu.user) / 1_000,
    durationMilliseconds: Number(finished - started) / NANOSECONDS_PER_MILLISECOND,
    edges: summary.snapshot.edgeCount,
    ...(summary.materialization?.fallbackReason ? {fallbackReason: summary.materialization.fallbackReason} : {}),
    materializationMilliseconds: Number(materializationNanoseconds) / NANOSECONDS_PER_MILLISECOND,
    materializationMode: summary.materialization?.mode ?? 'unreported',
    stagedFiles: summary.materialization?.stagedFiles ?? -1,
    symbols: summary.snapshot.symbolCount,
    totalFiles: summary.materialization?.totalFiles ?? -1,
  } satisfies DirtyOverlayObservation;
});

function validateMaterialization(summary: CodeGraphIndexSummary, incrementalOverlay: boolean): void {
  if (incrementalOverlay) {
    if (summary.materialization?.mode !== 'incremental-overlay' || summary.materialization.stagedFiles !== 1) {
      throw new ScriptError(
        `Incremental dirty-overlay benchmark fell back: ${JSON.stringify(summary.materialization)}.`,
      );
    }
    return;
  }
  if (summary.materialization?.mode !== 'full' || summary.materialization.fallbackReason !== 'disabled') {
    throw new ScriptError(
      `Full dirty-overlay benchmark did not use its control path: ${JSON.stringify(summary.materialization)}.`,
    );
  }
}

function summarize(values: readonly number[]): {
  readonly maximum: number;
  readonly mean: number;
  readonly minimum: number;
} {
  if (values.length === 0) throw new ScriptError('Dirty-overlay benchmark requires at least one observation.');
  return {
    maximum: Math.max(...values),
    mean: values.reduce((total, value) => total + value, 0) / values.length,
    minimum: Math.min(...values),
  };
}

function percentReduction(baseline: number, improved: number): number {
  return baseline === 0 ? 0 : ((baseline - improved) / baseline) * 100;
}

function parseArguments(args: readonly string[]): DirtyOverlayBenchmarkOptions {
  let outputPath: string | undefined;
  let samples = 3;
  let scaleSymbols = 10_000;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--samples') samples = integer(args[++index], argument, 1);
    else if (argument === '--scale-symbols') scaleSymbols = integer(args[++index], argument, 1);
    else throw new ScriptError(`Unknown dirty-overlay benchmark option: ${argument}`);
  }
  return {outputPath, samples, scaleSymbols};
}

function integer(value: string | undefined, option: string, minimum: number): number {
  const parsed = Number.parseInt(required(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new ScriptError(`${option} must be at least ${minimum}`);
  return parsed;
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ScriptError(`${option} requires a value`);
  return value;
}

BunRuntime.runMain(provideScriptLayer(benchmarkCodeGraphDirtyOverlay, ApplicationLayer));
