import type {CodeGraphBuildStatusSelection, ObservedCodeGraphBuildStatus} from './build_status.js';
import type {ObsoleteCodeGraphStoreInventory} from './maintenance.js';
import type {CodeGraphStorage} from './storage.js';
import type {CodeGraphStatus} from './types.js';

export const CODE_GRAPH_STATUS_DEFAULT_BUILD_LIMIT = 4;
export const CODE_GRAPH_STATUS_MINIMUM_BUILD_LIMIT = 1;
export const CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT = 32;

export interface CodeGraphStatusBoundedListReceiptV3 {
  readonly limit: number;
  readonly omitted: number;
  readonly returned: number;
  readonly total: number;
}

export interface CodeGraphStatusProjectionReceiptV3 {
  readonly builds: CodeGraphStatusBoundedListReceiptV3;
  readonly queuedWorktreeIds: CodeGraphStatusBoundedListReceiptV3;
  readonly waiters: CodeGraphStatusBoundedListReceiptV3;
}

export interface CodeGraphStatusActivityProjectionV3 {
  readonly build: ObservedCodeGraphBuildStatus | null;
  readonly builds: readonly ObservedCodeGraphBuildStatus[];
  readonly projection: CodeGraphStatusProjectionReceiptV3;
  readonly queuedWorktreeIds: readonly string[];
  /** Exact total, retained for compatibility with the v2 activity surface. */
  readonly waiterCount: number;
  readonly waiters: readonly ObservedCodeGraphBuildStatus[];
}

export type CodeGraphStatusJsonDetailsV3 = Pick<
  CodeGraphStatus,
  'databasePath' | 'identity' | 'languagePacks' | 'stale'
> & {
  readonly obsoleteStores: ObsoleteCodeGraphStoreInventory;
  readonly readySnapshot: CodeGraphStatus['readySnapshot'] | null;
  readonly storage: CodeGraphStorage;
};

export type CodeGraphStatusOptionsResolution =
  {readonly buildLimit: number; readonly error?: undefined} | {readonly buildLimit?: undefined; readonly error: string};

export function codeGraphStatusBuildLimit(value: number | undefined): number | undefined {
  const candidate = value ?? CODE_GRAPH_STATUS_DEFAULT_BUILD_LIMIT;
  return Number.isSafeInteger(candidate) &&
    candidate >= CODE_GRAPH_STATUS_MINIMUM_BUILD_LIMIT &&
    candidate <= CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT
    ? candidate
    : undefined;
}

export function resolveCodeGraphStatusOptions(options: {
  readonly buildLimit?: number;
  readonly json?: boolean;
}): CodeGraphStatusOptionsResolution {
  if (!options.json && options.buildLimit !== undefined) {
    return {error: 'Use --build-limit only with --json.'};
  }
  const buildLimit = codeGraphStatusBuildLimit(options.buildLimit);
  return buildLimit === undefined
    ? {
        error: `Use --build-limit with an integer between ${CODE_GRAPH_STATUS_MINIMUM_BUILD_LIMIT} and ${CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT}.`,
      }
    : {buildLimit};
}

/**
 * Bound only the CLI JSON projection. The complete selection remains available
 * to human rendering and Manager. The exact current worktree record is pinned
 * even when higher-priority records consume the ordinary prefix budget.
 */
export function projectCodeGraphStatusActivityV3(
  selection: CodeGraphBuildStatusSelection,
  currentWorktreeId: string,
  limit: number,
): CodeGraphStatusActivityProjectionV3 {
  const boundedLimit = codeGraphStatusBuildLimit(limit);
  if (boundedLimit === undefined) throw new RangeError('Invalid code graph status build limit.');
  const exactCurrent = selection.builds.find(status => status.identity.worktreeId === currentWorktreeId);
  const selectedBuild =
    exactCurrent ?? selection.builds.find(status => status.observation.liveness === 'active') ?? null;
  const builds = boundedPrefixPreserving(selection.builds, selectedBuild, boundedLimit);
  const waiters = selection.waiters.slice(0, boundedLimit);
  const allQueuedWorktreeIds = stableUnique(selection.waiters.map(status => status.identity.worktreeId));
  const queuedWorktreeIds = allQueuedWorktreeIds.slice(0, boundedLimit);
  return {
    build: selectedBuild,
    builds,
    projection: {
      builds: listReceipt(selection.builds.length, builds.length, boundedLimit),
      queuedWorktreeIds: listReceipt(allQueuedWorktreeIds.length, queuedWorktreeIds.length, boundedLimit),
      waiters: listReceipt(selection.waiters.length, waiters.length, boundedLimit),
    },
    queuedWorktreeIds,
    waiterCount: selection.waiters.length,
    waiters,
  };
}

export function serializeCodeGraphStatusV3(
  selection: CodeGraphBuildStatusSelection,
  currentWorktreeId: string,
  buildLimit: number,
  details: CodeGraphStatusJsonDetailsV3,
): string {
  return JSON.stringify({
    ...projectCodeGraphStatusActivityV3(selection, currentWorktreeId, buildLimit),
    ...details,
    type: 'code-graph-status',
    version: 3,
  });
}

function boundedPrefixPreserving<T>(items: readonly T[], required: T | null, limit: number): readonly T[] {
  const projected = items.slice(0, limit);
  if (required === null || projected.includes(required)) return projected;
  return [...projected.slice(0, -1), required];
}

function stableUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function listReceipt(total: number, returned: number, limit: number): CodeGraphStatusBoundedListReceiptV3 {
  return {limit, omitted: total - returned, returned, total};
}
