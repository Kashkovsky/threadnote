export interface RecallIndexForegroundFreshness {
  readonly observedCanonicalMutationGeneration: string;
  readonly forceRefresh: boolean;
  readonly initialized: boolean;
  readonly integrityCurrent: boolean;
  readonly observedStaleGeneration: string;
  readonly persistedCanonicalMutationGeneration: string;
  readonly persistedStaleGeneration: string;
}

/**
 * Keep ordinary recall reads independent of corpus size. Threadnote-managed
 * writes publish a new stale generation, while explicit maintenance can force
 * a source validation. Wall-clock age alone is not a foreground refresh
 * signal: re-walking every canonical source would otherwise create periodic
 * latency cliffs for unchanged large corpora.
 */
export function recallIndexForegroundRefreshRequired(input: RecallIndexForegroundFreshness): boolean {
  return (
    input.forceRefresh ||
    !input.initialized ||
    !input.integrityCurrent ||
    input.persistedCanonicalMutationGeneration !== input.observedCanonicalMutationGeneration ||
    input.persistedStaleGeneration !== input.observedStaleGeneration
  );
}
