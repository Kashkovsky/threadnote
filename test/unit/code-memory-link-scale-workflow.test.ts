import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';

interface WorkflowStep {
  readonly env?: Readonly<Record<string, string>>;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

describe('code-memory-link inverse-selector scale workflow', () => {
  it('runs the fixed 100k profile only on the release macOS class and stages a content-addressed G artifact', async () => {
    const workflow = load(await Bun.file('.github/workflows/benchmarks.yml').text(), {schema: JSON_SCHEMA}) as {
      readonly jobs: Readonly<
        Record<
          string,
          {
            readonly if?: string;
            readonly 'runs-on'?: string;
            readonly steps?: readonly WorkflowStep[];
            readonly 'timeout-minutes'?: number;
          }
        >
      >;
      readonly on: {
        readonly pull_request?: {readonly paths?: readonly string[]};
        readonly workflow_dispatch?: {readonly inputs?: Readonly<Record<string, unknown>>};
      };
    };
    const job = workflow.jobs['code-memory-link-inverse-scale']!;
    const benchmark = job.steps?.find(step => step.run?.includes('bench:code-memory-link-scale'));
    const stage = job.steps?.find(step => step.name === 'Stage the exact content-addressed G artifact');
    const upload = job.steps?.find(step => step.uses === 'actions/upload-artifact@v7');
    const command = benchmark?.run ?? '';

    expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty('include_code_memory_link_scale');
    expect(workflow.on.pull_request?.paths).toEqual(
      expect.arrayContaining([
        'scripts/benchmark-code-memory-link-scale.ts',
        'scripts/benchmark-code-memory-link-scale-target.ts',
        'test/evaluation/baselines/code-memory-link-scale-v1/**',
      ]),
    );
    expect(job.if).toContain("github.event_name == 'schedule'");
    expect(job.if).toContain('inputs.include_code_memory_link_scale');
    expect(job.if).not.toContain("github.event_name == 'pull_request'");
    expect(job['runs-on']).toBe('macos-15');
    expect(job['timeout-minutes']).toBe(120);
    expect(command).toContain('--candidate-commit "${{ github.sha }}"');
    expect(command).not.toContain('--development-smoke');
    expect(command).not.toContain('--memory-candidates');
    expect(command).not.toContain('--samples');
    expect(command).not.toContain('--warmups');
    expect(benchmark?.env?.THREADNOTE_BENCHMARK_RUNNER_CLASS).toBe('github-hosted-macos-15-ARM64');
    expect(stage?.run).toContain('shasum -a 256');
    expect(stage?.run).toContain('test/evaluation/retained/code-memory-link-scale');
    expect(upload?.with?.path).toBe('artifacts/test/evaluation/retained/code-memory-link-scale/*.json');
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    expect(upload?.with?.['retention-days']).toBe(90);
  });

  it('exposes the built-target wrapper as a dedicated package command', async () => {
    const manifest = JSON.parse(await Bun.file('package.json').text()) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    expect(manifest.scripts?.['bench:code-memory-link-scale']).toBe('bun scripts/benchmark-code-memory-link-scale.ts');
  });
});
