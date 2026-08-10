export const CODE_GRAPH_LARGE_EXTRACTION_BYTES = 512 * 1_024;
export const CODE_GRAPH_STRUCTURED_EXTRACTION_BYTES = 128 * 1_024;

const STRUCTURED_LANGUAGES = new Set([
  'graphql',
  'ini',
  'json',
  'jsonc',
  'msbuild',
  'properties',
  'protobuf',
  'solution',
  'sql',
  'toml',
  'xaml',
  'yaml',
]);

export interface CodeGraphExtractionCostFile {
  readonly language: string;
  readonly size: number;
}

export interface CodeGraphExtractionCostGroup {
  readonly files: readonly CodeGraphExtractionCostFile[];
}

export interface CodeGraphExtractionLane<Group extends CodeGraphExtractionCostGroup> {
  readonly concurrency: number;
  readonly groups: readonly Group[];
  readonly kind: 'isolated-high-cost' | 'parallel-bounded';
}

/**
 * Keep large or structured-heavy parser work out of a concurrent lane while
 * retaining bounded parallelism for ordinary source groups. Input order and
 * blob-reuse group boundaries are preserved exactly.
 */
export function planCodeGraphExtractionLanes<Group extends CodeGraphExtractionCostGroup>(
  groups: readonly Group[],
  capacity: number,
): readonly CodeGraphExtractionLane<Group>[] {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Code graph parser capacity is invalid.');
  const lanes: CodeGraphExtractionLane<Group>[] = [];
  let parallel: Group[] = [];
  const flushParallel = () => {
    if (parallel.length === 0) return;
    lanes.push({concurrency: capacity, groups: parallel, kind: 'parallel-bounded'});
    parallel = [];
  };
  for (const group of groups) {
    if (codeGraphExtractionGroupIsHighCost(group)) {
      flushParallel();
      lanes.push({concurrency: 1, groups: [group], kind: 'isolated-high-cost'});
    } else {
      parallel.push(group);
    }
  }
  flushParallel();
  return lanes;
}

export function codeGraphExtractionGroupIsHighCost(group: CodeGraphExtractionCostGroup): boolean {
  return group.files.some(
    file =>
      file.size >= CODE_GRAPH_LARGE_EXTRACTION_BYTES ||
      (STRUCTURED_LANGUAGES.has(file.language) && file.size >= CODE_GRAPH_STRUCTURED_EXTRACTION_BYTES),
  );
}
