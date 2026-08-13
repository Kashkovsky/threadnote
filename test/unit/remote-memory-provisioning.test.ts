import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  decodeStoredSharePolicyDocument,
  requireNoImplicitSharePolicyChange,
  STORED_SHARE_POLICY_MAX_BYTES,
  validateRemoteMemoryProvisioningInput,
  type RemoteMemoryProvisioningInput,
} from '../../src/remote_memory/postgres_control_plane.js';

const validProvisioning: RemoteMemoryProvisioningInput = {
  allowedProjects: ['threadnote'],
  capabilities: ['memory:read', 'memory:write:durable'],
  cursorAttestationRequired: true,
  cursorOwnerIds: ['12345'],
  cursorSubjects: ['user:12345'],
  cursorTeamId: '6789',
  displayName: 'Threadnote managed memory',
  featureFlags: ['remote_memory_read', 'remote_memory_durable_write', 'cursor_oidc_required', 'remote_memory_ga'],
  issuer: 'https://identity.example.test',
  policyVersion: 'grant-v1',
  principalId: 'principal-1',
  projects: ['threadnote'],
  region: 'eu-example-1',
  repositoryBindings: {threadnote: ['https://github.com/example/threadnote.git']},
  shareId: 'share-1',
  sharePolicyVersion: 'share-v1',
  subject: 'oauth-subject',
  tenantId: 'tenant-1',
};

describe('remote memory provisioning boundary', () => {
  it('accepts one end-to-end addressable Cursor share policy', () => {
    expect(() => validateRemoteMemoryProvisioningInput(validProvisioning)).not.toThrow();
  });

  it.each([
    ['share id', {shareId: 'share:unaddressable'}],
    ['project path', {allowedProjects: ['bad/project']}],
    [
      'noncanonical repository port',
      {repositoryBindings: {threadnote: ['https://github.com:8443/example/threadnote']}},
    ],
    ['scheme-free repository', {repositoryBindings: {threadnote: ['github.com/example/threadnote']}}],
    ['noncanonical issuer', {issuer: 'https://identity.example.test/'}],
    ['insecure issuer', {issuer: 'http://identity.example.test'}],
    ['blank subject', {subject: '  '}],
  ] as const)('rejects an unaddressable %s before storage', (_label, invalid) => {
    expect(() => validateRemoteMemoryProvisioningInput({...validProvisioning, ...invalid})).toThrow();
  });

  it('decodes bounded JSONB text without relying on the PostgreSQL driver JSON representation', () => {
    const json = '{"displayName": "Threadnote managed memory", "projects": ["threadnote"]}';

    expect(decodeStoredSharePolicyDocument(json)).toEqual({
      displayName: 'Threadnote managed memory',
      projects: ['threadnote'],
    });
  });

  it.each([undefined, null, {}, '', 'not-json', '[]', `{"value":"${'a'.repeat(STORED_SHARE_POLICY_MAX_BYTES)}"}`])(
    'rejects an unsafe stored share-policy representation %#',
    stored => {
      expect(() => decodeStoredSharePolicyDocument(stored)).toThrow('cannot be safely compared');
    },
  );

  it('compares nested share policy objects independent of JSONB key order', () => {
    const input: RemoteMemoryProvisioningInput = {
      ...validProvisioning,
      projects: ['threadnote', 'api'],
      repositoryBindings: {
        api: ['https://github.com/example/api.git'],
        threadnote: ['https://github.com/example/threadnote.git'],
      },
    };
    const stored = storedSharePolicy(input, {
      threadnote: ['https://github.com/example/threadnote.git'],
      api: ['https://github.com/example/api.git'],
    });

    expect(() => requireNoImplicitSharePolicyChange(input, stored)).not.toThrow();
  });

  it('preserves implicit share policies across arbitrary repository-binding insertion order', () => {
    const entry = fc.record({
      project: fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/u),
      repositories: fc.uniqueArray(
        fc.constantFrom(
          'https://github.com/example/one.git',
          'https://github.com/example/two.git',
          'https://github.com/example/three.git',
        ),
        {maxLength: 3},
      ),
    });
    fc.assert(
      fc.property(fc.uniqueArray(entry, {maxLength: 8, selector: value => value.project}), entries => {
        const inputBindings = Object.fromEntries(entries.map(value => [value.project, value.repositories]));
        const storedBindings = Object.fromEntries(
          [...entries].reverse().map(value => [value.project, [...value.repositories].sort()] as const),
        );
        const input: RemoteMemoryProvisioningInput = {
          ...validProvisioning,
          projects: entries.map(value => value.project),
          repositoryBindings: inputBindings,
        };

        expect(() => requireNoImplicitSharePolicyChange(input, storedSharePolicy(input, storedBindings))).not.toThrow();
      }),
      {numRuns: 100},
    );
  });
});

function storedSharePolicy(
  input: RemoteMemoryProvisioningInput,
  repositoryBindings: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, unknown>> {
  return {
    cursorTeamId: input.cursorTeamId ?? null,
    displayName: input.displayName,
    featureFlags: [...new Set(input.featureFlags ?? ['remote_memory_read'])].sort(),
    projects: [...new Set(input.projects ?? Object.keys(repositoryBindings))].sort(),
    repositoryBindings,
  };
}
