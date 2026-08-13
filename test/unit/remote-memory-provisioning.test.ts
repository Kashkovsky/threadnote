import {describe, expect, it} from 'vitest';
import {
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
});
