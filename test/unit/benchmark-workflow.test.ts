import {readFileSync} from '../helpers/node-fs.js';
import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';

interface WorkflowJob {
  readonly env?: Readonly<Record<string, string>>;
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly outputs?: Readonly<Record<string, string>>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly 'runs-on'?: string;
  readonly steps?: readonly {
    readonly 'continue-on-error'?: boolean;
    readonly id?: string;
    readonly if?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly name?: string;
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
  readonly with?: Readonly<Record<string, unknown>>;
}

interface BenchmarkWorkflow {
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
  readonly on: {
    readonly push?: {
      readonly tags?: readonly string[];
    };
    readonly pull_request?: {
      readonly paths?: readonly string[];
    };
    readonly workflow_dispatch?: {
      readonly inputs?: Readonly<Record<string, unknown>>;
    };
    readonly workflow_call?: {
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
    const worksetJob = workflow.jobs['code-graph-workset']!;
    const worksetCommand = worksetJob.steps?.flatMap(step => (step.run ? [step.run] : [])).join('\n') ?? '';

    expect(paths).toEqual(
      expect.arrayContaining([
        '.github/workflows/benchmarks.yml',
        'scripts/benchmark-code-graph.ts',
        'scripts/benchmark-code-graph-workset.ts',
        'scripts/code-graph-benchmark-sampler.ts',
        'scripts/benchmark-recall-vectors.ts',
        'scripts/recall-vector-performance-budget.ts',
        'scripts/evaluate-recall.ts',
        'src/code_graph/**',
        'src/effect/ai/**',
        'src/effect/runtime.ts',
        'src/models/**',
        'src/recall/**',
        'src/search/vector-index.ts',
        'test/evaluation/baselines/code-graph-v1/**',
        'test/evaluation/baselines/code-graph-workset-v1/**',
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
    const recallArtifactStep = recallJob.steps?.find(
      step =>
        step.uses === 'actions/upload-artifact@v7' &&
        step.with?.name === 'recall-vector-benchmark-pr-10000-Linux-${{ runner.arch }}',
    );
    expect(recallArtifactStep?.if).toBe('always()');
    expect(recallArtifactStep?.with?.['if-no-files-found']).toBe('warn');
    expect(recallArtifactStep?.with?.path).toBe('artifacts/recall-vectors-pr-10000-Linux-${{ runner.arch }}.json');
    expect(worksetJob.if).toContain("github.event_name == 'schedule'");
    expect(worksetJob.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(worksetJob['runs-on']).toBe('ubuntu-24.04');
    expect(worksetCommand).toContain('--sizes 1,8,32,64,128');
    expect(worksetCommand).toContain('--sizes 32,50,64,128');
    expect(worksetCommand).toContain('--samples 25');
    expect(worksetCommand).toContain('--warmups 5');
    expect(worksetCommand).not.toContain('--fail-on-budget');

    for (const jobName of [
      'code-graph',
      'code-graph-10k',
      'code-graph-load-evidence',
      'code-graph-vectors',
      'code-graph-vectors-10k',
      'recall-10k',
    ]) {
      expect(workflow.jobs[jobName]?.if).toContain("github.event_name == 'schedule'");
      expect(workflow.jobs[jobName]?.if).toContain("github.event_name == 'workflow_dispatch'");
      expect(workflow.jobs[jobName]?.if).not.toContain('refs/tags/');
    }

    const loadEvidence = workflow.jobs['code-graph-load-evidence']!;
    const loadEvidenceStep = loadEvidence.steps?.find(step => step.env?.THREADNOTE_VITEST_LONG_GROUP);
    expect(loadEvidence['runs-on']).toBe('ubuntu-latest');
    expect(loadEvidence['timeout-minutes']).toBe(30);
    expect(loadEvidenceStep).toMatchObject({
      env: {THREADNOTE_VITEST_LONG_GROUP: 'load-evidence'},
      run: 'bun --bun vitest run',
    });
    for (const jobName of ['code-graph-100k', 'code-graph-vectors-100k', 'recall-100k']) {
      expect(workflow.jobs[jobName]?.if).toContain("github.event_name == 'schedule'");
    }
  });

  it('runs one reduced production ratchet only for graph-affecting pull requests', () => {
    const ratchetWorkflow = load(readFileSync('.github/workflows/code-graph-production-ratchet.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const paths = ratchetWorkflow.on.pull_request?.paths ?? [];
    const classifier = ratchetWorkflow.jobs.classify!;
    const job = ratchetWorkflow.jobs.ratchet!;
    const command = job.steps?.flatMap(step => (step.run ? [step.run] : [])).join('\n') ?? '';

    expect(paths).toEqual(
      expect.arrayContaining([
        '.github/workflows/code-graph-production-ratchet.yml',
        'scripts/benchmark-code-graph.ts',
        'test/ci/code-graph-production-ratchet-scope.ts',
        'src/code_graph/**',
        'src/effect/errors.ts',
        'src/effect/file_durability.ts',
        'src/effect/time.ts',
        'src/process_diagnostics.ts',
        'src/telemetry/session.ts',
        'src/utils.ts',
        'src/worker_protocol.ts',
        'test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json',
        'test/unit/code-graph.production-ratchet-scope.property.test.ts',
      ]),
    );
    expect(paths).not.toContain('src/recall/**');
    expect(paths.join('\n').toLowerCase()).not.toContain('intellij');
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(15);
    expect(job.needs).toBe('classify');
    expect(job.if).toBe('always()');
    expect(classifier.outputs?.release_metadata_only).toBe('${{ steps.scope.outputs.release_metadata_only }}');
    expect(classifier.steps?.find(step => step.id === 'scope')).toMatchObject({
      name: 'Skip only a strict release-metadata diff',
      run: 'bun test/ci/code-graph-production-ratchet-scope.ts --base "$BASE_SHA" --head "$HEAD_SHA"',
    });
    const guardedSteps = job.steps?.filter(
      step =>
        step.uses === 'actions/checkout@v7' ||
        step.uses === 'oven-sh/setup-bun@v2' ||
        step.run === 'bun install --frozen-lockfile' ||
        step.name === 'Gate the governed reduced production profile',
    );
    expect(guardedSteps).toHaveLength(4);
    for (const step of guardedSteps ?? []) {
      expect(step.if).toBe(
        "needs.classify.result != 'success' || needs.classify.outputs.release_metadata_only != 'true'",
      );
    }
    expect(job.steps?.find(step => step.uses === 'actions/upload-artifact@v7')?.if).toContain(
      "needs.classify.result != 'success' || needs.classify.outputs.release_metadata_only != 'true'",
    );
    expect(command.match(/--samples 1/g)).toHaveLength(1);
    expect(command).toContain('--profile production-large');
    expect(command).toContain('--profile-files 3000');
    expect(command).toContain('--profile-symbols 110000');
    expect(command).toContain('--minimum-free-gib 20');
    expect(command).toContain(
      '--ratchet test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json',
    );
    expect(command).not.toContain('bench:code-graph:production:ratchet');
  });

  it('prepares one verified model artifact before every vector benchmark lane', () => {
    const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const preparation = workflow.jobs['prepare-code-graph-vector-model']!;
    const preparationSteps = preparation.steps ?? [];

    expect(preparation.if).toContain("github.event_name == 'schedule'");
    expect(preparation.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(preparation['timeout-minutes']).toBeLessThanOrEqual(10);
    expect(preparationSteps.find(step => step.id === 'graph-model-cache')?.uses).toBe('actions/cache@v6');
    expect(preparationSteps.find(step => step.run?.includes('models install'))?.run).toContain(
      '${CODE_GRAPH_EMBEDDING_MODEL_ID}',
    );
    expect(preparationSteps.find(step => step.uses === 'actions/upload-artifact@v7')?.with).toMatchObject({
      'if-no-files-found': 'error',
      name: 'code-graph-core-embedding-model',
    });

    for (const jobName of ['code-graph-vectors', 'code-graph-vectors-10k', 'code-graph-vectors-100k']) {
      const job = workflow.jobs[jobName]!;
      expect(job.needs).toBe('prepare-code-graph-vector-model');
      const download = job.steps?.find(step => step.uses === 'actions/download-artifact@v8');
      expect(download?.with).toMatchObject({name: 'code-graph-core-embedding-model'});
      expect(job.steps?.some(step => step.uses === 'actions/cache@v6')).toBe(false);
    }
  });

  it('bounds the shared production-large n=1 workflow for schedule, opt-in, and release evidence', () => {
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
    const admission = job.steps?.find(step => step.id === 'classify_production_large_admission');
    const upload = job.steps?.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    const summary = job.steps?.find(step => step.run?.includes('Production-large release evidence'));
    const admissionEnforcement = job.steps?.find(step => step.name === 'Enforce production-large admission');
    const enforcement = job.steps?.find(step => step.name === 'Enforce strict evidence completion');
    const productionInput = workflow.on.workflow_dispatch?.inputs?.include_production_large as
      {readonly description?: string} | undefined;

    expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty('include_production_large');
    expect(productionInput?.description).toContain('73k-repository/59,936-eligible');
    expect(productionInput?.description).toContain('profile target');
    expect(productionInput?.description).toContain('4.1 beta surrogate');
    expect(caller.if).toContain("github.event_name == 'schedule'");
    expect(caller.if).toContain('inputs.include_production_large');
    expect(caller.uses).toBe('./.github/workflows/production-large-evidence.yml');
    expect(evidence.on.workflow_call?.inputs?.strict).toMatchObject({default: true, type: 'boolean'});
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(30);
    expect(command).toContain('--profile production-large');
    expect(command).toContain('--minimum-free-gib 120');
    expect(command).toContain('--samples 1');
    expect(command).toContain('--warmups 0');
    expect(command).toContain('code-graph-production-large-n1-');
    expect(job.env).toBeUndefined();
    expect(admission?.run).toContain('MINIMUM_FREE_GIB * 1024 * 1024 * 1024');
    expect(admission?.run).toContain('df -Pk "$RUNNER_TEMP/threadnote-production-large-admission"');
    expect(admission?.run).toContain('threadnote-production-large-admission');
    expect(admission?.run).toContain('not-admitted-insufficient-capacity');
    expect(admission?.run).toContain('available_bytes >= required_bytes');
    expect(admission?.env).toMatchObject({
      MINIMUM_FREE_GIB: 120,
      SOURCE_REF: '${{ inputs.release_ref || github.ref }}',
      SOURCE_SHA: '${{ inputs.release_sha || github.sha }}',
    });
    expect(job.steps?.indexOf(admission!)).toBeLessThan(job.steps?.indexOf(capture!) ?? 0);
    expect(capture?.if).toContain("steps.classify_production_large_admission.outputs.admitted == 'true'");
    expect(capture?.env).toMatchObject({
      SQLITE_TMPDIR: '${{ runner.temp }}',
      TMPDIR: '${{ runner.temp }}',
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-ubuntu-24.04-${{ runner.arch }}',
      THREADNOTE_BENCHMARK_RUNNER_ID: '${{ runner.name }}',
      THREADNOTE_BENCHMARK_RELEASE_REF: '${{ inputs.release_ref }}',
      THREADNOTE_BENCHMARK_RELEASE_SHA: '${{ inputs.release_sha }}',
    });
    const captureTimeout = capture?.['timeout-minutes'];
    expect(captureTimeout).toBe(20);
    expect(capture?.['continue-on-error']).toBe(true);
    expect(job['timeout-minutes']! - (captureTimeout ?? 0)).toBeGreaterThanOrEqual(10);
    expect(upload?.uses).toBe('actions/upload-artifact@v7');
    expect(upload?.if).toBe('always()');
    expect(upload?.['timeout-minutes']).toBeLessThanOrEqual(5);
    expect(upload?.with?.path).toContain('artifacts/code-graph-production-large-admission-*.json');
    expect(upload?.with?.path).toContain('artifacts/code-graph-production-large-n1-*.json');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    expect(upload?.with?.['retention-days']).toBe(90);
    expect(enforcement?.if).toContain('inputs.strict');
    expect(enforcement?.if).toContain("steps.classify_production_large_admission.outputs.admitted == 'true'");
    expect(enforcement?.if).toContain("steps.capture_production_large.outcome != 'success'");
    expect(enforcement?.run).toContain('exit 1');
    expect(job.steps?.indexOf(enforcement!)).toBeGreaterThan(job.steps?.indexOf(upload!) ?? -1);
    expect(job.steps?.indexOf(enforcement!)).toBeGreaterThan(job.steps?.indexOf(summary!) ?? -1);
    expect(admissionEnforcement?.if).toContain('always()');
    expect(admissionEnforcement?.if).toContain("outputs.admitted != 'true'");
    expect(admissionEnforcement?.run).toContain('exit 1');
    expect(job.steps?.indexOf(admissionEnforcement!)).toBeGreaterThan(job.steps?.indexOf(upload!) ?? -1);
    expect(job.steps?.indexOf(admissionEnforcement!)).toBeGreaterThan(job.steps?.indexOf(summary!) ?? -1);
    expect(summary?.run).toContain('six declared linked-worktree churn scenarios');
    expect(summary?.run).toContain('actual-versus-target counts');
    expect(summary?.run).toContain('package-manager exclusion never removes active source');
  });

  it('publishes every channel after platform artifacts while retaining independent exact-commit evidence', () => {
    const workflow = load(readFileSync('.github/workflows/publish.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const releaseEvidence = load(readFileSync('.github/workflows/release-evidence.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const publisher = load(readFileSync('.github/workflows/publish-release-assets.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const evidence = releaseEvidence.jobs['production-large-evidence']!;
    const linux = workflow.jobs.linux!;
    const macos = workflow.jobs.macos!;
    const publish = workflow.jobs['publish-release']!;
    const release = publisher.jobs.publish!;
    const releaseCommand = release.steps?.flatMap(step => (step.run ? [step.run] : [])).join('\n') ?? '';

    expect(evidence.needs).toBeUndefined();
    expect(releaseEvidence.on.push?.tags).toEqual(['v4.*']);
    expect(evidence.uses).toBe('./.github/workflows/production-large-evidence.yml');
    expect(evidence.with).toMatchObject({
      strict: false,
      release_ref: '${{ github.ref }}',
      release_sha: '${{ github.sha }}',
    });
    expect(linux.needs).toBe('verify');
    expect(macos.needs).toBe('verify');

    expect(publish.needs).toEqual(['verify', 'linux', 'macos']);
    expect(publish.if).toContain("needs.verify.result == 'success'");
    expect(publish.if).toContain("needs.linux.result == 'success'");
    expect(publish.if).toContain("needs.macos.result == 'success'");
    expect(publish.if).not.toContain('needs.production-large-evidence');
    expect(publish.uses).toBe('./.github/workflows/publish-release-assets.yml');
    expect(publish.permissions).toEqual({contents: 'write'});
    expect(workflow.jobs['publish-beta']).toBeUndefined();
    expect(workflow.jobs['publish-evidence-gated']).toBeUndefined();
    expect(workflow.jobs['production-large-evidence']).toBeUndefined();

    expect(release['runs-on']).toBe('ubuntu-latest');
    expect(release.permissions).toEqual({contents: 'write'});
    expect(releaseCommand).toContain('gh release create');
    expect(releaseCommand).toContain('--json isImmutable');
  });

  it('reports bounded evidence outcome and strictness without coupling it to publication', () => {
    const evidence = load(readFileSync('.github/workflows/production-large-evidence.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const job = evidence.jobs['code-graph-production-large']!;
    const summary = job.steps?.find(step => step.run?.includes('Production-large release evidence'));

    expect(summary?.env).toMatchObject({
      ADMISSION_CLASSIFICATION: '${{ steps.classify_production_large_admission.outputs.classification }}',
      MEASUREMENT_OUTCOME: '${{ steps.capture_production_large.outcome }}',
      STRICT_EVIDENCE: '${{ inputs.strict }}',
    });
    expect(summary?.run).toContain('must complete for this evidence workflow to pass');
    expect(summary?.run).toContain('bounded observation retained without blocking release publication');
    expect(summary?.run).toContain('benchmark not attempted; capacity classification retained');
    expect(summary?.run).toContain('Admission classification');
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
