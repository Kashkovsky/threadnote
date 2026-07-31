import {describe, expect, it} from 'vitest';
import {codeGraphQueryTimeoutResult, codeGraphRetryAfterMilliseconds} from '../../src/mcp_server.js';
import type {CodeGraphRefreshStatus} from '../../src/code_graph/watcher.js';

describe('MCP code graph indexing progress', () => {
  it('derives a bounded adaptive poll interval from the phase estimate', () => {
    expect(codeGraphRetryAfterMilliseconds(undefined)).toBe(5_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(4_000))).toBe(3_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(60_000))).toBe(15_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(60 * 60_000))).toBe(30_000);
  });

  it('keeps elapsed query and active indexing states retryable without hiding a failed build', () => {
    const timedOut = codeGraphQueryTimeoutResult('query');
    expect(timedOut.isError).not.toBe(true);
    expect(timedOut.structuredContent).toMatchObject({
      retryAfterMilliseconds: 5_000,
      state: 'timed-out',
      type: 'code-graph-query-state',
      version: 2,
    });

    const indexing = codeGraphQueryTimeoutResult('query', indexingStatus(60_000));
    expect(indexing.isError).not.toBe(true);
    expect(indexing.structuredContent).toMatchObject({
      retryAfterMilliseconds: 15_000,
      state: 'indexing',
      type: 'code-graph-index-state',
      version: 2,
    });

    const failed = codeGraphQueryTimeoutResult('query', {message: 'fixture index failed', state: 'failed'});
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({
      message: 'fixture index failed',
      state: 'failed',
      type: 'code-graph-index-state',
      version: 2,
    });
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
