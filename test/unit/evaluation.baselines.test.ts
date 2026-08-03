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

  it('stores the 4.0 SQLite indexed-recall benchmark within every release budget', () => {
    const indexed = readJson(
      join(CANDIDATE_ROOT, 'benchmarks', 'darwin-arm64-m1-max', 'recall-index-sqlite-10000.json'),
    ) as {
      readonly fixture?: {readonly documents?: number};
      readonly scenarios?: Readonly<
        Record<string, {readonly p95LimitMilliseconds?: number; readonly p95Milliseconds?: number}>
      >;
      readonly source?: {readonly index?: string};
    };

    expect(indexed.fixture?.documents).toBe(10_000);
    expect(indexed.source?.index).toContain('@effect/sql-sqlite-bun');
    expect(Object.keys(indexed.scenarios ?? {}).sort()).toEqual([
      'coldDecode',
      'exactNoHit',
      'exactSubstring',
      'hotQuery',
      'incrementalUpdate',
      'sourceValidation',
    ]);
    for (const scenario of Object.values(indexed.scenarios ?? {})) {
      expect(scenario.p95Milliseconds).toBeLessThanOrEqual(scenario.p95LimitMilliseconds ?? 0);
    }
  });

  it('stores bounded content-addressed vector results at 10k and 50k', () => {
    const artifact = readJson(
      join(CANDIDATE_ROOT, 'benchmarks', 'darwin-arm64-m1-max', 'recall-vector-storage-sqlite-v2.json'),
    ) as {
      readonly scales?: Readonly<
        Record<
          string,
          {
            readonly database: {
              readonly chunkMappings: number;
              readonly incrementalBytes: number;
              readonly vectorValues: number;
            };
            readonly incrementalBuild: {
              readonly embeddedChunks: number;
              readonly reusedChunks: number;
            };
            readonly semanticQuery: {readonly p95Milliseconds: number};
          }
        >
      >;
      readonly suite?: string;
    };

    expect(artifact.suite).toBe('recall-vector-storage-v1');
    expect(Object.keys(artifact.scales ?? {}).sort()).toEqual(['10000', '50000']);
    for (const [documentsText, result] of Object.entries(artifact.scales ?? {})) {
      const documents = Number(documentsText);
      expect(result.database.chunkMappings).toBe(documents);
      expect(result.database.vectorValues).toBe(documents);
      expect(result.database.incrementalBytes).toBeLessThanOrEqual(64 * 1024);
      expect(result.incrementalBuild.embeddedChunks).toBe(1);
      expect(result.incrementalBuild.reusedChunks).toBe(documents - 1);
      expect(result.semanticQuery.p95Milliseconds).toBeLessThan(1_000);
    }
  });

  it('stores the audited code-graph improvements at 10k and 100k', () => {
    const artifact = readJson(
      join(CANDIDATE_ROOT, 'benchmarks', 'darwin-arm64-m1-max', 'code-graph-performance-audit-2026-07-30.json'),
    ) as {
      readonly scales?: Readonly<
        Record<
          string,
          {
            readonly after: {
              readonly coldIndexMilliseconds: number;
              readonly oneFileIncrementalMilliseconds: number;
            };
            readonly before: {
              readonly coldIndexMilliseconds: number;
              readonly oneFileIncrementalMilliseconds: number;
            };
          }
        >
      >;
      readonly suite?: string;
    };

    expect(artifact.suite).toBe('code-graph-performance-audit-v1');
    expect(Object.keys(artifact.scales ?? {}).sort()).toEqual(['10000', '100000']);
    for (const result of Object.values(artifact.scales ?? {})) {
      expect(result.after.coldIndexMilliseconds).toBeLessThan(result.before.coldIndexMilliseconds);
      expect(result.after.oneFileIncrementalMilliseconds).toBeLessThan(result.before.oneFileIncrementalMilliseconds);
    }
  });

  it('stores the passing 4.0 core embedding result and rejected reranker result', () => {
    const candidates = readdirSync(CANDIDATE_ROOT)
      .filter(name => name.endsWith('.json'))
      .map(name => readJson(join(CANDIDATE_ROOT, name)) as ModelCandidateSummary);

    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.fixture.hash).toBe('3967acf33893251f03126720ebf6fb55f6b6eed62f2c84f768963e9a352e9348');
      expect(candidate.models.every(model => /^[0-9a-f]{64}$/.test(model.sha256))).toBe(true);
    }
    const coreEmbedding = candidates.find(candidate => candidate.models.length === 1);
    const withReranker = candidates.find(candidate => candidate.models.length === 2);
    expect(coreEmbedding?.gate).toEqual(expect.objectContaining({failures: [], passed: true}));
    expect(coreEmbedding?.result.metrics.noAnswerRecall).toBe(1);
    expect(withReranker?.gate.passed).toBe(false);
    expect(withReranker?.gate.failures.some(failure => failure.includes('noAnswerRecall'))).toBe(true);
    expect(withReranker?.result.metrics.noAnswerRecall).toBe(0);
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
