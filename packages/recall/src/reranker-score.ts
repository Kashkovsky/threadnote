/**
 * Normalizes native reranker output into the probability range consumed by
 * recall ranking. node-llama-cpp ranking sessions normally return a
 * probability; the sigmoid branch keeps candidate artifacts with raw logits
 * comparable without letting non-finite scores enter ranking.
 */
export function normalizeRecallRerankerScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return score >= 0 && score <= 1 ? score : 1 / (1 + Math.exp(-score));
}
