import {describe, expect, it} from 'vitest';
import {codeGraphRetryAfterMilliseconds} from '../../src/mcp_server.js';
import type {CodeGraphRefreshStatus} from '../../src/code_graph/watcher.js';

describe('MCP code graph indexing progress', () => {
  it('derives a bounded adaptive poll interval from the phase estimate', () => {
    expect(codeGraphRetryAfterMilliseconds(undefined)).toBe(5_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(4_000))).toBe(3_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(60_000))).toBe(15_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(60 * 60_000))).toBe(30_000);
  });
});

function indexingStatus(estimatedPhaseRemainingMilliseconds: number): CodeGraphRefreshStatus {
  return {
    state: 'indexing',
    timing: {
      buildId: 'test-build',
      elapsedMilliseconds: 2_000,
      estimateConfidence: 'medium',
      estimatedPhaseRemainingMilliseconds,
      estimateScope: 'phase',
      lastProgressAgeMilliseconds: 0,
      phaseElapsedMilliseconds: 2_000,
      phaseStartedAtMilliseconds: 0,
      startedAtMilliseconds: 0,
      updatedAtMilliseconds: 2_000,
    },
  };
}
