import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Database} from 'bun:sqlite';
import {Clock, Effect, FileSystem, Path} from 'effect';
import {readCodeGraphBuildStatuses} from '../src/code_graph/build_status.js';
import {CodeGraphIndexer} from '../src/code_graph/indexer.js';
import {CodeGraphAnalysis} from '../src/code_graph/analysis.js';
import {codeGraphLayout} from '../src/code_graph/layout.js';
import {CodeGraphQueryService} from '../src/code_graph/query.js';
import {resolveRepositoryIdentity} from '../src/code_graph/repository.js';
import type {CodeGraphProgress} from '../src/code_graph/types.js';
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
  PRODUCTION_LARGE_CODE_GRAPH_PROFILE,
  VECTOR_SEMANTIC_CONTROL_QUERY,
  generatedSymbolName,
  prepareCodeGraphFixture,
  prepareGeneratedCodeGraphFixture,
  prepareProductionCodeGraphFixture,
  type ProductionCodeGraphFixtureProfile,
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
      options.profile === 'production-large'
        ? yield* prepareProductionCodeGraphFixture(productionProfile(options), options.vectors)
        : options.scaleSymbols === undefined
          ? yield* prepareCodeGraphFixture(options.fixture)
          : yield* prepareGeneratedCodeGraphFixture(options.scaleSymbols, options.vectors);
    const embeddingModelId = options.vectors
      ? yield* prepareBenchmarkEmbedding(prepared.home, options.modelHome)
      : undefined;
    const queryText = options.vectors
      ? VECTOR_SEMANTIC_CONTROL_QUERY
      : (prepared.queryText ??
        (options.scaleSymbols === undefined
          ? options.fixture === 'code-graph-polyglot-v1'
            ? 'KotlinApp'
            : 'exclusive file lock'
          : generatedSymbolName(Math.max(0, options.scaleSymbols - 1))));
    const indexer = yield* CodeGraphIndexer;
    const analysis = yield* CodeGraphAnalysis;
    const query = yield* CodeGraphQueryService;
    const benchmarkIdentity = yield* resolveRepositoryIdentity(prepared.repository);
    const benchmarkLayout = codeGraphLayout(
      path,
      prepared.home,
      benchmarkIdentity.checkoutId,
      benchmarkIdentity.worktreeId,
    );
    const coldStarted = yield* Clock.currentTimeNanos;
    const coldProcessStarted = processTelemetry();
    const coldTimeline = new IndexPhaseTimeline(coldStarted);
    const coldStoragePeak = new SqliteStoragePeakTelemetry();
    const cold = yield* indexer.index({
      cwd: prepared.repository,
      onProgress: progress =>
        observeIndexProgress(coldTimeline, progress).pipe(
          Effect.andThen(observeSqliteStoragePeak(fs, coldStoragePeak, benchmarkLayout.databasePath)),
        ),
      threadnoteHome: prepared.home,
    });
    const coldFinished = yield* Clock.currentTimeNanos;
    coldTimeline.finish(coldFinished);
    yield* observeSqliteStoragePeak(fs, coldStoragePeak, benchmarkLayout.databasePath);
    const coldProcessFinished = processTelemetry();
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
      const expectedPath =
        options.scaleSymbols === undefined && prepared.profile === undefined
          ? 'docs/architecture.md'
          : GENERATED_VECTOR_CONTROL_PATH;
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
    const queryDurations: number[] = [];
    const queryCpuDurations: number[] = [];
    for (let index = 0; index < options.samples; index += 1) {
      const started = yield* Clock.currentTimeNanos;
      const processStarted = processTelemetry();
      yield* query.inspect({
        cwd: prepared.repository,
        operation: 'query',
        query: queryText,
        threadnoteHome: prepared.home,
      });
      queryDurations.push(Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND);
      queryCpuDurations.push(cpuMilliseconds(processStarted, processTelemetry()).total);
    }

    const changedPath = path.join(
      prepared.repository,
      prepared.incrementalSourcePath ??
        (options.scaleSymbols === undefined
          ? options.fixture === 'code-graph-polyglot-v1'
            ? 'src/main.ts'
            : 'packages/search/src/vector-index.ts'
          : 'src/module-00000.ts'),
    );
    yield* fs.writeFileString(
      changedPath,
      `${yield* fs.readFileString(changedPath)}\n// Threadnote benchmark one-file reindex marker.\n`,
    );
    const incrementalStarted = yield* Clock.currentTimeNanos;
    const incrementalProcessStarted = processTelemetry();
    const incrementalTimeline = new IndexPhaseTimeline(incrementalStarted);
    const incrementalStoragePeak = new SqliteStoragePeakTelemetry();
    const incremental = yield* indexer.index({
      cwd: prepared.repository,
      onProgress: progress =>
        observeIndexProgress(incrementalTimeline, progress).pipe(
          Effect.andThen(observeSqliteStoragePeak(fs, incrementalStoragePeak, benchmarkLayout.databasePath)),
        ),
      threadnoteHome: prepared.home,
    });
    const incrementalFinished = yield* Clock.currentTimeNanos;
    incrementalTimeline.finish(incrementalFinished);
    yield* observeSqliteStoragePeak(fs, incrementalStoragePeak, benchmarkLayout.databasePath);
    const incrementalProcessFinished = processTelemetry();
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
      const expectedPath =
        options.scaleSymbols === undefined && prepared.profile === undefined
          ? 'docs/architecture.md'
          : GENERATED_VECTOR_CONTROL_PATH;
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

    const coldStatusStarted = yield* Clock.currentTimeNanos;
    const analysisStatus = yield* query.status(prepared.home, prepared.repository);
    const coldStatusDuration =
      Number((yield* Clock.currentTimeNanos) - coldStatusStarted) / NANOSECONDS_PER_MILLISECOND;
    if (!analysisStatus.readySnapshot) {
      return yield* Effect.fail(new Error('Code graph benchmark could not resolve its ready snapshot for analysis.'));
    }
    const analysisOptions = {
      databasePath: analysisStatus.databasePath,
      limits: {communities: 0, components: 0, hubs: 0, memberships: 0, surprisingLinks: 0},
      snapshot: analysisStatus.readySnapshot,
    } as const;
    for (let index = 0; index < Math.min(options.warmups, 1); index += 1) {
      yield* analysis.analyze(analysisOptions);
    }
    const analysisDurations: number[] = [];
    const analysisCpuDurations: number[] = [];
    let analysisComplete = false;
    for (let index = 0; index < Math.min(options.samples, 3); index += 1) {
      const started = yield* Clock.currentTimeNanos;
      const processStarted = processTelemetry();
      const result = yield* analysis.analyze(analysisOptions);
      analysisDurations.push(Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND);
      analysisCpuDurations.push(cpuMilliseconds(processStarted, processTelemetry()).total);
      analysisComplete = result.coverage.complete;
    }
    if (!analysisComplete) {
      return yield* Effect.fail(new Error('Code graph benchmark analysis returned partial coverage.'));
    }

    const statusSamples = Math.max(1, Math.min(options.samples, options.profile === 'production-large' ? 3 : 10));
    const repositoryStatusDurations: number[] = [];
    const sidecarStatusDurations: number[] = [];
    const layout = benchmarkLayout;
    let observedStatusRecords = 0;
    for (let index = 0; index < statusSamples; index += 1) {
      const repositoryStatusStarted = yield* Clock.currentTimeNanos;
      yield* query.status(prepared.home, prepared.repository);
      repositoryStatusDurations.push(
        Number((yield* Clock.currentTimeNanos) - repositoryStatusStarted) / NANOSECONDS_PER_MILLISECOND,
      );
      const sidecarStatusStarted = yield* Clock.currentTimeNanos;
      const statuses = yield* readCodeGraphBuildStatuses(layout);
      sidecarStatusDurations.push(
        Number((yield* Clock.currentTimeNanos) - sidecarStatusStarted) / NANOSECONDS_PER_MILLISECOND,
      );
      observedStatusRecords = Math.max(observedStatusRecords, statuses.length);
    }

    const databaseRoot = path.join(prepared.home, 'indexes', 'code-graph');
    const storage = yield* codeGraphStorageTelemetry(fs, path, analysisStatus.databasePath, databaseRoot);
    const coldLexicalTermRows = sqliteRowCount(
      analysisStatus.databasePath,
      'SELECT COUNT(*) AS count FROM symbol_terms WHERE snapshot_id = ?',
      cold.snapshot.id,
    );
    const vectorRows = yield* vectorRowCount(fs, path, layout.vectorRoot);
    const coldCpu = cpuMilliseconds(coldProcessStarted, coldProcessFinished);
    const incrementalCpu = cpuMilliseconds(incrementalProcessStarted, incrementalProcessFinished);
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
          prepared.profile !== undefined
            ? productionProfileIdentity(prepared.profile, options.vectors)
            : options.scaleSymbols === undefined
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
        ...indexPhaseMeasurements('cold', coldTimeline, options.vectors),
        benchmarkMeasurement('one-file-reindex-index', 'milliseconds', [
          Number(incrementalFinished - incrementalStarted) / NANOSECONDS_PER_MILLISECOND,
        ]),
        ...indexPhaseMeasurements('one-file-reindex', incrementalTimeline, options.vectors),
        benchmarkMeasurement(
          options.vectors ? 'hot-semantic-vector-query' : 'hot-exact-lexical-query',
          'milliseconds',
          queryDurations,
        ),
        benchmarkMeasurement('hot-query-process-cpu', 'milliseconds', queryCpuDurations),
        benchmarkMeasurement('whole-graph-structural-analysis', 'milliseconds', analysisDurations),
        benchmarkMeasurement('whole-graph-structural-analysis-process-cpu', 'milliseconds', analysisCpuDurations),
        benchmarkMeasurement('first-repository-status-read', 'milliseconds', [coldStatusDuration]),
        benchmarkMeasurement('hot-repository-status-read', 'milliseconds', repositoryStatusDurations),
        benchmarkMeasurement('hot-build-sidecar-status-read', 'milliseconds', sidecarStatusDurations),
        benchmarkMeasurement('cold-process-cpu-user', 'milliseconds', [coldCpu.user]),
        benchmarkMeasurement('cold-process-cpu-system', 'milliseconds', [coldCpu.system]),
        benchmarkMeasurement('cold-process-cpu-total', 'milliseconds', [coldCpu.total]),
        benchmarkMeasurement('incremental-process-cpu-user', 'milliseconds', [incrementalCpu.user]),
        benchmarkMeasurement('incremental-process-cpu-system', 'milliseconds', [incrementalCpu.system]),
        benchmarkMeasurement('incremental-process-cpu-total', 'milliseconds', [incrementalCpu.total]),
        benchmarkMeasurement('cold-process-peak-rss', 'bytes', [coldProcessFinished.peakRssBytes]),
        benchmarkMeasurement('cold-process-boundary-rss', 'bytes', [coldProcessFinished.rssBytes]),
        benchmarkMeasurement('incremental-process-peak-rss', 'bytes', [incrementalProcessFinished.peakRssBytes]),
        benchmarkMeasurement('incremental-process-boundary-rss', 'bytes', [incrementalProcessFinished.rssBytes]),
        benchmarkMeasurement('sqlite-main-disk', 'bytes', [storage.sqliteMainBytes]),
        benchmarkMeasurement('sqlite-wal-disk', 'bytes', [storage.sqliteWalBytes]),
        benchmarkMeasurement('sqlite-shm-disk', 'bytes', [storage.sqliteShmBytes]),
        benchmarkMeasurement('cold-sqlite-main-peak-observed', 'bytes', [coldStoragePeak.sqliteMainBytes]),
        benchmarkMeasurement('cold-sqlite-wal-peak-observed', 'bytes', [coldStoragePeak.sqliteWalBytes]),
        benchmarkMeasurement('cold-sqlite-shm-peak-observed', 'bytes', [coldStoragePeak.sqliteShmBytes]),
        benchmarkMeasurement('incremental-sqlite-main-peak-observed', 'bytes', [
          incrementalStoragePeak.sqliteMainBytes,
        ]),
        benchmarkMeasurement('incremental-sqlite-wal-peak-observed', 'bytes', [incrementalStoragePeak.sqliteWalBytes]),
        benchmarkMeasurement('incremental-sqlite-shm-peak-observed', 'bytes', [incrementalStoragePeak.sqliteShmBytes]),
        benchmarkMeasurement('vector-index-disk', 'bytes', [storage.vectorBytes]),
        benchmarkMeasurement('build-status-sidecar-disk', 'bytes', [storage.buildStatusBytes]),
        benchmarkMeasurement('derived-index-unclassified-disk', 'bytes', [storage.unclassifiedRepositoryBytes]),
        benchmarkMeasurement('derived-index-disk', 'bytes', [storage.totalBytes]),
        benchmarkMeasurement('cold-lexical-term-rows', 'count', [coldLexicalTermRows]),
        benchmarkMeasurement('vector-rows', 'count', [vectorRows]),
        ...(prepared.profile
          ? productionShapeMeasurements(prepared.profile, {
              edges: cold.snapshot.edgeCount,
              files: cold.snapshot.fileCount,
              symbols: cold.snapshot.symbolCount,
              terms: coldLexicalTermRows,
            })
          : []),
      ],
      metadata: {
        coldEdges: cold.snapshot.edgeCount,
        coldFiles: cold.snapshot.fileCount,
        coldSymbols: cold.snapshot.symbolCount,
        incrementalReusedFiles: incremental.reusedFiles,
        oneFileReindexMaterializationMode: incremental.materialization?.mode ?? 'unreported',
        oneFileReindexStagedFiles: incremental.materialization?.stagedFiles ?? 0,
        oneFileReindexTotalFiles: incremental.materialization?.totalFiles ?? 0,
        ...(incremental.materialization?.fallbackReason
          ? {oneFileReindexFallbackReason: incremental.materialization.fallbackReason}
          : {}),
        analysisSamples: analysisDurations.length,
        analysisCoverage: 'complete',
        coldIndexSamples: 1,
        cpuMeasurement: 'process.cpuUsage delta at operation boundary',
        diskMeasurement:
          'final bytes plus SQLite main/WAL/SHM peaks sampled at progress boundaries; vectors, sidecar, and unclassified bytes separate',
        incrementalIndexSamples: 1,
        observedBuildStatusRecords: observedStatusRecords,
        percentileInterpretation:
          'samples=1 is one observation; p50/p95/p99 fields are identical summaries, not percentile estimates',
        phaseMeasurement: 'first progress transition and explicit subphase completion boundaries',
        queries: options.scaleSymbols === undefined && prepared.profile === undefined ? fixture.queries.length : 1,
        retrievalMode: options.vectors ? 'pinned-production-vectors' : 'lexical-only',
        rssMeasurement:
          'boundary RSS plus process-lifetime resourceUsage.maxRSS; peak is cumulative, not phase-isolated',
        statusSamples,
        vectorEnabled: options.vectors,
        vectorRows,
        ...(embeddingModelId ? {embeddingModelId} : {}),
        ...(options.scaleSymbols === undefined ? {} : {scaleSymbols: options.scaleSymbols}),
        ...(prepared.profile
          ? {
              profile: prepared.profile.id,
              profileDeclarationSymbols: prepared.profile.declarationSymbols,
              profileSourceFiles: prepared.profile.sourceFiles,
              profileTargetEdges: prepared.profile.targetGraphEdges,
              profileTargetEligibleFiles: prepared.profile.targetEligibleFiles,
              profileTargetLexicalTermRows: prepared.profile.targetLexicalTermRows,
              profileTargetSymbols: prepared.profile.targetGraphSymbols,
              profileVersion: prepared.profile.version,
              profileWorkspaces: prepared.profile.workspaceCount,
            }
          : {}),
      },
      suite: prepared.profile
        ? options.vectors
          ? 'code-graph-production-large-vectors-v1'
          : 'code-graph-production-large-v1'
        : options.vectors
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

type IndexPhasePoint =
  | 'activating:complete'
  | 'activating:promoting'
  | 'activating:validating-input'
  | 'activating:writing-and-checkpointing'
  | 'embedding:complete'
  | 'embedding:start'
  | 'finish'
  | 'materializing:complete'
  | 'materializing:start'
  | 'registering:start'
  | 'resolving:complete'
  | 'resolving:references'
  | 'scanning:complete'
  | 'scanning:start'
  | 'start'
  | 'waiting:start';

class IndexPhaseTimeline {
  readonly #points = new Map<IndexPhasePoint, bigint>();

  constructor(startedAt: bigint) {
    this.#points.set('start', startedAt);
  }

  observe(progress: CodeGraphProgress, at: bigint): void {
    switch (progress.phase) {
      case 'registering':
        this.#first('registering:start', at);
        break;
      case 'waiting':
        this.#first('waiting:start', at);
        break;
      case 'scanning':
        this.#first('scanning:start', at);
        if (progress.completed >= progress.total) this.#points.set('scanning:complete', at);
        break;
      case 'materializing':
        this.#first('materializing:start', at);
        if (progress.completed >= progress.total) this.#points.set('materializing:complete', at);
        break;
      case 'resolving':
        if (progress.subphase === 'references') this.#first('resolving:references', at);
        else this.#points.set('resolving:complete', at);
        break;
      case 'activating':
        if (progress.subphase === 'validating-input') this.#first('activating:validating-input', at);
        else if (progress.subphase === 'writing-and-checkpointing') {
          this.#first('activating:writing-and-checkpointing', at);
        } else if (progress.subphase === 'promoting') this.#first('activating:promoting', at);
        else if (progress.subphase === 'complete') this.#points.set('activating:complete', at);
        break;
      case 'embedding':
        this.#first('embedding:start', at);
        if (progress.completed >= progress.total) this.#points.set('embedding:complete', at);
        break;
    }
  }

  finish(at: bigint): void {
    this.#points.set('finish', at);
  }

  duration(from: IndexPhasePoint, to: IndexPhasePoint, ...fallbackTo: readonly IndexPhasePoint[]): number {
    const start = this.#points.get(from);
    if (start === undefined) return 0;
    const end = [to, ...fallbackTo, 'finish' as const]
      .map(point => this.#points.get(point))
      .find((candidate): candidate is bigint => candidate !== undefined);
    return Math.max(0, Number((end ?? start) - start) / NANOSECONDS_PER_MILLISECOND);
  }

  #first(point: IndexPhasePoint, at: bigint): void {
    if (!this.#points.has(point)) this.#points.set(point, at);
  }
}

function observeIndexProgress(timeline: IndexPhaseTimeline, progress: CodeGraphProgress): Effect.Effect<void> {
  return Clock.currentTimeNanos.pipe(Effect.tap(at => Effect.sync(() => timeline.observe(progress, at))));
}

function indexPhaseMeasurements(
  prefix: 'cold' | 'one-file-reindex',
  timeline: IndexPhaseTimeline,
  vectors: boolean,
): ReturnType<typeof benchmarkMeasurement>[] {
  return [
    benchmarkMeasurement(`${prefix}-registration-lock-and-database-setup`, 'milliseconds', [
      timeline.duration('start', 'scanning:start', 'materializing:start'),
    ]),
    benchmarkMeasurement(`${prefix}-inventory-and-extraction`, 'milliseconds', [
      timeline.duration('scanning:start', 'scanning:complete', 'materializing:start'),
    ]),
    benchmarkMeasurement(`${prefix}-post-committed-scan-overlay-and-workspace`, 'milliseconds', [
      timeline.duration('scanning:complete', 'materializing:start'),
    ]),
    benchmarkMeasurement(`${prefix}-pre-activation`, 'milliseconds', [
      timeline.duration('start', 'activating:validating-input'),
    ]),
    benchmarkMeasurement(`${prefix}-materialization`, 'milliseconds', [
      timeline.duration('materializing:start', 'resolving:references'),
    ]),
    benchmarkMeasurement(`${prefix}-reference-resolution`, 'milliseconds', [
      timeline.duration('resolving:references', 'resolving:complete'),
    ]),
    benchmarkMeasurement(`${prefix}-resolved-fact-accounting`, 'milliseconds', [
      timeline.duration('resolving:complete', 'activating:validating-input'),
    ]),
    benchmarkMeasurement(`${prefix}-pre-activation-validation`, 'milliseconds', [
      timeline.duration('activating:validating-input', 'activating:writing-and-checkpointing'),
    ]),
    benchmarkMeasurement(`${prefix}-snapshot-write-and-checkpoint`, 'milliseconds', [
      timeline.duration('activating:writing-and-checkpointing', 'activating:promoting', 'activating:complete'),
    ]),
    benchmarkMeasurement(`${prefix}-snapshot-promotion`, 'milliseconds', [
      timeline.duration('activating:promoting', 'activating:complete'),
    ]),
    benchmarkMeasurement(
      vectors ? `${prefix}-activation-and-vectors` : `${prefix}-activation-lexical-only`,
      'milliseconds',
      [timeline.duration('activating:validating-input', 'finish')],
    ),
    benchmarkMeasurement(`${prefix}-vector-index`, 'milliseconds', [
      timeline.duration('embedding:start', 'embedding:complete', 'finish'),
    ]),
  ];
}

interface ProcessTelemetry {
  readonly cpuSystemMicroseconds: number;
  readonly cpuUserMicroseconds: number;
  readonly peakRssBytes: number;
  readonly rssBytes: number;
}

function processTelemetry(): ProcessTelemetry {
  const cpu = process.cpuUsage();
  return {
    cpuSystemMicroseconds: cpu.system,
    cpuUserMicroseconds: cpu.user,
    peakRssBytes: processPeakRssBytes(),
    rssBytes: process.memoryUsage().rss,
  };
}

function cpuMilliseconds(
  started: ProcessTelemetry,
  finished: ProcessTelemetry,
): {readonly system: number; readonly total: number; readonly user: number} {
  const system = Math.max(0, finished.cpuSystemMicroseconds - started.cpuSystemMicroseconds) / 1_000;
  const user = Math.max(0, finished.cpuUserMicroseconds - started.cpuUserMicroseconds) / 1_000;
  return {system, total: system + user, user};
}

interface CodeGraphStorageTelemetry {
  readonly buildStatusBytes: number;
  readonly sqliteMainBytes: number;
  readonly sqliteShmBytes: number;
  readonly sqliteWalBytes: number;
  readonly totalBytes: number;
  readonly unclassifiedRepositoryBytes: number;
  readonly vectorBytes: number;
}

class SqliteStoragePeakTelemetry {
  sqliteMainBytes = 0;
  sqliteShmBytes = 0;
  sqliteWalBytes = 0;

  observe(main: number, wal: number, shm: number): void {
    this.sqliteMainBytes = Math.max(this.sqliteMainBytes, main);
    this.sqliteWalBytes = Math.max(this.sqliteWalBytes, wal);
    this.sqliteShmBytes = Math.max(this.sqliteShmBytes, shm);
  }
}

function observeSqliteStoragePeak(
  fs: FileSystem.FileSystem,
  telemetry: SqliteStoragePeakTelemetry,
  databasePath: string,
): Effect.Effect<void, unknown> {
  return Effect.all(
    [
      regularFileBytes(fs, databasePath),
      regularFileBytes(fs, `${databasePath}-wal`),
      regularFileBytes(fs, `${databasePath}-shm`),
    ],
    {concurrency: 3},
  ).pipe(
    Effect.tap(([main, wal, shm]) => Effect.sync(() => telemetry.observe(main, wal, shm))),
    Effect.asVoid,
  );
}

const codeGraphStorageTelemetry = Effect.fn('benchmarkCodeGraph.storageTelemetry')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  databasePath: string,
  databaseRoot: string,
) {
  const repositoryRoot = path.dirname(databasePath);
  const [totalBytes, repositoryBytes, sqliteMainBytes, sqliteWalBytes, sqliteShmBytes, vectorBytes, buildStatusBytes] =
    yield* Effect.all(
      [
        directoryBytes(fs, path, databaseRoot),
        directoryBytes(fs, path, repositoryRoot),
        regularFileBytes(fs, databasePath),
        regularFileBytes(fs, `${databasePath}-wal`),
        regularFileBytes(fs, `${databasePath}-shm`),
        directoryBytes(fs, path, path.join(repositoryRoot, 'vectors')),
        directoryBytes(fs, path, path.join(repositoryRoot, 'build-status')),
      ],
      {concurrency: 7},
    );
  return {
    buildStatusBytes,
    sqliteMainBytes,
    sqliteShmBytes,
    sqliteWalBytes,
    totalBytes,
    unclassifiedRepositoryBytes: Math.max(
      0,
      repositoryBytes - sqliteMainBytes - sqliteWalBytes - sqliteShmBytes - vectorBytes - buildStatusBytes,
    ),
    vectorBytes,
  } satisfies CodeGraphStorageTelemetry;
});

function regularFileBytes(fs: FileSystem.FileSystem, file: string): Effect.Effect<number, unknown> {
  return fs.stat(file).pipe(
    Effect.map(info => (info.type === 'File' ? Number(info.size) : 0)),
    Effect.catch(() => Effect.succeed(0)),
  );
}

function sqliteRowCount(databasePath: string, query: string, ...parameters: readonly string[]): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database.query(query).get(...parameters) as {readonly count?: bigint | number} | null;
    const count = Number(row?.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid SQLite row count for ${databasePath}.`);
    return count;
  } finally {
    database.close(false);
  }
}

const vectorRowCount = Effect.fn('benchmarkCodeGraph.vectorRowCount')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  vectorRoot: string,
) {
  if (!(yield* fs.exists(vectorRoot))) return 0;
  let count = 0;
  for (const model of yield* fs.readDirectory(vectorRoot)) {
    const modelRoot = path.join(vectorRoot, model);
    const info = yield* fs.stat(modelRoot);
    if (info.type !== 'Directory') continue;
    for (const name of yield* fs.readDirectory(modelRoot)) {
      if (!/^vectors-v\d+\.sqlite$/.test(name)) continue;
      count += sqliteRowCount(path.join(modelRoot, name), 'SELECT COUNT(*) AS count FROM vectors');
    }
  }
  return count;
});

function productionShapeMeasurements(
  profile: ProductionCodeGraphFixtureProfile,
  actual: {readonly edges: number; readonly files: number; readonly symbols: number; readonly terms: number},
): ReturnType<typeof benchmarkMeasurement>[] {
  const percent = (value: number, target: number) => (value / target) * 100;
  return [
    benchmarkMeasurement('production-shape-file-target-attainment', 'percent', [
      percent(actual.files, profile.targetEligibleFiles),
    ]),
    benchmarkMeasurement('production-shape-symbol-target-attainment', 'percent', [
      percent(actual.symbols, profile.targetGraphSymbols),
    ]),
    benchmarkMeasurement('production-shape-edge-target-attainment', 'percent', [
      percent(actual.edges, profile.targetGraphEdges),
    ]),
    benchmarkMeasurement('production-shape-lexical-term-target-attainment', 'percent', [
      percent(actual.terms, profile.targetLexicalTermRows),
    ]),
  ];
}

const git = Effect.fn('benchmarkCodeGraph.git')((args: readonly string[]) =>
  runCommandEffect('git', args, {timeoutMs: 30_000}).pipe(Effect.map(result => result.stdout.trim())),
);

interface CodeGraphBenchmarkOptions {
  readonly fixture: string;
  readonly modelHome?: string;
  readonly outputPath?: string;
  readonly profile?: 'production-large';
  readonly profileFiles?: number;
  readonly profileSymbols?: number;
  readonly samples: number;
  readonly scaleSymbols?: number;
  readonly warmups: number;
  readonly failOnBudget: boolean;
  readonly vectors: boolean;
}

export function parseCodeGraphBenchmarkArguments(args: readonly string[]): CodeGraphBenchmarkOptions {
  let fixture = 'code-graph-v1';
  let modelHome: string | undefined;
  let outputPath: string | undefined;
  let profile: 'production-large' | undefined;
  let profileFiles: number | undefined;
  let profileSymbols: number | undefined;
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
    else if (argument === '--profile') {
      const value = required(args[++index], argument);
      if (value !== 'production-large') throw new Error(`Unknown code graph benchmark profile: ${value}`);
      profile = value;
    } else if (argument === '--profile-files') profileFiles = integer(args[++index], argument, 1);
    else if (argument === '--profile-symbols') profileSymbols = integer(args[++index], argument, 2);
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
  if (profile && scaleSymbols !== undefined) {
    throw new Error('--profile and --scale-symbols are separate fixture modes and cannot be combined.');
  }
  if ((profileFiles !== undefined || profileSymbols !== undefined) && profile !== 'production-large') {
    throw new Error('--profile-files and --profile-symbols require --profile production-large.');
  }
  if (profile === 'production-large' && fixture !== 'code-graph-v1') {
    throw new Error('The production-large profile uses the code-graph-v1 query contract.');
  }
  if (profile === 'production-large' && failOnBudget) {
    throw new Error(
      'The opt-in production-large profile has no portable latency budget; retain and review its artifact.',
    );
  }
  return {
    failOnBudget,
    fixture,
    modelHome,
    outputPath,
    profile,
    profileFiles,
    profileSymbols,
    samples,
    scaleSymbols,
    vectors,
    warmups,
  };
}

const parseArguments = parseCodeGraphBenchmarkArguments;

export function productionProfile(options: CodeGraphBenchmarkOptions): ProductionCodeGraphFixtureProfile {
  if (options.profile !== 'production-large') throw new Error('Production fixture profile was not selected.');
  if (options.profileFiles === undefined && options.profileSymbols === undefined) {
    return PRODUCTION_LARGE_CODE_GRAPH_PROFILE;
  }
  const sourceFiles = options.profileFiles ?? PRODUCTION_LARGE_CODE_GRAPH_PROFILE.sourceFiles;
  const targetGraphSymbols = options.profileSymbols ?? PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetGraphSymbols;
  const scale = targetGraphSymbols / PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetGraphSymbols;
  const workspaceCount = Math.min(PRODUCTION_LARGE_CODE_GRAPH_PROFILE.workspaceCount, sourceFiles);
  const metadataGraphSymbols = workspaceCount + 3;
  const declarationSymbols = targetGraphSymbols - sourceFiles - metadataGraphSymbols;
  if (declarationSymbols < sourceFiles) {
    throw new Error(
      '--profile-symbols must cover the requested files, manifest/module symbols, and at least one declaration per file.',
    );
  }
  return {
    declarationSymbols,
    id: 'production-large',
    sourceFiles,
    targetEligibleFiles: sourceFiles + workspaceCount * 2 + 4,
    targetGraphEdges: Math.max(1, Math.round(PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetGraphEdges * scale)),
    targetGraphSymbols,
    targetLexicalTermRows: Math.max(1, Math.round(PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetLexicalTermRows * scale)),
    version: 1,
    workspaceCount,
  };
}

function productionProfileIdentity(profile: ProductionCodeGraphFixtureProfile, vectors: boolean): string {
  return (
    `generated-code-graph-production-v${profile.version}-${vectors ? 'vectors' : 'lexical'}:` +
    `${profile.targetEligibleFiles}:${profile.targetGraphSymbols}:${profile.targetGraphEdges}:` +
    `${profile.targetLexicalTermRows}:${profile.workspaceCount}`
  );
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
    ['one-file-reindex-index', 'oneFileIncrementalP95MillisecondsMaximum'],
    [
      artifact.metadata.vectorEnabled === true ? 'hot-semantic-vector-query' : 'hot-exact-lexical-query',
      'hotQueryP95MillisecondsMaximum',
    ],
    ['whole-graph-structural-analysis', 'wholeGraphAnalysisP95MillisecondsMaximum'],
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
      const statistic =
        measurement.samples === 1
          ? `single observation ${measurement.maximum}`
          : `p95 ${measurement.p95} over ${measurement.samples} samples`;
      failures.push(`${measurementName} ${statistic} exceeds ${maximum}`);
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
