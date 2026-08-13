import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  parseRemoteReadInputV1,
  parseRemoteRecallInputV1,
  parseRemoteRememberInputV1,
} from '../../src/memory_domain/contracts.js';
import {
  inspectRemoteMemoryContent,
  InvalidRemoteMemoryDocument,
  parseRemoteCanonicalMemoryDocument,
} from '../../src/memory_domain/content.js';
import {
  InvalidRemoteMemoryReceipt,
  parseRemoteMemoryReceiptV1,
  type RemoteMemoryReceiptV1,
} from '../../src/memory_domain/receipts.js';

const receipt: RemoteMemoryReceiptV1 = {
  actor: {cloudAgentId: 'agent-1', principalId: 'principal-1', provider: 'cursor', turnId: 'turn-1'},
  consistency: 'recent-write-overlay',
  indexedGeneration: 6,
  policyVersion: 'policy-7',
  sharePolicyVersion: 'share-policy-3',
  requestId: 'request-1',
  revision: 'revision-2',
  shareGeneration: 7,
  shareId: 'share-1',
  tenantId: 'tenant-1',
  uri: 'threadnote://share/share-1/memories/durable/threadnote/decision.md',
  version: 1,
};

describe('remote memory versioned schemas', () => {
  it('parses the transport-neutral recall, read, and remember v1 contracts', () => {
    expect(
      parseRemoteRecallInputV1({kinds: ['durable'], limit: 8, project: 'threadnote', query: 'transport', version: 1}),
    ).toEqual({kinds: ['durable'], limit: 8, project: 'threadnote', query: 'transport', version: 1});
    expect(parseRemoteReadInputV1({revision: 'revision-1', uri: receipt.uri, version: 1})).toEqual({
      revision: 'revision-1',
      uri: receipt.uri,
      version: 1,
    });
    expect(
      parseRemoteRememberInputV1({
        attestationId: 'attestation-1',
        baseRevision: 'revision-1',
        kind: 'handoff',
        lifecycle: {expiresAt: '2026-08-14T12:00:00.000Z', retentionClass: 'standard'},
        operationId: 'operation-1',
        project: 'threadnote',
        text: 'Current status',
        topic: 'cursor-cloud',
        version: 1,
      }),
    ).toMatchObject({kind: 'handoff', operationId: 'operation-1', version: 1});
  });

  it('rejects lifecycle controls for durable memory until durable retention is implemented', () => {
    expect(() =>
      parseRemoteRememberInputV1({
        kind: 'durable',
        lifecycle: {expiresAt: '2026-08-14T12:00:00.000Z', retentionClass: 'standard'},
        operationId: 'operation-1',
        project: 'threadnote',
        text: 'Durable context.',
        topic: 'durable-expiry',
        version: 1,
      }),
    ).toThrow('only supported for handoffs');
  });

  it.each([
    {callerCwd: '/private/vm', project: 'threadnote', query: 'x', version: 1},
    {project: 'threadnote', query: 'x', version: 2},
    {limit: 0, project: 'threadnote', query: 'x', version: 1},
    {kinds: ['incident'], project: 'threadnote', query: 'x', version: 1},
  ])('rejects out-of-contract recall input %#', input => {
    expect(() => parseRemoteRecallInputV1(input)).toThrow();
  });

  it('parses bounded receipts and enforces committed/indexed generation order', () => {
    expect(parseRemoteMemoryReceiptV1(receipt)).toEqual(receipt);
    expect(() => parseRemoteMemoryReceiptV1({...receipt, indexedGeneration: 8})).toThrow(InvalidRemoteMemoryReceipt);
    expect(() => parseRemoteMemoryReceiptV1({...receipt, actor: {principalId: 'sk-abcdefghijklmnop'}})).toThrow(
      InvalidRemoteMemoryReceipt,
    );
  });

  it.prop(
    'never accepts model-visible content or identity fields added to a receipt',
    {
      field: FC.constantFrom('email', 'jwt', 'memoryText', 'query', 'refreshToken', 'source', 'absolutePath'),
      secret: FC.string({maxLength: 64, minLength: 1}),
    },
    ({field, secret}) => {
      expect(() => parseRemoteMemoryReceiptV1({...receipt, [field]: secret})).toThrow();
    },
    {fastCheck: {numRuns: 100}},
  );

  it('validates canonical Markdown identity without returning blocked content in the decision', () => {
    const uri = 'threadnote://share/share-1/memories/durable/threadnote/decision.md';
    const content = [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: threadnote',
      'topic: decision',
      'source_agent_client: cursor',
      'timestamp: 2026-08-13T08:00:00.000Z',
      '',
      'Use immutable revisions.',
    ].join('\n');

    expect(
      parseRemoteCanonicalMemoryDocument({content, kind: 'durable', project: 'threadnote', topic: 'decision', uri}),
    ).toMatchObject({content, kind: 'durable', project: 'threadnote', topic: 'decision', uri, version: 1});
    expect(() =>
      parseRemoteCanonicalMemoryDocument({content, kind: 'durable', project: 'other', topic: 'decision', uri}),
    ).toThrow(InvalidRemoteMemoryDocument);

    const secret = 'sk-abcdefghijklmnop';
    const blocked = inspectRemoteMemoryContent(`Do not store ${secret}`);
    expect(blocked).toEqual({allowed: false, category: 'credential', reason: 'API key (sk-...)', version: 1});
    expect(JSON.stringify(blocked)).not.toContain(secret);

    const localPath = '/workspace/private-repository/src/main.ts';
    const blockedPath = inspectRemoteMemoryContent(`Do not store ${localPath}`);
    expect(blockedPath).toEqual({
      allowed: false,
      category: 'machine_local_path',
      reason: 'Cursor workspace path',
      version: 1,
    });
    expect(JSON.stringify(blockedPath)).not.toContain(localPath);

    const customerMarker = 'CUST-123456';
    const policyBlocked = inspectRemoteMemoryContent(`Do not store ${customerMarker}`, {
      additionalPatterns: [{name: 'customer marker', regex: /\bCUST-\d{6}\b/u}],
    });
    expect(policyBlocked).toEqual({allowed: false, category: 'credential', reason: 'customer marker', version: 1});
    expect(JSON.stringify(policyBlocked)).not.toContain(customerMarker);
  });
});
