import {readFileSync} from '@threadnote/testing/node-fs';
import {expect, it} from 'vitest';
import {parse} from 'yaml';

interface Step {
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
}

interface Job {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly outputs?: Readonly<Record<string, string>>;
  readonly services?: Readonly<Record<string, unknown>>;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly jobs?: Readonly<Record<string, Job>>;
}

const workflowPath = '.github/workflows/ci.yml';
const workflow = parse(readFileSync(workflowPath, 'utf8')) as Workflow;
const jobs = workflow.jobs ?? {};

function step(job: Job | undefined, name: string): Step | undefined {
  return job?.steps?.find(candidate => candidate.name === name);
}

it('uses one authoritative Bazel selection and execution lane', async () => {
  expect(await Bun.file('.github/workflows/bazel.yml').exists()).toBe(false);
  expect(Object.keys(jobs)).toContain('bazel');
  expect(step(jobs.bazel, 'Verify generated Bazel declarations')?.run).toBe('bun tools/bazel/generate.mjs --check');
  expect(step(jobs.bazel, 'Select affected Bazel targets')).toMatchObject({
    id: 'selection',
    run: 'bun tools/ci/bazel-select.mjs --base "$BASE_SHA"',
  });
  expect(step(jobs.bazel, 'Execute selected Bazel targets')?.run).toBe('bun tools/ci/bazel-run-selected.mjs');
  expect(jobs.bazel?.services).toHaveProperty('postgres');

  const source = readFileSync(workflowPath, 'utf8');
  expect(source).not.toContain('ci-scopes.ts');
  expect(source).not.toContain('THREADNOTE_VITEST_SELECTION');
  expect(source).not.toContain('Bazel shadow');
});

it('routes platform and quality lanes from Bazel outputs', () => {
  expect(jobs.bazel?.outputs).toEqual({
    recall_quality: '${{ steps.selection.outputs.recall_quality }}',
    release_matrix: '${{ steps.selection.outputs.release_matrix }}',
    windows_smoke: '${{ steps.selection.outputs.windows_smoke }}',
  });
  expect(jobs['recall-quality']?.if).toBe("needs.bazel.outputs.recall_quality == 'true'");
  expect(jobs['windows-smoke']?.if).toBe("needs.bazel.outputs.windows_smoke == 'true'");
  expect(jobs['standalone-targets']?.if).toBe("needs.bazel.outputs.release_matrix == 'true'");
  expect(jobs['self-contained-distribution']?.if).toBe("needs.bazel.outputs.release_matrix == 'true'");
});

it('keeps the stable aggregate check and requires the Bazel lane', () => {
  expect(jobs.test?.if).toBe('always()');
  expect(jobs.test?.needs).toEqual([
    'bazel',
    'recall-quality',
    'windows-smoke',
    'standalone-targets',
    'self-contained-distribution',
  ]);
  expect(step(jobs.test, 'Require every selected lane')?.run).toContain('test "$BAZEL_RESULT" = success');
});
