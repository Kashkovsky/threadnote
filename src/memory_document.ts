import type {MemoryKind, MemoryStatus} from './types.js';

export type MemoryAuthority = 'agent_generated' | 'canonical_repo' | 'external' | 'reviewed_shared' | 'user_approved';

export type MemoryTrust = 'approved' | 'inferred' | 'untrusted';

export type MemoryRelationType = 'depends_on' | 'evidence_for' | 'references' | 'related_to' | 'supersedes';

export interface MemoryRelation {
  readonly type: MemoryRelationType;
  readonly uri: string;
}

export interface MemoryMetadata {
  readonly archivedFrom?: string;
  readonly authority?: MemoryAuthority;
  readonly candidateId?: string;
  readonly evidence?: readonly string[];
  readonly kind: MemoryKind;
  readonly lastReviewed?: string;
  readonly project?: string;
  readonly references?: readonly string[];
  readonly relations?: readonly MemoryRelation[];
  readonly schemaVersion?: number;
  readonly sourceAgentClient: string;
  readonly sourceCommit?: string;
  readonly sourceObservedAt?: string;
  readonly sourceSessionId?: string;
  readonly status: MemoryStatus;
  readonly supersedes?: string;
  readonly timestamp: string;
  readonly topic?: string;
  readonly trust?: MemoryTrust;
  readonly validFrom?: string;
  readonly validTo?: string;
}

export interface MemoryRecord {
  readonly body: string;
  readonly content: string;
  readonly headerTitle: 'MEMORY' | 'HANDOFF';
  readonly metadata: MemoryMetadata;
  readonly uri: string;
}

const OPENVIKING_MEMORY_FIELDS_TRAILER = /\r?\n\r?\n<!-- MEMORY_FIELDS\r?\n[\s\S]*?\r?\n-->\s*$/;
const HEADER_LINE_BREAK = /[\r\n]/;
const AUTHORITY_LEVEL: Readonly<Record<MemoryAuthority, number>> = {
  external: 0,
  agent_generated: 1,
  reviewed_shared: 2,
  user_approved: 3,
  canonical_repo: 4,
};
const TRUST_LEVEL: Readonly<Record<MemoryTrust, number>> = {
  untrusted: 0,
  inferred: 1,
  approved: 2,
};

export function parseMemoryDocument(uri: string, content: string): MemoryRecord | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }
  const separatorIndex = trimmed.indexOf('\n\n');
  const header = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
  const body =
    separatorIndex === -1
      ? ''
      : trimmed
          .slice(separatorIndex + 2)
          .replace(OPENVIKING_MEMORY_FIELDS_TRAILER, '')
          .trim();
  const firstLine = header.split('\n')[0]?.trim();
  if (firstLine !== 'MEMORY' && firstLine !== 'HANDOFF') {
    return undefined;
  }
  const kind = parseMemoryKind(memoryHeaderValue(header, 'kind')) ?? (firstLine === 'HANDOFF' ? 'handoff' : undefined);
  if (!kind) {
    return undefined;
  }
  return {
    body,
    content: trimmed,
    headerTitle: firstLine,
    metadata: {
      archivedFrom: memoryHeaderValue(header, 'archived_from'),
      authority: parseMemoryAuthority(memoryHeaderValue(header, 'authority')),
      candidateId: memoryHeaderValue(header, 'candidate_id'),
      evidence: memoryHeaderValues(header, 'evidence'),
      kind,
      lastReviewed: memoryHeaderValue(header, 'last_reviewed'),
      project: normalizeOptionalMetadata(memoryHeaderValue(header, 'project') ?? memoryHeaderValue(header, 'repo')),
      references: memoryHeaderValues(header, 'references'),
      relations: parseMemoryRelations(memoryHeaderValues(header, 'relation')),
      schemaVersion: parseSchemaVersion(memoryHeaderValue(header, 'schema_version')),
      sourceAgentClient: memoryHeaderValue(header, 'source_agent_client') ?? 'unknown',
      sourceCommit: memoryHeaderValue(header, 'source_commit'),
      sourceObservedAt: memoryHeaderValue(header, 'source_observed_at'),
      sourceSessionId: memoryHeaderValue(header, 'source_session_id'),
      status: parseMemoryStatus(memoryHeaderValue(header, 'status')) ?? 'active',
      supersedes: memoryHeaderValue(header, 'supersedes'),
      timestamp: memoryHeaderValue(header, 'timestamp') ?? new Date(0).toISOString(),
      topic: normalizeOptionalMetadata(memoryHeaderValue(header, 'topic')),
      trust: parseMemoryTrust(memoryHeaderValue(header, 'trust')),
      validFrom: memoryHeaderValue(header, 'valid_from'),
      validTo: memoryHeaderValue(header, 'valid_to'),
    },
    uri,
  };
}

export function formatMemoryDocument(title: 'MEMORY' | 'HANDOFF', metadata: MemoryMetadata, body: string): string {
  const header = [
    title,
    metadata.schemaVersion !== undefined ? `schema_version: ${metadata.schemaVersion}` : undefined,
    `kind: ${metadata.kind}`,
    `status: ${metadata.status}`,
    memoryHeaderLine('project', metadata.project),
    memoryHeaderLine('topic', metadata.topic),
    memoryHeaderLine('source_agent_client', metadata.sourceAgentClient),
    memoryHeaderLine('timestamp', metadata.timestamp),
    memoryHeaderLine('authority', metadata.authority),
    memoryHeaderLine('trust', metadata.trust),
    memoryHeaderLine('valid_from', metadata.validFrom),
    memoryHeaderLine('valid_to', metadata.validTo),
    memoryHeaderLine('last_reviewed', metadata.lastReviewed),
    memoryHeaderLine('source_observed_at', metadata.sourceObservedAt),
    memoryHeaderLine('source_session_id', metadata.sourceSessionId),
    memoryHeaderLine('source_commit', metadata.sourceCommit),
    memoryHeaderLine('candidate_id', metadata.candidateId),
    memoryHeaderLine('supersedes', metadata.supersedes),
    memoryHeaderLine('archived_from', metadata.archivedFrom),
    ...(metadata.references ?? []).map(reference => memoryHeaderLine('references', reference)),
    ...(metadata.evidence ?? []).map(evidence => memoryHeaderLine('evidence', evidence)),
    ...(metadata.relations ?? []).map(relation => memoryHeaderLine('relation', `${relation.type} ${relation.uri}`)),
  ].filter((line): line is string => line !== undefined);
  return [...header, '', body.trim()].join('\n');
}

/**
 * OpenViking appends a managed indexing trailer after writes. It is not part
 * of the user-approved memory payload and must not affect content identity.
 */
export function canonicalMemoryDocumentContent(content: string): string {
  return content.trim().replace(OPENVIKING_MEMORY_FIELDS_TRAILER, '').trim();
}

/**
 * Content metadata may lower a source's authority, but it cannot claim an
 * authority above the URI boundary. Personal candidate memories receive their
 * higher ceiling only when the complete reviewed-candidate provenance tuple is
 * present.
 */
export function boundedMemoryAuthority(
  uri: string,
  metadata?: Partial<MemoryMetadata>,
  options: {readonly canonicalResource?: boolean} = {},
): MemoryAuthority {
  const reviewedCandidate = isReviewedCandidateMetadata(metadata);
  const fallback: MemoryAuthority = options.canonicalResource
    ? 'canonical_repo'
    : uri.startsWith('viking://resources/')
      ? 'external'
      : isSharedMemoryUri(uri)
        ? 'reviewed_shared'
        : reviewedCandidate
          ? 'user_approved'
          : 'agent_generated';
  const asserted = metadata?.authority;
  return asserted !== undefined && AUTHORITY_LEVEL[asserted] <= AUTHORITY_LEVEL[fallback] ? asserted : fallback;
}

export function boundedMemoryTrust(
  uri: string,
  metadata?: Partial<MemoryMetadata>,
  options: {readonly canonicalResource?: boolean} = {},
): MemoryTrust {
  const reviewedCandidate = isReviewedCandidateMetadata(metadata);
  const fallback: MemoryTrust =
    options.canonicalResource || isSharedMemoryUri(uri) || reviewedCandidate
      ? 'approved'
      : uri.startsWith('viking://resources/')
        ? 'untrusted'
        : 'inferred';
  const asserted = metadata?.trust;
  return asserted !== undefined && TRUST_LEVEL[asserted] <= TRUST_LEVEL[fallback] ? asserted : fallback;
}

export function isSharedMemoryUri(uri: string): boolean {
  return /^viking:\/\/user\/[^/]+\/memories\/shared\/[^/]+\//.test(uri);
}

export function inferMemoryMetadata(memory: string): Partial<MemoryMetadata> {
  const header = memory.slice(0, Math.max(0, memory.indexOf('\n\n')) || memory.length);
  const firstLine = header.split('\n')[0]?.trim();
  return {
    archivedFrom: memoryHeaderValue(header, 'archived_from'),
    authority: parseMemoryAuthority(memoryHeaderValue(header, 'authority')),
    candidateId: memoryHeaderValue(header, 'candidate_id'),
    evidence: memoryHeaderValues(header, 'evidence'),
    kind: parseMemoryKind(memoryHeaderValue(header, 'kind')) ?? (firstLine === 'HANDOFF' ? 'handoff' : undefined),
    lastReviewed: memoryHeaderValue(header, 'last_reviewed'),
    project: normalizeOptionalMetadata(
      memoryHeaderValue(header, 'project') ??
        memoryHeaderValue(header, 'repo') ??
        memoryHeaderValue(header, 'repo_path'),
    ),
    references: memoryHeaderValues(header, 'references'),
    relations: parseMemoryRelations(memoryHeaderValues(header, 'relation')),
    schemaVersion: parseSchemaVersion(memoryHeaderValue(header, 'schema_version')),
    sourceAgentClient: memoryHeaderValue(header, 'source_agent_client'),
    sourceCommit: memoryHeaderValue(header, 'source_commit'),
    sourceObservedAt: memoryHeaderValue(header, 'source_observed_at'),
    sourceSessionId: memoryHeaderValue(header, 'source_session_id'),
    status: parseMemoryStatus(memoryHeaderValue(header, 'status')),
    supersedes: memoryHeaderValue(header, 'supersedes'),
    timestamp: memoryHeaderValue(header, 'timestamp'),
    topic: normalizeOptionalMetadata(memoryHeaderValue(header, 'topic') ?? memoryHeaderValue(header, 'task')),
    trust: parseMemoryTrust(memoryHeaderValue(header, 'trust')),
    validFrom: memoryHeaderValue(header, 'valid_from'),
    validTo: memoryHeaderValue(header, 'valid_to'),
  };
}

export function memoryHeaderValue(header: string, key: string): string | undefined {
  const prefix = `${key}:`;
  return header
    .split('\n')
    .find(line => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function memoryHeaderValues(header: string, key: string): readonly string[] | undefined {
  const prefix = `${key}:`;
  const values = header
    .split('\n')
    .filter(line => line.startsWith(prefix))
    .map(line => line.slice(prefix.length).trim())
    .filter(value => value.length > 0);
  return values.length > 0 ? values : undefined;
}

function parseMemoryKind(value: string | undefined): MemoryKind | undefined {
  return value === 'durable' ||
    value === 'handoff' ||
    value === 'incident' ||
    value === 'preference' ||
    value === 'smoke'
    ? value
    : undefined;
}

function parseMemoryStatus(value: string | undefined): MemoryStatus | undefined {
  return value === 'active' || value === 'archived' || value === 'superseded' ? value : undefined;
}

function parseMemoryAuthority(value: string | undefined): MemoryAuthority | undefined {
  return value === 'agent_generated' ||
    value === 'canonical_repo' ||
    value === 'external' ||
    value === 'reviewed_shared' ||
    value === 'user_approved'
    ? value
    : undefined;
}

function parseMemoryTrust(value: string | undefined): MemoryTrust | undefined {
  return value === 'approved' || value === 'inferred' || value === 'untrusted' ? value : undefined;
}

function parseMemoryRelations(values: readonly string[] | undefined): readonly MemoryRelation[] | undefined {
  if (!values) {
    return undefined;
  }
  const relations = values
    .map(value => {
      const separator = value.indexOf(' ');
      if (separator <= 0) {
        return undefined;
      }
      const type = value.slice(0, separator);
      const uri = value.slice(separator + 1).trim();
      if (!uri.startsWith('viking://') || !isMemoryRelationType(type)) {
        return undefined;
      }
      return {type, uri};
    })
    .filter((relation): relation is MemoryRelation => relation !== undefined);
  return relations.length > 0 ? relations : undefined;
}

function isMemoryRelationType(value: string): value is MemoryRelationType {
  return (
    value === 'depends_on' ||
    value === 'evidence_for' ||
    value === 'references' ||
    value === 'related_to' ||
    value === 'supersedes'
  );
}

function parseSchemaVersion(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeOptionalMetadata(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isReviewedCandidateMetadata(metadata: Partial<MemoryMetadata> | undefined): boolean {
  return (
    metadata?.authority === 'user_approved' &&
    metadata.trust === 'approved' &&
    metadata.candidateId !== undefined &&
    metadata.lastReviewed !== undefined &&
    metadata.sourceObservedAt !== undefined
  );
}

function memoryHeaderLine(key: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (HEADER_LINE_BREAK.test(value)) {
    throw new Error(`Memory metadata ${key} must not contain line breaks.`);
  }
  return `${key}: ${value}`;
}
