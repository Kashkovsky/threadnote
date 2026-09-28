import {DateTime, Effect} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import type {VerifiedProcedureSelection} from './procedure/selection.js';
import {unavailableContextBriefCodeLinkedMemoryEvidence, mergeContextBriefMemoryEvidence} from './memory-evidence.js';
import {assembleContextBriefLogicalResult, planContextBrief} from './planner.js';
import {projectContextBrief} from './projector.js';
import type {
  ContextBriefGraphEvidenceV1,
  ContextBriefCitationValidationFenceV2,
  ContextBriefMemoryRetrievalV1,
  ContextBriefLogicalResultV1,
  ContextBriefPlanV1,
  ContextBriefRequestV1,
  ContextBriefResponseFormat,
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
  readonly procedureEvidence?: (
    plan: ContextBriefPlanV1,
  ) => Effect.Effect<VerifiedProcedureSelection, unknown, MemoryR>;
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
    responseFormat: ContextBriefResponseFormat,
  ) => Effect.Effect<ProjectedContextBriefV1, unknown, ProjectR>;
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
  const observedAt = DateTime.formatIso(yield* DateTime.now);
  const codeLinkedMemory =
    plan.codeAnchors.codeRefs.length === 0
      ? succeedUndefined
      : dependencies.codeLinkedMemoryEvidence === undefined
        ? Effect.succeed(unavailableContextBriefCodeLinkedMemoryEvidence(plan.codeAnchors.codeRefs.length))
        : dependencies.codeLinkedMemoryEvidence(plan.codeAnchors);
  const [graph, lexicalMemory, linkedMemory, procedureEvidence] = yield* Effect.all(
    [
      dependencies.graphEvidence(plan.graph),
      dependencies.memoryEvidence(plan.memory),
      codeLinkedMemory,
      dependencies.procedureEvidence?.(plan) ?? Effect.succeed({gaps: [], procedures: []}),
    ],
    {concurrency: 4},
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
    verifiedProcedureGaps: procedureEvidence.gaps,
    verifiedProcedures: procedureEvidence.procedures,
  });
  return yield* dependencies.projection
    ? dependencies.projection(logical, plan.outputBudgetTokens, plan.responseFormat)
    : Effect.sync(() => projectContextBrief(logical, plan.outputBudgetTokens, plan.responseFormat));
});
