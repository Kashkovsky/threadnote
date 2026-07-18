import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['test/e2e/**/*.e2e.ts'],
    testTimeout: 120_000,
  },
});
