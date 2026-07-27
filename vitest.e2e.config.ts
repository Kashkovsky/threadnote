import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 300_000,
    include: ['test/e2e/**/*.e2e.ts'],
    testTimeout: 300_000,
  },
});
