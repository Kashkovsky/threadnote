import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import type {ObservedCodeGraphBuildStatus} from '../../src/code_graph/build_status.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../../src/code_graph/languages/registry.js';
import {codeGraphLanguagePackStatuses} from '../../src/code_graph/query_status_helpers.js';
import {
  CODE_GRAPH_STATUS_DEFAULT_BUILD_LIMIT,
  CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT,
  CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT,
  CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT,
  codeGraphStatusBuildLimit,
  codeGraphStatusLanguagePackLimit,
  projectCodeGraphStatusActivityV3,
  projectCodeGraphStatusLanguagePacksV4,
} from '../../src/code_graph/status_projection.js';

describe('code graph status JSON projection', () => {
  it('bounds the observed 74-worktree shape and pins an otherwise omitted current build', () => {
    const builds = Array.from({length: 74}, (_, index) => status(index, 'completed'));
    const waiters = Array.from({length: 74}, (_, index) => status(index + 100, 'active'));
    const currentWorktreeId = builds[73]!.identity.worktreeId;

    const result = projectCodeGraphStatusActivityV3({builds, waiters}, currentWorktreeId, 8);

    expect(result.build?.identity.worktreeId).toBe(currentWorktreeId);
    expect(result.builds).toHaveLength(8);
    expect(result.builds.map(build => build.identity.worktreeId)).toContain(currentWorktreeId);
    expect(result.waiters).toHaveLength(8);
    expect(result.queuedWorktreeIds).toHaveLength(8);
    expect(result.projection).toEqual({
      builds: {limit: 8, omitted: 66, returned: 8, total: 74},
      queuedWorktreeIds: {limit: 8, omitted: 66, returned: 8, total: 74},
      waiters: {limit: 8, omitted: 66, returned: 8, total: 74},
    });
    expect(result.waiterCount).toBe(74);
  });

  it('is deterministic, non-mutating, count-bounded, and current-preserving across arbitrary catalog sizes', () => {
    fc.assert(
      fc.property(
        fc.integer({max: 128, min: 0}),
        fc.integer({max: 128, min: 0}),
        fc.integer({max: 127, min: 0}),
        fc.integer({max: CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT, min: 1}),
        (buildCount, waiterCount, currentSeed, limit) => {
          const builds = Array.from({length: buildCount}, (_, index) =>
            status(index, index % 3 === 0 ? 'active' : 'completed'),
          );
          const waiters = Array.from({length: waiterCount}, (_, index) =>
            status(1_000 + Math.floor(index / 2), 'active'),
          );
          const current = buildCount === 0 ? hexId(10_000) : builds[currentSeed % buildCount]!.identity.worktreeId;
          const originalBuildOrder = builds.map(build => build.identity.worktreeId);
          const originalWaiterOrder = waiters.map(waiter => waiter.identity.worktreeId);

          const first = projectCodeGraphStatusActivityV3({builds, waiters}, current, limit);
          const second = projectCodeGraphStatusActivityV3({builds, waiters}, current, limit);

          expect(second).toEqual(first);
          expect(builds.map(build => build.identity.worktreeId)).toEqual(originalBuildOrder);
          expect(waiters.map(waiter => waiter.identity.worktreeId)).toEqual(originalWaiterOrder);
          expect(first.builds.length).toBeLessThanOrEqual(limit);
          expect(first.waiters.length).toBeLessThanOrEqual(limit);
          expect(first.queuedWorktreeIds.length).toBeLessThanOrEqual(limit);
          expect(new Set(first.queuedWorktreeIds).size).toBe(first.queuedWorktreeIds.length);
          expect(first.projection.builds).toEqual({
            limit,
            omitted: buildCount - first.builds.length,
            returned: first.builds.length,
            total: buildCount,
          });
          expect(first.projection.waiters).toEqual({
            limit,
            omitted: waiterCount - first.waiters.length,
            returned: first.waiters.length,
            total: waiterCount,
          });
          const queuedTotal = new Set(waiters.map(waiter => waiter.identity.worktreeId)).size;
          expect(first.projection.queuedWorktreeIds).toEqual({
            limit,
            omitted: queuedTotal - first.queuedWorktreeIds.length,
            returned: first.queuedWorktreeIds.length,
            total: queuedTotal,
          });
          if (buildCount > 0) {
            expect(first.build?.identity.worktreeId).toBe(current);
            expect(first.builds.map(build => build.identity.worktreeId)).toContain(current);
          }
        },
      ),
      {numRuns: 100},
    );
  });

  it('admits only the documented safe build-limit range', () => {
    expect(codeGraphStatusBuildLimit(undefined)).toBe(CODE_GRAPH_STATUS_DEFAULT_BUILD_LIMIT);
    expect(codeGraphStatusBuildLimit(1)).toBe(1);
    expect(codeGraphStatusBuildLimit(CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT)).toBe(
      CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT,
    );
    for (const invalid of [0, CODE_GRAPH_STATUS_MAXIMUM_BUILD_LIMIT + 1, 1.5, Number.NaN]) {
      expect(codeGraphStatusBuildLimit(invalid)).toBeUndefined();
    }
  });

  it('keeps the default rich language-pack projection compact and discoverable', () => {
    const languagePacks = codeGraphLanguagePackStatuses(BUILTIN_LANGUAGE_PACK_REGISTRY);
    const result = projectCodeGraphStatusLanguagePacksV4(languagePacks, CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT);

    expect(JSON.stringify(languagePacks).length).toBeGreaterThan(10_000);
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
    expect(result.items).toHaveLength(CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT);
    expect(result.receipt).toEqual({
      limit: CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT,
      omitted: languagePacks.length - CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT,
      returned: CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT,
      total: languagePacks.length,
    });
  });

  it('bounds language packs deterministically without mutating the complete catalog', () => {
    const builtins = codeGraphLanguagePackStatuses(BUILTIN_LANGUAGE_PACK_REGISTRY);
    fc.assert(
      fc.property(
        fc.integer({max: 128, min: 0}),
        fc.integer({max: CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT, min: 1}),
        (packCount, limit) => {
          const languagePacks = Array.from({length: packCount}, (_, index) => ({
            ...builtins[index % builtins.length]!,
            id: `pack-${index.toString().padStart(3, '0')}`,
          }));
          const originalIds = languagePacks.map(pack => pack.id);

          const first = projectCodeGraphStatusLanguagePacksV4(languagePacks, limit);
          const second = projectCodeGraphStatusLanguagePacksV4(languagePacks, limit);

          expect(second).toEqual(first);
          expect(languagePacks.map(pack => pack.id)).toEqual(originalIds);
          expect(first.items).toEqual(languagePacks.slice(0, limit));
          expect(first.items.length).toBeLessThanOrEqual(limit);
          expect(first.receipt).toEqual({
            limit,
            omitted: packCount - first.items.length,
            returned: first.items.length,
            total: packCount,
          });
        },
      ),
      {numRuns: 100},
    );
  });

  it('admits only the documented safe language-pack-limit range', () => {
    expect(codeGraphStatusLanguagePackLimit(undefined)).toBe(CODE_GRAPH_STATUS_DEFAULT_LANGUAGE_PACK_LIMIT);
    expect(codeGraphStatusLanguagePackLimit(1)).toBe(1);
    expect(codeGraphStatusLanguagePackLimit(CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT)).toBe(
      CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT,
    );
    for (const invalid of [0, CODE_GRAPH_STATUS_MAXIMUM_LANGUAGE_PACK_LIMIT + 1, 1.5, Number.NaN]) {
      expect(codeGraphStatusLanguagePackLimit(invalid)).toBeUndefined();
    }
  });
});

function status(index: number, liveness: 'active' | 'completed'): ObservedCodeGraphBuildStatus {
  return {
    identity: {worktreeId: hexId(index)},
    observation: {heartbeatAgeMilliseconds: index, liveness},
  } as ObservedCodeGraphBuildStatus;
}

function hexId(index: number): string {
  return index.toString(16).padStart(64, '0');
}
