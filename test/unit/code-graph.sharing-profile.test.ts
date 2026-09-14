import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {
  assertEnrollmentMatchesIdentity,
  casProfilePointer,
  defaultGraphShareProfile,
  enrolledProfileBodyDigest,
  graphShareProfileDigest,
  ociProfilePointer,
  parseGraphShareCoordinatorUrl,
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
    expect(parseGraphShareProfilePointer(enrollment.profile)).toEqual({bodyDigest: digest, kind: 'cas'});
    expect(enrolledProfileBodyDigest(enrollment)).toBe(digest);
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

  it('separates the OCI manifest pin from the canonical profile body digest', () => {
    const profileDigest = graphShareProfileDigest(PROFILE);
    const manifestDigest = `sha256:${'c'.repeat(64)}` as const;
    const profile = ociProfilePointer('oci://registry.example.test/acme/canonical', manifestDigest);
    const enrollment = parseGraphShareEnrollment({
      profile,
      profileDigest,
      publisherKeyFingerprint: PROFILE.trust.publisherKeys[0],
      repositoryId: PROFILE.repositoryId,
      schemaVersion: 2,
    });
    expect(enrolledProfileBodyDigest(enrollment)).toBe(profileDigest);
    expect(parseGraphShareProfilePointer(enrollment.profile)).toMatchObject({
      kind: 'oci',
      manifestDigest,
      registryReference: 'oci://registry.example.test/acme/canonical',
    });
    for (const invalid of [
      {...enrollment, profileDigest: undefined},
      {...enrollment, profile: casProfilePointer(profileDigest)},
      {...enrollment, profile: profile.replace('registry.example.test', 'user:secret@registry.example.test')},
      {...enrollment, profile: profile.replace('registry.example.test', 'registry.example.test:443')},
      {...enrollment, profile: profile.replace('acme/canonical', 'Acme/canonical')},
      {...enrollment, extra: 'unexpected'},
      {...enrollment, schemaVersion: 1},
    ])
      expect(() => parseGraphShareEnrollment(invalid)).toThrow(/invalid/i);
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

  it('accepts loopback HTTP coordinator URLs and rejects non-loopback HTTP', () => {
    expect(parseGraphShareCoordinatorUrl('http://127.0.0.1:18765')).toBe('http://127.0.0.1:18765');
    expect(parseGraphShareCoordinatorUrl('http://localhost:9')).toBe('http://localhost:9');
    expect(() => parseGraphShareCoordinatorUrl('http://example.com')).toThrow(/loopback/i);
    expect(() => parseGraphShareCoordinatorUrl('ftp://127.0.0.1')).toThrow(/https or loopback/i);
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
