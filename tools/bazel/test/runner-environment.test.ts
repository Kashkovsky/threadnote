import {readFileSync} from '@threadnote/testing/node-fs';
import {describe, expect, it} from 'vitest';

describe('Bazel test runner environment', () => {
  it('exposes Git to process-boundary integration tests', () => {
    const result = Bun.spawnSync(['git', '--version'], {stderr: 'pipe', stdout: 'pipe'});

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toMatch(/^git version /u);
  });

  it('does not inject product telemetry kill switches into the test process', () => {
    const source = readFileSync('tools/bazel/runner.mjs', 'utf8');

    expect(source).not.toContain('DO_NOT_TRACK:');
  });
});
