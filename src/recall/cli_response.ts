import type {RecallOptions} from '../types.js';
import type {RecallConfidence} from './rank.js';
import {
  EXPLICIT_MEMORY_CONNECTION_CONFIDENCE_BASIS,
  explicitMemoryConnectionNavigationConfidence,
} from './connection_confidence.js';
import {
  parseRecallMemoryConnectionInput,
  type ParsedRecallMemoryConnectionInput,
  type RecallMemoryConnectionsResult,
} from './memory_connections.js';

export interface ParsedRecallCliInput {
  readonly memoryConnections: ParsedRecallMemoryConnectionInput | undefined;
  readonly query: string;
}

export interface RecallCliProjection {
  readonly confidence: RecallConfidence | undefined;
  readonly rankedContext: string;
  readonly sections: readonly string[];
}

export function parseRecallCliInput(
  options: Pick<RecallOptions, 'memoryRefs' | 'query' | 'relationTypes'>,
): ParsedRecallCliInput {
  const memoryConnections = parseRecallCliMemoryConnectionInput(options);
  const query = options.query?.trim() ?? '';
  if (query.length === 0 && memoryConnections === undefined) {
    throw new Error(
      [
        'Threadnote recall needs either a non-empty --query or at least one --memory-ref seed.',
        'Examples: threadnote recall --query "latest handoff" or threadnote recall --memory-ref tn_example.',
      ].join('\n'),
    );
  }
  return {memoryConnections, query};
}

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

export function explicitMemoryConnectionConfidence(
  result: RecallMemoryConnectionsResult | undefined,
): RecallConfidence | undefined {
  return result?.connections.some(connection => connection.resolution === 'resolved' && connection.neighborUri)
    ? explicitMemoryConnectionNavigationConfidence()
    : undefined;
}

export function renderSeedOnlyRecallNavigation(result: RecallMemoryConnectionsResult): string {
  const firstNeighbor = result.connections.find(
    connection => connection.resolution === 'resolved' && connection.neighborUri !== undefined,
  )?.neighborUri;
  const confidence = explicitMemoryConnectionNavigationConfidence();
  return [
    ...(firstNeighbor
      ? [
          `Recall confidence: ${confidence.level} (${confidence.score.toFixed(2)}; ${EXPLICIT_MEMORY_CONNECTION_CONFIDENCE_BASIS}) — ${confidence.reason}`,
        ]
      : []),
    renderRecallMemoryConnections(result),
    ...(firstNeighbor ? [`Next: threadnote read ${firstNeighbor}`] : []),
  ].join('\n');
}

export function projectRecallCliResponse(
  input: {
    readonly confidence?: RecallConfidence;
    readonly exactTail?: string;
    readonly memoryConnections?: RecallMemoryConnectionsResult;
    readonly semanticSection?: string;
  },
  navigationOnly: boolean,
): RecallCliProjection {
  const rankedContext = navigationOnly ? '' : (input.semanticSection ?? '');
  const sections = navigationOnly
    ? input.memoryConnections
      ? [renderSeedOnlyRecallNavigation(input.memoryConnections)]
      : []
    : [
        input.semanticSection,
        input.exactTail,
        input.memoryConnections ? renderRecallMemoryConnections(input.memoryConnections) : undefined,
      ].filter((section): section is string => section !== undefined);
  return {
    confidence:
      (navigationOnly ? explicitMemoryConnectionConfidence(input.memoryConnections) : undefined) ?? input.confidence,
    rankedContext,
    sections,
  };
}
