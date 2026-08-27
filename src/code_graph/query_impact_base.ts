import type {CodeGraphQueryResult} from './types.js';

export function addUnavailableImpactBaseWarning(result: CodeGraphQueryResult): CodeGraphQueryResult {
  return {
    ...result,
    warnings: [
      ...result.warnings,
      'The requested impact base has no ready current-format snapshot; deleted-path recovery was skipped without starting indexing.',
    ],
  };
}
