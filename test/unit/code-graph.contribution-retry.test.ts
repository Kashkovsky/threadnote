import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {
  graphShareContributionRetryDelay,
  graphShareSignedContributionRetryDelay,
} from '../../src/code_graph/sharing/contribution_retry_state.js';
import {graphShareRetryAfterMilliseconds} from '../../src/code_graph/sharing/errors.js';

describe('automatic graph contribution retry timing', () => {
  it('backs off monotonically, bounds jitter and respects a server retry delay', () => {
    FC.assert(
      FC.property(
        FC.integer({min: 1, max: 20}),
        FC.double({min: 0, max: 1, noNaN: true}),
        FC.integer({min: 0, max: 86_400_000}),
        (failures, jitter, retryAfter) => {
          const delay = graphShareContributionRetryDelay(failures, jitter, retryAfter);
          expect(delay).toBeGreaterThanOrEqual(retryAfter);
          expect(delay).toBeGreaterThanOrEqual(5_000);
          expect(delay).toBeLessThanOrEqual(Math.max(retryAfter, 360_000));
          expect(graphShareContributionRetryDelay(failures + 1, jitter, retryAfter)).toBeGreaterThanOrEqual(delay);
        },
      ),
      {numRuns: 50},
    );
  });

  it('accepts delta-seconds and HTTP dates but ignores malformed retry hints', () => {
    expect(graphShareRetryAfterMilliseconds('12', 0)).toBe(12_000);
    expect(graphShareRetryAfterMilliseconds('Thu, 01 Jan 1970 00:00:30 GMT', 10_000)).toBe(20_000);
    expect(graphShareRetryAfterMilliseconds('not a date', 0)).toBeUndefined();
    expect(graphShareRetryAfterMilliseconds('-2', 0)).toBeUndefined();
  });

  it('retries source-unavailable responses within the collection window without weakening other backoff', () => {
    FC.assert(
      FC.property(
        FC.integer({min: 1, max: 13}),
        FC.double({min: 0, max: 1, noNaN: true}),
        FC.integer({min: 0, max: 2_000}),
        (failures, jitter, retryAfter) => {
          const delay = graphShareSignedContributionRetryDelay(425, failures, jitter, retryAfter);
          expect(delay).toBe(
            failures <= 6 ? 2_000 : graphShareContributionRetryDelay(failures - 6, jitter, retryAfter),
          );
          expect(
            graphShareSignedContributionRetryDelay(425, Math.min(13, failures + 1), jitter, retryAfter),
          ).toBeGreaterThanOrEqual(delay);
          expect(graphShareSignedContributionRetryDelay(503, failures, jitter, retryAfter)).toBe(
            graphShareContributionRetryDelay(failures, jitter, retryAfter),
          );
        },
      ),
      {numRuns: 40},
    );
    expect(graphShareSignedContributionRetryDelay(425, 1, 0, 3_000)).toBe(3_000);
    expect(graphShareSignedContributionRetryDelay(425, 13, 0)).toBe(300_000);
  });
});
