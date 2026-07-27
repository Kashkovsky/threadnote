import {createHash} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from '@effect/vitest';
import {parseBenchmarkArtifactV1} from '../../src/evaluation/benchmark.js';
import {parseRecallEvaluationBaselineV1} from '../../src/evaluation/recall-baseline.js';
import {
  createRecallEvaluationFixtureV2,
  serializeRecallEvaluationFixtureV2Identity,
} from '../../src/evaluation/recall-fixture.js';

const BASELINE_ROOT = 'test/evaluation/baselines/threadnote-3.0.3';
const BENCHMARK_ROOT = join(BASELINE_ROOT, 'benchmarks', 'darwin-arm64-m1-max');
const CANDIDATE_ROOT = 'test/evaluation/candidates/threadnote-4.0.0';

describe('frozen Threadnote 3.0.3 baselines', () => {
  it('validates the compact recall-v2 baseline', () => {
    const baseline = parseRecallEvaluationBaselineV1(readJson(join(BASELINE_ROOT, 'recall-v2-lexical.json')));
    const fixture = createRecallEvaluationFixtureV2();
    const fixtureHash = createHash('sha256').update(serializeRecallEvaluationFixtureV2Identity(fixture)).digest('hex');

    expect(baseline.fixture).toMatchObject({documents: 200, queries: 250, version: 2});
    expect(baseline.fixture.hash).toBe(fixtureHash);
    expect(fixture.documents.every(document => document.uri.startsWith('threadnote://'))).toBe(true);
    expect(baseline.knownContractFailures).toBeGreaterThan(0);
    expect(baseline.source).toMatchObject({
      openVikingVersion: '0.4.10',
      threadnoteVersion: '3.0.3',
    });
  });

  it('validates every rank benchmark and preserves all scale points', () => {
    const artifacts = readdirSync(BENCHMARK_ROOT)
      .filter(name => /^recall-rank-\d+\.json$/.test(name))
      .map(name => parseBenchmarkArtifactV1(readJson(join(BENCHMARK_ROOT, name))));

    expect(
      artifacts.map(artifact => artifact.metadata.documents).sort((left, right) => Number(left) - Number(right)),
    ).toEqual([200, 1_000, 10_000, 100_000]);
    for (const artifact of artifacts) {
      expect(artifact.environment.node).toBe('v22.22.0');
      expect(artifact.environment.fixtureHash).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.measurements.some(measurement => measurement.name === 'hybrid-rank-one-query')).toBe(true);
      expect(artifact.measurements.some(measurement => measurement.name === 'process-rss')).toBe(true);
    }
  });

  it('stores compact Mitata and indexed-recall summaries', () => {
    const micro = readJson(join(BENCHMARK_ROOT, 'recall-micro.json')) as {
      readonly benchmarks?: readonly unknown[];
      readonly environment?: {readonly node?: string};
      readonly fixtures?: Readonly<Record<string, string>>;
      readonly runner?: {readonly name?: string; readonly version?: string};
    };
    const indexed = readJson(join(BENCHMARK_ROOT, 'recall-index-10000.json')) as {
      readonly fixture?: {readonly documents?: number};
      readonly scenarios?: Readonly<Record<string, {readonly p95Milliseconds?: number}>>;
    };

    expect(micro.environment?.node).toBe('v22.22.0');
    expect(micro.runner).toEqual({name: 'mitata', version: '1.0.34'});
    expect(Object.keys(micro.fixtures ?? {}).sort()).toEqual(['1000', '10000', '200']);
    expect(micro.benchmarks).toHaveLength(3);
    expect(indexed.fixture?.documents).toBe(10_000);
    expect(Object.keys(indexed.scenarios ?? {}).sort()).toEqual([
      'coldDecode',
      'hotQuery',
      'incrementalUpdate',
      'sourceValidation',
    ]);
  });

  it('stores measured 4.0 model candidates without selecting a failed pipeline', () => {
    const candidates = readdirSync(CANDIDATE_ROOT)
      .filter(name => name.endsWith('.json'))
      .map(name => readJson(join(CANDIDATE_ROOT, name)) as ModelCandidateSummary);

    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.fixture.hash).toBe('3967acf33893251f03126720ebf6fb55f6b6eed62f2c84f768963e9a352e9348');
      expect(candidate.gate.passed).toBe(false);
      expect(candidate.gate.failures.some(failure => failure.includes('noAnswerRecall'))).toBe(true);
      expect(candidate.result.metrics.noAnswerRecall).toBe(0);
      expect(candidate.models.every(model => /^[0-9a-f]{64}$/.test(model.sha256))).toBe(true);
    }
  });
});

interface ModelCandidateSummary {
  readonly fixture: {readonly hash: string};
  readonly gate: {readonly failures: readonly string[]; readonly passed: boolean};
  readonly models: readonly {readonly sha256: string}[];
  readonly result: {readonly metrics: {readonly noAnswerRecall: number}};
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
