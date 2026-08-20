import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Clock, Effect, FileSystem, Path} from 'effect';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from '../src/code_graph/indexer.js';
import type {
  CodeGraphIndexSummary,
  CodeGraphMaterializationMetrics,
  CodeGraphProgress,
} from '../src/code_graph/types.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {SystemInfo} from '../src/effect/system.js';
import {atomicWrite, printJson, scriptArguments} from './effect/script.js';
import {generatedStaticReexportControlStatement, prepareGeneratedCodeGraphFixture} from './code-graph-fixture.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

interface DirtyOverlayBenchmarkOptions {
  readonly outputPath?: string;
  readonly samples: number;
  readonly scenario: DirtyOverlayBenchmarkScenario;
  readonly scaleSymbols: number;
}

export type DirtyOverlayBenchmarkScenario = 'body-only' | 'unchanged-static-reexport';

interface DirtyOverlayObservation {
  readonly cpuMilliseconds: number;
  readonly durationMilliseconds: number;
  readonly edges: number;
  readonly factReplayAmplification?: number;
  readonly fallbackReason?: string;
  readonly materializationMilliseconds: number;
  readonly materializationMode: string;
  readonly replay: DirtyOverlayReplayEvidence;
  readonly rewriteAmplification?: number;
  readonly stagedFiles: number;
  readonly symbols: number;
  readonly totalFiles: number;
}

export interface DirtyOverlayReplayEvidence {
  readonly attributedFiles: number;
  readonly cachedFactReplayBytes: number;
  readonly changedFactBytes: number;
  readonly crossGenerationShardFiles: number;
  readonly exactGenerationShardFiles: number;
  readonly materializedShardReplayBytes: number;
  readonly rawFactReplayBytes: number;
}

const benchmarkCodeGraphDirtyOverlay = Effect.scoped(
  Effect.gen(function* () {
    const options = parseDirtyOverlayBenchmarkArguments(yield* scriptArguments());
    const system = yield* SystemInfo;
    const hardware = yield* system.hardwareInfo;
    const indexer = yield* CodeGraphIndexer;
    const incremental: DirtyOverlayObservation[] = [];
    const full: DirtyOverlayObservation[] = [];

    for (let sample = 0; sample < options.samples; sample += 1) {
      const order = sample % 2 === 0 ? ([false, true] as const) : ([true, false] as const);
      for (const enabled of order) {
        const observation = yield* Effect.scoped(
          runDirtyOverlayIndex(indexer, options.scaleSymbols, enabled, options.scenario),
        );
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
        ...(options.scenario === 'body-only'
          ? {bodyOnlyModifiedFiles: 1}
          : {
              scaleSemantics:
                `target symbols; this run has ${incremental[0]?.totalFiles ?? 0} indexed files, ` +
                `not ${options.scaleSymbols} files`,
              scenario: options.scenario,
              spanOnlyStaticReexportModifiedFiles: 1,
            }),
        targetSymbols: options.scaleSymbols,
      },
      measurements: {
        full: {
          cpuMilliseconds: summarize(full.map(sample => sample.cpuMilliseconds)),
          durationMilliseconds: fullDuration,
          ...(options.scenario === 'unchanged-static-reexport'
            ? {
                factReplayAmplification: full[0]?.factReplayAmplification ?? 0,
                rewriteAmplification: full[0]?.rewriteAmplification ?? 0,
                totalFiles: full[0]?.totalFiles ?? 0,
              }
            : {}),
          materializationMilliseconds: fullMaterialization,
          replay: full[0]!.replay,
          stagedFiles: full[0]?.stagedFiles ?? 0,
        },
        incremental: {
          cpuMilliseconds: summarize(incremental.map(sample => sample.cpuMilliseconds)),
          durationMilliseconds: incrementalDuration,
          ...(options.scenario === 'unchanged-static-reexport'
            ? {
                factReplayAmplification: incremental[0]?.factReplayAmplification ?? 0,
                rewriteAmplification: incremental[0]?.rewriteAmplification ?? 0,
                totalFiles: incremental[0]?.totalFiles ?? 0,
              }
            : {}),
          materializationMilliseconds: incrementalMaterialization,
          replay: incremental[0]!.replay,
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
  scenario: DirtyOverlayBenchmarkScenario,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prepared = yield* prepareGeneratedCodeGraphFixture(
    scaleSymbols,
    false,
    scenario === 'unchanged-static-reexport',
  );
  const changedPath = path.join(prepared.repository, 'src/module-00000.ts');
  const committed = yield* fs.readFileString(changedPath);
  const changed = dirtyOverlayChangedSource(scenario, committed);
  yield* fs.writeFileString(changedPath, changed);

  let materializationStarted: bigint | undefined;
  let materializationNanoseconds = 0n;
  let finalMaterializationMetrics: Extract<CodeGraphProgress, {readonly phase: 'materializing'}>['metrics'];
  let previousProgressPhase: CodeGraphProgress['phase'] | undefined;
  const observeProgress = (progress: CodeGraphProgress) =>
    Clock.currentTimeNanos.pipe(
      Effect.tap(now =>
        Effect.sync(() => {
          if (progress.phase === 'materializing') {
            if (previousProgressPhase !== 'materializing') finalMaterializationMetrics = undefined;
            if (progress.metrics !== undefined) finalMaterializationMetrics = progress.metrics;
          }
          if (progress.phase === 'materializing') {
            materializationStarted ??= now;
          } else if (materializationStarted !== undefined) {
            materializationNanoseconds += now - materializationStarted;
            materializationStarted = undefined;
          }
          previousProgressPhase = progress.phase;
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
  const changedFactBytes =
    summary.incrementalWork?.factBytes ?? finalMaterializationMetrics?.changedFactBytesCompleted ?? 0;
  if (scenario === 'unchanged-static-reexport' && changedFactBytes <= 0) {
    return yield* Effect.fail(new ScriptError('Dirty-overlay benchmark did not retain changed-fact byte evidence.'));
  }
  const replay = incrementalOverlay
    ? incrementalDirtyOverlayReplayEvidence(changedFactBytes)
    : dirtyOverlayReplayEvidence(finalMaterializationMetrics, changedFactBytes);
  const amplification =
    scenario === 'unchanged-static-reexport'
      ? dirtyOverlayAmplificationEvidence({
          cachedFactReplayBytes: replay.cachedFactReplayBytes,
          changedFactBytes,
          deltaFiles: 1,
          stagedFiles: summary.materialization?.stagedFiles ?? 0,
        })
      : undefined;
  const cpu = process.cpuUsage(cpuStarted);
  return {
    cpuMilliseconds: (cpu.system + cpu.user) / 1_000,
    durationMilliseconds: Number(finished - started) / NANOSECONDS_PER_MILLISECOND,
    edges: summary.snapshot.edgeCount,
    ...(amplification === undefined
      ? {}
      : {
          factReplayAmplification: amplification.factReplayAmplification,
          rewriteAmplification: amplification.rewriteAmplification,
        }),
    ...(summary.materialization?.fallbackReason ? {fallbackReason: summary.materialization.fallbackReason} : {}),
    materializationMilliseconds: Number(materializationNanoseconds) / NANOSECONDS_PER_MILLISECOND,
    materializationMode: summary.materialization?.mode ?? 'unreported',
    replay,
    stagedFiles: summary.materialization?.stagedFiles ?? -1,
    symbols: summary.snapshot.symbolCount,
    totalFiles: summary.materialization?.totalFiles ?? -1,
  } satisfies DirtyOverlayObservation;
});

export function dirtyOverlayReplayEvidence(
  metrics: CodeGraphMaterializationMetrics | undefined,
  changedFactBytes: number,
): DirtyOverlayReplayEvidence {
  if (
    metrics?.attributedFilesCompleted === undefined ||
    metrics.cachedFactReplayBytesCompleted === undefined ||
    metrics.changedFactBytesCompleted === undefined ||
    metrics.crossGenerationShardFilesCompleted === undefined ||
    metrics.exactGenerationShardFilesCompleted === undefined ||
    metrics.materializedShardReplayBytesCompleted === undefined ||
    metrics.rawFactReplayBytesCompleted === undefined
  ) {
    throw new ScriptError('Dirty-overlay benchmark did not retain complete physical replay evidence.');
  }
  const cachedFactReplayBytes = metrics.cachedFactReplayBytesCompleted;
  const materializedShardReplayBytes = metrics.materializedShardReplayBytesCompleted;
  const rawFactReplayBytes = metrics.rawFactReplayBytesCompleted;
  if (cachedFactReplayBytes !== Math.min(Number.MAX_SAFE_INTEGER, materializedShardReplayBytes + rawFactReplayBytes)) {
    throw new ScriptError('Dirty-overlay benchmark replay-byte split is inconsistent.');
  }
  if (changedFactBytes !== metrics.changedFactBytesCompleted) {
    throw new ScriptError('Dirty-overlay benchmark changed-fact byte evidence is inconsistent.');
  }
  return {
    attributedFiles: metrics.attributedFilesCompleted,
    cachedFactReplayBytes,
    changedFactBytes,
    crossGenerationShardFiles: metrics.crossGenerationShardFilesCompleted,
    exactGenerationShardFiles: metrics.exactGenerationShardFilesCompleted,
    materializedShardReplayBytes,
    rawFactReplayBytes,
  };
}

function incrementalDirtyOverlayReplayEvidence(changedFactBytes: number): DirtyOverlayReplayEvidence {
  return {
    attributedFiles: 0,
    cachedFactReplayBytes: 0,
    changedFactBytes,
    crossGenerationShardFiles: 0,
    exactGenerationShardFiles: 0,
    materializedShardReplayBytes: 0,
    rawFactReplayBytes: 0,
  };
}

export function dirtyOverlayAmplificationEvidence(input: {
  readonly cachedFactReplayBytes: number;
  readonly changedFactBytes: number;
  readonly deltaFiles: number;
  readonly stagedFiles: number;
}): {readonly factReplayAmplification: number; readonly rewriteAmplification: number} {
  return {
    factReplayAmplification: integerAmplification(input.cachedFactReplayBytes, input.changedFactBytes),
    rewriteAmplification: integerAmplification(input.stagedFiles, input.deltaFiles),
  };
}

export function dirtyOverlayChangedSource(scenario: DirtyOverlayBenchmarkScenario, committed: string): string {
  if (scenario === 'body-only') {
    if (!committed.includes('return 0;')) {
      throw new ScriptError('Dirty-overlay benchmark fixture lost its body-only edit marker.');
    }
    return committed.replace('return 0;', 'return 1000000;');
  }
  if (!committed.includes(generatedStaticReexportControlStatement())) {
    throw new ScriptError('Dirty-overlay benchmark fixture lost its static re-export control.');
  }
  return `// Span-only benchmark edit; resolver input below is byte-identical.\n${committed}`;
}

function integerAmplification(numerator: number, denominator: number): number {
  return numerator <= 0 ? 0 : Math.floor(numerator / Math.max(1, denominator));
}

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

export function parseDirtyOverlayBenchmarkArguments(args: readonly string[]): DirtyOverlayBenchmarkOptions {
  let outputPath: string | undefined;
  let samples = 3;
  let scenario: DirtyOverlayBenchmarkScenario = 'body-only';
  let scaleSymbols = 10_000;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--samples') samples = integer(args[++index], argument, 1);
    else if (argument === '--scenario') {
      const value = required(args[++index], argument);
      if (value !== 'body-only' && value !== 'unchanged-static-reexport') {
        throw new ScriptError('--scenario must be body-only or unchanged-static-reexport.');
      }
      scenario = value;
    } else if (argument === '--scale-symbols') scaleSymbols = integer(args[++index], argument, 1);
    else throw new ScriptError(`Unknown dirty-overlay benchmark option: ${argument}`);
  }
  if (scenario === 'unchanged-static-reexport' && scaleSymbols < 101) {
    throw new ScriptError('--scenario unchanged-static-reexport requires --scale-symbols at least 101.');
  }
  return {outputPath, samples, scaleSymbols, scenario};
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

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmarkCodeGraphDirtyOverlay, ApplicationLayer));
