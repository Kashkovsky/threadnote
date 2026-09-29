import {isMemoryId} from '@threadnote/memory/identity-alias';
import type {ContextBriefLogicalResultV1, ContextBriefMemoryEvidenceV1} from './types.js';

const STABLE_MEMORY_IDENTITY_UNAVAILABLE_GAP = 'stable-memory-identity-unavailable';

export function contextBriefRelationshipMemoryByUri(
  logical: ContextBriefLogicalResultV1,
  uri: string,
): ContextBriefMemoryEvidenceV1 | undefined {
  return [...logical.activeHandoffs, ...logical.durableDecisions].find(memory => memory.uri === uri);
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
