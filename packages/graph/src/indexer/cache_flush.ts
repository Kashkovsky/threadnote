import {Effect, Option} from 'effect';
import type {BoundedCodeGraphFact} from '../fact/budget.js';
import type {CodeGraphContentBatchContext} from '../inventory.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {codeGraphSourceSizeBucket, type CodeGraphScanningMetrics} from '../progress/telemetry.js';
import type {CodeGraphInventoryFile, CodeGraphProgress} from '../types.js';

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
