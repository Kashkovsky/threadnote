import {describe, expect, it} from 'vitest';
import {
  isInSharedNamespace,
  parentUri,
  sharedDirectoryChain,
  sharedMemoryUriParts,
  sharedTeamNameForUri,
  sharedUriFor,
  resourceUriToWorktreeRelative,
} from '../../src/share/index.js';
import type {ShareRuntime} from '../../src/types.js';

const runtime: ShareRuntime = {
  account: 'local',
  agentContextHome: '/tmp/.threadnote',
  agentId: 'threadnote',
  user: 'test-user',
};

describe('isInSharedNamespace', () => {
  it('returns true for URIs under the user-shared subtree', () => {
    expect(isInSharedNamespace(runtime, 'threadnote://user/test-user/memories/shared/default/durable/x.md')).toBe(true);
  });

  it('returns false for personal memories', () => {
    expect(isInSharedNamespace(runtime, 'threadnote://user/test-user/memories/durable/projects/a.md')).toBe(false);
    expect(isInSharedNamespace(runtime, 'threadnote://user/test-user/memories/handoffs/active/x.md')).toBe(false);
  });

  it('returns false for another user namespace', () => {
    expect(isInSharedNamespace(runtime, 'threadnote://user/other/memories/shared/default/x.md')).toBe(false);
  });
});

describe('sharedTeamNameForUri', () => {
  it('returns the team segment for current-user shared URIs', () => {
    expect(
      sharedTeamNameForUri(runtime, 'threadnote://user/test-user/memories/shared/friends/durable/projects/foo/bar.md'),
    ).toBe('friends');
  });

  it('returns undefined for personal or other-user URIs', () => {
    expect(
      sharedTeamNameForUri(runtime, 'threadnote://user/test-user/memories/durable/projects/foo/bar.md'),
    ).toBeUndefined();
    expect(
      sharedTeamNameForUri(runtime, 'threadnote://user/other/memories/shared/default/durable/projects/foo/bar.md'),
    ).toBeUndefined();
  });
});

describe('sharedMemoryUriParts', () => {
  it('extracts team and durable project/topic metadata from shared URIs', () => {
    expect(
      sharedMemoryUriParts(
        runtime,
        'threadnote://user/test-user/memories/shared/default/durable/projects/mobile-native/auth.md',
      ),
    ).toEqual({kind: 'durable', project: 'mobile-native', team: 'default', topic: 'auth'});
  });

  it('returns only the team when the shared URI shape is not a stable durable project memory', () => {
    expect(sharedMemoryUriParts(runtime, 'threadnote://user/test-user/memories/shared/default/README.md')).toEqual({
      team: 'default',
    });
  });
});

describe('sharedUriFor', () => {
  it('rewrites a personal URI into the team-shared subtree', () => {
    const out = sharedUriFor(runtime, 'threadnote://user/test-user/memories/durable/projects/foo/bar.md', 'default');
    expect(out).toBe('threadnote://user/test-user/memories/shared/default/durable/projects/foo/bar.md');
  });

  it('rejects URIs outside the current user namespace', () => {
    expect(() => sharedUriFor(runtime, 'threadnote://user/other/memories/durable/foo.md', 'default')).toThrow(
      /outside the current user namespace/,
    );
  });
});

describe('resourceUriToWorktreeRelative', () => {
  it('returns the path relative to the team subtree', () => {
    expect(
      resourceUriToWorktreeRelative(
        runtime,
        'threadnote://user/test-user/memories/shared/default/durable/projects/foo/bar.md',
        'default',
      ),
    ).toBe('durable/projects/foo/bar.md');
  });

  it('rejects URIs outside the team subtree', () => {
    expect(() =>
      resourceUriToWorktreeRelative(
        runtime,
        'threadnote://user/test-user/memories/shared/friends/durable/x.md',
        'default',
      ),
    ).toThrow(/not inside team "default"/);
  });
});

describe('parentUri', () => {
  it('drops the last segment', () => {
    expect(parentUri('threadnote://user/me/memories/durable/projects/a/b.md')).toBe(
      'threadnote://user/me/memories/durable/projects/a',
    );
  });

  it('returns the input unchanged when there is no slash', () => {
    expect(parentUri('noslash')).toBe('noslash');
  });
});

describe('sharedDirectoryChain', () => {
  it('returns the directory chain under the shared subtree, including the root', () => {
    const out = sharedDirectoryChain(
      runtime,
      'threadnote://user/test-user/memories/shared/default/durable/projects/foo',
    );
    expect(out).toEqual([
      'threadnote://user/test-user/memories/shared/default',
      'threadnote://user/test-user/memories/shared/default/durable',
      'threadnote://user/test-user/memories/shared/default/durable/projects',
      'threadnote://user/test-user/memories/shared/default/durable/projects/foo',
    ]);
  });

  it('returns the input as a single-element chain when it is not under the shared subtree', () => {
    expect(sharedDirectoryChain(runtime, 'threadnote://other/space/x')).toEqual(['threadnote://other/space/x']);
  });
});
