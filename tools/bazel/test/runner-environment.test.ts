import {describe, expect, it} from 'vitest';

describe('Bazel test runner environment', () => {
  it('exposes Git to process-boundary integration tests', () => {
    const result = Bun.spawnSync(['git', '--version'], {stderr: 'pipe', stdout: 'pipe'});

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toMatch(/^git version /u);
  });
});
