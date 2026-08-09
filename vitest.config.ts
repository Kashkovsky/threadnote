import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // Test files use isolated Threadnote homes, so the production home-scoped
    // parser-slot locks cannot bound child processes across Vitest workers.
    // Dedicated parser-pool and heavy-tail tests exercise parallel extraction.
    env: {THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '1'},
    environment: 'node',
    // Bound parallelism so shared-machine dogfood hosts do not overcommit parser,
    // SQLite, and child-process work. Instrumented CI coverage is serialized because
    // even two workers can push long lifecycle fixtures past their 30-second contract.
    maxWorkers: process.env.CI ? 1 : 2,
    hookTimeout: 30_000,
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
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
