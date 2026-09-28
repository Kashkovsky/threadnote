export const MAX_RECALL_SELECTION_CANDIDATES = 24;

export interface RecallSelectionCandidate {
  readonly id: string;
  readonly summary: string;
  readonly uri: string;
}

export interface RecallSelectionInput {
  readonly candidates: readonly RecallSelectionCandidate[];
  readonly query: string;
}
