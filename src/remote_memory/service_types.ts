import type {RemoteMemoryReceiptV1} from '../memory_domain/receipts.js';
import type {RemoteHandoffLifecycleOperation} from '../memory_domain/lifecycle.js';
import type {RemoteReadInputV1, RemoteRecallInputV1, RemoteRememberInputV1} from '../memory_domain/contracts.js';
import type {AuthorizedRemotePrincipal, RemoteAuthorizationStore} from './authorization.js';
import type {CursorAttestationStore, CursorTokenVerifier, CursorWorkloadAttestation} from './cursor_oidc.js';
import type {OAuthTokenVerifier} from './oauth.js';
import type {RemoteMemoryRateLimiter} from './rate_limit.js';
import type {RemoteMemoryRequestExecution} from './request_execution.js';
import type {
  RemoteMemoryListEntry,
  RemoteMemoryReadResult,
  RemoteMemoryRecallResult,
  RemoteMemoryStatusResult,
} from './postgres_repository.js';

export interface RemoteMemoryListInput {
  readonly afterUri?: string;
  readonly kinds?: readonly ('durable' | 'handoff')[];
  readonly limit: number;
  readonly project?: string;
  readonly status?: 'active' | 'archived' | 'expired' | 'superseded';
}

export interface RemoteHandoffTransitionInput {
  readonly attestationId?: string;
  readonly baseRevision: string;
  readonly operation: Exclude<RemoteHandoffLifecycleOperation, 'revise'>;
  readonly operationId: string;
  readonly uri: string;
  readonly version: 1;
}

/** Promise-native storage boundary used by the official MCP SDK handlers. */
export interface RemoteMemoryServiceRepository {
  readonly list: (
    principal: AuthorizedRemotePrincipal,
    input: RemoteMemoryListInput,
    requestId: string,
    execution?: RemoteMemoryRequestExecution,
  ) => Promise<{
    readonly entries: readonly RemoteMemoryListEntry[];
    readonly nextCursor?: string;
    readonly receipt: RemoteMemoryReceiptV1;
  }>;
  readonly read: (
    principal: AuthorizedRemotePrincipal,
    input: RemoteReadInputV1,
    requestId: string,
    execution?: RemoteMemoryRequestExecution,
  ) => Promise<RemoteMemoryReadResult>;
  readonly recall: (
    principal: AuthorizedRemotePrincipal,
    input: RemoteRecallInputV1,
    requestId: string,
    execution?: RemoteMemoryRequestExecution,
  ) => Promise<{readonly receipt: RemoteMemoryReceiptV1; readonly results: readonly RemoteMemoryRecallResult[]}>;
  readonly remember: (
    principal: AuthorizedRemotePrincipal,
    input: RemoteRememberInputV1,
    requestId: string,
    attestation?: CursorWorkloadAttestation,
    now?: Date,
    execution?: RemoteMemoryRequestExecution,
  ) => Promise<RemoteMemoryReceiptV1>;
  readonly status: (
    principal: AuthorizedRemotePrincipal,
    requestId: string,
    execution?: RemoteMemoryRequestExecution,
  ) => Promise<RemoteMemoryStatusResult>;
  readonly transitionHandoff: (
    principal: AuthorizedRemotePrincipal,
    input: RemoteHandoffTransitionInput,
    requestId: string,
    attestation?: CursorWorkloadAttestation,
    now?: Date,
    execution?: RemoteMemoryRequestExecution,
  ) => Promise<RemoteMemoryReceiptV1>;
}

export interface RemoteAttestationControlPlane extends CursorAttestationStore {
  readonly principalForChallenge: (
    challengeId: string,
    execution?: RemoteMemoryRequestExecution,
  ) => Promise<AuthorizedRemotePrincipal | undefined>;
}

export interface RemoteMemoryServiceDependencies {
  readonly attestations: RemoteAttestationControlPlane;
  readonly authorization: RemoteAuthorizationStore;
  readonly cursorTokens: CursorTokenVerifier;
  readonly oauthTokens: OAuthTokenVerifier;
  readonly rateLimits: RemoteMemoryRateLimiter;
  readonly readiness: () => Promise<boolean>;
  readonly repository: RemoteMemoryServiceRepository;
}
