import {Clock, Effect} from 'effect';
import type {AnonymousTelemetryContextBriefCitationUnknownReason} from '../effect/telemetry.js';
import {
  makeContextBriefAnonymousTelemetryReporter,
  type ContextBriefCitationTelemetrySummary,
} from '../telemetry/context_brief.js';
import type {RuntimeConfig} from '../types.js';
import {validateContextBriefMemoryCitations} from './citation_validation.js';
import {retrieveContextBriefGraphEvidence, unavailableContextBriefGraphEvidence} from './graph_evidence.js';
import {
  mergeContextBriefMemoryEvidence,
  retrieveContextBriefCodeLinkedMemoryEvidence,
  retrieveContextBriefMemoryEvidence,
  unavailableContextBriefCodeLinkedMemoryEvidence,
  unavailableContextBriefMemoryEvidence,
} from './memory_evidence.js';
import {assembleContextBriefLogicalResult, planContextBrief} from './planner.js';
import {projectContextBrief} from './projector.js';
import type {
  ContextBriefGraphEvidenceV1,
  ContextBriefCitationValidationFenceV2,
  ContextBriefMemoryRetrievalV1,
  ContextBriefLogicalResultV1,
  ContextBriefPlanV1,
  ContextBriefRequestV1,
  ProjectedContextBriefV1,
} from './types.js';

export interface ContextBriefCompilerDependencies<
  GraphR = never,
  MemoryR = never,
  CitationR = never,
  ProjectR = never,
> {
  readonly graphEvidence: (
    plan: ContextBriefPlanV1['graph'],
  ) => Effect.Effect<ContextBriefGraphEvidenceV1, unknown, GraphR>;
  readonly memoryEvidence: (
    plan: ContextBriefPlanV1['memory'],
  ) => Effect.Effect<ContextBriefMemoryRetrievalV1, unknown, MemoryR>;
  readonly codeLinkedMemoryEvidence?: (
    plan: ContextBriefPlanV1['codeAnchors'],
  ) => Effect.Effect<ContextBriefMemoryRetrievalV1, unknown, MemoryR>;
  readonly citationValidation?: (
    scope: ContextBriefPlanV1['scope'],
    candidates: ContextBriefMemoryRetrievalV1['candidates'],
    fence: ContextBriefCitationValidationFenceV2 | undefined,
  ) => Effect.Effect<NonNullable<ContextBriefMemoryRetrievalV1['citationValidations']>, unknown, CitationR>;
  readonly projection?: (
    logical: ContextBriefLogicalResultV1,
    maximumEstimatedTokens: number,
  ) => Effect.Effect<ProjectedContextBriefV1, unknown, ProjectR>;
}

export interface ContextBriefRuntimeCompilerSources<
  GraphR = never,
  MemoryR = never,
  CitationR = never,
  ProjectR = never,
> {
  readonly citationValidation: NonNullable<
    ContextBriefCompilerDependencies<never, never, CitationR>['citationValidation']
  >;
  readonly graphEvidence: ContextBriefCompilerDependencies<GraphR>['graphEvidence'];
  readonly codeLinkedMemoryEvidence?: ContextBriefCompilerDependencies<never, MemoryR>['codeLinkedMemoryEvidence'];
  readonly memoryEvidence: ContextBriefCompilerDependencies<never, MemoryR>['memoryEvidence'];
  readonly projection: NonNullable<ContextBriefCompilerDependencies<never, never, never, ProjectR>['projection']>;
}

/**
 * Measure raw phase outcomes before converting source failures into bounded
 * compiler gaps. This preserves a successful fail-soft brief without teaching
 * telemetry that an unavailable graph, recall store, or validator succeeded.
 */
export function instrumentContextBriefCompilerDependencies<
  GraphR = never,
  MemoryR = never,
  CitationR = never,
  ProjectR = never,
>(
  reporter: ReturnType<typeof makeContextBriefAnonymousTelemetryReporter>,
  sources: ContextBriefRuntimeCompilerSources<GraphR, MemoryR, CitationR, ProjectR>,
  requestedRepositories: number,
): ContextBriefCompilerDependencies<GraphR, MemoryR, CitationR, ProjectR> {
  return {
    citationValidation: (scope, candidates, fence) =>
      reporter
        .citationValidation(sources.citationValidation(scope, candidates, fence), validations =>
          summarizeContextBriefCitationTelemetry(candidates, validations),
        )
        .pipe(
          Effect.catch(() =>
            Clock.currentTimeMillis.pipe(
              Effect.map(now => failedContextBriefCitationValidations(candidates, new Date(now).toISOString())),
            ),
          ),
        ),
    graphEvidence: graphPlan =>
      reporter
        .graph(sources.graphEvidence(graphPlan))
        .pipe(
          Effect.catch(() =>
            Effect.succeed(unavailableContextBriefGraphEvidence('graph-query-unavailable', requestedRepositories)),
          ),
        ),
    ...(sources.codeLinkedMemoryEvidence === undefined
      ? {}
      : {
          codeLinkedMemoryEvidence: (codePlan: ContextBriefPlanV1['codeAnchors']) =>
            reporter.codeLinkedMemory(
              sources.codeLinkedMemoryEvidence!(codePlan).pipe(
                Effect.catch(() =>
                  Effect.succeed(unavailableContextBriefCodeLinkedMemoryEvidence(codePlan.codeRefs.length)),
                ),
              ),
            ),
        }),
    memoryEvidence: memoryPlan =>
      reporter
        .memory(sources.memoryEvidence(memoryPlan))
        .pipe(Effect.catch(() => Effect.succeed(unavailableContextBriefMemoryEvidence()))),
    projection: (logical, maximumEstimatedTokens) =>
      reporter.projection(
        sources.projection(logical, maximumEstimatedTokens),
        projected => projected.structuredContent.output.truncated,
        logical.coverage.memory.codeAnchors === undefined
          ? undefined
          : projected => ({
              ...logical.coverage.memory.codeAnchors!,
              gaps: logical.coverage.gaps,
              recoveryPresent: projected.structuredContent.recommendedFollowUps.length > 0,
            }),
        projected => {
          const graphReturned =
            projected.structuredContent.graph.cards.length + projected.structuredContent.graph.contracts.length > 0;
          const memoryReturned =
            projected.structuredContent.durableDecisions.length + projected.structuredContent.activeHandoffs.length > 0;
          return graphReturned && memoryReturned
            ? 'mixed'
            : graphReturned
              ? 'graph'
              : memoryReturned
                ? 'memory'
                : 'none';
        },
      ),
  };
}

/** Deterministic compiler core with injected read boundaries for focused tests and alternate clients. */
export const compileContextBriefWith = Effect.fn('contextBrief.compileWith')(function* <
  GraphR = never,
  MemoryR = never,
  CitationR = never,
  ProjectR = never,
>(
  dependencies: ContextBriefCompilerDependencies<GraphR, MemoryR, CitationR, ProjectR>,
  input: ContextBriefRequestV1 | unknown,
) {
  const plan = planContextBrief(input);
  const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const codeLinkedMemory =
    plan.codeAnchors.codeRefs.length === 0
      ? Effect.succeed(undefined)
      : dependencies.codeLinkedMemoryEvidence === undefined
        ? Effect.succeed(unavailableContextBriefCodeLinkedMemoryEvidence(plan.codeAnchors.codeRefs.length))
        : dependencies.codeLinkedMemoryEvidence(plan.codeAnchors);
  const [graph, lexicalMemory, linkedMemory] = yield* Effect.all(
    [dependencies.graphEvidence(plan.graph), dependencies.memoryEvidence(plan.memory), codeLinkedMemory],
    {concurrency: 3},
  );
  const memory = mergeContextBriefMemoryEvidence(
    lexicalMemory,
    linkedMemory,
    plan.memory.candidateLimit,
    plan.codeAnchors.candidateLimit,
  );
  const citationValidations = dependencies.citationValidation
    ? yield* dependencies.citationValidation(plan.scope, memory.candidates, graph.citationValidationFence)
    : memory.citationValidations;
  const logical = assembleContextBriefLogicalResult({
    graph,
    memory: citationValidations === undefined ? memory : {...memory, citationValidations},
    observedAt,
    plan,
  });
  return yield* dependencies.projection
    ? dependencies.projection(logical, plan.outputBudgetTokens)
    : Effect.sync(() => projectContextBrief(logical, plan.outputBudgetTokens));
});

/**
 * CLI/MCP-ready local runtime adapter. Graph failure and recall failure remain
 * explicit coverage gaps so either evidence source can still orient the task.
 */
export const compileContextBrief = Effect.fn('contextBrief.compile')(function* (
  config: RuntimeConfig,
  input: ContextBriefRequestV1 | unknown,
) {
  const request = planContextBrief(input);
  const requestedRepositories = request.scope.kind === 'repository' ? 1 : 0;
  const reporter = makeContextBriefAnonymousTelemetryReporter(request.scope.kind === 'workset' ? 'workset' : 'local', {
    contract: request.codeAnchors.codeRefs.length === 0 ? 'task-only-v2' : 'code-anchored-v3',
    mode: request.mode,
  });
  yield* reporter.annotate;
  return yield* compileContextBriefWith(
    instrumentContextBriefCompilerDependencies(
      reporter,
      {
        citationValidation: (scope, candidates, fence) =>
          validateContextBriefMemoryCitations(config, scope, candidates, fence),
        graphEvidence: graphPlan => retrieveContextBriefGraphEvidence(config, graphPlan),
        codeLinkedMemoryEvidence: codePlan => retrieveContextBriefCodeLinkedMemoryEvidence(config, codePlan),
        memoryEvidence: memoryPlan => retrieveContextBriefMemoryEvidence(config, memoryPlan),
        projection: (logical, maximumEstimatedTokens) =>
          Effect.sync(() => projectContextBrief(logical, maximumEstimatedTokens)),
      },
      requestedRepositories,
    ),
    {
      budgetTokens: request.outputBudgetTokens,
      ...(request.codeAnchors.codeRefs.length === 0 ? {} : {codeRefs: request.codeAnchors.codeRefs}),
      mode: request.mode,
      scope: request.scope,
      task: request.task,
    },
  );
});

function failedContextBriefCitationValidations(
  candidates: ContextBriefMemoryRetrievalV1['candidates'],
  observedAt: string,
): NonNullable<ContextBriefMemoryRetrievalV1['citationValidations']> {
  return candidates.flatMap(candidate =>
    candidate.codeCitations.length === 0
      ? []
      : [
          {
            receipts: candidate.codeCitations.map(citation => ({
              candidateCount: 0,
              citationId: citation.id,
              coverage: 'incomplete' as const,
              kind: citation.target.kind,
              observedAt,
              reason: 'validation-error' as const,
              repositoryId: citation.repositoryId,
              sourcePath: citation.path,
              status: 'unknown' as const,
              strategy: 'none' as const,
              validatorVersion: 1 as const,
            })),
            uri: candidate.uri,
          },
        ],
  );
}

/** Project private validation receipts into the closed, count-only telemetry vocabulary. */
export function summarizeContextBriefCitationTelemetry(
  candidates: ContextBriefMemoryRetrievalV1['candidates'],
  validations: NonNullable<ContextBriefMemoryRetrievalV1['citationValidations']>,
): ContextBriefCitationTelemetrySummary {
  const validationsByUri = new Map(validations.map(validation => [validation.uri, validation]));
  let cacheHits = 0;
  let citations = 0;
  let citedMemories = 0;
  let exactCitations = 0;
  let relocatedCitations = 0;
  let staleCitations = 0;
  let unknownCitations = 0;
  const repositoriesValidated = new Set<string>();
  const unknownReasons = new Set<AnonymousTelemetryContextBriefCitationUnknownReason>();

  for (const candidate of candidates) {
    const citationCount = candidate.codeCitations.length + candidate.citationErrorCount;
    if (citationCount === 0) continue;
    citations += citationCount;
    citedMemories += 1;
    const validation = validationsByUri.get(candidate.uri);
    cacheHits += Math.min(validation?.cacheHits ?? 0, candidate.codeCitations.length);
    const receiptsById = new Map((validation?.receipts ?? []).map(receipt => [receipt.citationId, receipt]));
    for (const citation of candidate.codeCitations) {
      const receipt = receiptsById.get(citation.id);
      if (receipt?.snapshotId !== undefined && receipt.repositoryId !== undefined) {
        repositoriesValidated.add(receipt.repositoryId);
      }
      switch (receipt?.status) {
        case 'exact':
          exactCitations += 1;
          break;
        case 'relocated':
          relocatedCitations += 1;
          break;
        case 'changed':
        case 'deleted':
          staleCitations += 1;
          break;
        case 'unknown':
          unknownCitations += 1;
          unknownReasons.add(telemetryUnknownReason(receipt.reason));
          break;
        case undefined:
          unknownCitations += 1;
          unknownReasons.add('repository-unavailable');
          break;
      }
    }
    if (candidate.citationErrorCount > 0) {
      unknownCitations += candidate.citationErrorCount;
      unknownReasons.add('invalid-citation');
    }
  }

  const coverage =
    citations === 0
      ? ('none' as const)
      : unknownCitations === 0
        ? ('complete' as const)
        : unknownCitations === citations
          ? ('unavailable' as const)
          : ('partial' as const);
  return {
    cacheHits,
    citations,
    citedMemories,
    coverage,
    exactCitations,
    relocatedCitations,
    repositoriesValidated: repositoriesValidated.size,
    staleCitations,
    unknownCitations,
    ...(unknownCitations === 0
      ? {}
      : {unknownReason: unknownReasons.size === 1 ? [...unknownReasons][0]! : ('mixed' as const)}),
  };
}

function telemetryUnknownReason(
  reason: NonNullable<ContextBriefMemoryRetrievalV1['citationValidations']>[number]['receipts'][number]['reason'],
): AnonymousTelemetryContextBriefCitationUnknownReason {
  switch (reason) {
    case 'ambiguous-relocation':
      return 'ambiguous-relocation';
    case 'citation-limit':
      return 'budget-exhausted';
    case 'extractor-mismatch':
      return 'unsupported';
    case 'graph-incomplete':
      return 'snapshot-unavailable';
    case 'graph-stale':
      return 'snapshot-not-current';
    case 'malformed-citation':
      return 'invalid-citation';
    case 'repository-ambiguous':
    case 'repository-unavailable':
      return 'repository-unavailable';
    case 'validation-error':
      return 'store-failure';
    case 'exact':
    case 'relocated':
    case 'source-changed':
    case 'source-deleted':
      return 'unsupported';
  }
}

export * from './graph_evidence.js';
export * from './graph_anchor_evidence.js';
export * from './citation_validation.js';
export * from './memory_evidence.js';
export * from './planner.js';
export * from './projector.js';
export * from './types.js';
