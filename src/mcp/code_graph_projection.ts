import {
  AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN,
  encodedJsonBytes,
  measureAgentToolResponse,
} from '../evaluation/agent-response.js';
import {renderCodeGraphResult} from '../code_graph/query.js';
import type {CodeGraphProjectCoverage, CodeGraphQueryResult} from '../code_graph/types.js';
import type {CodeGraphRefreshContinuity} from '../code_graph/watcher.js';

const MCP_CODE_GRAPH_STRUCTURED_CONTENT_BYTES = 24 * 1_024;
const MCP_CODE_GRAPH_STRUCTURED_CONTENT_RESERVE_BYTES = 768;
/** Fixed receipt floor for every public graph channel (dual, text, agent). */
export const MCP_CODE_GRAPH_MINIMUM_ESTIMATED_TOKENS = 800;
const MCP_CODE_GRAPH_MAXIMUM_ESTIMATED_TOKENS = 1_500;

export type CodeGraphMcpResponseFormat = 'dual' | 'text' | 'agent';

const textEncoder = new TextEncoder();

function compactMcpText(value: string, maximumBytes: number): string {
  if (textEncoder.encode(value).byteLength <= maximumBytes) return value;
  const suffix = '…';
  const prefixBytes = maximumBytes - textEncoder.encode(suffix).byteLength;
  if (prefixBytes <= 0) return suffix;
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = textEncoder.encode(character).byteLength;
    if (bytes + characterBytes > prefixBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return `${value.slice(0, end)}${suffix}`;
}

type MandatoryMetadataProfile = 'minimum' | 'normal';

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

function compactProjectCoverage(coverage: CodeGraphProjectCoverage, profile: MandatoryMetadataProfile) {
  const rootLimit = profile === 'minimum' ? 1 : 2;
  const textLimit = profile === 'minimum' ? 32 : 64;
  const configuredRoots = coverage.configuredRoots.slice(0, rootLimit).map(root => compactMcpText(root, textLimit));
  return {
    ...coverage,
    ...(coverage.snapshotSourceCommit === undefined
      ? {}
      : {snapshotSourceCommit: compactMcpText(coverage.snapshotSourceCommit, textLimit)}),
    configuredRoots,
    observedWorktreeCommit: compactMcpText(coverage.observedWorktreeCommit, 64),
    project: compactMcpText(coverage.project, 64),
    ...(configuredRoots.length === coverage.configuredRoots.length
      ? {}
      : {configuredRootsOmitted: coverage.configuredRoots.length - configuredRoots.length}),
  };
}

function compactOutsideProjectGraph(
  outside: NonNullable<CodeGraphQueryResult['outsideProjectGraph']>,
  profile: MandatoryMetadataProfile,
) {
  const pathLimit = profile === 'minimum' ? 1 : 2;
  const actionLimit = profile === 'minimum' ? 0 : 1;
  const paths = outside.paths.slice(0, pathLimit).map(path => compactMcpText(path, profile === 'minimum' ? 48 : 96));
  const suggestedActions = outside.suggestedActions.slice(0, actionLimit).map(action => compactMcpText(action, 96));
  return {
    ...outside,
    paths,
    suggestedActions,
    ...(paths.length === outside.paths.length ? {} : {pathsOmitted: outside.paths.length - paths.length}),
    ...(suggestedActions.length === outside.suggestedActions.length
      ? {}
      : {suggestedActionsOmitted: outside.suggestedActions.length - suggestedActions.length}),
  };
}

function compactMandatoryMetadata(result: CodeGraphQueryResult, profile: MandatoryMetadataProfile) {
  const textLimit = profile === 'minimum' ? 32 : 96;
  const snapshotLimit = profile === 'minimum' ? 32 : 64;
  return {
    compacted: profile === 'minimum',
    repository: {
      displayName: compactMcpText(result.repository.displayName, textLimit),
      repositoryId: compactMcpText(result.repository.repositoryId, textLimit),
    },
    snapshot: {
      commit: compactMcpText(result.snapshot.commit, snapshotLimit),
      dirty: result.snapshot.dirty,
      id: compactMcpText(result.snapshot.id, snapshotLimit),
      worktreeId: compactMcpText(result.snapshot.worktreeId, snapshotLimit),
    },
    ...(result.projectCoverage === undefined
      ? {}
      : {projectCoverage: compactProjectCoverage(result.projectCoverage, profile)}),
    ...(result.outsideProjectGraph === undefined
      ? {}
      : {outsideProjectGraph: compactOutsideProjectGraph(result.outsideProjectGraph, profile)}),
    ...(result.scope === undefined
      ? {}
      : {
          scope: {
            ...result.scope,
            packageName: compactMcpText(result.scope.packageName, textLimit),
          },
        }),
    ...(result.source === undefined
      ? {}
      : {
          source: {
            ...result.source,
            frontierCommit: compactMcpText(result.source.frontierCommit, snapshotLimit),
            localCommit: compactMcpText(result.source.localCommit, snapshotLimit),
            profileDigest: compactMcpText(result.source.profileDigest, textLimit),
          },
        }),
  };
}

function projectCodeGraphMcpResult(
  result: CodeGraphQueryResult,
  nodeCount: number,
  edgeCount: number,
  warningCount: number,
  conciseTruncationWarning: boolean,
  refresh?: CodeGraphRefreshContinuity,
  metadataProfile: MandatoryMetadataProfile = 'normal',
) {
  const metadata = compactMandatoryMetadata(result, metadataProfile);
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
    repository: metadata.repository,
    snapshot: metadata.snapshot,
    ...(metadata.projectCoverage === undefined ? {} : {projectCoverage: metadata.projectCoverage}),
    ...(metadata.outsideProjectGraph === undefined ? {} : {outsideProjectGraph: metadata.outsideProjectGraph}),
    ...(result.outsideScopeChangedPaths === undefined
      ? {}
      : {outsideScopeChangedPaths: result.outsideScopeChangedPaths}),
    ...(metadata.scope === undefined ? {} : {scope: metadata.scope}),
    ...(result.searchCoverage ? {searchCoverage: result.searchCoverage} : {}),
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
      ...(metadata.compacted ? {metadataTruncated: true as const} : {}),
    },
    ...(metadata.source === undefined ? {} : {source: metadata.source}),
    ...(refresh === undefined ? {} : {refresh}),
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
  refresh?: CodeGraphRefreshContinuity,
  metadataProfile: MandatoryMetadataProfile = 'normal',
) {
  const structuredContent = projectCodeGraphMcpResult(
    result,
    nodeCount,
    edgeCount,
    warningCount,
    conciseTruncationWarning,
    refresh,
    metadataProfile,
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
    snapshot: structuredContent.snapshot,
    ...(structuredContent.projectCoverage === undefined ? {} : {projectCoverage: structuredContent.projectCoverage}),
    ...(structuredContent.outsideProjectGraph === undefined
      ? {}
      : {outsideProjectGraph: structuredContent.outsideProjectGraph}),
    ...(structuredContent.outsideScopeChangedPaths === undefined
      ? {}
      : {outsideScopeChangedPaths: structuredContent.outsideScopeChangedPaths}),
    ...(structuredContent.scope === undefined ? {} : {scope: structuredContent.scope}),
    ...(structuredContent.source === undefined ? {} : {source: structuredContent.source}),
    warnings: structuredContent.warnings,
  };
  return {structuredContent, text: renderCodeGraphResult(rendered, 'mcp')};
}

function longestAdmittedPrefix(
  result: CodeGraphQueryResult,
  admits: (response: ReturnType<typeof responseForPrefix>) => boolean,
  conciseTruncationWarning = false,
  refresh?: CodeGraphRefreshContinuity,
  metadataProfile: MandatoryMetadataProfile = 'normal',
) {
  let nodeCount = 0;
  let edgeCount = 0;
  let warningCount = 0;
  let nodesBlocked = false;
  let edgesBlocked = false;
  let warningsBlocked = false;
  let selected = responseForPrefix(
    result,
    nodeCount,
    edgeCount,
    warningCount,
    conciseTruncationWarning,
    refresh,
    metadataProfile,
  );
  while (
    (!nodesBlocked && nodeCount < result.nodes.length) ||
    (!edgesBlocked && edgeCount < result.edges.length) ||
    (!warningsBlocked && warningCount < Math.min(5, result.warnings.length))
  ) {
    if (!warningsBlocked && warningCount < Math.min(5, result.warnings.length)) {
      const candidate = responseForPrefix(
        result,
        nodeCount,
        edgeCount,
        warningCount + 1,
        conciseTruncationWarning,
        refresh,
        metadataProfile,
      );
      if (admits(candidate)) {
        warningCount += 1;
        selected = candidate;
      } else warningsBlocked = true;
    }
    if (!nodesBlocked && nodeCount < result.nodes.length) {
      const candidate = responseForPrefix(
        result,
        nodeCount + 1,
        edgeCount,
        warningCount,
        conciseTruncationWarning,
        refresh,
        metadataProfile,
      );
      if (admits(candidate)) {
        nodeCount += 1;
        selected = candidate;
      } else nodesBlocked = true;
    }
    if (!edgesBlocked && edgeCount < result.edges.length) {
      const candidate = responseForPrefix(
        result,
        nodeCount,
        edgeCount + 1,
        warningCount,
        conciseTruncationWarning,
        refresh,
        metadataProfile,
      );
      if (admits(candidate)) {
        edgeCount += 1;
        selected = candidate;
      } else edgesBlocked = true;
    }
  }
  return selected;
}

function defaultCodeGraphMcpResponse(result: CodeGraphQueryResult, refresh?: CodeGraphRefreshContinuity) {
  const maximumBytes = MCP_CODE_GRAPH_STRUCTURED_CONTENT_BYTES - MCP_CODE_GRAPH_STRUCTURED_CONTENT_RESERVE_BYTES;
  return longestAdmittedPrefix(
    result,
    response => encodedJsonBytes(response.structuredContent) <= maximumBytes,
    false,
    refresh,
  );
}

/**
 * Last-resort receipt for a valid public budget. It intentionally contains no
 * optional metadata bodies: their bounded omission counts retain recovery
 * semantics without allowing adversarial identifiers to consume the envelope.
 */
function fixedCodeGraphMcpReceipt(result: CodeGraphQueryResult, refresh?: CodeGraphRefreshContinuity) {
  const metadataOmissions = {
    ...(result.projectCoverage === undefined
      ? {}
      : {projectCoverage: {configuredRoots: result.projectCoverage.configuredRoots.length}}),
    ...(result.outsideProjectGraph === undefined
      ? {}
      : {
          outsideProjectGraph: {
            paths: result.outsideProjectGraph.paths.length,
            suggestedActions: result.outsideProjectGraph.suggestedActions.length,
          },
        }),
    ...(result.outsideScopeChangedPaths === undefined ? {} : {outsideScopeChangedPaths: true}),
    ...(result.scope === undefined ? {} : {scope: true}),
    ...(result.searchCoverage === undefined ? {} : {searchCoverage: true}),
    ...(result.source === undefined ? {} : {source: true}),
    ...(refresh === undefined ? {} : {refresh: true}),
  };
  const structuredContent = {
    freshness: result.freshness,
    operation: result.operation,
    repository: {
      displayName: compactMcpText(result.repository.displayName, 8),
      repositoryId: compactMcpText(result.repository.repositoryId, 8),
    },
    snapshot: {
      commit: compactMcpText(result.snapshot.commit, 8),
      dirty: result.snapshot.dirty,
      id: compactMcpText(result.snapshot.id, 8),
      worktreeId: compactMcpText(result.snapshot.worktreeId, 8),
    },
    sourceVersion: result.version,
    trust: result.trust,
    type: 'code-graph-inspection' as const,
    version: 1 as const,
    edges: [],
    nodes: [],
    output: {
      returnedEdges: 0,
      returnedNodes: 0,
      totalEdges: result.edges.length,
      totalNodes: result.nodes.length,
      truncated: true as const,
      metadataOmissions,
      metadataTruncated: true as const,
    },
    ...(refresh === undefined
      ? {}
      : {
          refresh: {
            ...(refresh.retryAfterMilliseconds === undefined
              ? {}
              : {retryAfterMilliseconds: refresh.retryAfterMilliseconds}),
            state: refresh.state,
            type: refresh.type,
            version: refresh.version,
          },
        }),
    warnings: ['Budget truncated.'],
  };
  return {structuredContent, text: JSON.stringify(structuredContent)};
}

/**
 * MCP consumers need stable IDs and source evidence, not parser/index internals.
 * Keep the richer graph result available to the CLI and Manager while enforcing
 * a deterministic context budget for agent tool calls.
 */
export function compactCodeGraphMcpResult(result: CodeGraphQueryResult, refresh?: CodeGraphRefreshContinuity) {
  return defaultCodeGraphMcpResponse(result, refresh).structuredContent;
}

export function codeGraphMcpResponse(
  result: CodeGraphQueryResult,
  maximumEstimatedTokens?: number,
  refresh?: CodeGraphRefreshContinuity,
  responseFormat: CodeGraphMcpResponseFormat = 'dual',
) {
  if (maximumEstimatedTokens === undefined) return defaultCodeGraphMcpResponse(result, refresh);
  if (
    !Number.isSafeInteger(maximumEstimatedTokens) ||
    maximumEstimatedTokens < MCP_CODE_GRAPH_MINIMUM_ESTIMATED_TOKENS ||
    maximumEstimatedTokens > MCP_CODE_GRAPH_MAXIMUM_ESTIMATED_TOKENS
  ) {
    throw new Error(
      `Code graph response token budget must be an integer from ${MCP_CODE_GRAPH_MINIMUM_ESTIMATED_TOKENS} to ${MCP_CODE_GRAPH_MAXIMUM_ESTIMATED_TOKENS}.`,
    );
  }
  const maximumBytes = maximumEstimatedTokens * AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN;
  const minimum = responseForPrefix(result, 0, 0, 0, true, refresh);
  const minimumBytes = measureFormattedCodeGraphMcpResponse(minimum, responseFormat).totalBytes;
  if (minimumBytes <= maximumBytes) {
    return longestAdmittedPrefix(
      result,
      response => measureFormattedCodeGraphMcpResponse(response, responseFormat).totalBytes <= maximumBytes,
      true,
      refresh,
    );
  }
  const compactMinimum = responseForPrefix(result, 0, 0, 0, true, refresh, 'minimum');
  const compactMinimumBytes = measureFormattedCodeGraphMcpResponse(compactMinimum, responseFormat).totalBytes;
  if (compactMinimumBytes > maximumBytes) return fixedCodeGraphMcpReceipt(result, refresh);
  return longestAdmittedPrefix(
    result,
    response => measureFormattedCodeGraphMcpResponse(response, responseFormat).totalBytes <= maximumBytes,
    true,
    refresh,
    'minimum',
  );
}

export function formatCodeGraphMcpResponse<T>(
  response: {readonly structuredContent: T; readonly text: string},
  responseFormat: CodeGraphMcpResponseFormat = 'dual',
) {
  if (responseFormat === 'agent') {
    return {content: [{type: 'text' as const, text: renderCodeGraphAgentResponse(response.structuredContent)}]};
  }
  if (responseFormat === 'text') {
    return {content: [{type: 'text' as const, text: JSON.stringify(response.structuredContent)}]};
  }
  return {
    content: [{type: 'text' as const, text: response.text}],
    structuredContent: response.structuredContent,
  };
}

function measureFormattedCodeGraphMcpResponse<T>(
  response: {readonly structuredContent: T; readonly text: string},
  responseFormat: CodeGraphMcpResponseFormat,
) {
  const formatted = formatCodeGraphMcpResponse(response, responseFormat);
  return measureAgentToolResponse({
    ...(formatted.structuredContent === undefined ? {} : {structuredContent: formatted.structuredContent}),
    text: formatted.content[0].text,
  });
}

/** A deterministic, text-only receipt for local graph inspection. Every cell
 * is JSON encoded, so delimiters and Unicode remain grammar-safe. */
export function renderCodeGraphAgentResponse(value: unknown): string {
  const result = value as {
    readonly edges?: readonly Record<string, unknown>[];
    readonly nodes?: readonly Record<string, unknown>[];
    readonly output?: Record<string, unknown>;
    readonly warnings?: readonly unknown[];
    readonly [key: string]: unknown;
  };
  const nodes = result.nodes ?? [];
  const aliases = new Map(nodes.map((node, index) => [String(node.id), `n${index + 1}`]));
  const scalar = (item: unknown) => JSON.stringify(item);
  const lines = ['TN-GRAPH/1'];
  for (const key of [
    'operation',
    'repository',
    'snapshot',
    'freshness',
    'trust',
    'sourceVersion',
    'projectCoverage',
    'outsideProjectGraph',
    'outsideScopeChangedPaths',
    'scope',
    'searchCoverage',
    'source',
    'refresh',
  ]) {
    if (result[key] !== undefined) lines.push(`${key}\t${scalar(result[key])}`);
  }
  lines.push(`coverage\t${scalar(result.output ?? {})}`);
  for (const node of nodes) {
    const {id, ...rest} = node;
    lines.push(`node\t${aliases.get(String(id))}\t${scalar(id)}\t${scalar(rest)}`);
  }
  for (const edge of result.edges ?? []) {
    const {id: _id, sourceId, targetId, ...rest} = edge;
    const source = sourceId === undefined ? null : (aliases.get(String(sourceId)) ?? sourceId);
    const target = targetId === undefined ? null : (aliases.get(String(targetId)) ?? targetId);
    lines.push(`edge\t${scalar(source)}\t${scalar(target)}\t${scalar(rest)}`);
  }
  for (const warning of result.warnings ?? []) lines.push(`warning\t${scalar(warning)}`);
  if (result.output?.truncated === true) lines.push('recovery\t"refine-query-or-follow-a-stable-cgs-handle"');
  return `${lines.join('\n')}\n`;
}
