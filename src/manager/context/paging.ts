export const MANAGER_CONTEXT_RECALL_PAGE_SIZE_DEFAULT = 8 as const;

export interface ManagerRecallPageProjection<T> {
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
  readonly index: number;
  readonly pageCount: number;
  readonly results: readonly T[];
}

/** Client-safe deterministic projection over one stable bounded recall snapshot. */
export function projectManagerRecallPage<T>(
  results: readonly T[],
  requestedPage: number,
  pageSize: number = MANAGER_CONTEXT_RECALL_PAGE_SIZE_DEFAULT,
): ManagerRecallPageProjection<T> {
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 0) throw new Error('requestedPage must be non-negative.');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('pageSize must be a positive integer.');
  const pageCount = Math.max(1, Math.ceil(results.length / pageSize));
  const index = Math.min(requestedPage, pageCount - 1);
  const start = index * pageSize;
  return {
    hasNext: index + 1 < pageCount,
    hasPrevious: index > 0,
    index,
    pageCount,
    results: results.slice(start, start + pageSize),
  };
}
