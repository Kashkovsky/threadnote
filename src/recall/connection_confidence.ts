import type {RecallConfidence} from './rank.js';

export const EXPLICIT_MEMORY_CONNECTION_CONFIDENCE_BASIS = 'explicit-memory-connection' as const;

export function explicitMemoryConnectionNavigationConfidence(): RecallConfidence {
  return {
    level: 'high',
    margin: 1,
    reason: 'Verified one-hop relation; confidence covers navigation only, not entailment.',
    score: 1,
  };
}
