export const REMOTE_HANDOFF_LIFECYCLE_VERSION = 1 as const;
export const REMOTE_HANDOFF_LIFECYCLE_STATES = ['active', 'superseded', 'archived', 'expired'] as const;
export const REMOTE_HANDOFF_LIFECYCLE_OPERATIONS = ['revise', 'supersede', 'archive', 'expire'] as const;

export type RemoteHandoffLifecycleState = (typeof REMOTE_HANDOFF_LIFECYCLE_STATES)[number];
export type RemoteHandoffLifecycleOperation = (typeof REMOTE_HANDOFF_LIFECYCLE_OPERATIONS)[number];

export type RemoteHandoffLifecycleDecisionV1 =
  | {
      readonly from: RemoteHandoffLifecycleState;
      readonly kind: 'transition';
      readonly operation: RemoteHandoffLifecycleOperation;
      readonly to: RemoteHandoffLifecycleState;
      readonly version: typeof REMOTE_HANDOFF_LIFECYCLE_VERSION;
    }
  | {
      readonly from: RemoteHandoffLifecycleState;
      readonly kind: 'rejected';
      readonly operation: RemoteHandoffLifecycleOperation;
      readonly reason: 'terminal_state' | 'transition_not_allowed';
      readonly version: typeof REMOTE_HANDOFF_LIFECYCLE_VERSION;
    };

export function transitionRemoteHandoffLifecycle(
  from: RemoteHandoffLifecycleState,
  operation: RemoteHandoffLifecycleOperation,
): RemoteHandoffLifecycleDecisionV1 {
  if (from === 'archived' || from === 'superseded') {
    return {from, kind: 'rejected', operation, reason: 'terminal_state', version: REMOTE_HANDOFF_LIFECYCLE_VERSION};
  }
  if (from === 'expired') {
    return operation === 'archive'
      ? {from, kind: 'transition', operation, to: 'archived', version: REMOTE_HANDOFF_LIFECYCLE_VERSION}
      : {
          from,
          kind: 'rejected',
          operation,
          reason: 'transition_not_allowed',
          version: REMOTE_HANDOFF_LIFECYCLE_VERSION,
        };
  }
  const to = activeTransitionTarget(operation);
  return {from, kind: 'transition', operation, to, version: REMOTE_HANDOFF_LIFECYCLE_VERSION};
}

export function openNewRemoteHandoffLifecycle(): RemoteHandoffLifecycleState {
  return 'active';
}

function activeTransitionTarget(operation: RemoteHandoffLifecycleOperation): RemoteHandoffLifecycleState {
  switch (operation) {
    case 'archive':
      return 'archived';
    case 'expire':
      return 'expired';
    case 'revise':
      return 'active';
    case 'supersede':
      return 'superseded';
  }
}
