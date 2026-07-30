import {readFileSync} from 'node:fs';
import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';

interface WorkflowJob {
  readonly if?: string;
  readonly 'runs-on'?: string;
  readonly steps?: readonly {
    readonly run?: string;
    readonly uses?: string;
  }[];
  readonly strategy?: {
    readonly matrix?: {
      readonly scale?: readonly number[];
    };
  };
  readonly 'timeout-minutes'?: number;
}

interface BenchmarkWorkflow {
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
  readonly on: {
    readonly pull_request?: {
      readonly paths?: readonly string[];
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
      expect(workflow.jobs[jobName]?.if).toBe("github.event_name != 'pull_request'");
    }
    for (const jobName of ['code-graph-100k', 'code-graph-vectors-100k', 'recall-100k']) {
      expect(workflow.jobs[jobName]?.if).toContain("github.event_name == 'schedule'");
    }
  });
});
