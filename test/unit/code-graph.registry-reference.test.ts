import {describe, expect, it} from 'vitest';
import * as FC from 'effect/testing/FastCheck';
import {parseGraphShareRegistryTarget} from '../../src/code_graph/sharing/registry_reference.js';
import {parseGraphShareRegistryChallenge} from '../../src/code_graph/sharing/registry_auth.js';

const name = FC.array(FC.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), {minLength: 1, maxLength: 20}).map(
  chars => chars.join(''),
);
describe('trusted registry targets', () => {
  it('keeps generated repositories and token scopes confined to their exact authority', () => {
    FC.assert(
      FC.property(
        name,
        FC.array(name, {minLength: 1, maxLength: 5}),
        FC.integer({min: 1, max: 65535}),
        (host, parts, port) => {
          const reference = `oci://registry-${host}.example.test:${port}/${parts.join('/')}`;
          const target = parseGraphShareRegistryTarget(reference);
          expect(target.repository).toBe(parts.join('/'));
          expect(target.origin).toBe(new URL(`https://registry-${host}.example.test:${port}`).origin);
          expect(target.pullScope).toBe(`repository:${parts.join('/')}:pull`);
          expect(new URL(`/v2/${target.repository}/blobs/sha256:abc`, target.origin).pathname).toBe(
            `/v2/${parts.join('/')}/blobs/sha256:abc`,
          );
          expect(
            parseGraphShareRegistryChallenge(
              `Bearer realm="${target.origin}/token",scope="${target.pullScope}"`,
              target,
            ),
          ).toEqual({kind: 'bearer', realm: `${target.origin}/token`});
          expect(() =>
            parseGraphShareRegistryChallenge(
              `Bearer realm="${target.origin}/token",scope="${target.pullScope},push"`,
              target,
            ),
          ).toThrow();
        },
      ),
      {numRuns: 80},
    );
  });
  it('rejects credentials, path aliases, unsupported schemes, case changes and invalid ports', () => {
    for (const value of [
      'https://registry.example.test/repo',
      'oci://127.1/repo',
      'oci://900.555.66/repo',
      'oci://user@registry.example.test/repo',
      'oci://registry.example.test/a/../other',
      'oci://registry.example.test/a/%2e%2e/other',
      'oci://registry.example.test/a//b',
      'oci://registry.example.test/A',
      'oci://registry.example.test/repo?other',
      'oci://registry.example.test/repo#tag',
      'oci://registry.example.test:0/repo',
      'oci://registry.example.test:65536/repo',
      'oci://registry.example.test:0443/repo',
      'oci://registry.example.test/' + 'a'.repeat(256),
    ])
      expect(() => parseGraphShareRegistryTarget(value)).toThrow();
  });
  it('rejects ambiguous, malformed and foreign authentication challenges', () => {
    const target = parseGraphShareRegistryTarget('oci://registry.example.test/repo');
    for (const value of [
      undefined,
      'Digest realm="fixture"',
      'Bearer realm="https://foreign.example.test/token"',
      'Bearer realm="https://registry.example.test/token",realm="https://foreign.example.test/token"',
      'Bearer realm="https://registry.example.test/../token"',
      'Bearer realm="https://registry.example.test/%74oken"',
      'Bearer realm="https://registry.example.test/token#fragment"',
      'Bearer realm="https://user@registry.example.test/token"',
    ])
      expect(() => parseGraphShareRegistryChallenge(value, target)).toThrow();
  });
});
