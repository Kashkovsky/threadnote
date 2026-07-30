import * as BunServices from '@effect/platform-bun/BunServices';
import {BunRuntime} from '@effect/platform-bun';
import {Database} from 'bun:sqlite';
import {Clock, Console, Effect, FileSystem, Layer, Path} from 'effect';
import {LocalModelRuntime} from '../src/effect/ai/local-model-runtime.js';
import {SystemInfo} from '../src/effect/system.js';
import {BUILTIN_MODEL_MANIFESTS} from '../src/models/builtin.js';
import {LocalModelCatalog} from '../src/models/catalog.js';
import {selectLocalModel} from '../src/models/selection.js';
import {LocalModelStore, type LocalModelStoreShape} from '../src/models/store.js';
import {
  rebuildVectorIndex,
  selectedSemanticScores,
  vectorIndexDatabaseFilename,
  type VectorIndexProgress,
} from '../src/search/vector-index.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const MEBIBYTE = 1024 * 1024;
const DEFAULT_DOCUMENT_COUNT = 10_000;
const DEFAULT_QUERY_SAMPLES = 10;
const VECTOR_QUERY_RESULT_LIMIT = 25;
const manifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === 'bge-small-en-v1.5-q8')!;

const options = parseOptions(process.argv.slice(2));

const modelStoreLayer = Layer.succeed(
  LocalModelStore,
  LocalModelStore.of({
    install: () => Effect.die(new Error('Unexpected model installation')),
    path: home => `${home}/models/benchmark.gguf`,
    remove: () => Effect.succeed(false),
    status: home => Effect.succeed(modelInstallation(home)),
    verify: home => Effect.succeed(modelInstallation(home)),
  } satisfies LocalModelStoreShape),
);

const runtimeLayer = Layer.succeed(
  LocalModelRuntime,
  LocalModelRuntime.of({
    embedMany: ({inputs, manifest: requested}) =>
      Effect.sync(() => inputs.map(input => deterministicVector(requested.dimensions ?? 0, input))),
    generate: () => Effect.die(new Error('Unexpected generation')),
    rerank: () => Effect.die(new Error('Unexpected reranking')),
  }),
);

const benchmarkLayer = Layer.mergeAll(
  BunServices.layer,
  LocalModelCatalog.layer([manifest]),
  modelStoreLayer,
  runtimeLayer,
  SystemInfo.layer,
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-benchmark-'});
    const catalog = yield* LocalModelCatalog;
    yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
    const candidates = Array.from({length: options.documents}, (_, index) => ({
      text: `# Vector benchmark ${index}\n\nUnique vector benchmark document ${index}.`,
      uri: `threadnote://resources/repos/vector-benchmark/${String(index).padStart(6, '0')}.md`,
    }));
    const initialRss = startRssSampler();
    let initialPeakRssBytes = initialRss.peak();
    const trackInitialMemory = (_progress: VectorIndexProgress) =>
      Effect.sync(() => {
        initialPeakRssBytes = Math.max(initialPeakRssBytes, process.memoryUsage().rss);
      });
    const initialStartedAt = yield* Clock.currentTimeNanos;
    const initial = yield* rebuildVectorIndex({agentContextHome: home}, manifest, candidates, {
      onProgress: trackInitialMemory,
    }).pipe(Effect.ensuring(Effect.sync(() => initialRss.stop())));
    const initialFinishedAt = yield* Clock.currentTimeNanos;
    initialPeakRssBytes = Math.max(initialPeakRssBytes, initialRss.peak(), process.memoryUsage().rss);
    const databasePath = path.join(home, 'indexes', 'vectors', manifest.id, vectorIndexDatabaseFilename());
    const initialDatabaseBytes = Number((yield* fs.stat(databasePath)).size);

    Bun.gc(true);
    const queryRssBeforeBytes = process.memoryUsage().rss;
    const queryRss = startRssSampler();
    const queryDurations: number[] = [];
    let queryRssAfterBytes = queryRssBeforeBytes;
    yield* Effect.gen(function* () {
      for (let sample = 0; sample < options.samples; sample += 1) {
        const targetIndex = sample % options.documents;
        const startedAt = yield* Clock.currentTimeNanos;
        const scores = yield* selectedSemanticScores(
          {agentContextHome: home},
          `vector benchmark query ${targetIndex}`,
          {limit: VECTOR_QUERY_RESULT_LIMIT},
        );
        const finishedAt = yield* Clock.currentTimeNanos;
        const expectedSize = Math.min(VECTOR_QUERY_RESULT_LIMIT, options.documents);
        const expectedUri = candidates[targetIndex]!.uri;
        if (scores?.size !== expectedSize || (scores.get(expectedUri) ?? -1) < 0.999) {
          return yield* Effect.fail(
            new Error(
              `Vector benchmark returned ${scores?.size ?? 0}/${expectedSize} results without the exact target ${expectedUri}.`,
            ),
          );
        }
        queryDurations.push(Number(finishedAt - startedAt) / NANOSECONDS_PER_MILLISECOND);
        queryRssAfterBytes = Math.max(queryRssAfterBytes, process.memoryUsage().rss);
      }
    }).pipe(Effect.ensuring(Effect.sync(() => queryRss.stop())));
    queryRssAfterBytes = Math.max(queryRssAfterBytes, queryRss.peak());

    const changedCandidates = [
      ...candidates.slice(0, -1),
      {
        text: `# Vector benchmark ${options.documents - 1}\n\nChanged vector benchmark document ${options.documents - 1}.`,
        uri: candidates.at(-1)!.uri,
      },
    ];
    const incrementalRss = startRssSampler();
    let incrementalPeakRssBytes = incrementalRss.peak();
    const incrementalStartedAt = yield* Clock.currentTimeNanos;
    const incremental = yield* rebuildVectorIndex({agentContextHome: home}, manifest, changedCandidates, {
      onProgress: () =>
        Effect.sync(() => {
          incrementalPeakRssBytes = Math.max(incrementalPeakRssBytes, process.memoryUsage().rss);
        }),
    }).pipe(Effect.ensuring(Effect.sync(() => incrementalRss.stop())));
    const incrementalFinishedAt = yield* Clock.currentTimeNanos;
    incrementalPeakRssBytes = Math.max(incrementalPeakRssBytes, incrementalRss.peak(), process.memoryUsage().rss);
    const incrementalDatabaseBytes = Number((yield* fs.stat(databasePath)).size);
    const database = new Database(databasePath, {readonly: true});
    const storage = (() => {
      try {
        return {
          chunkMappings: count(database, 'vector_chunks'),
          generations: count(database, 'vector_generations'),
          vectorValues: count(database, 'vector_values'),
        };
      } finally {
        database.close();
      }
    })();
    const sortedQueryDurations = queryDurations.sort((left, right) => left - right);
    const result = {
      database: {
        bytesAfterIncremental: incrementalDatabaseBytes,
        bytesAfterInitial: initialDatabaseBytes,
        incrementalBytes: incrementalDatabaseBytes - initialDatabaseBytes,
        ...storage,
      },
      environment: {
        architecture: process.arch,
        bun: Bun.version,
        operatingSystem: process.platform,
      },
      fixture: {
        dimensions: manifest.dimensions,
        documents: options.documents,
        querySamples: options.samples,
      },
      scenarios: {
        incrementalBuild: {
          embeddedChunks: incremental.embeddedChunkCount,
          milliseconds: Number(incrementalFinishedAt - incrementalStartedAt) / NANOSECONDS_PER_MILLISECOND,
          peakRssBytes: incrementalPeakRssBytes,
          reusedChunks: incremental.reusedChunkCount,
        },
        initialBuild: {
          embeddedChunks: initial.embeddedChunkCount,
          milliseconds: Number(initialFinishedAt - initialStartedAt) / NANOSECONDS_PER_MILLISECOND,
          peakRssBytes: initialPeakRssBytes,
        },
        semanticQuery: {
          p50Milliseconds: percentile(sortedQueryDurations, 0.5),
          p95Milliseconds: percentile(sortedQueryDurations, 0.95),
          peakRssBytes: queryRssAfterBytes,
          resultCount: Math.min(VECTOR_QUERY_RESULT_LIMIT, options.documents),
          rssDeltaBytes: Math.max(0, queryRssAfterBytes - queryRssBeforeBytes),
          rssAfterBytes: queryRssAfterBytes,
          rssBeforeBytes: queryRssBeforeBytes,
          samples: options.samples,
        },
      },
      suite: 'recall-vector-storage-v1',
      version: 1,
    };
    yield* Console.log(JSON.stringify(result, undefined, 2));
    if (options.output) {
      yield* fs.makeDirectory(path.dirname(options.output), {recursive: true});
      yield* fs.writeFileString(options.output, `${JSON.stringify(result, undefined, 2)}\n`);
    }
    if (options.failOnBudget) {
      const scale = options.documents / DEFAULT_DOCUMENT_COUNT;
      const boundedScale = Math.max(1, scale);
      if (result.scenarios.semanticQuery.p95Milliseconds > boundedScale * 750) {
        return yield* Effect.fail(new Error('Semantic vector query exceeded its linear scale budget.'));
      }
      if (result.scenarios.initialBuild.milliseconds > boundedScale * 15_000) {
        return yield* Effect.fail(new Error('Initial vector build exceeded its linear scale budget.'));
      }
      if (result.scenarios.incrementalBuild.milliseconds > boundedScale * 3_000) {
        return yield* Effect.fail(new Error('Incremental vector build exceeded its linear scale budget.'));
      }
      if (result.scenarios.initialBuild.peakRssBytes > boundedScale * 768 * MEBIBYTE) {
        return yield* Effect.fail(new Error('Initial vector build exceeded its bounded-memory budget.'));
      }
      if (result.scenarios.incrementalBuild.peakRssBytes > boundedScale * 768 * MEBIBYTE) {
        return yield* Effect.fail(new Error('Incremental vector build exceeded its bounded-memory budget.'));
      }
      if (result.scenarios.semanticQuery.rssDeltaBytes > 128 * MEBIBYTE) {
        return yield* Effect.fail(new Error('Semantic vector query exceeded its bounded-memory budget.'));
      }
      if (result.database.bytesAfterInitial > options.documents * 4_096 + 4 * MEBIBYTE) {
        return yield* Effect.fail(new Error('Vector database exceeded its per-document storage budget.'));
      }
      if (result.database.incrementalBytes > 64 * 1024) {
        return yield* Effect.fail(new Error('Incremental vector build caused unexpected database growth.'));
      }
      if (incremental.embeddedChunkCount !== 1 || incremental.reusedChunkCount !== options.documents - 1) {
        return yield* Effect.fail(new Error('Incremental vector build did not reuse all unchanged chunks.'));
      }
      if (storage.vectorValues !== options.documents || storage.chunkMappings !== options.documents) {
        return yield* Effect.fail(new Error('Content-addressed vector storage duplicated unchanged vector values.'));
      }
    }
  }),
);

BunRuntime.runMain(program.pipe(Effect.provide(benchmarkLayer)));

function deterministicVector(dimensions: number, input: string): readonly number[] {
  const numeric = Number(/(\d+)(?!.*\d)/.exec(input)?.[1] ?? 0);
  const vector = new Array<number>(dimensions).fill(0);
  const primary = numeric % dimensions;
  const secondary = (primary + Math.floor(numeric / dimensions) + 1) % dimensions;
  vector[primary] = 2 / Math.sqrt(5);
  vector[secondary] = 1 / Math.sqrt(5);
  return vector;
}

function startRssSampler(): {readonly peak: () => number; readonly stop: () => void} {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 2);
  return {
    peak: () => peak,
    stop: () => clearInterval(timer),
  };
}

function modelInstallation(home: string) {
  return {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: `${home}/models/benchmark.gguf`,
    verified: true,
  };
}

function count(database: Database, table: string): number {
  return Number((database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {readonly count: number}).count);
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function parseOptions(arguments_: readonly string[]): {
  readonly documents: number;
  readonly failOnBudget: boolean;
  readonly output?: string;
  readonly samples: number;
} {
  let documents = DEFAULT_DOCUMENT_COUNT;
  let failOnBudget = false;
  let output: string | undefined;
  let samples = DEFAULT_QUERY_SAMPLES;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === '--documents') documents = positiveInteger(arguments_[++index], '--documents');
    else if (argument === '--samples') samples = positiveInteger(arguments_[++index], '--samples');
    else if (argument === '--output') output = arguments_[++index];
    else if (argument === '--fail-on-budget') failOnBudget = true;
    else throw new Error(`Unknown vector benchmark option: ${argument}`);
  }
  return {...(output ? {output} : {}), documents, failOnBudget, samples};
}

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${option} requires a positive integer.`);
  return parsed;
}
