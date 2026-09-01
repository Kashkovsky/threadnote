import * as yaml from 'js-yaml';
import fc from 'fast-check';
import {it as effectIt} from '@effect/vitest';
import {Effect, Schema} from 'effect';
import {describe, expect, it} from 'vitest';
import {benchmarkMeasurement} from '../../src/evaluation/benchmark.js';
import {
  CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V2,
  CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE,
  CONTEXT_BRIEF_CITATION_SCALE_ARTIFACT_SUITE,
  CONTEXT_BRIEF_CITATION_SCALE_EXECUTION_V2,
  CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS,
  CONTEXT_BRIEF_CITATION_SCALE_RELEASE_RUNNER_CLASS,
  CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES,
  CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS,
  contextBriefCitationScaleGate,
  contextBriefCitationRssSampleGapFailures,
  contextBriefCitationRssSampleGapSummary,
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
import {CONTEXT_BRIEF_CITATION_RSS_MAXIMUM_OBSERVATIONS} from '../../scripts/context-brief-citation-rss-observer.js';

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const GitCommit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const IsoInstant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u));

const budget = parseContextBriefCitationScaleBudgetV1(
  JSON.parse(
    await Bun.file('test/evaluation/baselines/context-brief-citations-v1/scale-budgets.json').text(),
  ) as unknown,
);
const sampleGapCalibration = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      breachThresholdMilliseconds: PositiveInteger,
      calibrationMargin: Schema.Number,
      expected: Schema.Struct({
        breachCount: NonNegativeInteger,
        derivedHardMaximumMilliseconds: PositiveInteger,
        maximumConsecutiveBreachesWithinRun: NonNegativeInteger,
        maximumMilliseconds: NonNegativeInteger,
        observationCount: PositiveInteger,
        p50Milliseconds: NonNegativeInteger,
        p95Milliseconds: NonNegativeInteger,
        p99Milliseconds: NonNegativeInteger,
      }),
      roundUpIncrementMilliseconds: PositiveInteger,
      runs: Schema.Array(
        Schema.Struct({
          artifactId: PositiveInteger,
          candidateCommit: GitCommit,
          createdAt: IsoInstant,
          maximumSampleGapsMilliseconds: Schema.Array(NonNegativeInteger),
          rawArtifactSha256: Sha256,
          workflowAttempt: PositiveInteger,
          workflowRun: PositiveInteger,
        }),
      ),
      version: Schema.Literal(1),
    }),
  ),
)(await Bun.file('test/evaluation/baselines/context-brief-citations-v1/sample-gap-calibration-v2.json').text());
const validationQuantileCalibration = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      benchmarkBundleSha256: Sha256,
      expected: Schema.Struct({
        firstFailingTailValuesAtProspectiveSamples: PositiveInteger,
        latestFourObservationCount: PositiveInteger,
        latestFourP95Milliseconds: Schema.Number,
        maximumExcludedTailValuesAtProspectiveSamples: NonNegativeInteger,
        maximumMilliseconds: Schema.Number,
        observationCount: PositiveInteger,
        p50Milliseconds: Schema.Number,
        p95Milliseconds: Schema.Number,
        thresholdBreaches: NonNegativeInteger,
      }),
      fixtureSha256: Sha256,
      historicalSamplesPerRun: Schema.Literal(25),
      percentileEstimator: Schema.Literal('sorted[floor(sampleCount * 0.95)]'),
      profile: Schema.Literal('workset-128'),
      prospectiveSamples: Schema.Literal(CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES),
      prospectiveWarmups: Schema.Literal(CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS),
      runs: Schema.Array(
        Schema.Struct({
          archiveSha256: Sha256,
          artifactId: PositiveInteger,
          benchmarkBundleSha256: Sha256,
          commit: GitCommit,
          createdAt: IsoInstant,
          fixtureSha256: Sha256,
          jobId: PositiveInteger,
          rawJsonSha256: Sha256,
          validationMilliseconds: Schema.Array(Schema.Number),
          workflowRun: PositiveInteger,
        }),
      ),
      type: Schema.Literal('threadnote-context-brief-validation-quantile-calibration'),
      validationP95MaximumMilliseconds: PositiveInteger,
      version: Schema.Literal(1),
    }),
  ),
)(
  await Bun.file('test/evaluation/baselines/context-brief-citations-v1/validation-quantile-calibration-v1.json').text(),
);
const rssObserverCapacityCalibration = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      correction: Schema.Struct({
        capacityDerivedFromReleaseContract: Schema.Literal(true),
        childStderrPropagated: Schema.Literal(true),
        maximumObservations: Schema.Literal(300),
        maximumProtocolSequence: Schema.Literal(601),
        parentDetectsChildExitBeforeTimeout: Schema.Literal(true),
        preflightRejectsOversizedSchedules: Schema.Literal(true),
      }),
      failure: Schema.Struct({
        firstRejectedObservation: Schema.Literal(257),
        lastAcknowledgedSequence: Schema.Literal(512),
        parentAcknowledgementTimeoutMilliseconds: Schema.Literal(30_000),
        previousMaximumObservations: Schema.Literal(256),
        reportedMessage: Schema.Literal('Timed out waiting for the RSS observer acknowledgement.'),
        requestSequence: Schema.Literal(513),
      }),
      prospectiveRun: Schema.Struct({
        artifactProduced: Schema.Literal(false),
        builtArtifactSha256: Sha256,
        commit: GitCommit,
        invocation: Schema.Struct({
          profiles: Schema.Literal(3),
          samplesPerProfile: Schema.Literal(CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES),
          totalObservedSamples: Schema.Literal(300),
          warmupsPerProfile: Schema.Literal(CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS),
        }),
        jobId: PositiveInteger,
        jobLogSha256: Sha256,
        sourceTree: GitCommit,
        workflowAttempt: Schema.Literal(1),
        workflowRun: PositiveInteger,
      }),
      type: Schema.Literal('threadnote-context-brief-rss-observer-capacity-calibration'),
      version: Schema.Literal(1),
    }),
  ),
)(
  await Bun.file(
    'test/evaluation/baselines/context-brief-citations-v1/rss-observer-capacity-calibration-v1.json',
  ).text(),
);
const benchmarkWorkflow = await Bun.file('.github/workflows/benchmarks.yml').text();
const releaseGuide = await Bun.file('docs/releasing.md').text();
const scaleEvaluationSource = await Bun.file('src/evaluation/context-brief-citation-scale.ts').text();

describe('Context Brief citation scale benchmark', () => {
  it('rederives observer capacity from the complete release schedule and retains the failed prospective provenance', () => {
    const {correction, failure, prospectiveRun} = rssObserverCapacityCalibration;
    expect(prospectiveRun.invocation.profiles * prospectiveRun.invocation.samplesPerProfile).toBe(
      prospectiveRun.invocation.totalObservedSamples,
    );
    expect(failure.firstRejectedObservation).toBe(failure.previousMaximumObservations + 1);
    expect(failure.requestSequence).toBe(failure.previousMaximumObservations * 2 + 1);
    expect(failure.lastAcknowledgedSequence).toBe(failure.requestSequence - 1);
    expect(correction.maximumObservations).toBe(prospectiveRun.invocation.totalObservedSamples);
    expect(correction.maximumProtocolSequence).toBe(correction.maximumObservations * 2 + 1);
    expect(CONTEXT_BRIEF_CITATION_RSS_MAXIMUM_OBSERVATIONS).toBe(correction.maximumObservations);
    expect(prospectiveRun.artifactProduced).toBe(false);
  });

  it('pins the reviewed 100k / 50 / 128 envelope and built-target defaults', () => {
    expect(budget).toMatchObject({
      corpusMemoryCandidates: 100_000,
      maximumCitationsPerBrief: 96,
      maximumEstimatedTokens: 1_500,
      maximumObservedAddedProcessTreeRssBytes: 64 * 1_024 * 1_024,
      profiles: [
        {
          citationCount: 96,
          citedRepositories: 1,
          id: 'local-100k',
          maximumBriefP95Milliseconds: 1_500,
          maximumValidationP95Milliseconds: 250,
          worksetMembers: 1,
        },
        {
          citationCount: 64,
          citedRepositories: 16,
          id: 'workset-50',
          maximumBriefP95Milliseconds: 3_250,
          maximumValidationP95Milliseconds: 950,
          worksetMembers: 50,
        },
        {
          citationCount: 96,
          citedRepositories: 32,
          id: 'workset-128',
          maximumBriefP95Milliseconds: 5_000,
          maximumValidationP95Milliseconds: 1_400,
          worksetMembers: 128,
        },
      ],
    });
    expect(parseContextBriefCitationScaleBenchmarkArguments(['--built-artifact-sha256', 'a'.repeat(64)])).toMatchObject(
      {
        memoryCandidates: 100_000,
        profileIds: CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS,
        samples: CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES,
        warmups: CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS,
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
    expect(() => parseContextBriefCitationScaleBenchmarkArguments(['--samples', '101'])).toThrow(
      /supports at most 300 total profile\/sample observations; received 303/u,
    );
    expect(
      parseContextBriefCitationScaleBenchmarkArguments(['--profiles', 'local-100k', '--samples', '300']),
    ).toMatchObject({profileIds: ['local-100k'], samples: 300});
  });

  it('accepts exactly the unique-profile schedules that fit the 300-observation capacity', () => {
    const parseSchedule = (profileIds: readonly string[], samples: number) =>
      parseContextBriefCitationScaleBenchmarkArguments([
        '--profiles',
        profileIds.join(','),
        '--samples',
        String(samples),
      ]);

    expect(parseSchedule(['local-100k', 'workset-50'], 150)).toMatchObject({
      profileIds: ['local-100k', 'workset-50'],
      samples: 150,
    });
    expect(() => parseSchedule(['local-100k', 'workset-50'], 151)).toThrow(
      /supports at most 300 total profile\/sample observations; received 302/u,
    );

    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS), {
          maxLength: CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS.length,
          minLength: 1,
        }),
        fc.integer({max: 2, min: -2}),
        (profileIds, capacityOffset) => {
          const samples =
            Math.floor(CONTEXT_BRIEF_CITATION_RSS_MAXIMUM_OBSERVATIONS / profileIds.length) + capacityOffset;
          const totalObservations = profileIds.length * samples;
          if (totalObservations <= CONTEXT_BRIEF_CITATION_RSS_MAXIMUM_OBSERVATIONS) {
            expect(parseSchedule(profileIds, samples)).toMatchObject({profileIds, samples});
          } else {
            expect(() => parseSchedule(profileIds, samples)).toThrow(`received ${totalObservations}`);
          }
        },
      ),
      {numRuns: 100},
    );
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

  it('rederives the v2 sample-gap ceiling from retained hosted-runner calibration evidence', () => {
    expect(sampleGapCalibration.runs).toHaveLength(4);
    expect(new Set(sampleGapCalibration.runs.map(run => run.artifactId)).size).toBe(4);
    const gaps = sampleGapCalibration.runs.flatMap(run => {
      expect(run.maximumSampleGapsMilliseconds).toHaveLength(75);
      expect(Number.isFinite(Date.parse(run.createdAt))).toBe(true);
      return run.maximumSampleGapsMilliseconds;
    });
    const sorted = [...gaps].sort((left, right) => left - right);
    const percentile = (quantile: number): number => {
      const value = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
      if (value === undefined) throw new Error('Sample-gap calibration must retain observations.');
      return value;
    };
    const maximumConsecutiveBreachesWithinRun = Math.max(
      ...sampleGapCalibration.runs.map(run => {
        let current = 0;
        let maximum = 0;
        for (const gap of run.maximumSampleGapsMilliseconds) {
          current = gap > sampleGapCalibration.breachThresholdMilliseconds ? current + 1 : 0;
          maximum = Math.max(maximum, current);
        }
        return maximum;
      }),
    );
    const maximumMilliseconds = sorted.at(-1);
    if (maximumMilliseconds === undefined) throw new Error('Sample-gap calibration must retain observations.');
    const derivedHardMaximumMilliseconds =
      Math.ceil(
        (maximumMilliseconds * (1 + sampleGapCalibration.calibrationMargin)) /
          sampleGapCalibration.roundUpIncrementMilliseconds,
      ) * sampleGapCalibration.roundUpIncrementMilliseconds;

    expect({
      breachCount: gaps.filter(gap => gap > sampleGapCalibration.breachThresholdMilliseconds).length,
      derivedHardMaximumMilliseconds,
      maximumConsecutiveBreachesWithinRun,
      maximumMilliseconds,
      observationCount: gaps.length,
      p50Milliseconds: percentile(0.5),
      p95Milliseconds: percentile(0.95),
      p99Milliseconds: percentile(0.99),
    }).toEqual(sampleGapCalibration.expected);
    expect(sampleGapCalibration.breachThresholdMilliseconds).toBe(
      CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V2.breachThresholdMilliseconds,
    );
    expect(derivedHardMaximumMilliseconds).toBe(
      CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V2.hardMaximumGapMilliseconds,
    );
    expect(
      sampleGapCalibration.expected.breachCount / sampleGapCalibration.expected.observationCount,
    ).toBeLessThanOrEqual(CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V2.maximumBreachRate);
    expect(maximumConsecutiveBreachesWithinRun).toBeLessThanOrEqual(
      CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V2.maximumConsecutiveBreaches,
    );
  });

  it('rederives the 100-sample validation quantile from retained same-bundle hosted evidence', () => {
    expect(validationQuantileCalibration.runs).toHaveLength(5);
    expect(new Set(validationQuantileCalibration.runs.map(run => run.workflowRun)).size).toBe(5);
    expect(new Set(validationQuantileCalibration.runs.map(run => run.artifactId)).size).toBe(5);
    expect(new Set(validationQuantileCalibration.runs.map(run => run.rawJsonSha256)).size).toBe(5);
    expect(new Set(validationQuantileCalibration.runs.map(run => run.archiveSha256)).size).toBe(5);
    expect(
      validationQuantileCalibration.runs.every(
        run =>
          run.benchmarkBundleSha256 === validationQuantileCalibration.benchmarkBundleSha256 &&
          run.fixtureSha256 === validationQuantileCalibration.fixtureSha256,
      ),
    ).toBe(true);
    expect(
      validationQuantileCalibration.runs.every(
        run => run.validationMilliseconds.length === validationQuantileCalibration.historicalSamplesPerRun,
      ),
    ).toBe(true);

    const all = validationQuantileCalibration.runs.flatMap(run => run.validationMilliseconds);
    const pooled = benchmarkMeasurement('validation-pooled', 'milliseconds', all);
    const latestFour = benchmarkMeasurement(
      'validation-latest-four',
      'milliseconds',
      validationQuantileCalibration.runs.slice(1).flatMap(run => run.validationMilliseconds),
    );
    expect({
      latestFourObservationCount: latestFour.samples,
      latestFourP95Milliseconds: latestFour.p95,
      maximumMilliseconds: pooled.maximum,
      observationCount: pooled.samples,
      p50Milliseconds: pooled.p50,
      p95Milliseconds: pooled.p95,
      thresholdBreaches: all.filter(value => value > validationQuantileCalibration.validationP95MaximumMilliseconds)
        .length,
    }).toEqual({
      latestFourObservationCount: validationQuantileCalibration.expected.latestFourObservationCount,
      latestFourP95Milliseconds: validationQuantileCalibration.expected.latestFourP95Milliseconds,
      maximumMilliseconds: validationQuantileCalibration.expected.maximumMilliseconds,
      observationCount: validationQuantileCalibration.expected.observationCount,
      p50Milliseconds: validationQuantileCalibration.expected.p50Milliseconds,
      p95Milliseconds: validationQuantileCalibration.expected.p95Milliseconds,
      thresholdBreaches: validationQuantileCalibration.expected.thresholdBreaches,
    });
    expect(validationQuantileCalibration.expected.maximumExcludedTailValuesAtProspectiveSamples).toBe(4);
    expect(validationQuantileCalibration.expected.firstFailingTailValuesAtProspectiveSamples).toBe(5);
  });

  effectIt.effect.prop(
    'derives and gates sample-gap rate, consecutive runs, and hard maximum from observation order',
    {gaps: fc.array(fc.integer({max: 500, min: 0}), {maxLength: 75, minLength: 1})},
    ({gaps}) =>
      Effect.sync(() => {
        const summary = contextBriefCitationRssSampleGapSummary(gaps);
        const breaches = gaps.map(
          gap => gap > CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V2.breachThresholdMilliseconds,
        );
        const breachCount = breaches.filter(Boolean).length;
        let run = 0;
        let maximumRun = 0;
        for (const breach of breaches) {
          run = breach ? run + 1 : 0;
          maximumRun = Math.max(maximumRun, run);
        }

        expect(summary).toEqual({
          maximumConsecutiveSampleGapBreaches: maximumRun,
          maximumSampleGapMilliseconds: Math.max(...gaps),
          sampleGapBreachCount: breachCount,
          sampleGapBreachRate: breachCount / breaches.length,
        });
        const shouldPass =
          breachCount / breaches.length <= CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V2.maximumBreachRate &&
          maximumRun <= CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V2.maximumConsecutiveBreaches &&
          Math.max(...gaps) <= CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V2.hardMaximumGapMilliseconds;
        expect(contextBriefCitationRssSampleGapFailures(summary, breaches.length).length === 0).toBe(shouldPass);
      }),
    {fastCheck: {numRuns: 100}},
  );

  it('accepts bounded hosted stalls and rejects rate, consecutive, and hard-maximum violations independently', () => {
    const pass = contextBriefCitationRssSampleGapSummary([297, 115, ...Array.from({length: 73}, () => 100)]);
    expect(contextBriefCitationRssSampleGapFailures(pass, 75)).toEqual([]);

    const excessiveRate = contextBriefCitationRssSampleGapSummary([
      ...Array.from({length: 8}, () => 101),
      ...Array.from({length: 67}, () => 100),
    ]);
    expect(contextBriefCitationRssSampleGapFailures(excessiveRate, 75)).toEqual(
      expect.arrayContaining([expect.stringContaining('breach rate 8/75')]),
    );

    const excessiveRun = contextBriefCitationRssSampleGapSummary([
      101,
      101,
      101,
      ...Array.from({length: 72}, () => 100),
    ]);
    expect(contextBriefCitationRssSampleGapFailures(excessiveRun, 75)).toEqual(
      expect.arrayContaining([expect.stringContaining('3 consecutive')]),
    );

    const hardMaximum = contextBriefCitationRssSampleGapSummary([351, ...Array.from({length: 74}, () => 100)]);
    expect(contextBriefCitationRssSampleGapFailures(hardMaximum, 75)).toEqual(
      expect.arrayContaining([expect.stringContaining('351ms exceeds hard maximum 350ms')]),
    );
  });

  it('fails closed on every derived sample-gap summary and reviewed schedule dimension', () => {
    const artifact = scaleArtifact();
    const mutations: readonly unknown[] = [
      {
        ...artifact,
        memoryObserver: {
          ...artifact.memoryObserver,
          maximumConsecutiveSampleGapBreaches: artifact.memoryObserver.maximumConsecutiveSampleGapBreaches + 1,
        },
      },
      {
        ...artifact,
        memoryObserver: {
          ...artifact.memoryObserver,
          maximumSampleGapMilliseconds: artifact.memoryObserver.maximumSampleGapMilliseconds + 1,
        },
      },
      {
        ...artifact,
        memoryObserver: {
          ...artifact.memoryObserver,
          sampleGapBreachCount: artifact.memoryObserver.sampleGapBreachCount + 1,
        },
      },
      {
        ...artifact,
        memoryObserver: {
          ...artifact.memoryObserver,
          sampleGapBreachRate: artifact.memoryObserver.sampleGapBreachRate + 0.1,
        },
      },
      {
        ...artifact,
        memoryObserver: {
          ...artifact.memoryObserver,
          sampleGapPolicy: {...artifact.memoryObserver.sampleGapPolicy, version: 1},
        },
      },
      {
        ...artifact,
        memoryObserver: {
          ...artifact.memoryObserver,
          sampleGapPolicy: {...artifact.memoryObserver.sampleGapPolicy, hardMaximumGapMilliseconds: 250},
        },
      },
      {
        ...artifact,
        memoryObserver: {...artifact.memoryObserver, samplingSchedule: 'fixed-delay-v0'},
      },
    ];
    for (const mutation of mutations) {
      expect(() => parseContextBriefCitationScaleArtifactV2(mutation, budget)).toThrow(/Invalid Context Brief/u);
    }
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

  it('uses the 100-sample production quantile at the four-versus-five validation-tail boundary', () => {
    const profile = budget.profiles.find(candidate => candidate.id === 'workset-128')!;
    const order = Array.from({length: CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES}, (_, index) => index);

    fc.assert(
      fc.property(
        fc.integer({max: 10, min: 0}),
        fc.shuffledSubarray(order, {
          maxLength: CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES,
          minLength: CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES,
        }),
        (tailValues, permutation) => {
          const observations = permutation.map((value, ordinal) => {
            const validationMilliseconds =
              value < tailValues
                ? profile.maximumValidationP95Milliseconds + 1
                : profile.maximumValidationP95Milliseconds;
            return scaleObservation(
              profile,
              {},
              {contextBriefMilliseconds: validationMilliseconds * 2, validationMilliseconds},
              {observationId: `workset-128-${ordinal}`, ordinal},
            );
          });
          const evaluated = evaluateContextBriefCitationScaleProfile(
            budget,
            profile.id,
            scaleObservation(profile),
            observations,
          );
          const validationFailures = evaluated.failures.filter(failure => failure.includes('validation p95'));

          expect(validationFailures.length === 0).toBe(tailValues <= 4);
        },
      ),
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
    expect(command).toContain(`--samples ${CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES}`);
    expect(command).toContain(`--warmups ${CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS}`);
    expect(releaseGuide).toContain(
      `memory candidates, exactly ${CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES} samples, exactly ${CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS} warmups`,
    );
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
      maximumConsecutiveSampleGapBreaches: 0,
      maximumSampleGapMilliseconds: 25,
      observationCount: 3,
      observerExcluded: true,
      processCountPeakObserved: 2,
      retainedRootRssGrowthBytes: 0,
      rootIdentityValidation: 'darwin-ps-lstart',
      rootStartIdentity: 'root-start',
      sampleGapBreachCount: 0,
      sampleGapBreachRate: 0,
      sampleGapPolicy: CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V2,
      sampleAttempts: 10,
      sampleFailures: 0,
      scope: 'recursive-process-tree',
      samplingSchedule: CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE,
      source: 'darwin-ps',
      successfulSamples: 10,
      version: 2,
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
