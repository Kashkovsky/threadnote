import type {RecallOptions} from '../types.js';
import {
  parseRecallMemoryConnectionInput,
  type ParsedRecallMemoryConnectionInput,
  type RecallMemoryConnectionsResult,
} from './memory_connections.js';

export function parseRecallCliMemoryConnectionInput(
  options: Pick<RecallOptions, 'memoryRefs' | 'relationTypes'>,
): ParsedRecallMemoryConnectionInput | undefined {
  if ((options.relationTypes?.length ?? 0) > 0 && (options.memoryRefs?.length ?? 0) === 0) {
    throw new Error('--relation-type requires at least one --memory-ref.');
  }
  return (options.memoryRefs?.length ?? 0) > 0
    ? parseRecallMemoryConnectionInput({
        memoryRefs: options.memoryRefs ?? [],
        relationTypes: options.relationTypes,
      })
    : undefined;
}

export function renderRecallMemoryConnections(result: RecallMemoryConnectionsResult): string {
  const premiseLines = result.premises.map(
    premise => `- premise ${premise.requestedOrdinal + 1}: ${premise.uri ?? premise.requestedRef} [${premise.state}]`,
  );
  const connectionLines = result.connections.map(connection => {
    const pointer = connection.neighborUri ?? 'unresolved target';
    return `- ${connection.direction} ${connection.relationType}: ${pointer} [${connection.currentness}; ${connection.resolution}]`;
  });
  return [
    `Memory connections (one hop; ${result.coverage.resultCount} result(s)${result.coverage.truncated ? ', truncated' : ''}):`,
    ...premiseLines,
    ...connectionLines,
    'Relations are navigation evidence, not entailment.',
  ].join('\n');
}
