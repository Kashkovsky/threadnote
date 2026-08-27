import * as yaml from 'js-yaml';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS,
  contextBriefCitationScaleGate,
  evaluateContextBriefCitationScaleProfile,
  parseContextBriefCitationScaleBudgetV1,
  type ContextBriefCitationScaleCountersV1,
  type ContextBriefCitationScaleObservationV1,
  type ContextBriefCitationScaleProfileV1,
} from '../../src/evaluation/context-brief-citation-scale-contract.js';
import {parseContextBriefCitationScaleBenchmarkArguments} from '../../scripts/benchmark-context-brief-citations-target.js';

const budget = parseContextBriefCitationScaleBudgetV1(
  JSON.parse(
    await Bun.file('test/evaluation/baselines/context-brief-citations-v1/scale-budgets.json').text(),
  ) as unknown,
);
const benchmarkWorkflow = await Bun.file('.github/workflows/benchmarks.yml').text();

describe('Context Brief citation scale benchmark', () => {
  it('pins the reviewed 100k / 50 / 128 envelope and built-target defaults', () => {
    expect(budget).toMatchObject({
      corpusMemoryCandidates: 100_000,
      maximumCitationsPerBrief: 96,
      maximumEstimatedTokens: 1_500,
      profiles: [
        {citationCount: 96, citedRepositories: 1, id: 'local-100k', worksetMembers: 1},
        {citationCount: 64, citedRepositories: 16, id: 'workset-50', worksetMembers: 50},
        {citationCount: 96, citedRepositories: 32, id: 'workset-128', worksetMembers: 128},
      ],
    });
    expect(parseContextBriefCitationScaleBenchmarkArguments(['--built-artifact-sha256', 'a'.repeat(64)])).toMatchObject(
      {
        memoryCandidates: 100_000,
        profileIds: CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS,
        samples: 25,
        warmups: 5,
      },
    );
  });

  it('fails when real production store-session fan-out exceeds distinct cited repositories', () => {
    const profile = budget.profiles.find(candidate => candidate.id === 'workset-128')!;
    const observation = scaleObservation(profile, {
      productionStoreSessionCalls: profile.citedRepositories * 3,
    });
    const evaluated = evaluateContextBriefCitationScaleProfile(budget, profile.id, observation, [observation]);
    expect(evaluated.failures).toContain(
      'workset-128 observation 0 opened 96 production graph-store sessions; expected 32 (one per cited repository)',
    );
  });

  it('fails when a published Workset omits either active-view fence observation', () => {
    const profile = budget.profiles.find(candidate => candidate.id === 'workset-50')!;
    const observation = scaleObservation(profile, {
      activeViewFenceObservations: profile.citedRepositories,
    });
    const evaluated = evaluateContextBriefCitationScaleProfile(budget, profile.id, observation, [observation]);
    expect(evaluated.failures).toContain('workset-50 observation 0 made 16/32 active-view fence observations');
  });

  it('keeps aggregation invariant under sample order while enforcing fan-out counters', () => {
    const profile = budget.profiles.find(candidate => candidate.id === 'workset-50')!;
    fc.assert(
      fc.property(fc.shuffledSubarray([1, 2, 3, 4, 5], {maxLength: 5, minLength: 5}), order => {
        const observations = order.map(value =>
          scaleObservation(profile, {}, {contextBriefMilliseconds: value * 10, validationMilliseconds: value}),
        );
        const forward = evaluateContextBriefCitationScaleProfile(
          budget,
          profile.id,
          scaleObservation(profile),
          observations,
        );
        const reverse = evaluateContextBriefCitationScaleProfile(
          budget,
          profile.id,
          scaleObservation(profile),
          [...observations].reverse(),
        );
        expect(reverse.failures).toEqual(forward.failures);
        expect(reverse.result.counters).toEqual(forward.result.counters);
        expect(reverse.result.measurements).toEqual(forward.result.measurements);
        expect(reverse.result.observations).toEqual([...observations].reverse());
        expect(contextBriefCitationScaleGate(forward.failures).passed).toBe(true);
      }),
      {numRuns: 50},
    );
  });

  it('runs only by schedule or explicit opt-in and retains the built scale artifact', () => {
    const workflow = yaml.load(benchmarkWorkflow) as {
      readonly jobs: Readonly<Record<string, {readonly if?: string; readonly steps?: readonly WorkflowStep[]}>>;
      readonly on: {readonly workflow_dispatch?: {readonly inputs?: Readonly<Record<string, unknown>>}};
    };
    const job = workflow.jobs['context-brief-citations-scale']!;
    const benchmarkStep = job.steps?.find(step => step.run?.includes('bench:context-brief-citations'));
    const command = benchmarkStep?.run ?? '';
    const upload = job.steps?.find(step => step.uses?.startsWith('actions/upload-artifact'));
    expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty('include_context_brief_citations_scale');
    expect(job.if).toContain("github.event_name == 'schedule'");
    expect(job.if).toContain('inputs.include_context_brief_citations_scale');
    expect(command).toContain('--memory-candidates 100000');
    expect(command).toContain('--samples 25');
    expect(command).toContain('--warmups 5');
    expect(command).toContain('--fail-on-budget');
    expect(benchmarkStep?.env?.THREADNOTE_BENCHMARK_RUNNER_CLASS).toBe('github-hosted-ubuntu-24.04-${{ runner.arch }}');
    expect(upload?.with?.['retention-days']).toBe(90);
  });
});

interface WorkflowStep {
  readonly env?: Readonly<Record<string, string>>;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

function scaleObservation(
  profile: ContextBriefCitationScaleProfileV1,
  counters: Partial<ContextBriefCitationScaleCountersV1> = {},
  values: Partial<ContextBriefCitationScaleObservationV1> = {},
): ContextBriefCitationScaleObservationV1 {
  return {
    addedRssBytes: 1_024,
    contextBriefMilliseconds: 10,
    counters: {
      activeViewFenceObservations: profile.id === 'local-100k' ? 0 : profile.citedRepositories * 2,
      coldGraphBuilds: 0,
      distinctGraphDatabasePaths: profile.citedRepositories,
      effectiveEvidenceBatches: profile.citedRepositories,
      leaseBalance: 0,
      maintenanceRequests: 0,
      peakLeaseBalance: Math.min(4, profile.citedRepositories),
      productionStoreSessionCalls: profile.citedRepositories,
      snapshotLeaseAcquisitions: profile.citedRepositories,
      snapshotLeaseReleases: profile.citedRepositories,
      statusObservations: profile.citedRepositories * (profile.id === 'local-100k' ? 2 : 1),
      ...counters,
    },
    estimatedTokens: 1_000,
    exactValidationReceipts: profile.citationCount,
    memoryRetrievalMilliseconds: 5,
    profile: profile.id,
    selectedMemories: profile.selectedMemories,
    validationMilliseconds: 4,
    validationReceipts: profile.citationCount,
    ...values,
  };
}
