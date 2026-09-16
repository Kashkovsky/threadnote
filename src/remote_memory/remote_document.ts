import {randomUuidV4} from '../crypto/uuid.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {type MemoryCodeCitationV1, MEMORY_SCHEMA_VERSION} from '../memory/code_citation.js';
import {
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryRelation,
} from '../memory/document.js';
import {inspectRemoteMemoryContent} from '../memory_domain/content.js';
import type {RemoteRememberInputV1} from '../memory_domain/contracts.js';
import {assertRemoteBodyReplacementSupported} from './document_compatibility.js';
import {remoteMemoryError} from './errors.js';

export function makeRemoteDocument(
  input: RemoteRememberInputV1,
  hasCurrent: boolean,
  uri: string,
  sourceAgentClient: 'cursor' | 'remote',
  now: Date,
  priorBody: string | undefined,
  memoryId?: string,
  codeCitations?: readonly MemoryCodeCitationV1[],
): {readonly content: string; readonly contentHash: string; readonly relations?: readonly MemoryRelation[]} {
  const timestamp = now.toISOString();
  const prior = hasCurrent && priorBody ? parseMemoryDocument(uri, priorBody) : undefined;
  if (hasCurrent && priorBody) assertRemoteBodyReplacementSupported(priorBody);
  const metadata: MemoryMetadata = {
    ...prior?.metadata,
    codeCitations: codeCitations === undefined ? prior?.metadata.codeCitations : codeCitations,
    createdAt: prior?.metadata.createdAt ?? prior?.metadata.timestamp ?? timestamp,
    kind: input.kind,
    memoryId: prior?.metadata.memoryId ?? memoryId ?? `tn_${randomUuidV4().replaceAll('-', '')}`,
    project: input.project,
    relations: input.relations === undefined ? prior?.metadata.relations : input.relations,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceAgentClient,
    status: 'active',
    timestamp,
    topic: input.topic,
    updatedAt: timestamp,
    visibility: 'shared',
  };
  const formatted = formatMemoryDocument(input.kind === 'handoff' ? 'HANDOFF' : 'MEMORY', metadata, input.text.trim());
  const inspected = inspectRemoteMemoryContent(formatted);
  if (!inspected.allowed) {
    throw remoteMemoryError('invalid_request', `Remote memory content was blocked by ${inspected.category} policy.`);
  }
  return {
    content: inspected.canonicalContent,
    contentHash: sha256HexSync(inspected.canonicalContent),
    ...(metadata.relations?.length ? {relations: metadata.relations} : {}),
  };
}
