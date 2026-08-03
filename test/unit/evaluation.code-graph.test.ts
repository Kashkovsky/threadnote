import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {parseBenchmarkArtifactV1, type BenchmarkArtifactV1} from '../../src/evaluation/benchmark.js';
import {
  PRODUCTION_LARGE_CODE_GRAPH_PROFILE,
  git,
  prepareProductionCodeGraphFixture,
  productionWorkspaceRoots,
} from '../../scripts/code-graph-fixture.js';
import {
  codeGraphEdgeKey,
  codeGraphEvaluationFixtureHash,
  evaluateCodeGraphObservations,
  parseCodeGraphEvaluationBaselineV1,
  parseCodeGraphEvaluationFixtureV1,
} from '../../src/evaluation/code-graph.js';
import {runEffect} from '../helpers/effect-runtime.js';

const FIXTURE_ROOT = 'test/evaluation/fixtures/code-graph-v1';
const BASELINE_ROOT = 'test/evaluation/baselines/code-graph-v1';
const POLYGLOT_FIXTURE_ROOT = 'test/evaluation/fixtures/code-graph-polyglot-v1';
const POLYGLOT_BASELINE_ROOT = 'test/evaluation/baselines/code-graph-polyglot-v1';

describe('code graph evaluation contract', () => {
  const fixture = parseCodeGraphEvaluationFixtureV1(readJson(join(FIXTURE_ROOT, 'fixture.json')));

  it('loads the reviewed fixture with every required safety category', () => {
    expect(fixture.expectedSymbols.length).toBeGreaterThanOrEqual(7);
    expect(fixture.expectedEdges.length).toBeGreaterThanOrEqual(6);
    expect(fixture.allowedAuthoritativeEdges.length).toBeGreaterThan(fixture.expectedEdges.length);
    expect(new Set(fixture.queries.map(query => query.category))).toEqual(
      new Set(['definition', 'documentation', 'impact', 'no-answer', 'path']),
    );
    expect(fixture.worktreeContracts).toEqual([expect.objectContaining({forbiddenCrossBranch: true})]);
    expect(codeGraphEvaluationFixtureHash(fixture)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('scores perfect reviewed observations without hiding no-answer or worktree safety', () => {
    const edgeKeys = fixture.expectedEdges.map(codeGraphEdgeKey);
    const observations = fixture.queries.map(query => ({
      answerable: query.answerable,
      edgeKeys,
      pathHits: query.relevantPaths ?? [],
      queryId: query.id,
      symbolHits: query.relevantSymbols,
    }));
    const metrics = evaluateCodeGraphObservations(fixture, observations, {
      actualAuthoritativeEdges: edgeKeys,
      allowedAuthoritativeEdgeKeys: fixture.allowedAuthoritativeEdges.map(codeGraphEdgeKey),
      worktreeLeakageCount: 0,
      worktreeObservationCount: 2,
    });

    expect(metrics).toEqual({
      answerableQueries: 4,
      authoritativeFalseEdgeRate: 0,
      edgeRecall: 1,
      meanReciprocalRank: 1,
      noAnswerPrecision: 1,
      noAnswerRecall: 1,
      queryCount: 5,
      symbolRecall: 1,
      worktreeLeakageRate: 0,
    });
  });

  it('counts authoritative edges outside the hand-picked endpoint domain as false positives', () => {
    const edgeKeys = fixture.expectedEdges.map(codeGraphEdgeKey);
    const observations = fixture.queries.map(query => ({
      answerable: query.answerable,
      edgeKeys,
      pathHits: query.relevantPaths ?? [],
      queryId: query.id,
      symbolHits: query.relevantSymbols,
    }));
    const unexpected = codeGraphEdgeKey({
      provenance: 'resolved',
      relation: 'calls',
      source: 'unexpectedInRepositorySource',
      target: 'unexpectedInRepositoryTarget',
    });
    const metrics = evaluateCodeGraphObservations(fixture, observations, {
      actualAuthoritativeEdges: [...edgeKeys, unexpected],
      allowedAuthoritativeEdgeKeys: fixture.allowedAuthoritativeEdges.map(codeGraphEdgeKey),
      worktreeLeakageCount: 0,
      worktreeObservationCount: 2,
    });

    expect(metrics.authoritativeFalseEdgeRate).toBe(1 / (edgeKeys.length + 1));
  });

  it('counts authoritative edges from unexpected sources into the reviewed domain', () => {
    const edgeKeys = fixture.expectedEdges.map(codeGraphEdgeKey);
    const unexpected = codeGraphEdgeKey({
      provenance: 'resolved',
      relation: 'calls',
      source: 'unexpectedInRepositorySource',
      target: 'ensureVectorIndex',
    });
    const metrics = evaluateCodeGraphObservations(
      fixture,
      fixture.queries.map(query => ({
        answerable: query.answerable,
        edgeKeys,
        pathHits: query.relevantPaths ?? [],
        queryId: query.id,
        symbolHits: query.relevantSymbols,
      })),
      {
        actualAuthoritativeEdges: [...edgeKeys, unexpected],
        allowedAuthoritativeEdgeKeys: fixture.allowedAuthoritativeEdges.map(codeGraphEdgeKey),
        worktreeLeakageCount: 0,
        worktreeObservationCount: 2,
      },
    );

    expect(metrics.authoritativeFalseEdgeRate).toBe(1 / (edgeKeys.length + 1));
  });

  it('treats zero observed failures as a zero failure rate instead of a perfect-ratio sentinel', () => {
    const edgeKeys = fixture.expectedEdges.map(codeGraphEdgeKey);
    const metrics = evaluateCodeGraphObservations(
      fixture,
      fixture.queries.map(query => ({
        answerable: query.answerable,
        edgeKeys,
        pathHits: query.relevantPaths ?? [],
        queryId: query.id,
        symbolHits: query.relevantSymbols,
      })),
      {
        actualAuthoritativeEdges: [],
        worktreeLeakageCount: 0,
        worktreeObservationCount: 0,
      },
    );

    expect(metrics.authoritativeFalseEdgeRate).toBe(0);
    expect(metrics.worktreeLeakageRate).toBe(0);
  });

  it('validates compact frozen Graphify, no-graph, and native baselines against the fixture hash', () => {
    const hash = codeGraphEvaluationFixtureHash(fixture);
    const graphify = parseCodeGraphEvaluationBaselineV1(readJson(join(BASELINE_ROOT, 'graphify-0.9.29.json')));
    const noGraph = parseCodeGraphEvaluationBaselineV1(readJson(join(BASELINE_ROOT, 'threadnote-no-graph.json')));
    const native = parseCodeGraphEvaluationBaselineV1(readJson(join(BASELINE_ROOT, 'threadnote-native.json')));

    expect(graphify.fixture).toMatchObject({hash, id: fixture.id, queries: fixture.queries.length, version: 1});
    expect(graphify.source).toEqual({name: 'graphify', version: '0.9.29'});
    expect(noGraph.fixture.hash).toBe(hash);
    expect(noGraph.source.name).toBe('threadnote-no-code-graph');
    expect(noGraph.metrics.symbolRecall).toBe(0);
    expect(noGraph.metrics.noAnswerRecall).toBe(1);
    expect(native.fixture.hash).toBe(hash);
    expect(native.source.name).toBe('threadnote-native-code-graph');
    expect(native.metrics).toMatchObject({
      authoritativeFalseEdgeRate: 0,
      edgeRecall: 1,
      meanReciprocalRank: 1,
      noAnswerPrecision: 1,
      noAnswerRecall: 1,
      symbolRecall: 1,
      worktreeLeakageRate: 0,
    });
  });

  it('stores lexical, production-vector, 10k, and 100k process baselines within reviewed budgets', () => {
    const budgets = readJson(join(BASELINE_ROOT, 'budgets.json')) as {
      readonly developmentPerformance: PerformanceBudget;
      readonly scalePerformance: Readonly<Record<string, PerformanceBudget>>;
      readonly vectorPerformance: PerformanceBudget;
      readonly vectorScalePerformance: Readonly<Record<string, PerformanceBudget>>;
    };
    const cases = [
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-vectors-development.json'))),
        budget: budgets.vectorPerformance,
        scale: undefined,
        vectors: true,
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-vectors-10000-development.json'))),
        budget: budgets.vectorScalePerformance['10000']!,
        scale: 10_000,
        vectors: true,
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-development.json'))),
        budget: budgets.developmentPerformance,
        scale: undefined,
        vectors: false,
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-10000-development.json'))),
        budget: budgets.scalePerformance['10000']!,
        scale: 10_000,
        vectors: false,
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-100000-development.json'))),
        budget: budgets.scalePerformance['100000']!,
        scale: 100_000,
        vectors: false,
      },
    ] as const;

    for (const testCase of cases) {
      expectBenchmarkWithinBudget(testCase.artifact, testCase.budget);
      if (!testCase.vectors && testCase.scale === undefined) {
        expect(testCase.artifact.suite).toBe('code-graph-v1');
        expect(testCase.artifact.metadata.retrievalMode).toBe('lexical-only');
      } else if (testCase.vectors) {
        expect(testCase.artifact.suite).toBe('code-graph-vectors-v1');
        expect(testCase.artifact.metadata).toMatchObject({
          embeddingModelId: 'bge-small-en-v1.5-q8',
          retrievalMode: 'pinned-production-vectors',
          vectorEnabled: true,
        });
        if (testCase.scale !== undefined) expect(testCase.artifact.metadata.scaleSymbols).toBe(testCase.scale);
      } else {
        expect(testCase.artifact.suite).toBe('code-graph-scale-v1');
        expect(testCase.artifact.metadata.scaleSymbols).toBe(testCase.scale);
      }
    }
  });

  it('keeps lexical scale incremental budgets below the known minute-scale regression with runner headroom', () => {
    const budgets = readJson(join(BASELINE_ROOT, 'budgets.json')) as {
      readonly scalePerformance: Readonly<Record<string, PerformanceBudget>>;
    };
    const cases = [
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-10000-development.json'))),
        maximum: 15_000,
        scale: '10000',
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-100000-development.json'))),
        maximum: 60_000,
        scale: '100000',
      },
    ] as const;

    for (const testCase of cases) {
      const budget = budgets.scalePerformance[testCase.scale]!;
      const baseline = testCase.artifact.measurements.find(
        measurement => measurement.name === 'one-file-incremental-index',
      )!.p95;
      expect(budget.oneFileIncrementalP95MillisecondsMaximum).toBe(testCase.maximum);
      expect(budget.oneFileIncrementalP95MillisecondsMaximum).toBeLessThan(128_000);
      expect(budget.oneFileIncrementalP95MillisecondsMaximum).toBeGreaterThanOrEqual(baseline * 5);
    }
  });

  it('stores complete whole-graph analysis measurements through the 100k-symbol scale point', () => {
    const budgets = readJson(join(BASELINE_ROOT, 'budgets.json')) as {
      readonly developmentPerformance: PerformanceBudget;
      readonly scalePerformance: Readonly<Record<string, PerformanceBudget>>;
    };
    const cases = [
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-parity-development.json'))),
        budget: budgets.developmentPerformance,
        scale: undefined,
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-parity-10000-development.json'))),
        budget: budgets.scalePerformance['10000']!,
        scale: 10_000,
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-parity-100000-development.json'))),
        budget: budgets.scalePerformance['100000']!,
        scale: 100_000,
      },
    ] as const;

    for (const testCase of cases) {
      const measurement = testCase.artifact.measurements.find(
        candidate => candidate.name === 'whole-graph-structural-analysis',
      );
      expect(testCase.artifact.metadata).toMatchObject({analysisCoverage: 'complete'});
      if (testCase.scale === undefined) expect(testCase.artifact.metadata).not.toHaveProperty('scaleSymbols');
      else expect(testCase.artifact.metadata.scaleSymbols).toBe(testCase.scale);
      expect(measurement?.p95).toBeLessThanOrEqual(testCase.budget.wholeGraphAnalysisP95MillisecondsMaximum);
    }
  });

  it('freezes an opt-in production-shaped large-monorepo profile without inventing a latency baseline', () => {
    const reviewed = readJson(join(BASELINE_ROOT, 'production-large-profile.json')) as {
      readonly fixture: {
        readonly declarationSymbols: number;
        readonly sourceFiles: number;
        readonly workspaceCount: number;
      };
      readonly notes: readonly string[];
      readonly profile: string;
      readonly targets: {
        readonly eligibleFiles: number;
        readonly graphEdges: number;
        readonly graphSymbols: number;
        readonly lexicalTermRows: number;
      };
      readonly version: number;
    };

    expect(reviewed).toMatchObject({
      fixture: {
        declarationSymbols: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.declarationSymbols,
        sourceFiles: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.sourceFiles,
        workspaceCount: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.workspaceCount,
      },
      profile: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.id,
      targets: {
        eligibleFiles: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetEligibleFiles,
        graphEdges: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetGraphEdges,
        graphSymbols: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetGraphSymbols,
        lexicalTermRows: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetLexicalTermRows,
      },
      version: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.version,
    });
    expect(productionWorkspaceRoots(reviewed.fixture.workspaceCount)).toEqual(
      expect.arrayContaining([
        'apps/application-00',
        'apps/integrated/modules/module-00',
        'apps/isolated/packages/package-00',
        'libs/library-00',
      ]),
    );
    expect(reviewed.notes.join(' ')).toContain('no synthetic latency baseline');
  });

  it('materializes the production profile topology across integrated and isolated nested workspaces', async () => {
    const observed = await runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const prepared = yield* prepareProductionCodeGraphFixture({
            declarationSymbols: 48,
            id: 'production-large',
            sourceFiles: 24,
            targetEligibleFiles: 76,
            targetGraphEdges: 150,
            targetGraphSymbols: 99,
            targetLexicalTermRows: 1_000,
            version: 1,
            workspaceCount: 24,
          });
          const tracked = (yield* git(prepared.repository, ['ls-files'])).stdout.trim().split('\n');
          return {
            incrementalSourcePath: prepared.incrementalSourcePath,
            queryText: prepared.queryText,
            tracked,
          };
        }),
      ),
    );

    expect(observed.incrementalSourcePath).toBe('apps/application-00/src/module-00000.ts');
    expect(observed.queryText).toContain('FeatureOperation0000047');
    expect(observed.tracked).toEqual(
      expect.arrayContaining([
        'apps/application-00/src/module-00000.ts',
        'apps/integrated/modules/module-00/src/module-00000.ts',
        'apps/isolated/packages/package-00/src/module-00000.ts',
        'libs/library-00/src/module-00000.ts',
      ]),
    );
  });

  it('stores a passing Java, Kotlin, Swift, and compiler-backed TypeScript baseline and performance gate', () => {
    const polyglotFixture = parseCodeGraphEvaluationFixtureV1(readJson(join(POLYGLOT_FIXTURE_ROOT, 'fixture.json')));
    const baseline = parseCodeGraphEvaluationBaselineV1(
      readJson(join(POLYGLOT_BASELINE_ROOT, 'threadnote-native.json')),
    );
    const artifact = parseBenchmarkArtifactV1(readJson(join(POLYGLOT_BASELINE_ROOT, 'performance-development.json')));
    const budgets = readJson(join(POLYGLOT_BASELINE_ROOT, 'budgets.json')) as {
      readonly developmentPerformance: PerformanceBudget;
      readonly fixture: {readonly hash: string; readonly id: string};
    };
    const hash = codeGraphEvaluationFixtureHash(polyglotFixture);

    expect(polyglotFixture.languages).toEqual(['java', 'kotlin', 'swift', 'typescript']);
    expect(baseline.fixture).toEqual({
      hash,
      id: polyglotFixture.id,
      queries: polyglotFixture.queries.length,
      version: polyglotFixture.version,
    });
    expect(baseline.metrics).toMatchObject({
      authoritativeFalseEdgeRate: 0,
      edgeRecall: 1,
      meanReciprocalRank: 1,
      noAnswerPrecision: 1,
      noAnswerRecall: 1,
      symbolRecall: 1,
      worktreeLeakageRate: 0,
    });
    expect(budgets.fixture).toEqual({hash, id: polyglotFixture.id});
    expect(artifact.suite).toBe('code-graph-polyglot-v1');
    expect(artifact.environment.fixtureHash).toBe(hash);
    expectBenchmarkWithinBudget(artifact, budgets.developmentPerformance);
  });
});

interface PerformanceBudget {
  readonly coldIndexP95MillisecondsMaximum: number;
  readonly derivedIndexBytesMaximum: number;
  readonly hotQueryP95MillisecondsMaximum: number;
  readonly oneFileIncrementalP95MillisecondsMaximum: number;
  readonly processPeakRssBytesMaximum: number;
  readonly wholeGraphAnalysisP95MillisecondsMaximum: number;
}

function expectBenchmarkWithinBudget(artifact: BenchmarkArtifactV1, budget: PerformanceBudget): void {
  const measurements = new Map(artifact.measurements.map(measurement => [measurement.name, measurement]));
  expect(measurements.get('cold-index')?.p95).toBeLessThanOrEqual(budget.coldIndexP95MillisecondsMaximum);
  expect(measurements.get('one-file-incremental-index')?.p95).toBeLessThanOrEqual(
    budget.oneFileIncrementalP95MillisecondsMaximum,
  );
  const queryMeasurement =
    artifact.metadata.vectorEnabled === true ? 'hot-semantic-vector-query' : 'hot-exact-lexical-query';
  expect(measurements.get(queryMeasurement)?.p95).toBeLessThanOrEqual(budget.hotQueryP95MillisecondsMaximum);
  expect(measurements.get('cold-process-peak-rss')?.p95).toBeLessThanOrEqual(budget.processPeakRssBytesMaximum);
  expect(measurements.get('incremental-process-peak-rss')?.p95).toBeLessThanOrEqual(budget.processPeakRssBytesMaximum);
  expect(measurements.get('derived-index-disk')?.p95).toBeLessThanOrEqual(budget.derivedIndexBytesMaximum);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
