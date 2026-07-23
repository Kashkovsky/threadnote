import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 600_000,
    include: ['test/e2e/**/*.windows.e2e.ts'],
    testTimeout: 600_000,
  },
});
