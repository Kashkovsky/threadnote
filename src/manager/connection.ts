export interface ManagerAvailability {
  readonly runtime: 'connecting' | 'connected' | 'disconnected';
  readonly selection: 'none' | 'loading' | 'ready' | 'failed';
}

export interface ManagerDraft {
  readonly base: string;
  readonly text: string;
  readonly uri: string;
}

/** Keep a local edit until the reloaded canonical record has been compared with its base. */
export function reconcileManagerDraft(
  draft: ManagerDraft | undefined,
  canonical: {readonly content: string; readonly uri: string},
): {readonly content: string; readonly needsReview: boolean} {
  if (draft?.uri !== canonical.uri) return {content: canonical.content, needsReview: false};
  return {content: draft.text, needsReview: draft.base !== canonical.content};
}

export type ManagerAvailabilityEvent =
  'runtime-ready' | 'runtime-lost' | 'selection-cleared' | 'selection-started' | 'selection-ready' | 'selection-failed';

export const initialManagerAvailability: ManagerAvailability = {runtime: 'connecting', selection: 'none'};

export function managerAvailabilityTransition(
  state: ManagerAvailability,
  event: ManagerAvailabilityEvent,
): ManagerAvailability {
  switch (event) {
    case 'runtime-ready':
      return {...state, runtime: 'connected'};
    case 'runtime-lost':
      return {runtime: 'disconnected', selection: state.selection === 'none' ? 'none' : 'loading'};
    case 'selection-cleared':
      return {...state, selection: 'none'};
    case 'selection-started':
      return {...state, selection: 'loading'};
    case 'selection-ready':
      return state.runtime === 'connected' ? {...state, selection: 'ready'} : state;
    case 'selection-failed':
      return {...state, selection: 'failed'};
  }
}

export function managerSelectionIsReadable(state: ManagerAvailability): boolean {
  return state.runtime === 'connected' && state.selection === 'ready';
}

export function managerActionsAreAvailable(state: ManagerAvailability): boolean {
  return state.runtime === 'connected' && (state.selection === 'none' || state.selection === 'ready');
}
