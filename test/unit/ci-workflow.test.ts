import {readFileSync} from 'node:fs';
import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';
import {ciScopeKeys} from '../ci/ci-scopes.js';

interface WorkflowStep {
  readonly env?: Readonly<Record<string, string>>;
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly outputs?: Readonly<Record<string, string>>;
  readonly strategy?: {
    readonly 'fail-fast'?: boolean;
    readonly matrix?: Readonly<Record<string, readonly unknown[]>>;
  };
  readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
  readonly on: {
    readonly pull_request?: {
      readonly paths?: readonly string[];
      readonly 'paths-ignore'?: readonly string[];
    };
    readonly push?: {
      readonly paths?: readonly string[];
      readonly 'paths-ignore'?: readonly string[];
    };
  };
}

function workflow(path: string): Workflow {
  return load(readFileSync(path, 'utf8'), {schema: JSON_SCHEMA}) as Workflow;
}

function stepForRun(job: WorkflowJob, run: string): WorkflowStep {
  const step = job.steps?.find(candidate => candidate.run === run);
  expect(step, `missing workflow step: ${run}`).toBeDefined();
  return step!;
}

describe('dependency-aware CI workflow', () => {
  it('exports every classifier scope and preserves a fail-safe full-diff checkout', () => {
    const ci = workflow('.github/workflows/ci.yml');
    const changes = ci.jobs.changes!;
    const checkout = changes.steps?.find(step => step.uses?.startsWith('actions/checkout@'));
    const classifier = changes.steps?.find(step => step.id === 'scopes');

    expect(Object.keys(changes.outputs ?? {})).toEqual(ciScopeKeys);
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(classifier?.run).toBe('bun test/ci/ci-scopes.ts --base "$BASE_SHA" --head "$HEAD_SHA"');
    expect(classifier?.env).toMatchObject({
      BASE_SHA: '${{ github.event.pull_request.base.sha || github.event.before }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha || github.sha }}',
    });
  });

  it('keeps the stable primary check while parallelizing scoped tests and quality gates', () => {
    const ci = workflow('.github/workflows/ci.yml');
    const primary = ci.jobs.test!;
    const quality = ci.jobs.quality!;
    const standard = ci.jobs.standard_tests!;
    const long = ci.jobs.long_tests!;
    const actionlint = quality.steps?.find(step => step.uses === 'docker://rhysd/actionlint:1.7.8');

    expect(primary.needs).toEqual(['changes', 'quality', 'standard_tests', 'long_tests']);
    expect(primary.if).toBe('always()');
    expect(primary.steps?.some(step => step.name === 'Require every applicable test shard')).toBe(true);

    expect(quality.needs).toBe('changes');
    expect(actionlint?.if).toBe("needs.changes.outputs.actions == 'true'");
    expect(stepForRun(quality, 'bun run prettier:check').if).toBeUndefined();
    expect(stepForRun(quality, 'bun run lint').if).toBe("needs.changes.outputs.code == 'true'");
    expect(stepForRun(quality, 'bun run typecheck').if).toBe("needs.changes.outputs.code == 'true'");
    expect(stepForRun(quality, 'bun run site:check').if).toBe(
      "needs.changes.outputs.site_check == 'true' && needs.changes.outputs.code != 'true'",
    );
    expect(stepForRun(quality, 'bun run site:build').if).toBe("needs.changes.outputs.site_build == 'true'");
    expect(stepForRun(quality, 'bun run build').if).toBe("needs.changes.outputs.release == 'true'");
    expect(stepForRun(quality, 'bun run check:self-contained').if).toBe("needs.changes.outputs.release == 'true'");

    expect(standard).toMatchObject({
      needs: 'changes',
      if: "needs.changes.outputs.code == 'true'",
      strategy: {matrix: {shard: [1, 2, 3, 4]}},
    });
    expect(standard.steps?.find(step => step.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth']).toBe(0);
    expect(stepForRun(standard, 'bun --bun vitest run --coverage --shard=${{ matrix.shard }}/4').env).toEqual({
      THREADNOTE_VITEST_STANDARD_SHARD: '1',
    });

    expect(long).toMatchObject({
      needs: 'changes',
      if: "needs.changes.outputs.code == 'true'",
    });
    expect(long.strategy?.matrix?.group).toHaveLength(12);
    expect(long.steps?.find(step => step.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth']).toBe(0);
    expect(stepForRun(long, 'bun run test:coverage').env).toEqual({
      THREADNOTE_VITEST_LONG_GROUP: '${{ matrix.group }}',
    });
  });

  it('gates quality, Windows, bytecode, model, and release matrices independently', () => {
    const jobs = workflow('.github/workflows/ci.yml').jobs;

    expect(jobs['recall-quality']).toMatchObject({
      needs: 'changes',
      if: "needs.changes.outputs.quality == 'true'",
    });
    expect(jobs['windows-smoke']).toMatchObject({
      needs: 'changes',
      if: "needs.changes.outputs.windows == 'true'",
    });
    for (const name of ['prepare-e2e-model', 'standalone-targets']) {
      expect(jobs[name]).toMatchObject({
        needs: 'changes',
        if: "needs.changes.outputs.release == 'true'",
      });
    }
    expect(jobs['self-contained-distribution']).toMatchObject({
      needs: ['changes', 'prepare-e2e-model'],
      if: "needs.changes.outputs.release == 'true' && needs.prepare-e2e-model.result == 'success'",
    });
  });

  it('routes website-only changes to PR site checks and output-changing pushes to Pages', () => {
    const ci = workflow('.github/workflows/ci.yml');
    const pages = workflow('.github/workflows/pages.yml');
    const benchmarks = workflow('.github/workflows/benchmarks.yml');
    const pagePaths = pages.on.push?.paths ?? [];
    const benchmarkPaths = benchmarks.on.pull_request?.paths ?? [];

    expect(ci.on.push?.['paths-ignore']).toEqual(
      expect.arrayContaining(['.github/release-notes/**', '*.md', 'LICENSE', 'docs/**', 'website/**']),
    );
    expect(ci.on.pull_request?.['paths-ignore']).toBeUndefined();
    expect(pagePaths).toEqual(
      expect.arrayContaining([
        '.github/workflows/pages.yml',
        'scripts/site-performance-evidence.ts',
        'src/evaluation/benchmark.ts',
        'website/**',
      ]),
    );
    expect(pagePaths).not.toContain('src/**');
    expect(benchmarkPaths.some(path => path === 'website/**' || path.startsWith('website/'))).toBe(false);
  });
});
