import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
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
