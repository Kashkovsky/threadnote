import {defineConfig} from 'vitest/config';
import {
  ciLongRunningTestGroups,
  ciSerializedLongRunningTestGroups,
  type CiLongRunningTestGroupName,
} from './test/ci/vitest-plan.js';

const lifecycleAlphaVerbs =
  'aliases|atomically|attaches|batches|builds|changes|coalesces|collapses|counts|falls|materializes|serves|shares';
const lifecycleBetaVerbs = 'does|fails|sanitizes|streams|synchronously|treats|uses|visibly|waits';
const lifecycleBetaNested = 'full materialization fallback .* fails closed';
const lifecycleGammaVerbs = 'holds|indexes|keeps|marks|pauses|performs|preserves|prunes|publishes|purges';
const knownLifecycleVerbs = `${lifecycleAlphaVerbs}|${lifecycleBetaVerbs}|${lifecycleGammaVerbs}`;
const lifecycleTestPrefix = 'native code graph lifecycle ';

const ciLongRunningTestPatterns: Partial<Record<string, RegExp>> = {
  'lifecycle-alpha': new RegExp(`${lifecycleTestPrefix}(?:${lifecycleAlphaVerbs})\\b`, 'u'),
  'lifecycle-beta': new RegExp(`${lifecycleTestPrefix}(?:(?:${lifecycleBetaVerbs})\\b|${lifecycleBetaNested})`, 'u'),
  'lifecycle-gamma': new RegExp(`${lifecycleTestPrefix}(?:${lifecycleGammaVerbs})\\b`, 'u'),
  // The final group is deliberately a fallback. New lifecycle tests cannot be
  // silently omitted merely because their title starts with a new verb.
  'lifecycle-delta': new RegExp(
    `${lifecycleTestPrefix}(?!(?:${knownLifecycleVerbs})\\b|${lifecycleBetaNested}).+`,
    'u',
  ),
};

const ciLongRunningGroupName = process.env.THREADNOTE_VITEST_LONG_GROUP;
const ciLongRunningGroup = ciLongRunningGroupName
  ? ciLongRunningTestGroups[ciLongRunningGroupName as CiLongRunningTestGroupName]
  : undefined;
const ciSerializedLongGroup = ciLongRunningGroupName
  ? ciSerializedLongRunningTestGroups.has(ciLongRunningGroupName as CiLongRunningTestGroupName)
  : false;

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
    ...(ciSerializedLongGroup ? {fileParallelism: false, maxWorkers: 1} : {}),
    hookTimeout: 30_000,
    include: ciLongRunningGroup ? [...ciLongRunningGroup] : ['test/**/*.test.ts'],
    exclude: process.env.THREADNOTE_VITEST_STANDARD_SHARD ? ciLongRunningTests : undefined,
    testNamePattern: ciLongRunningGroupName ? ciLongRunningTestPatterns[ciLongRunningGroupName] : undefined,
    // Long groups are independently bounded jobs; ordinary shards retain the
    // same fast timeout as local runs so new regressions fail promptly.
    testTimeout: process.env.THREADNOTE_VITEST_LONG_GROUP ? 180_000 : 30_000,
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
