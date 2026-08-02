import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Database} from 'bun:sqlite';
import {Clock, Effect, Exit, FileSystem, Option, Path} from 'effect';
import {readCodeGraphBuildStatuses} from '../src/code_graph/build_status.js';
import {CodeGraphIndexer} from '../src/code_graph/indexer.js';
import {CodeGraphAnalysis} from '../src/code_graph/analysis.js';
import {codeGraphLayout} from '../src/code_graph/layout.js';
import {parserWorkerCapacity} from '../src/code_graph/parser_worker.js';
import {CodeGraphQueryService, type CodeGraphInspectOptions} from '../src/code_graph/query.js';
import {resolveRepositoryIdentity} from '../src/code_graph/repository.js';
import type {CodeGraphActivationActivity, CodeGraphProgress, CodeGraphQueryResult} from '../src/code_graph/types.js';
import {runCommandEffect} from '../src/effect/command.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {SystemInfo} from '../src/effect/system.js';
import {CORE_EMBEDDING_MODEL_ID} from '../src/models/builtin.js';
import {LocalModelCatalog} from '../src/models/catalog.js';
import {selectLocalModel} from '../src/models/selection.js';
import {LocalModelStore} from '../src/models/store.js';
import {codeGraphMcpResponse} from '../src/mcp_server.js';
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
import {
  parseCodeGraphBenchmarkSamplerArtifact,
  type CodeGraphBenchmarkSamplerArtifact,
} from './code-graph-benchmark-sampler.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const EXTERNAL_SAMPLER_READY_TIMEOUT_MS = 5_000;
const EXTERNAL_SAMPLER_STOP_TIMEOUT_MS = 5_000;
const EXTERNAL_SAMPLER_TERMINATE_TIMEOUT_MS = 1_000;
export const PRODUCTION_LARGE_TARGET_ATTAINMENT_MINIMUM_PERCENT = 90;
const CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'status.showUntrackedFiles=all',
  '-c',
  'diff.ignoreSubmodules=none',
  'status',
  '--porcelain=v1',
  '--untracked-files=all',
  '--ignore-submodules=none',
  '--no-renames',
] as const;

const ACTIVATION_STAGES = [
  'validating-input',
  'copying-workspace',
  'copying-files',
  'copying-symbols',
  'copying-terms',
  'copying-edges',
  'copying-lookup-keys',
  'copying-reexports',
  'committing-snapshot',
  'checkpointing-snapshot',
  'recording-completion',
] as const satisfies readonly CodeGraphActivationActivity['stage'][];

const DIRECT_PERSISTENT_ACTIVATION_STAGES = [
  'validating-input',
  'recording-completion',
  'committing-snapshot',
] as const satisfies readonly CodeGraphActivationActivity['stage'][];

const INCREMENTAL_STAGED_ACTIVATION_STAGES = [
  'validating-input',
  'copying-workspace',
  'copying-files',
  'copying-symbols',
  'copying-terms',
  'copying-edges',
  'recording-completion',
  'committing-snapshot',
  'checkpointing-snapshot',
] as const satisfies readonly CodeGraphActivationActivity['stage'][];

const ACTIVATION_COPY_STAGES = ACTIVATION_STAGES.filter(stage => stage.startsWith('copying-'));

const ACTIVATION_RELEASE_EVIDENCE_MEASUREMENTS = (['cold', 'one-file-reindex'] as const).flatMap(prefix => [
  {name: `${prefix}-activation-observed-stages-n1`, unit: 'count'} as const,
  {name: `${prefix}-activation-longest-transaction-n1`, unit: 'milliseconds'} as const,
  {name: `${prefix}-maximum-progress-heartbeat-gap-n1`, unit: 'milliseconds'} as const,
  ...ACTIVATION_STAGES.flatMap(stage => [
    {name: `${prefix}-activation-${stage}-observed-n1`, unit: 'count'} as const,
    {name: `${prefix}-activation-${stage}-duration-n1`, unit: 'milliseconds'} as const,
    {name: `${prefix}-activation-${stage}-rows-n1`, unit: 'count'} as const,
  ]),
]);

const SAMPLER_RELEASE_EVIDENCE_MEASUREMENTS = (['cold', 'one-file-reindex', 'same-overlay-reference'] as const).flatMap(
  prefix => [
    {name: `${prefix}-external-sampler-version-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-storage-samples-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-process-tree-samples-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-process-tree-attempts-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-process-tree-failures-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-process-tree-maximum-sample-gap-n1`, unit: 'milliseconds'} as const,
    {name: `${prefix}-external-process-count-peak-observed-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-process-cpu-n1`, unit: 'milliseconds'} as const,
    {name: `${prefix}-external-rss-peak-observed-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-external-open-temp-process-tree-attempts-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-open-temp-process-tree-failures-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-open-temp-process-tree-samples-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-sqlite-temp-combined-peak-observed-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-external-sqlite-temp-linked-peak-observed-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-external-sqlite-temp-open-process-tree-peak-observed-n1`, unit: 'bytes'} as const,
  ],
);

export const PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS = [
  {name: 'cold-materialization', unit: 'milliseconds'},
  {name: 'cold-materialization-process-cpu-n1', unit: 'milliseconds'},
  {name: 'cold-materialization-boundary-rss-n1', unit: 'bytes'},
  {name: 'cold-materialized-file-rows', unit: 'count'},
  {name: 'cold-materialized-symbol-rows', unit: 'count'},
  {name: 'cold-materialized-edge-rows', unit: 'count'},
  {name: 'cold-materialized-lexical-term-rows', unit: 'count'},
  {name: 'one-file-reindex-materialization', unit: 'milliseconds'},
  {name: 'one-file-reindex-materialization-process-cpu-n1', unit: 'milliseconds'},
  {name: 'one-file-reindex-materialization-boundary-rss-n1', unit: 'bytes'},
  {name: 'one-file-reindex-materialization-staged-files', unit: 'count'},
  {name: 'one-file-reindex-materialization-total-files', unit: 'count'},
  {name: 'cold-primary-query-returned-nodes', unit: 'count'},
  {name: 'one-file-reindex-primary-query-returned-nodes', unit: 'count'},
  {name: 'same-overlay-full-rebuild-index', unit: 'milliseconds'},
  {name: 'same-overlay-full-rebuild-primary-query-returned-nodes', unit: 'count'},
  {name: 'primary-query-structural-parity', unit: 'count'},
  {name: 'structural-graph-digest-parity', unit: 'count'},
  {name: 'cold-sqlite-temp-database-pages-high-water-n1', unit: 'bytes'},
  {name: 'cold-sqlite-durable-database-pages-high-water-n1', unit: 'bytes'},
  {name: 'cold-materialization-cached-fact-bytes-total-n1', unit: 'bytes'},
  {name: 'cold-materialization-estimated-temp-filesystem-required-n1', unit: 'bytes'},
  {name: 'cold-materialization-estimated-durable-filesystem-required-n1', unit: 'bytes'},
  {name: 'cold-materialization-temp-filesystem-available-n1', unit: 'bytes'},
  {name: 'cold-materialization-durable-filesystem-available-n1', unit: 'bytes'},
  {name: 'cold-materialization-filesystems-shared-n1', unit: 'count'},
  {name: 'cold-materialization-deduplicated-edge-rows-n1', unit: 'count'},
  {name: 'cold-materialization-deduplicated-reference-rows-n1', unit: 'count'},
  {name: 'one-file-reindex-sqlite-temp-database-pages-high-water-n1', unit: 'bytes'},
  {name: 'one-file-reindex-materialization-deduplicated-edge-rows-n1', unit: 'count'},
  {name: 'one-file-reindex-materialization-deduplicated-reference-rows-n1', unit: 'count'},
  {name: 'production-shape-file-target-attainment', unit: 'percent'},
  {name: 'production-shape-symbol-target-attainment', unit: 'percent'},
  {name: 'production-shape-edge-target-attainment', unit: 'percent'},
  {name: 'production-shape-lexical-term-target-attainment', unit: 'percent'},
  ...SAMPLER_RELEASE_EVIDENCE_MEASUREMENTS,
  ...ACTIVATION_RELEASE_EVIDENCE_MEASUREMENTS,
] as const;

const EXTERNAL_AGGREGATE_EVIDENCE_MEASUREMENTS = [
  {name: 'cold-language-category-count', unit: 'count'},
  {name: 'cold-workspace-scope-rows', unit: 'count'},
  {name: 'cold-workspace-component-rows', unit: 'count'},
  {name: 'cold-bazel-workspace-scope-rows', unit: 'count'},
  {name: 'cold-bazel-workspace-component-rows', unit: 'count'},
] as const;

export const EXTERNAL_REPOSITORY_EVIDENCE_MEASUREMENTS = [
  ...PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS.filter(measurement => !measurement.name.startsWith('production-shape-')),
  ...EXTERNAL_AGGREGATE_EVIDENCE_MEASUREMENTS,
] as const;

export interface ExternalRepositoryQueryControl {
  readonly expectedLanguage: string;
  readonly expectedPath: string;
  readonly query: string;
}

interface PreparedCodeGraphBenchmarkFixture {
  readonly externalCommit?: string;
  readonly externalControls?: readonly ExternalRepositoryQueryControl[];
  readonly fixtureIdentity?: string;
  readonly home: string;
  readonly incrementalSourcePath?: string;
  readonly profile?: ProductionCodeGraphFixtureProfile;
  readonly preserveHomes?: Effect.Effect<void>;
  readonly queryText?: string;
  readonly referenceHome?: string;
  readonly repository: string;
}

export interface CodeGraphBenchmarkRunCheckpoint {
  readonly phase: string;
  readonly state: 'complete' | 'failed' | 'running';
  readonly updatedAt: string;
  readonly version: 1;
}

interface CodeGraphBenchmarkRunCheckpointHandle {
  readonly mark: (phase: string) => Effect.Effect<void, unknown>;
  readonly finish: (state: 'complete' | 'failed') => Effect.Effect<void, never>;
}

const benchmarkCodeGraph = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const options = parseArguments(yield* scriptArguments());
    const threadnoteSourceRoot = yield* path.fromFileUrl(new URL('..', import.meta.url));
    const releaseEvidenceSource = yield* validateReleaseEvidenceSource(
      threadnoteSourceRoot,
      process.env.THREADNOTE_BENCHMARK_RELEASE_REF?.trim() || undefined,
      process.env.THREADNOTE_BENCHMARK_RELEASE_SHA?.trim() || undefined,
    );
    const largeEvidenceRun = options.profile === 'production-large' || options.repository !== undefined;
    const externalPrepared =
      options.repository !== undefined ? yield* prepareExternalCodeGraphFixture(options) : undefined;
    const externalPreflight = externalPrepared
      ? yield* externalBenchmarkPreflight(fs, path, externalPrepared, options.minimumFreeGiB, options.retainHomes)
      : undefined;
    if (options.preflight) {
      if (!externalPreflight) {
        return yield* Effect.fail(new Error('External benchmark preflight was not prepared.'));
      }
      if (options.outputPath) {
        yield* atomicWrite(
          `${options.outputPath}.preflight.json`,
          `${JSON.stringify(externalPreflight, undefined, 2)}\n`,
        );
      }
      yield* printJson(externalPreflight);
      return;
    }
    if (externalPrepared && options.retainHomes) {
      yield* externalPrepared.preserveHomes ??
        Effect.fail(new Error('External benchmark homes could not be retained after preflight.'));
    }
    const runCheckpoint =
      largeEvidenceRun && options.outputPath
        ? yield* Effect.acquireRelease(
            makeBenchmarkRunCheckpoint(`${options.outputPath}.run.json`),
            (checkpoint, exit) => checkpoint.finish(Exit.isSuccess(exit) ? 'complete' : 'failed'),
          )
        : undefined;
    const fixturePath = yield* path.fromFileUrl(
      new URL(`../test/evaluation/fixtures/${options.fixture}/fixture.json`, import.meta.url),
    );
    const fixture = parseCodeGraphEvaluationFixtureV1(yield* readJsonFile(fixturePath));
    const bootstrapRoot =
      options.profile === 'production-large'
        ? yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-graph-benchmark-bootstrap-'})
        : undefined;
    const bootstrapSampler =
      options.profile === 'production-large' && bootstrapRoot
        ? yield* Effect.acquireRelease(
            startExternalSampler(
              fs,
              path,
              bootstrapRoot,
              path.join(bootstrapRoot, 'sqlite-temp'),
              path.join(bootstrapRoot, 'not-created.sqlite'),
              benchmarkSamplerCheckpointPath(path, bootstrapRoot, options.outputPath, 'bootstrap'),
              'bootstrap',
            ),
            (sampler, exit) => sampler.stop(Exit.isSuccess(exit) ? 'complete' : 'aborted').pipe(Effect.ignore),
          )
        : undefined;
    const prepared: PreparedCodeGraphBenchmarkFixture =
      externalPrepared !== undefined
        ? externalPrepared
        : options.profile === 'production-large'
          ? yield* prepareProductionCodeGraphFixture(productionProfile(options), options.vectors)
          : options.scaleSymbols === undefined
            ? yield* prepareCodeGraphFixture(options.fixture)
            : yield* prepareGeneratedCodeGraphFixture(options.scaleSymbols, options.vectors);
    yield* runCheckpoint?.mark('preparing-runtime') ?? Effect.void;
    yield* bootstrapSampler?.markPhase('preparing-runtime') ?? Effect.void;
    const embeddingModelId = options.vectors
      ? yield* prepareBenchmarkEmbedding(prepared.home, options.modelHome)
      : undefined;
    const queryText =
      options.queryText ??
      (options.vectors
        ? VECTOR_SEMANTIC_CONTROL_QUERY
        : (prepared.queryText ??
          (options.scaleSymbols === undefined
            ? options.fixture === 'code-graph-polyglot-v1'
              ? 'KotlinApp'
              : 'exclusive file lock'
            : generatedSymbolName(Math.max(0, options.scaleSymbols - 1)))));
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
    const samplerRoot = path.join(prepared.home, 'benchmark-telemetry');
    const sqliteTemporaryRoot = path.join(samplerRoot, 'sqlite-temp');
    if (largeEvidenceRun) {
      yield* fs.makeDirectory(sqliteTemporaryRoot, {recursive: true});
      process.env.SQLITE_TMPDIR = sqliteTemporaryRoot;
    }
    const bootstrapExternalTelemetry = bootstrapSampler ? yield* bootstrapSampler.stop() : undefined;
    const coldStoragePeak = new SqliteStoragePeakTelemetry();
    yield* runCheckpoint?.mark('cold-index') ?? Effect.void;
    const coldPhase = yield* measureSampledBenchmarkIndex(
      largeEvidenceRun
        ? startExternalSampler(
            fs,
            path,
            samplerRoot,
            sqliteTemporaryRoot,
            benchmarkLayout.databasePath,
            benchmarkSamplerCheckpointPath(path, samplerRoot, options.outputPath, 'cold'),
            'cold',
          )
        : Effect.succeed(undefined),
      (timeline, sampler) =>
        indexer.index({
          cwd: prepared.repository,
          onProgress: progress =>
            observeIndexProgress(timeline, progress).pipe(
              Effect.andThen(sampler?.mark(progress) ?? Effect.void),
              Effect.andThen(observeSqliteStoragePeak(fs, coldStoragePeak, benchmarkLayout.databasePath)),
            ),
          threadnoteHome: prepared.home,
        }),
      observeSqliteStoragePeak(fs, coldStoragePeak, benchmarkLayout.databasePath),
    );
    const coldMeasurement = coldPhase.measurement;
    const coldExternalTelemetry = coldPhase.telemetry;
    const {
      finishedAt: coldFinished,
      processFinished: coldProcessFinished,
      processStarted: coldProcessStarted,
      result: cold,
      startedAt: coldStarted,
      timeline: coldTimeline,
    } = coldMeasurement;
    yield* runCheckpoint?.mark('hot-query-and-mutation') ?? Effect.void;
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
    const coldExternalQueryControls = prepared.externalControls
      ? yield* Effect.forEach(
          prepared.externalControls,
          control =>
            query
              .inspect({
                cwd: prepared.repository,
                operation: 'query',
                query: control.query,
                refresh: false,
                threadnoteHome: prepared.home,
              })
              .pipe(
                Effect.map(result => ({
                  ...assertExternalQueryPositiveControl(result, {
                    expectedLanguage: control.expectedLanguage,
                    expectedPath: control.expectedPath,
                    expectedSnapshotId: cold.snapshot.id,
                    phase: 'cold',
                  }),
                  language: control.expectedLanguage,
                })),
              ),
          {concurrency: 1},
        )
      : [];
    const coldPrimaryQueryEvidence =
      coldExternalQueryControls[0] ??
      assertPrimaryQueryPositiveControl(
        yield* query.inspect({
          cwd: prepared.repository,
          operation: 'query',
          query: queryText,
          refresh: false,
          threadnoteHome: prepared.home,
        }),
        cold.snapshot.id,
        'cold',
      );

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
    const originalChangedBytes = yield* fs.readFile(changedPath);
    const originalChangedSource = decodeBenchmarkSource(originalChangedBytes);
    const benchmarkChangedSource = semanticBenchmarkOverlay(changedPath, originalChangedSource);
    const benchmarkChangedBytes = new TextEncoder().encode(benchmarkChangedSource);
    const incrementalStoragePeak = new SqliteStoragePeakTelemetry();
    const incrementalPhase = yield* Effect.acquireUseRelease(
      applyBenchmarkOverlay(fs, changedPath, originalChangedBytes, benchmarkChangedBytes),
      () =>
        Effect.gen(function* () {
          yield* runCheckpoint?.mark('incremental-index') ?? Effect.void;
          return yield* measureSampledBenchmarkIndex(
            largeEvidenceRun
              ? startExternalSampler(
                  fs,
                  path,
                  samplerRoot,
                  sqliteTemporaryRoot,
                  benchmarkLayout.databasePath,
                  benchmarkSamplerCheckpointPath(path, samplerRoot, options.outputPath, 'incremental'),
                  'incremental',
                )
              : Effect.succeed(undefined),
            (timeline, sampler) =>
              indexer.index({
                cwd: prepared.repository,
                onProgress: progress =>
                  observeIndexProgress(timeline, progress).pipe(
                    Effect.andThen(sampler?.mark(progress) ?? Effect.void),
                    Effect.andThen(observeSqliteStoragePeak(fs, incrementalStoragePeak, benchmarkLayout.databasePath)),
                  ),
                threadnoteHome: prepared.home,
              }),
            observeSqliteStoragePeak(fs, incrementalStoragePeak, benchmarkLayout.databasePath),
          );
        }),
      () => restoreBenchmarkOverlay(fs, changedPath, benchmarkChangedBytes, originalChangedBytes),
    );
    const incrementalMeasurement = incrementalPhase.measurement;
    const incrementalExternalTelemetry = incrementalPhase.telemetry;
    const {
      finishedAt: incrementalFinished,
      processFinished: incrementalProcessFinished,
      processStarted: incrementalProcessStarted,
      result: incremental,
      startedAt: incrementalStarted,
      timeline: incrementalTimeline,
    } = incrementalMeasurement;
    if (prepared.externalCommit) {
      yield* verifyExternalRepositoryUnchanged(prepared.repository, prepared.externalCommit);
    }
    yield* runCheckpoint?.mark('post-incremental-query-and-analysis') ?? Effect.void;
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
    const incrementalExternalQueryControls = prepared.externalControls
      ? yield* Effect.forEach(
          prepared.externalControls,
          control =>
            query
              .inspect({
                cwd: prepared.repository,
                operation: 'query',
                query: control.query,
                refresh: false,
                threadnoteHome: prepared.home,
              })
              .pipe(
                Effect.map(result => ({
                  ...assertExternalQueryPositiveControl(result, {
                    expectedLanguage: control.expectedLanguage,
                    expectedPath: control.expectedPath,
                    expectedSnapshotId: incremental.snapshot.id,
                    phase: 'incremental',
                  }),
                  language: control.expectedLanguage,
                })),
              ),
          {concurrency: 1},
        )
      : [];
    const incrementalPrimaryQueryEvidence =
      incrementalExternalQueryControls[0] ??
      assertPrimaryQueryPositiveControl(
        yield* query.inspect({
          cwd: prepared.repository,
          operation: 'query',
          query: queryText,
          refresh: false,
          threadnoteHome: prepared.home,
        }),
        incremental.snapshot.id,
        'incremental',
      );
    const mcpOperationMatrix = largeEvidenceRun
      ? yield* benchmarkMcpOperationMatrix(query, prepared.repository, prepared.home, queryText)
      : [];

    const sameOverlayReferenceHome =
      prepared.referenceHome ??
      (yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-graph-same-overlay-reference-'}));
    const sameOverlayReferenceIdentity = yield* resolveRepositoryIdentity(prepared.repository);
    const sameOverlayReferenceLayout = codeGraphLayout(
      path,
      sameOverlayReferenceHome,
      sameOverlayReferenceIdentity.checkoutId,
      sameOverlayReferenceIdentity.worktreeId,
    );
    const sameOverlaySamplerRoot = path.join(sameOverlayReferenceHome, 'benchmark-telemetry');
    const sameOverlaySqliteTemporaryRoot = path.join(sameOverlaySamplerRoot, 'sqlite-temp');
    if (largeEvidenceRun) yield* fs.makeDirectory(sameOverlaySqliteTemporaryRoot, {recursive: true});
    const sameOverlayReferenceStoragePeak = new SqliteStoragePeakTelemetry();
    const previousSqliteTemporaryRoot = process.env.SQLITE_TMPDIR;
    const sameOverlayReference = yield* Effect.sync(() => {
      if (largeEvidenceRun) process.env.SQLITE_TMPDIR = sameOverlaySqliteTemporaryRoot;
    }).pipe(
      Effect.andThen(
        Effect.acquireUseRelease(
          applyBenchmarkOverlay(fs, changedPath, originalChangedBytes, benchmarkChangedBytes),
          () =>
            Effect.gen(function* () {
              yield* runCheckpoint?.mark('same-overlay-reference-index') ?? Effect.void;
              const sampled = yield* measureSampledBenchmarkIndex(
                largeEvidenceRun
                  ? startExternalSampler(
                      fs,
                      path,
                      sameOverlaySamplerRoot,
                      sameOverlaySqliteTemporaryRoot,
                      sameOverlayReferenceLayout.databasePath,
                      benchmarkSamplerCheckpointPath(
                        path,
                        sameOverlaySamplerRoot,
                        options.outputPath,
                        'same-overlay-reference',
                      ),
                      'same-overlay-reference',
                    )
                  : Effect.succeed(undefined),
                (timeline, sampler) =>
                  indexer.index({
                    cwd: prepared.repository,
                    incrementalOverlay: false,
                    onProgress: progress =>
                      observeIndexProgress(timeline, progress).pipe(
                        Effect.andThen(sampler?.mark(progress) ?? Effect.void),
                        Effect.andThen(
                          observeSqliteStoragePeak(
                            fs,
                            sameOverlayReferenceStoragePeak,
                            sameOverlayReferenceLayout.databasePath,
                          ),
                        ),
                      ),
                    threadnoteHome: sameOverlayReferenceHome,
                  }),
                observeSqliteStoragePeak(fs, sameOverlayReferenceStoragePeak, sameOverlayReferenceLayout.databasePath),
              );
              const measurement = sampled.measurement;
              const summary = measurement.result;
              const controls = prepared.externalControls
                ? yield* Effect.forEach(
                    prepared.externalControls,
                    control =>
                      query
                        .inspect({
                          cwd: prepared.repository,
                          operation: 'query',
                          query: control.query,
                          refresh: false,
                          threadnoteHome: sameOverlayReferenceHome,
                        })
                        .pipe(
                          Effect.map(result => ({
                            ...assertExternalQueryPositiveControl(result, {
                              expectedLanguage: control.expectedLanguage,
                              expectedPath: control.expectedPath,
                              expectedSnapshotId: summary.snapshot.id,
                              phase: 'same-overlay-reference',
                            }),
                            language: control.expectedLanguage,
                          })),
                        ),
                    {concurrency: 1},
                  )
                : [];
              const primary =
                controls[0] ??
                assertPrimaryQueryPositiveControl(
                  yield* query.inspect({
                    cwd: prepared.repository,
                    operation: 'query',
                    query: queryText,
                    refresh: false,
                    threadnoteHome: sameOverlayReferenceHome,
                  }),
                  summary.snapshot.id,
                  'same-overlay-reference',
                );
              return {
                controls,
                indexFinished: measurement.finishedAt,
                measurement,
                primary,
                summary,
                telemetry: sampled.telemetry,
              };
            }),
          () => restoreBenchmarkOverlay(fs, changedPath, benchmarkChangedBytes, originalChangedBytes),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previousSqliteTemporaryRoot === undefined) delete process.env.SQLITE_TMPDIR;
          else process.env.SQLITE_TMPDIR = previousSqliteTemporaryRoot;
        }),
      ),
    );
    const sameOverlayReferenceStarted = sameOverlayReference.measurement.startedAt;
    const sameOverlayReferenceTimeline = sameOverlayReference.measurement.timeline;
    const sameOverlayReferenceTelemetry = sameOverlayReference.telemetry;
    if (sameOverlayReference.summary.materialization?.mode !== 'full') {
      return yield* Effect.fail(new Error('Same-overlay reference build did not execute a full materialization.'));
    }
    if (prepared.externalCommit) {
      yield* verifyExternalRepositoryUnchanged(prepared.repository, prepared.externalCommit);
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

    const statusSamples = Math.max(1, Math.min(options.samples, largeEvidenceRun ? 3 : 10));
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
    const sqliteVersion = sqliteVersionString(analysisStatus.databasePath);
    const coldStructuralGraphDigest = sqliteStructuralGraphDigest(analysisStatus.databasePath, cold.snapshot.id);
    const incrementalStructuralGraphDigest = sqliteStructuralGraphDigest(
      analysisStatus.databasePath,
      incremental.snapshot.id,
    );
    if (coldStructuralGraphDigest === incrementalStructuralGraphDigest) {
      return yield* Effect.fail(
        new Error('The semantic one-file overlay did not change the structural code graph digest.'),
      );
    }
    const sameOverlayReferenceStructuralGraphDigest = sqliteStructuralGraphDigest(
      sameOverlayReferenceLayout.databasePath,
      sameOverlayReference.summary.snapshot.id,
    );
    const coldLanguageCounts = sqliteLanguageCounts(analysisStatus.databasePath, cold.snapshot.id);
    const coldWorkspaceScopeRows = sqliteRowCount(
      analysisStatus.databasePath,
      'SELECT COUNT(*) AS count FROM workspace_scopes WHERE snapshot_id = ?',
      cold.snapshot.id,
    );
    const coldWorkspaceComponentRows = sqliteRowCount(
      analysisStatus.databasePath,
      'SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ?',
      cold.snapshot.id,
    );
    const coldBazelWorkspaceScopeRows = sqliteRowCount(
      analysisStatus.databasePath,
      "SELECT COUNT(*) AS count FROM workspace_scopes WHERE snapshot_id = ? AND build_system = 'bazel'",
      cold.snapshot.id,
    );
    const coldBazelWorkspaceComponentRows = sqliteRowCount(
      analysisStatus.databasePath,
      "SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ? AND build_system = 'bazel'",
      cold.snapshot.id,
    );
    const vectorRows = yield* vectorRowCount(fs, path, layout.vectorRoot);
    const coldCpu = cpuMilliseconds(coldProcessStarted, coldProcessFinished);
    const incrementalCpu = cpuMilliseconds(incrementalProcessStarted, incrementalProcessFinished);
    const coldMaterializationStorage = coldTimeline.materializationStorage();
    const incrementalMaterializationStorage = incrementalTimeline.materializationStorage();
    const sameOverlayReferenceMaterializationStorage = sameOverlayReferenceTimeline.materializationStorage();
    const [commit, dirty, hardware] = yield* Effect.all(
      [
        threadnoteSourceGit(threadnoteSourceRoot, ['rev-parse', 'HEAD']),
        threadnoteSourceGit(threadnoteSourceRoot, CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS),
        system.hardwareInfo(),
      ],
      {concurrency: 3},
    );
    const effectiveParserWorkers = parserWorkerCapacity({
      effectiveMemoryBytes: hardware.effectiveMemoryBytes,
      environment: system.environment(),
      hardwareConcurrency: navigator.hardwareConcurrency,
    });
    yield* runCheckpoint?.mark('finalizing-artifact') ?? Effect.void;
    const artifact: BenchmarkArtifactV1 = {
      createdAt: new Date().toISOString(),
      environment: {
        architecture: system.architecture,
        commit,
        cpu: hardware.cpuModel,
        dirty: dirty.length > 0,
        fixtureHash:
          prepared.fixtureIdentity !== undefined
            ? prepared.fixtureIdentity
            : prepared.profile !== undefined
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
        ...externalSamplerMeasurements('bootstrap', bootstrapExternalTelemetry),
        benchmarkMeasurement('cold-index', 'milliseconds', [
          Number(coldFinished - coldStarted) / NANOSECONDS_PER_MILLISECOND,
        ]),
        ...indexPhaseMeasurements('cold', coldTimeline, options.vectors),
        ...indexPhaseResourceMeasurements('cold', coldTimeline),
        ...externalSamplerMeasurements('cold', coldExternalTelemetry),
        benchmarkMeasurement('one-file-reindex-index', 'milliseconds', [
          Number(incrementalFinished - incrementalStarted) / NANOSECONDS_PER_MILLISECOND,
        ]),
        ...indexPhaseMeasurements('one-file-reindex', incrementalTimeline, options.vectors),
        ...indexPhaseResourceMeasurements('one-file-reindex', incrementalTimeline),
        ...externalSamplerMeasurements('one-file-reindex', incrementalExternalTelemetry),
        ...indexPhaseMeasurements('same-overlay-reference', sameOverlayReferenceTimeline, false),
        ...indexPhaseResourceMeasurements('same-overlay-reference', sameOverlayReferenceTimeline),
        ...externalSamplerMeasurements('same-overlay-reference', sameOverlayReferenceTelemetry),
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
        benchmarkMeasurement('same-overlay-reference-sqlite-main-peak-observed', 'bytes', [
          sameOverlayReferenceStoragePeak.sqliteMainBytes,
        ]),
        benchmarkMeasurement('same-overlay-reference-sqlite-wal-peak-observed', 'bytes', [
          sameOverlayReferenceStoragePeak.sqliteWalBytes,
        ]),
        benchmarkMeasurement('same-overlay-reference-sqlite-shm-peak-observed', 'bytes', [
          sameOverlayReferenceStoragePeak.sqliteShmBytes,
        ]),
        ...(coldExternalTelemetry
          ? [
              benchmarkMeasurement('cold-sqlite-temp-peak-observed', 'bytes', [
                externalTelemetryPeak(coldExternalTelemetry, 'temporaryPeakBytes'),
              ]),
            ]
          : []),
        ...(incrementalExternalTelemetry
          ? [
              benchmarkMeasurement('incremental-sqlite-temp-peak-observed', 'bytes', [
                externalTelemetryPeak(incrementalExternalTelemetry, 'temporaryPeakBytes'),
              ]),
            ]
          : []),
        benchmarkMeasurement('vector-index-disk', 'bytes', [storage.vectorBytes]),
        benchmarkMeasurement('build-status-sidecar-disk', 'bytes', [storage.buildStatusBytes]),
        benchmarkMeasurement('derived-index-unclassified-disk', 'bytes', [storage.unclassifiedRepositoryBytes]),
        benchmarkMeasurement('derived-index-disk', 'bytes', [storage.totalBytes]),
        benchmarkMeasurement('cold-lexical-term-rows', 'count', [coldLexicalTermRows]),
        benchmarkMeasurement('vector-rows', 'count', [vectorRows]),
        benchmarkMeasurement('cold-materialized-file-rows', 'count', [cold.snapshot.fileCount]),
        benchmarkMeasurement('cold-materialized-symbol-rows', 'count', [cold.snapshot.symbolCount]),
        benchmarkMeasurement('cold-materialized-edge-rows', 'count', [cold.snapshot.edgeCount]),
        benchmarkMeasurement('cold-materialized-lexical-term-rows', 'count', [coldLexicalTermRows]),
        benchmarkMeasurement('cold-language-category-count', 'count', [coldLanguageCounts.length]),
        ...languageAggregateMeasurements('cold', coldLanguageCounts),
        benchmarkMeasurement('cold-workspace-scope-rows', 'count', [coldWorkspaceScopeRows]),
        benchmarkMeasurement('cold-workspace-component-rows', 'count', [coldWorkspaceComponentRows]),
        benchmarkMeasurement('cold-bazel-workspace-scope-rows', 'count', [coldBazelWorkspaceScopeRows]),
        benchmarkMeasurement('cold-bazel-workspace-component-rows', 'count', [coldBazelWorkspaceComponentRows]),
        benchmarkMeasurement('one-file-reindex-materialization-staged-files', 'count', [
          incremental.materialization?.stagedFiles ?? 0,
        ]),
        benchmarkMeasurement('one-file-reindex-materialization-total-files', 'count', [
          incremental.materialization?.totalFiles ?? 0,
        ]),
        benchmarkMeasurement('cold-primary-query-returned-nodes', 'count', [coldPrimaryQueryEvidence.returnedNodes]),
        benchmarkMeasurement('one-file-reindex-primary-query-returned-nodes', 'count', [
          incrementalPrimaryQueryEvidence.returnedNodes,
        ]),
        benchmarkMeasurement('same-overlay-full-rebuild-index', 'milliseconds', [
          Number(sameOverlayReference.indexFinished - sameOverlayReferenceStarted) / NANOSECONDS_PER_MILLISECOND,
        ]),
        benchmarkMeasurement('same-overlay-full-rebuild-primary-query-returned-nodes', 'count', [
          sameOverlayReference.primary.returnedNodes,
        ]),
        benchmarkMeasurement('cold-to-incremental-primary-query-structural-parity', 'count', [
          coldPrimaryQueryEvidence.digest === incrementalPrimaryQueryEvidence.digest ? 1 : 0,
        ]),
        benchmarkMeasurement('primary-query-structural-parity', 'count', [
          incrementalPrimaryQueryEvidence.digest === sameOverlayReference.primary.digest ? 1 : 0,
        ]),
        benchmarkMeasurement('semantic-overlay-structural-graph-change', 'count', [
          coldStructuralGraphDigest === incrementalStructuralGraphDigest ? 0 : 1,
        ]),
        benchmarkMeasurement('structural-graph-digest-parity', 'count', [
          incrementalStructuralGraphDigest === sameOverlayReferenceStructuralGraphDigest ? 1 : 0,
        ]),
        ...externalQueryControlMeasurements('cold', coldExternalQueryControls),
        ...externalQueryControlMeasurements('incremental', incrementalExternalQueryControls),
        ...externalQueryControlMeasurements('same-overlay-reference', sameOverlayReference.controls),
        ...externalQueryControlParityMeasurements(incrementalExternalQueryControls, sameOverlayReference.controls),
        ...mcpOperationMatrixMeasurements(mcpOperationMatrix),
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
        activationMeasurement:
          'privacy-safe completed-stage duration and row counts; unobserved optional stages are retained as zero',
        coldEdges: cold.snapshot.edgeCount,
        coldFiles: cold.snapshot.fileCount,
        coldMaterializationStorageMode: coldMaterializationStorage?.materializationMode ?? 'unreported',
        coldSymbols: cold.snapshot.symbolCount,
        incrementalReusedFiles: incremental.reusedFiles,
        oneFileReindexMaterializationMode: incremental.materialization?.mode ?? 'unreported',
        oneFileReindexMaterializationStorageMode:
          incrementalMaterializationStorage?.materializationMode ?? 'unreported',
        oneFileReindexStagedFiles: incremental.materialization?.stagedFiles ?? 0,
        oneFileReindexTotalFiles: incremental.materialization?.totalFiles ?? 0,
        ...(incremental.materialization?.fallbackReason
          ? {oneFileReindexFallbackReason: incremental.materialization.fallbackReason}
          : {}),
        analysisSamples: analysisDurations.length,
        analysisCoverage: 'complete',
        coldIndexSamples: 1,
        cpuMeasurement: 'process.cpuUsage delta at operation boundary',
        effectiveParserMemoryBytes: hardware.effectiveMemoryBytes,
        effectiveParserWorkers,
        environmentOverrides: JSON.stringify(benchmarkEnvironmentProvenance()),
        diskMeasurement:
          'final bytes plus SQLite main/WAL/SHM peaks sampled at progress boundaries; vectors, sidecar, and unclassified bytes separate',
        incrementalIndexSamples: 1,
        materializationMeasurement:
          'aggregate phase duration, process CPU, boundary RSS, and row counts; no repository paths or source content',
        mcpOperationCount: mcpOperationMatrix.length,
        mcpOperationMeasurement:
          'query, node, neighbors, explain, impact, and path latency plus compact text/structured byte counts; no graph content retained',
        ...(coldMaterializationStorage?.estimateBasis
          ? {coldMaterializationEstimateBasis: coldMaterializationStorage.estimateBasis}
          : {}),
        materializationStorageEstimateMeasurement:
          'warning-only cached-fact planning split across actual SQLite TEMP and durable graph filesystems, including one concurrent-build allowance',
        languageAggregateMeasurement:
          'privacy-safe cold snapshot file and symbol row counts grouped only by normalized language category',
        observedBuildStatusRecords: observedStatusRecords,
        percentileInterpretation:
          'samples=1 is one observation; p50/p95/p99 fields are identical summaries, not percentile estimates',
        observationLabel:
          'Cold index, incremental index, and every per-phase measurement are n=1 observations, not statistical estimates.',
        phaseMeasurement: 'first progress transition and explicit subphase completion boundaries',
        primaryQueryStructuralDigestCold: coldPrimaryQueryEvidence.digest,
        primaryQueryStructuralDigestIncremental: incrementalPrimaryQueryEvidence.digest,
        primaryQueryStructuralDigestSameOverlayReference: sameOverlayReference.primary.digest,
        queries:
          options.repository !== undefined
            ? (prepared.externalControls?.length ?? 0)
            : options.scaleSymbols === undefined && prepared.profile === undefined
              ? fixture.queries.length
              : 1,
        retrievalMode: options.vectors ? 'pinned-production-vectors' : 'lexical-only',
        ...(largeEvidenceRun && releaseEvidenceSource
          ? {
              releaseEvidenceRef: releaseEvidenceSource.ref,
              releaseEvidenceResolvedSha: releaseEvidenceSource.resolvedSha,
              releaseEvidenceSha: releaseEvidenceSource.sha,
            }
          : {}),
        rssMeasurement:
          'boundary RSS plus process-lifetime resourceUsage.maxRSS; peak is cumulative, not phase-isolated',
        statusSamples,
        sqliteDurableStorageMeasurement:
          'SQLite durable database allocated-page high-water from direct materialization progress; WAL and SHM remain separately sampled filesystem artifacts',
        sqliteTemporaryStorageMeasurement:
          'SQLite TEMP database allocated-page high-water from materialization progress; excludes rollback journals and subjournals and remains separate from the filesystem sampler',
        sqliteVersion,
        structuralGraphDigestCold: coldStructuralGraphDigest,
        structuralGraphDigestIncremental: incrementalStructuralGraphDigest,
        structuralGraphDigestSameOverlayReference: sameOverlayReferenceStructuralGraphDigest,
        structuralGraphDigestMeasurement:
          'canonical SHA-256 over privacy-safe effective files, symbols, terms, lookup keys, edges, workspace, re-export, and analysis rows; incremental parity compares with an independent fresh-home full rebuild of the same overlay',
        sameOverlayReferenceMaterializationMode: sameOverlayReference.summary.materialization?.mode ?? 'unreported',
        sameOverlayReferenceMaterializationStorageMode:
          sameOverlayReferenceMaterializationStorage?.materializationMode ?? 'unreported',
        sameRunnerComparisonKey: benchmarkComparisonKey({
          architecture: system.architecture,
          cpu: hardware.cpuModel,
          memoryBytes: hardware.memoryBytes,
          operatingSystem: hardware.operatingSystem,
          runnerClass: benchmarkRunnerLabel('THREADNOTE_BENCHMARK_RUNNER_CLASS', 'local-unclassified'),
        }),
        runnerClass: benchmarkRunnerLabel('THREADNOTE_BENCHMARK_RUNNER_CLASS', 'local-unclassified'),
        runnerIdentity: benchmarkRunnerLabel('THREADNOTE_BENCHMARK_RUNNER_ID', 'local'),
        sampler: largeEvidenceRun
          ? externalSamplerDescription(coldExternalTelemetry ?? bootstrapExternalTelemetry)
          : 'progress-boundary storage sampling',
        vectorEnabled: options.vectors,
        vectorRows,
        ...(embeddingModelId ? {embeddingModelId} : {}),
        ...(options.scaleSymbols === undefined ? {} : {scaleSymbols: options.scaleSymbols}),
        ...(prepared.externalCommit
          ? {
              externalBenchmarkHomesRetained: options.retainHomes,
              externalControlCount: prepared.externalControls?.length ?? 0,
              externalControlLanguages:
                prepared.externalControls?.map(control => control.expectedLanguage).join(',') ?? '',
              externalQueryPositiveControl:
                'every cold and incremental control returned its expected tracked path and language; queries and paths omitted',
              externalRepositoryCommit: prepared.externalCommit,
              externalRepositoryMode: 'clean checkout with a byte-compared, scoped one-file overlay',
              externalSemanticOverlay:
                'language-aware import or dependency with effective-state digest change enforcement',
              externalWorkspaceAggregate:
                'cold total and Bazel workspace scope/component counts; repository names and roots omitted',
            }
          : {}),
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
      suite: prepared.externalCommit
        ? 'code-graph-external-repository-v1'
        : prepared.profile
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
    if (prepared.profile) {
      if (releaseEvidenceSource) {
        assertProductionReleaseEvidence(artifact);
      } else {
        assertProductionLargeEvidence(artifact);
      }
    }
    if (prepared.externalCommit) assertExternalRepositoryEvidence(artifact);
    if (options.failOnBudget) {
      const budgetPath = yield* path.fromFileUrl(
        new URL(`../test/evaluation/baselines/${options.fixture}/budgets.json`, import.meta.url),
      );
      enforceCodeGraphBenchmarkBudget(artifact, yield* readJsonFile(budgetPath), options.scaleSymbols);
    }
    if (prepared.externalCommit) {
      yield* verifyExternalRepositoryUnchanged(prepared.repository, prepared.externalCommit);
      yield* verifyBenchmarkSourceUnchanged(threadnoteSourceRoot, commit);
    }
    if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
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

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

export function decodeBenchmarkSource(source: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(source);
  } catch {
    throw new Error('The incremental benchmark source must be valid UTF-8 so it can be restored byte-for-byte.');
  }
}

export const applyBenchmarkOverlay = Effect.fn('benchmarkCodeGraph.applyOverlay')(function* (
  fs: FileSystem.FileSystem,
  file: string,
  expectedContents: Uint8Array,
  benchmarkContents: Uint8Array,
) {
  const current = yield* fs.readFile(file);
  if (!sameBytes(current, expectedContents)) {
    return yield* Effect.fail(
      new Error('The benchmark overlay file changed concurrently; Threadnote left the newer contents untouched.'),
    );
  }
  yield* fs.writeFile(file, benchmarkContents);
});

export const restoreBenchmarkOverlay = Effect.fn('benchmarkCodeGraph.restoreOverlay')(function* (
  fs: FileSystem.FileSystem,
  file: string,
  benchmarkContents: Uint8Array,
  originalContents: Uint8Array,
) {
  const current = yield* fs.readFile(file);
  if (!sameBytes(current, benchmarkContents)) {
    return yield* Effect.fail(
      new Error('The benchmark overlay file changed concurrently; Threadnote left the newer contents untouched.'),
    );
  }
  yield* fs.writeFile(file, originalContents);
});

/**
 * A benchmark overlay must change extracted graph structure, not only bytes.
 * Keep the import/dependency harmless, deterministic, and valid for the source
 * language. It changes graph evidence while preserving the file's symbol
 * resolution surface, so the benchmark exercises the real incremental path.
 */
export function semanticBenchmarkOverlay(filePath: string, source: string): string {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase();
  if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs)$/.test(normalized)) {
    return insertAfterInterpreter(source, "import 'threadnote-benchmark-overlay';");
  }
  if (/\.cjs$/.test(normalized)) return appendStatement(source, "require('threadnote-benchmark-overlay');");
  if (/\.(?:kt|kts)$/.test(normalized)) {
    return insertAfterPackage(source, 'import threadnote.benchmark.overlay');
  }
  if (/\.java$/.test(normalized)) {
    return insertAfterPackage(source, 'import threadnote.benchmark.Overlay;');
  }
  if (/\.swift$/.test(normalized)) return insertAfterInterpreter(source, 'import ThreadnoteBenchmarkOverlay');
  if (/\.go$/.test(normalized)) return insertAfterPackage(source, 'import _ "threadnote/benchmark/overlay"');
  if (/\.rs$/.test(normalized)) return insertAfterRustPreamble(source, 'use threadnote_benchmark_overlay as _;');
  if (/\.(?:c|cc|cpp|cxx|h|hh|hpp)$/.test(normalized)) {
    return insertAfterBom(source, '#include <threadnote_benchmark_overlay.h>');
  }
  if (/\.py$/.test(normalized)) return appendStatement(source, '__import__("threadnote_benchmark_overlay")');
  if (/(?:^|\/)(?:build(?:\.bazel)?|workspace(?:\.bazel)?|module\.bazel|[^/]+\.bzl)$/.test(normalized)) {
    return insertAfterBom(source, 'load("@threadnote_benchmark_overlay//:defs.bzl", "threadnote_benchmark_overlay")');
  }
  throw new Error('The incremental benchmark path must use a supported source language.');
}

function sourceNewline(source: string): '\n' | '\r\n' {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function appendStatement(source: string, statement: string): string {
  const newline = sourceNewline(source);
  return `${source}${source.endsWith('\n') ? '' : newline}${statement}${newline}`;
}

function insertAfterBom(source: string, statement: string): string {
  const newline = sourceNewline(source);
  const offset = source.startsWith('\uFEFF') ? 1 : 0;
  return `${source.slice(0, offset)}${statement}${newline}${source.slice(offset)}`;
}

function insertAfterInterpreter(source: string, statement: string): string {
  const bomOffset = source.startsWith('\uFEFF') ? 1 : 0;
  if (!source.startsWith('#!', bomOffset)) return insertAfterBom(source, statement);
  const lineEnd = source.indexOf('\n', bomOffset);
  if (lineEnd < 0) return `${source}${sourceNewline(source)}${statement}${sourceNewline(source)}`;
  return `${source.slice(0, lineEnd + 1)}${statement}${sourceNewline(source)}${source.slice(lineEnd + 1)}`;
}

function insertAfterPackage(source: string, statement: string): string {
  const packageLine = /^[\t ]*package(?:[\t ]+[^\r\n;]+;?)[\t ]*$/m.exec(source);
  if (!packageLine || packageLine.index === undefined) return insertAfterBom(source, statement);
  const lineEnd = source.indexOf('\n', packageLine.index + packageLine[0].length);
  const offset = lineEnd < 0 ? source.length : lineEnd + 1;
  const separator = lineEnd < 0 && !source.endsWith('\n') ? sourceNewline(source) : '';
  return `${source.slice(0, offset)}${separator}${statement}${sourceNewline(source)}${source.slice(offset)}`;
}

function insertAfterRustPreamble(source: string, statement: string): string {
  const newline = sourceNewline(source);
  const bomOffset = source.startsWith('\uFEFF') ? 1 : 0;
  let offset = bomOffset;
  for (const line of source.slice(bomOffset).split(/(?<=\n)/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#![') && !trimmed.startsWith('//!')) break;
    offset += line.length;
  }
  return `${source.slice(0, offset)}${statement}${newline}${source.slice(offset)}`;
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

export class IndexPhaseTimeline {
  readonly #activationStages = new Map<
    CodeGraphActivationActivity['stage'],
    {readonly durationMilliseconds: number; readonly rows: number}
  >();
  readonly #points = new Map<IndexPhasePoint, bigint>();
  readonly #resources = new Map<IndexPhasePoint, ProcessTelemetry>();
  #lastProgressAt: bigint;
  #maximumActivationTransactionMilliseconds = 0;
  #maximumProgressHeartbeatGapMilliseconds = 0;
  #materializationDeduplicatedEdges = 0;
  #materializationDeduplicatedReferences = 0;
  #materializationStorage: IndexMaterializationStorageEvidence | undefined;
  #sqliteDurableDatabaseHighWaterBytes = 0;
  #sqliteTemporaryDatabaseHighWaterBytes = 0;

  constructor(startedAt: bigint, telemetry: ProcessTelemetry) {
    this.#lastProgressAt = startedAt;
    this.#points.set('start', startedAt);
    this.#resources.set('start', telemetry);
  }

  observe(progress: CodeGraphProgress, at: bigint, telemetry: ProcessTelemetry): void {
    this.#observeHeartbeat(at);
    switch (progress.phase) {
      case 'registering':
        this.#first('registering:start', at, telemetry);
        break;
      case 'waiting':
        this.#first('waiting:start', at, telemetry);
        break;
      case 'scanning':
        this.#first('scanning:start', at, telemetry);
        if (progress.completed >= progress.total) this.#set('scanning:complete', at, telemetry);
        break;
      case 'materializing':
        this.#first('materializing:start', at, telemetry);
        this.#materializationDeduplicatedEdges = Math.max(
          this.#materializationDeduplicatedEdges,
          progress.metrics?.rows?.deduplicatedEdges ?? 0,
        );
        this.#materializationDeduplicatedReferences = Math.max(
          this.#materializationDeduplicatedReferences,
          progress.metrics?.rows?.deduplicatedReferences ?? 0,
        );
        if (progress.metrics?.storage) {
          this.#materializationStorage = {
            ...(progress.metrics.cachedFactBytesTotal === undefined
              ? {}
              : {cachedFactBytesTotal: progress.metrics.cachedFactBytesTotal}),
            ...(progress.metrics.factsBytesTotal === undefined
              ? {}
              : {finalFactBytesTotal: progress.metrics.factsBytesTotal}),
            durableAvailableBytes: progress.metrics.storage.durableAvailableBytes,
            durableDatabaseGrowthHighWaterBytes: progress.metrics.storage.durableDatabaseGrowthHighWaterBytes,
            durableFilesystemHighWaterBytes: progress.metrics.storage.durableFilesystemHighWaterBytes,
            durableJournalHighWaterBytes: progress.metrics.storage.durableJournalHighWaterBytes,
            durableWalHighWaterBytes: progress.metrics.storage.durableWalHighWaterBytes,
            estimateBasis: progress.metrics.storage.estimateBasis,
            estimatedDurableFilesystemRequiredBytes: progress.metrics.storage.estimatedDurableFilesystemRequiredBytes,
            estimatedTemporaryFilesystemRequiredBytes:
              progress.metrics.storage.estimatedTemporaryFilesystemRequiredBytes,
            filesystemsShared: progress.metrics.storage.filesystemsShared,
            materializationMode: progress.metrics.storage.materializationMode,
            temporaryAvailableBytes: progress.metrics.storage.temporaryAvailableBytes,
          };
        }
        this.#sqliteTemporaryDatabaseHighWaterBytes = Math.max(
          this.#sqliteTemporaryDatabaseHighWaterBytes,
          progress.metrics?.storage?.temporaryDatabaseHighWaterBytes ?? 0,
        );
        this.#sqliteDurableDatabaseHighWaterBytes = Math.max(
          this.#sqliteDurableDatabaseHighWaterBytes,
          progress.metrics?.storage?.durableDatabaseHighWaterBytes ?? 0,
        );
        if (progress.completed >= progress.total) this.#set('materializing:complete', at, telemetry);
        break;
      case 'resolving':
        if (progress.subphase === 'references') this.#first('resolving:references', at, telemetry);
        else this.#set('resolving:complete', at, telemetry);
        break;
      case 'activating':
        this.#maximumActivationTransactionMilliseconds = Math.max(
          this.#maximumActivationTransactionMilliseconds,
          progress.activity?.transactionMilliseconds ?? 0,
        );
        if (progress.activity?.state === 'completed') {
          this.#activationStages.set(progress.activity.stage, {
            durationMilliseconds: progress.activity.stageElapsedMilliseconds,
            rows: progress.activity.rows ?? 0,
          });
        }
        if (progress.subphase === 'validating-input') this.#first('activating:validating-input', at, telemetry);
        else if (progress.subphase === 'writing-and-checkpointing') {
          this.#first('activating:writing-and-checkpointing', at, telemetry);
        } else if (progress.subphase === 'promoting') this.#first('activating:promoting', at, telemetry);
        else if (progress.subphase === 'complete') this.#set('activating:complete', at, telemetry);
        break;
      case 'embedding':
        this.#first('embedding:start', at, telemetry);
        if (progress.completed >= progress.total) this.#set('embedding:complete', at, telemetry);
        break;
    }
  }

  finish(at: bigint, telemetry: ProcessTelemetry): void {
    this.#observeHeartbeat(at);
    this.#set('finish', at, telemetry);
  }

  duration(from: IndexPhasePoint, to: IndexPhasePoint, ...fallbackTo: readonly IndexPhasePoint[]): number {
    const start = this.#points.get(from);
    if (start === undefined) return 0;
    const end = [to, ...fallbackTo, 'finish' as const]
      .map(point => this.#points.get(point))
      .find((candidate): candidate is bigint => candidate !== undefined);
    return Math.max(0, Number((end ?? start) - start) / NANOSECONDS_PER_MILLISECOND);
  }

  resources(
    from: IndexPhasePoint,
    to: IndexPhasePoint,
    ...fallbackTo: readonly IndexPhasePoint[]
  ): {readonly cpuMilliseconds: number; readonly rssBoundaryPeakBytes: number} {
    const started = this.#resources.get(from);
    const finished = [to, ...fallbackTo, 'finish' as const]
      .map(point => this.#resources.get(point))
      .find((candidate): candidate is ProcessTelemetry => candidate !== undefined);
    if (!started || !finished) return {cpuMilliseconds: 0, rssBoundaryPeakBytes: 0};
    return {
      cpuMilliseconds: cpuMilliseconds(started, finished).total,
      rssBoundaryPeakBytes: Math.max(started.rssBytes, finished.rssBytes),
    };
  }

  activationStage(
    stage: CodeGraphActivationActivity['stage'],
  ): {readonly durationMilliseconds: number; readonly rows: number} | undefined {
    return this.#activationStages.get(stage);
  }

  activationStageCount(): number {
    return this.#activationStages.size;
  }

  maximumActivationTransactionMilliseconds(): number {
    return this.#maximumActivationTransactionMilliseconds;
  }

  maximumProgressHeartbeatGapMilliseconds(): number {
    return this.#maximumProgressHeartbeatGapMilliseconds;
  }

  materializationDeduplicatedEdges(): number {
    return this.#materializationDeduplicatedEdges;
  }

  materializationDeduplicatedReferences(): number {
    return this.#materializationDeduplicatedReferences;
  }

  materializationStorage(): IndexMaterializationStorageEvidence | undefined {
    return this.#materializationStorage;
  }

  sqliteTemporaryDatabaseHighWaterBytes(): number {
    return this.#sqliteTemporaryDatabaseHighWaterBytes;
  }

  sqliteDurableDatabaseHighWaterBytes(): number {
    return this.#sqliteDurableDatabaseHighWaterBytes;
  }

  #first(point: IndexPhasePoint, at: bigint, telemetry: ProcessTelemetry): void {
    if (!this.#points.has(point)) this.#set(point, at, telemetry);
  }

  #observeHeartbeat(at: bigint): void {
    this.#maximumProgressHeartbeatGapMilliseconds = Math.max(
      this.#maximumProgressHeartbeatGapMilliseconds,
      Math.max(0, Number(at - this.#lastProgressAt) / NANOSECONDS_PER_MILLISECOND),
    );
    this.#lastProgressAt = at;
  }

  #set(point: IndexPhasePoint, at: bigint, telemetry: ProcessTelemetry): void {
    this.#points.set(point, at);
    this.#resources.set(point, telemetry);
  }
}

export interface BenchmarkIndexMeasurement<A> {
  readonly finishedAt: bigint;
  readonly processFinished: ProcessTelemetry;
  readonly processStarted: ProcessTelemetry;
  readonly result: A;
  readonly startedAt: bigint;
  readonly timeline: IndexPhaseTimeline;
}

export interface BenchmarkIndexSamplerHandle {
  readonly mark: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly stop: (state?: 'aborted' | 'complete') => Effect.Effect<CodeGraphBenchmarkSamplerArtifact, unknown>;
}

export interface SampledBenchmarkIndexMeasurement<A> {
  readonly measurement: BenchmarkIndexMeasurement<A>;
  readonly telemetry?: CodeGraphBenchmarkSamplerArtifact;
}

export function measureBenchmarkIndex<A, E, R>(
  run: (timeline: IndexPhaseTimeline) => Effect.Effect<A, E, R>,
): Effect.Effect<BenchmarkIndexMeasurement<A>, E, R> {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeNanos;
    const processStarted = processTelemetry();
    const timeline = new IndexPhaseTimeline(startedAt, processStarted);
    const result = yield* run(timeline);
    const finishedAt = yield* Clock.currentTimeNanos;
    const processFinished = processTelemetry();
    timeline.finish(finishedAt, processFinished);
    return {finishedAt, processFinished, processStarted, result, startedAt, timeline};
  });
}

/**
 * Starts external observation only after all phase setup is complete, then
 * stops it after the final index-boundary storage sample. The scoped release
 * still aborts the sampler on interruption before an enclosing overlay scope
 * restores source bytes.
 */
export function measureSampledBenchmarkIndex<A>(
  startSampler: Effect.Effect<BenchmarkIndexSamplerHandle | undefined, unknown>,
  run: (timeline: IndexPhaseTimeline, sampler: BenchmarkIndexSamplerHandle | undefined) => Effect.Effect<A, unknown>,
  observeFinalStorage: Effect.Effect<void, unknown>,
): Effect.Effect<SampledBenchmarkIndexMeasurement<A>, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      let stopped = false;
      const sampler = yield* Effect.acquireRelease(startSampler, (handle, exit) =>
        handle && !stopped
          ? handle.stop(Exit.isSuccess(exit) ? 'complete' : 'aborted').pipe(Effect.ignore)
          : Effect.void,
      );
      const measurement = yield* measureBenchmarkIndex(timeline => run(timeline, sampler));
      yield* observeFinalStorage;
      const telemetry = sampler ? yield* sampler.stop('complete') : undefined;
      stopped = true;
      return {measurement, ...(telemetry ? {telemetry} : {})};
    }),
  );
}

export interface IndexMaterializationStorageEvidence {
  readonly cachedFactBytesTotal?: number;
  readonly finalFactBytesTotal?: number;
  readonly durableAvailableBytes?: number;
  readonly durableDatabaseGrowthHighWaterBytes?: number;
  readonly durableFilesystemHighWaterBytes?: number;
  readonly durableJournalHighWaterBytes?: number;
  readonly durableWalHighWaterBytes?: number;
  readonly estimateBasis?: 'cached-fact-bytes' | 'final-fact-bytes' | 'source-bytes-fallback';
  readonly estimatedDurableFilesystemRequiredBytes?: number;
  readonly estimatedTemporaryFilesystemRequiredBytes?: number;
  readonly filesystemsShared?: boolean;
  readonly materializationMode?: 'direct-persistent' | 'temporary-staged';
  readonly temporaryAvailableBytes?: number;
}

function observeIndexProgress(timeline: IndexPhaseTimeline, progress: CodeGraphProgress): Effect.Effect<void> {
  return Clock.currentTimeNanos.pipe(
    Effect.tap(at => Effect.sync(() => timeline.observe(progress, at, processTelemetry()))),
  );
}

function indexPhaseMeasurements(
  prefix: 'cold' | 'one-file-reindex' | 'same-overlay-reference',
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
    benchmarkMeasurement(`${prefix}-sqlite-temp-database-pages-high-water-n1`, 'bytes', [
      timeline.sqliteTemporaryDatabaseHighWaterBytes(),
    ]),
    benchmarkMeasurement(`${prefix}-sqlite-durable-database-pages-high-water-n1`, 'bytes', [
      timeline.sqliteDurableDatabaseHighWaterBytes(),
    ]),
    benchmarkMeasurement(`${prefix}-materialization-deduplicated-edge-rows-n1`, 'count', [
      timeline.materializationDeduplicatedEdges(),
    ]),
    benchmarkMeasurement(`${prefix}-materialization-deduplicated-reference-rows-n1`, 'count', [
      timeline.materializationDeduplicatedReferences(),
    ]),
    ...materializationStorageMeasurements(prefix, timeline.materializationStorage()),
    ...activationStageMeasurements(prefix, timeline),
  ];
}

export function materializationStorageMeasurements(
  prefix: 'cold' | 'one-file-reindex' | 'same-overlay-reference',
  storage: IndexMaterializationStorageEvidence | undefined,
): ReturnType<typeof benchmarkMeasurement>[] {
  if (!storage) return [];
  const measurements: ReturnType<typeof benchmarkMeasurement>[] = [];
  const add = (name: string, unit: 'bytes' | 'count', value: number | undefined) => {
    if (value !== undefined) measurements.push(benchmarkMeasurement(`${prefix}-${name}`, unit, [value]));
  };
  add('materialization-cached-fact-bytes-total-n1', 'bytes', storage.cachedFactBytesTotal);
  add('materialization-final-fact-bytes-total-n1', 'bytes', storage.finalFactBytesTotal);
  add(
    'materialization-estimated-temp-filesystem-required-n1',
    'bytes',
    storage.estimatedTemporaryFilesystemRequiredBytes,
  );
  add(
    'materialization-estimated-durable-filesystem-required-n1',
    'bytes',
    storage.estimatedDurableFilesystemRequiredBytes,
  );
  add('materialization-temp-filesystem-available-n1', 'bytes', storage.temporaryAvailableBytes);
  add('materialization-durable-filesystem-available-n1', 'bytes', storage.durableAvailableBytes);
  add(
    'materialization-filesystems-shared-n1',
    'count',
    storage.filesystemsShared === undefined ? undefined : storage.filesystemsShared ? 1 : 0,
  );
  return measurements;
}

function activationStageMeasurements(
  prefix: 'cold' | 'one-file-reindex' | 'same-overlay-reference',
  timeline: IndexPhaseTimeline,
): ReturnType<typeof benchmarkMeasurement>[] {
  return [
    benchmarkMeasurement(`${prefix}-activation-observed-stages-n1`, 'count', [timeline.activationStageCount()]),
    benchmarkMeasurement(`${prefix}-activation-longest-transaction-n1`, 'milliseconds', [
      timeline.maximumActivationTransactionMilliseconds(),
    ]),
    benchmarkMeasurement(`${prefix}-maximum-progress-heartbeat-gap-n1`, 'milliseconds', [
      timeline.maximumProgressHeartbeatGapMilliseconds(),
    ]),
    ...ACTIVATION_STAGES.flatMap(stage => {
      const observed = timeline.activationStage(stage);
      return [
        benchmarkMeasurement(`${prefix}-activation-${stage}-observed-n1`, 'count', [observed ? 1 : 0]),
        benchmarkMeasurement(`${prefix}-activation-${stage}-duration-n1`, 'milliseconds', [
          observed?.durationMilliseconds ?? 0,
        ]),
        benchmarkMeasurement(`${prefix}-activation-${stage}-rows-n1`, 'count', [observed?.rows ?? 0]),
      ];
    }),
  ];
}

function indexPhaseResourceMeasurements(
  prefix: 'cold' | 'one-file-reindex' | 'same-overlay-reference',
  timeline: IndexPhaseTimeline,
): ReturnType<typeof benchmarkMeasurement>[] {
  const phases = [
    ['registration', 'start', 'scanning:start', 'materializing:start'],
    ['inventory-and-extraction', 'scanning:start', 'scanning:complete', 'materializing:start'],
    ['materialization', 'materializing:start', 'resolving:references', 'activating:validating-input'],
    ['reference-resolution', 'resolving:references', 'resolving:complete', 'activating:validating-input'],
    ['activation', 'activating:validating-input', 'activating:complete', 'finish'],
    ['vector-index', 'embedding:start', 'embedding:complete', 'finish'],
  ] as const satisfies readonly (readonly [string, IndexPhasePoint, IndexPhasePoint, IndexPhasePoint])[];
  return phases.flatMap(([name, from, to, fallback]) => {
    const resources = timeline.resources(from, to, fallback);
    return [
      benchmarkMeasurement(`${prefix}-${name}-process-cpu-n1`, 'milliseconds', [resources.cpuMilliseconds]),
      benchmarkMeasurement(`${prefix}-${name}-boundary-rss-n1`, 'bytes', [resources.rssBoundaryPeakBytes]),
    ];
  });
}

export function externalSamplerMeasurements(
  prefix: 'bootstrap' | 'cold' | 'one-file-reindex' | 'same-overlay-reference',
  artifact: CodeGraphBenchmarkSamplerArtifact | undefined,
): ReturnType<typeof benchmarkMeasurement>[] {
  if (!artifact) return [];
  const phases = Object.entries(artifact.phases);
  const processTreeMeasurements =
    artifact.version >= 3 &&
    artifact.processTelemetry.availability === 'available' &&
    artifact.processTelemetry.scope === 'recursive-process-tree'
      ? [
          benchmarkMeasurement(`${prefix}-external-process-tree-samples-n1`, 'count', [
            boundedPhaseTotal(phases, sample => sample.processSamples ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-process-tree-attempts-n1`, 'count', [
            boundedPhaseTotal(phases, sample => sample.processSampleAttempts ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-process-tree-failures-n1`, 'count', [
            boundedPhaseTotal(phases, sample => sample.processSampleFailures ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-process-tree-maximum-sample-gap-n1`, 'milliseconds', [
            Math.max(0, ...phases.map(([, sample]) => sample.processSampleGapPeakMilliseconds ?? 0)),
          ]),
          benchmarkMeasurement(`${prefix}-external-process-count-peak-observed-n1`, 'count', [
            Math.max(0, ...phases.map(([, sample]) => sample.processPeakCount ?? 0)),
          ]),
          benchmarkMeasurement(`${prefix}-external-process-cpu-n1`, 'milliseconds', [
            boundedPhaseTotal(phases, sample => sample.cpuMilliseconds ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-rss-peak-observed-n1`, 'bytes', [
            Math.max(0, ...phases.map(([, sample]) => sample.rssPeakBytes ?? 0)),
          ]),
          ...(artifact.processTelemetry.ioCounters === 'linux-proc-read-write-bytes'
            ? [
                benchmarkMeasurement(`${prefix}-external-process-physical-read-n1`, 'bytes', [
                  boundedPhaseTotal(phases, sample => sample.ioReadBytes ?? 0),
                ]),
                benchmarkMeasurement(`${prefix}-external-process-physical-write-n1`, 'bytes', [
                  boundedPhaseTotal(phases, sample => sample.ioWriteBytes ?? 0),
                ]),
              ]
            : []),
        ]
      : [];
  const openTemporaryFileMeasurements =
    artifact.version >= 4 && artifact.temporaryTelemetry?.availability === 'available'
      ? [
          benchmarkMeasurement(`${prefix}-external-open-temp-process-tree-attempts-n1`, 'count', [
            boundedPhaseTotal(phases, sample => sample.temporaryOpenAttempts ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-open-temp-process-tree-failures-n1`, 'count', [
            boundedPhaseTotal(phases, sample => sample.temporaryOpenFailures ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-open-temp-process-tree-samples-n1`, 'count', [
            boundedPhaseTotal(phases, sample => sample.temporaryOpenSamples ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-sqlite-temp-combined-peak-observed-n1`, 'bytes', [
            Math.max(0, ...phases.map(([, sample]) => sample.temporaryPeakBytes)),
          ]),
          benchmarkMeasurement(`${prefix}-external-sqlite-temp-linked-peak-observed-n1`, 'bytes', [
            Math.max(0, ...phases.map(([, sample]) => sample.temporaryLinkedPeakBytes ?? 0)),
          ]),
          benchmarkMeasurement(`${prefix}-external-sqlite-temp-open-process-tree-peak-observed-n1`, 'bytes', [
            Math.max(0, ...phases.map(([, sample]) => sample.temporaryOpenPeakBytes ?? 0)),
          ]),
        ]
      : [];
  return [
    benchmarkMeasurement(`${prefix}-external-sampler-version-n1`, 'count', [artifact.version]),
    benchmarkMeasurement(`${prefix}-external-storage-samples-n1`, 'count', [artifact.samples]),
    ...processTreeMeasurements,
    ...openTemporaryFileMeasurements,
    ...phases.flatMap(([phase, sample]) => {
      const name =
        phase
          .replace(/[^a-z0-9]+/gi, '-')
          .replace(/^-|-$/g, '')
          .toLowerCase() || 'unknown';
      const processMeasurements =
        artifact.processTelemetry.availability === 'available' &&
        sample.cpuMilliseconds !== undefined &&
        sample.rssPeakBytes !== undefined
          ? [
              benchmarkMeasurement(`${prefix}-${name}-external-process-cpu-n1`, 'milliseconds', [
                sample.cpuMilliseconds,
              ]),
              benchmarkMeasurement(`${prefix}-${name}-external-rss-peak-observed-n1`, 'bytes', [sample.rssPeakBytes]),
              ...(sample.processPeakCount === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-count-peak-observed-n1`, 'count', [
                      sample.processPeakCount,
                    ]),
                  ]),
              ...(sample.processSamples === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-samples-n1`, 'count', [
                      sample.processSamples,
                    ]),
                  ]),
              ...(sample.processSampleAttempts === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-attempts-n1`, 'count', [
                      sample.processSampleAttempts,
                    ]),
                  ]),
              ...(sample.processSampleFailures === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-failures-n1`, 'count', [
                      sample.processSampleFailures,
                    ]),
                  ]),
              ...(sample.processSampleGapPeakMilliseconds === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-maximum-sample-gap-n1`, 'milliseconds', [
                      sample.processSampleGapPeakMilliseconds,
                    ]),
                  ]),
              ...(sample.ioReadBytes === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-physical-read-n1`, 'bytes', [
                      sample.ioReadBytes,
                    ]),
                  ]),
              ...(sample.ioWriteBytes === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-physical-write-n1`, 'bytes', [
                      sample.ioWriteBytes,
                    ]),
                  ]),
            ]
          : [];
      return [
        ...processMeasurements,
        benchmarkMeasurement(`${prefix}-${name}-sqlite-main-peak-observed-n1`, 'bytes', [sample.databasePeakBytes]),
        benchmarkMeasurement(`${prefix}-${name}-sqlite-wal-peak-observed-n1`, 'bytes', [sample.walPeakBytes]),
        benchmarkMeasurement(`${prefix}-${name}-sqlite-shm-peak-observed-n1`, 'bytes', [sample.shmPeakBytes]),
        benchmarkMeasurement(`${prefix}-${name}-sqlite-temp-peak-observed-n1`, 'bytes', [sample.temporaryPeakBytes]),
        ...(sample.temporaryLinkedPeakBytes === undefined
          ? []
          : [
              benchmarkMeasurement(`${prefix}-${name}-sqlite-temp-linked-peak-observed-n1`, 'bytes', [
                sample.temporaryLinkedPeakBytes,
              ]),
            ]),
        ...(sample.temporaryOpenPeakBytes === undefined
          ? []
          : [
              benchmarkMeasurement(`${prefix}-${name}-sqlite-temp-open-process-tree-peak-observed-n1`, 'bytes', [
                sample.temporaryOpenPeakBytes,
              ]),
            ]),
      ];
    }),
  ];
}

function boundedPhaseTotal(
  phases: readonly (readonly [string, CodeGraphBenchmarkSamplerArtifact['phases'][string]])[],
  value: (sample: CodeGraphBenchmarkSamplerArtifact['phases'][string]) => number,
): number {
  return phases.reduce((total, [, sample]) => Math.min(Number.MAX_SAFE_INTEGER, total + value(sample)), 0);
}

function externalTelemetryPeak(
  artifact: CodeGraphBenchmarkSamplerArtifact,
  field: 'databasePeakBytes' | 'shmPeakBytes' | 'temporaryPeakBytes' | 'walPeakBytes',
): number {
  return Math.max(0, ...Object.values(artifact.phases).map(phase => phase[field]));
}

function externalSamplerDescription(artifact: CodeGraphBenchmarkSamplerArtifact | undefined): string {
  const storage =
    artifact?.temporaryTelemetry?.availability === 'available'
      ? `DB/WAL/SHM plus deduplicated linked temp-root and process-tree open SQLite scratch bytes sampled at ` +
        `${artifact.temporaryTelemetry.openFileSampleIntervalMilliseconds}ms with aggregate attempt/failure accounting; ` +
        `no paths retained`
      : 'DB/WAL/SHM and linked isolated SQLite temp-root bytes';
  if (!artifact) return `external 25ms sampler; process telemetry unavailable; ${storage}`;
  return artifact.processTelemetry.availability === 'available'
    ? artifact.processTelemetry.scope === 'recursive-process-tree'
      ? `external 25ms storage sampler; ${artifact.processTelemetry.source} observer-excluded recursive process-tree CPU/RSS ` +
        `at ${artifact.processTelemetry.sampleIntervalMilliseconds}ms with start-time identity validation` +
        `${artifact.processTelemetry.ioCounters ? ' and physical I/O counters' : ''}; ${storage}`
      : `external 25ms sampler; Linux /proc parent CPU/RSS with start-time identity validation; ${storage}`
    : `external 25ms sampler; process CPU/RSS unavailable on ${artifact.platform} ` +
        `(${artifact.processTelemetry.reason}); ${storage}`;
}

export interface ProcessTelemetry {
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

interface ExternalSamplerHandle {
  readonly mark: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly markPhase: (phase: string) => Effect.Effect<void, unknown>;
  readonly stop: (state?: 'aborted' | 'complete') => Effect.Effect<CodeGraphBenchmarkSamplerArtifact, Error | unknown>;
}

export function parseCodeGraphBenchmarkRunCheckpoint(value: unknown): CodeGraphBenchmarkRunCheckpoint {
  if (typeof value !== 'object' || value === null) throw new Error('Benchmark run checkpoint must be an object.');
  const checkpoint = value as Partial<CodeGraphBenchmarkRunCheckpoint>;
  if (
    checkpoint.version !== 1 ||
    !['complete', 'failed', 'running'].includes(checkpoint.state ?? '') ||
    typeof checkpoint.phase !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(checkpoint.phase) ||
    typeof checkpoint.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(checkpoint.updatedAt))
  ) {
    throw new Error('Benchmark run checkpoint is invalid.');
  }
  return checkpoint as CodeGraphBenchmarkRunCheckpoint;
}

const makeBenchmarkRunCheckpoint = Effect.fn('benchmarkCodeGraph.makeRunCheckpoint')(function* (outputPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const write = (phase: string, state: CodeGraphBenchmarkRunCheckpoint['state']) => {
    const checkpoint = parseCodeGraphBenchmarkRunCheckpoint({
      phase,
      state,
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    return atomicWrite(outputPath, `${JSON.stringify(checkpoint)}\n`).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SystemInfo, system),
    );
  };
  yield* write('preparing-fixture', 'running');
  return {
    finish: state => write('finished', state).pipe(Effect.catch(() => Effect.void)),
    mark: phase => write(phase, 'running'),
  } satisfies CodeGraphBenchmarkRunCheckpointHandle;
});

function benchmarkSamplerCheckpointPath(
  path: Path.Path,
  samplerRoot: string,
  outputPath: string | undefined,
  name: 'bootstrap' | 'cold' | 'incremental' | 'same-overlay-reference',
): string {
  return outputPath ? `${outputPath}.${name}.sampler.json` : path.join(samplerRoot, `${name}.checkpoint.json`);
}

export const startExternalSampler = Effect.fn('benchmarkCodeGraph.startExternalSampler')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  samplerRoot: string,
  temporaryRoot: string,
  databasePath: string,
  checkpointPath: string,
  name: 'bootstrap' | 'cold' | 'incremental' | 'same-overlay-reference',
) {
  yield* fs.makeDirectory(samplerRoot, {recursive: true});
  const phasePath = path.join(samplerRoot, `${name}.phase`);
  const stopPath = path.join(samplerRoot, `${name}.stop`);
  const outputPath = path.join(samplerRoot, `${name}.json`);
  const readyPath = path.join(samplerRoot, `${name}.ready`);
  yield* Effect.all(
    [
      fs.remove(stopPath, {force: true}),
      fs.remove(outputPath, {force: true}),
      fs.remove(readyPath, {force: true}),
      fs.remove(checkpointPath, {force: true}),
      fs.writeFileString(phasePath, name === 'bootstrap' ? 'preparing-fixture' : 'start'),
    ],
    {concurrency: 3},
  );
  const samplerScript = yield* path.fromFileUrl(new URL('./code-graph-benchmark-sampler.ts', import.meta.url));
  const subprocess = Bun.spawn({
    cmd: [
      process.execPath,
      samplerScript,
      '--pid',
      String(process.pid),
      '--database',
      databasePath,
      '--temp-root',
      temporaryRoot,
      '--phase',
      phasePath,
      '--stop',
      stopPath,
      '--output',
      outputPath,
      '--checkpoint-output',
      checkpointPath,
      '--interval-ms',
      '25',
      '--checkpoint-ms',
      '1000',
      '--ready',
      readyPath,
    ],
    stderr: 'pipe',
    stdout: 'ignore',
  });
  yield* waitForExternalSamplerReady(fs, readyPath, subprocess).pipe(
    Effect.onError(() => terminateExternalSampler(subprocess)),
  );
  let currentPhase = name === 'bootstrap' ? 'preparing-fixture' : 'start';
  let stopped = false;
  const markPhase = (phase: string) => {
    if (phase === currentPhase) return Effect.void;
    currentPhase = phase;
    return fs.writeFileString(phasePath, phase);
  };
  return {
    mark: progress => {
      const phase = `${progress.phase}:${'subphase' in progress && progress.subphase ? progress.subphase : 'progress'}`;
      return markPhase(phase);
    },
    markPhase,
    stop: (state = 'complete') =>
      Effect.gen(function* () {
        if (!stopped) {
          yield* fs.writeFileString(phasePath, 'finish').pipe(Effect.catch(() => Effect.void));
          const stopSignal = yield* Effect.exit(fs.writeFileString(stopPath, state));
          if (Exit.isFailure(stopSignal)) {
            yield* terminateExternalSampler(subprocess);
            return yield* Effect.fail(
              new Error('Could not signal the code graph benchmark sampler to stop; it was terminated.'),
            );
          }
          stopped = true;
        }
        let exitCode = yield* Effect.promise(() => subprocessExitWithin(subprocess, EXTERNAL_SAMPLER_STOP_TIMEOUT_MS));
        if (exitCode === undefined) {
          yield* terminateExternalSampler(subprocess);
          exitCode = yield* Effect.promise(() =>
            subprocessExitWithin(subprocess, EXTERNAL_SAMPLER_TERMINATE_TIMEOUT_MS),
          );
          return yield* Effect.fail(
            new Error(
              `Code graph benchmark sampler did not stop within ${EXTERNAL_SAMPLER_STOP_TIMEOUT_MS} ms; ` +
                `it was terminated${exitCode === undefined ? ' without confirming exit' : ''}.`,
            ),
          );
        }
        if (exitCode !== 0) {
          const stderr = subprocess.stderr ? yield* Effect.promise(() => new Response(subprocess.stderr).text()) : '';
          return yield* Effect.fail(
            new Error(`Code graph benchmark sampler exited with ${exitCode}: ${stderr.trim() || 'no diagnostic'}`),
          );
        }
        return parseCodeGraphBenchmarkSamplerArtifact(JSON.parse(yield* fs.readFileString(outputPath)));
      }),
  } satisfies ExternalSamplerHandle;
});

const waitForExternalSamplerReady = Effect.fn('benchmarkCodeGraph.waitForExternalSamplerReady')(function* (
  fs: FileSystem.FileSystem,
  readyPath: string,
  subprocess: ReturnType<typeof Bun.spawn>,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  while (!(yield* fs.exists(readyPath))) {
    if (subprocess.exitCode !== null) {
      return yield* Effect.fail(new Error(`Code graph benchmark sampler exited before becoming ready.`));
    }
    if ((yield* Clock.currentTimeMillis) - startedAt >= EXTERNAL_SAMPLER_READY_TIMEOUT_MS) {
      return yield* Effect.fail(
        new Error(`Code graph benchmark sampler was not ready within ${EXTERNAL_SAMPLER_READY_TIMEOUT_MS} ms.`),
      );
    }
    yield* Effect.sleep(10);
  }
});

const terminateExternalSampler = Effect.fn('benchmarkCodeGraph.terminateExternalSampler')(function* (
  subprocess: ReturnType<typeof Bun.spawn>,
) {
  if (subprocess.exitCode !== null) return;
  subprocess.kill();
  if (
    (yield* Effect.promise(() => subprocessExitWithin(subprocess, EXTERNAL_SAMPLER_TERMINATE_TIMEOUT_MS))) !== undefined
  ) {
    return;
  }
  subprocess.kill(9);
  yield* Effect.promise(() => subprocessExitWithin(subprocess, EXTERNAL_SAMPLER_TERMINATE_TIMEOUT_MS));
});

function subprocessExitWithin(
  subprocess: ReturnType<typeof Bun.spawn>,
  timeoutMilliseconds: number,
): Promise<number | undefined> {
  if (subprocess.exitCode !== null) return Promise.resolve(subprocess.exitCode);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), timeoutMilliseconds);
    timer.unref?.();
    void subprocess.exited.then(
      code => {
        clearTimeout(timer);
        resolve(code);
      },
      () => {
        clearTimeout(timer);
        resolve(-1);
      },
    );
  });
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

interface CodeGraphLanguageAggregate {
  readonly files: number;
  readonly language: string;
  readonly symbols: number;
}

function sqliteLanguageCounts(databasePath: string, snapshotId: string): readonly CodeGraphLanguageAggregate[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const files = sqliteGroupedLanguageCounts(
      database
        .query('SELECT language, COUNT(*) AS count FROM snapshot_files WHERE snapshot_id = ? GROUP BY language')
        .all(snapshotId),
    );
    const symbols = sqliteGroupedLanguageCounts(
      database
        .query('SELECT language, COUNT(*) AS count FROM symbols WHERE snapshot_id = ? GROUP BY language')
        .all(snapshotId),
    );
    return [...new Set([...files.keys(), ...symbols.keys()])]
      .sort()
      .map(language => ({files: files.get(language) ?? 0, language, symbols: symbols.get(language) ?? 0}));
  } finally {
    database.close(false);
  }
}

function sqliteGroupedLanguageCounts(rows: readonly unknown[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const value of rows) {
    const row = value as {readonly count?: bigint | number; readonly language?: string};
    const language = row.language ?? '';
    const count = Number(row.count ?? -1);
    if (!/^[a-z][a-z0-9-]*$/.test(language) || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('Code graph database returned an invalid privacy-safe language aggregate.');
    }
    counts.set(language, count);
  }
  return counts;
}

function sqliteVersionString(databasePath: string): string {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database.query('SELECT sqlite_version() AS version').get() as {readonly version?: string} | null;
    const version = row?.version ?? '';
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error('Code graph database returned an invalid SQLite version.');
    }
    return version;
  } finally {
    database.close(false);
  }
}

function sqliteStructuralGraphDigest(databasePath: string, snapshotId: string): string {
  const database = new Database(databasePath, {readonly: true, strict: true});
  const digest = new Bun.CryptoHasher('sha256');
  try {
    const snapshot = database
      .query('SELECT base_snapshot_id FROM snapshots WHERE id = ? AND state = ? LIMIT 1')
      .get(snapshotId, 'ready') as {readonly base_snapshot_id?: unknown} | null;
    if (!snapshot) throw new Error('Ready snapshot was unavailable for the structural graph digest.');
    const baseSnapshotId = typeof snapshot.base_snapshot_id === 'string' ? snapshot.base_snapshot_id : '';
    const effectiveParameters = [snapshotId, baseSnapshotId, snapshotId, snapshotId] as const;
    const streams = [
      {
        name: 'snapshot',
        parameters: [snapshotId],
        query: `SELECT commit_id, extractor_set, dirty, overlay_fingerprint,
            file_count, symbol_count, edge_count
          FROM snapshots WHERE id = ? AND state = 'ready'`,
      },
      {
        name: 'extractor-generation',
        parameters: [snapshotId],
        query: `SELECT generation FROM snapshot_extractor_generations
          WHERE snapshot_id = ?`,
      },
      {
        name: 'files',
        parameters: effectiveParameters,
        query: `${effectiveSnapshotRowsCte('snapshot_files', 'snapshot_file_deletions', 'path', 'path')}
          SELECT path, content_hash, language, mode, size, source
          FROM effective_rows ORDER BY path`,
      },
      {
        name: 'symbols',
        parameters: effectiveParameters,
        query: `${effectiveSnapshotRowsCte('symbols', 'snapshot_symbol_deletions', 'symbol_id', 'id')}
          SELECT id, content_hash, kind, name, qualified_name, path, language, arity, lookup_keys_json,
            resolution_domain, resolution_scope_id, package_name, exported, signature, documentation, span_json
          FROM effective_rows ORDER BY path, qualified_name, id`,
      },
      {
        name: 'symbol-terms',
        parameters: effectiveParameters,
        query: `WITH effective_rows AS (
          SELECT current_rows.term, current_rows.symbol_id, current_rows.weight
          FROM symbol_terms AS current_rows
          WHERE current_rows.snapshot_id = ?
          UNION ALL
          SELECT base_rows.term, base_rows.symbol_id, base_rows.weight
          FROM symbol_terms AS base_rows
          WHERE base_rows.snapshot_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM symbols AS overrides
              WHERE overrides.snapshot_id = ? AND overrides.id = base_rows.symbol_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM snapshot_symbol_deletions AS removed
              WHERE removed.snapshot_id = ? AND removed.symbol_id = base_rows.symbol_id
            )
        )
        SELECT term, symbol_id, weight FROM effective_rows ORDER BY term, symbol_id`,
      },
      {
        name: 'symbol-lookup',
        parameters: [snapshotId, baseSnapshotId, snapshotId, snapshotId, snapshotId],
        query: `WITH effective_rows AS (
          SELECT current_rows.lookup_key, current_rows.symbol_id, current_rows.resolution_domain,
            current_rows.exported, current_rows.provenance, current_rows.evidence_edge_id,
            current_rows.evidence_path
          FROM snapshot_symbol_lookup AS current_rows
          WHERE current_rows.snapshot_id = ?
          UNION ALL
          SELECT base_rows.lookup_key, base_rows.symbol_id, base_rows.resolution_domain,
            base_rows.exported, base_rows.provenance, base_rows.evidence_edge_id,
            base_rows.evidence_path
          FROM snapshot_symbol_lookup AS base_rows
          WHERE base_rows.snapshot_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM snapshot_symbol_lookup AS overrides
              WHERE overrides.snapshot_id = ?
                AND overrides.lookup_key = base_rows.lookup_key
                AND overrides.symbol_id = base_rows.symbol_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM snapshot_symbol_deletions AS removed
              WHERE removed.snapshot_id = ? AND removed.symbol_id = base_rows.symbol_id
            )
            AND (
              base_rows.evidence_path IS NULL OR NOT EXISTS (
                SELECT 1 FROM snapshot_files AS changed
                WHERE changed.snapshot_id = ? AND changed.path = base_rows.evidence_path
              )
            )
        )
        SELECT lookup_key, symbol_id, resolution_domain, exported, provenance,
          evidence_edge_id, evidence_path
        FROM effective_rows ORDER BY lookup_key, symbol_id`,
      },
      {
        name: 'edges',
        parameters: effectiveParameters,
        query: `${effectiveSnapshotRowsCte('edges', 'snapshot_edge_deletions', 'edge_id', 'id')}
          SELECT id, source_id, source_name, relation, target_id, target_name, provenance, confidence,
            evidence_path, evidence_span_json
          FROM effective_rows ORDER BY source_name, relation, target_name, id`,
      },
      {
        name: 'workspace-scopes',
        parameters: [snapshotId],
        query: `SELECT id, build_system, name, root, provenance, diagnostics_json
          FROM workspace_scopes WHERE snapshot_id = ? ORDER BY id`,
      },
      {
        name: 'workspace-components',
        parameters: [snapshotId],
        query: `SELECT id, workspace_id, build_system, kind, name, root, resolution_domain,
            languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
          FROM workspace_components WHERE snapshot_id = ? ORDER BY id`,
      },
      {
        name: 'workspace-component-dependencies',
        parameters: [snapshotId],
        query: `SELECT source_component_id, target_component_id, provenance, evidence
          FROM workspace_component_dependencies WHERE snapshot_id = ?
          ORDER BY source_component_id, target_component_id, provenance`,
      },
      {
        name: 'reexport-provenance',
        parameters: effectiveParameters,
        query: `WITH effective_rows AS (
          SELECT current_rows.source_path, current_rows.local_name,
            current_rows.target_path, current_rows.imported_name
          FROM snapshot_reexport_provenance AS current_rows
          WHERE current_rows.snapshot_id = ?
          UNION ALL
          SELECT base_rows.source_path, base_rows.local_name,
            base_rows.target_path, base_rows.imported_name
          FROM snapshot_reexport_provenance AS base_rows
          WHERE base_rows.snapshot_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM snapshot_reexport_provenance AS overrides
              WHERE overrides.snapshot_id = ?
                AND overrides.source_path = base_rows.source_path
                AND overrides.local_name = base_rows.local_name
                AND overrides.target_path = base_rows.target_path
                AND overrides.imported_name = base_rows.imported_name
            )
            AND NOT EXISTS (
              SELECT 1 FROM snapshot_files AS changed
              WHERE changed.snapshot_id = ? AND changed.path = base_rows.source_path
            )
        )
        SELECT source_path, local_name, target_path, imported_name
        FROM effective_rows ORDER BY source_path, local_name, target_path, imported_name`,
      },
      {
        name: 'analysis-symbol-counts',
        parameters: [snapshotId],
        query: `SELECT language, kind, count FROM snapshot_analysis_symbol_counts
          WHERE snapshot_id = ? ORDER BY language, kind`,
      },
      {
        name: 'analysis-edge-histogram',
        parameters: [snapshotId],
        query: `SELECT provenance, relation, confidence, endpoint_state, count
          FROM snapshot_analysis_edge_histogram WHERE snapshot_id = ?
          ORDER BY provenance, relation, confidence, endpoint_state`,
      },
      {
        name: 'analysis-edge-counts',
        parameters: [snapshotId],
        query: `SELECT provenance, relation, count, confidence_invalid, confidence_total,
            lowest_confidence, confidence_high, confidence_medium, confidence_low,
            unresolved_endpoint_count, self_loop_count, review_finding_count
          FROM snapshot_analysis_edge_counts WHERE snapshot_id = ?
          ORDER BY provenance, relation`,
      },
      {
        name: 'analysis-summary-receipt',
        parameters: [snapshotId],
        query: `SELECT version, symbol_count, edge_count, digest
          FROM snapshot_analysis_summary_receipts WHERE snapshot_id = ?`,
      },
    ] as const;
    for (const stream of streams) {
      digest.update(`${stream.name}\0`);
      const statement = database.query(stream.query);
      for (const row of statement.iterate(...stream.parameters)) {
        digest.update(JSON.stringify(row, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)));
        digest.update('\n');
      }
    }
    return digest.digest('hex');
  } finally {
    database.close(false);
  }
}

function effectiveSnapshotRowsCte(
  table: 'edges' | 'snapshot_files' | 'symbols',
  deletions: 'snapshot_edge_deletions' | 'snapshot_file_deletions' | 'snapshot_symbol_deletions',
  deletionKey: 'edge_id' | 'path' | 'symbol_id',
  rowKey: 'id' | 'path',
): string {
  return `WITH effective_rows AS (
    SELECT current_rows.* FROM ${table} AS current_rows WHERE current_rows.snapshot_id = ?
    UNION ALL
    SELECT base_rows.* FROM ${table} AS base_rows
    WHERE base_rows.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM ${table} AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.${rowKey} = base_rows.${rowKey}
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${deletions} AS removed
        WHERE removed.snapshot_id = ? AND removed.${deletionKey} = base_rows.${rowKey}
      )
  )`;
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

function languageAggregateMeasurements(
  prefix: 'cold',
  aggregates: readonly CodeGraphLanguageAggregate[],
): ReturnType<typeof benchmarkMeasurement>[] {
  return aggregates.flatMap(aggregate => [
    benchmarkMeasurement(`${prefix}-materialized-file-rows-language-${aggregate.language}`, 'count', [aggregate.files]),
    benchmarkMeasurement(`${prefix}-materialized-symbol-rows-language-${aggregate.language}`, 'count', [
      aggregate.symbols,
    ]),
  ]);
}

interface McpOperationBenchmarkResult {
  readonly durationMilliseconds: number;
  readonly edges: number;
  readonly nodes: number;
  readonly operation: CodeGraphQueryResult['operation'];
  readonly structuredBytes: number;
  readonly textBytes: number;
  readonly truncated: boolean;
  readonly warnings: number;
}

interface BenchmarkCodeGraphQuery {
  readonly inspect: (options: CodeGraphInspectOptions) => Effect.Effect<CodeGraphQueryResult, unknown>;
}

const benchmarkMcpOperationMatrix = Effect.fn('benchmarkCodeGraph.mcpOperationMatrix')(function* (
  query: BenchmarkCodeGraphQuery,
  cwd: string,
  threadnoteHome: string,
  queryText: string,
) {
  const results: McpOperationBenchmarkResult[] = [];
  const execute = Effect.fn('benchmarkCodeGraph.mcpOperation')(function* (options: CodeGraphQueryOptionsForBenchmark) {
    const started = yield* Clock.currentTimeNanos;
    const result = yield* query
      .inspect({
        ...options,
        cwd,
        edgeLimit: 80,
        nodeLimit: 40,
        refresh: false,
        threadnoteHome,
      })
      .pipe(Effect.timeout(25_000));
    const response = codeGraphMcpResponse(result);
    const structuredBytes = encodedBytes(JSON.stringify(response.structuredContent));
    const textBytes = encodedBytes(response.text);
    if (structuredBytes > 24 * 1_024 || textBytes > 24 * 1_024) {
      return yield* Effect.fail(new Error(`MCP ${options.operation} output exceeded its 24 KiB per-part budget.`));
    }
    const finished = yield* Clock.currentTimeNanos;
    results.push({
      durationMilliseconds: Number(finished - started) / NANOSECONDS_PER_MILLISECOND,
      edges: response.structuredContent.edges.length,
      nodes: response.structuredContent.nodes.length,
      operation: options.operation,
      structuredBytes,
      textBytes,
      truncated: response.structuredContent.output.truncated,
      warnings: response.structuredContent.warnings.length,
    });
    return result;
  });

  const lexical = yield* execute({operation: 'query', query: queryText});
  const seed = lexical.nodes[0];
  if (!seed) return yield* Effect.fail(new Error('MCP operation matrix query returned no seed node.'));
  yield* execute({nodeId: seed.id, operation: 'node'});
  const neighbors = yield* execute({depth: 1, nodeId: seed.id, operation: 'neighbors'});
  yield* execute({operation: 'explain', symbol: seed.id});
  yield* execute({operation: 'impact', query: seed.id});
  const peer =
    neighbors.nodes.find(node => node.id !== seed.id)?.id ??
    neighbors.edges.find(edge => edge.sourceId === seed.id)?.targetId ??
    neighbors.edges.find(edge => edge.targetId === seed.id)?.sourceId ??
    seed.id;
  yield* execute({depth: 8, from: seed.id, operation: 'path', to: peer});
  return results;
});

type CodeGraphQueryOptionsForBenchmark = Omit<
  CodeGraphInspectOptions,
  'cwd' | 'edgeLimit' | 'nodeLimit' | 'refresh' | 'threadnoteHome'
>;

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function mcpOperationMatrixMeasurements(
  results: readonly McpOperationBenchmarkResult[],
): ReturnType<typeof benchmarkMeasurement>[] {
  return results.flatMap(result => [
    benchmarkMeasurement(`mcp-${result.operation}-duration`, 'milliseconds', [result.durationMilliseconds]),
    benchmarkMeasurement(`mcp-${result.operation}-structured-output`, 'bytes', [result.structuredBytes]),
    benchmarkMeasurement(`mcp-${result.operation}-text-output`, 'bytes', [result.textBytes]),
    benchmarkMeasurement(`mcp-${result.operation}-returned-nodes`, 'count', [result.nodes]),
    benchmarkMeasurement(`mcp-${result.operation}-returned-edges`, 'count', [result.edges]),
    benchmarkMeasurement(`mcp-${result.operation}-truncated`, 'count', [result.truncated ? 1 : 0]),
    benchmarkMeasurement(`mcp-${result.operation}-warnings`, 'count', [result.warnings]),
  ]);
}

interface ExternalQueryControlResult {
  readonly digest: string;
  readonly expectedMatches: number;
  readonly language: string;
  readonly returnedNodes: number;
}

function externalQueryControlMeasurements(
  phase: 'cold' | 'incremental' | 'same-overlay-reference',
  controls: readonly ExternalQueryControlResult[],
): ReturnType<typeof benchmarkMeasurement>[] {
  return controls.flatMap(control => [
    benchmarkMeasurement(`external-query-${phase}-${control.language}-returned-nodes`, 'count', [
      control.returnedNodes,
    ]),
    benchmarkMeasurement(`external-query-${phase}-${control.language}-expected-path-language-nodes`, 'count', [
      control.expectedMatches,
    ]),
  ]);
}

function externalQueryControlParityMeasurements(
  incremental: readonly ExternalQueryControlResult[],
  reference: readonly ExternalQueryControlResult[],
): ReturnType<typeof benchmarkMeasurement>[] {
  const referenceByLanguage = new Map(reference.map(control => [control.language, control]));
  return incremental.map(control =>
    benchmarkMeasurement(`external-query-${control.language}-same-overlay-structural-parity`, 'count', [
      referenceByLanguage.get(control.language)?.digest === control.digest ? 1 : 0,
    ]),
  );
}

function assertExternalQueryPositiveControl(
  result: CodeGraphQueryResult,
  expected: {
    readonly expectedLanguage: string;
    readonly expectedPath: string;
    readonly expectedSnapshotId: string;
    readonly phase: 'cold' | 'incremental' | 'same-overlay-reference';
  },
): {readonly digest: string; readonly expectedMatches: number; readonly returnedNodes: number} {
  const expectedMatches = result.nodes.filter(
    node => node.path === expected.expectedPath && node.language === expected.expectedLanguage,
  ).length;
  if (result.snapshot.id !== expected.expectedSnapshotId || result.nodes.length === 0 || expectedMatches === 0) {
    throw new Error(
      `External repository ${expected.phase} query did not resolve its expected tracked path and language; ` +
        'the query and path were omitted from this diagnostic.',
    );
  }
  return {digest: queryResultStructuralDigest(result), expectedMatches, returnedNodes: result.nodes.length};
}

function assertPrimaryQueryPositiveControl(
  result: CodeGraphQueryResult,
  expectedSnapshotId: string,
  phase: 'cold' | 'incremental' | 'same-overlay-reference',
): {readonly digest: string; readonly returnedNodes: number} {
  if (result.snapshot.id !== expectedSnapshotId || result.nodes.length === 0) {
    throw new Error(`Code graph ${phase} primary query returned no current-snapshot nodes.`);
  }
  return {digest: queryResultStructuralDigest(result), returnedNodes: result.nodes.length};
}

function queryResultStructuralDigest(result: CodeGraphQueryResult): string {
  const digest = new Bun.CryptoHasher('sha256');
  digest.update(
    JSON.stringify({
      edges: result.edges,
      nodes: result.nodes.map(({contentHash: _contentHash, ...node}) => node),
      operation: result.operation,
    }),
  );
  return digest.digest('hex');
}

export function assertProductionReleaseEvidence(artifact: BenchmarkArtifactV1): void {
  assertProductionLargeEvidence(artifact, true);
}

function assertProductionLargeEvidence(artifact: BenchmarkArtifactV1, requireReleaseSource = false): void {
  if (!artifact.suite.startsWith('code-graph-production-large-')) {
    throw new Error(`Production release evidence has the wrong suite: ${artifact.suite}.`);
  }
  const measurements = new Map(artifact.measurements.map(measurement => [measurement.name, measurement]));
  const missing = PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS.flatMap(required => {
    const measurement = measurements.get(required.name);
    return measurement?.unit === required.unit ? [] : [`${required.name} (${required.unit})`];
  });
  if (artifact.metadata.oneFileReindexMaterializationMode !== 'incremental-overlay') {
    missing.push('one-file reindex incremental-overlay materialization mode');
  }
  if (artifact.metadata.coldMaterializationStorageMode !== 'direct-persistent') {
    missing.push('cold direct-persistent materialization storage mode');
  }
  if (artifact.metadata.sameOverlayReferenceMaterializationMode !== 'full') {
    missing.push('same-overlay full rebuild materialization mode');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(artifact.metadata.sqliteVersion ?? ''))) {
    missing.push('SQLite version');
  }
  if (requireReleaseSource) {
    missing.push(...missingReleaseSourceProvenance(artifact));
    missing.push(...missingReviewedProductionProfile(artifact));
  }
  missing.push(...missingProductionShapeTargetAttainment(measurements, artifact));
  missing.push(...missingDeterministicParityEvidence(measurements));
  missing.push(...missingSamplerObservations(measurements));
  missing.push(...missingActivationObservations(artifact, measurements));
  if (missing.length > 0) {
    throw new Error(`Production release evidence is incomplete: ${missing.join(', ')}.`);
  }
}

function missingProductionShapeTargetAttainment(
  measurements: ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number]>,
  artifact: BenchmarkArtifactV1,
): readonly string[] {
  if (!isReviewedProductionProfile(artifact)) return [];
  return PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS.filter(required =>
    required.name.startsWith('production-shape-'),
  ).flatMap(required => {
    const measurement = measurements.get(required.name);
    if (!measurement || measurement.unit !== 'percent') return [];
    return measurement.minimum >= PRODUCTION_LARGE_TARGET_ATTAINMENT_MINIMUM_PERCENT
      ? []
      : [
          `${required.name} expected at least ` +
            `${PRODUCTION_LARGE_TARGET_ATTAINMENT_MINIMUM_PERCENT}% target attainment`,
        ];
  });
}

function isReviewedProductionProfile(artifact: BenchmarkArtifactV1): boolean {
  const expected = {
    profile: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.id,
    profileDeclarationSymbols: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.declarationSymbols,
    profileSourceFiles: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.sourceFiles,
    profileTargetEdges: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetGraphEdges,
    profileTargetEligibleFiles: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetEligibleFiles,
    profileTargetLexicalTermRows: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetLexicalTermRows,
    profileTargetSymbols: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetGraphSymbols,
    profileVersion: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.version,
    profileWorkspaces: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.workspaceCount,
  } as const;
  return Object.entries(expected).every(([name, value]) => artifact.metadata[name] === value);
}

function missingReviewedProductionProfile(artifact: BenchmarkArtifactV1): readonly string[] {
  return isReviewedProductionProfile(artifact) ? [] : ['reviewed default production-large profile'];
}

export function assertExternalRepositoryEvidence(artifact: BenchmarkArtifactV1): void {
  if (artifact.suite !== 'code-graph-external-repository-v1') {
    throw new Error(`External repository evidence has the wrong suite: ${artifact.suite}.`);
  }
  const measurements = new Map(artifact.measurements.map(measurement => [measurement.name, measurement]));
  const missing = EXTERNAL_REPOSITORY_EVIDENCE_MEASUREMENTS.flatMap(required => {
    const measurement = measurements.get(required.name);
    return measurement?.unit === required.unit ? [] : [`${required.name} (${required.unit})`];
  });
  if (artifact.metadata.oneFileReindexMaterializationMode !== 'incremental-overlay') {
    missing.push('one-file reindex incremental-overlay materialization mode');
  }
  if (artifact.metadata.coldMaterializationStorageMode !== 'direct-persistent') {
    missing.push('cold direct-persistent materialization storage mode');
  }
  if (artifact.metadata.sameOverlayReferenceMaterializationMode !== 'full') {
    missing.push('same-overlay full rebuild materialization mode');
  }
  if (!/^[0-9a-f]{40,64}$/.test(String(artifact.metadata.externalRepositoryCommit ?? ''))) {
    missing.push('exact external repository commit');
  }
  if (!/^[0-9a-f]{40,64}$/.test(artifact.environment.commit) || artifact.environment.dirty) {
    missing.push('clean exact Threadnote source commit');
  }
  if (
    artifact.environment.fixtureHash !== `external-code-graph-v1:${String(artifact.metadata.externalRepositoryCommit)}`
  ) {
    missing.push('external fixture identity tied to its exact commit');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(artifact.metadata.sqliteVersion ?? ''))) {
    missing.push('SQLite version');
  }
  const controlLanguages = externalControlLanguages(artifact.metadata);
  if (controlLanguages.length === 0) missing.push('external query control languages');
  if (artifact.metadata.externalControlCount !== controlLanguages.length) missing.push('external query control count');
  if (artifact.metadata.mcpOperationCount !== 6) missing.push('complete six-operation MCP matrix');
  missing.push(...missingDeterministicParityEvidence(measurements));
  missing.push(...missingSamplerObservations(measurements));
  missing.push(...missingActivationObservations(artifact, measurements));
  for (const language of controlLanguages) {
    for (const name of [
      `cold-materialized-file-rows-language-${language}`,
      `cold-materialized-symbol-rows-language-${language}`,
      `external-query-cold-${language}-returned-nodes`,
      `external-query-cold-${language}-expected-path-language-nodes`,
      `external-query-incremental-${language}-returned-nodes`,
      `external-query-incremental-${language}-expected-path-language-nodes`,
      `external-query-same-overlay-reference-${language}-returned-nodes`,
      `external-query-same-overlay-reference-${language}-expected-path-language-nodes`,
      `external-query-${language}-same-overlay-structural-parity`,
    ]) {
      const measurement = measurements.get(name);
      if (!measurement || measurement.minimum < 1) missing.push(`${name} positive result`);
    }
  }
  if (controlLanguages.includes('bazel-build')) {
    for (const name of ['cold-bazel-workspace-scope-rows', 'cold-bazel-workspace-component-rows']) {
      const measurement = measurements.get(name);
      if (!measurement || measurement.minimum < 1) missing.push(`${name} positive result`);
    }
  }
  for (const operation of ['query', 'node', 'neighbors', 'explain', 'impact', 'path'] as const) {
    const duration = measurements.get(`mcp-${operation}-duration`);
    if (!duration || duration.maximum > 25_000) missing.push(`mcp-${operation}-duration within 25 seconds`);
    for (const part of ['structured', 'text'] as const) {
      const bytes = measurements.get(`mcp-${operation}-${part}-output`);
      if (!bytes || bytes.minimum < 1 || bytes.maximum > 24 * 1_024) {
        missing.push(`mcp-${operation}-${part}-output within 24 KiB`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`External repository evidence is incomplete: ${missing.join(', ')}.`);
  }
}

function missingDeterministicParityEvidence(
  measurements: ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number]>,
): readonly string[] {
  return [
    'cold-primary-query-returned-nodes',
    'one-file-reindex-primary-query-returned-nodes',
    'same-overlay-full-rebuild-primary-query-returned-nodes',
    'primary-query-structural-parity',
    'structural-graph-digest-parity',
  ].flatMap(name => {
    const measurement = measurements.get(name);
    return measurement && measurement.minimum >= 1 ? [] : [`${name} positive result`];
  });
}

function missingSamplerObservations(
  measurements: ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number]>,
): readonly string[] {
  const requiredFailureMeasurements = new Set<string>();
  const missing = (['cold', 'one-file-reindex', 'same-overlay-reference'] as const).flatMap(prefix => {
    const expectedPositive = [
      `${prefix}-external-storage-samples-n1`,
      `${prefix}-external-process-tree-samples-n1`,
      `${prefix}-external-process-tree-attempts-n1`,
      `${prefix}-external-process-count-peak-observed-n1`,
      `${prefix}-external-rss-peak-observed-n1`,
    ];
    const prefixMissing = expectedPositive.flatMap(name => {
      const measurement = measurements.get(name);
      return measurement && measurement.minimum >= 1 ? [] : [`${name} positive result`];
    });
    const samplerVersion = measurements.get(`${prefix}-external-sampler-version-n1`);
    if (!samplerVersion || samplerVersion.minimum < 4) {
      prefixMissing.push(`${prefix}-external-sampler-version-n1 expected sampler v4 or newer`);
    }
    const processTreeFailures = measurements.get(`${prefix}-external-process-tree-failures-n1`);
    requiredFailureMeasurements.add(`${prefix}-external-process-tree-failures-n1`);
    if (!processTreeFailures || processTreeFailures.maximum !== 0) {
      prefixMissing.push(`${prefix}-external-process-tree-failures-n1 expected zero inspection loss`);
    }
    if (!measurements.has(`${prefix}-external-process-tree-maximum-sample-gap-n1`)) {
      prefixMissing.push(`${prefix}-external-process-tree-maximum-sample-gap-n1 observed result`);
    }
    const openTemporaryFileAttempts = measurements.get(`${prefix}-external-open-temp-process-tree-attempts-n1`);
    if (!openTemporaryFileAttempts || openTemporaryFileAttempts.minimum < 1) {
      prefixMissing.push(`${prefix}-external-open-temp-process-tree-attempts-n1 positive result`);
    }
    const openTemporaryFileFailures = measurements.get(`${prefix}-external-open-temp-process-tree-failures-n1`);
    requiredFailureMeasurements.add(`${prefix}-external-open-temp-process-tree-failures-n1`);
    if (!openTemporaryFileFailures || openTemporaryFileFailures.maximum !== 0) {
      prefixMissing.push(`${prefix}-external-open-temp-process-tree-failures-n1 expected zero inspection loss`);
    }
    const openTemporaryFileSamples = measurements.get(`${prefix}-external-open-temp-process-tree-samples-n1`);
    if (!openTemporaryFileSamples || openTemporaryFileSamples.minimum < 1) {
      prefixMissing.push(`${prefix}-external-open-temp-process-tree-samples-n1 positive result`);
    }
    return prefixMissing;
  });
  for (const [name, measurement] of measurements) {
    if (
      (name.endsWith('-external-process-tree-failures-n1') ||
        name.endsWith('-external-open-temp-process-tree-failures-n1')) &&
      !requiredFailureMeasurements.has(name) &&
      measurement.maximum !== 0
    ) {
      missing.push(`${name} expected zero inspection loss`);
    }
  }
  return missing;
}

function externalControlLanguages(metadata: BenchmarkArtifactV1['metadata']): readonly string[] {
  const value = metadata.externalControlLanguages;
  if (typeof value !== 'string' || value.length === 0) return [];
  const languages = value.split(',');
  if (languages.some(language => !/^[a-z][a-z0-9-]*$/.test(language)) || new Set(languages).size !== languages.length) {
    return [];
  }
  return languages;
}

function missingReleaseSourceProvenance(artifact: BenchmarkArtifactV1): readonly string[] {
  const ref = artifact.metadata.releaseEvidenceRef;
  const resolvedSha = artifact.metadata.releaseEvidenceResolvedSha;
  const sha = artifact.metadata.releaseEvidenceSha;
  return typeof ref === 'string' &&
    /^refs\/tags\/v4\.0\.0(?:-(?:beta|rc)\.\d+)?$/.test(ref) &&
    typeof sha === 'string' &&
    /^[0-9a-f]{40,64}$/.test(sha) &&
    resolvedSha === sha &&
    sha === artifact.environment.commit &&
    !artifact.environment.dirty
    ? []
    : ['clean exact release source provenance'];
}

function missingActivationObservations(
  artifact: BenchmarkArtifactV1,
  measurements: ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number]>,
): readonly string[] {
  const missing = (['cold', 'one-file-reindex'] as const).flatMap(prefix => {
    const storageMode =
      prefix === 'cold'
        ? artifact.metadata.coldMaterializationStorageMode
        : artifact.metadata.oneFileReindexMaterializationStorageMode;
    const expectedStages =
      storageMode === 'direct-persistent'
        ? DIRECT_PERSISTENT_ACTIVATION_STAGES
        : prefix === 'cold'
          ? ACTIVATION_STAGES
          : storageMode === 'temporary-staged'
            ? INCREMENTAL_STAGED_ACTIVATION_STAGES
            : DIRECT_PERSISTENT_ACTIVATION_STAGES;
    const name = `${prefix}-activation-observed-stages-n1`;
    const measurement = measurements.get(name);
    const missing =
      measurement && measurement.minimum >= expectedStages.length
        ? []
        : [`${name} expected at least ${expectedStages.length} real stages`];
    for (const stage of expectedStages) {
      const observedName = `${prefix}-activation-${stage}-observed-n1`;
      const observed = measurements.get(observedName);
      if (!observed || observed.minimum < 1) missing.push(`${observedName} positive result`);
    }
    return missing;
  });
  if (artifact.metadata.coldMaterializationStorageMode === 'direct-persistent') {
    const durableHighWater = measurements.get('cold-sqlite-durable-database-pages-high-water-n1');
    if (!durableHighWater || durableHighWater.minimum < 1) {
      missing.push('cold-sqlite-durable-database-pages-high-water-n1 positive result');
    }
    for (const stage of ACTIVATION_COPY_STAGES) {
      const observedName = `cold-activation-${stage}-observed-n1`;
      const observed = measurements.get(observedName);
      if (!observed || observed.maximum !== 0) {
        missing.push(`${observedName} expected zero direct-persistent activation copies`);
      }
    }
  }
  return missing;
}

const threadnoteSourceGit = Effect.fn('benchmarkCodeGraph.threadnoteSourceGit')(
  (sourceRoot: string, args: readonly string[]) =>
    repositoryGit(sourceRoot, args).pipe(Effect.map(result => result.stdout.trim())),
);

export function resolvedReleaseEvidenceSource(
  ref: string,
  sha: string,
  resolvedSha: string,
  checkoutCommit: string,
  dirty: boolean,
): {readonly ref: string; readonly resolvedSha: string; readonly sha: string} {
  if (
    !/^refs\/tags\/v4\.0\.0(?:-(?:beta|rc)\.\d+)?$/.test(ref) ||
    !/^[0-9a-f]{40,64}$/.test(sha) ||
    resolvedSha !== sha ||
    checkoutCommit !== sha ||
    dirty
  ) {
    throw new Error(
      'Release benchmark provenance requires a locally resolvable tag, its exact commit SHA, and a clean checkout.',
    );
  }
  return {ref, resolvedSha, sha};
}

const validateReleaseEvidenceSource = Effect.fn('benchmarkCodeGraph.validateReleaseEvidenceSource')(function* (
  sourceRoot: string,
  ref: string | undefined,
  sha: string | undefined,
) {
  if (ref === undefined && sha === undefined) return undefined;
  if (
    ref === undefined ||
    sha === undefined ||
    !/^refs\/tags\/v4\.0\.0(?:-(?:beta|rc)\.\d+)?$/.test(ref) ||
    !/^[0-9a-f]{40,64}$/.test(sha)
  ) {
    return yield* Effect.fail(
      new Error('Release benchmark provenance requires a Threadnote 4 release tag and its exact commit SHA.'),
    );
  }
  const [commit, dirty, resolvedSha] = yield* Effect.all(
    [
      threadnoteSourceGit(sourceRoot, ['rev-parse', 'HEAD']),
      threadnoteSourceGit(sourceRoot, CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS),
      threadnoteSourceGit(sourceRoot, ['rev-parse', '--verify', `${ref}^{commit}`]),
    ],
    {concurrency: 3},
  );
  return yield* Effect.try(() => resolvedReleaseEvidenceSource(ref, sha, resolvedSha, commit, dirty.length > 0));
});

export interface CodeGraphBenchmarkOptions {
  readonly externalControls: readonly ExternalRepositoryQueryControl[];
  readonly fixture: string;
  readonly homePath?: string;
  readonly incrementalPath?: string;
  readonly minimumFreeGiB: number;
  readonly modelHome?: string;
  readonly outputPath?: string;
  readonly preflight: boolean;
  readonly profile?: 'production-large';
  readonly profileFiles?: number;
  readonly profileSymbols?: number;
  readonly queryText?: string;
  readonly referenceHomePath?: string;
  readonly repository?: string;
  readonly retainHomes: boolean;
  readonly samples: number;
  readonly scaleSymbols?: number;
  readonly warmups: number;
  readonly failOnBudget: boolean;
  readonly vectors: boolean;
}

export function parseCodeGraphBenchmarkArguments(args: readonly string[]): CodeGraphBenchmarkOptions {
  const structuredControls: ExternalRepositoryQueryControl[] = [];
  let expectedLanguage: string | undefined;
  let expectedPath: string | undefined;
  let fixture = 'code-graph-v1';
  let homePath: string | undefined;
  let incrementalPath: string | undefined;
  let minimumFreeGiB = 120;
  let modelHome: string | undefined;
  let outputPath: string | undefined;
  let preflight = false;
  let profile: 'production-large' | undefined;
  let profileFiles: number | undefined;
  let profileSymbols: number | undefined;
  let queryText: string | undefined;
  let referenceHomePath: string | undefined;
  let repository: string | undefined;
  let retainHomes = false;
  let samples = 25;
  let scaleSymbols: number | undefined;
  let warmups = 5;
  let failOnBudget = false;
  let vectors = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--control') {
      structuredControls.push(parseExternalRepositoryQueryControl(required(args[++index], argument)));
    } else if (argument === '--expected-language') expectedLanguage = required(args[++index], argument);
    else if (argument === '--expected-path') expectedPath = required(args[++index], argument);
    else if (argument === '--fixture') fixture = required(args[++index], argument);
    else if (argument === '--home') homePath = required(args[++index], argument);
    else if (argument === '--incremental-path') incrementalPath = required(args[++index], argument);
    else if (argument === '--minimum-free-gib') minimumFreeGiB = integer(args[++index], argument, 1);
    else if (argument === '--model-home') modelHome = required(args[++index], argument);
    else if (argument === '--query') queryText = required(args[++index], argument);
    else if (argument === '--reference-home') referenceHomePath = required(args[++index], argument);
    else if (argument === '--repository') repository = required(args[++index], argument);
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
    else if (argument === '--preflight') preflight = true;
    else if (argument === '--retain-homes') retainHomes = true;
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
  const legacyControlValues = [queryText, expectedPath, expectedLanguage].filter(value => value !== undefined).length;
  if (structuredControls.length > 0 && legacyControlValues > 0) {
    throw new Error('--control cannot be combined with legacy --query, --expected-path, or --expected-language flags.');
  }
  if (legacyControlValues > 0 && legacyControlValues < 3) {
    throw new Error(
      'Legacy external control flags require --query, --expected-path, and --expected-language together.',
    );
  }
  const externalControls =
    structuredControls.length > 0
      ? structuredControls
      : queryText && expectedPath && expectedLanguage
        ? [{expectedLanguage, expectedPath, query: queryText}]
        : [];
  if (new Set(externalControls.map(control => control.expectedLanguage)).size !== externalControls.length) {
    throw new Error('External query controls must use unique language categories.');
  }
  if (repository !== undefined) {
    if (profile !== undefined || scaleSymbols !== undefined || vectors) {
      throw new Error('--repository cannot be combined with generated profiles, scale fixtures, or vectors.');
    }
    if (!incrementalPath || externalControls.length === 0 || !outputPath) {
      throw new Error('--repository requires --incremental-path, at least one --control, and --output.');
    }
    if (failOnBudget) {
      throw new Error('External repositories retain same-runner evidence and do not use portable latency budgets.');
    }
    if ((homePath === undefined) !== (referenceHomePath === undefined)) {
      throw new Error('--home and --reference-home must be provided together.');
    }
    if (retainHomes && (homePath === undefined || referenceHomePath === undefined)) {
      throw new Error('--retain-homes requires explicit --home and --reference-home paths.');
    }
  } else if (
    incrementalPath !== undefined ||
    externalControls.length > 0 ||
    homePath !== undefined ||
    referenceHomePath !== undefined ||
    retainHomes ||
    preflight
  ) {
    throw new Error(
      '--incremental-path, external controls, benchmark homes, --retain-homes, and --preflight require --repository.',
    );
  }
  return {
    externalControls,
    failOnBudget,
    fixture,
    homePath,
    incrementalPath,
    minimumFreeGiB,
    modelHome,
    outputPath,
    preflight,
    profile,
    profileFiles,
    profileSymbols,
    queryText: externalControls[0]?.query,
    referenceHomePath,
    repository,
    retainHomes,
    samples,
    scaleSymbols,
    vectors,
    warmups,
  };
}

const parseArguments = parseCodeGraphBenchmarkArguments;

function parseExternalRepositoryQueryControl(value: string): ExternalRepositoryQueryControl {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('--control must be a JSON object with query, expectedPath, and expectedLanguage strings.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--control must be a JSON object with query, expectedPath, and expectedLanguage strings.');
  }
  const candidate = parsed as Partial<Record<keyof ExternalRepositoryQueryControl, unknown>>;
  const query = typeof candidate.query === 'string' ? candidate.query.trim() : '';
  const expectedPath = typeof candidate.expectedPath === 'string' ? candidate.expectedPath.trim() : '';
  const expectedLanguage = typeof candidate.expectedLanguage === 'string' ? candidate.expectedLanguage.trim() : '';
  if (!query || !expectedPath || !/^[a-z][a-z0-9-]*$/.test(expectedLanguage)) {
    throw new Error(
      '--control requires non-empty query and expectedPath strings plus a lowercase expectedLanguage category.',
    );
  }
  return {expectedLanguage, expectedPath, query};
}

const prepareExternalCodeGraphFixture = Effect.fn('benchmarkCodeGraph.prepareExternalRepository')(function* (
  options: CodeGraphBenchmarkOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!options.repository || !options.incrementalPath || options.externalControls.length === 0 || !options.outputPath) {
    return yield* Effect.fail(new Error('External repository benchmark options are incomplete.'));
  }
  const requestedRoot = path.resolve(options.repository);
  const repository = yield* fs.realPath(
    path.resolve((yield* repositoryGit(requestedRoot, ['rev-parse', '--show-toplevel'])).stdout.trim()),
  );
  const [externalCommit, dirty] = yield* Effect.all(
    [
      repositoryGit(repository, ['rev-parse', 'HEAD']).pipe(Effect.map(result => result.stdout.trim())),
      repositoryGit(repository, CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS).pipe(Effect.map(result => result.stdout.trim())),
    ],
    {concurrency: 2},
  );
  if (!/^[0-9a-f]{40,64}$/.test(externalCommit)) {
    return yield* Effect.fail(new Error('External repository did not resolve to an exact Git commit.'));
  }
  if (dirty.length > 0) {
    return yield* Effect.fail(new Error('External repository benchmark requires a clean checkout.'));
  }

  const artifactPath = yield* canonicalizeProspectivePath(fs, path, options.outputPath);
  const artifactContainment = path.relative(repository, artifactPath);
  if (
    artifactContainment === '' ||
    (!path.isAbsolute(artifactContainment) &&
      artifactContainment !== '..' &&
      !artifactContainment.startsWith(`..${path.sep}`))
  ) {
    return yield* Effect.fail(
      new Error('--output must be outside the external repository so benchmark evidence cannot modify the checkout.'),
    );
  }

  const [incrementalPath, externalControls] = yield* Effect.all(
    [
      validateExternalTrackedRegularPath(fs, path, repository, options.incrementalPath, '--incremental-path'),
      Effect.forEach(
        options.externalControls,
        control =>
          validateExternalTrackedRegularPath(fs, path, repository, control.expectedPath, '--control expectedPath').pipe(
            Effect.map(expectedPath => ({...control, expectedPath})),
          ),
        {concurrency: 4},
      ),
    ],
    {concurrency: 2},
  );

  // Reserve sequentially. Besides making error cleanup deterministic, this
  // catches case aliases on case-insensitive filesystems after the first path
  // has a canonical identity.
  const homeReservation = yield* acquireFreshBenchmarkHome(
    fs,
    path,
    options.homePath,
    'threadnote-code-graph-external-benchmark-',
    repository,
  );
  const referenceHomeReservation = yield* acquireFreshBenchmarkHome(
    fs,
    path,
    options.referenceHomePath,
    'threadnote-code-graph-same-overlay-reference-',
    repository,
  );
  const home = homeReservation.home;
  const referenceHome = referenceHomeReservation.home;
  if (home === referenceHome) {
    return yield* Effect.fail(new Error('Primary and same-overlay reference benchmark homes must be different.'));
  }
  for (const benchmarkHome of [home, referenceHome]) {
    const containment = path.relative(repository, benchmarkHome);
    if (
      containment === '' ||
      (!path.isAbsolute(containment) && containment !== '..' && !containment.startsWith(`..${path.sep}`))
    ) {
      return yield* Effect.fail(new Error('Benchmark homes must be outside the external repository.'));
    }
  }
  return {
    externalCommit,
    externalControls,
    fixtureIdentity: `external-code-graph-v1:${externalCommit}`,
    home,
    incrementalSourcePath: incrementalPath,
    preserveHomes: Effect.sync(() => {
      homeReservation.preserve();
      referenceHomeReservation.preserve();
    }),
    queryText: externalControls[0]!.query,
    referenceHome,
    repository,
  } satisfies PreparedCodeGraphBenchmarkFixture;
});

const acquireFreshBenchmarkHome = Effect.fn('benchmarkCodeGraph.acquireFreshHome')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  requested: string | undefined,
  prefix: string,
  repository: string,
) {
  if (requested === undefined) {
    const home = yield* fs.makeTempDirectoryScoped({prefix});
    return {home, preserve: () => {}} as const;
  }
  const target = yield* canonicalizeProspectivePath(fs, path, requested);
  const containment = path.relative(repository, target);
  if (
    containment === '' ||
    (!path.isAbsolute(containment) && containment !== '..' && !containment.startsWith(`..${path.sep}`))
  ) {
    return yield* Effect.fail(new Error('Benchmark homes must be outside the external repository.'));
  }
  const parent = path.dirname(target);
  yield* fs.makeDirectory(parent, {mode: 0o700, recursive: true});
  const canonicalParent = yield* fs.realPath(parent);
  const exclusiveTarget = path.join(canonicalParent, path.basename(target));
  return yield* Effect.acquireRelease(
    fs.makeDirectory(exclusiveTarget, {mode: 0o700}).pipe(
      Effect.mapError(() => new Error('Explicit benchmark home paths must be fresh and exclusively reservable.')),
      Effect.andThen(
        fs.realPath(exclusiveTarget).pipe(
          Effect.flatMap(home => {
            const finalContainment = path.relative(repository, home);
            return finalContainment === '' ||
              (!path.isAbsolute(finalContainment) &&
                finalContainment !== '..' &&
                !finalContainment.startsWith(`..${path.sep}`))
              ? Effect.fail(new Error('Benchmark homes must be outside the external repository.'))
              : Effect.succeed(home);
          }),
        ),
      ),
      Effect.onError(() => fs.remove(exclusiveTarget, {force: true, recursive: true}).pipe(Effect.ignore)),
      Effect.map(home => {
        let preserved = false;
        return {
          home,
          preserve: () => {
            preserved = true;
          },
          preserved: () => preserved,
        } as const;
      }),
    ),
    reservation =>
      reservation.preserved()
        ? Effect.void
        : fs.remove(reservation.home, {force: true, recursive: true}).pipe(Effect.ignore),
  );
});

const externalBenchmarkPreflight = Effect.fn('benchmarkCodeGraph.externalPreflight')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  prepared: PreparedCodeGraphBenchmarkFixture,
  minimumFreeGiB: number,
  retainHomes: boolean,
) {
  const system = yield* SystemInfo;
  if (!externalBenchmarkPlatformSupported(process.platform)) {
    return yield* Effect.fail(
      new Error('External code-graph evidence currently requires Linux or macOS process and storage telemetry.'),
    );
  }
  if (!prepared.externalCommit || !prepared.incrementalSourcePath || !prepared.referenceHome) {
    return yield* Effect.fail(new Error('External benchmark preflight requires a complete prepared fixture.'));
  }
  const source = decodeBenchmarkSource(
    yield* fs.readFile(path.join(prepared.repository, prepared.incrementalSourcePath)),
  );
  semanticBenchmarkOverlay(prepared.incrementalSourcePath, source);
  const [tree, primaryCapacity, referenceCapacity, hardware] = yield* Effect.all(
    [
      repositoryGit(prepared.repository, ['rev-parse', 'HEAD^{tree}']).pipe(Effect.map(result => result.stdout.trim())),
      filesystemCapacity(prepared.home),
      filesystemCapacity(prepared.referenceHome),
      system.hardwareInfo(),
    ],
    {concurrency: 4},
  );
  const minimumFreeBytes = minimumFreeGiB * 1_073_741_824;
  if (primaryCapacity.availableBytes < minimumFreeBytes || referenceCapacity.availableBytes < minimumFreeBytes) {
    return yield* Effect.fail(
      new Error(
        `External benchmark preflight requires at least ${minimumFreeGiB} GiB free on every benchmark-home filesystem.`,
      ),
    );
  }
  return {
    availableBytes: {
      primary: primaryCapacity.availableBytes,
      reference: referenceCapacity.availableBytes,
    },
    commit: prepared.externalCommit,
    effectiveParserMemoryBytes: hardware.effectiveMemoryBytes,
    effectiveParserWorkers: parserWorkerCapacity({
      effectiveMemoryBytes: hardware.effectiveMemoryBytes,
      environment: system.environment(),
      hardwareConcurrency: navigator.hardwareConcurrency,
    }),
    physicalMemoryBytes: hardware.memoryBytes,
    environment: benchmarkEnvironmentProvenance(),
    filesystemsShared: primaryCapacity.filesystem === referenceCapacity.filesystem,
    minimumFreeBytes,
    retainHomes,
    semanticOverlaySupported: true,
    tree,
    version: 1,
  } as const;
});

const filesystemCapacity = Effect.fn('benchmarkCodeGraph.filesystemCapacity')(function* (target: string) {
  const result = yield* runCommandEffect('df', ['-Pk', target], {timeoutMs: 10_000});
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  const columns = line?.trim().split(/\s+/) ?? [];
  const capacityIndex = columns.findIndex(column => /^\d+%$/.test(column));
  const availableKilobytes = Number(columns[capacityIndex - 1] ?? Number.NaN);
  const filesystem = columns[0] ?? '';
  if (!filesystem || capacityIndex < 3 || !Number.isSafeInteger(availableKilobytes) || availableKilobytes < 0) {
    return yield* Effect.fail(new Error('Could not determine benchmark filesystem capacity.'));
  }
  return {availableBytes: availableKilobytes * 1_024, filesystem};
});

function benchmarkEnvironmentProvenance(): Readonly<Record<string, string>> {
  return sanitizedBenchmarkEnvironmentProvenance(process.env);
}

export function sanitizedBenchmarkEnvironmentProvenance(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  if (environment.SQLITE_TMPDIR?.trim()) values.SQLITE_TMPDIR = 'configured-path-redacted';
  const idleTimeout = boundedEnvironmentInteger(
    environment,
    'THREADNOTE_CODE_GRAPH_PARSER_IDLE_TIMEOUT_MS',
    0,
    60 * 60_000,
  );
  const requestTimeout = boundedEnvironmentInteger(
    environment,
    'THREADNOTE_CODE_GRAPH_PARSER_TIMEOUT_MS',
    1_000,
    10 * 60_000,
  );
  const workers = boundedEnvironmentInteger(environment, 'THREADNOTE_CODE_GRAPH_PARSER_WORKERS', 1, 8);
  if (idleTimeout !== undefined) values.THREADNOTE_CODE_GRAPH_PARSER_IDLE_TIMEOUT_MS = String(idleTimeout);
  if (requestTimeout !== undefined) values.THREADNOTE_CODE_GRAPH_PARSER_TIMEOUT_MS = String(requestTimeout);
  if (workers !== undefined) values.THREADNOTE_CODE_GRAPH_PARSER_WORKERS = String(workers);
  if (environment.THREADNOTE_BENCHMARK_RUNNER_CLASS?.trim()) {
    values.THREADNOTE_BENCHMARK_RUNNER_CLASS = benchmarkRunnerLabel(
      'THREADNOTE_BENCHMARK_RUNNER_CLASS',
      'local-unclassified',
      environment,
    );
  }
  if (environment.THREADNOTE_BENCHMARK_RUNNER_ID?.trim()) {
    values.THREADNOTE_BENCHMARK_RUNNER_ID = benchmarkRunnerLabel(
      'THREADNOTE_BENCHMARK_RUNNER_ID',
      'local',
      environment,
    );
  }
  return values;
}

export function externalBenchmarkPlatformSupported(platform: string): boolean {
  return platform === 'darwin' || platform === 'linux';
}

function boundedEnvironmentInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const parsed = Number.parseInt(environment[name] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? Math.min(maximum, parsed) : undefined;
}

function benchmarkRunnerLabel(
  name: 'THREADNOTE_BENCHMARK_RUNNER_CLASS' | 'THREADNOTE_BENCHMARK_RUNNER_ID',
  fallback: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[name]?.trim();
  if (!value) return fallback;
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) return value;
  const digest = new Bun.CryptoHasher('sha256').update(value).digest('hex');
  return `redacted-${digest.slice(0, 16)}`;
}

const validateExternalTrackedRegularPath = Effect.fn('benchmarkCodeGraph.validateExternalTrackedRegularPath')(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    repository: string,
    value: string,
    option: '--control expectedPath' | '--incremental-path',
  ) {
    if (path.isAbsolute(value)) {
      return yield* Effect.fail(new Error(`${option} must name a repository-relative file.`));
    }
    const normalized = path.normalize(value);
    const source = path.resolve(repository, normalized);
    const containment = path.relative(repository, source);
    if (
      containment === '' ||
      containment === '..' ||
      containment.startsWith(`..${path.sep}`) ||
      path.isAbsolute(containment)
    ) {
      return yield* Effect.fail(new Error(`${option} must name a repository-relative file.`));
    }
    const canonicalSource = yield* fs.realPath(source);
    const canonicalContainment = path.relative(repository, canonicalSource);
    if (
      canonicalContainment === '' ||
      canonicalContainment === '..' ||
      canonicalContainment.startsWith(`..${path.sep}`) ||
      path.isAbsolute(canonicalContainment)
    ) {
      return yield* Effect.fail(new Error(`${option} resolved outside the external repository.`));
    }
    const gitPath = containment.split(path.sep).join('/');
    const tracked = yield* repositoryGit(repository, ['ls-files', '--stage', '--error-unmatch', '--', gitPath]);
    if (!/^100(?:644|755)\s/.test(tracked.stdout)) {
      return yield* Effect.fail(new Error(`${option} must name a tracked regular file, not a link or submodule.`));
    }
    const info = yield* fs.stat(source);
    if (info.type !== 'File') {
      return yield* Effect.fail(new Error(`${option} must name a tracked regular file.`));
    }
    return gitPath;
  },
);

const verifyExternalRepositoryUnchanged = Effect.fn('benchmarkCodeGraph.verifyExternalRepositoryUnchanged')(function* (
  repository: string,
  expectedCommit: string,
) {
  const [commit, dirty] = yield* Effect.all(
    [
      repositoryGit(repository, ['rev-parse', 'HEAD']).pipe(Effect.map(result => result.stdout.trim())),
      repositoryGit(repository, CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS).pipe(Effect.map(result => result.stdout.trim())),
    ],
    {concurrency: 2},
  );
  if (commit !== expectedCommit || dirty.length > 0) {
    return yield* Effect.fail(
      new Error(
        'External repository changed during the benchmark; its evidence was rejected after restoring the overlay.',
      ),
    );
  }
});

const verifyBenchmarkSourceUnchanged = Effect.fn('benchmarkCodeGraph.verifyBenchmarkSourceUnchanged')(function* (
  sourceRoot: string,
  expectedCommit: string,
) {
  const [commit, dirty] = yield* Effect.all(
    [
      threadnoteSourceGit(sourceRoot, ['rev-parse', 'HEAD']),
      threadnoteSourceGit(sourceRoot, CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS),
    ],
    {concurrency: 2},
  );
  if (commit !== expectedCommit || dirty.length > 0) {
    return yield* Effect.fail(
      new Error('Threadnote source changed during the external benchmark; its evidence was not published.'),
    );
  }
});

const repositoryGit = Effect.fn('benchmarkCodeGraph.repositoryGit')((repository: string, args: readonly string[]) =>
  runCommandEffect('git', ['-C', repository, ...args], {
    maxOutputBytes: 16 * 1_048_576,
    timeoutMs: 5 * 60_000,
  }),
);

const canonicalizeProspectivePath = Effect.fn('benchmarkCodeGraph.canonicalizeProspectivePath')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
) {
  let current = path.resolve(target);
  const suffix: string[] = [];
  while (true) {
    const canonical = yield* fs.realPath(current).pipe(Effect.option);
    if (Option.isSome(canonical)) return path.join(canonical.value, ...suffix);
    const parent = path.dirname(current);
    if (parent === current) {
      return yield* Effect.fail(new Error(`Could not resolve an existing parent for output path ${target}.`));
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
});

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

function benchmarkComparisonKey(input: {
  readonly architecture: string;
  readonly cpu: string;
  readonly memoryBytes: number;
  readonly operatingSystem: string;
  readonly runnerClass: string;
}): string {
  return [input.runnerClass, input.operatingSystem, input.architecture, input.cpu, input.memoryBytes]
    .map(value => String(value).trim().replace(/\s+/g, ' '))
    .join('|');
}

export function enforceCodeGraphBenchmarkBudget(
  artifact: BenchmarkArtifactV1,
  value: unknown,
  scaleSymbols: number | undefined,
): void {
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
    ['cold-materialization', 'coldMaterializationP95MillisecondsMaximum'],
    ['one-file-reindex-index', 'oneFileIncrementalP95MillisecondsMaximum'],
    ['one-file-reindex-materialization', 'oneFileMaterializationP95MillisecondsMaximum'],
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
    if (!measurement) {
      failures.push(`missing ${measurementName} measurement`);
    } else if (typeof maximum !== 'number' || !Number.isFinite(maximum)) {
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

if (import.meta.main) BunRuntime.runMain(benchmarkCodeGraph.pipe(Effect.provide(ApplicationLayer)));
