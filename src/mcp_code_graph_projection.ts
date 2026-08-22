import {
  AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN,
  AgentResponseBudgetTooSmallError,
  encodedJsonBytes,
  measureAgentToolResponse,
} from './evaluation/agent-response.js';
import {renderCodeGraphResult} from './code_graph/query.js';
import type {CodeGraphQueryResult} from './code_graph/types.js';

const MCP_CODE_GRAPH_STRUCTURED_CONTENT_BYTES = 24 * 1_024;
const MCP_CODE_GRAPH_STRUCTURED_CONTENT_RESERVE_BYTES = 768;
const MCP_CODE_GRAPH_MAXIMUM_ESTIMATED_TOKENS = 1_500;

function compactMcpText(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function compactCodeGraphNode(node: CodeGraphQueryResult['nodes'][number]) {
  return {
    ...(node.arity === undefined ? {} : {arity: node.arity}),
    exported: node.exported,
    id: node.id,
    kind: node.kind,
    language: compactMcpText(node.language, 80),
    name: compactMcpText(node.name, 160),
    ...(node.packageName === undefined ? {} : {packageName: compactMcpText(node.packageName, 160)}),
    path: compactMcpText(node.path, 400),
    qualifiedName: compactMcpText(node.qualifiedName, 320),
    score: node.score,
    ...(node.signature === undefined ? {} : {signature: compactMcpText(node.signature, 300)}),
    span: node.span,
  };
}

function compactCodeGraphEdge(edge: CodeGraphQueryResult['edges'][number]) {
  return {
    confidence: edge.confidence,
    evidencePath: compactMcpText(edge.evidencePath, 400),
    evidenceSpan: edge.evidenceSpan,
    id: edge.id,
    provenance: edge.provenance,
    relation: edge.relation,
    ...(edge.sourceId === undefined ? {} : {sourceId: edge.sourceId}),
    sourceName: compactMcpText(edge.sourceName, 160),
    ...(edge.targetId === undefined ? {} : {targetId: edge.targetId}),
    targetName: compactMcpText(edge.targetName, 160),
  };
}

function projectCodeGraphMcpResult(
  result: CodeGraphQueryResult,
  nodeCount: number,
  edgeCount: number,
  warningCount: number,
  conciseTruncationWarning: boolean,
) {
  const warningsPrefix = result.warnings.slice(0, warningCount).map(warning => compactMcpText(warning, 320));
  const nodes = result.nodes.slice(0, nodeCount).map(compactCodeGraphNode);
  const edges = result.edges.slice(0, edgeCount).map(compactCodeGraphEdge);
  const truncated =
    nodes.length < result.nodes.length ||
    edges.length < result.edges.length ||
    warningsPrefix.length < result.warnings.length;
  return {
    freshness: result.freshness,
    operation: result.operation,
    repository: {
      displayName: compactMcpText(result.repository.displayName, 320),
      repositoryId: result.repository.repositoryId,
    },
    snapshot: result.snapshot,
    ...(result.scope ? {scope: result.scope} : {}),
    sourceVersion: result.version,
    trust: result.trust,
    type: 'code-graph-inspection' as const,
    version: 1 as const,
    edges,
    nodes,
    output: {
      returnedEdges: edges.length,
      returnedNodes: nodes.length,
      totalEdges: result.edges.length,
      totalNodes: result.nodes.length,
      truncated,
    },
    warnings: truncated
      ? [
          ...warningsPrefix,
          conciseTruncationWarning
            ? 'Budget truncated.'
            : `MCP output was bounded to ${nodes.length}/${result.nodes.length} nodes and ${edges.length}/${result.edges.length} relationships; refine the query or follow a stable cgs_ ID.`,
        ]
      : warningsPrefix,
  };
}

function responseForPrefix(
  result: CodeGraphQueryResult,
  nodeCount: number,
  edgeCount: number,
  warningCount: number,
  conciseTruncationWarning: boolean,
) {
  const structuredContent = projectCodeGraphMcpResult(
    result,
    nodeCount,
    edgeCount,
    warningCount,
    conciseTruncationWarning,
  );
  const rendered: CodeGraphQueryResult = {
    ...result,
    edges: result.edges
      .slice(0, structuredContent.edges.length)
      .map((edge, index) => ({...edge, ...structuredContent.edges[index]})),
    nodes: result.nodes
      .slice(0, structuredContent.nodes.length)
      .map((node, index) => ({...node, ...structuredContent.nodes[index]})),
    repository: structuredContent.repository,
    warnings: structuredContent.warnings,
  };
  return {structuredContent, text: renderCodeGraphResult(rendered, 'mcp')};
}

function longestAdmittedPrefix(
  result: CodeGraphQueryResult,
  admits: (response: ReturnType<typeof responseForPrefix>) => boolean,
  conciseTruncationWarning = false,
) {
  let nodeCount = 0;
  let edgeCount = 0;
  let warningCount = 0;
  let nodesBlocked = false;
  let edgesBlocked = false;
  let warningsBlocked = false;
  let selected = responseForPrefix(result, nodeCount, edgeCount, warningCount, conciseTruncationWarning);
  while (
    (!nodesBlocked && nodeCount < result.nodes.length) ||
    (!edgesBlocked && edgeCount < result.edges.length) ||
    (!warningsBlocked && warningCount < Math.min(5, result.warnings.length))
  ) {
    if (!warningsBlocked && warningCount < Math.min(5, result.warnings.length)) {
      const candidate = responseForPrefix(result, nodeCount, edgeCount, warningCount + 1, conciseTruncationWarning);
      if (admits(candidate)) {
        warningCount += 1;
        selected = candidate;
      } else warningsBlocked = true;
    }
    if (!nodesBlocked && nodeCount < result.nodes.length) {
      const candidate = responseForPrefix(result, nodeCount + 1, edgeCount, warningCount, conciseTruncationWarning);
      if (admits(candidate)) {
        nodeCount += 1;
        selected = candidate;
      } else nodesBlocked = true;
    }
    if (!edgesBlocked && edgeCount < result.edges.length) {
      const candidate = responseForPrefix(result, nodeCount, edgeCount + 1, warningCount, conciseTruncationWarning);
      if (admits(candidate)) {
        edgeCount += 1;
        selected = candidate;
      } else edgesBlocked = true;
    }
  }
  return selected;
}

function defaultCodeGraphMcpResponse(result: CodeGraphQueryResult) {
  const maximumBytes = MCP_CODE_GRAPH_STRUCTURED_CONTENT_BYTES - MCP_CODE_GRAPH_STRUCTURED_CONTENT_RESERVE_BYTES;
  return longestAdmittedPrefix(result, response => encodedJsonBytes(response.structuredContent) <= maximumBytes);
}

/**
 * MCP consumers need stable IDs and source evidence, not parser/index internals.
 * Keep the richer graph result available to the CLI and Manager while enforcing
 * a deterministic context budget for agent tool calls.
 */
export function compactCodeGraphMcpResult(result: CodeGraphQueryResult) {
  return defaultCodeGraphMcpResponse(result).structuredContent;
}

export function codeGraphMcpResponse(result: CodeGraphQueryResult, maximumEstimatedTokens?: number) {
  if (maximumEstimatedTokens === undefined) return defaultCodeGraphMcpResponse(result);
  if (
    !Number.isSafeInteger(maximumEstimatedTokens) ||
    maximumEstimatedTokens < 1 ||
    maximumEstimatedTokens > MCP_CODE_GRAPH_MAXIMUM_ESTIMATED_TOKENS
  ) {
    throw new Error(
      `Code graph response token budget must be an integer from 1 to ${MCP_CODE_GRAPH_MAXIMUM_ESTIMATED_TOKENS}.`,
    );
  }
  const maximumBytes = maximumEstimatedTokens * AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN;
  const minimum = responseForPrefix(result, 0, 0, 0, true);
  const minimumBytes = measureAgentToolResponse(minimum).totalBytes;
  if (minimumBytes > maximumBytes) throw new AgentResponseBudgetTooSmallError(maximumBytes, minimumBytes);
  return longestAdmittedPrefix(result, response => measureAgentToolResponse(response).totalBytes <= maximumBytes, true);
}
