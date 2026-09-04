import {describe, expect, it} from 'vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  assertEnrollmentMatchesIdentity,
  casProfilePointer,
  defaultGraphShareProfile,
  graphShareProfileDigest,
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  parseGraphShareProfilePointer,
} from '../../src/code_graph/sharing/profile.js';

const PROFILE = defaultGraphShareProfile({
  branch: 'refs/heads/main',
  canonicalRemote: 'github.com/acme/monorepo',
  organization: 'acme',
  publisherKeyFingerprint: `sha256:${'a'.repeat(64)}`,
  repositoryId: 'b'.repeat(64),
});

describe('graph share enrollment and profile', () => {
  it('parses a closed enrollment pointer and rejects extra fields or credentials', () => {
    const digest = graphShareProfileDigest(PROFILE);
    const enrollment = parseGraphShareEnrollment({
      profile: casProfilePointer(digest),
      publisherKeyFingerprint: PROFILE.trust.publisherKeys[0],
      repositoryId: PROFILE.repositoryId,
      schemaVersion: 1,
    });
    expect(parseGraphShareProfilePointer(enrollment.profile)).toEqual({digest, kind: 'cas'});
    expect(() =>
      parseGraphShareEnrollment({
        ...enrollment,
        credential: 'secret',
      }),
    ).toThrow(/invalid/i);
    expect(() =>
      parseGraphShareEnrollment({
        ...enrollment,
        profile: 'oci://user:token@registry.example/threadnote/profile@sha256:' + 'c'.repeat(64),
      }),
    ).toThrow(/invalid/i);
  });

  it('rejects enrollment when repositoryId does not match the checkout identity', () => {
    const enrollment = parseGraphShareEnrollment({
      profile: casProfilePointer(graphShareProfileDigest(PROFILE)),
      publisherKeyFingerprint: PROFILE.trust.publisherKeys[0],
      repositoryId: PROFILE.repositoryId,
      schemaVersion: 1,
    });
    expect(() => assertEnrollmentMatchesIdentity(enrollment, 'd'.repeat(64))).toThrow(/repositoryId/);
    expect(() => assertEnrollmentMatchesIdentity(enrollment, PROFILE.repositoryId)).not.toThrow();
  });

  it('keeps organization profile digest stable under key reorder', () => {
    FC.assert(
      FC.property(FC.boolean(), reverse => {
        const canonical = parseGraphShareProfile(PROFILE);
        const reordered = parseGraphShareProfile(reorderKeys(canonical, reverse));
        expect(graphShareProfileDigest(reordered)).toBe(graphShareProfileDigest(canonical));
      }),
      {numRuns: 20},
    );
  });
});

function reorderKeys(value: unknown, reverse: boolean): unknown {
  if (Array.isArray(value)) return value.map(item => reorderKeys(item, reverse));
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    const ordered = reverse ? keys.slice().reverse() : keys.slice().sort();
    return Object.fromEntries(ordered.map(key => [key, reorderKeys((value as Record<string, unknown>)[key], reverse)]));
  }
  return value;
}
