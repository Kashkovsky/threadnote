import {NodeCrypto, NodeFileSystem, NodePath, NodeRuntime} from '@effect/platform-node';
import {Clock, Console, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {evaluateRecallFixture, parseRecallEvaluationFixture} from '../src/recall/evaluate.js';
import {clearRecallIndexMemoryCache, expireRecallIndexValidation, loadRecallIndex} from '../src/recall/index.js';
import {prepareRecallSections} from '../src/recall/runtime.js';

const FIXTURE_PATH = 'test/evaluation/fixtures/recall-v1/fixture.json';
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const PRODUCTION_BENCHMARK_DOCUMENT_COUNT = 10_000;
const PRODUCTION_BENCHMARK_WARMUP_COUNT = 5;
const HOT_QUERY_SAMPLE_COUNT = 25;
const COLD_DECODE_SAMPLE_COUNT = 5;
const VALIDATION_SAMPLE_COUNT = 3;
const INCREMENTAL_UPDATE_SAMPLE_COUNT = 40;
const HOT_QUERY_P95_LIMIT_MILLISECONDS = 150;
const COLD_DECODE_P95_LIMIT_MILLISECONDS = 1_000;
const VALIDATION_P95_LIMIT_MILLISECONDS = 2_000;
const INCREMENTAL_UPDATE_P95_LIMIT_MILLISECONDS = 2_000;
const PRODUCTION_BENCHMARK_WRITE_CONCURRENCY = 64;
const PRODUCTION_BENCHMARK_QUERY = 'benchmark-anchor-9999';
const PRODUCTION_BENCHMARK_BASE_TIMESTAMP_MILLISECONDS = Date.UTC(2026, 0, 1);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(FIXTURE_PATH);
  const fixture = yield* Effect.try({
    try: () => parseRecallEvaluationFixture(JSON.parse(raw)),
    catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
  });
  const durations: number[] = [];
  for (const query of fixture.queries) {
    const startedAt = yield* Clock.currentTimeNanos;
    evaluateRecallFixture({...fixture, queries: [query]});
    const finishedAt = yield* Clock.currentTimeNanos;
    durations.push(Number(finishedAt - startedAt) / NANOSECONDS_PER_MILLISECOND);
  }
  const result = evaluateRecallFixture(fixture);
  const sortedDurations = [...durations].sort((left, right) => left - right);
  const productionBenchmark = yield* runProductionBenchmark;
  const output = {
    ...result,
    latencyMs: {
      p50: percentile(sortedDurations, 0.5),
      p95: percentile(sortedDurations, 0.95),
    },
    productionBenchmark,
  };
  yield* Console.log(JSON.stringify(output, undefined, 2));
  if (result.failures.length > 0) {
    return yield* Effect.fail(new Error(`Recall evaluation failed ${result.failures.length} contract check(s).`));
  }
  for (const [name, benchmark] of Object.entries(productionBenchmark.scenarios)) {
    if (benchmark.p95Milliseconds > benchmark.p95LimitMilliseconds) {
      return yield* Effect.fail(
        new Error(
          `Recall ${name} benchmark p95 ${benchmark.p95Milliseconds.toFixed(2)}ms exceeds ${benchmark.p95LimitMilliseconds}ms.`,
        ),
      );
    }
  }
});

const runProductionBenchmark = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const agentContextHome = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-eval-'});
    const resourceRoot = pathService.join(
      agentContextHome,
      'data',
      'viking',
      'local',
      'resources',
      'repos',
      'threadnote',
    );
    const repoRoot = pathService.join(agentContextHome, 'benchmark-repo');
    const manifestPath = pathService.join(agentContextHome, 'seed-manifest.yaml');
    const seedStatePath = pathService.join(agentContextHome, 'seed-state.json');
    const targetResourcePath = pathService.join(resourceRoot, '09999.md');
    const targetRepoPath = pathService.join(repoRoot, '09999.md');
    yield* fs.makeDirectory(resourceRoot, {recursive: true});
    yield* fs.makeDirectory(repoRoot, {recursive: true});
    yield* Effect.forEach(
      Array.from({length: PRODUCTION_BENCHMARK_DOCUMENT_COUNT}, (_unused, index) => index),
      index =>
        fs.writeFileString(
          pathService.join(resourceRoot, `${String(index).padStart(5, '0')}.md`),
          index === PRODUCTION_BENCHMARK_DOCUMENT_COUNT - 1
            ? '# Production benchmark target\n\ncommon retrieval benchmark-anchor-9999 bounded retrieval'
            : `# Production benchmark ${index}\n\ncommon retrieval document ${index}`,
        ),
      {concurrency: PRODUCTION_BENCHMARK_WRITE_CONCURRENCY},
    );
    const initialTargetContent =
      '# Production benchmark target\n\ncommon retrieval benchmark-anchor-9999 bounded retrieval';
    const initialTimestamp = new Date(PRODUCTION_BENCHMARK_BASE_TIMESTAMP_MILLISECONDS);
    yield* fs.writeFileString(targetRepoPath, initialTargetContent);
    yield* Effect.all([
      fs.utimes(targetResourcePath, initialTimestamp, initialTimestamp),
      fs.utimes(targetRepoPath, initialTimestamp, initialTimestamp),
    ]);
    yield* fs.writeFileString(
      manifestPath,
      `${JSON.stringify({
        projects: [
          {
            name: 'threadnote',
            path: repoRoot,
            seed: ['09999.md'],
            uri: 'viking://resources/repos/threadnote',
          },
        ],
        version: 1,
      })}\n`,
    );
    const writeSeedState = Effect.gen(function* () {
      const targetInfo = yield* fs.stat(targetRepoPath);
      const modifiedAt = Option.getOrUndefined(targetInfo.mtime)?.getTime();
      if (modifiedAt === undefined) {
        return yield* Effect.fail(new Error('Production benchmark target has no modification time.'));
      }
      yield* fs.writeFileString(
        seedStatePath,
        `${JSON.stringify({
          files: {
            'viking://resources/repos/threadnote/09999.md': {
              mtimeMs: modifiedAt,
              size: Number(targetInfo.size),
            },
          },
          version: 1,
        })}\n`,
      );
    });
    yield* writeSeedState;
    const config = {account: 'local', agentContextHome, manifestPath, user: 'benchmark'};
    const initialIndex = yield* loadRecallIndex(config, {forceRefresh: true, includeInactive: false});
    if (
      initialIndex.find(candidate => candidate.uri === 'viking://resources/repos/threadnote/09999.md')?.authority !==
      'canonical_repo'
    ) {
      return yield* Effect.fail(new Error('Production benchmark target did not receive verified seed authority.'));
    }
    const prepareForQuery = (query: string) =>
      prepareRecallSections(config, {
        exactMatches: [],
        feedbackQuery: query,
        includeInactive: false,
        limit: 10,
        minimumScore: 0,
        passes: [],
        project: 'threadnote',
        query,
        readRecords: () => Effect.succeed([]),
      });
    const prepare = prepareForQuery(`common retrieval ${PRODUCTION_BENCHMARK_QUERY}`);
    for (let index = 0; index < PRODUCTION_BENCHMARK_WARMUP_COUNT; index += 1) {
      const warmup = yield* prepare;
      if (!warmup.ranked.some(hit => hit.uri === 'viking://resources/repos/threadnote/09999.md')) {
        return yield* Effect.fail(new Error('Production benchmark failed to retrieve its exact target.'));
      }
    }
    const targetUri = 'viking://resources/repos/threadnote/09999.md';
    const measure = (
      samples: number,
      p95LimitMilliseconds: number,
      beforeSample: (sample: number) => Effect.Effect<void, unknown, FileSystem.FileSystem>,
      runSample: (sample: number) => ReturnType<typeof prepareForQuery> = () => prepare,
    ) =>
      Effect.gen(function* () {
        const durations: number[] = [];
        for (let sample = 0; sample < samples; sample += 1) {
          yield* beforeSample(sample);
          const startedAt = yield* Clock.currentTimeNanos;
          const result = yield* runSample(sample);
          const finishedAt = yield* Clock.currentTimeNanos;
          if (!result.ranked.some(hit => hit.uri === targetUri)) {
            return yield* Effect.fail(new Error('Production benchmark failed to retrieve its target.'));
          }
          durations.push(Number(finishedAt - startedAt) / NANOSECONDS_PER_MILLISECOND);
        }
        const sorted = durations.sort((left, right) => left - right);
        return {
          p50Milliseconds: percentile(sorted, 0.5),
          p95LimitMilliseconds,
          p95Milliseconds: percentile(sorted, 0.95),
          samples,
        };
      });
    const hotQuery = yield* measure(HOT_QUERY_SAMPLE_COUNT, HOT_QUERY_P95_LIMIT_MILLISECONDS, () => Effect.void);
    const coldDecode = yield* measure(COLD_DECODE_SAMPLE_COUNT, COLD_DECODE_P95_LIMIT_MILLISECONDS, () =>
      clearRecallIndexMemoryCache(),
    );
    const sourceValidation = yield* measure(VALIDATION_SAMPLE_COUNT, VALIDATION_P95_LIMIT_MILLISECONDS, () =>
      expireRecallIndexValidation(agentContextHome, false),
    );
    const incrementalUpdate = yield* measure(
      INCREMENTAL_UPDATE_SAMPLE_COUNT,
      INCREMENTAL_UPDATE_P95_LIMIT_MILLISECONDS,
      sample =>
        Effect.gen(function* () {
          const content = `# Production benchmark target\n\ncommon retrieval ${PRODUCTION_BENCHMARK_QUERY} benchmark-update-${String(sample).padStart(3, '0')}`;
          yield* Effect.all([
            fs.writeFileString(targetResourcePath, content),
            fs.writeFileString(targetRepoPath, content),
          ]);
          const timestamp = new Date(PRODUCTION_BENCHMARK_BASE_TIMESTAMP_MILLISECONDS + (sample + 1) * 1_000);
          yield* Effect.all([
            fs.utimes(targetResourcePath, timestamp, timestamp),
            fs.utimes(targetRepoPath, timestamp, timestamp),
          ]);
          yield* writeSeedState;
          yield* expireRecallIndexValidation(agentContextHome, false);
        }),
      sample => prepareForQuery(`benchmark-update-${String(sample).padStart(3, '0')}`),
    );
    const finalUnchangedQuery = yield* prepare;
    if (!finalUnchangedQuery.ranked.some(hit => hit.uri === targetUri)) {
      return yield* Effect.fail(
        new Error('Production benchmark lost an unchanged-term target after sustained incremental updates.'),
      );
    }
    return {
      documents: PRODUCTION_BENCHMARK_DOCUMENT_COUNT,
      scenarios: {
        coldDecode,
        hotQuery,
        incrementalUpdate,
        sourceValidation,
      },
      warmups: PRODUCTION_BENCHMARK_WARMUP_COUNT,
    };
  }),
);

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

NodeRuntime.runMain(
  program.pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer))),
  {
    disableErrorReporting: false,
  },
);
