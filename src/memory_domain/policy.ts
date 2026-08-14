import type {RemoteMemoryKind} from './contracts.js';

export const REMOTE_MEMORY_POLICY_CONTRACT_VERSION = 1 as const;
export const REMOTE_MEMORY_CAPABILITIES = [
  'memory:read',
  'memory:write:durable',
  'memory:write:handoff',
  'memory:admin',
] as const;

export type RemoteMemoryCapability = (typeof REMOTE_MEMORY_CAPABILITIES)[number];

export interface RemoteMemoryGrantV1 {
  readonly active: boolean;
  readonly allProjects: boolean;
  readonly projectIds: readonly string[];
  readonly shareId: string;
  readonly version: typeof REMOTE_MEMORY_POLICY_CONTRACT_VERSION;
}

export interface RemoteWorkloadAttestationV1 {
  readonly expiresAtEpochMilliseconds: number;
  readonly principalId: string;
  readonly projectIds: readonly string[];
  readonly provider: 'cursor';
  readonly shareId: string;
  readonly version: typeof REMOTE_MEMORY_POLICY_CONTRACT_VERSION;
}

export interface RemoteMemoryPolicyContextV1 {
  readonly attestation?: RemoteWorkloadAttestationV1;
  readonly capabilities: readonly RemoteMemoryCapability[];
  readonly durableWritesAllowed: boolean;
  readonly grant: RemoteMemoryGrantV1;
  readonly handoffWritesAllowed: boolean;
  readonly membershipActive: boolean;
  readonly policyVersion: string;
  readonly principalId: string;
  readonly requireCursorAttestationForManagedWrites: boolean;
  readonly version: typeof REMOTE_MEMORY_POLICY_CONTRACT_VERSION;
}

export interface RemoteMemoryPolicyRequestV1 {
  readonly kind: RemoteMemoryKind;
  readonly managedCloud: boolean;
  readonly nowEpochMilliseconds: number;
  readonly operation: 'read' | 'write';
  readonly project: string;
  readonly shareId: string;
  readonly version: typeof REMOTE_MEMORY_POLICY_CONTRACT_VERSION;
}

export type RemoteMemoryPolicyDenialReason =
  | 'attestation_expired'
  | 'attestation_mismatch'
  | 'attestation_required'
  | 'capability_missing'
  | 'grant_inactive'
  | 'membership_inactive'
  | 'project_not_granted'
  | 'share_mismatch'
  | 'write_kind_disabled';

export type RemoteMemoryPolicyDecisionV1 =
  | {
      readonly allowed: true;
      readonly policyVersion: string;
      readonly version: typeof REMOTE_MEMORY_POLICY_CONTRACT_VERSION;
    }
  | {
      readonly allowed: false;
      readonly policyVersion: string;
      readonly reason: RemoteMemoryPolicyDenialReason;
      readonly version: typeof REMOTE_MEMORY_POLICY_CONTRACT_VERSION;
    };

export function evaluateRemoteMemoryPolicy(
  context: RemoteMemoryPolicyContextV1,
  request: RemoteMemoryPolicyRequestV1,
): RemoteMemoryPolicyDecisionV1 {
  if (!context.membershipActive) return deny(context, 'membership_inactive');
  if (!context.grant.active) return deny(context, 'grant_inactive');
  if (context.grant.shareId !== request.shareId) return deny(context, 'share_mismatch');
  if (!context.grant.allProjects && !context.grant.projectIds.includes(request.project)) {
    return deny(context, 'project_not_granted');
  }
  if (!context.capabilities.includes(requiredCapability(request))) return deny(context, 'capability_missing');
  if (request.operation === 'write') {
    if (
      (request.kind === 'durable' && !context.durableWritesAllowed) ||
      (request.kind === 'handoff' && !context.handoffWritesAllowed)
    ) {
      return deny(context, 'write_kind_disabled');
    }
    if (request.managedCloud && context.requireCursorAttestationForManagedWrites) {
      const attestation = context.attestation;
      if (!attestation) return deny(context, 'attestation_required');
      if (attestation.expiresAtEpochMilliseconds <= request.nowEpochMilliseconds) {
        return deny(context, 'attestation_expired');
      }
      if (
        attestation.principalId !== context.principalId ||
        attestation.shareId !== request.shareId ||
        !attestation.projectIds.includes(request.project)
      ) {
        return deny(context, 'attestation_mismatch');
      }
    }
  }
  return {
    allowed: true,
    policyVersion: context.policyVersion,
    version: REMOTE_MEMORY_POLICY_CONTRACT_VERSION,
  };
}

function requiredCapability(request: RemoteMemoryPolicyRequestV1): RemoteMemoryCapability {
  if (request.operation === 'read') return 'memory:read';
  return request.kind === 'durable' ? 'memory:write:durable' : 'memory:write:handoff';
}

function deny(
  context: RemoteMemoryPolicyContextV1,
  reason: RemoteMemoryPolicyDenialReason,
): RemoteMemoryPolicyDecisionV1 {
  return {allowed: false, policyVersion: context.policyVersion, reason, version: REMOTE_MEMORY_POLICY_CONTRACT_VERSION};
}
