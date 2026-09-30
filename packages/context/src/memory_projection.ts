import {isMemoryId} from '@threadnote/memory/identity-alias';
import type {ContextBriefLogicalResultV1, ContextBriefMemoryEvidenceV1, ContextBriefResponseFormat} from './types.js';

const STABLE_MEMORY_IDENTITY_UNAVAILABLE_GAP = 'stable-memory-identity-unavailable';

export function contextBriefRelationshipMemoryByUri(
  logical: ContextBriefLogicalResultV1,
  uri: string,
): ContextBriefMemoryEvidenceV1 | undefined {
  return [...logical.activeHandoffs, ...logical.durableDecisions].find(memory => memory.uri === uri);
}

export function requiredContextBriefAgentMemoryItem<T extends {readonly id: string; readonly lane: string}>(
  logical: ContextBriefLogicalResultV1,
  items: readonly T[],
  responseFormat: ContextBriefResponseFormat,
): T | undefined {
  if (logical.mode === 'resume') {
    return items.find(
      item =>
        (item.lane === 'handoff' || item.lane === 'durable-decision') &&
        contextBriefRelationshipMemoryByUri(logical, item.id)?.continuationCard !== undefined,
    );
  }
  if (responseFormat !== 'agent' || logical.mode !== 'explain' || logical.coverage.memory.codeAnchors !== undefined) {
    return undefined;
  }
  return items.find(item => item.lane === 'handoff' || item.lane === 'durable-decision');
}

export function withStableContextBriefMemoryIdentityGap(
  logical: ContextBriefLogicalResultV1,
): ContextBriefLogicalResultV1 {
  if (logical.coverage.memory.codeAnchors === undefined) return logical;
  if (logical.mode !== 'trace' && logical.mode !== 'impact') return logical;
  const primary = [...logical.activeHandoffs, ...logical.durableDecisions].find(
    memory => memory.selectionBasis === 'code-citation',
  );
  if (primary === undefined || (primary.memoryId !== undefined && isMemoryId(primary.memoryId))) return logical;
  return {
    ...logical,
    coverage: {
      ...logical.coverage,
      gaps: [
        STABLE_MEMORY_IDENTITY_UNAVAILABLE_GAP,
        ...logical.coverage.gaps.filter(gap => gap !== STABLE_MEMORY_IDENTITY_UNAVAILABLE_GAP),
      ],
    },
  };
}
