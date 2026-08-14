import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  remoteMemoryDatabaseTimeoutMilliseconds,
  remainingRemoteMemoryRequestMilliseconds,
  requireActiveRemoteMemoryRequest,
} from '../../src/remote_memory/request_execution.js';

describe('remote memory request execution budget', () => {
  it.prop(
    'derives a positive PostgreSQL timeout bounded by both configuration and remaining request time',
    {
      configuredMaximum: FC.integer({max: 120_000, min: 1}),
      remaining: FC.integer({max: 240_000, min: 1}),
    },
    ({configuredMaximum, remaining}) => {
      const now = 2_000_000_000_000;
      const execution = {
        deadlineEpochMilliseconds: now + remaining,
        signal: new AbortController().signal,
      };

      expect(remainingRemoteMemoryRequestMilliseconds(execution, now)).toBe(remaining);
      expect(remoteMemoryDatabaseTimeoutMilliseconds(configuredMaximum, execution, now)).toBe(
        Math.min(configuredMaximum, remaining),
      );
    },
    {fastCheck: {numRuns: 100}},
  );

  it('fails closed before storage when the request is cancelled or expired', () => {
    const cancelled = new AbortController();
    cancelled.abort();
    expect(() =>
      requireActiveRemoteMemoryRequest({
        deadlineEpochMilliseconds: Date.now() + 1_000,
        signal: cancelled.signal,
      }),
    ).toThrow('cancelled');
    expect(() =>
      requireActiveRemoteMemoryRequest({
        deadlineEpochMilliseconds: Date.now() - 1,
        signal: new AbortController().signal,
      }),
    ).toThrow('deadline expired');
  });
});
