import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
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
