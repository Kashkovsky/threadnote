import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tools/bazel/spike/*.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
