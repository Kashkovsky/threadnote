export const CODE_GRAPH_CAT_FILE_BATCH_ENTRIES = 512;
export const CODE_GRAPH_CAT_FILE_BATCH_BYTES = 16 * 1_048_576;

export function codeGraphCatFileBatches<T extends {readonly size: number}>(
  entries: readonly T[],
): readonly (readonly T[])[] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    if (
      current.length > 0 &&
      (current.length >= CODE_GRAPH_CAT_FILE_BATCH_ENTRIES ||
        currentBytes + entry.size > CODE_GRAPH_CAT_FILE_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entry.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
