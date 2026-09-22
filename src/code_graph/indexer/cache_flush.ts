import {Effect, Option} from 'effect';
import type {BoundedCodeGraphFact} from '../fact/budget.js';
import type {CodeGraphContentBatchContext} from '../inventory.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {codeGraphSourceSizeBucket, type CodeGraphScanningMetrics} from '../progress/telemetry.js';
import type {CodeGraphDirectPersistentCapacityProtector, CodeGraphStoreShape} from '../store.js';
import type {CodeGraphInventoryFile, CodeGraphProgress} from '../types.js';
import {CodeGraphIndexOperationError} from './shared.js';

export interface CodeGraphPendingCacheGroup {
  readonly cacheIdentity: string;
  readonly facts: BoundedCodeGraphFact[];
  readonly files: CodeGraphInventoryFile[];
  readonly paths: Set<string>;
  payloadBytes: number;
}

export function codeGraphFileProgressDimensions(
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

export function emitContentProgress(
  onProgress: ((progress: CodeGraphProgress) => Effect.Effect<void, unknown>) | undefined,
  context: CodeGraphContentBatchContext,
  activity: NonNullable<Extract<CodeGraphProgress, {readonly phase: 'scanning'}>['activity']>,
  extractionMilliseconds: number,
  persistenceMilliseconds: number,
  serializationMilliseconds: number,
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
        serializationMilliseconds,
      },
    }) ?? Effect.void
  );
}

export function flushCombinedCodeGraphCacheGroups(options: {
  readonly context?: CodeGraphContentBatchContext;
  readonly databasePath: string;
  readonly extractionMilliseconds: number;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly metrics?: CodeGraphScanningMetrics;
  readonly onCachedParserBatch?: (group: {
    readonly cacheIdentity: string;
    readonly facts: readonly BoundedCodeGraphFact[];
    readonly files: readonly CodeGraphInventoryFile[];
  }) => Effect.Effect<void, unknown>;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly onSourceParserBatch?: (group: {
    readonly cacheIdentity: string;
    readonly facts: readonly BoundedCodeGraphFact[];
    readonly files: readonly CodeGraphInventoryFile[];
  }) => Effect.Effect<void, unknown>;
  readonly pendingBytes: number;
  readonly pendingGroups: Map<string, CodeGraphPendingCacheGroup>;
  readonly pendingRows: number;
  readonly persistenceMilliseconds: number;
  readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
  readonly serializationMilliseconds: number;
  readonly store: CodeGraphStoreShape;
}): Effect.Effect<
  {readonly pendingBytes: number; readonly pendingRows: number; readonly persistenceMilliseconds: number},
  unknown
> {
  return Effect.gen(function* () {
    const groups = [...options.pendingGroups.entries()];
    if (groups.length === 0)
      return {
        pendingBytes: options.pendingBytes,
        pendingRows: options.pendingRows,
        persistenceMilliseconds: options.persistenceMilliseconds,
      };
    const context = options.context;
    if (!context)
      return yield* CodeGraphIndexOperationError.make({
        message: 'Code graph cache persistence context is unavailable.',
      });
    const startedAt = performance.now();
    for (const [, group] of groups) yield* options.onSourceParserBatch?.(group) ?? Effect.void;
    yield* options.store.cacheFactBatches(
      options.databasePath,
      groups.map(([, group]) => ({
        extractorSet: group.cacheIdentity,
        facts: group.facts,
        files: group.files,
      })),
      options.persistentCapacityProtector,
    );
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        for (const [, group] of groups) {
          yield* (
            options.onCachedParserBatch?.({
              cacheIdentity: group.cacheIdentity,
              facts: group.facts,
              files: group.files,
            }) ?? Effect.void
          ).pipe(Effect.ignore);
        }
        const elapsed = Math.max(0, performance.now() - startedAt);
        const totalPayloadBytes = Math.max(
          1,
          groups.reduce((total, [, group]) => total + group.payloadBytes, 0),
        );
        let allocatedMilliseconds = 0;
        let pendingBytes = options.pendingBytes;
        let pendingRows = options.pendingRows;
        let persistenceMilliseconds = options.persistenceMilliseconds;
        for (let index = 0; index < groups.length; index += 1) {
          const [key, group] = groups[index];
          const representative = group.files[0];
          const groupBytes = group.files.reduce((total, file) => total + file.size, 0);
          const groupFactBytes = group.facts.reduce((total, fact) => total + fact.bytes, 0);
          const groupMilliseconds =
            index === groups.length - 1
              ? Math.max(0, elapsed - allocatedMilliseconds)
              : (elapsed * group.payloadBytes) / totalPayloadBytes;
          allocatedMilliseconds += groupMilliseconds;
          persistenceMilliseconds += groupMilliseconds;
          pendingBytes -= group.payloadBytes;
          pendingRows -= group.files.length;
          options.pendingGroups.delete(key);
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
            options.extractionMilliseconds,
            persistenceMilliseconds - groupMilliseconds,
            options.serializationMilliseconds,
            options.metrics,
          );
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
              persistMilliseconds: groupMilliseconds,
              relations: group.facts.reduce((total, fact) => total + fact.facts.edges.length, 0),
              sizeBucket: codeGraphSourceSizeBucket(groupBytes),
              stage: 'persisting',
              symbols: group.facts.reduce((total, fact) => total + fact.facts.symbols.length, 0),
            },
            options.extractionMilliseconds,
            persistenceMilliseconds,
            options.serializationMilliseconds,
            options.metrics,
          );
        }
        const allFiles = groups.flatMap(([, group]) => group.files);
        const allFacts = groups.flatMap(([, group]) => group.facts);
        const totalBytes = allFiles.reduce((total, file) => total + file.size, 0);
        const totalFactBytes = allFacts.reduce((total, fact) => total + fact.bytes, 0);
        const representative = allFiles[0];
        const commitActivity = {
          batchTotal: allFiles.length,
          bytes: totalBytes,
          classifier: 'mixed',
          factsBytes: totalFactBytes,
          language: 'mixed',
          path: representative.path,
          role: 'mixed',
          sizeBucket: codeGraphSourceSizeBucket(totalBytes),
          stage: 'persisting' as const,
        };
        yield* emitContentProgress(
          options.onProgress,
          context,
          {batchCompleted: 0, ...commitActivity},
          options.extractionMilliseconds,
          persistenceMilliseconds,
          options.serializationMilliseconds,
          options.metrics,
        );
        yield* emitContentProgress(
          options.onProgress,
          context,
          {
            batchCompleted: allFiles.length,
            ...commitActivity,
            persistMilliseconds: 0,
            relations: allFacts.reduce((total, fact) => total + fact.facts.edges.length, 0),
            symbols: allFacts.reduce((total, fact) => total + fact.facts.symbols.length, 0),
          },
          options.extractionMilliseconds,
          persistenceMilliseconds,
          options.serializationMilliseconds,
          options.metrics,
        );
        return {pendingBytes, pendingRows, persistenceMilliseconds};
      }),
    );
  });
}
