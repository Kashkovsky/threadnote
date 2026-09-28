import type {CodeGraphQueryResult} from '../types.js';

export const UNAVAILABLE_IMPACT_BASE_WARNING =
  'The requested impact base has no ready current-format snapshot; deleted-path recovery was skipped without starting indexing.';

export function addUnavailableImpactBaseWarning(result: CodeGraphQueryResult): CodeGraphQueryResult {
  return {
    ...result,
    warnings: [...result.warnings, UNAVAILABLE_IMPACT_BASE_WARNING],
  };
}
