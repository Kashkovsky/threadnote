import {
  AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN,
  AgentResponseBudgetTooSmallError,
  measureAgentToolResponse,
  type AgentToolResponseMeasurement,
} from '../evaluation/agent-response.js';
import type {RecallConfidence} from './rank.js';
import type {RecallHit} from '../utils.js';
import {
  mergeRecallOperationalWarnings,
  renderRecallOperationalWarning,
  type RecallOperationalWarning,
} from './warning.js';

export const RECALL_MCP_RESPONSE_DEFAULT_ESTIMATED_TOKENS = 1_500 as const;
export const RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS = 700 as const;
export const RECALL_MCP_RESPONSE_MAXIMUM_ESTIMATED_TOKENS = 1_500 as const;

const NEXT_ACTION_URI_LIMIT = 3;
const RESULT_ALIAS_LIMIT = 3;
const REASON_MAXIMUM_BYTES = 96;
const NOTICE_LIMIT = 4;
const NOTICE_MAXIMUM_BYTES = 180;
// withStaleVersionNotice may append one bounded reconnect line after projection.
const POST_PROJECTION_NOTICE_RESERVE_BYTES = 256;

export interface RecallMcpLogicalResponse {
  readonly confidence?: RecallConfidence;
  readonly memoryScope?: unknown;
  readonly notices?: readonly string[];
  readonly queryExpansions: readonly string[];
  readonly rankerVersion: string;
  readonly results: readonly RecallHit[];
  readonly warnings?: readonly RecallOperationalWarning[];
}

export interface RecallMcpResponseProjectionOptions {
  readonly budgetTokens?: number;
  readonly explain?: boolean;
}

export interface ProjectedRecallMcpResponse {
  readonly maximumBytes: number;
  readonly measurement: AgentToolResponseMeasurement;
  readonly structuredContent: RecallMcpStructuredContent;
  readonly text: string;
}

export interface RecallMcpStructuredContent {
  readonly [key: string]: unknown;
  readonly confidence?: RecallConfidence;
  readonly memoryScope?: unknown;
  readonly nextAction: {
    readonly tool: 'read_context';
    readonly uris: readonly string[];
  };
  readonly output: {
    readonly budgetTokens: number;
    readonly explain: boolean;
    readonly omittedResults: number;
    readonly returnedResults: number;
    readonly totalResults: number;
    readonly truncated: boolean;
  };
  readonly queryExpansions?: readonly string[];
  readonly rankerVersion: string;
  readonly results: readonly RecallMcpResult[];
  readonly warnings?: readonly RecallOperationalWarning[];
}

export interface RecallMcpResult {
  readonly aliasCount?: number;
  readonly aliases?: readonly string[];
  readonly category: RecallHit['category'];
  readonly confidence: number;
  readonly finalScore?: number;
  readonly omittedAliases?: number;
  readonly rankWarnings?: RecallHit['rankWarnings'];
  readonly readState: 'unread';
  readonly reason: string;
  readonly reasons?: RecallHit['rankReasons'];
  readonly signals?: RecallHit['rankSignals'];
  readonly uri: string;
  readonly warnings?: readonly RecallMcpResultWarning[];
}

export interface RecallMcpResultWarning {
  readonly code: 'memory_identity_conflict';
  readonly message: string;
  readonly remediation: string;
}

const MEMORY_IDENTITY_CONFLICT_WARNING = {
  code: 'memory_identity_conflict',
  message: 'This memory_id has divergent bodies in the authorized memory corpus.',
  remediation: 'Treat it as conflicting evidence and verify against a canonical source before use.',
} as const satisfies RecallMcpResultWarning;

/**
 * Projects the already-ranked recall set without changing its order. The only
 * budget reduction is a ranked-prefix reduction; compact fields never change
 * in response to the requested budget.
 */
export function projectRecallMcpResponse(
  logical: RecallMcpLogicalResponse,
  options: RecallMcpResponseProjectionOptions = {},
): ProjectedRecallMcpResponse {
  const budgetTokens = options.budgetTokens ?? RECALL_MCP_RESPONSE_DEFAULT_ESTIMATED_TOKENS;
  if (
    !Number.isSafeInteger(budgetTokens) ||
    budgetTokens < RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS ||
    budgetTokens > RECALL_MCP_RESPONSE_MAXIMUM_ESTIMATED_TOKENS
  ) {
    throw new Error(
      `Recall response budget must be an integer from ${RECALL_MCP_RESPONSE_MINIMUM_ESTIMATED_TOKENS} to ${RECALL_MCP_RESPONSE_MAXIMUM_ESTIMATED_TOKENS}.`,
    );
  }
  const maximumBytes = budgetTokens * AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN;
  const projectionMaximumBytes = Math.max(1, maximumBytes - POST_PROJECTION_NOTICE_RESERVE_BYTES);
  const explain = options.explain === true;
  const notices = compactNotices(logical.notices ?? []);
  const warnings = mergeRecallOperationalWarnings(logical.warnings ?? []);
  let selected:
    | {readonly measurement: AgentToolResponseMeasurement; readonly structuredContent: RecallMcpStructuredContent}
    | undefined;
  let minimumBytes = Number.POSITIVE_INFINITY;

  for (let count = 0; count <= logical.results.length; count += 1) {
    const structuredContent = renderStructuredContent(logical, warnings, count, budgetTokens, explain);
    const text = renderRecallMcpText(structuredContent, notices);
    const measurement = measureAgentToolResponse({structuredContent, text});
    minimumBytes = Math.min(minimumBytes, measurement.totalBytes);
    if (measurement.totalBytes <= projectionMaximumBytes) selected = {measurement, structuredContent};
  }
  if (selected === undefined) throw new AgentResponseBudgetTooSmallError(projectionMaximumBytes, minimumBytes);
  return {
    maximumBytes,
    measurement: selected.measurement,
    structuredContent: selected.structuredContent,
    text: renderRecallMcpText(selected.structuredContent, notices),
  };
}

export function renderRecallMcpText(response: RecallMcpStructuredContent, notices: readonly string[] = []): string {
  const {omittedResults, returnedResults, totalResults} = response.output;
  const count = `${returnedResults}/${totalResults}`;
  const omitted = omittedResults > 0 ? `; ${omittedResults} omitted by the response budget` : '';
  const nextUri = response.nextAction.uris[0];
  const next = nextUri
    ? ` Next: call read_context for ${nextUri} before using memory as evidence.`
    : ' No memory pointer is available to read.';
  return [
    `Recall returned ${count} unread pointer(s)${omitted}. Ranked pointers are not evidence.${next}`,
    ...(response.warnings ?? []).map(renderRecallOperationalWarning),
    ...notices,
  ].join('\n');
}

function renderStructuredContent(
  logical: RecallMcpLogicalResponse,
  warnings: readonly RecallOperationalWarning[],
  count: number,
  budgetTokens: number,
  explain: boolean,
): RecallMcpStructuredContent {
  const selected = logical.results.slice(0, count);
  const results = selected.map(hit => renderResult(hit, explain));
  const omittedResults = logical.results.length - results.length;
  return {
    ...(logical.confidence === undefined ? {} : {confidence: logical.confidence}),
    ...(logical.memoryScope === undefined ? {} : {memoryScope: logical.memoryScope}),
    nextAction: {
      tool: 'read_context',
      uris: results.slice(0, NEXT_ACTION_URI_LIMIT).map(result => result.uri),
    },
    output: {
      budgetTokens,
      explain,
      omittedResults,
      returnedResults: results.length,
      totalResults: logical.results.length,
      truncated: omittedResults > 0,
    },
    ...(explain ? {queryExpansions: logical.queryExpansions} : {}),
    rankerVersion: logical.rankerVersion,
    results,
    ...(warnings.length > 0 ? {warnings} : {}),
  };
}

function renderResult(hit: RecallHit, explain: boolean): RecallMcpResult {
  const allAliases = [...new Set(hit.equivalentUris?.filter(uri => uri !== hit.uri) ?? [])];
  const aliases = allAliases.slice(0, RESULT_ALIAS_LIMIT);
  const omittedAliases = allAliases.length - aliases.length;
  const compact = {
    ...(aliases.length > 0 ? {aliasCount: allAliases.length, aliases} : {}),
    category: hit.category,
    confidence: roundedConfidence(hit.finalScore ?? hit.score),
    readState: 'unread' as const,
    reason: compactReason(hit),
    ...(omittedAliases > 0 ? {omittedAliases} : {}),
    uri: hit.uri,
    ...(hit.identityConflict ? {warnings: [MEMORY_IDENTITY_CONFLICT_WARNING]} : {}),
  };
  if (!explain) return compact;
  return {
    ...compact,
    finalScore: hit.finalScore,
    reasons: hit.rankReasons,
    signals: hit.rankSignals,
    rankWarnings: hit.rankWarnings,
  };
}

function compactReason(hit: RecallHit): string {
  const reason =
    hit.rankReasons?.[0]?.detail ??
    (hit.exactTerms && hit.exactTerms.length > 0
      ? `Matched ${hit.exactTerms.slice(0, 3).join(', ')}`
      : `${hit.contextType} match`);
  return truncateUtf8(reason.replace(/\s+/gu, ' ').trim(), REASON_MAXIMUM_BYTES);
}

function compactNotices(notices: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const candidates: Array<{readonly index: number; readonly notice: string; readonly priority: number}> = [];
  for (const [index, notice] of notices.entries()) {
    const normalized = notice.replace(/\s+/gu, ' ').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push({index, notice: normalized, priority: noticePriority(normalized)});
  }
  return candidates
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .slice(0, NOTICE_LIMIT)
    .map(candidate => truncateUtf8(candidate.notice, NOTICE_MAXIMUM_BYTES));
}

function noticePriority(notice: string): number {
  if (/\b(?:failed|unavailable|warning)\b/iu.test(notice)) return 0;
  if (notice.startsWith('Memory hygiene hints:')) return 1;
  if (notice.startsWith('Referenced context:')) return 2;
  if (notice.startsWith('Auto-synced ')) return 3;
  return 4;
}

function roundedConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.min(1, Math.max(0, value)).toFixed(3));
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  let prefix = '';
  for (const character of value) {
    if (encoder.encode(`${prefix}${character}…`).byteLength > maximumBytes) break;
    prefix += character;
  }
  return `${prefix}…`;
}
