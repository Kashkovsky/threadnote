import {Clock, Effect} from 'effect';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from '../../src/code_graph/indexer.js';
import {
  CODE_GRAPH_WORKSET_MAX_REPOSITORIES,
  inspectCodeGraphWorkset,
  type CodeGraphWorksetQueryResult,
} from '../../src/code_graph/workset_query.js';
import type {RuntimeConfig} from '../../src/types.js';
import {
  CODE_GRAPH_WORKSET_EVALUATION_VERSION,
  codeGraphWorksetEdgeKey,
  parseCodeGraphWorksetEvaluationFixtureV1,
  type CodeGraphWorksetCoverageObservationV1,
  type CodeGraphWorksetEvaluationFixtureV1,
  type CodeGraphWorksetEvaluationMeasurementV1,
  type CodeGraphWorksetEvaluationObservationV1,
  type CodeGraphWorksetExpectedEdgeV1,
  type CodeGraphWorksetMemberState,
  type CodeGraphWorksetSymbolRefV1,
} from '../../src/evaluation/code-graph-workset.js';
import {measureAgentToolResponse} from '../../src/evaluation/agent-response.js';
import {benchmarkMeasurement, type BenchmarkMeasurementV1} from '../../src/evaluation/benchmark.js';
import {codeGraphWorksetMcpResponse} from '../../src/mcp_server.js';
import {
  CODE_GRAPH_WORKSET_FIXTURE_ARCHETYPES,
  CODE_GRAPH_WORKSET_FIXTURE_GENERATOR_VERSION,
  establishCodeGraphWorksetStaleReadySnapshot,
  type CodeGraphWorksetFixturePlan,
  type CodeGraphWorksetFixtureSize,
  type MaterializedCodeGraphWorksetFixtureRepository,
  type PreparedCodeGraphWorksetFixture,
} from './code-graph-workset-fixture.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

export const CODE_GRAPH_WORKSET_DEFAULT_NODE_LIMIT = 24;
export const CODE_GRAPH_WORKSET_DEFAULT_EDGE_LIMIT = 40;
export const CODE_GRAPH_WORKSET_AGENT_TOKEN_BUDGET = 1_500;
export const CODE_GRAPH_WORKSET_FIFTY_FIRST_EVIDENCE_P95_BUDGET_MS = 1_000;
export const CODE_GRAPH_WORKSET_FIFTY_COMPLETION_P95_BUDGET_MS = 3_000;
export const CODE_GRAPH_WORKSET_128_COMPLETION_P95_BUDGET_MS = 5_000;

export interface CodeGraphWorksetDeliveryMeasurementInput {
  readonly completionMilliseconds: number;
  readonly evidenceItemCount: number;
  readonly repositoriesConsidered: number;
  readonly repositoriesDeepQueried: number;
  readonly repositoryDatabasesOpened: number;
  readonly response: {
    readonly structuredContent?: unknown;
    readonly text?: string;
  };
}

export interface CodeGraphWorksetBenchmarkSample {
  readonly completionMilliseconds: number;
  readonly estimatedTokenCount: number;
  readonly evidenceItemCount: number;
  readonly repositoriesConsidered: number;
  readonly repositoriesDeepQueried: number;
  readonly repositoryDatabasesOpened: number;
  readonly requestedRepositories: number;
  readonly responseUtf8Bytes: number;
  readonly structuredResponseUtf8Bytes: number;
  readonly textResponseUtf8Bytes: number;
  readonly timeToFirstEvidenceMilliseconds: number;
  readonly worksetSize: number;
}

export interface MeasuredCodeGraphWorksetQuery {
  readonly measurement: CodeGraphWorksetEvaluationMeasurementV1;
  readonly response: ReturnType<typeof codeGraphWorksetMcpResponse>;
  readonly result: CodeGraphWorksetQueryResult;
}

export function codeGraphWorksetRuntimeConfig(fixture: PreparedCodeGraphWorksetFixture): RuntimeConfig {
  return {
    account: 'evaluation',
    agentContextHome: fixture.home,
    agentId: 'code-graph-workset-harness',
    manifestPath: fixture.manifestPath,
    user: 'evaluation',
  };
}

/**
 * Adapts the path-independent generator plan to the versioned evaluation
 * contract. Impact and path remain typed intent categories, but V1 records
 * their operations as unsupported instead of running a text-query proxy.
 */
export function buildCodeGraphWorksetEvaluationFixture(
  plan: CodeGraphWorksetFixturePlan,
  requestedSizes: readonly CodeGraphWorksetFixtureSize[],
): CodeGraphWorksetEvaluationFixtureV1 {
  const sizes = [...requestedSizes];
  const usedArchetypes = new Set(plan.members.map(member => member.archetypeId));
  const queries = plan.queries.flatMap(query => {
    const applicableSizes = query.sizes.filter(size => sizes.includes(size));
    if (applicableSizes.length === 0) return [];
    return [
      {
        answerable: query.answerable,
        category: query.category,
        expectedEdges: query.expectedEdges,
        expectedRepositories: query.expectedRepositories,
        expectedSymbols: query.expectedSymbols,
        id: query.id,
        operation: query.operation,
        query: query.query,
        sizes: applicableSizes,
      } as const,
    ];
  });
  return parseCodeGraphWorksetEvaluationFixtureV1({
    allowedAuthoritativeEdges: plan.allowedAuthoritativeEdges,
    generator: {
      archetypes: CODE_GRAPH_WORKSET_FIXTURE_ARCHETYPES.filter(archetype => usedArchetypes.has(archetype.id)).map(
        ({id, sha256}) => ({id, sha256}),
      ),
      name: plan.identity.generator,
      version: String(CODE_GRAPH_WORKSET_FIXTURE_GENERATOR_VERSION),
    },
    id: plan.identity.id,
    members: plan.members,
    queries,
    sizes,
    version: CODE_GRAPH_WORKSET_EVALUATION_VERSION,
    worksetId: plan.identity.worksetName,
  });
}

/** Indexes every materialized member whose fixture state permits a ready snapshot. */
export const indexPreparedCodeGraphWorksetFixture = Effect.fn('codeGraphWorksetHarness.indexFixture')(function* (
  fixture: PreparedCodeGraphWorksetFixture,
) {
  const indexer = yield* CodeGraphIndexer;
  yield* Effect.forEach(fixture.repositories, repository => indexFixtureRepository(indexer, fixture.home, repository), {
    concurrency: 2,
  });
});

export const measureCodeGraphWorksetQuery = Effect.fn('codeGraphWorksetHarness.measureQuery')(function* (
  config: RuntimeConfig,
  worksetName: string,
  query: string,
) {
  const started = yield* Clock.currentTimeNanos;
  const result = yield* inspectCodeGraphWorkset(config, worksetName, {
    edgeLimit: CODE_GRAPH_WORKSET_DEFAULT_EDGE_LIMIT,
    nodeLimit: CODE_GRAPH_WORKSET_DEFAULT_NODE_LIMIT,
    query,
    requestMaintenance: false,
  });
  const response = codeGraphWorksetMcpResponse(result);
  const finished = yield* Clock.currentTimeNanos;
  const completionMilliseconds = Number(finished - started) / NANOSECONDS_PER_MILLISECOND;
  const evidenceItemCount = returnedEvidenceItemCount(response);
  const readyRepositories = result.repositories.filter(member => member.state === 'ready').length;
  return {
    measurement: codeGraphWorksetDeliveryMeasurement({
      completionMilliseconds,
      evidenceItemCount,
      repositoriesConsidered: result.coverage.queriedRepositories,
      repositoriesDeepQueried: readyRepositories,
      repositoryDatabasesOpened: readyRepositories,
      response,
    }),
    response,
    result,
  } satisfies MeasuredCodeGraphWorksetQuery;
});

/**
 * V1 delivers a complete buffered MCP response. Consequently, when evidence
 * is present, delivered time-to-first-evidence equals completion. The current
 * response has nodes and edges rather than formal V2 cards, so the card-count
 * field records the exact number of delivered V1 evidence items.
 */
export function codeGraphWorksetDeliveryMeasurement(
  input: CodeGraphWorksetDeliveryMeasurementInput,
): CodeGraphWorksetEvaluationMeasurementV1 {
  assertNonNegativeFinite(input.completionMilliseconds, 'completionMilliseconds');
  assertNonNegativeInteger(input.evidenceItemCount, 'evidenceItemCount');
  assertNonNegativeInteger(input.repositoriesConsidered, 'repositoriesConsidered');
  assertNonNegativeInteger(input.repositoriesDeepQueried, 'repositoriesDeepQueried');
  assertNonNegativeInteger(input.repositoryDatabasesOpened, 'repositoryDatabasesOpened');
  const response = measureAgentToolResponse(input.response);
  return {
    catalogBytesRead: 0,
    completionMilliseconds: input.completionMilliseconds,
    estimatedTokenCount: response.estimatedTokens,
    evidenceCardCount: input.evidenceItemCount,
    representativeTokenCounts: [],
    repositoriesConsidered: input.repositoriesConsidered,
    repositoriesDeepQueried: input.repositoriesDeepQueried,
    repositoryDatabasesOpened: input.repositoryDatabasesOpened,
    responseUtf8Bytes: response.totalBytes,
    structuredResponseUtf8Bytes: response.structuredBytes,
    textResponseUtf8Bytes: response.textBytes,
    ...(input.evidenceItemCount > 0 ? {timeToFirstEvidenceCardMilliseconds: input.completionMilliseconds} : {}),
    timeToFirstEvidenceSemantics: 'buffered-response',
  };
}

export function codeGraphWorksetObservationFromQuery(
  fixture: CodeGraphWorksetEvaluationFixtureV1,
  worksetSize: number,
  sampleId: string,
  queryId: string,
  measured: MeasuredCodeGraphWorksetQuery,
  worktree: {readonly leakageCount: number; readonly observationCount: number} = {
    leakageCount: 0,
    observationCount: 0,
  },
): CodeGraphWorksetEvaluationObservationV1 {
  const repositoryIdByProject = repositoryIdsByProject(fixture, measured.result);
  const repositoryHits: string[] = [];
  const symbolHits: CodeGraphWorksetSymbolRefV1[] = [];
  const edges: CodeGraphWorksetExpectedEdgeV1[] = [];
  const resultByProject = new Map(measured.result.repositories.map(member => [member.project, member]));
  for (const member of measured.response.structuredContent.repositories) {
    if (member.state !== 'ready') continue;
    const repositoryId = repositoryIdByProject.get(member.project);
    if (!repositoryId) continue;
    if (member.graph.nodes.length > 0 || member.graph.edges.length > 0) repositoryHits.push(repositoryId);
    for (const node of member.graph.nodes) {
      symbolHits.push({repositoryId, symbol: `${node.path}#${node.name}`});
    }
    const rawMember = resultByProject.get(member.project);
    const rawNodes = new Map(
      rawMember?.state === 'ready' ? rawMember.graph.nodes.map(node => [node.id, node] as const) : [],
    );
    for (const edge of member.graph.edges) {
      edges.push({
        provenance: edge.provenance,
        relation: edge.relation,
        source: deliveredEdgeEndpoint(repositoryId, edge.sourceId, edge.sourceName, edge.evidencePath, rawNodes),
        target: deliveredEdgeEndpoint(repositoryId, edge.targetId, edge.targetName, edge.evidencePath, rawNodes),
      });
    }
  }
  const deliveredEdges = uniqueEdges(edges);
  return {
    authoritativeEdges: deliveredEdges.filter(edge => edge.provenance === 'declared' || edge.provenance === 'resolved'),
    coverage: codeGraphWorksetCoverage(fixture, worksetSize, measured.result),
    edges: deliveredEdges,
    execution: 'executed',
    measurement: measured.measurement,
    queryId,
    reportedNoAnswer: symbolHits.length === 0 && returnedEvidenceItemCount(measured.response) === 0,
    repositoryHits,
    sampleId,
    symbolHits: uniqueSymbols(symbolHits),
    version: CODE_GRAPH_WORKSET_EVALUATION_VERSION,
    worksetSize,
    worktreeLeakageCount: worktree.leakageCount,
    worktreeObservationCount: worktree.observationCount,
  };
}

export function unsupportedCodeGraphWorksetObservation(
  fixture: CodeGraphWorksetEvaluationFixtureV1,
  worksetSize: number,
  sampleId: string,
  queryId: string,
  coverage: readonly CodeGraphWorksetCoverageObservationV1[],
): CodeGraphWorksetEvaluationObservationV1 {
  return {
    authoritativeEdges: [],
    coverage,
    edges: [],
    execution: 'unsupported-operation',
    queryId,
    reportedNoAnswer: false,
    repositoryHits: [],
    sampleId,
    symbolHits: [],
    version: CODE_GRAPH_WORKSET_EVALUATION_VERSION,
    worksetSize,
    worktreeLeakageCount: 0,
    worktreeObservationCount: 0,
  };
}

export function codeGraphWorksetCoverage(
  fixture: CodeGraphWorksetEvaluationFixtureV1,
  worksetSize: number,
  result: CodeGraphWorksetQueryResult,
): readonly CodeGraphWorksetCoverageObservationV1[] {
  const activeMembers = fixture.members.filter(member => member.ordinal <= worksetSize);
  const byProject = new Map(result.repositories.map(member => [member.project, member]));
  return activeMembers.flatMap(member => {
    const project = `workset-${member.id}`;
    const observed = byProject.get(project);
    return observed ? [{repositoryId: member.id, state: memberState(observed)}] : [];
  });
}

export function codeGraphWorksetBenchmarkSample(
  worksetSize: number,
  measured: MeasuredCodeGraphWorksetQuery,
): CodeGraphWorksetBenchmarkSample {
  const measurement = measured.measurement;
  if (measurement.evidenceCardCount === 0 || measurement.timeToFirstEvidenceCardMilliseconds === undefined) {
    throw new Error(`Workset benchmark control returned no evidence at size ${worksetSize}.`);
  }
  return {
    completionMilliseconds: measurement.completionMilliseconds,
    estimatedTokenCount: measurement.estimatedTokenCount,
    evidenceItemCount: measurement.evidenceCardCount,
    repositoriesConsidered: measurement.repositoriesConsidered,
    repositoriesDeepQueried: measurement.repositoriesDeepQueried,
    repositoryDatabasesOpened: measurement.repositoryDatabasesOpened,
    requestedRepositories: measured.result.coverage.requestedRepositories,
    responseUtf8Bytes: measurement.responseUtf8Bytes,
    structuredResponseUtf8Bytes: measurement.structuredResponseUtf8Bytes,
    textResponseUtf8Bytes: measurement.textResponseUtf8Bytes,
    timeToFirstEvidenceMilliseconds: measurement.timeToFirstEvidenceCardMilliseconds,
    worksetSize,
  };
}

export function codeGraphWorksetBenchmarkMeasurements(
  samples: readonly CodeGraphWorksetBenchmarkSample[],
): readonly BenchmarkMeasurementV1[] {
  const sizes = [...new Set(samples.map(sample => sample.worksetSize))].sort((left, right) => left - right);
  const measurements: BenchmarkMeasurementV1[] = [
    benchmarkMeasurement('workset-current-repository-cap', 'count', [CODE_GRAPH_WORKSET_MAX_REPOSITORIES]),
  ];
  for (const size of sizes) {
    const selected = samples.filter(sample => sample.worksetSize === size);
    const prefix = `workset-${size}`;
    measurements.push(
      benchmarkMeasurement(
        `${prefix}-completion`,
        'milliseconds',
        selected.map(value => value.completionMilliseconds),
      ),
      benchmarkMeasurement(
        `${prefix}-delivered-time-to-first-evidence-buffered`,
        'milliseconds',
        selected.map(value => value.timeToFirstEvidenceMilliseconds),
      ),
      benchmarkMeasurement(
        `${prefix}-mcp-structured-response`,
        'bytes',
        selected.map(value => value.structuredResponseUtf8Bytes),
      ),
      benchmarkMeasurement(
        `${prefix}-mcp-text-response`,
        'bytes',
        selected.map(value => value.textResponseUtf8Bytes),
      ),
      benchmarkMeasurement(
        `${prefix}-total-agent-output`,
        'bytes',
        selected.map(value => value.responseUtf8Bytes),
      ),
      benchmarkMeasurement(
        `${prefix}-estimated-agent-tokens`,
        'count',
        selected.map(value => value.estimatedTokenCount),
      ),
      benchmarkMeasurement(
        `${prefix}-requested-repositories`,
        'count',
        selected.map(value => value.requestedRepositories),
      ),
      benchmarkMeasurement(
        `${prefix}-considered-repositories`,
        'count',
        selected.map(value => value.repositoriesConsidered),
      ),
      benchmarkMeasurement(
        `${prefix}-deep-queried-repositories`,
        'count',
        selected.map(value => value.repositoriesDeepQueried),
      ),
      benchmarkMeasurement(
        `${prefix}-opened-repository-databases`,
        'count',
        selected.map(value => value.repositoryDatabasesOpened),
      ),
      benchmarkMeasurement(
        `${prefix}-delivered-v1-evidence-items`,
        'count',
        selected.map(value => value.evidenceItemCount),
      ),
    );
  }
  return measurements;
}

export function codeGraphWorksetBenchmarkBudgetFailures(
  measurements: readonly BenchmarkMeasurementV1[],
  requestedSizes: readonly number[],
): readonly string[] {
  const byName = new Map(measurements.map(measurement => [measurement.name, measurement]));
  const failures: string[] = [];
  const p95 = (name: string, maximum: number) => {
    const measurement = byName.get(name);
    if (measurement && measurement.p95 > maximum) {
      failures.push(`${name} p95 ${measurement.p95.toFixed(2)}ms exceeds ${maximum}ms`);
    }
  };
  if (requestedSizes.includes(50)) {
    p95('workset-50-delivered-time-to-first-evidence-buffered', CODE_GRAPH_WORKSET_FIFTY_FIRST_EVIDENCE_P95_BUDGET_MS);
    p95('workset-50-completion', CODE_GRAPH_WORKSET_FIFTY_COMPLETION_P95_BUDGET_MS);
  }
  if (requestedSizes.includes(128)) {
    p95('workset-128-completion', CODE_GRAPH_WORKSET_128_COMPLETION_P95_BUDGET_MS);
  }
  for (const size of requestedSizes) {
    const tokens = byName.get(`workset-${size}-estimated-agent-tokens`);
    if (tokens && tokens.maximum > CODE_GRAPH_WORKSET_AGENT_TOKEN_BUDGET) {
      failures.push(
        `workset-${size}-estimated-agent-tokens maximum ${tokens.maximum} exceeds ${CODE_GRAPH_WORKSET_AGENT_TOKEN_BUDGET}`,
      );
    }
  }
  return failures;
}

function indexFixtureRepository(
  indexer: CodeGraphIndexerShape,
  home: string,
  repository: MaterializedCodeGraphWorksetFixtureRepository,
) {
  if (!repository.exists || repository.state === 'cold' || repository.state === 'failed') return Effect.void;
  const index = (cwd: string) => indexer.index({cwd, threadnoteHome: home});
  if (repository.state === 'stale') {
    return Effect.tryPromise({
      try: () => establishCodeGraphWorksetStaleReadySnapshot(repository, cwd => Effect.runPromise(index(cwd))),
      catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.asVoid);
  }
  return index(repository.path).pipe(
    Effect.andThen(
      repository.siblingWorktreePath ? index(repository.siblingWorktreePath).pipe(Effect.asVoid) : Effect.void,
    ),
    Effect.asVoid,
  );
}

function repositoryIdsByProject(
  fixture: CodeGraphWorksetEvaluationFixtureV1,
  result: CodeGraphWorksetQueryResult,
): ReadonlyMap<string, string> {
  const activeIds = new Set(fixture.members.map(member => member.id));
  return new Map(
    result.repositories.flatMap(member => {
      const id = member.project.startsWith('workset-') ? member.project.slice('workset-'.length) : '';
      return activeIds.has(id) ? [[member.project, id] as const] : [];
    }),
  );
}

function memberState(member: CodeGraphWorksetQueryResult['repositories'][number]): CodeGraphWorksetMemberState {
  if (member.state === 'ready') return member.graph.freshness;
  if (member.reason === 'missing-path') return 'missing';
  if (member.reason === 'no-ready-snapshot') return 'deferred';
  return 'failed';
}

function returnedEvidenceItemCount(response: ReturnType<typeof codeGraphWorksetMcpResponse>): number {
  return response.structuredContent.output.returnedNodes + response.structuredContent.output.returnedEdges;
}

function uniqueSymbols(symbols: readonly CodeGraphWorksetSymbolRefV1[]): readonly CodeGraphWorksetSymbolRefV1[] {
  const seen = new Set<string>();
  return symbols.filter(symbol => {
    const key = `${symbol.repositoryId}\u0000${symbol.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueEdges(edges: readonly CodeGraphWorksetExpectedEdgeV1[]): readonly CodeGraphWorksetExpectedEdgeV1[] {
  const seen = new Set<string>();
  return edges.filter(edge => {
    const key = codeGraphWorksetEdgeKey(edge);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deliveredEdgeEndpoint(
  repositoryId: string,
  nodeId: string | undefined,
  name: string,
  evidencePath: string,
  nodes: ReadonlyMap<string, {readonly name: string; readonly path: string}>,
): CodeGraphWorksetSymbolRefV1 {
  const node = nodeId ? nodes.get(nodeId) : undefined;
  return {
    repositoryId,
    symbol: node ? `${node.path}#${node.name}` : `${evidencePath}#${name}`,
  };
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number.`);
}
