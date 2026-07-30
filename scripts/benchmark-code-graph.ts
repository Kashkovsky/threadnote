import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Clock, Effect, FileSystem, Path} from 'effect';
import {CodeGraphIndexer} from '../src/code_graph/indexer.js';
import {CodeGraphQueryService} from '../src/code_graph/query.js';
import {runCommandEffect} from '../src/effect/command.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {SystemInfo} from '../src/effect/system.js';
import {CORE_EMBEDDING_MODEL_ID} from '../src/models/builtin.js';
import {LocalModelCatalog} from '../src/models/catalog.js';
import {selectLocalModel} from '../src/models/selection.js';
import {LocalModelStore} from '../src/models/store.js';
import {
  BENCHMARK_ARTIFACT_VERSION,
  benchmarkMeasurement,
  parseBenchmarkArtifactV1,
  type BenchmarkArtifactV1,
} from '../src/evaluation/benchmark.js';
import {codeGraphEvaluationFixtureHash, parseCodeGraphEvaluationFixtureV1} from '../src/evaluation/code-graph.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import {
  GENERATED_VECTOR_CONTROL_PATH,
  VECTOR_SEMANTIC_CONTROL_QUERY,
  generatedSymbolName,
  prepareCodeGraphFixture,
  prepareGeneratedCodeGraphFixture,
} from './code-graph-fixture.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

const benchmarkCodeGraph = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const options = parseArguments(yield* scriptArguments());
    const fixturePath = yield* path.fromFileUrl(
      new URL(`../test/evaluation/fixtures/${options.fixture}/fixture.json`, import.meta.url),
    );
    const fixture = parseCodeGraphEvaluationFixtureV1(yield* readJsonFile(fixturePath));
    const prepared =
      options.scaleSymbols === undefined
        ? yield* prepareCodeGraphFixture(options.fixture)
        : yield* prepareGeneratedCodeGraphFixture(options.scaleSymbols, options.vectors);
    const embeddingModelId = options.vectors
      ? yield* prepareBenchmarkEmbedding(prepared.home, options.modelHome)
      : undefined;
    const queryText = options.vectors
      ? VECTOR_SEMANTIC_CONTROL_QUERY
      : options.scaleSymbols === undefined
        ? options.fixture === 'code-graph-polyglot-v1'
          ? 'KotlinApp'
          : 'exclusive file lock'
        : generatedSymbolName(Math.max(0, options.scaleSymbols - 1));
    const indexer = yield* CodeGraphIndexer;
    const query = yield* CodeGraphQueryService;
    const coldStarted = yield* Clock.currentTimeNanos;
    let coldMaterializationFinished = coldStarted;
    let coldResolutionFinished = coldStarted;
    let coldActivationStarted = coldStarted;
    const cold = yield* indexer.index({
      cwd: prepared.repository,
      onProgress: progress => {
        if (progress.phase === 'parsing') {
          return Clock.currentTimeNanos.pipe(Effect.tap(now => Effect.sync(() => (coldMaterializationFinished = now))));
        }
        if (progress.phase === 'resolving') {
          return Clock.currentTimeNanos.pipe(Effect.tap(now => Effect.sync(() => (coldResolutionFinished = now))));
        }
        if (progress.phase === 'activating') {
          return Clock.currentTimeNanos.pipe(Effect.tap(now => Effect.sync(() => (coldActivationStarted = now))));
        }
        return Effect.void;
      },
      threadnoteHome: prepared.home,
    });
    const coldFinished = yield* Clock.currentTimeNanos;
    const coldProcessPeakRssBytes = processPeakRssBytes();
    if (options.vectors) {
      if (cold.diagnostics.some(diagnostic => diagnostic.includes('Vector graph retrieval unavailable'))) {
        return yield* Effect.fail(new Error(cold.diagnostics.join('\n')));
      }
      const semanticControl = yield* query.inspect({
        cwd: prepared.repository,
        operation: 'query',
        query: queryText,
        refresh: false,
        threadnoteHome: prepared.home,
      });
      const expectedPath = options.scaleSymbols === undefined ? 'docs/architecture.md' : GENERATED_VECTOR_CONTROL_PATH;
      if (!semanticControl.nodes.some(node => node.path === expectedPath && node.score >= 0.64)) {
        const observed = semanticControl.nodes
          .slice(0, 5)
          .map(node => `${node.path}:${node.name}:${node.score.toFixed(3)}`)
          .join(', ');
        return yield* Effect.fail(
          new Error(`Vector benchmark semantic positive control did not resolve; observed ${observed || 'no nodes'}.`),
        );
      }
    }

    for (let index = 0; index < options.warmups; index += 1) {
      yield* query.inspect({
        cwd: prepared.repository,
        operation: 'query',
        query: queryText,
        threadnoteHome: prepared.home,
      });
    }
    const queryDurations = [];
    for (let index = 0; index < options.samples; index += 1) {
      const started = yield* Clock.currentTimeNanos;
      yield* query.inspect({
        cwd: prepared.repository,
        operation: 'query',
        query: queryText,
        threadnoteHome: prepared.home,
      });
      queryDurations.push(Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND);
    }

    const changedPath = path.join(
      prepared.repository,
      options.scaleSymbols === undefined
        ? options.fixture === 'code-graph-polyglot-v1'
          ? 'src/main.ts'
          : 'packages/search/src/vector-index.ts'
        : 'src/module-00000.ts',
    );
    yield* fs.writeFileString(
      changedPath,
      `${yield* fs.readFileString(changedPath)}\nexport const benchmarkIncrementalMarker = true;\n`,
    );
    const incrementalStarted = yield* Clock.currentTimeNanos;
    let incrementalMaterializationFinished = incrementalStarted;
    let incrementalResolutionFinished = incrementalStarted;
    let incrementalActivationStarted = incrementalStarted;
    const incremental = yield* indexer.index({
      cwd: prepared.repository,
      onProgress: progress => {
        if (progress.phase === 'parsing') {
          return Clock.currentTimeNanos.pipe(
            Effect.tap(now => Effect.sync(() => (incrementalMaterializationFinished = now))),
          );
        }
        if (progress.phase === 'resolving') {
          return Clock.currentTimeNanos.pipe(
            Effect.tap(now => Effect.sync(() => (incrementalResolutionFinished = now))),
          );
        }
        if (progress.phase === 'activating') {
          return Clock.currentTimeNanos.pipe(
            Effect.tap(now => Effect.sync(() => (incrementalActivationStarted = now))),
          );
        }
        return Effect.void;
      },
      threadnoteHome: prepared.home,
    });
    const incrementalFinished = yield* Clock.currentTimeNanos;
    const incrementalProcessPeakRssBytes = processPeakRssBytes();
    if (
      options.vectors &&
      incremental.diagnostics.some(diagnostic => diagnostic.includes('Vector graph retrieval unavailable'))
    ) {
      return yield* Effect.fail(new Error(incremental.diagnostics.join('\n')));
    }
    if (options.vectors) {
      const semanticControl = yield* query.inspect({
        cwd: prepared.repository,
        operation: 'query',
        query: queryText,
        refresh: false,
        threadnoteHome: prepared.home,
      });
      const expectedPath = options.scaleSymbols === undefined ? 'docs/architecture.md' : GENERATED_VECTOR_CONTROL_PATH;
      if (
        semanticControl.snapshot.id !== incremental.snapshot.id ||
        !semanticControl.nodes.some(node => node.path === expectedPath && node.score >= 0.64)
      ) {
        const observed = semanticControl.nodes
          .slice(0, 5)
          .map(node => `${node.path}:${node.name}:${node.score.toFixed(3)}`)
          .join(', ');
        return yield* Effect.fail(
          new Error(
            `Incremental vector benchmark semantic positive control did not resolve on the new snapshot; ` +
              `observed ${observed || 'no nodes'}.`,
          ),
        );
      }
    }

    const databaseRoot = path.join(prepared.home, 'indexes', 'code-graph');
    const diskBytes = yield* directoryBytes(fs, path, databaseRoot);
    const [commit, dirty, hardware] = yield* Effect.all(
      [git(['rev-parse', 'HEAD']), git(['status', '--porcelain']), system.hardwareInfo()],
      {concurrency: 3},
    );
    const artifact: BenchmarkArtifactV1 = {
      createdAt: new Date().toISOString(),
      environment: {
        architecture: system.architecture,
        commit,
        cpu: hardware.cpuModel,
        dirty: dirty.length > 0,
        fixtureHash:
          options.scaleSymbols === undefined
            ? codeGraphEvaluationFixtureHash(fixture)
            : `generated-code-graph-${options.vectors ? 'vectors-v2' : 'v1'}:${options.scaleSymbols}`,
        memoryBytes: hardware.memoryBytes,
        ...(embeddingModelId
          ? {model: {backend: 'node-llama-cpp', id: embeddingModelId, revision: 'builtin-pinned'}}
          : {}),
        node: `bun/${system.runtimeVersion}`,
        operatingSystem: hardware.operatingSystem,
        packageManager: `bun/${system.runtimeVersion}`,
        runner: 'threadnote-code-graph-e2e',
        runnerVersion: '1',
      },
      measurements: [
        benchmarkMeasurement('cold-index', 'milliseconds', [
          Number(coldFinished - coldStarted) / NANOSECONDS_PER_MILLISECOND,
        ]),
        benchmarkMeasurement('cold-pre-activation', 'milliseconds', [
          Number(coldActivationStarted - coldStarted) / NANOSECONDS_PER_MILLISECOND,
        ]),
        benchmarkMeasurement('cold-materialization', 'milliseconds', [
          Number(coldMaterializationFinished - coldStarted) / NANOSECONDS_PER_MILLISECOND,
        ]),
        benchmarkMeasurement('cold-reference-resolution', 'milliseconds', [
          Number(coldResolutionFinished - coldMaterializationFinished) / NANOSECONDS_PER_MILLISECOND,
        ]),
        benchmarkMeasurement('cold-pre-activation-validation', 'milliseconds', [
          Number(coldActivationStarted - coldResolutionFinished) / NANOSECONDS_PER_MILLISECOND,
        ]),
        benchmarkMeasurement(
          options.vectors ? 'cold-activation-and-vectors' : 'cold-activation-lexical-only',
          'milliseconds',
          [Number(coldFinished - coldActivationStarted) / NANOSECONDS_PER_MILLISECOND],
        ),
        benchmarkMeasurement('one-file-incremental-index', 'milliseconds', [
          Number(incrementalFinished - incrementalStarted) / NANOSECONDS_PER_MILLISECOND,
        ]),
        benchmarkMeasurement('one-file-incremental-pre-activation', 'milliseconds', [
          Number(incrementalActivationStarted - incrementalStarted) / NANOSECONDS_PER_MILLISECOND,
        ]),
        benchmarkMeasurement('one-file-incremental-materialization', 'milliseconds', [
          Number(incrementalMaterializationFinished - incrementalStarted) / NANOSECONDS_PER_MILLISECOND,
        ]),
        benchmarkMeasurement('one-file-incremental-reference-resolution', 'milliseconds', [
          Number(incrementalResolutionFinished - incrementalMaterializationFinished) / NANOSECONDS_PER_MILLISECOND,
        ]),
        benchmarkMeasurement('one-file-incremental-pre-activation-validation', 'milliseconds', [
          Number(incrementalActivationStarted - incrementalResolutionFinished) / NANOSECONDS_PER_MILLISECOND,
        ]),
        benchmarkMeasurement(
          options.vectors
            ? 'one-file-incremental-activation-and-vectors'
            : 'one-file-incremental-activation-lexical-only',
          'milliseconds',
          [Number(incrementalFinished - incrementalActivationStarted) / NANOSECONDS_PER_MILLISECOND],
        ),
        benchmarkMeasurement(
          options.vectors ? 'hot-semantic-vector-query' : 'hot-exact-lexical-query',
          'milliseconds',
          queryDurations,
        ),
        benchmarkMeasurement('cold-process-peak-rss', 'bytes', [coldProcessPeakRssBytes]),
        benchmarkMeasurement('incremental-process-peak-rss', 'bytes', [incrementalProcessPeakRssBytes]),
        benchmarkMeasurement('derived-index-disk', 'bytes', [diskBytes]),
      ],
      metadata: {
        coldEdges: cold.snapshot.edgeCount,
        coldFiles: cold.snapshot.fileCount,
        coldSymbols: cold.snapshot.symbolCount,
        incrementalReusedFiles: incremental.reusedFiles,
        queries: options.scaleSymbols === undefined ? fixture.queries.length : 1,
        retrievalMode: options.vectors ? 'pinned-production-vectors' : 'lexical-only',
        rssMeasurement: 'process.resourceUsage.maxRSS at phase boundary',
        vectorEnabled: options.vectors,
        ...(embeddingModelId ? {embeddingModelId} : {}),
        ...(options.scaleSymbols === undefined ? {} : {scaleSymbols: options.scaleSymbols}),
      },
      suite: options.vectors
        ? 'code-graph-vectors-v1'
        : options.scaleSymbols === undefined
          ? options.fixture
          : 'code-graph-scale-v1',
      version: BENCHMARK_ARTIFACT_VERSION,
      warmups: options.warmups,
    };
    parseBenchmarkArtifactV1(artifact);
    if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    if (options.failOnBudget) {
      const budgetPath = yield* path.fromFileUrl(
        new URL(`../test/evaluation/baselines/${options.fixture}/budgets.json`, import.meta.url),
      );
      enforceBudget(artifact, yield* readJsonFile(budgetPath), options.scaleSymbols);
    }
    yield* printJson(artifact);
  }),
);

function directoryBytes(fs: FileSystem.FileSystem, path: Path.Path, directory: string): Effect.Effect<number, unknown> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(directory))) return 0;
    let bytes = 0;
    for (const name of yield* fs.readDirectory(directory)) {
      const child = path.join(directory, name);
      const info = yield* fs.stat(child);
      if (info.type === 'Directory') bytes += yield* directoryBytes(fs, path, child);
      else if (info.type === 'File') bytes += Number(info.size);
    }
    return bytes;
  });
}

const git = Effect.fn('benchmarkCodeGraph.git')((args: readonly string[]) =>
  runCommandEffect('git', args, {timeoutMs: 30_000}).pipe(Effect.map(result => result.stdout.trim())),
);

function parseArguments(args: readonly string[]): {
  readonly fixture: string;
  readonly modelHome?: string;
  readonly outputPath?: string;
  readonly samples: number;
  readonly scaleSymbols?: number;
  readonly warmups: number;
  readonly failOnBudget: boolean;
  readonly vectors: boolean;
} {
  let fixture = 'code-graph-v1';
  let modelHome: string | undefined;
  let outputPath: string | undefined;
  let samples = 25;
  let scaleSymbols: number | undefined;
  let warmups = 5;
  let failOnBudget = false;
  let vectors = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--fixture') fixture = required(args[++index], argument);
    else if (argument === '--model-home') modelHome = required(args[++index], argument);
    else if (argument === '--samples') samples = integer(args[++index], argument, 1);
    else if (argument === '--scale-symbols') scaleSymbols = integer(args[++index], argument, 1);
    else if (argument === '--warmups') warmups = integer(args[++index], argument, 0);
    else if (argument === '--fail-on-budget') failOnBudget = true;
    else if (argument === '--vectors') vectors = true;
    else throw new Error(`Unknown code graph benchmark option: ${argument}`);
  }
  if (!/^code-graph-[a-z0-9-]+$/.test(fixture)) throw new Error(`Invalid code graph fixture name: ${fixture}.`);
  if (vectors && fixture !== 'code-graph-v1') {
    throw new Error('The vector semantic control is currently defined only for code-graph-v1.');
  }
  return {failOnBudget, fixture, modelHome, outputPath, samples, scaleSymbols, vectors, warmups};
}

function enforceBudget(artifact: BenchmarkArtifactV1, value: unknown, scaleSymbols: number | undefined): void {
  if (typeof value !== 'object' || value === null) throw new Error('Code graph budget file must be an object.');
  const record = value as {
    readonly developmentPerformance?: unknown;
    readonly scalePerformance?: Readonly<Record<string, unknown>>;
    readonly vectorPerformance?: unknown;
    readonly vectorScalePerformance?: Readonly<Record<string, unknown>>;
  };
  const selected =
    artifact.metadata.vectorEnabled === true
      ? scaleSymbols === undefined
        ? record.vectorPerformance
        : record.vectorScalePerformance?.[String(scaleSymbols)]
      : scaleSymbols === undefined
        ? record.developmentPerformance
        : record.scalePerformance?.[String(scaleSymbols)];
  if (typeof selected !== 'object' || selected === null) {
    throw new Error(
      `No reviewed ${artifact.metadata.vectorEnabled === true ? 'vector ' : ''}code graph performance budget exists ` +
        `for ${scaleSymbols ?? 'development'}.`,
    );
  }
  const budget = selected as Readonly<Record<string, unknown>>;
  const checks = [
    ['cold-index', 'coldIndexP95MillisecondsMaximum'],
    ['one-file-incremental-index', 'oneFileIncrementalP95MillisecondsMaximum'],
    [
      artifact.metadata.vectorEnabled === true ? 'hot-semantic-vector-query' : 'hot-exact-lexical-query',
      'hotQueryP95MillisecondsMaximum',
    ],
    ['incremental-process-peak-rss', 'processPeakRssBytesMaximum'],
    ['derived-index-disk', 'derivedIndexBytesMaximum'],
  ] as const;
  const failures: string[] = [];
  for (const [measurementName, budgetName] of checks) {
    const measurement = artifact.measurements.find(candidate => candidate.name === measurementName);
    const maximum = budget[budgetName];
    if (!measurement || typeof maximum !== 'number' || !Number.isFinite(maximum)) {
      failures.push(`missing numeric ${budgetName}`);
    } else if (measurement.p95 > maximum) {
      failures.push(`${measurementName} ${measurement.p95} exceeds ${maximum}`);
    }
  }
  if (failures.length > 0) throw new Error(`Code graph performance budget failed: ${failures.join('; ')}`);
}

function processPeakRssBytes(): number {
  const maxRss = process.resourceUsage().maxRSS;
  return 'bun' in process.versions ? maxRss : maxRss * 1_024;
}

const prepareBenchmarkEmbedding = Effect.fn('benchmarkCodeGraph.prepareEmbedding')(function* (
  targetHome: string,
  sourceHome?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const catalog = yield* LocalModelCatalog;
  const store = yield* LocalModelStore;
  const manifest = yield* catalog.get(CORE_EMBEDDING_MODEL_ID);
  const modelHome = sourceHome ?? targetHome;
  const status = yield* store.status(modelHome, manifest);
  const installed = status.installed
    ? yield* store.verify(modelHome, manifest)
    : yield* store.install(modelHome, manifest);
  if (modelHome !== targetHome) {
    const target = store.path(targetHome, manifest);
    yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
    yield* fs.copy(installed.path, target, {overwrite: true});
  }
  yield* selectLocalModel(targetHome, catalog, 'embedding', manifest.id);
  return manifest.id;
});

function integer(value: string | undefined, option: string, minimum: number): number {
  const parsed = Number.parseInt(required(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${option} must be at least ${minimum}`);
  return parsed;
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new Error(`${option} requires a value`);
  return value;
}

BunRuntime.runMain(benchmarkCodeGraph.pipe(Effect.provide(ApplicationLayer)));
