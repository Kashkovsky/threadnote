import fc from 'fast-check';
import {Schema} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  adjudicateCodeGraphWindowsReplicas,
  type CodeGraphWindowsReplicaInput,
} from '../../scripts/adjudicate-code-graph-windows-replicas.js';
import type {BenchmarkArtifactV1, BenchmarkMeasurementV1} from '../../src/evaluation/benchmark.js';

const GitCommit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const GitObjectId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const Positive = Schema.Number.check(Schema.isGreaterThan(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const calibration = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      expected: Schema.Struct({
        processCpuP95DeltaMilliseconds: Schema.Number,
        slowerTailHasLowerWallP50: Schema.Boolean,
        wallP95DeltaMilliseconds: Schema.Number,
        wallP95Ratio: Positive,
      }),
      fixtureHash: Sha256,
      observations: Schema.Array(
        Schema.Struct({
          archiveSha256: Sha256,
          artifactId: PositiveInteger,
          commit: GitCommit,
          processCpuMilliseconds: Schema.Struct({maximum: Positive, p50: Positive, p95: Positive}),
          rawJsonSha256: Sha256,
          runnerIdentity: Schema.String,
          sourceTree: GitObjectId,
          wallMilliseconds: Schema.Struct({maximum: Positive, p50: Positive, p95: Positive}),
          workflowRun: PositiveInteger,
        }),
      ),
      policy: Schema.Struct({
        hardWallP95MillisecondsMaximum: Schema.Literal(1900),
        headroomRatio: Schema.Literal(0.1),
        ordinaryPassesMinimum: Schema.Literal(2),
        ordinaryWallP95MillisecondsMaximum: Schema.Literal(1050),
        replicas: Schema.Literal(3),
        roundingQuantumMilliseconds: Schema.Literal(100),
        samplesPerReplica: Schema.Literal(100),
        warmupsPerReplica: Schema.Literal(5),
      }),
      runnerClass: Schema.Literal('github-hosted-windows-x64'),
      runtime: Schema.Literal('bun/1.3.14'),
      sourceTree: Schema.Literal('e1fc4934be4abf21711f1c15d3a72eaa9fda7d01'),
      type: Schema.Literal('threadnote-windows-native-hosted-replica-calibration'),
      version: Schema.Literal(1),
    }),
  ),
)(await Bun.file('test/evaluation/baselines/code-graph-v1/windows-native-hosted-replica-calibration-v1.json').text());
const budget: unknown = JSON.parse(await Bun.file('test/evaluation/baselines/code-graph-v1/budgets.json').text());
const expectedCommit = 'a'.repeat(40);

describe('hosted Windows native replica adjudication', () => {
  it('rederives the safety fuse and wall-only runner variance from retained exact-tree evidence', () => {
    expect(calibration.observations).toHaveLength(2);
    expect(new Set(calibration.observations.map(observation => observation.workflowRun)).size).toBe(2);
    expect(new Set(calibration.observations.map(observation => observation.artifactId)).size).toBe(2);
    expect(new Set(calibration.observations.map(observation => observation.rawJsonSha256)).size).toBe(2);
    expect(calibration.observations.every(observation => observation.sourceTree === calibration.sourceTree)).toBe(true);
    const [ordinary, tail] = calibration.observations;
    if (ordinary === undefined || tail === undefined) throw new Error('Replica calibration observations are missing.');

    expect(tail.wallMilliseconds.p95 - ordinary.wallMilliseconds.p95).toBeCloseTo(
      calibration.expected.wallP95DeltaMilliseconds,
      8,
    );
    expect(tail.wallMilliseconds.p95 / ordinary.wallMilliseconds.p95).toBeCloseTo(
      calibration.expected.wallP95Ratio,
      12,
    );
    expect(tail.processCpuMilliseconds.p95 - ordinary.processCpuMilliseconds.p95).toBe(
      calibration.expected.processCpuP95DeltaMilliseconds,
    );
    expect(tail.wallMilliseconds.p50 < ordinary.wallMilliseconds.p50).toBe(
      calibration.expected.slowerTailHasLowerWallP50,
    );
    expect(
      Math.ceil(
        (tail.wallMilliseconds.p95 * (1 + calibration.policy.headroomRatio)) /
          calibration.policy.roundingQuantumMilliseconds,
      ) * calibration.policy.roundingQuantumMilliseconds,
    ).toBe(calibration.policy.hardWallP95MillisecondsMaximum);
  });

  it('accepts three safe ordinary replicas and one bounded ordinary wall-tail', () => {
    expect(adjudicate(replicas()).gate).toEqual({failures: [], passed: true});
    const oneTail = replicas([500, 1673.8084, 600]);
    const result = adjudicate(oneTail);
    expect(result.gate).toEqual({failures: [], passed: true});
    expect(result.replicas.map(replica => replica.ordinaryPassed)).toEqual([true, false, true]);
    expect(result.replicas.every(replica => replica.safetyPassed)).toBe(true);
  });

  it('rejects two ordinary tails and any single safety-fuse breach', () => {
    expect(adjudicate(replicas([1050, 1050.000_001, 1050.000_001])).gate.failures).toContain(
      'ordinary wall gate passed 1/3; required 2',
    );
    expect(adjudicate(replicas([500, 600, 1900.000_001])).gate.failures).toEqual(
      expect.arrayContaining([expect.stringContaining('replica 3 safety budget')]),
    );
  });

  it('fails closed on companion, non-wall, parity, and exact sample-count regressions', () => {
    const cases: readonly [string, (artifact: BenchmarkArtifactV1) => BenchmarkArtifactV1, RegExp][] = [
      [
        'wall median',
        artifact =>
          replaceMeasurement(artifact, 'hot-exact-lexical-query', value => ({
            ...value,
            maximum: Math.max(value.maximum, 751),
            p50: 751,
            p95: Math.max(value.p95, 751),
            p99: Math.max(value.p99, 751),
          })),
        /p50/u,
      ],
      [
        'process CPU',
        artifact =>
          replaceMeasurement(artifact, 'hot-query-process-cpu', value => ({
            ...value,
            maximum: 501,
            p95: 501,
            p99: 501,
          })),
        /hot-query-process-cpu/u,
      ],
      ['cold index', artifact => replaceAllStatistics(artifact, 'cold-index', 15_001), /cold-index/u],
      ['parity', artifact => replaceAllStatistics(artifact, 'structural-graph-digest-parity', 0), /parity/u],
      ['99 samples', artifact => replaceHotSampleCounts(artifact, 99), /hot-query samples 99\/99; expected 100\/100/u],
      [
        '101 samples',
        artifact => replaceHotSampleCounts(artifact, 101),
        /hot-query samples 101\/101; expected 100\/100/u,
      ],
    ];
    for (const [, mutate, expected] of cases) {
      const inputs = replicas();
      const first = inputs[0];
      if (first === undefined) throw new Error('Replica fixture is missing.');
      const result = adjudicate([{...first, artifact: mutate(first.artifact)}, ...inputs.slice(1)]);
      expect(result.gate.passed).toBe(false);
      expect(result.gate.failures.join('\n')).toMatch(expected);
    }
  });

  it('requires exact ordinals, distinct runner identities and digests, and matching provenance', () => {
    const valid = replicas();
    expect(adjudicate(valid.slice(0, 2)).gate.failures).toContain('replica ordinals must be exactly 1,2,3');
    expect(adjudicate([valid[0]!, valid[0]!, valid[2]!]).gate.failures).toEqual(
      expect.arrayContaining([
        'artifact digests must be distinct across all replicas',
        'replica ordinals must be exactly 1,2,3',
        'runner identities must be distinct across all replicas',
      ]),
    );
    const mismatched = valid.map((input, index) =>
      index === 2
        ? {
            ...input,
            artifact: {
              ...input.artifact,
              environment: {...input.artifact.environment, operatingSystem: 'Windows changed'},
            },
          }
        : input,
    );
    expect(adjudicate(mismatched).gate.failures).toContain('operating system must match across all replicas');
  });

  it('is permutation-invariant and deterministic', () => {
    const forward = adjudicate(replicas([500, 1673.8084, 600]));
    const reverse = adjudicate([...replicas([500, 1673.8084, 600])].reverse());
    expect(reverse).toEqual(forward);
  });

  it('accepts exactly all-safe replica sets with at least two ordinary passes', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.double({max: 2_100, min: 500, noDefaultInfinity: true, noNaN: true}),
          fc.double({max: 2_100, min: 500, noDefaultInfinity: true, noNaN: true}),
          fc.double({max: 2_100, min: 500, noDefaultInfinity: true, noNaN: true}),
        ),
        walls => {
          const expected = walls.every(value => value <= 1900) && walls.filter(value => value <= 1050).length >= 2;
          expect(adjudicate(replicas(walls)).gate.passed).toBe(expected);
        },
      ),
      {numRuns: 100},
    );
  });

  it('is monotone under governed wall-tail regressions', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.double({max: 2_100, min: 500, noDefaultInfinity: true, noNaN: true}),
          fc.double({max: 2_100, min: 500, noDefaultInfinity: true, noNaN: true}),
          fc.double({max: 2_100, min: 500, noDefaultInfinity: true, noNaN: true}),
        ),
        fc.tuple(
          fc.double({max: 500, min: 0, noDefaultInfinity: true, noNaN: true}),
          fc.double({max: 500, min: 0, noDefaultInfinity: true, noNaN: true}),
          fc.double({max: 500, min: 0, noDefaultInfinity: true, noNaN: true}),
        ),
        (walls, deltas) => {
          const before = adjudicate(replicas(walls)).gate.passed;
          const regressed: Triple = [walls[0] + deltas[0], walls[1] + deltas[1], walls[2] + deltas[2]];
          const after = adjudicate(replicas(regressed)).gate.passed;
          if (!before) expect(after).toBe(false);
        },
      ),
      {numRuns: 100},
    );
  });
});

type Triple = readonly [number, number, number];

function adjudicate(inputs: readonly CodeGraphWindowsReplicaInput[]) {
  return adjudicateCodeGraphWindowsReplicas(inputs, budget, expectedCommit);
}

function replicas(walls: Triple = [500, 600, 700]): readonly CodeGraphWindowsReplicaInput[] {
  return walls.map((wallP95, index) => ({
    artifact: artifact(index + 1, wallP95),
    artifactSha256: String(index + 1).repeat(64),
    replica: index + 1,
  }));
}

function artifact(replica: number, wallP95: number): BenchmarkArtifactV1 {
  return {
    createdAt: `2026-09-01T00:00:0${replica}.000Z`,
    environment: {
      architecture: 'x64',
      commit: expectedCommit,
      cpu: `hosted-cpu-${replica}`,
      dirty: false,
      fixtureHash: 'c4c45a6bcc25517df1fdae711f19f4989e13fde6b4763d596d547c6757230e7d',
      memoryBytes: 16 * 1_024 * 1_024 * 1_024,
      node: 'bun/1.3.14',
      operatingSystem: 'Windows 10.0.26100',
      packageManager: 'bun/1.3.14',
      runner: 'threadnote-code-graph-e2e',
      runnerVersion: '1',
    },
    measurements: [
      measurement('cold-index', 1_000),
      measurement('cold-materialization', 1_000),
      measurement('one-file-reindex-index', 1_000),
      measurement('one-file-reindex-materialization', 1_000),
      {
        ...measurement('hot-exact-lexical-query', wallP95, 100),
        maximum: Math.max(wallP95, 700),
        mean: 450,
        minimum: 350,
        p50: 400,
        p95: wallP95,
        p99: Math.max(wallP95, 700),
      },
      {
        ...measurement('hot-query-process-cpu', 250, 100),
        mean: 180,
        minimum: 100,
        p50: 180,
        p95: 250,
      },
      measurement('whole-graph-structural-analysis', 500),
      measurement('incremental-process-peak-rss', 64 * 1_024 * 1_024, 1, 'bytes'),
      measurement('derived-index-disk', 16 * 1_024 * 1_024, 1, 'bytes'),
      measurement('one-file-reindex-materialization-staged-files', 1, 1, 'count'),
      measurement('primary-query-structural-parity', 1, 1, 'count'),
      measurement('structural-graph-digest-parity', 1, 1, 'count'),
    ],
    metadata: {
      coldFiles: 13,
      incrementalReusedFiles: 12,
      oneFileReindexStagedFiles: 1,
      oneFileReindexTotalFiles: 13,
      primaryQueryStructuralDigestIncremental: '1'.repeat(64),
      primaryQueryStructuralDigestSameOverlayReference: '1'.repeat(64),
      runnerClass: 'github-hosted-windows-x64',
      runnerIdentity: `runner-${replica.toString(16).padStart(16, '0')}`,
      runtimePlatform: 'win32',
      structuralGraphDigestIncremental: '2'.repeat(64),
      structuralGraphDigestSameOverlayReference: '2'.repeat(64),
      vectorEnabled: false,
    },
    suite: 'code-graph-v1',
    version: 1,
    warmups: 5,
  };
}

function measurement(
  name: string,
  value: number,
  samples = 1,
  unit: BenchmarkMeasurementV1['unit'] = 'milliseconds',
): BenchmarkMeasurementV1 {
  return {maximum: value, mean: value, minimum: value, name, p50: value, p95: value, p99: value, samples, unit};
}

function replaceHotSampleCounts(artifact: BenchmarkArtifactV1, samples: number): BenchmarkArtifactV1 {
  return {
    ...artifact,
    measurements: artifact.measurements.map(measurement =>
      measurement.name === 'hot-exact-lexical-query' || measurement.name === 'hot-query-process-cpu'
        ? {...measurement, samples}
        : measurement,
    ),
  };
}

function replaceAllStatistics(artifact: BenchmarkArtifactV1, name: string, value: number): BenchmarkArtifactV1 {
  return replaceMeasurement(artifact, name, measurement => ({
    ...measurement,
    maximum: value,
    mean: value,
    minimum: value,
    p50: value,
    p95: value,
    p99: value,
  }));
}

function replaceMeasurement(
  artifact: BenchmarkArtifactV1,
  name: string,
  update: (measurement: BenchmarkMeasurementV1) => BenchmarkMeasurementV1,
): BenchmarkArtifactV1 {
  const current = artifact.measurements.find(measurement => measurement.name === name);
  if (current === undefined) throw new Error(`Missing measurement ${name}.`);
  return {
    ...artifact,
    measurements: artifact.measurements.map(measurement => (measurement.name === name ? update(current) : measurement)),
  };
}
