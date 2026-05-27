import {describe, expect, it} from 'vitest';
import {isResourceBusyFailure, isTransientOvFailure, mergeChanges} from '../../src/share.js';
import type {ChangedFile} from '../../src/share.js';

describe('isTransientOvFailure', () => {
  it('classifies resource-busy errors as transient', () => {
    expect(isTransientOvFailure('Error: API error: [INVALID_ARGUMENT] resource is busy', '')).toBe(true);
    expect(isTransientOvFailure('', 'resource is being processed')).toBe(true);
  });

  it('classifies network-class errors as transient', () => {
    expect(isTransientOvFailure('', 'connection refused')).toBe(true);
    expect(isTransientOvFailure('', 'connection reset')).toBe(true);
    expect(isTransientOvFailure('', 'timed out waiting')).toBe(true);
    expect(isTransientOvFailure('', 'http request failed')).toBe(true);
    expect(isTransientOvFailure('', 'network error: ...')).toBe(true);
    expect(isTransientOvFailure('', 'error sending request')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isTransientOvFailure('Resource Is BUSY', '')).toBe(true);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientOvFailure('', '[NOT_FOUND] resource does not exist')).toBe(false);
    expect(isTransientOvFailure('permission denied', '')).toBe(false);
    expect(isTransientOvFailure('', '')).toBe(false);
  });
});

describe('isResourceBusyFailure', () => {
  it('matches only the busy-resource subset, not generic network errors', () => {
    expect(isResourceBusyFailure('', 'resource is busy')).toBe(true);
    expect(isResourceBusyFailure('', 'resource is being processed')).toBe(true);
    expect(isResourceBusyFailure('', 'connection refused')).toBe(false);
    expect(isResourceBusyFailure('', 'timed out')).toBe(false);
  });
});

describe('mergeChanges', () => {
  const make = (relativePath: string, status: ChangedFile['status']): ChangedFile => ({
    path: `/repo/${relativePath}`,
    relativePath,
    status,
  });

  it('returns an empty array for no lists', () => {
    expect(mergeChanges()).toEqual([]);
  });

  it('returns the single list unchanged when given one input', () => {
    const list = [make('a.md', 'added'), make('b.md', 'modified')];
    expect(mergeChanges(list)).toEqual(list);
  });

  it('deduplicates by relativePath; later lists override earlier ones', () => {
    const previous = [make('a.md', 'modified'), make('b.md', 'removed')];
    const current = [make('a.md', 'added'), make('c.md', 'added')];
    const out = mergeChanges(previous, current);
    expect(out).toHaveLength(3);
    expect(out.find(c => c.relativePath === 'a.md')?.status).toBe('added');
    expect(out.find(c => c.relativePath === 'b.md')?.status).toBe('removed');
    expect(out.find(c => c.relativePath === 'c.md')?.status).toBe('added');
  });

  it('preserves order of first occurrence', () => {
    const previous = [make('z.md', 'modified'), make('a.md', 'modified')];
    const current = [make('a.md', 'added'), make('b.md', 'added')];
    const out = mergeChanges(previous, current);
    expect(out.map(c => c.relativePath)).toEqual(['z.md', 'a.md', 'b.md']);
  });
});
