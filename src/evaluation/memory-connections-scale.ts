import {Clock, Data, DateTime, Effect, FileSystem, Path} from 'effect';
import {MEMORY_SCHEMA_VERSION} from '../memory/code_citation.js';
import {readMemoryRecordsByUri} from '../memory/commands.js';
import {formatMemoryDocument, type MemoryMetadata, type MemoryRelation} from '../memory/document.js';
import {loadRecallIndexData, recallIndexStatus} from '../recall/index.js';
import {projectRecallMcpResponse} from '../recall/mcp_response.js';
import {retrieveRecallMemoryConnections} from '../recall/memory_connections.js';
import type {RuntimeConfig} from '../types.js';
import {
  MEMORY_CONNECTIONS_SCALE_FIXTURE,
  MEMORY_CONNECTIONS_SCALE_SCENARIOS,
  memoryConnectionsScaleExpectedIds,
  memoryConnectionsScaleFixtureHash,
  type MemoryConnectionsScaleCaptureV1,
  type MemoryConnectionsScaleObservationV1,
  type MemoryConnectionsScaleScenarioId,
} from './memory-connections-scale-contract.js';

const MINIMUM_CORPUS_SIZE = 14;
const WRITE_BATCH_SIZE = 1_000;
const WRITE_CONCURRENCY = 64;
const FIXED_TIMESTAMP = '2026-08-31T00:00:00.000Z';
const encoder = new TextEncoder();

export interface MemoryConnectionsScaleWorkloadOptions {
  readonly memoryCandidates: number;
  readonly samples: number;
  readonly warmups: number;
}

class MemoryConnectionsScaleError extends Data.TaggedError('MemoryConnectionsScaleError')<{
  readonly message: string;
}> {}

/** Materialize, index, and sample the full seeded one-hop retrieval path. */
export const runMemoryConnectionsScaleWorkload = Effect.fn('evaluation.memoryConnectionsScale')(function* (
  options: MemoryConnectionsScaleWorkloadOptions,
) {
  validateOptions(options);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-connections-scale-'});
  Bun.gc(true);
  const baselineRssBytes = process.memoryUsage().rss;
  return yield* Effect.acquireUseRelease(
    Effect.sync(startRssSampler),
    rss =>
      Effect.gen(function* () {
        const materializationStarted = yield* Clock.currentTimeNanos;
        const corpus = yield* materializeCorpus(fs, path, root, options.memoryCandidates, rss.observe);
        const materializationFinished = yield* Clock.currentTimeNanos;
        const indexStarted = yield* Clock.currentTimeNanos;
        yield* loadRecallIndexData(corpus.config, {
          forceRefresh: true,
          includeInactive: true,
          onProgress: () => Effect.sync(rss.observe),
        });
        const indexFinished = yield* Clock.currentTimeNanos;
        const status = yield* recallIndexStatus(corpus.config, true);
        if (!status.ready || status.documentCount !== options.memoryCandidates) {
          return yield* new MemoryConnectionsScaleError({
            message: `Recall index contains ${status.documentCount}/${options.memoryCandidates} memories.`,
          });
        }
        const scenarios = yield* Effect.forEach(
          MEMORY_CONNECTIONS_SCALE_SCENARIOS,
          id => runScenario(corpus.config, id, options),
          {concurrency: 1},
        );
        const storage = yield* recallStorageBytes(fs, status.databasePath);
        rss.observe();
        const peakRssBytes = rss.peak();
        return {
          corpus: {
            authorizedHubMemoryCount: corpus.authorizedHubMemoryCount,
            corpusBytes: corpus.bytes,
            indexedMemoryCount: status.documentCount,
            materializedMemoryCount: options.memoryCandidates,
          },
          fixtureHash: memoryConnectionsScaleFixtureHash(),
          resources: {
            addedPeakRssBytes: Math.max(0, peakRssBytes - baselineRssBytes),
            baselineRssBytes,
            indexBuildMilliseconds: elapsed(indexStarted, indexFinished),
            materializationMilliseconds: elapsed(materializationStarted, materializationFinished),
            peakRssBytes,
            recallDatabaseBytes: storage.database,
            recallStorageBytes: storage.total,
          },
          scenarios,
        } satisfies MemoryConnectionsScaleCaptureV1;
      }),
    rss => Effect.sync(rss.stop),
  );
});

const materializeCorpus = Effect.fn('evaluation.memoryConnectionsScale.materialize')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  memoryCandidates: number,
  observeRss: () => void,
) {
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: path.join(root, 'threadnote-home'),
    agentId: 'memory-connections-scale',
    manifestPath: path.join(root, 'manifest.yaml'),
    user: MEMORY_CONNECTIONS_SCALE_FIXTURE.user,
  };
  const fixed = [
    document('hub-seed', 'tn_scale_hub'),
    document('sparse-seed', 'tn_scale_sparse'),
    document('sparse-a', 'tn_sparse_a', [relationTo('tn_scale_sparse')]),
    document('sparse-b', 'tn_sparse_b', [relationTo('tn_scale_sparse')]),
    document('empty', 'tn_scale_empty'),
  ];
  let bytes = 0;
  for (const item of fixed) bytes += yield* writeDocument(fs, path, config, item);
  bytes += yield* writeDocument(
    fs,
    path,
    config,
    document('foreign-hub', 'tn_foreign_hub', [relationTo('tn_scale_hub')], 'outside'),
  );
  const authorizedHubMemoryCount = memoryCandidates - fixed.length - 1;
  for (let offset = 0; offset < authorizedHubMemoryCount; offset += WRITE_BATCH_SIZE) {
    const end = Math.min(authorizedHubMemoryCount, offset + WRITE_BATCH_SIZE);
    const shard = String(Math.floor(offset / WRITE_BATCH_SIZE)).padStart(3, '0');
    const batchBytes = yield* Effect.forEach(
      Array.from({length: end - offset}, (_, index) => offset + index),
      index =>
        writeDocument(
          fs,
          path,
          config,
          document(`hub/${shard}/hub-${String(index).padStart(6, '0')}`, `tn_hub_${String(index).padStart(6, '0')}`, [
            relationTo('tn_scale_hub'),
          ]),
        ),
      {concurrency: WRITE_CONCURRENCY},
    );
    bytes += batchBytes.reduce((total, value) => total + value, 0);
    observeRss();
    yield* Effect.yieldNow;
  }
  return {authorizedHubMemoryCount, bytes, config};
});

const runScenario = Effect.fn('evaluation.memoryConnectionsScale.scenario')(function* (
  config: RuntimeConfig,
  id: MemoryConnectionsScaleScenarioId,
  options: MemoryConnectionsScaleWorkloadOptions,
) {
  const run = () => runLookup(config, id);
  const cold = yield* run();
  const warmups = yield* Effect.forEach(Array.from({length: options.warmups}), run, {concurrency: 1});
  const samples = yield* Effect.forEach(Array.from({length: options.samples}), run, {concurrency: 1});
  const fixture = MEMORY_CONNECTIONS_SCALE_FIXTURE.scenarios.find(value => value.id === id)!;
  return {
    cold,
    expectedMemoryIds: memoryConnectionsScaleExpectedIds(id),
    expectedTruncated: fixture.expectedTruncated,
    id,
    samples,
    warmups,
  };
});

const runLookup = Effect.fn('evaluation.memoryConnectionsScale.lookup')(function* (
  config: RuntimeConfig,
  id: MemoryConnectionsScaleScenarioId,
) {
  const fixture = MEMORY_CONNECTIONS_SCALE_FIXTURE.scenarios.find(value => value.id === id)!;
  const started = yield* Clock.currentTimeNanos;
  const result = yield* retrieveRecallMemoryConnections(config, {
    allowedUriScopes: [memoryProjectRoot(config.user)],
    limit: 8,
    memoryRefs: [`threadnote://memory/${fixture.premiseMemoryId}`],
    now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-08-31T12:00:00.000Z')),
    readRecords: uris => readMemoryRecordsByUri(config, uris),
  });
  const projection = projectRecallMcpResponse(
    {
      memoryConnections: result,
      queryExpansions: [],
      rankerVersion: 'memory-connections-scale-v1',
      results: result.candidates.map(candidate => ({
        category: 'memories',
        contextType: 'memory',
        score: 1,
        snippet: '',
        uri: candidate.uri,
      })),
    },
    {budgetTokens: 1_500},
  );
  const wire = JSON.parse(JSON.stringify(projection.structuredContent)) as typeof projection.structuredContent;
  const wireConnections = wire.memoryConnections?.connections ?? [];
  const wirePremises = wire.memoryConnections?.premises ?? [];
  const memoryIdByUri = new Map(
    result.candidates.flatMap(candidate => (candidate.memoryId ? [[candidate.uri, candidate.memoryId] as const] : [])),
  );
  const finished = yield* Clock.currentTimeNanos;
  return {
    canonicalRereads: result.diagnostics.canonicalRereads,
    estimatedTokens: projection.measurement.estimatedTokens,
    milliseconds: elapsed(started, finished),
    omittedConnectionReceiptCount: Math.max(0, result.connections.length - wireConnections.length),
    omittedPremiseReceiptCount: Math.max(0, result.premises.length - wirePremises.length),
    projectedConnections: wireConnections.map(connection => ({
      currentness: connection.currentness,
      direction: connection.direction,
      distance: connection.distance,
      neighborMemoryId: connection.neighborMemoryId ?? null,
      origin: connection.origin,
      relationOrdinal: connection.relationOrdinal,
      relationType: connection.relationType,
      requestedOrdinal: connection.requestedOrdinal,
      resolution: connection.resolution,
      sourceMemoryId: connection.sourceMemoryId ?? null,
      targetMemoryId: connection.targetMemoryId ?? null,
    })),
    projectedCoverageConnectionCount: wire.memoryConnections?.coverage.connectionCount ?? -1,
    projectedCoveragePremiseCount: wire.memoryConnections?.coverage.premiseCount ?? -1,
    projectedCoverageResultCount: wire.memoryConnections?.coverage.resultCount ?? -1,
    projectedConnectionCoverageTruncated: wire.memoryConnections?.coverage.truncated ?? true,
    projectedOutputTruncated: wire.output.truncated,
    projectedPremises: wirePremises.map(premise => ({
      memoryId: premise.memoryId ?? null,
      requestedOrdinal: premise.requestedOrdinal,
      state: premise.state,
    })),
    rawLinkRows: result.diagnostics.rawLinkRows,
    retrievalTruncated: result.coverage.truncated,
    returnedMemoryIds: wire.results.flatMap(candidate => {
      const memoryId = memoryIdByUri.get(candidate.uri);
      return memoryId ? [memoryId] : [];
    }),
  } satisfies MemoryConnectionsScaleObservationV1;
});

interface ScaleDocument {
  readonly memoryId: string;
  readonly project: string;
  readonly relations: readonly MemoryRelation[];
  readonly topic: string;
}

function document(
  topic: string,
  memoryId: string,
  relations: readonly MemoryRelation[] = [],
  project = 'threadnote',
): ScaleDocument {
  return {memoryId, project, relations, topic};
}

function relationTo(memoryId: string): MemoryRelation {
  return {type: 'related_to', uri: `threadnote://memory/${memoryId}`};
}

const writeDocument = Effect.fn('evaluation.memoryConnectionsScale.writeDocument')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RuntimeConfig,
  item: ScaleDocument,
) {
  const target = path.join(
    config.agentContextHome,
    'data',
    config.account,
    'user',
    config.user,
    'memories',
    'durable',
    'projects',
    item.project,
    `${item.topic}.md`,
  );
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId: item.memoryId,
    project: item.project,
    relations: item.relations,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceAgentClient: 'memory-connections-scale',
    status: 'active',
    timestamp: FIXED_TIMESTAMP,
    topic: item.topic.split('/').at(-1),
  };
  const content = formatMemoryDocument('MEMORY', metadata, 'Deterministic one-hop scale fixture memory.');
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(target, content);
  return encoder.encode(content).byteLength;
});

function memoryProjectRoot(user: string): string {
  return `threadnote://user/${user}/memories/durable/projects/threadnote`;
}

function recallStorageBytes(fs: FileSystem.FileSystem, databasePath: string) {
  return Effect.gen(function* () {
    const sizes = yield* Effect.forEach(
      [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`],
      candidate =>
        fs.stat(candidate).pipe(
          Effect.map(value => Number(value.size)),
          Effect.orElseSucceed(() => 0),
        ),
      {concurrency: 4},
    );
    return {database: sizes[0], total: sizes.reduce((total, size) => total + size, 0)};
  });
}

function startRssSampler(): {readonly observe: () => void; readonly peak: () => number; readonly stop: () => void} {
  let peak = process.memoryUsage().rss;
  const observe = () => {
    peak = Math.max(peak, process.memoryUsage().rss);
  };
  const timer = setInterval(observe, 5);
  return {observe, peak: () => peak, stop: () => clearInterval(timer)};
}

function elapsed(started: bigint, finished: bigint): number {
  return Number(finished - started) / 1_000_000;
}

function validateOptions(options: MemoryConnectionsScaleWorkloadOptions): void {
  if (!Number.isSafeInteger(options.memoryCandidates) || options.memoryCandidates < MINIMUM_CORPUS_SIZE) {
    throw new MemoryConnectionsScaleError({message: `memoryCandidates must be at least ${MINIMUM_CORPUS_SIZE}.`});
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 1) {
    throw new MemoryConnectionsScaleError({message: 'samples must be a positive safe integer.'});
  }
  if (!Number.isSafeInteger(options.warmups) || options.warmups < 0) {
    throw new MemoryConnectionsScaleError({message: 'warmups must be a non-negative safe integer.'});
  }
}
