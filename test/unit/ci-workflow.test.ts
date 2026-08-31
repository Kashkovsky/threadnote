import {readFileSync} from '../helpers/node-fs.js';
import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';
import {ciScopeKeys} from '../ci/ci-scopes.js';
import {
  CI_STANDARD_TEST_TIMEOUT_MILLISECONDS,
  ciLongRunningTestGroupNames,
  ciLongRunningTestGroups,
  ciRequiredLongRunningTestGroupNames,
  ciScheduledLongRunningTestGroupNames,
  ciSerializedLongRunningTestGroups,
} from '../ci/vitest-plan.js';

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
    readonly matrix?: Readonly<Record<string, readonly unknown[] | string>>;
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

    expect(Object.keys(changes.outputs ?? {})).toEqual([
      ...ciScopeKeys.slice(0, 2),
      'long_test_groups',
      ...ciScopeKeys.slice(2),
    ]);
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
    const remotePostgres = ci.jobs.remote_memory_postgres!;
    const actionlint = quality.steps?.find(
      step =>
        step.uses ===
        'docker://rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667',
    );

    expect(primary.needs).toEqual(['changes', 'quality', 'standard_tests', 'long_tests', 'remote_memory_postgres']);
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
    expect(stepForRun(standard, 'bun --bun vitest run --shard=${{ matrix.shard }}/4').env).toEqual({
      THREADNOTE_VITEST_STANDARD_SHARD: '${{ matrix.shard }}',
    });
    expect(standard.steps?.some(step => step.uses?.startsWith('actions/upload-artifact@'))).toBe(false);

    expect(long).toMatchObject({
      needs: 'changes',
      if: "needs.changes.outputs.code == 'true'",
    });
    expect(long.strategy?.matrix?.group).toBe('${{ fromJSON(needs.changes.outputs.long_test_groups) }}');
    expect(ciRequiredLongRunningTestGroupNames).toHaveLength(9);
    expect(long.steps?.find(step => step.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth']).toBe(0);
    expect(stepForRun(long, 'bun --bun vitest run').env).toEqual({
      THREADNOTE_VITEST_LONG_GROUP: '${{ matrix.group }}',
    });
    expect(long.steps?.some(step => step.uses?.startsWith('actions/upload-artifact@'))).toBe(false);

    expect(remotePostgres).toMatchObject({
      needs: 'changes',
      if: "needs.changes.outputs.code == 'true'",
    });
    expect(remotePostgres.steps?.filter(step => step.uses?.startsWith('actions/checkout@'))).toHaveLength(1);
    expect(
      stepForRun(remotePostgres, 'bun --bun vitest run test/integration/remote-memory-postgres.test.ts').env,
    ).toEqual({
      THREADNOTE_TEST_POSTGRES_URL: 'postgres://postgres:postgres@127.0.0.1:5432/threadnote_ci',
    });
    expect(primary.steps?.[0]?.env).toMatchObject({
      REMOTE_MEMORY_POSTGRES_RESULT: '${{ needs.remote_memory_postgres.result }}',
    });
  });

  it('keeps the quota-aware long-test plan bounded and non-overlapping', () => {
    expect(ciLongRunningTestGroupNames).toEqual(Object.keys(ciLongRunningTestGroups));
    expect(ciLongRunningTestGroupNames).toHaveLength(10);
    expect(ciRequiredLongRunningTestGroupNames).not.toContain('load-evidence');
    expect(ciScheduledLongRunningTestGroupNames).toEqual(['load-evidence']);
    expect(new Set([...ciRequiredLongRunningTestGroupNames, ...ciScheduledLongRunningTestGroupNames])).toEqual(
      new Set(ciLongRunningTestGroupNames),
    );
    expect([...ciSerializedLongRunningTestGroups]).toEqual([
      'heavy-integration',
      'heavy-state',
      'incremental-property',
      'load-evidence',
      'os-contention',
    ]);

    const assignments = Object.values(ciLongRunningTestGroups).flat();
    const counts = new Map<string, number>();
    for (const path of assignments) counts.set(path, (counts.get(path) ?? 0) + 1);
    expect([...counts].filter(([, count]) => count > 1)).toEqual([
      ['test/integration/code-graph.lifecycle.test.ts', 4],
    ]);
  });

  it('serializes the SQLite-heavy workset projection suite without relaxing its ordinary timeout', () => {
    expect(ciLongRunningTestGroups['heavy-state']).toContain('test/unit/code-graph.workset-catalog-projection.test.ts');
    expect(ciSerializedLongRunningTestGroups.has('heavy-state')).toBe(true);
    expect(CI_STANDARD_TEST_TIMEOUT_MILLISECONDS).toBe(30_000);
  });

  it('runs the actual-runtime citation gate on quality-relevant changes', () => {
    const ci = workflow('.github/workflows/ci.yml');
    const recallQuality = ci.jobs['recall-quality']!;

    expect(stepForRun(recallQuality, 'bun run eval:context-brief-citations:runtime').name).toBe(
      'Actual-runtime memory citation and Context Brief gate',
    );
    expect(stepForRun(recallQuality, 'bun run eval:code-memory-link-bench').name).toBe(
      'Actual-runtime code-to-memory backlink gate',
    );
  });

  it('gates quality, Windows, bytecode, and self-contained release matrices independently', () => {
    const jobs = workflow('.github/workflows/ci.yml').jobs;

    expect(jobs['recall-quality']).toMatchObject({
      needs: 'changes',
      if: "needs.changes.outputs.quality == 'true'",
    });
    expect(jobs['windows-smoke']).toMatchObject({
      needs: 'changes',
      if: "needs.changes.outputs.windows == 'true'",
    });
    expect(jobs['prepare-e2e-model']).toBeUndefined();
    expect(jobs['standalone-targets']).toMatchObject({
      needs: 'changes',
      if: "needs.changes.outputs.release == 'true'",
    });
    expect(jobs['self-contained-distribution']).toMatchObject({
      needs: 'changes',
      if: "needs.changes.outputs.release == 'true'",
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
        'package.json',
        'scripts/site-performance-evidence.ts',
        'scripts/site-release-notes.ts',
        'scripts/site-release-social-image.ts',
        'src/evaluation/benchmark.ts',
        'website/**',
      ]),
    );
    expect(pagePaths).not.toContain('src/**');
    expect(benchmarkPaths.some(path => path === 'website/**' || path.startsWith('website/'))).toBe(false);
  });
});
