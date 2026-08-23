import type {CodeGraphBuildStatus, CodeGraphBuildTimings} from './build_status.js';
import type {CodeGraphProgress} from './types.js';

/** Preserves componentwise cumulative scan timings across sparse progress events. */
export function codeGraphProgressTimings(
  current: Pick<CodeGraphBuildStatus, 'phase' | 'timings'>,
  progress: CodeGraphProgress,
): CodeGraphBuildTimings | undefined {
  if (progress.phase !== 'scanning') return undefined;
  if (progress.timings === undefined) return current.phase === 'scanning' ? current.timings : undefined;
  const previous = current.phase === 'scanning' ? current.timings : undefined;
  return {
    extractionMilliseconds: Math.max(previous?.extractionMilliseconds ?? 0, progress.timings.extractionMilliseconds),
    persistenceMilliseconds: Math.max(previous?.persistenceMilliseconds ?? 0, progress.timings.persistenceMilliseconds),
    readingMilliseconds: Math.max(previous?.readingMilliseconds ?? 0, progress.timings.readingMilliseconds),
    serializationMilliseconds: Math.max(
      previous?.serializationMilliseconds ?? 0,
      progress.timings.serializationMilliseconds,
    ),
  };
}
