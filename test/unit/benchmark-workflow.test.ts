import {readFileSync} from 'node:fs';
import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';

interface WorkflowJob {
  readonly env?: Readonly<Record<string, string>>;
  readonly if?: string;
  readonly 'runs-on'?: string;
  readonly steps?: readonly {
    readonly if?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly run?: string;
    readonly 'timeout-minutes'?: number;
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string>>;
  }[];
  readonly strategy?: {
    readonly matrix?: {
      readonly scale?: readonly number[];
    };
  };
  readonly 'timeout-minutes'?: number;
  readonly uses?: string;
}

interface BenchmarkWorkflow {
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
  readonly on: {
    readonly pull_request?: {
      readonly paths?: readonly string[];
    };
    readonly workflow_dispatch?: {
      readonly inputs?: Readonly<Record<string, unknown>>;
    };
  };
}

describe('platform benchmark workflow', () => {
  it('runs only bounded lexical scale gates for graph and runtime pull requests', () => {
    const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const paths = workflow.on.pull_request?.paths ?? [];
    const pullRequestJob = workflow.jobs['code-graph-pr-scale']!;
    const command = pullRequestJob.steps?.flatMap(step => (step.run ? [step.run] : [])).join('\n') ?? '';
    const recallJob = workflow.jobs['recall-pr-10k']!;
    const recallCommand = recallJob.steps?.flatMap(step => (step.run ? [step.run] : [])).join('\n') ?? '';

    expect(paths).toEqual(
      expect.arrayContaining([
        '.github/workflows/benchmarks.yml',
        'scripts/benchmark-code-graph.ts',
        'scripts/code-graph-benchmark-sampler.ts',
        'scripts/benchmark-recall-vectors.ts',
        'scripts/evaluate-recall.ts',
        'src/code_graph/**',
        'src/effect/ai/**',
        'src/effect/runtime.ts',
        'src/models/**',
        'src/recall/**',
        'src/search/vector-index.ts',
        'test/evaluation/baselines/code-graph-v1/**',
      ]),
    );
    expect(pullRequestJob.if).toBe("github.event_name == 'pull_request'");
    expect(pullRequestJob['runs-on']).toBe('ubuntu-latest');
    expect(pullRequestJob['timeout-minutes']).toBe(20);
    expect(pullRequestJob.strategy?.matrix?.scale).toEqual([10_000, 100_000]);
    expect(command).toContain('--scale-symbols ${{ matrix.scale }}');
    expect(command).toContain('--fail-on-budget');
    expect(command).not.toContain('--vectors');
    expect(recallJob.if).toBe("github.event_name == 'pull_request'");
    expect(recallJob['runs-on']).toBe('ubuntu-latest');
    expect(recallJob['timeout-minutes']).toBeLessThanOrEqual(15);
    expect(recallCommand).toContain('bun run eval:recall');
    expect(recallCommand).toContain('bun run bench:recall:vectors');
    expect(recallCommand).toContain('--documents 10000');
    expect(recallCommand).toContain('--fail-on-budget');

    for (const jobName of [
      'code-graph',
      'code-graph-10k',
      'code-graph-vectors',
      'code-graph-vectors-10k',
      'recall-10k',
    ]) {
      expect(workflow.jobs[jobName]?.if).toContain("github.event_name == 'schedule'");
      expect(workflow.jobs[jobName]?.if).toContain("github.event_name == 'workflow_dispatch'");
      expect(workflow.jobs[jobName]?.if).not.toContain('refs/tags/');
    }
    for (const jobName of ['code-graph-100k', 'code-graph-vectors-100k', 'recall-100k']) {
      expect(workflow.jobs[jobName]?.if).toContain("github.event_name == 'schedule'");
    }
  });

  it('reuses one fail-closed production-large n=1 workflow for schedule, opt-in, and release gating', () => {
    const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const evidence = load(readFileSync('.github/workflows/production-large-evidence.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const caller = workflow.jobs['code-graph-production-large']!;
    const job = evidence.jobs['code-graph-production-large']!;
    const command = job.steps?.flatMap(step => (step.run ? [step.run] : [])).join('\n') ?? '';
    const capture = job.steps?.find(step => step.run?.includes('--profile production-large'));
    const upload = job.steps?.find(step => step.uses?.startsWith('actions/upload-artifact@'));

    expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty('include_production_large');
    expect(caller.if).toContain("github.event_name == 'schedule'");
    expect(caller.if).toContain('inputs.include_production_large');
    expect(caller.uses).toBe('./.github/workflows/production-large-evidence.yml');
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(360);
    expect(command).toContain('--profile production-large');
    expect(command).toContain('--samples 1');
    expect(command).toContain('--warmups 0');
    expect(command).toContain('code-graph-production-large-n1-');
    expect(job.env).toBeUndefined();
    expect(capture?.env).toMatchObject({
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-ubuntu-24.04-${{ runner.arch }}',
      THREADNOTE_BENCHMARK_RUNNER_ID: '${{ runner.name }}',
      THREADNOTE_BENCHMARK_RELEASE_REF: '${{ inputs.release_ref }}',
      THREADNOTE_BENCHMARK_RELEASE_SHA: '${{ inputs.release_sha }}',
    });
    const captureTimeout = capture?.['timeout-minutes'];
    expect(captureTimeout).toBeDefined();
    expect(job['timeout-minutes']! - (captureTimeout ?? 0)).toBeGreaterThanOrEqual(30);
    expect(upload?.uses).toBe('actions/upload-artifact@v7');
    expect(upload?.if).toBe('always()');
    expect(upload?.['timeout-minutes']).toBeLessThanOrEqual(10);
    expect(upload?.with?.path).toBe('artifacts/code-graph-production-large-n1-*.json');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    expect(upload?.with?.['retention-days']).toBe(90);
  });

  it('runs the large-monorepo heavy-tail regression only by schedule or explicit opt-in', () => {
    const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const job = workflow.jobs['code-graph-heavy-tail']!;
    const capture = job.steps?.find(step => step.run?.includes('bench:code-graph:heavy-tail'));
    const upload = job.steps?.find(step => step.uses?.startsWith('actions/upload-artifact@'));

    expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty('include_heavy_tail');
    expect(job.if).toContain("github.event_name == 'schedule'");
    expect(job.if).toContain('inputs.include_heavy_tail');
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(180);
    expect(capture?.run).toContain('bench:code-graph:heavy-tail');
    expect(capture?.env).toMatchObject({
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-ubuntu-24.04-${{ runner.arch }}',
      THREADNOTE_BENCHMARK_RUNNER_ID: '${{ runner.name }}',
    });
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.path).toBe('artifacts/code-graph-heavy-tail-*.json');
    expect(upload?.with?.['if-no-files-found']).toBe('warn');
  });
});
