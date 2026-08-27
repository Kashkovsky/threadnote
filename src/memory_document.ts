import type {MemoryKind, MemoryStatus} from './types.js';
import {parseResourceId} from './storage/resource-id.js';
import {
  assertMemorySchemaWritable,
  formatMemoryCodeCitationLines,
  MEMORY_CODE_CITATION_HEADER,
  MEMORY_SCHEMA_VERSION,
  parseMemoryCodeCitationHeaders,
  type MemoryCodeCitationError,
  type MemoryCodeCitationV1,
} from './memory_code_citation.js';

export type MemoryAuthority = 'agent_generated' | 'canonical_repo' | 'external' | 'reviewed_shared' | 'user_approved';

export type MemoryTrust = 'approved' | 'inferred' | 'untrusted';

export type MemoryVisibility = 'external' | 'personal' | 'shared';

export type MemoryRelationType = 'depends_on' | 'evidence_for' | 'references' | 'related_to' | 'supersedes';

export interface MemoryRelation {
  readonly type: MemoryRelationType;
  readonly uri: string;
}

export interface MemoryMetadata {
  readonly archivedFrom?: string;
  readonly authority?: MemoryAuthority;
  readonly candidateId?: string;
  /** Immutable capture-time code evidence; validation receipts are never persisted here. */
  readonly codeCitations?: readonly MemoryCodeCitationV1[];
  /** Closed parse/bounds errors that force precise freshness to abstain. */
  readonly citationErrors?: readonly MemoryCodeCitationError[];
  readonly createdAt?: string;
  readonly evidence?: readonly string[];
  readonly kind: MemoryKind;
  readonly keywords?: readonly string[];
  readonly lastReviewed?: string;
  readonly memoryId?: string;
  readonly project?: string;
  readonly references?: readonly string[];
  readonly relations?: readonly MemoryRelation[];
  readonly schemaVersion?: number;
  readonly sourceHash?: string;
  readonly sourceAgentClient: string;
  readonly sourceCommit?: string;
  readonly sourceObservedAt?: string;
  readonly sourceSessionId?: string;
  readonly status: MemoryStatus;
  readonly supersedes?: string;
  readonly timestamp: string;
  readonly topic?: string;
  readonly trust?: MemoryTrust;
  readonly updatedAt?: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly visibility?: MemoryVisibility;
  /** POSIX, repo-relative package/app root; absent means repo-wide. */
  readonly workspaceScope?: string;
}

export interface MemoryRecord {
  readonly body: string;
  readonly content: string;
  readonly headerTitle: 'MEMORY' | 'HANDOFF';
  readonly metadata: MemoryMetadata;
  readonly uri: string;
}

const LEGACY_MEMORY_FIELDS_TRAILER = /\r?\n\r?\n<!-- MEMORY_FIELDS\r?\n[\s\S]*?\r?\n-->\s*$/;
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
  const parseable = normalizeMemoryDocumentLineEndings(trimmed);
  const separatorIndex = parseable.indexOf('\n\n');
  const header = separatorIndex === -1 ? parseable : parseable.slice(0, separatorIndex);
  const body =
    separatorIndex === -1
      ? ''
      : parseable
          .slice(separatorIndex + 2)
          .replace(LEGACY_MEMORY_FIELDS_TRAILER, '')
          .trim();
  const firstLine = header.split('\n')[0]?.trim();
  if (firstLine !== 'MEMORY' && firstLine !== 'HANDOFF') {
    return undefined;
  }
  const kind = parseMemoryKind(memoryHeaderValue(header, 'kind')) ?? (firstLine === 'HANDOFF' ? 'handoff' : undefined);
  if (!kind) {
    return undefined;
  }
  const schemaVersion = parseSchemaVersion(memoryHeaderValue(header, 'schema_version'));
  const codeCitationMetadata = parseMemoryCodeCitationHeaders(
    memoryCodeCitationHeaderValues(header),
    canonicalCodeCitationSchemaVersion(header, schemaVersion),
  );
  return {
    body,
    content: trimmed,
    headerTitle: firstLine,
    metadata: {
      archivedFrom: canonicalOptionalResourceInput(memoryHeaderValue(header, 'archived_from')),
      authority: parseMemoryAuthority(memoryHeaderValue(header, 'authority')),
      candidateId: memoryHeaderValue(header, 'candidate_id'),
      codeCitations: codeCitationMetadata.citations,
      citationErrors: codeCitationMetadata.errors,
      createdAt: memoryHeaderValue(header, 'created_at'),
      evidence: canonicalResourceInputs(memoryHeaderValues(header, 'evidence')),
      kind,
      keywords: memoryHeaderValues(header, 'keywords'),
      lastReviewed: memoryHeaderValue(header, 'last_reviewed'),
      memoryId: memoryHeaderValue(header, 'memory_id'),
      project: normalizeOptionalMetadata(memoryHeaderValue(header, 'project') ?? memoryHeaderValue(header, 'repo')),
      references: canonicalResourceInputs(memoryHeaderValues(header, 'references')),
      relations: parseMemoryRelations(memoryHeaderValues(header, 'relation')),
      schemaVersion,
      sourceHash: memoryHeaderValue(header, 'source_hash'),
      sourceAgentClient: memoryHeaderValue(header, 'source_agent_client') ?? 'unknown',
      sourceCommit: memoryHeaderValue(header, 'source_commit'),
      sourceObservedAt: memoryHeaderValue(header, 'source_observed_at'),
      sourceSessionId: memoryHeaderValue(header, 'source_session_id'),
      status: parseMemoryStatus(memoryHeaderValue(header, 'status')) ?? 'active',
      supersedes: canonicalOptionalResourceInput(memoryHeaderValue(header, 'supersedes')),
      timestamp: memoryHeaderValue(header, 'timestamp') ?? new Date(0).toISOString(),
      topic: normalizeOptionalMetadata(memoryHeaderValue(header, 'topic')),
      trust: parseMemoryTrust(memoryHeaderValue(header, 'trust')),
      updatedAt: memoryHeaderValue(header, 'updated_at'),
      validFrom: memoryHeaderValue(header, 'valid_from'),
      validTo: memoryHeaderValue(header, 'valid_to'),
      visibility: parseMemoryVisibility(memoryHeaderValue(header, 'visibility')),
      workspaceScope: normalizeOptionalMetadata(memoryHeaderValue(header, 'workspace_scope')),
    },
    uri: canonicalResourceInput(uri),
  };
}

export function formatMemoryDocument(title: 'MEMORY' | 'HANDOFF', metadata: MemoryMetadata, body: string): string {
  assertMemorySchemaWritable(metadata.schemaVersion);
  if (metadata.citationErrors && metadata.citationErrors.length > 0) {
    throw new Error('Cannot format memory metadata with unresolved code-citation errors.');
  }
  if (metadata.codeCitations && metadata.codeCitations.length > 0 && metadata.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    throw new Error(`Memory code citations require memory schema version ${MEMORY_SCHEMA_VERSION}.`);
  }
  const codeCitationLines = formatMemoryCodeCitationLines(metadata.codeCitations ?? []);
  const header = [
    title,
    `kind: ${metadata.kind}`,
    `status: ${metadata.status}`,
    memoryHeaderLine('project', metadata.project),
    memoryHeaderLine('topic', metadata.topic),
    memoryHeaderLine('source_agent_client', metadata.sourceAgentClient),
    memoryHeaderLine('timestamp', metadata.timestamp),
    metadata.schemaVersion !== undefined ? `schema_version: ${metadata.schemaVersion}` : undefined,
    memoryHeaderLine('memory_id', metadata.memoryId),
    memoryHeaderLine('created_at', metadata.createdAt),
    memoryHeaderLine('updated_at', metadata.updatedAt),
    memoryHeaderLine('visibility', metadata.visibility),
    memoryHeaderLine('workspace_scope', metadata.workspaceScope),
    memoryHeaderLine('authority', metadata.authority),
    memoryHeaderLine('trust', metadata.trust),
    memoryHeaderLine('valid_from', metadata.validFrom),
    memoryHeaderLine('valid_to', metadata.validTo),
    memoryHeaderLine('last_reviewed', metadata.lastReviewed),
    memoryHeaderLine('source_observed_at', metadata.sourceObservedAt),
    memoryHeaderLine('source_session_id', metadata.sourceSessionId),
    memoryHeaderLine('source_commit', metadata.sourceCommit),
    ...codeCitationLines,
    memoryHeaderLine('candidate_id', metadata.candidateId),
    memoryHeaderLine('source_hash', metadata.sourceHash),
    memoryHeaderLine('supersedes', metadata.supersedes),
    memoryHeaderLine('archived_from', metadata.archivedFrom),
    ...(metadata.references ?? []).map(reference => memoryHeaderLine('references', reference)),
    ...(metadata.evidence ?? []).map(evidence => memoryHeaderLine('evidence', evidence)),
    ...(metadata.relations ?? []).map(relation => memoryHeaderLine('relation', `${relation.type} ${relation.uri}`)),
    ...(metadata.keywords ?? []).map(keyword => memoryHeaderLine('keywords', keyword)),
  ].filter((line): line is string => line !== undefined);
  return [...header, '', body.trim()].join('\n');
}

/** Preserve source prose in an archive without duplicating machine-readable headers into recall text. */
export function memoryArchiveBody(sourceBody: string): string {
  return ['Archived original Threadnote memory.', '', sourceBody].join('\n');
}

export function formatMemoryDocumentWithKeywords(content: string, keywords: readonly string[]): string {
  assertMemoryDocumentSchemaWritable(content);
  const canonical = normalizeMemoryDocumentLineEndings(canonicalMemoryDocumentContent(content));
  const separatorIndex = canonical.indexOf('\n\n');
  const header = separatorIndex === -1 ? canonical : canonical.slice(0, separatorIndex);
  const body = separatorIndex === -1 ? '' : canonical.slice(separatorIndex + 2);
  const headerLines = header.split('\n').filter(line => !line.startsWith('keywords:'));
  const keywordLines = keywords.map(keyword => memoryHeaderLine('keywords', keyword) as string);
  return [...headerLines, ...keywordLines, '', body].join('\n');
}

/**
 * A legacy indexer appended a managed indexing trailer after writes. It is not part
 * of the user-approved memory payload and must not affect content identity.
 */
export function canonicalMemoryDocumentContent(content: string): string {
  return content.trim().replace(LEGACY_MEMORY_FIELDS_TRAILER, '').trim();
}

/**
 * Rewriters must inspect the raw header rather than trusting parsed metadata:
 * malformed, unsafe, or duplicate versions otherwise collapse to an absent or
 * older version and make unknown fields look writable.
 */
export function assertMemoryDocumentSchemaWritable(content: string): void {
  const canonical = normalizeMemoryDocumentLineEndings(canonicalMemoryDocumentContent(content));
  const separatorIndex = canonical.indexOf('\n\n');
  const header = separatorIndex === -1 ? canonical : canonical.slice(0, separatorIndex);
  const schemaLines = header.split('\n').filter(line => /^\s*schema_version\s*:/u.test(line));
  if (schemaLines.length === 0) return;
  if (schemaLines.length !== 1) {
    throw new Error('Memory schema_version header must appear exactly once before rewriting.');
  }
  const line = schemaLines[0]!;
  const rawVersion = line.slice(line.indexOf(':') + 1).trim();
  const schemaVersion = parseSchemaVersion(rawVersion);
  if (schemaVersion === undefined) {
    throw new Error('Memory schema_version header must be a canonical positive safe integer before rewriting.');
  }
  assertMemorySchemaWritable(schemaVersion);
  if (line !== `schema_version: ${schemaVersion}`) {
    throw new Error('Memory schema_version header must be a canonical positive safe integer before rewriting.');
  }
}

export function assertMemoryRecordArchivable(record: Pick<MemoryRecord, 'content' | 'metadata' | 'uri'>): void {
  assertMemoryDocumentSchemaWritable(record.content);
  const citationErrors = record.metadata.citationErrors;
  if (citationErrors && citationErrors.length > 0) {
    const reasons = [...new Set(citationErrors.map(error => error.reason))].sort().join(', ');
    throw new Error(
      `Cannot archive ${record.uri}: malformed code citation metadata (${reasons}) must be repaired or recaptured first.`,
    );
  }
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
  const canonicalUri = canonicalResourceInput(uri);
  const fallback: MemoryAuthority = options.canonicalResource
    ? 'canonical_repo'
    : canonicalUri.startsWith('threadnote://resources/')
      ? 'external'
      : isSharedMemoryUri(canonicalUri)
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
  const canonicalUri = canonicalResourceInput(uri);
  const fallback: MemoryTrust =
    options.canonicalResource || isSharedMemoryUri(canonicalUri) || reviewedCandidate
      ? 'approved'
      : canonicalUri.startsWith('threadnote://resources/')
        ? 'untrusted'
        : 'inferred';
  const asserted = metadata?.trust;
  return asserted !== undefined && TRUST_LEVEL[asserted] <= TRUST_LEVEL[fallback] ? asserted : fallback;
}

export function isSharedMemoryUri(uri: string): boolean {
  return /^threadnote:\/\/user\/[^/]+\/memories\/shared\/[^/]+\//.test(canonicalResourceInput(uri));
}

function canonicalResourceInput(uri: string): string {
  try {
    return parseResourceId(uri).canonicalUri;
  } catch {
    return uri;
  }
}

export function inferMemoryMetadata(memory: string): Partial<MemoryMetadata> {
  const parseable = normalizeMemoryDocumentLineEndings(memory);
  const header = parseable.slice(0, Math.max(0, parseable.indexOf('\n\n')) || parseable.length);
  const firstLine = header.split('\n')[0]?.trim();
  const schemaVersion = parseSchemaVersion(memoryHeaderValue(header, 'schema_version'));
  const codeCitationMetadata = parseMemoryCodeCitationHeaders(
    memoryCodeCitationHeaderValues(header),
    canonicalCodeCitationSchemaVersion(header, schemaVersion),
  );
  return {
    archivedFrom: canonicalOptionalResourceInput(memoryHeaderValue(header, 'archived_from')),
    authority: parseMemoryAuthority(memoryHeaderValue(header, 'authority')),
    candidateId: memoryHeaderValue(header, 'candidate_id'),
    codeCitations: codeCitationMetadata.citations,
    citationErrors: codeCitationMetadata.errors,
    createdAt: memoryHeaderValue(header, 'created_at'),
    evidence: canonicalResourceInputs(memoryHeaderValues(header, 'evidence')),
    kind: parseMemoryKind(memoryHeaderValue(header, 'kind')) ?? (firstLine === 'HANDOFF' ? 'handoff' : undefined),
    keywords: memoryHeaderValues(header, 'keywords'),
    lastReviewed: memoryHeaderValue(header, 'last_reviewed'),
    memoryId: memoryHeaderValue(header, 'memory_id'),
    project: normalizeOptionalMetadata(
      memoryHeaderValue(header, 'project') ??
        memoryHeaderValue(header, 'repo') ??
        memoryHeaderValue(header, 'repo_path'),
    ),
    references: canonicalResourceInputs(memoryHeaderValues(header, 'references')),
    relations: parseMemoryRelations(memoryHeaderValues(header, 'relation')),
    schemaVersion,
    sourceHash: memoryHeaderValue(header, 'source_hash'),
    sourceAgentClient: memoryHeaderValue(header, 'source_agent_client'),
    sourceCommit: memoryHeaderValue(header, 'source_commit'),
    sourceObservedAt: memoryHeaderValue(header, 'source_observed_at'),
    sourceSessionId: memoryHeaderValue(header, 'source_session_id'),
    status: parseMemoryStatus(memoryHeaderValue(header, 'status')),
    supersedes: canonicalOptionalResourceInput(memoryHeaderValue(header, 'supersedes')),
    timestamp: memoryHeaderValue(header, 'timestamp'),
    topic: normalizeOptionalMetadata(memoryHeaderValue(header, 'topic') ?? memoryHeaderValue(header, 'task')),
    trust: parseMemoryTrust(memoryHeaderValue(header, 'trust')),
    updatedAt: memoryHeaderValue(header, 'updated_at'),
    validFrom: memoryHeaderValue(header, 'valid_from'),
    validTo: memoryHeaderValue(header, 'valid_to'),
    visibility: parseMemoryVisibility(memoryHeaderValue(header, 'visibility')),
    workspaceScope: normalizeOptionalMetadata(memoryHeaderValue(header, 'workspace_scope')),
  };
}

function normalizeMemoryDocumentLineEndings(content: string): string {
  return content.replace(/\r\n?/gu, '\n');
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

/** Preserve citation whitespace so a non-canonical header cannot become authoritative after trimming. */
function memoryCodeCitationHeaderValues(header: string): readonly string[] | undefined {
  const prefix = `${MEMORY_CODE_CITATION_HEADER}:`;
  const values = header
    .split('\n')
    .filter(line => line.trimStart().startsWith(prefix))
    .map(line => {
      const trimmedStart = line.trimStart();
      const suffix = trimmedStart.slice(prefix.length);
      const value = suffix.startsWith(' ') ? suffix.slice(1) : ` ${suffix}`;
      return line === trimmedStart ? value : ` ${value}`;
    });
  return values.length > 0 ? values : undefined;
}

function canonicalCodeCitationSchemaVersion(header: string, schemaVersion: number | undefined): number | undefined {
  if (schemaVersion === undefined) return undefined;
  const lines = header.split('\n').filter(line => line.startsWith('schema_version:'));
  return lines.length === 1 && lines[0] === `schema_version: ${schemaVersion}` ? schemaVersion : undefined;
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
  return value === 'active' || value === 'archived' || value === 'expired' || value === 'superseded'
    ? value
    : undefined;
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

function parseMemoryVisibility(value: string | undefined): MemoryVisibility | undefined {
  return value === 'external' || value === 'personal' || value === 'shared' ? value : undefined;
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
      const uri = canonicalOptionalResourceInput(value.slice(separator + 1).trim());
      if (!uri || !uri.startsWith('threadnote://') || !isMemoryRelationType(type)) {
        return undefined;
      }
      return {type, uri};
    })
    .filter((relation): relation is MemoryRelation => relation !== undefined);
  return relations.length > 0 ? relations : undefined;
}

function canonicalOptionalResourceInput(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  try {
    return parseResourceId(uri).canonicalUri;
  } catch {
    return uri;
  }
}

function canonicalResourceInputs(values: readonly string[] | undefined): readonly string[] | undefined {
  return values?.map(value => canonicalOptionalResourceInput(value) ?? value);
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
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
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
