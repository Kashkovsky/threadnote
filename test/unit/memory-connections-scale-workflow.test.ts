import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';
import {
  MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
  MEMORY_CONNECTIONS_SCALE_APPROVED_FIXTURE_HASH,
  MEMORY_CONNECTIONS_SCALE_ID,
  MEMORY_CONNECTIONS_SCALE_RELEASE_RUNNER_CLASS,
} from '../../src/evaluation/memory-connections-scale-contract.js';
import {
  MEMORY_CONNECTIONS_RETRIEVAL_BENCH_APPROVED_FIXTURE_HASH,
  MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ID,
} from '../../src/evaluation/memory-connections-retrieval-bench-contract.js';

interface WorkflowStep {
  readonly env?: Readonly<Record<string, string>>;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

describe('memory-connections release-scale workflow', () => {
  it('requires the governed candidate-C job and documents the frozen acceptance contract', async () => {
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
      readonly on: {readonly workflow_dispatch?: {readonly inputs?: Readonly<Record<string, unknown>>}};
    };
    const releaseGuide = await Bun.file('docs/releasing.md').text();
    const job = workflow.jobs['memory-connections-one-hop-scale']!;
    const benchmark = job.steps?.find(step => step.run?.includes('bench:memory-connections-scale'));
    const upload = job.steps?.find(step => step.uses === 'actions/upload-artifact@v7');

    expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty('include_memory_connections_scale');
    expect(job.if).toContain('inputs.include_memory_connections_scale');
    expect(job['runs-on']).toBe('macos-15');
    expect(job['timeout-minutes']).toBe(120);
    expect(benchmark?.run).toContain('--candidate-commit "${{ github.sha }}"');
    expect(benchmark?.run).not.toContain('--development-smoke');
    expect(benchmark?.env?.THREADNOTE_BENCHMARK_RUNNER_CLASS).toBe(MEMORY_CONNECTIONS_SCALE_RELEASE_RUNNER_CLASS);
    expect(upload?.with?.['retention-days']).toBe(90);

    expect(releaseGuide).toContain('include_memory_connections_scale=true');
    expect(releaseGuide).toContain(`suite \`${MEMORY_CONNECTIONS_SCALE_ID}\``);
    expect(releaseGuide).toContain(MEMORY_CONNECTIONS_SCALE_APPROVED_FIXTURE_HASH);
    expect(releaseGuide).toContain(`\`${MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ID}\``);
    expect(releaseGuide).toContain(MEMORY_CONNECTIONS_RETRIEVAL_BENCH_APPROVED_FIXTURE_HASH);
    expect(releaseGuide).toContain(
      `Measured lookup p95 must be at most ${MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.maximumLookupP95Milliseconds} ms`,
    );
    expect(releaseGuide).toContain(
      `No response may exceed ${MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.maximumResponseEstimatedTokens.toLocaleString('en-US')} estimated tokens, ${MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.maximumRawLinkRowsPerLookup} raw link rows, or ${MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.maximumCanonicalRereadsPerLookup} canonical rereads`,
    );
  });
});
