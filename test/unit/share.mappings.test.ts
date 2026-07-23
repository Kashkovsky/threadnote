import {describe, expect, it} from 'vitest';
import {
  isInSharedNamespace,
  parentUri,
  sharedDirectoryChain,
  sharedMemoryUriParts,
  sharedTeamNameForUri,
  sharedUriFor,
  vikingUriToWorktreeRelative,
} from '../../src/share.js';
import type {ShareRuntime} from '../../src/types.js';

const runtime: ShareRuntime = {
  account: 'local',
  agentContextHome: '/tmp/.openviking',
  agentId: 'threadnote',
  user: 'test-user',
};

describe('isInSharedNamespace', () => {
  it('returns true for URIs under the user-shared subtree', () => {
    expect(isInSharedNamespace(runtime, 'viking://user/test-user/memories/shared/default/durable/x.md')).toBe(true);
  });

  it('returns false for personal memories', () => {
    expect(isInSharedNamespace(runtime, 'viking://user/test-user/memories/durable/projects/a.md')).toBe(false);
    expect(isInSharedNamespace(runtime, 'viking://user/test-user/memories/handoffs/active/x.md')).toBe(false);
  });

  it('returns false for another user namespace', () => {
    expect(isInSharedNamespace(runtime, 'viking://user/other/memories/shared/default/x.md')).toBe(false);
  });
});

describe('sharedTeamNameForUri', () => {
  it('returns the team segment for current-user shared URIs', () => {
    expect(
      sharedTeamNameForUri(runtime, 'viking://user/test-user/memories/shared/friends/durable/projects/foo/bar.md'),
    ).toBe('friends');
  });

  it('returns undefined for personal or other-user URIs', () => {
    expect(
      sharedTeamNameForUri(runtime, 'viking://user/test-user/memories/durable/projects/foo/bar.md'),
    ).toBeUndefined();
    expect(
      sharedTeamNameForUri(runtime, 'viking://user/other/memories/shared/default/durable/projects/foo/bar.md'),
    ).toBeUndefined();
  });
});

describe('sharedMemoryUriParts', () => {
  it('extracts team and durable project/topic metadata from shared URIs', () => {
    expect(
      sharedMemoryUriParts(
        runtime,
        'viking://user/test-user/memories/shared/default/durable/projects/mobile-native/auth.md',
      ),
    ).toEqual({kind: 'durable', project: 'mobile-native', team: 'default', topic: 'auth'});
  });

  it('returns only the team when the shared URI shape is not a stable durable project memory', () => {
    expect(sharedMemoryUriParts(runtime, 'viking://user/test-user/memories/shared/default/README.md')).toEqual({
      team: 'default',
    });
  });
});

describe('sharedUriFor', () => {
  it('rewrites a personal URI into the team-shared subtree', () => {
    const out = sharedUriFor(runtime, 'viking://user/test-user/memories/durable/projects/foo/bar.md', 'default');
    expect(out).toBe('viking://user/test-user/memories/shared/default/durable/projects/foo/bar.md');
  });

  it('rejects URIs outside the current user namespace', () => {
    expect(() => sharedUriFor(runtime, 'viking://user/other/memories/durable/foo.md', 'default')).toThrow(
      /outside the current user namespace/,
    );
  });
});

describe('vikingUriToWorktreeRelative', () => {
  it('returns the path relative to the team subtree', () => {
    expect(
      vikingUriToWorktreeRelative(
        runtime,
        'viking://user/test-user/memories/shared/default/durable/projects/foo/bar.md',
        'default',
      ),
    ).toBe('durable/projects/foo/bar.md');
  });

  it('rejects URIs outside the team subtree', () => {
    expect(() =>
      vikingUriToWorktreeRelative(runtime, 'viking://user/test-user/memories/shared/friends/durable/x.md', 'default'),
    ).toThrow(/not inside team "default"/);
  });
});

describe('parentUri', () => {
  it('drops the last segment', () => {
    expect(parentUri('viking://user/me/memories/durable/projects/a/b.md')).toBe(
      'viking://user/me/memories/durable/projects/a',
    );
  });

  it('returns the input unchanged when there is no slash', () => {
    expect(parentUri('noslash')).toBe('noslash');
  });
});

describe('sharedDirectoryChain', () => {
  it('returns the directory chain under the shared subtree, including the root', () => {
    const out = sharedDirectoryChain(runtime, 'viking://user/test-user/memories/shared/default/durable/projects/foo');
    expect(out).toEqual([
      'viking://user/test-user/memories/shared/default',
      'viking://user/test-user/memories/shared/default/durable',
      'viking://user/test-user/memories/shared/default/durable/projects',
      'viking://user/test-user/memories/shared/default/durable/projects/foo',
    ]);
  });

  it('returns the input as a single-element chain when it is not under the shared subtree', () => {
    expect(sharedDirectoryChain(runtime, 'viking://other/space/x')).toEqual(['viking://other/space/x']);
  });
});
