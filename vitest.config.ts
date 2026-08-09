import {defineConfig} from 'vitest/config';

const ciLongRunningTestGroups: Record<string, string[]> = {
  'lifecycle-serves': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-shares': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-materializes': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-global-resolution': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-file-set-change': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-core-a': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-core-b': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-core-c': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-core-d': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-core-e': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-core-f': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-core-g': ['test/integration/code-graph.lifecycle.test.ts'],
  'project-closure-reattribution': ['test/integration/code-graph.project-closure.test.ts'],
  'project-closure-clean-base': ['test/integration/code-graph.project-closure.test.ts'],
  'project-closure-cache-tuple': ['test/integration/code-graph.project-closure.test.ts'],
  'project-closure-loss': ['test/integration/code-graph.project-closure.test.ts'],
  'project-closure-fail-closed': ['test/integration/code-graph.project-closure.test.ts'],
  'project-closure-overflow': ['test/integration/code-graph.project-closure.test.ts'],
  'project-closure-property': ['test/integration/code-graph.project-closure.test.ts'],
  'incremental-body-property': ['test/integration/code-graph.incremental.property.test.ts'],
  'incremental-clean-property': ['test/integration/code-graph.incremental.property.test.ts'],
  'incremental-surface-property': ['test/integration/code-graph.incremental.property.test.ts'],
  'incremental-recovery': ['test/integration/code-graph.incremental.property.test.ts'],
  'incremental-barrel-property': ['test/integration/code-graph.incremental.property.test.ts'],
  'removed-view-cleanup-load': ['test/integration/code-graph.removed-view-cleanup-load.test.ts'],
  'removed-view-cleanup-property': ['test/unit/code-graph.removed-view-cleanup.property.test.ts'],
  'view-removal-property': ['test/unit/code-graph.view-removal.property.test.ts'],
  'worktree-reconciliation': ['test/unit/code-graph.worktree-reconciliation.test.ts'],
  'cli-native-tools': ['test/integration/cli.effect.test.ts', 'test/integration/mcp.native-tools.test.ts'],
  'view-attach-lock': ['test/integration/code-graph.view-attach-lock.test.ts'],
  'vector-retirement': [
    'test/unit/code-graph.vector-retirement-schema.test.ts',
    'test/unit/code-graph.vector-retirement-ordinary.test.ts',
    'test/integration/code-graph.vector-retirement-load.test.ts',
    'test/unit/code-graph.vector-maintenance.test.ts',
    'test/unit/code-graph.materialization-store.test.ts',
  ],
  'parser-languages': [
    'test/unit/code-graph.tree-sitter-identity.property.test.ts',
    'test/unit/code-graph.languages.property.test.ts',
    'test/unit/code-graph.languages.test.ts',
  ],
  'graph-snapshot-repair': ['test/integration/code-graph.snapshot-repair.property.test.ts'],
  'graph-cross-session': ['test/integration/code-graph.cross-session-incremental.test.ts'],
  'graph-cache-capacity-load': ['test/integration/code-graph.cache-capacity-load.test.ts'],
  'graph-session': ['test/integration/code-graph.session.test.ts'],
  'benchmark-preflight': ['test/integration/code-graph.benchmark-preflight.test.ts'],
  'vector-retirement-os': ['test/integration/code-graph.vector-retirement-os.test.ts'],
  'removed-view-cleanup-os': ['test/integration/code-graph.removed-view-cleanup-os.test.ts'],
  'cache-capacity-os': ['test/integration/code-graph.cache-capacity-os.test.ts'],
  'disk-reservation': ['test/integration/code-graph.disk-reservation.test.ts'],
  'stores-retention': [
    'test/unit/evaluation.recall-v2.test.ts',
    'test/unit/code-graph.project-closure-store.test.ts',
    'test/unit/code-graph.snapshot-retention.test.ts',
    'test/integration/share.sync.test.ts',
    'test/unit/code-graph.cache-coalescer.test.ts',
  ],
};

const ciLongRunningTestPatterns: Partial<Record<string, RegExp>> = {
  'lifecycle-serves': /serves parallel ready-snapshot queries/u,
  'lifecycle-shares': /shares immutable clean snapshots/u,
  'lifecycle-materializes': /materializes only body-changed files/u,
  'lifecycle-global-resolution': /clean commit changes global resolution/u,
  'lifecycle-file-set-change': /clean commit adds or deletes a file/u,
  'lifecycle-core-a':
    /native code graph lifecycle (?:aliases|atomically|attaches|batches|builds|changes|coalesces|collapses|counts)\b/u,
  'lifecycle-core-b':
    /native code graph lifecycle (?:(?:does|fails)\b|falls back to complete attribution|full materialization fallback .* fails closed)/u,
  'lifecycle-core-c': /native code graph lifecycle (?:holds|indexes|keeps)\b/u,
  'lifecycle-core-d': /native code graph lifecycle (?:marks|pauses|performs|preserves|prunes|publishes|purges)\b/u,
  'lifecycle-core-e': /native code graph lifecycle (?:rebuilds|recovers|refreshes|refuses|rehydrates|rejects)\b/u,
  'lifecycle-core-f':
    /native code graph lifecycle (?:releases|removes|reports|reprotects|reserves|retains|resumes|retries|reuses)\b/u,
  'lifecycle-core-g': /native code graph lifecycle (?:sanitizes|streams|synchronously|treats|uses|visibly|waits)\b/u,
  'project-closure-reattribution': /reattributes the exact reverse-dependent project closure/u,
  'project-closure-clean-base': /uses the same project closure from a nearby persisted clean base/u,
  'project-closure-cache-tuple': /reparses and replaces a valid cache tuple/u,
  'project-closure-loss': /falls back through bounded full materialization/u,
  'project-closure-fail-closed': /fails closed for file-set, global-surface/u,
  'project-closure-overflow': /reports an exact typed fallback/u,
  'project-closure-property': /matches forced-full graph, query, catalog/u,
  'incremental-body-property': /randomized body-only edits/u,
  'incremental-clean-property': /randomized compatible changes/u,
  'incremental-surface-property': /randomized clean resolution-surface changes/u,
  'incremental-recovery': /(?:resumes|does not reuse|reclaims|keeps|switches) /u,
  'incremental-barrel-property': /randomized transitive and cyclic named barrels/u,
};

const ciLongRunningGroupName = process.env.THREADNOTE_VITEST_LONG_GROUP;
const ciLongRunningGroup = ciLongRunningGroupName ? ciLongRunningTestGroups[ciLongRunningGroupName] : undefined;

if (ciLongRunningGroupName && !ciLongRunningGroup) {
  throw new Error(`Unknown CI long-running test group: ${ciLongRunningGroupName}`);
}

const ciLongRunningTests = [...new Set(Object.values(ciLongRunningTestGroups).flat())];

export default defineConfig({
  test: {
    // Test files use isolated Threadnote homes, so the production home-scoped
    // parser-slot locks cannot bound child processes across Vitest workers.
    // Dedicated parser-pool and heavy-tail tests exercise parallel extraction.
    env: {THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '1'},
    environment: 'node',
    // Bound local shared-machine dogfood runs. CI uses Vitest's available worker
    // pool inside each isolated matrix runner instead of serializing 240+ files.
    ...(process.env.CI ? {} : {maxWorkers: 2}),
    hookTimeout: 30_000,
    include: ciLongRunningGroup ?? ['test/**/*.test.ts'],
    exclude: process.env.THREADNOTE_VITEST_STANDARD_SHARD ? ciLongRunningTests : undefined,
    testNamePattern: ciLongRunningGroupName ? ciLongRunningTestPatterns[ciLongRunningGroupName] : undefined,
    // Only the explicitly isolated long-running matrix gets the instrumented
    // ceiling. Ordinary CI shards retain the same fast timeout as local runs.
    testTimeout: process.env.THREADNOTE_VITEST_LONG_GROUP ? 120_000 : 30_000,
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/types.ts',
        'src/threadnote.ts',
        'src/mcp_server.ts',
        'src/mcp.ts',
        'src/hooks.ts',
        'src/lifecycle.ts',
        'src/seeding.ts',
        'src/manifest.ts',
        'src/memory.ts',
        'src/runtime.ts',
        'src/update-check.ts',
      ],
    },
  },
});
