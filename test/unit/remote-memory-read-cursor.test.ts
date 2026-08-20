import {describe, expect, it} from 'vitest';
import type {AuthorizedRemotePrincipal} from '../../src/remote_memory/authorization.js';
import {
  decodeRemoteMemoryReadCursor,
  encodeRemoteMemoryReadCursor,
  remoteMemoryReadCursorKey,
} from '../../src/remote_memory/read_cursor.js';

describe('remote memory read cursor', () => {
  it('round-trips revision-pinned state and rejects tampering, another principal, and expiry', () => {
    const principal = remotePrincipal('principal-1');
    const key = remoteMemoryReadCursorKey(principal);
    const state = {
      contentHash: 'a'.repeat(64),
      expiresAt: 10_000,
      mode: 'content' as const,
      position: {characterOffset: 1234, resourceIndex: 0},
      revision: 'revision-1',
      section: '## Contract',
      uri: 'threadnote://share/share-1/memories/durable/threadnote/contract.md',
    };
    const cursor = encodeRemoteMemoryReadCursor(state, key);

    expect(cursor).toMatch(/^tnrr1\.[0-9a-f]{64}\.[A-Za-z0-9_-]+$/u);
    expect(cursor).not.toContain(state.uri);
    expect(decodeRemoteMemoryReadCursor(cursor, key, 9_999)).toEqual(state);
    expect(decodeRemoteMemoryReadCursor(cursor, key, 10_000)).toBeUndefined();
    expect(decodeRemoteMemoryReadCursor(`${cursor.slice(0, -1)}A`, key, 9_999)).toBeUndefined();
    expect(decodeRemoteMemoryReadCursor(cursor, remoteMemoryReadCursorKey(remotePrincipal('principal-2')), 9_999)).toBe(
      undefined,
    );
  });
});

function remotePrincipal(principalId: string): AuthorizedRemotePrincipal {
  return {
    allowedProjects: 'all',
    attestationRequiredForWrites: false,
    capabilities: new Set(['memory:read']),
    cursorOwnerIds: new Set(),
    cursorSubjects: new Set(),
    featureFlags: new Set(['remote_memory_ga', 'remote_memory_read']),
    OAuth: {issuer: 'https://auth.example.test', scopes: new Set(['memory:read']), subject: principalId},
    policyDigest: 'policy-digest',
    policyVersion: 'policy-v1',
    principalId,
    repositoriesByProject: new Map(),
    repositoryBindings: new Set(),
    shareId: 'share-1',
    sharePolicyDigest: 'share-policy-digest',
    sharePolicyVersion: 'share-policy-v1',
    tenantId: 'tenant-1',
  };
}
