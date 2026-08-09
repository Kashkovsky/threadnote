export const CODE_GRAPH_SLOW_FILE_THRESHOLD_MILLISECONDS = 1_000;
export const CODE_GRAPH_TOP_SLOW_FILE_LIMIT = 10;

export const CODE_GRAPH_SOURCE_SIZE_BUCKETS = ['0-16KiB', '16-64KiB', '64-256KiB', '256KiB-1MiB', '>1MiB'] as const;

export type CodeGraphSourceSizeBucket = (typeof CODE_GRAPH_SOURCE_SIZE_BUCKETS)[number];

export interface CodeGraphSlowFileTelemetry {
  readonly classifier: string;
  readonly degraded?: boolean;
  readonly durationMilliseconds: number;
  readonly extension: string;
  readonly factsBytes?: number;
  readonly language: string;
  readonly pathHash: string;
  readonly relations?: number;
  readonly role: string;
  readonly sizeBucket: CodeGraphSourceSizeBucket;
  readonly sourceBytes: number;
  readonly symbols?: number;
}

export function codeGraphSourceSizeBucket(bytes: number): CodeGraphSourceSizeBucket {
  if (bytes <= 16 * 1_024) return '0-16KiB';
  if (bytes <= 64 * 1_024) return '16-64KiB';
  if (bytes <= 256 * 1_024) return '64-256KiB';
  if (bytes <= 1_024 * 1_024) return '256KiB-1MiB';
  return '>1MiB';
}

export function isCodeGraphSourceSizeBucket(value: unknown): value is CodeGraphSourceSizeBucket {
  return CODE_GRAPH_SOURCE_SIZE_BUCKETS.includes(value as CodeGraphSourceSizeBucket);
}

/**
 * Retains a deterministic, bounded top-slow set independent of completion
 * order. Path hashes are the final tie-breaker and never expose source paths.
 */
export function retainCodeGraphSlowFileTelemetry(
  current: readonly CodeGraphSlowFileTelemetry[],
  candidate: CodeGraphSlowFileTelemetry,
  limit = CODE_GRAPH_TOP_SLOW_FILE_LIMIT,
): readonly CodeGraphSlowFileTelemetry[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  return [...current, candidate]
    .sort(
      (left, right) =>
        right.durationMilliseconds - left.durationMilliseconds ||
        left.pathHash.localeCompare(right.pathHash) ||
        left.language.localeCompare(right.language),
    )
    .slice(0, limit);
}

export function codeGraphPathExtension(path: string): string {
  const basename = path.split('/').at(-1) ?? '';
  const separator = basename.lastIndexOf('.');
  if (separator <= 0 || separator === basename.length - 1) return 'none';
  return basename.slice(separator, separator + 16).toLowerCase();
}
