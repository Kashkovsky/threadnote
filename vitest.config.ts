import {defineConfig} from 'vitest/config';

const ciLongRunningTestGroups: Record<string, string[]> = {
  lifecycle: ['test/integration/code-graph.lifecycle.test.ts'],
  'project-closure': ['test/integration/code-graph.project-closure.test.ts'],
  'incremental-property': ['test/integration/code-graph.incremental.property.test.ts'],
  'removed-view-cleanup-load': ['test/integration/code-graph.removed-view-cleanup-load.test.ts'],
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
  'graph-integration': [
    'test/integration/code-graph.snapshot-repair.property.test.ts',
    'test/integration/code-graph.cross-session-incremental.test.ts',
    'test/integration/code-graph.cache-capacity-load.test.ts',
    'test/integration/code-graph.session.test.ts',
  ],
  'benchmark-preflight': ['test/integration/code-graph.benchmark-preflight.test.ts'],
  'os-recovery': [
    'test/integration/code-graph.vector-retirement-os.test.ts',
    'test/integration/code-graph.removed-view-cleanup-os.test.ts',
    'test/integration/code-graph.cache-capacity-os.test.ts',
    'test/integration/code-graph.disk-reservation.test.ts',
  ],
  'stores-retention': [
    'test/unit/evaluation.recall-v2.test.ts',
    'test/unit/code-graph.project-closure-store.test.ts',
    'test/unit/code-graph.snapshot-retention.test.ts',
    'test/integration/share.sync.test.ts',
    'test/unit/code-graph.cache-coalescer.test.ts',
  ],
};

const ciLongRunningGroupName = process.env.THREADNOTE_VITEST_LONG_GROUP;
const ciLongRunningGroup = ciLongRunningGroupName ? ciLongRunningTestGroups[ciLongRunningGroupName] : undefined;

if (ciLongRunningGroupName && !ciLongRunningGroup) {
  throw new Error(`Unknown CI long-running test group: ${ciLongRunningGroupName}`);
}

const ciLongRunningTests = Object.values(ciLongRunningTestGroups).flat();

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
