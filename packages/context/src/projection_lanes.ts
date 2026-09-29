export const CONTEXT_BRIEF_PROJECTION_LANES = [
  'coverage-gap',
  'handoff',
  'durable-decision',
  'graph-card',
  'graph-contract',
  'source-excerpt',
  'issue',
  'follow-up',
  'verified-procedure',
] as const;

export type ContextBriefProjectionLane = (typeof CONTEXT_BRIEF_PROJECTION_LANES)[number];

export function contextBriefProjectionLanePriority(lane: ContextBriefProjectionLane): number {
  return CONTEXT_BRIEF_PROJECTION_LANES.indexOf(lane);
}
