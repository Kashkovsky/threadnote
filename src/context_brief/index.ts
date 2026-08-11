import {Effect} from 'effect';
import type {RuntimeConfig} from '../types.js';
import {retrieveContextBriefGraphEvidence, unavailableContextBriefGraphEvidence} from './graph_evidence.js';
import {retrieveContextBriefMemoryEvidence, unavailableContextBriefMemoryEvidence} from './memory_evidence.js';
import {assembleContextBriefLogicalResult, planContextBrief} from './planner.js';
import {projectContextBrief} from './projector.js';
import type {
  ContextBriefGraphEvidenceV1,
  ContextBriefMemoryRetrievalV1,
  ContextBriefPlanV1,
  ContextBriefRequestV1,
} from './types.js';

export interface ContextBriefCompilerDependencies<R = never> {
  readonly graphEvidence: (plan: ContextBriefPlanV1['graph']) => Effect.Effect<ContextBriefGraphEvidenceV1, unknown, R>;
  readonly memoryEvidence: (
    plan: ContextBriefPlanV1['memory'],
  ) => Effect.Effect<ContextBriefMemoryRetrievalV1, unknown, R>;
}

/** Deterministic compiler core with injected read boundaries for focused tests and alternate clients. */
export const compileContextBriefWith = Effect.fn('contextBrief.compileWith')(function* <R>(
  dependencies: ContextBriefCompilerDependencies<R>,
  input: ContextBriefRequestV1 | unknown,
) {
  const plan = planContextBrief(input);
  const [graph, memory] = yield* Effect.all(
    [dependencies.graphEvidence(plan.graph), dependencies.memoryEvidence(plan.memory)],
    {concurrency: 2},
  );
  const logical = assembleContextBriefLogicalResult({graph, memory, plan});
  return projectContextBrief(logical, plan.outputBudgetTokens);
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
  return yield* compileContextBriefWith(
    {
      graphEvidence: graphPlan =>
        retrieveContextBriefGraphEvidence(config, graphPlan).pipe(
          Effect.catch(() =>
            Effect.succeed(unavailableContextBriefGraphEvidence('graph-query-unavailable', requestedRepositories)),
          ),
        ),
      memoryEvidence: memoryPlan =>
        retrieveContextBriefMemoryEvidence(config, memoryPlan).pipe(
          Effect.catch(() => Effect.succeed(unavailableContextBriefMemoryEvidence())),
        ),
    },
    {
      budgetTokens: request.outputBudgetTokens,
      mode: request.mode,
      scope: request.scope,
      task: request.task,
    },
  );
});

export * from './graph_evidence.js';
export * from './memory_evidence.js';
export * from './planner.js';
export * from './projector.js';
export * from './types.js';
