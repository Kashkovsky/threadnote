import {Clock, Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {SystemInfo} from '../effect/system.js';
import {codeGraphBlobExtractionReuseClass, codeGraphBlobReuseCacheKey} from './blob_reuse.js';
import {CODE_GRAPH_CACHE_TRANSACTION_LIMITS, codeGraphFileBlobCapacityBytes} from './cache_capacity.js';
import {
  codeGraphDiskCapacityFailure,
  codeGraphPersistentCapacityDemand,
  type CodeGraphDirectPersistentCapacityBoundary,
} from './disk_capacity.js';
import {
  codeGraphDiskReservationFilesystemKey,
  type CodeGraphDiskReservationOptions,
  withCodeGraphDiskReservation,
} from './disk_reservation.js';
import {planCodeGraphExtractionLanes} from './extraction_lanes.js';
import {extractRepositoryFileFacts} from './extractor.js';
import {
  budgetCachedCodeGraphFacts,
  cachedCodeGraphFactBytes,
  CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
  serializeBoundedCodeGraphFact,
  type BoundedCodeGraphFact,
} from './fact_budget.js';
import {CodeGraphIndexOperationError, sameOverlayState, WorktreeChangedDuringIndex} from './indexer_shared.js';
import type {DirectPersistentCapacityProtection} from './indexer_types.js';
import {
  worktreeBuildRequestState,
  type CodeGraphContentBatchContext,
  type CodeGraphInventoryOptions,
} from './inventory.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY, type CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import {relocateStructuredSchemaFacts} from './languages/schemas/extractor.js';
import {codeGraphDiskReservationLockPath, codeGraphDiskReservationRoot, type CodeGraphLayout} from './layout.js';
import {compareCodeUnits} from './ordering.js';
import {budgetParserWorkerFacts, type CodeGraphParserPoolShape, type CodeGraphParserResult} from './parser_worker.js';
import {
  codeGraphExtractionWorkUnits,
  codeGraphSourceSizeBucket,
  type CodeGraphScanningMetrics,
} from './progress_telemetry.js';
import {repositoryIdentityMatchesExpectation, resolveRepositoryIdentity} from './repository.js';
import {
  CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION,
  type CodeGraphDirectPersistentCapacityProtector,
  type CodeGraphLanguagePackProvenance,
  type CodeGraphStagingProgress,
  type CodeGraphStoreShape,
} from './store.js';
import {inspectCodeGraphStorage} from './storage.js';
import {TreeSitterRuntime, type TreeSitterRuntimeShape} from './tree_sitter/runtime.js';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  type CodeGraphEdge,
  type CodeGraphFileFacts,
  type CodeGraphInventoryFile,
  type CodeGraphMaterializationRows,
  type CodeGraphProgress,
  type CodeGraphReference,
  type CodeGraphSymbol,
  type RepositoryIdentity,
} from './types.js';

export interface DirectPersistentCapacityContext {
  readonly capacityProtection?: DirectPersistentCapacityProtection;
  readonly claimMode?: CodeGraphDiskReservationOptions['claimMode'];
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly layout: CodeGraphLayout;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly threadnoteHome: string;
}

export function codeGraphDirectPersistentCapacityProtector(
  input: DirectPersistentCapacityContext,
): CodeGraphDirectPersistentCapacityProtector {
  return (boundary, transaction) =>
    input.capacityProtection
      ? withCodeGraphDiskReservation(
          {
            boundary,
            claimMode: input.claimMode,
            ledgerLockPath: codeGraphDiskReservationLockPath(input.capacityProtection.path, input.threadnoteHome),
            ledgerRoot: codeGraphDiskReservationRoot(input.capacityProtection.path, input.threadnoteHome),
            maintenance: input.capacityProtection.maintenance
              .tick({
                allowIndexPreparation: true,
                anchorIdentity: input.identity,
                automaticTail: false,
                checkoutId: input.layout.checkoutId,
                databasePath: input.layout.databasePath,
                joinActive: false,
                pressure: 'critical',
                threadnoteHome: input.threadnoteHome,
                writerLockPath: input.layout.databaseWriteLockPath,
              })
              .pipe(
                Effect.catch(error => (['busy', 'no-space'].includes(error.code) ? Effect.void : Effect.fail(error))),
              ),
            observe: observeDirectPersistentCapacity({
              boundary,
              fs: input.fs,
              identity: input.identity,
              layout: input.layout,
              protection: input.capacityProtection,
              threadnoteHome: input.threadnoteHome,
            }),
            onDiagnostic: diagnostic => Effect.logWarning(diagnostic),
            onWaiting: (input.onProgress?.({phase: 'waiting', reason: 'disk-capacity'}) ?? Effect.void).pipe(
              Effect.catch(() => Effect.void),
            ),
          },
          transaction,
        ).pipe(
          Effect.provideService(Crypto.Crypto, input.capacityProtection.crypto),
          Effect.provideService(FileSystem.FileSystem, input.fs),
          Effect.provideService(Path.Path, input.capacityProtection.path),
          Effect.provideService(SystemInfo, input.capacityProtection.system),
        )
      : Effect.fail(
          codeGraphDiskCapacityFailure(
            {
              calibrationIdentity: 'direct-persistent-capacity-unavailable',
              reason: 'calibration-input-unknown',
              state: 'unknown',
            },
            boundary.operation,
          ),
        );
}

export function promoteReadySnapshotWithCapacity(
  input: DirectPersistentCapacityContext & {readonly store: CodeGraphStoreShape},
  snapshotId: string,
) {
  return input.store.promote(input.layout.databasePath, input.identity, snapshotId, {
    persistentCapacityProtector: codeGraphDirectPersistentCapacityProtector(input),
  });
}

export interface CodeGraphCacheExtractedRow {
  readonly cacheFact: BoundedCodeGraphFact;
  readonly cacheIdentity: string;
  readonly degraded: boolean;
  readonly file: CodeGraphInventoryFile;
}

export interface CodeGraphCacheContentCoalescer {
  /** @internal Accepts already-extracted rows for bounded structural/load tests. */
  readonly acceptExtracted: (
    rows: readonly CodeGraphCacheExtractedRow[],
    context: CodeGraphContentBatchContext,
  ) => Effect.Effect<void, unknown>;
  /** Starts exact path accounting for a bounded sparse-admission attempt. */
  readonly beginSparseExtractionTracking: Effect.Effect<void>;
  /** Marks the committed-to-worktree extraction boundary, even for deletion-only overlays. */
  readonly beginOverlayExtraction: Effect.Effect<void>;
  /** Drops references only. This is safe in failure/cancellation cleanup because it never starts a write. */
  readonly discard: Effect.Effect<void>;
  /** Stops sparse-attempt path accounting while retaining its terminal count. */
  readonly endSparseExtractionTracking: Effect.Effect<void>;
  /** Exact serialized fact bytes extracted in the current inventory phase. */
  readonly extractedFactBytes: Effect.Effect<number>;
  /** Flushes pending rows and is called only after inventory succeeds. */
  readonly flush: Effect.Effect<void, unknown>;
  readonly onContentBatch: NonNullable<CodeGraphInventoryOptions['onContentBatch']>;
  /** Unique paths extracted during the bounded sparse-admission attempt. */
  readonly sparseExtractedFiles: Effect.Effect<number>;
}

const CODE_GRAPH_CACHE_TIMESTAMP_CAPACITY_PLACEHOLDER = '1970-01-01T00:00:00.000Z';

function codeGraphFileProgressDimensions(
  file: CodeGraphInventoryFile,
  languagePacks: CodeGraphLanguagePackRegistryShape,
) {
  const matched = Option.getOrUndefined(languagePacks.match(file.path));
  return {
    classifier: matched?.pack.id ?? 'unmatched',
    role: matched?.role ?? 'unmatched',
    sizeBucket: codeGraphSourceSizeBucket(file.size),
  } as const;
}

/** @internal Exposed for cache coalescing/cancellation contract tests. */
export function cacheContentBatch(options: {
  readonly databasePath: string;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly parserPool: CodeGraphParserPoolShape;
  readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
  readonly treeSitter: TreeSitterRuntimeShape;
}): CodeGraphCacheContentCoalescer {
  const windowSize = Math.max(1, options.parserPool.capacity * 2);
  let extractionMilliseconds = 0;
  let extractionFactsBytesCompleted = 0;
  let extractionDegradedFiles = 0;
  let extractionSourceBytesCompleted = 0;
  let extractionWorkUnitsCompleted = 0;
  let extractionPlan = undefined as CodeGraphContentBatchContext['extractionPlan'];
  let extractionPhase: 'none' | 'planned' | 'unplanned' = 'none';
  let sparseExtractionTracking = false;
  const sparseExtractedPaths = new Set<string>();
  let terminalExtractedFactBytes = 0;
  let persistenceMilliseconds = 0;
  let readingMilliseconds = 0;
  let pendingBytes = 0;
  let pendingRows = 0;
  let latestContext: CodeGraphContentBatchContext | undefined;
  type PendingCacheGroup = {
    readonly cacheIdentity: string;
    readonly facts: BoundedCodeGraphFact[];
    readonly files: CodeGraphInventoryFile[];
    readonly paths: Set<string>;
    payloadBytes: number;
  };
  const pendingGroups = new Map<string, PendingCacheGroup>();
  const currentScanningMetrics = (): CodeGraphScanningMetrics | undefined =>
    extractionPlan === undefined
      ? undefined
      : {
          factsBytesCompleted: extractionFactsBytesCompleted,
          degradedFiles: extractionDegradedFiles,
          sourceBytesCompleted: extractionSourceBytesCompleted,
          sourceBytesTotal: extractionPlan.sourceBytesTotal,
          workUnitsCompleted: extractionWorkUnitsCompleted,
          workUnitsTotal: extractionPlan.workUnitsTotal,
        };
  const observeExtractionPlan = (plan: CodeGraphContentBatchContext['extractionPlan']) => {
    if (plan === undefined) {
      if (extractionPhase !== 'unplanned') terminalExtractedFactBytes = 0;
      extractionPhase = 'unplanned';
      extractionPlan = undefined;
      extractionFactsBytesCompleted = 0;
      extractionDegradedFiles = 0;
      extractionSourceBytesCompleted = 0;
      extractionWorkUnitsCompleted = 0;
      return;
    }
    if (
      extractionPhase !== 'planned' ||
      extractionPlan === undefined ||
      extractionPlan.sourceBytesTotal !== plan.sourceBytesTotal ||
      extractionPlan.workUnitsTotal !== plan.workUnitsTotal
    ) {
      terminalExtractedFactBytes = 0;
      extractionFactsBytesCompleted = 0;
      extractionDegradedFiles = 0;
      extractionSourceBytesCompleted = 0;
      extractionWorkUnitsCompleted = 0;
    }
    extractionPhase = 'planned';
    extractionPlan = plan;
  };
  const completeExtractionMetrics = (file: CodeGraphInventoryFile, factsBytes: number) => {
    terminalExtractedFactBytes = Math.min(Number.MAX_SAFE_INTEGER, terminalExtractedFactBytes + factsBytes);
    if (extractionPlan === undefined) return undefined;
    extractionFactsBytesCompleted = Math.min(Number.MAX_SAFE_INTEGER, extractionFactsBytesCompleted + factsBytes);
    extractionSourceBytesCompleted = Math.min(
      extractionPlan.sourceBytesTotal,
      extractionSourceBytesCompleted + file.size,
    );
    extractionWorkUnitsCompleted = Math.min(
      extractionPlan.workUnitsTotal,
      extractionWorkUnitsCompleted +
        codeGraphExtractionWorkUnits(file.size, file.language, codeGraphSourceSizeBucket(file.size)),
    );
    return currentScanningMetrics();
  };
  type SerializedParserResult = CodeGraphParserResult & {readonly cacheFact: BoundedCodeGraphFact};
  const reusableExtractions = new Map<string, SerializedParserResult>();
  const reusableExtractionUses = new Map<string, number>();
  const flushPendingGroup = (key: string) =>
    Effect.gen(function* () {
      const group = pendingGroups.get(key);
      if (!group || group.files.length === 0) return;
      const context = latestContext;
      if (!context)
        return yield* Effect.fail(
          new CodeGraphIndexOperationError('Code graph cache persistence context is unavailable.'),
        );
      const representative = group.files[0]!;
      const groupBytes = group.files.reduce((total, file) => total + file.size, 0);
      const groupFactBytes = group.facts.reduce((total, fact) => total + fact.bytes, 0);
      yield* emitContentProgress(
        options.onProgress,
        context,
        {
          batchCompleted: 0,
          batchTotal: group.files.length,
          bytes: groupBytes,
          ...codeGraphFileProgressDimensions(representative, options.languagePacks),
          factsBytes: groupFactBytes,
          language: representative.language,
          path: representative.path,
          sizeBucket: codeGraphSourceSizeBucket(groupBytes),
          stage: 'persisting',
        },
        extractionMilliseconds,
        persistenceMilliseconds,
        currentScanningMetrics(),
      );
      const startedAt = performance.now();
      yield* options.store.cacheFacts(
        options.databasePath,
        group.files,
        group.facts,
        group.cacheIdentity,
        options.persistentCapacityProtector,
      );
      const elapsed = Math.max(0, performance.now() - startedAt);
      persistenceMilliseconds += elapsed;
      pendingBytes -= group.payloadBytes;
      pendingRows -= group.files.length;
      pendingGroups.delete(key);
      yield* emitContentProgress(
        options.onProgress,
        context,
        {
          batchCompleted: group.files.length,
          batchTotal: group.files.length,
          bytes: groupBytes,
          ...codeGraphFileProgressDimensions(representative, options.languagePacks),
          factsBytes: groupFactBytes,
          language: representative.language,
          path: representative.path,
          persistMilliseconds: elapsed,
          relations: group.facts.reduce((total, fact) => total + fact.facts.edges.length, 0),
          sizeBucket: codeGraphSourceSizeBucket(groupBytes),
          stage: 'persisting',
          symbols: group.facts.reduce((total, fact) => total + fact.facts.symbols.length, 0),
        },
        extractionMilliseconds,
        persistenceMilliseconds,
        currentScanningMetrics(),
      );
    });
  const flushOldestPendingGroup = () => {
    const key = pendingGroups.keys().next().value as string | undefined;
    return key === undefined ? Effect.void : flushPendingGroup(key);
  };
  const acceptExtracted = (rows: readonly CodeGraphCacheExtractedRow[], context: CodeGraphContentBatchContext) =>
    Effect.gen(function* () {
      latestContext = context;
      for (const {cacheFact, cacheIdentity: activeCacheIdentity, degraded, file} of rows) {
        if (sparseExtractionTracking) sparseExtractedPaths.add(file.path);
        const cacheIdentity = degraded ? degradedParserCacheIdentity(activeCacheIdentity) : activeCacheIdentity;
        const key = `${degraded ? 'degraded' : 'durable'}\0${cacheIdentity}`;
        const reuseClass = degraded ? undefined : codeGraphBlobExtractionReuseClass(file);
        const rowBytes = codeGraphFileBlobCapacityBytes({
          ...(reuseClass === undefined ? {} : {blobId: file.blobId, reuseClass}),
          contentHash: file.contentHash,
          createdAt: CODE_GRAPH_CACHE_TIMESTAMP_CAPACITY_PLACEHOLDER,
          extractorSet: cacheIdentity,
          factsJson: cacheFact.json,
          path: file.path,
        });
        if (rowBytes > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes) {
          return yield* Effect.fail(
            new CodeGraphIndexOperationError(`Code graph cache row exceeds the persistence payload ceiling.`),
          );
        }
        while (
          pendingRows > 0 &&
          (pendingRows >= CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows ||
            pendingBytes > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes - rowBytes)
        ) {
          yield* flushOldestPendingGroup();
        }
        if (pendingGroups.get(key)?.paths.has(file.path)) {
          // Committed-tree and dirty-overlay inventory phases can extract the
          // same path with different content hashes. Both physical cache rows
          // are reusable, so flush the older row instead of deduplicating it.
          yield* flushPendingGroup(key);
        }
        const pending = pendingGroups.get(key) ?? {
          cacheIdentity,
          facts: [],
          files: [],
          paths: new Set<string>(),
          payloadBytes: 0,
        };
        if (!pendingGroups.has(key)) pendingGroups.set(key, pending);
        const {bytes: _bytes, content: _content, ...baseCacheFile} = file;
        const cacheFile = degraded ? {...baseCacheFile, blobId: ''} : baseCacheFile;
        pending.files.push(cacheFile);
        pending.facts.push(cacheFact);
        pending.paths.add(file.path);
        pending.payloadBytes += rowBytes;
        pendingBytes += rowBytes;
        pendingRows += 1;
      }
    });
  const onContentBatch = (
    files: Parameters<typeof extractRepositoryFileFacts>[0],
    context: CodeGraphContentBatchContext,
  ) =>
    Effect.gen(function* () {
      readingMilliseconds += context.readingMilliseconds;
      observeExtractionPlan(context.extractionPlan);
      const cumulativeContext = {...context, readingMilliseconds};
      latestContext = cumulativeContext;
      let parsedCompleted = 0;
      const orderedFiles = [...files].sort((left, right) => compareCodeUnits(left.path, right.path));
      const localReuseCounts = new Map<string, number>();
      for (const file of orderedFiles) {
        const reuseKey = blobReuseKeyForFile(file, options.languagePacks);
        if (reuseKey !== undefined) localReuseCounts.set(reuseKey, (localReuseCounts.get(reuseKey) ?? 0) + 1);
      }
      const expectedReuseCount = (key: string): number =>
        cumulativeContext.blobReuseCounts?.get(key) ?? localReuseCounts.get(key) ?? 0;
      const finishReuseAttempt = (key: string | undefined) => {
        if (key === undefined) return;
        const uses = (reusableExtractionUses.get(key) ?? 0) + 1;
        if (uses >= expectedReuseCount(key)) {
          reusableExtractionUses.delete(key);
          reusableExtractions.delete(key);
        } else {
          reusableExtractionUses.set(key, uses);
        }
      };
      for (const window of chunkValues(orderedFiles, windowSize)) {
        let windowCompleted = 0;
        const groups = extractionReuseGroups(window, options.languagePacks);
        const extractGroup = (group: (typeof groups)[number]) =>
          Effect.forEach(
            group.files,
            file =>
              Effect.gen(function* () {
                const reuseKey = group.reuseKey;
                yield* emitContentProgress(
                  options.onProgress,
                  cumulativeContext,
                  {
                    batchCompleted: parsedCompleted,
                    batchTotal: files.length,
                    bytes: file.size,
                    ...codeGraphFileProgressDimensions(file, options.languagePacks),
                    language: file.language,
                    path: file.path,
                    stage: 'extracting',
                  },
                  extractionMilliseconds,
                  persistenceMilliseconds,
                  currentScanningMetrics(),
                );
                const donor = reuseKey === undefined ? undefined : reusableExtractions.get(reuseKey);
                const reused = donor === undefined ? undefined : relocateSerializedParserResult(file, donor);
                if (reused !== undefined) {
                  finishReuseAttempt(reuseKey);
                  windowCompleted += 1;
                  yield* emitContentProgress(
                    options.onProgress,
                    cumulativeContext,
                    {
                      batchCompleted: parsedCompleted + windowCompleted,
                      batchTotal: files.length,
                      bytes: file.size,
                      ...codeGraphFileProgressDimensions(file, options.languagePacks),
                      degraded: false,
                      factsBytes: reused.cacheFact.bytes,
                      language: file.language,
                      parseMilliseconds: 0,
                      path: file.path,
                      relations: reused.facts.edges.length,
                      stage: 'extracting',
                      symbols: reused.facts.symbols.length,
                    },
                    extractionMilliseconds,
                    persistenceMilliseconds,
                    completeExtractionMetrics(file, reused.cacheFact.bytes),
                  );
                  return {file, result: reused};
                }
                const parsed = yield* extractParserFacts(file, options);
                const cacheFact = serializeBoundedCodeGraphFact(parsed.facts);
                const result = {
                  ...parsed,
                  cacheFact,
                  facts: cacheFact.facts,
                } satisfies CodeGraphParserResult & {readonly cacheFact: BoundedCodeGraphFact};
                if (result.degraded) extractionDegradedFiles += 1;
                if (!result.degraded && reuseKey !== undefined && expectedReuseCount(reuseKey) > 1) {
                  reusableExtractions.set(reuseKey, result);
                }
                finishReuseAttempt(reuseKey);
                windowCompleted += 1;
                yield* emitContentProgress(
                  options.onProgress,
                  cumulativeContext,
                  {
                    batchCompleted: parsedCompleted + windowCompleted,
                    batchTotal: files.length,
                    bytes: file.size,
                    ...codeGraphFileProgressDimensions(file, options.languagePacks),
                    degraded: result.degraded,
                    ...(result.degradationReason === undefined ? {} : {degradationReason: result.degradationReason}),
                    factsBytes: result.cacheFact.bytes,
                    language: file.language,
                    parseMilliseconds: result.parseMilliseconds,
                    path: file.path,
                    relations: result.facts.edges.length,
                    stage: 'extracting',
                    symbols: result.facts.symbols.length,
                  },
                  extractionMilliseconds + result.parseMilliseconds,
                  persistenceMilliseconds,
                  completeExtractionMetrics(file, result.cacheFact.bytes),
                );
                return {file, result};
              }),
            {concurrency: 1},
          );
        const groupedResults: Array<
          readonly {readonly file: CodeGraphInventoryFile; readonly result: SerializedParserResult}[]
        > = [];
        for (const lane of planCodeGraphExtractionLanes(groups, options.parserPool.capacity)) {
          groupedResults.push(...(yield* Effect.forEach(lane.groups, extractGroup, {concurrency: lane.concurrency})));
        }
        const results = groupedResults.flat();
        extractionMilliseconds += results.reduce((total, result) => total + result.result.parseMilliseconds, 0);
        parsedCompleted += results.length;
        const resultsByPath = new Map(results.map(result => [result.file.path, result.result]));
        const extractedRows: CodeGraphCacheExtractedRow[] = [];
        for (const group of groupFilesByCacheIdentity(window, options.languagePacks)) {
          const durableFiles = group.files.filter(file => !resultsByPath.get(file.path)!.degraded);
          const degradedFiles = group.files.filter(file => resultsByPath.get(file.path)!.degraded);
          for (const [degraded, cacheFiles] of [
            [false, durableFiles],
            [true, degradedFiles],
          ] as const) {
            for (const file of cacheFiles) {
              extractedRows.push({
                cacheFact: resultsByPath.get(file.path)!.cacheFact,
                cacheIdentity: group.cacheIdentity,
                degraded,
                file,
              });
            }
          }
        }
        yield* acceptExtracted(extractedRows, cumulativeContext);
      }
    });
  return {
    acceptExtracted,
    beginSparseExtractionTracking: Effect.sync(() => {
      sparseExtractedPaths.clear();
      sparseExtractionTracking = true;
    }),
    beginOverlayExtraction: Effect.sync(() => observeExtractionPlan(undefined)),
    discard: Effect.sync(() => {
      pendingGroups.clear();
      pendingBytes = 0;
      pendingRows = 0;
      latestContext = undefined;
      reusableExtractions.clear();
      reusableExtractionUses.clear();
    }),
    endSparseExtractionTracking: Effect.sync(() => {
      sparseExtractionTracking = false;
    }),
    extractedFactBytes: Effect.sync(() => terminalExtractedFactBytes),
    flush: Effect.gen(function* () {
      while (pendingGroups.size > 0) yield* flushOldestPendingGroup();
      reusableExtractions.clear();
      reusableExtractionUses.clear();
    }),
    onContentBatch,
    sparseExtractedFiles: Effect.sync(() => sparseExtractedPaths.size),
  };
}

function blobReuseKeyForFile(
  file: CodeGraphInventoryFile,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): string | undefined {
  const cacheIdentity = Option.getOrUndefined(languagePacks.cacheIdentityForPath(file.path));
  return cacheIdentity === undefined ? undefined : codeGraphBlobReuseCacheKey(file, cacheIdentity);
}

function extractionReuseGroups(
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): readonly {readonly files: readonly CodeGraphInventoryFile[]; readonly reuseKey?: string}[] {
  const groups = new Map<string, {files: CodeGraphInventoryFile[]; reuseKey?: string}>();
  for (const file of files) {
    const reuseKey = blobReuseKeyForFile(file, languagePacks);
    const key = reuseKey ?? `path\0${file.path}`;
    const group = groups.get(key) ?? {files: [], ...(reuseKey === undefined ? {} : {reuseKey})};
    if (!groups.has(key)) groups.set(key, group);
    group.files.push(file);
  }
  return [...groups.values()];
}

function relocateSerializedParserResult(
  file: CodeGraphInventoryFile,
  donor: CodeGraphParserResult & {readonly cacheFact: BoundedCodeGraphFact},
): (CodeGraphParserResult & {readonly cacheFact: BoundedCodeGraphFact}) | undefined {
  if (donor.degraded) return undefined;
  const relocated = relocateStructuredSchemaFacts(file, donor.facts);
  if (relocated === undefined) return undefined;
  const cacheFact = serializeBoundedCodeGraphFact(relocated);
  return {cacheFact, degraded: false, facts: cacheFact.facts, parseMilliseconds: 0};
}

function extractParserFacts(
  file: CodeGraphInventoryFile,
  options: {
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
    readonly parserPool: CodeGraphParserPoolShape;
    readonly threadnoteHome: string;
    readonly treeSitter: TreeSitterRuntimeShape;
  },
): Effect.Effect<CodeGraphParserResult, unknown> {
  if (file.bytes === undefined) return options.parserPool.extract(file, options.threadnoteHome);
  return Effect.gen(function* () {
    const startedAt = performance.now();
    const facts = yield* options.languagePacks
      .extractRawFile(file)
      .pipe(Effect.provideService(TreeSitterRuntime, options.treeSitter));
    const bounded = budgetParserWorkerFacts(file, facts);
    return {
      degraded: bounded.degraded,
      facts: bounded.facts,
      parseMilliseconds: Math.max(0, performance.now() - startedAt),
    };
  });
}

function emitContentProgress(
  onProgress: ((progress: CodeGraphProgress) => Effect.Effect<void, unknown>) | undefined,
  context: CodeGraphContentBatchContext,
  activity: NonNullable<Extract<CodeGraphProgress, {readonly phase: 'scanning'}>['activity']>,
  extractionMilliseconds: number,
  persistenceMilliseconds: number,
  metrics?: CodeGraphScanningMetrics,
) {
  return (
    onProgress?.({
      ...context.progress,
      activity,
      ...(metrics === undefined ? {} : {metrics}),
      timings: {
        extractionMilliseconds,
        persistenceMilliseconds,
        readingMilliseconds: context.readingMilliseconds,
      },
    }) ?? Effect.void
  );
}

function chunkValues<A>(values: readonly A[], size: number): readonly (readonly A[])[] {
  const chunks: A[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function degradedParserCacheIdentity(activeIdentity: string): string {
  return sha256HexSync(`code-graph-parser-degraded-v1\n${activeIdentity}`);
}

/** Cache generations that can satisfy inventory content admission for active parser packs. */
export function codeGraphParserCacheLookupGenerations(activeIdentities: readonly string[]): readonly {
  readonly activeIdentity: string;
  readonly storedIdentity: string;
}[] {
  return [...new Set(activeIdentities)].sort(compareCodeUnits).flatMap(activeIdentity => [
    {activeIdentity, storedIdentity: activeIdentity},
    {activeIdentity, storedIdentity: degradedParserCacheIdentity(activeIdentity)},
  ]);
}

/** Rebind a physical cache-generation key to the active identity expected by inventory admission. */
export function codeGraphActiveParserCacheKey(key: string, storedIdentity: string, activeIdentity: string): string {
  if (storedIdentity === activeIdentity) return key;
  const terminalGeneration = `\0${storedIdentity}`;
  if (key.endsWith(terminalGeneration)) return `${key.slice(0, -terminalGeneration.length)}\0${activeIdentity}`;
  const embeddedGeneration = `\0${storedIdentity}\0`;
  return key.includes(embeddedGeneration) ? key.replace(embeddedGeneration, () => `\0${activeIdentity}\0`) : key;
}

export const verifyIndexInput = Effect.fn('codeGraph.verifyIndexInput')(function* (
  identity: RepositoryIdentity,
  verifyOverlay: boolean,
  threadnoteHome: string,
  requestedOverlay?: {readonly dirty: boolean; readonly fingerprint?: string},
) {
  const verifiedIdentity = yield* resolveRepositoryIdentity(identity.repoRoot);
  if (
    !repositoryIdentityMatchesExpectation(verifiedIdentity, identity) ||
    (verifyOverlay && verifiedIdentity.headCommit !== identity.headCommit)
  ) {
    return yield* Effect.fail(new WorktreeChangedDuringIndex());
  }
  if (!verifyOverlay) return;
  if (!requestedOverlay) {
    return yield* Effect.fail(
      new CodeGraphIndexOperationError('Pointer activation requires an exact worktree build request state.'),
    );
  }
  const verifiedOverlay = yield* worktreeBuildRequestState(verifiedIdentity, threadnoteHome);
  if (!sameOverlayState(verifiedOverlay, requestedOverlay)) {
    return yield* Effect.fail(new WorktreeChangedDuringIndex());
  }
});

export function extractorSetIdentity(
  files: readonly {readonly contentHash: string; readonly path: string}[],
  languagePacks: CodeGraphLanguagePackRegistryShape = BUILTIN_LANGUAGE_PACK_REGISTRY,
): string {
  const paths = files.map(file => file.path);
  return extractorSetIdentityFromIdentities(
    languagePacks.activeCacheIdentities(paths),
    languagePacks.activeDerivationIdentities(paths),
  );
}

export function extractorSetIdentityFromPackProvenance(provenance: readonly CodeGraphLanguagePackProvenance[]): string {
  return extractorSetIdentityFromIdentities(
    [...new Set(provenance.map(pack => pack.cacheIdentity))],
    [...new Set(provenance.map(pack => pack.derivationIdentity))],
  );
}

function extractorSetIdentityFromIdentities(
  cacheIdentities: readonly string[],
  derivationIdentities: readonly string[],
): string {
  const activeParsers = [...cacheIdentities].sort(compareCodeUnits).join('\n');
  const activeDerivations = [...derivationIdentities].sort(compareCodeUnits).join('\n');
  return sha256HexSync(
    `${CODE_GRAPH_EXTRACTOR_SET_VERSION}\nactive-parser-packs:\n${activeParsers}\nactive-derivations:\n${activeDerivations}\nignore-policy:3\nresolution-context-policy:semantic-workspace-v1`,
  );
}

export function parserCacheIdentity(): string {
  const identity = BUILTIN_LANGUAGE_PACK_REGISTRY.cacheIdentityForPath('source.ts');
  return identity._tag === 'Some' ? identity.value : sha256HexSync(`${CODE_GRAPH_EXTRACTOR_SET_VERSION}:typescript`);
}

export function snapshotIdentity(
  identity: {
    readonly headCommit: string;
    readonly repositoryId: string;
    readonly worktreeId: string;
  },
  dirty: boolean,
  extractorSet: string,
  files: readonly {readonly contentHash: string; readonly path: string; readonly source: string}[],
): string {
  const inventory = files
    .map(file => `${file.path}\0${file.contentHash}\0${file.source}`)
    .sort()
    .join('\n');
  return `cgsn_${sha256HexSync(
    `snapshot-v2\nlexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}\n${identity.repositoryId}\n${dirty ? identity.worktreeId : 'shared-commit'}\n${identity.headCommit}\n${dirty ? 'dirty' : 'clean'}\n${extractorSet}\n${inventory}`,
  ).slice(0, 40)}`;
}

/**
 * Deterministic dirty identity for a persisted-base delta. The base snapshot
 * and exact overlay observation replace a repository-wide inventory replay.
 */
export function sparseOverlaySnapshotIdentity(
  identity: {
    readonly headCommit: string;
    readonly repositoryId: string;
    readonly worktreeId: string;
  },
  baseSnapshotId: string,
  extractorSet: string,
  overlayFingerprint: string,
): string {
  return `cgsn_${sha256HexSync(
    `snapshot-sparse-overlay-v1\nlexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}\n${identity.repositoryId}\n${identity.worktreeId}\n${identity.headCommit}\n${baseSnapshotId}\n${extractorSet}\n${overlayFingerprint}`,
  ).slice(0, 40)}`;
}

/** Content identity for a persisted-base delta without a flat full-inventory hash. */
export function sparseOverlayGraphContentIdentity(
  baseGraphContentId: string,
  extractorSet: string,
  overlayFingerprint: string,
): string {
  return `cgc_${sha256HexSync(
    `graph-content-sparse-overlay-v1\nlexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}\n${baseGraphContentId}\n${extractorSet}\n${overlayFingerprint}`,
  ).slice(0, 40)}`;
}

/**
 * Identifies the graph-producing inputs without coupling them to a Git commit or
 * worktree. Commit observations remain snapshot rows and may safely alias this
 * identity when the eligible inventory and derivation identity are unchanged.
 */
export function graphContentIdentity(
  extractorSet: string,
  files: readonly {
    readonly contentHash: string;
    readonly language?: string;
    readonly mode?: string;
    readonly path: string;
  }[],
): string {
  const inventory = files
    .map(file => `${file.path}\0${file.contentHash}\0${file.language ?? ''}\0${file.mode ?? ''}`)
    .sort()
    .join('\n');
  return `cgc_${sha256HexSync(
    `graph-content-v1\nlexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}\n${extractorSet}\n${inventory}`,
  ).slice(0, 40)}`;
}

export function selectedDecodedFactBytes(
  bytesByPath: ReadonlyMap<string, number> | undefined,
  paths: readonly string[],
): number | undefined {
  if (paths.length === 0) return 0;
  if (bytesByPath === undefined) return undefined;
  let total = 0;
  for (const path of paths) {
    const bytes = bytesByPath.get(path);
    if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) return undefined;
    total = Math.min(Number.MAX_SAFE_INTEGER, total + bytes);
  }
  return total;
}

export function directFullSnapshotIdentity(logicalSnapshotId: string): string {
  if (!/^cgsn_[0-9a-f]{40}$/.test(logicalSnapshotId)) {
    throw new CodeGraphIndexOperationError('Logical snapshot identity is invalid.');
  }
  return `${logicalSnapshotId}-direct`;
}

export function forcedSnapshotIdentity(logicalSnapshotId: string, forceGeneration: string | undefined): string {
  return forceGeneration ? `${logicalSnapshotId}-full-${forceGeneration}` : logicalSnapshotId;
}

export const firstReadySnapshotById = Effect.fn('codeGraph.firstReadySnapshotById')(function* (
  store: CodeGraphStoreShape,
  databasePath: string,
  snapshotIds: readonly string[],
) {
  for (const snapshotId of snapshotIds) {
    const ready = yield* store.currentLexicalReadySnapshotById(databasePath, snapshotId);
    if (ready) return ready;
  }
  return undefined;
});

/**
 * Decide whether a clean ready snapshot for HEAD is graph-equivalent to the
 * current inventory and safe to promote without rematerializing.
 *
 * Requires an explicit graphContentId on the candidate so we never promote a
 * same-commit row that merely shares extractor set but not inventory content.
 */
export function shouldReuseReadySnapshotForCleanCommit(input: {
  readonly candidate?: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly graphContentId?: string;
    readonly id: string;
  };
  readonly graphContentId: string;
  readonly headCommit: string;
}): boolean {
  return (
    input.candidate !== undefined &&
    input.candidate.dirty === false &&
    input.candidate.commit === input.headCommit &&
    input.candidate.graphContentId !== undefined &&
    input.candidate.graphContentId === input.graphContentId
  );
}

export const reusableReadySnapshotForCleanCommit = Effect.fn('codeGraph.reusableReadySnapshotForCleanCommit')(
  function* (input: {
    readonly databasePath: string;
    readonly extractorSet: string;
    readonly graphContentId: string;
    readonly headCommit: string;
    readonly repositoryId: string;
    readonly store: CodeGraphStoreShape;
  }) {
    const candidate = yield* input.store.readySnapshotForCommit(
      input.databasePath,
      input.repositoryId,
      input.headCommit,
      input.extractorSet,
    );
    return shouldReuseReadySnapshotForCleanCommit({
      candidate,
      graphContentId: input.graphContentId,
      headCommit: input.headCommit,
    })
      ? candidate
      : undefined;
  },
);

export function embeddingSymbolSource(store: CodeGraphStoreShape, databasePath: string, snapshotId: string) {
  return {
    count: store.countEmbeddingSymbols(databasePath, snapshotId),
    loadPage: (cursor: Parameters<CodeGraphStoreShape['loadSymbolPage']>[2], limit: number) =>
      store.loadEmbeddingSymbolPage(databasePath, snapshotId, cursor, limit),
  };
}

const observeDirectPersistentCapacity = Effect.fn('codeGraph.observeDirectPersistentCapacity')(function* (input: {
  readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly layout: CodeGraphLayout;
  readonly protection: DirectPersistentCapacityProtection;
  readonly threadnoteHome: string;
}) {
  const [durableFilesystem, temporaryFilesystem] = yield* Effect.all(
    [
      input.fs.stat(input.layout.repositoryRoot).pipe(
        Effect.map(info => info.dev),
        Effect.option,
      ),
      input.fs.stat(input.protection.temporaryDirectory).pipe(
        Effect.map(info => info.dev),
        Effect.option,
      ),
    ] as const,
    {concurrency: 2},
  );
  const filesystemsShared =
    Option.isSome(durableFilesystem) && Option.isSome(temporaryFilesystem)
      ? durableFilesystem.value === temporaryFilesystem.value
      : undefined;
  const probe = (target: string) =>
    input.protection.availableDiskBytes(target, input.boundary).pipe(Effect.catch(() => Effect.succeed(undefined)));
  const availability =
    filesystemsShared === undefined
      ? Effect.succeed([undefined, undefined] as const)
      : filesystemsShared
        ? probe(input.layout.repositoryRoot).pipe(Effect.map(available => [available, available] as const))
        : Effect.all([probe(input.layout.repositoryRoot), probe(input.protection.temporaryDirectory)] as const, {
            concurrency: 2,
          });
  const [[durableAvailableBytes, temporaryAvailableBytes], storage] = yield* Effect.all(
    [
      availability,
      inspectCodeGraphStorage(input.threadnoteHome, input.identity.checkoutId, {openWhileLocked: true}).pipe(
        Effect.option,
      ),
    ] as const,
    {concurrency: 2},
  );
  const pageStorage =
    Option.isSome(storage) && storage.value.state === 'available' && storage.value.pageStorage.state === 'available'
      ? storage.value.pageStorage
      : undefined;
  const demand = codeGraphPersistentCapacityDemand({
    boundary: input.boundary,
    lexicalFormatVersion: CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION,
    pageSize: pageStorage?.pageSize ?? 0,
    walAutoCheckpointPages: input.protection.walAutoCheckpointPages,
  });
  return {
    demand,
    durableAvailableBytes,
    durableFilesystemKey: Option.isSome(durableFilesystem)
      ? (codeGraphDiskReservationFilesystemKey(input.protection.system.platform, durableFilesystem.value) ??
        'durable-filesystem-unknown')
      : 'durable-filesystem-unknown',
    freelistBytes: pageStorage?.reclaimableBytes ?? 0,
    temporaryAvailableBytes,
    temporaryFilesystemKey: Option.isSome(temporaryFilesystem)
      ? (codeGraphDiskReservationFilesystemKey(input.protection.system.platform, temporaryFilesystem.value) ??
        'temporary-filesystem-unknown')
      : 'temporary-filesystem-unknown',
  };
});

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const CODE_GRAPH_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: Number.POSITIVE_INFINITY,
} as const;

export const CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS = 10 * 60_000;
const FACT_MATERIALIZATION_BATCH_FILES = 128;
const FACT_MATERIALIZATION_BATCH_SOURCE_BYTES = 16 * 1_048_576;
const FACT_MATERIALIZATION_BATCH_CACHED_FACT_BYTES = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM;
const PERSISTENT_MATERIALIZATION_TRANSACTION_BATCHES = 4;
export const PERSISTENT_MATERIALIZATION_TRANSACTION_FILES = 512;
export const PERSISTENT_MATERIALIZATION_TRANSACTION_SOURCE_BYTES = 64 * 1_048_576;
export const PERSISTENT_MATERIALIZATION_TRANSACTION_FACT_BYTES = 32 * 1_048_576;
// Conservative, warning-only planning factors informed by beta.30's observed
// production-shaped live amplification. They cover indexed TEMP rows, the durable candidate
// plus WAL, rollback/subjournals, and one concurrent worktree/repository build.
// Actual high-water telemetry remains authoritative and should recalibrate
// these factors as retained release evidence grows.
const FACT_MATERIALIZATION_TEMP_FACT_AMPLIFICATION_HEURISTIC = 5;
const FACT_MATERIALIZATION_DURABLE_FACT_AMPLIFICATION_HEURISTIC = 5;
const FACT_MATERIALIZATION_JOURNAL_FACT_AMPLIFICATION_HEURISTIC = 3;
const FACT_MATERIALIZATION_TEMP_MINIMUM_ESTIMATE_BYTES = 512 * 1_048_576;
const FACT_MATERIALIZATION_DIRECT_TEMP_ESTIMATE_BYTES = 16 * 1_048_576;
const FACT_MATERIALIZATION_DURABLE_MINIMUM_ESTIMATE_BYTES = 512 * 1_048_576;
const FACT_MATERIALIZATION_JOURNAL_MINIMUM_ESTIMATE_BYTES = 256 * 1_048_576;

export function estimatedMaterializationStorageBytes(
  factBytes: number | undefined,
  sourceBytes: number,
  materializationMode: 'direct-persistent' | 'temporary-staged' = 'temporary-staged',
  estimateBasis: 'cached-fact-bytes' | 'final-fact-bytes' = 'cached-fact-bytes',
) {
  const basisBytes = factBytes ?? sourceBytes;
  const estimatedTemporaryDatabaseBytes =
    materializationMode === 'direct-persistent'
      ? FACT_MATERIALIZATION_DIRECT_TEMP_ESTIMATE_BYTES
      : Math.max(
          FACT_MATERIALIZATION_TEMP_MINIMUM_ESTIMATE_BYTES,
          saturatingMultiply(basisBytes, FACT_MATERIALIZATION_TEMP_FACT_AMPLIFICATION_HEURISTIC),
        );
  const estimatedDurableSnapshotBytes = Math.max(
    FACT_MATERIALIZATION_DURABLE_MINIMUM_ESTIMATE_BYTES,
    saturatingMultiply(basisBytes, FACT_MATERIALIZATION_DURABLE_FACT_AMPLIFICATION_HEURISTIC),
  );
  const estimatedJournalBytes = Math.max(
    FACT_MATERIALIZATION_JOURNAL_MINIMUM_ESTIMATE_BYTES,
    saturatingMultiply(basisBytes, FACT_MATERIALIZATION_JOURNAL_FACT_AMPLIFICATION_HEURISTIC),
  );
  const estimatedConcurrentBuildBytes = saturatingAdd(
    estimatedTemporaryDatabaseBytes,
    estimatedDurableSnapshotBytes,
    estimatedJournalBytes,
  );
  return {
    estimateBasis: factBytes === undefined ? ('source-bytes-fallback' as const) : estimateBasis,
    estimatedConcurrentBuildBytes,
    estimatedDurableSnapshotBytes,
    estimatedJournalBytes,
    estimatedRequiredBytes: saturatingAdd(estimatedConcurrentBuildBytes, estimatedConcurrentBuildBytes),
    estimatedTemporaryDatabaseBytes,
    materializationMode,
  };
}

export interface MaterializationStorageAvailability {
  readonly durableAvailableBytes?: number;
  readonly filesystemsShared?: boolean;
  readonly temporaryAvailableBytes?: number;
}

export type MaterializationStoragePlan = ReturnType<typeof estimatedMaterializationStorageBytes> &
  MaterializationStorageAvailability & {
    readonly availableBytes?: number;
    readonly estimatedDurableFilesystemRequiredBytes: number;
    readonly estimatedTemporaryFilesystemRequiredBytes: number;
  };

/**
 * Plans warning-only materialization headroom for SQLite's durable and TEMP
 * filesystems. A second complete allowance covers one concurrent worktree or
 * repository build without imposing a repository-size rejection.
 */
export function materializationStoragePlan(
  estimate: ReturnType<typeof estimatedMaterializationStorageBytes>,
  availability: MaterializationStorageAvailability,
): MaterializationStoragePlan {
  const estimatedDurableFilesystemRequiredBytes = saturatingMultiply(
    estimate.materializationMode === 'direct-persistent'
      ? saturatingAdd(estimate.estimatedDurableSnapshotBytes, estimate.estimatedJournalBytes)
      : estimate.estimatedDurableSnapshotBytes,
    2,
  );
  const estimatedTemporaryFilesystemRequiredBytes = saturatingMultiply(
    estimate.materializationMode === 'direct-persistent'
      ? estimate.estimatedTemporaryDatabaseBytes
      : saturatingAdd(estimate.estimatedTemporaryDatabaseBytes, estimate.estimatedJournalBytes),
    2,
  );
  const sharedAvailableBytes =
    availability.filesystemsShared === true
      ? minimumDefined(availability.durableAvailableBytes, availability.temporaryAvailableBytes)
      : undefined;
  return {
    ...estimate,
    ...availability,
    ...(sharedAvailableBytes === undefined ? {} : {availableBytes: sharedAvailableBytes}),
    estimatedDurableFilesystemRequiredBytes,
    estimatedTemporaryFilesystemRequiredBytes,
  };
}

export function materializationStorageShortfalls(storage: {
  readonly availableBytes?: number;
  readonly durableAvailableBytes?: number;
  readonly estimatedDurableFilesystemRequiredBytes?: number;
  readonly estimatedRequiredBytes?: number;
  readonly estimatedTemporaryFilesystemRequiredBytes?: number;
  readonly filesystemsShared?: boolean;
  readonly temporaryAvailableBytes?: number;
}): readonly ('durable' | 'shared' | 'temporary')[] {
  if (storage.filesystemsShared === true) {
    return storage.availableBytes !== undefined &&
      storage.estimatedRequiredBytes !== undefined &&
      storage.availableBytes < storage.estimatedRequiredBytes
      ? ['shared']
      : [];
  }
  const shortfalls: ('durable' | 'temporary')[] = [];
  if (
    storage.durableAvailableBytes !== undefined &&
    storage.estimatedDurableFilesystemRequiredBytes !== undefined &&
    storage.durableAvailableBytes < storage.estimatedDurableFilesystemRequiredBytes
  ) {
    shortfalls.push('durable');
  }
  if (
    storage.temporaryAvailableBytes !== undefined &&
    storage.estimatedTemporaryFilesystemRequiredBytes !== undefined &&
    storage.temporaryAvailableBytes < storage.estimatedTemporaryFilesystemRequiredBytes
  ) {
    shortfalls.push('temporary');
  }
  return shortfalls;
}

function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function saturatingMultiply(value: number, multiplier: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value * multiplier);
}

function saturatingAdd(...values: readonly number[]): number {
  return values.reduce((total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + value), 0);
}

export interface CodeGraphMaterializationReplayMetrics {
  readonly attributedFilesCompleted: number;
  readonly cachedFactReplayBytesCompleted: number;
  readonly crossGenerationShardFilesCompleted: number;
  readonly exactGenerationShardFilesCompleted: number;
  readonly materializedShardReplayBytesCompleted: number;
  readonly rawFactReplayBytesCompleted: number;
}

export interface CodeGraphMaterializationReplayObservation {
  readonly attributedFiles?: number;
  readonly crossGenerationShardFiles?: number;
  readonly exactGenerationShardFiles?: number;
  readonly materializedShardReplayBytes?: number;
  readonly rawFactReplayBytes?: number;
}

export function emptyMaterializationReplayMetrics(): CodeGraphMaterializationReplayMetrics {
  return {
    attributedFilesCompleted: 0,
    cachedFactReplayBytesCompleted: 0,
    crossGenerationShardFilesCompleted: 0,
    exactGenerationShardFilesCompleted: 0,
    materializedShardReplayBytesCompleted: 0,
    rawFactReplayBytesCompleted: 0,
  };
}

/** Adds one physical replay observation while retaining an exact, safely bounded split. */
export function addMaterializationReplayMetrics(
  current: CodeGraphMaterializationReplayMetrics,
  observation: CodeGraphMaterializationReplayObservation,
): CodeGraphMaterializationReplayMetrics {
  const materializedShardReplayBytesCompleted = saturatingAdd(
    current.materializedShardReplayBytesCompleted,
    observation.materializedShardReplayBytes ?? 0,
  );
  const rawFactReplayBytesCompleted = saturatingAdd(
    current.rawFactReplayBytesCompleted,
    observation.rawFactReplayBytes ?? 0,
  );
  return {
    attributedFilesCompleted: saturatingAdd(current.attributedFilesCompleted, observation.attributedFiles ?? 0),
    cachedFactReplayBytesCompleted: saturatingAdd(materializedShardReplayBytesCompleted, rawFactReplayBytesCompleted),
    crossGenerationShardFilesCompleted: saturatingAdd(
      current.crossGenerationShardFilesCompleted,
      observation.crossGenerationShardFiles ?? 0,
    ),
    exactGenerationShardFilesCompleted: saturatingAdd(
      current.exactGenerationShardFilesCompleted,
      observation.exactGenerationShardFiles ?? 0,
    ),
    materializedShardReplayBytesCompleted,
    rawFactReplayBytesCompleted,
  };
}

export function factMaterializationBatches<T extends {readonly path: string; readonly size: number}>(
  values: readonly T[],
  cachedFactBytesByPath: ReadonlyMap<string, number> = new Map(),
): readonly (readonly T[])[] {
  const output: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 0;
  let batchFactBytes = 0;
  for (const value of values) {
    // Current-version cache writes and materialization reads both apply the
    // same per-file compactor. Clamp defensive metadata from an unexpected
    // legacy/corrupt row to that in-memory materialization ceiling, so there
    // is no oversized-singleton exception in the batch planner.
    const factBytes = Math.min(
      CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
      Math.max(0, cachedFactBytesByPath.get(value.path) ?? 0),
    );
    if (
      batch.length > 0 &&
      (batch.length >= FACT_MATERIALIZATION_BATCH_FILES ||
        batchBytes + value.size > FACT_MATERIALIZATION_BATCH_SOURCE_BYTES ||
        batchFactBytes + factBytes > FACT_MATERIALIZATION_BATCH_CACHED_FACT_BYTES)
    ) {
      output.push(batch);
      batch = [];
      batchBytes = 0;
      batchFactBytes = 0;
    }
    batch.push(value);
    batchBytes += value.size;
    batchFactBytes += factBytes;
  }
  if (batch.length > 0) output.push(batch);
  return output;
}

export interface PersistentMaterializationTransactionCandidate {
  readonly factBytes: number;
  readonly fileCount: number;
  readonly sourceBytes: number;
}

/**
 * Coalesces contiguous, already-bounded logical receipts into larger physical
 * SQLite transactions. Logical receipt identities stay unchanged so an
 * interrupted build from an older release resumes without replay or graph
 * drift. A candidate over a physical ceiling remains an isolated singleton.
 */
export function persistentMaterializationTransactionBatches<T extends PersistentMaterializationTransactionCandidate>(
  values: readonly T[],
  maximumBatches = PERSISTENT_MATERIALIZATION_TRANSACTION_BATCHES,
): readonly (readonly T[])[] {
  const batchLimit = Math.max(1, Math.min(PERSISTENT_MATERIALIZATION_TRANSACTION_BATCHES, maximumBatches));
  const output: T[][] = [];
  let batch: T[] = [];
  let factBytes = 0;
  let fileCount = 0;
  let sourceBytes = 0;
  for (const value of values) {
    if (
      batch.length > 0 &&
      (batch.length >= batchLimit ||
        fileCount + value.fileCount > PERSISTENT_MATERIALIZATION_TRANSACTION_FILES ||
        sourceBytes + value.sourceBytes > PERSISTENT_MATERIALIZATION_TRANSACTION_SOURCE_BYTES ||
        factBytes + value.factBytes > PERSISTENT_MATERIALIZATION_TRANSACTION_FACT_BYTES)
    ) {
      output.push(batch);
      batch = [];
      factBytes = 0;
      fileCount = 0;
      sourceBytes = 0;
    }
    batch.push(value);
    factBytes += value.factBytes;
    fileCount += value.fileCount;
    sourceBytes += value.sourceBytes;
  }
  if (batch.length > 0) output.push(batch);
  return output;
}

export function uniqueById<T extends {readonly id: string}>(values: readonly T[]): readonly T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    if (!unique.has(value.id)) unique.set(value.id, value);
  }
  return [...unique.values()];
}

/**
 * Extraction may encounter the same relationship repeatedly at one call site
 * or through overlapping language-pack derivations. The storage layer keeps
 * strict INSERT semantics; collapse those logical duplicates deterministically
 * before they reach its primary-key boundary.
 */
export function deduplicateMaterializationRelationships(
  edges: readonly CodeGraphEdge[],
  references: readonly CodeGraphReference[],
): {
  readonly duplicateEdges: number;
  readonly duplicateReferences: number;
  readonly edges: readonly CodeGraphEdge[];
  readonly references: readonly CodeGraphReference[];
} {
  const edgeById = new Map<string, CodeGraphEdge>();
  for (const edge of edges) {
    if (!edgeById.has(edge.id)) edgeById.set(edge.id, edge);
  }
  const referenceByEdgeId = new Map<string, CodeGraphReference>();
  for (const reference of references) {
    // Reference attribution has historically been last-wins for one logical
    // edge. Preserve that contract for older, uncompacted cache rows while
    // edges retain their first stable evidence occurrence.
    referenceByEdgeId.set(reference.edgeId, reference);
  }
  return {
    duplicateEdges: edges.length - edgeById.size,
    duplicateReferences: references.length - referenceByEdgeId.size,
    edges: [...edgeById.values()],
    references: [...referenceByEdgeId.values()],
  };
}

export function materializationRows(
  symbols: readonly CodeGraphSymbol[],
  edges: number,
  references: readonly CodeGraphReference[],
  deduplicated: {readonly edges: number; readonly references: number},
): CodeGraphMaterializationRows {
  return {
    deduplicatedEdges: deduplicated.edges,
    deduplicatedReferences: deduplicated.references,
    edges,
    lookupKeys: symbols.reduce((total, symbol) => total + (symbol.lookupKeys?.length ?? 0), 0),
    referenceCandidates: references.reduce(
      (total, reference) => total + reference.lookupTiers.reduce((tierTotal, tier) => tierTotal + tier.length, 0),
      0,
    ),
    references: references.length,
    symbols: symbols.length,
  };
}

export function addMaterializationRows(
  left: CodeGraphMaterializationRows,
  right: CodeGraphMaterializationRows,
): CodeGraphMaterializationRows {
  return {
    deduplicatedEdges: (left.deduplicatedEdges ?? 0) + (right.deduplicatedEdges ?? 0),
    deduplicatedReferences: (left.deduplicatedReferences ?? 0) + (right.deduplicatedReferences ?? 0),
    edges: (left.edges ?? 0) + (right.edges ?? 0),
    lookupKeys: (left.lookupKeys ?? 0) + (right.lookupKeys ?? 0),
    referenceCandidates: (left.referenceCandidates ?? 0) + (right.referenceCandidates ?? 0),
    references: (left.references ?? 0) + (right.references ?? 0),
    reexports: (left.reexports ?? 0) + (right.reexports ?? 0),
    symbols: (left.symbols ?? 0) + (right.symbols ?? 0),
    terms: (left.terms ?? 0) + (right.terms ?? 0),
  };
}

export function materializationRowsWithStoreProgress(
  rows: CodeGraphMaterializationRows,
  progress: CodeGraphStagingProgress,
): CodeGraphMaterializationRows {
  // Store observers emit a zero-row stage boundary before the first bounded
  // statement. Keep the batch estimate at that boundary; replacing it with
  // zero made the CLI claim that a non-empty batch contained no symbols or
  // lookup keys. Positive observations monotonically replace estimates with
  // the rows actually accepted by SQLite.
  if (progress.rowsCompleted === 0) return rows;
  switch (progress.stage) {
    case 'symbols':
      return {...rows, symbols: progress.rowsCompleted};
    case 'lookup-keys':
      return {...rows, lookupKeys: progress.rowsCompleted};
    case 'terms':
      return {...rows, terms: progress.rowsCompleted};
    case 'edges':
      return {...rows, edges: progress.rowsCompleted};
    case 'references':
      return {...rows, references: progress.rowsCompleted};
    case 'reference-candidates':
      return {...rows, referenceCandidates: progress.rowsCompleted};
    case 'reexports':
      return {...rows, reexports: progress.rowsCompleted};
    case 'analysis':
    case 'receipt':
    case 'validating':
    case 'committing':
    case 'committed':
      return rows;
  }
}

interface MaterializationStorageFiles {
  readonly databaseBytes: number;
  readonly journalBytes: number;
  readonly sharedMemoryBytes: number;
  readonly totalBytes: number;
  readonly walBytes: number;
}

export function materializationStorageFiles(
  fs: FileSystem.FileSystem,
  databasePath: string,
): Effect.Effect<MaterializationStorageFiles, never> {
  const bytes = (file: string) =>
    fs.stat(file).pipe(
      Effect.map(info => Math.min(Number(info.size), Number.MAX_SAFE_INTEGER)),
      Effect.catch(() => Effect.succeed(0)),
    );
  return Effect.all(
    [bytes(databasePath), bytes(`${databasePath}-journal`), bytes(`${databasePath}-shm`), bytes(`${databasePath}-wal`)],
    {concurrency: 4},
  ).pipe(
    Effect.map(([databaseBytes, journalBytes, sharedMemoryBytes, walBytes]) => ({
      databaseBytes,
      journalBytes,
      sharedMemoryBytes,
      totalBytes: databaseBytes + journalBytes + sharedMemoryBytes + walBytes,
      walBytes,
    })),
  );
}

export function materializationStagingStage(
  progress: CodeGraphStagingProgress,
): NonNullable<Extract<CodeGraphProgress, {readonly phase: 'materializing'}>['activity']>['stage'] {
  switch (progress.stage) {
    case 'validating':
      return 'preparing-rows';
    case 'symbols':
      return 'writing-symbols';
    case 'lookup-keys':
      return 'writing-lookups';
    case 'terms':
      return 'writing-terms';
    case 'edges':
      return 'writing-edges';
    case 'reference-candidates':
      return 'writing-candidates';
    case 'references':
    case 'reexports':
      return 'writing-references';
    case 'analysis':
      return 'writing-analysis';
    case 'receipt':
      return 'writing-receipt';
    case 'committing':
    case 'committed':
      return 'committing';
  }
}

export function cachedFileKeys(
  store: CodeGraphStoreShape,
  databasePath: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>,
  files?: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
): Effect.Effect<ReadonlySet<string>, unknown> {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const cacheIdentities =
      files === undefined
        ? languagePacks.cacheIdentities
        : languagePacks.activeCacheIdentities(files.map(file => file.path));
    const generations = codeGraphParserCacheLookupGenerations(cacheIdentities);
    const sets = yield* Effect.forEach(
      generations,
      generation =>
        store
          .cachedCommittedFileKeys(databasePath, generation.storedIdentity, files)
          .pipe(
            Effect.map(
              keys =>
                new Set(
                  [...keys].map(key =>
                    codeGraphActiveParserCacheKey(key, generation.storedIdentity, generation.activeIdentity),
                  ),
                ),
            ),
          ),
      {concurrency: 1},
    );
    const keys = new Set(sets.flatMap(set => [...set]));
    yield* onProgress?.({
      activity: {
        elapsedMilliseconds: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
        generations: generations.length,
        keys: keys.size,
        stage: 'loading-cache',
      },
      phase: 'registering',
    }) ?? Effect.void;
    return keys;
  });
}

export function loadCachedFacts(
  store: CodeGraphStoreShape,
  databasePath: string,
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): Effect.Effect<
  {
    readonly bytes: number;
    readonly bytesByPath: ReadonlyMap<string, number>;
    readonly facts: ReadonlyMap<string, CodeGraphFileFacts>;
  },
  unknown
> {
  return Effect.forEach(
    groupFilesByCacheIdentity(files, languagePacks),
    group =>
      Effect.gen(function* () {
        const active = yield* store.loadCachedFacts(databasePath, group.files, group.cacheIdentity);
        const missing = group.files.filter(file => !active.facts.has(file.path));
        if (missing.length === 0) return active;
        const degraded = yield* store.loadCachedFacts(
          databasePath,
          missing,
          degradedParserCacheIdentity(group.cacheIdentity),
        );
        return {
          bytes: active.bytes + degraded.bytes,
          bytesByPath: new Map([...(active.bytesByPath ?? []), ...(degraded.bytesByPath ?? [])]),
          facts: new Map([...active.facts, ...degraded.facts]),
        };
      }),
    {concurrency: 1},
  ).pipe(
    Effect.map(groups => {
      const output = new Map<string, CodeGraphFileFacts>();
      const bytesByPath = new Map<string, number>();
      let bytes = 0;
      for (const group of groups) {
        for (const [path, facts] of group.facts) {
          const persistedBytes = group.bytesByPath?.get(path);
          if (persistedBytes !== undefined && persistedBytes <= CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM) {
            output.set(path, facts);
            bytesByPath.set(path, persistedBytes);
            bytes += persistedBytes;
            continue;
          }
          const budgeted = budgetCachedCodeGraphFacts(facts);
          const budgetedBytes = cachedCodeGraphFactBytes(budgeted);
          output.set(path, budgeted);
          bytesByPath.set(path, budgetedBytes);
          bytes += budgetedBytes;
        }
      }
      return {bytes, bytesByPath, facts: output};
    }),
  );
}

export function loadCachedFactsWithPackProvenance(
  store: CodeGraphStoreShape,
  databasePath: string,
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
  provenance: readonly CodeGraphLanguagePackProvenance[],
): Effect.Effect<
  {
    readonly bytes: number;
    readonly bytesByPath: ReadonlyMap<string, number>;
    readonly facts: ReadonlyMap<string, CodeGraphFileFacts>;
  },
  unknown
> {
  const provenanceById = new Map(provenance.map(pack => [pack.id, pack]));
  const groups = new Map<string, CodeGraphInventoryFile[]>();
  let unmatched = false;
  for (const file of files) {
    const match = Option.getOrUndefined(languagePacks.match(file.path));
    const identity = match === undefined ? undefined : provenanceById.get(match.pack.id)?.cacheIdentity;
    if (identity === undefined) {
      unmatched = true;
      continue;
    }
    const group = groups.get(identity) ?? [];
    group.push(file);
    groups.set(identity, group);
  }
  if (unmatched) return Effect.succeed({bytes: 0, bytesByPath: new Map(), facts: new Map()});
  return Effect.forEach(
    [...groups],
    ([cacheIdentity, groupFiles]) =>
      Effect.gen(function* () {
        const active = yield* store.loadCachedFacts(databasePath, groupFiles, cacheIdentity);
        const missing = groupFiles.filter(file => !active.facts.has(file.path));
        if (missing.length === 0) return active;
        const degraded = yield* store.loadCachedFacts(
          databasePath,
          missing,
          degradedParserCacheIdentity(cacheIdentity),
        );
        return {
          bytes: active.bytes + degraded.bytes,
          bytesByPath: new Map([...(active.bytesByPath ?? []), ...(degraded.bytesByPath ?? [])]),
          facts: new Map([...active.facts, ...degraded.facts]),
        };
      }),
    {concurrency: 1},
  ).pipe(
    Effect.map(loaded => {
      const facts = new Map<string, CodeGraphFileFacts>();
      const bytesByPath = new Map<string, number>();
      let bytes = 0;
      for (const group of loaded) {
        for (const [path, fact] of group.facts) {
          const persistedBytes = group.bytesByPath?.get(path);
          if (persistedBytes !== undefined && persistedBytes <= CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM) {
            facts.set(path, fact);
            bytesByPath.set(path, persistedBytes);
            bytes += persistedBytes;
            continue;
          }
          const budgeted = budgetCachedCodeGraphFacts(fact);
          const budgetedBytes = cachedCodeGraphFactBytes(budgeted);
          facts.set(path, budgeted);
          bytesByPath.set(path, budgetedBytes);
          bytes += budgetedBytes;
        }
      }
      return {bytes, bytesByPath, facts};
    }),
  );
}

export function cachedFactsMetadata(
  store: CodeGraphStoreShape,
  databasePath: string,
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): Effect.Effect<
  {readonly bytes: number; readonly bytesByPath: ReadonlyMap<string, number>; readonly files: number},
  unknown
> {
  return Effect.forEach(
    groupFilesByCacheIdentity(files, languagePacks),
    group =>
      Effect.gen(function* () {
        const active = yield* store.loadCachedFacts(databasePath, group.files, group.cacheIdentity, {decode: false});
        const activeKeys = active.keys ?? new Set(active.facts.keys());
        const missing = group.files.filter(file => !activeKeys.has(file.path));
        if (missing.length === 0)
          return {bytes: active.bytes, bytesByPath: active.bytesByPath ?? new Map(), keys: activeKeys};
        const degraded = yield* store.loadCachedFacts(
          databasePath,
          missing,
          degradedParserCacheIdentity(group.cacheIdentity),
          {decode: false},
        );
        const degradedKeys = degraded.keys ?? new Set(degraded.facts.keys());
        return {
          bytes: active.bytes + degraded.bytes,
          bytesByPath: new Map([...(active.bytesByPath ?? []), ...(degraded.bytesByPath ?? [])]),
          keys: new Set([...activeKeys, ...degradedKeys]),
        };
      }),
    {concurrency: 1},
  ).pipe(
    Effect.map(groups => {
      const bytesByPath = new Map(
        groups.flatMap(group => [...group.bytesByPath]).map(([path, bytes]) => [path, bytes] as const),
      );
      return {
        bytes: [...bytesByPath.values()].reduce((total, bytes) => total + bytes, 0),
        bytesByPath,
        files: new Set(groups.flatMap(group => [...group.keys])).size,
      };
    }),
  );
}

function groupFilesByCacheIdentity<T extends {readonly path: string}>(
  files: readonly T[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): readonly {readonly cacheIdentity: string; readonly files: readonly T[]}[] {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const matched = languagePacks.cacheIdentityForPath(file.path);
    const identity = matched._tag === 'Some' ? matched.value : 'unmatched';
    const group = groups.get(identity);
    if (group) group.push(file);
    else groups.set(identity, [file]);
  }
  return [...groups]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([cacheIdentity, groupedFiles]) => ({cacheIdentity, files: groupedFiles}));
}
