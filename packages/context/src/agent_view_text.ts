import {Predicate} from 'effect';
import {isContextBriefExactCurrentContinuation} from './memory_projection.js';
import {compactContinuationCard, projectContextBriefAgentView} from './projection_view.js';
import {
  CONTEXT_BRIEF_VERSION,
  type ContextBriefAgentViewV1,
  type ContextBriefEvidenceState,
  type ContextBriefV1,
} from './types.js';

export function renderContextBriefText(brief: ContextBriefV1): string {
  const view = projectContextBriefAgentView(brief, false);
  const exactResume =
    brief.mode === 'resume' &&
    brief.activeHandoffs.length === 1 &&
    brief.stalenessAndConflicts.length === 0 &&
    brief.activeHandoffs.some(isContextBriefExactCurrentContinuation);
  const compactMemories = (memories: ContextBriefAgentViewV1['durableDecisions']) =>
    memories?.map(memory => {
      const compact =
        memory.freshnessBasis !== 'source-commit' && memory.selectionBasis !== 'code-citation'
          ? memory
          : (({freshnessBasis: _freshnessBasis, ...value}) => value)(memory);
      return !exactResume || compact.continuationCard === undefined
        ? compact
        : {...compact, continuationCard: compactContinuationCard(compact.continuationCard)};
    });
  const legacyFollowUps = view.recommendedFollowUps?.map(({arguments: action, tool: _tool, ...followUp}) => ({
    ...followUp,
    ...('callerCwd' in action ? {callerCwd: action.callerCwd} : {}),
  }));
  const compactScope =
    view.scope.readyRepositories === view.scope.requestedRepositories
      ? (({requestedRepositories: _requestedRepositories, ...scope}) => scope)(view.scope)
      : view.scope;
  const legacy = {
    ...view,
    ...(view.activeHandoffs === undefined ? {} : {activeHandoffs: compactMemories(view.activeHandoffs)}),
    ...(view.durableDecisions === undefined ? {} : {durableDecisions: compactMemories(view.durableDecisions)}),
    scope: compactScope,
    ...(legacyFollowUps === undefined ? {} : {recommendedFollowUps: legacyFollowUps}),
  };
  // The structured channel already carries the exact omission receipt. V3
  // code-anchor coverage is an unambiguous version witness; every other shape
  // retains the explicit brief version because optional coverage cannot infer it.
  const {evidenceState: _evidenceState, output: _output, ...withoutDerivedState} = legacy;
  const versioned =
    withoutDerivedState.briefVersion === CONTEXT_BRIEF_VERSION &&
    withoutDerivedState.coverage?.codeAnchors !== undefined
      ? (({briefVersion: _briefVersion, ...value}) => value)(withoutDerivedState)
      : withoutDerivedState;
  const compactLegacy = legacy.mode === 'brief' ? (({mode: _mode, ...value}) => value)(versioned) : versioned;
  if (legacyEvidenceState(compactLegacy) !== brief.evidenceState) {
    return JSON.stringify({...compactLegacy, evidenceState: brief.evidenceState});
  }
  return JSON.stringify(compactLegacy);
}

export function legacyEvidenceState(value: Record<string, unknown>): ContextBriefEvidenceState {
  if (
    value.evidenceState === 'sufficient' ||
    value.evidenceState === 'partial' ||
    value.evidenceState === 'degraded' ||
    value.evidenceState === 'no-match'
  )
    return value.evidenceState;
  const scope = Predicate.isObject(value.scope) ? value.scope : undefined;
  if (scope?.freshness === 'stale' || scope?.freshness === 'unknown') return 'degraded';
  const graph = Predicate.isObject(value.graph) ? value.graph : undefined;
  const cards = Array.isArray(graph?.cards) ? graph.cards : [];
  const handoffs = Array.isArray(value.activeHandoffs) ? value.activeHandoffs : [];
  const decisions = Array.isArray(value.durableDecisions) ? value.durableDecisions : [];
  if (cards.length === 0 && handoffs.length === 0 && decisions.length === 0) return 'no-match';
  const coverage = Predicate.isObject(value.coverage) ? value.coverage : undefined;
  return Array.isArray(coverage?.gaps) && coverage.gaps.length > 0 ? 'partial' : 'sufficient';
}
