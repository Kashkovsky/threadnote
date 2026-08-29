import * as yaml from 'js-yaml';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CONTEXT_BRIEF_CITATION_SCALE_ARTIFACT_SUITE,
  CONTEXT_BRIEF_CITATION_SCALE_EXECUTION_V2,
  CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS,
  CONTEXT_BRIEF_CITATION_SCALE_RELEASE_RUNNER_CLASS,
  contextBriefCitationScaleGate,
  contextBriefCitationScaleReleaseIdentityFailures,
  contextBriefCitationScaleRetainedRootRssGrowthBytes,
  evaluateContextBriefCitationScaleProfile,
  parseContextBriefCitationScaleArtifactV2,
  parseContextBriefCitationScaleBudgetV1,
  type ContextBriefCitationScaleArtifactV2,
  type ContextBriefCitationScaleCountersV1,
  type ContextBriefCitationScaleMeasuredObservationV2,
  type ContextBriefCitationScaleMemoryObservationV2,
  type ContextBriefCitationScaleObservationV2,
  type ContextBriefCitationScaleProfileV1,
  type ContextBriefCitationScaleReleaseIdentityV1,
} from '../../src/evaluation/context-brief-citation-scale-contract.js';
import {parseContextBriefCitationScaleBenchmarkArguments} from '../../scripts/benchmark-context-brief-citations-target.js';

const budget = parseContextBriefCitationScaleBudgetV1(
  JSON.parse(
    await Bun.file('test/evaluation/baselines/context-brief-citations-v1/scale-budgets.json').text(),
  ) as unknown,
);
const benchmarkWorkflow = await Bun.file('.github/workflows/benchmarks.yml').text();
const scaleEvaluationSource = await Bun.file('src/evaluation/context-brief-citation-scale.ts').text();

describe('Context Brief citation scale benchmark', () => {
  it('pins the reviewed 100k / 50 / 128 envelope and built-target defaults', () => {
    expect(budget).toMatchObject({
      corpusMemoryCandidates: 100_000,
      maximumCitationsPerBrief: 96,
      maximumEstimatedTokens: 1_500,
      maximumObservedAddedProcessTreeRssBytes: 64 * 1_024 * 1_024,
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
    expect(
      parseContextBriefCitationScaleBenchmarkArguments([
        '--built-artifact-sha256',
        'a'.repeat(64),
        '--candidate-commit',
        'b'.repeat(40),
      ]),
    ).toMatchObject({candidateCommit: 'b'.repeat(40)});
  });

  it('fails closed when any release-runner identity field is relabeled', () => {
    const identity: ContextBriefCitationScaleReleaseIdentityV1 = {
      architecture: 'arm64',
      candidateCommit: 'a'.repeat(40),
      commit: 'a'.repeat(40),
      cpu: 'Apple M1',
      dirty: false,
      gitStatusObserved: true,
      githubActions: true,
      operatingSystem: 'macOS 15.6.1',
      runnerClass: CONTEXT_BRIEF_CITATION_SCALE_RELEASE_RUNNER_CLASS,
      runnerArchitecture: 'ARM64',
      runnerEnvironment: 'github-hosted',
      runnerOperatingSystem: 'macOS',
      runtime: 'bun/1.3.14',
      sourceVersion: 'threadnote-4.6.0',
    };
    expect(contextBriefCitationScaleReleaseIdentityFailures(identity)).toEqual([]);
    fc.assert(
      fc.property(
        fc.constantFrom<keyof ContextBriefCitationScaleReleaseIdentityV1>(
          'architecture',
          'candidateCommit',
          'commit',
          'cpu',
          'dirty',
          'gitStatusObserved',
          'githubActions',
          'operatingSystem',
          'runnerClass',
          'runnerArchitecture',
          'runnerEnvironment',
          'runnerOperatingSystem',
          'runtime',
          'sourceVersion',
        ),
        key => {
          const invalid = {
            ...identity,
            [key]:
              key === 'dirty'
                ? true
                : key === 'gitStatusObserved' || key === 'githubActions'
                  ? false
                  : key === 'commit'
                    ? 'b'.repeat(40)
                    : 'invalid',
          } as ContextBriefCitationScaleReleaseIdentityV1;
          expect(contextBriefCitationScaleReleaseIdentityFailures(invalid).length).toBeGreaterThan(0);
        },
      ),
      {numRuns: 50},
    );
  });

  it('gates externally observed process-tree RSS while retaining boundary RSS as diagnostics', () => {
    const profile = budget.profiles.find(candidate => candidate.id === 'local-100k')!;
    const boundaryOutlier = scaleObservation(
      profile,
      {},
      {boundaryAddedRssBytes: 512 * 1_024 * 1_024},
      {observedAddedProcessTreeRssBytes: 32 * 1_024 * 1_024},
    );
    const accepted = evaluateContextBriefCitationScaleProfile(budget, profile.id, boundaryOutlier, [boundaryOutlier]);
    expect(accepted.failures).toEqual([]);
    expect(accepted.result.measurements.boundaryAddedRssBytes.maximum).toBe(512 * 1_024 * 1_024);

    const peakRegression = scaleObservation(
      profile,
      {},
      {},
      {observedAddedProcessTreeRssBytes: 64 * 1_024 * 1_024 + 1},
    );
    const rejected = evaluateContextBriefCitationScaleProfile(budget, profile.id, peakRegression, [peakRegression]);
    expect(rejected.failures).toContain(
      `local-100k observed added process-tree RSS ${64 * 1_024 * 1_024 + 1} exceeds ${64 * 1_024 * 1_024}`,
    );
  });

  it('fails closed when a claimed OS peak growth is not derivable from its fixed baseline', () => {
    const profile = budget.profiles.find(candidate => candidate.id === 'local-100k')!;
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 2_000_000_000}),
        fc.integer({min: 0, max: 64 * 1_024 * 1_024}),
        (baseline, growth) => {
          const valid = scaleObservation(
            profile,
            {},
            {},
            {
              observedAddedProcessTreeRssBytes: growth,
              observedAddedRootRssBytes: 0,
              observedProcessTreeRssBaselineBytes: baseline,
              observedProcessTreeRssPeakBytes: baseline + growth,
              observedRootRssBaselineBytes: baseline,
              observedRootRssPeakBytes: baseline,
            },
          );
          expect(evaluateContextBriefCitationScaleProfile(budget, profile.id, valid, [valid]).failures).toEqual([]);
          const tampered = {
            ...valid,
            memory: {
              ...valid.memory,
              observedAddedProcessTreeRssBytes: growth === 0 ? 1 : growth - 1,
            },
          };
          expect(evaluateContextBriefCitationScaleProfile(budget, profile.id, tampered, [tampered]).failures).toContain(
            'local-100k memory observation 0 has inconsistent process-tree RSS evidence',
          );
        },
      ),
      {numRuns: 50},
    );
  });

  it('requires a local descendant capture and 80% coverage for sustained workset fan-out', () => {
    const localProfile = budget.profiles.find(candidate => candidate.id === 'local-100k')!;
    const observations = Array.from({length: 5}, (_, ordinal) =>
      scaleObservation(
        localProfile,
        {},
        {},
        {
          observationId: `local-100k-${ordinal}`,
          ordinal,
          peakProcessCount: ordinal === 0 ? 1 : 2,
        },
      ),
    );
    const accepted = evaluateContextBriefCitationScaleProfile(
      budget,
      localProfile.id,
      scaleObservation(localProfile),
      observations,
    );
    expect(accepted.failures).toEqual([]);
    expect(accepted.result.memoryCoverage).toMatchObject({
      descendantObservationCount: 4,
      descendantObservationRate: 0.8,
    });

    const noLocalDescendants = observations.map(observation => ({
      ...observation,
      memory: {...observation.memory, peakProcessCount: 1},
    }));
    expect(
      evaluateContextBriefCitationScaleProfile(
        budget,
        localProfile.id,
        scaleObservation(localProfile),
        noLocalDescendants,
      ).failures,
    ).toContain(
      'local-100k observed workload descendants in 0/5 memory observations; required at least one sampled descendant',
    );

    const worksetProfile = budget.profiles.find(candidate => candidate.id === 'workset-50')!;
    const worksetObservations = observations.map((_, ordinal) =>
      scaleObservation(
        worksetProfile,
        {},
        {},
        {
          observationId: `workset-50-${ordinal}`,
          ordinal,
          peakProcessCount: ordinal === 0 ? 1 : 2,
        },
      ),
    );
    expect(
      evaluateContextBriefCitationScaleProfile(
        budget,
        worksetProfile.id,
        scaleObservation(worksetProfile),
        worksetObservations,
      ).failures,
    ).toEqual([]);
    const underObservedWorkset = worksetObservations.map((observation, ordinal) =>
      ordinal === 1 ? {...observation, memory: {...observation.memory, peakProcessCount: 1}} : observation,
    );
    expect(
      evaluateContextBriefCitationScaleProfile(
        budget,
        worksetProfile.id,
        scaleObservation(worksetProfile),
        underObservedWorkset,
      ).failures,
    ).toContain('workset-50 observed workload descendants in 3/5 memory observations; required at least 80%');
  });

  it('measures retained root growth from the first memory baseline and is offset-invariant', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({min: 0, max: 1_000_000}), {maxLength: 50, minLength: 1}),
        fc.integer({min: 0, max: 1_000_000}),
        (baselines, offset) => {
          const expected = Math.max(0, Math.max(...baselines) - baselines[0]!);
          expect(contextBriefCitationScaleRetainedRootRssGrowthBytes(baselines)).toBe(expected);
          expect(contextBriefCitationScaleRetainedRootRssGrowthBytes(baselines.map(value => value + offset))).toBe(
            expected,
          );
        },
      ),
      {numRuns: 100},
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
        const observations = order.map((value, index) =>
          scaleObservation(
            profile,
            {},
            {contextBriefMilliseconds: value * 10, validationMilliseconds: value},
            {observationId: `workset-50-${index}`, ordinal: index},
          ),
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

  it('accepts a complete v2 artifact and rejects bounded single-field evidence tampering', () => {
    const artifact = scaleArtifact();
    expect(parseContextBriefCitationScaleArtifactV2(artifact, budget)).toEqual(artifact);

    fc.assert(
      fc.property(
        fc.constantFrom<ArtifactTamperTarget>(
          'claimed-profile-aggregate',
          'execution-contract',
          'final-retained-sample',
          'gate-decision',
          'memory-observation',
          'memory-observer-summary',
          'memory-workload',
          'workset-generation-digest',
        ),
        fc.integer({max: CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS.length - 1, min: 0}),
        fc.integer({max: 1_000_000, min: 1}),
        (target, profileIndex, delta) => {
          expect(() =>
            parseContextBriefCitationScaleArtifactV2(
              tamperScaleArtifact(artifact, target, profileIndex, delta),
              budget,
            ),
          ).toThrow();
        },
      ),
      {numRuns: 100},
    );
  });

  it('runs first-use memory evidence before observer-free timing', () => {
    const memoryPhase = scaleEvaluationSource.indexOf('const rssEvidence = yield* Effect.acquireUseRelease');
    const timingPhase = scaleEvaluationSource.indexOf('const timingProfiles = new Map');
    expect(memoryPhase).toBeGreaterThan(-1);
    expect(timingPhase).toBeGreaterThan(memoryPhase);
  });

  it('runs only by schedule or explicit opt-in and retains the built scale artifact', () => {
    const workflow = yaml.load(benchmarkWorkflow) as {
      readonly jobs: Readonly<
        Record<string, {readonly if?: string; readonly 'runs-on'?: string; readonly steps?: readonly WorkflowStep[]}>
      >;
      readonly on: {readonly workflow_dispatch?: {readonly inputs?: Readonly<Record<string, unknown>>}};
    };
    const job = workflow.jobs['context-brief-citations-scale']!;
    const benchmarkStep = job.steps?.find(step => step.run?.includes('bench:context-brief-citations'));
    const checkout = job.steps?.find(step => step.uses === 'actions/checkout@v7');
    const command = benchmarkStep?.run ?? '';
    const upload = job.steps?.find(step => step.uses?.startsWith('actions/upload-artifact'));
    expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty('include_context_brief_citations_scale');
    expect(job.if).toContain("github.event_name == 'schedule'");
    expect(job.if).toContain('inputs.include_context_brief_citations_scale');
    expect(job['runs-on']).toBe('macos-15');
    expect(checkout?.with).toMatchObject({
      'persist-credentials': false,
      ref: '${{ github.sha }}',
    });
    expect(command).toContain('--candidate-commit "${{ github.sha }}"');
    expect(command).toContain('--memory-candidates 100000');
    expect(command).toContain('--samples 25');
    expect(command).toContain('--warmups 5');
    expect(command).toContain('--fail-on-budget');
    expect(benchmarkStep?.env?.THREADNOTE_BENCHMARK_RUNNER_CLASS).toBe(
      CONTEXT_BRIEF_CITATION_SCALE_RELEASE_RUNNER_CLASS,
    );
    expect(upload?.with?.['retention-days']).toBe(90);
  });
});

interface WorkflowStep {
  readonly env?: Readonly<Record<string, string>>;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

type ArtifactTamperTarget =
  | 'claimed-profile-aggregate'
  | 'execution-contract'
  | 'final-retained-sample'
  | 'gate-decision'
  | 'memory-observation'
  | 'memory-observer-summary'
  | 'memory-workload'
  | 'workset-generation-digest';

function scaleArtifact(): ContextBriefCitationScaleArtifactV2 {
  const profiles = budget.profiles.map(profile => {
    const observation = scaleObservation(profile, {}, {}, {observationId: `context-rss-${profile.id}-0`});
    return evaluateContextBriefCitationScaleProfile(budget, profile.id, observation.memoryWorkload, [observation])
      .result;
  });
  return {
    createdAt: '2026-08-29T00:00:00.000Z',
    environment: {
      architecture: 'arm64',
      candidateCommit: 'unclaimed',
      commit: 'a'.repeat(40),
      cpu: 'Apple M1 Max',
      dirty: true,
      gitStatusObserved: true,
      githubActions: false,
      memoryBytes: 64 * 1_024 * 1_024 * 1_024,
      operatingSystem: 'macOS 27.0',
      runnerArchitecture: 'arm64',
      runnerClass: 'local-unpinned',
      runnerEnvironment: 'local',
      runnerOperatingSystem: 'darwin',
      runtime: 'bun/1.3.14',
      sourceVersion: 'threadnote-4.6.0',
    },
    evidenceClass: 'development-smoke',
    execution: {builtArtifactSha256: 'b'.repeat(64), ...CONTEXT_BRIEF_CITATION_SCALE_EXECUTION_V2},
    fixture: {
      hash: 'c'.repeat(64),
      indexedMemoryCandidates: 200,
      legacyV1MemoryCandidates: 128,
      readyGraphSetupMilliseconds: 1,
      recallIndexBuildMilliseconds: 1,
      requestedMemoryCandidates: 200,
      worksetGenerationDigests: ['d'.repeat(64), 'e'.repeat(64)],
      worksetRepositoryIdentities: [50, 128],
    },
    gate: contextBriefCitationScaleGate([
      'artifact is a development smoke, not release-scale evidence',
      'indexed memory corpus 200; required 100000',
    ]),
    memoryObserver: {
      finalSample: {
        processCount: 1,
        rootRssBytes: 512 * 1_024 * 1_024,
        sampleAttempts: 1,
        sampleFailures: 0,
        treeRssBytes: 512 * 1_024 * 1_024,
      },
      intervalMilliseconds: 25,
      maximumSampleGapMilliseconds: 25,
      observationCount: 3,
      observerExcluded: true,
      processCountPeakObserved: 2,
      retainedRootRssGrowthBytes: 0,
      rootIdentityValidation: 'darwin-ps-lstart',
      rootStartIdentity: 'root-start',
      sampleAttempts: 10,
      sampleFailures: 0,
      scope: 'recursive-process-tree',
      source: 'darwin-ps',
      successfulSamples: 10,
      version: 1,
    },
    profiles,
    samples: 1,
    suite: CONTEXT_BRIEF_CITATION_SCALE_ARTIFACT_SUITE,
    version: 2,
    warmups: 0,
  };
}

function tamperScaleArtifact(
  artifact: ContextBriefCitationScaleArtifactV2,
  target: ArtifactTamperTarget,
  profileIndex: number,
  delta: number,
): unknown {
  if (target === 'claimed-profile-aggregate') {
    return {
      ...artifact,
      profiles: artifact.profiles.map((candidate, index) =>
        index === profileIndex
          ? {
              ...candidate,
              measurements: {
                ...candidate.measurements,
                contextBriefMilliseconds: {
                  ...candidate.measurements.contextBriefMilliseconds,
                  maximum: candidate.measurements.contextBriefMilliseconds.maximum + delta,
                },
              },
            }
          : candidate,
      ),
    };
  }
  if (target === 'execution-contract') {
    return {...artifact, execution: {...artifact.execution, timingScope: `${artifact.execution.timingScope} tampered`}};
  }
  if (target === 'final-retained-sample') {
    return {
      ...artifact,
      memoryObserver: {
        ...artifact.memoryObserver,
        finalSample: {
          ...artifact.memoryObserver.finalSample,
          rootRssBytes: artifact.memoryObserver.finalSample.rootRssBytes + delta,
          treeRssBytes: artifact.memoryObserver.finalSample.treeRssBytes + delta,
        },
      },
    };
  }
  if (target === 'gate-decision') return {...artifact, gate: {failures: [], passed: true}};
  if (target === 'memory-observation') {
    return {
      ...artifact,
      profiles: artifact.profiles.map((candidate, index) =>
        index === profileIndex
          ? {
              ...candidate,
              observations: candidate.observations.map((observation, observationIndex) =>
                observationIndex === 0
                  ? {
                      ...observation,
                      memory: {...observation.memory, sampleAttempts: observation.memory.sampleAttempts + delta},
                    }
                  : observation,
              ),
            }
          : candidate,
      ),
    };
  }
  if (target === 'memory-observer-summary') {
    return {
      ...artifact,
      memoryObserver: {...artifact.memoryObserver, sampleAttempts: artifact.memoryObserver.sampleAttempts + delta},
    };
  }
  if (target === 'memory-workload') {
    return {
      ...artifact,
      profiles: artifact.profiles.map((candidate, index) =>
        index === profileIndex
          ? {
              ...candidate,
              observations: candidate.observations.map((observation, observationIndex) =>
                observationIndex === 0
                  ? {
                      ...observation,
                      memoryWorkload: {
                        ...observation.memoryWorkload,
                        selectedMemories: observation.memoryWorkload.selectedMemories + delta,
                      },
                    }
                  : observation,
              ),
            }
          : candidate,
      ),
    };
  }
  return {
    ...artifact,
    fixture: {
      ...artifact.fixture,
      worksetGenerationDigests: ['not-a-digest', artifact.fixture.worksetGenerationDigests[1]],
    },
  };
}

function scaleObservation(
  profile: ContextBriefCitationScaleProfileV1,
  counters: Partial<ContextBriefCitationScaleCountersV1> = {},
  values: Partial<ContextBriefCitationScaleObservationV2> = {},
  memoryValues: Partial<ContextBriefCitationScaleMemoryObservationV2> = {},
): ContextBriefCitationScaleMeasuredObservationV2 {
  const observedRootRssBaselineBytes = memoryValues.observedRootRssBaselineBytes ?? 512 * 1_024 * 1_024;
  const observedAddedRootRssBytes = memoryValues.observedAddedRootRssBytes ?? 1_024;
  const observedProcessTreeRssBaselineBytes =
    memoryValues.observedProcessTreeRssBaselineBytes ?? observedRootRssBaselineBytes + 1_024;
  const observedAddedProcessTreeRssBytes = memoryValues.observedAddedProcessTreeRssBytes ?? 2_048;
  const timing: ContextBriefCitationScaleObservationV2 = {
    boundaryAddedRssBytes: 1_024,
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
  return {
    ...timing,
    memory: {
      baselineProcessCount: 1,
      maximumSampleGapMilliseconds: 25,
      observedAddedProcessTreeRssBytes,
      observedAddedRootRssBytes,
      observedProcessTreeRssBaselineBytes,
      observedProcessTreeRssPeakBytes: observedProcessTreeRssBaselineBytes + observedAddedProcessTreeRssBytes,
      observedRootRssBaselineBytes,
      observedRootRssPeakBytes: observedRootRssBaselineBytes + observedAddedRootRssBytes,
      observationId: `${profile.id}-0`,
      ordinal: 0,
      peakProcessCount: 2,
      profile: profile.id,
      rootStartIdentity: 'root-start',
      sampleAttempts: 3,
      sampleFailures: 0,
      sampleIntervalMilliseconds: 25,
      samples: 3,
      source: 'darwin-ps',
      ...memoryValues,
    },
    memoryWorkload: timing,
  };
}
