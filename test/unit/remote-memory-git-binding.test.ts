import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {assertGitMemoryBinding, requireGitMemoryBinding} from '../../src/remote_memory/git_binding.js';
import {remoteMemoryConfigFromEnvironment} from '../../src/remote_memory/config.js';

const id = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/u);

describe('Git deployment binding', () => {
  it('admits exactly the bound tenant/share pair', () => {
    fc.assert(
      fc.property(id, id, id, id, (tenantId, shareId, otherTenant, otherShare) => {
        const binding = requireGitMemoryBinding({tenantId, shareId});
        const scope = {tenantId: otherTenant, shareId: otherShare};
        if (tenantId === otherTenant && shareId === otherShare) {
          expect(() => assertGitMemoryBinding(binding, scope)).not.toThrow();
        } else {
          expect(() => assertGitMemoryBinding(binding, scope)).toThrow('outside');
        }
        expect(() => assertGitMemoryBinding(binding, {tenantId, shareId})).not.toThrow();
        expect(() => assertGitMemoryBinding(undefined, scope)).not.toThrow();
      }),
      {numRuns: 100},
    );
  });

  it('requires complete deployment scope in Git mode', () => {
    const environment = {
      THREADNOTE_REMOTE_CANONICAL_STORE: 'git',
      THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE: '/tmp/org-memory',
      THREADNOTE_REMOTE_DATABASE_URL: 'postgresql://localhost/fixture',
      THREADNOTE_REMOTE_PUBLIC_URL: 'http://localhost:8787',
      THREADNOTE_REMOTE_OAUTH_ISSUER: 'http://localhost:9000',
    };
    expect(() => remoteMemoryConfigFromEnvironment(environment)).toThrow('binding');
    expect(() =>
      remoteMemoryConfigFromEnvironment({...environment, THREADNOTE_REMOTE_MEMORY_GIT_TENANT_ID: 'tenant'}),
    ).toThrow('binding');
    expect(() =>
      remoteMemoryConfigFromEnvironment({...environment, THREADNOTE_REMOTE_MEMORY_GIT_SHARE_ID: 'share'}),
    ).toThrow('binding');
    expect(
      remoteMemoryConfigFromEnvironment({
        ...environment,
        THREADNOTE_REMOTE_MEMORY_GIT_TENANT_ID: 'tenant',
        THREADNOTE_REMOTE_MEMORY_GIT_SHARE_ID: 'share',
      }).gitBinding,
    ).toEqual({tenantId: 'tenant', shareId: 'share'});
  });

  it('copies and freezes the binding instead of retaining mutable caller input', () => {
    const input = {tenantId: 'tenant', shareId: 'share'};
    const binding = requireGitMemoryBinding(input);
    input.shareId = 'different';
    expect(binding).toEqual({tenantId: 'tenant', shareId: 'share'});
    expect(Object.isFrozen(binding)).toBe(true);
  });
});
