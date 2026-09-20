import {sha256HexSync} from '../../crypto/sha256.js';
import {formatMemoryDocument, parseMemoryDocument} from '../../memory/document.js';
import {inspectRemoteMemoryContent} from '../../memory_domain/content.js';
import {REMOTE_MEMORY_RECEIPT_VERSION, type RemoteMemoryReceiptV1} from '../../memory_domain/receipts.js';
import type {AuthorizedRemotePrincipal} from '../authorization.js';
import type {CursorWorkloadAttestation} from '../cursor_oidc.js';
import {remoteMemoryError} from '../errors.js';
import type {RemoteMemoryRequestExecution} from '../request_execution.js';
import type {ShareStateRow} from '../repository_policy.js';

export function mutationAuthorityValidThrough(
  execution: RemoteMemoryRequestExecution | undefined,
  refUpdateTimeoutMilliseconds = 0,
  nowEpochMilliseconds = Date.now(),
): number {
  const requestDeadline = execution?.deadlineEpochMilliseconds ?? nowEpochMilliseconds;
  const refUpdateDeadline = nowEpochMilliseconds + refUpdateTimeoutMilliseconds;
  return Math.max(requestDeadline, refUpdateDeadline);
}

export function numeric(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) && !Number.isFinite(parsed))
    throw remoteMemoryError('service_unavailable', 'A remote memory generation was invalid.');
  return parsed;
}

export function receipt(
  principal: AuthorizedRemotePrincipal,
  state: ShareStateRow,
  requestId: string,
  extra: Partial<Pick<RemoteMemoryReceiptV1, 'actor' | 'revision' | 'uri'>> & {
    readonly overlayUsed?: boolean;
  } = {},
): RemoteMemoryReceiptV1 {
  const shareGeneration = numeric(state.share_generation);
  const indexedGeneration = numeric(state.indexed_generation);
  const {overlayUsed, ...receiptFields} = extra;
  return {
    ...receiptFields,
    consistency:
      indexedGeneration === shareGeneration
        ? 'current'
        : extra.revision || overlayUsed
          ? 'recent-write-overlay'
          : 'stale-index',
    indexedGeneration,
    policyVersion: principal.policyVersion,
    sharePolicyVersion: state.policy_version,
    requestId,
    shareGeneration,
    shareId: principal.shareId,
    tenantId: principal.tenantId,
    version: REMOTE_MEMORY_RECEIPT_VERSION,
  };
}

export function lifecycleRequestFingerprint(
  principal: AuthorizedRemotePrincipal,
  input: {
    readonly baseRevision: string;
    readonly operation: string;
    readonly operationId: string;
    readonly uri: string;
  },
): string {
  return sha256HexSync(
    JSON.stringify({
      baseRevision: input.baseRevision,
      operation: input.operation,
      operationId: input.operationId,
      shareId: principal.shareId,
      uri: input.uri,
      version: 1,
    }),
  );
}

export function makeLifecycleDocument(
  current: Readonly<{
    canonical_uri: string;
    markdown_body: string;
  }>,
  status: 'active' | 'archived' | 'expired' | 'superseded',
  now: Date,
  priorBody = current.markdown_body,
): {readonly content: string; readonly contentHash: string} {
  const prior = parseMemoryDocument(current.canonical_uri, priorBody);
  if (!prior || prior.headerTitle !== 'HANDOFF') {
    throw remoteMemoryError('service_unavailable', 'The stored remote handoff document is invalid.');
  }
  const content = formatMemoryDocument(
    'HANDOFF',
    {...prior.metadata, status, updatedAt: now.toISOString()},
    prior.body,
  );
  const inspected = inspectRemoteMemoryContent(content);
  if (!inspected.allowed) {
    throw remoteMemoryError('service_unavailable', 'The stored remote handoff no longer passes content policy.');
  }
  return {content: inspected.canonicalContent, contentHash: sha256HexSync(inspected.canonicalContent)};
}

export function mutationActor(
  principal: AuthorizedRemotePrincipal,
  attestation: CursorWorkloadAttestation | undefined,
): RemoteMemoryReceiptV1['actor'] {
  return attestation
    ? {
        cloudAgentId: attestation.cloudAgentId,
        principalId: principal.principalId,
        provider: 'cursor',
        ...(attestation.turnId ? {turnId: attestation.turnId} : {}),
      }
    : {principalId: principal.principalId};
}
