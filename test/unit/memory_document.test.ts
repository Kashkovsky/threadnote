import {describe, expect, it} from 'vitest';
import {
  boundedMemoryAuthority,
  boundedMemoryTrust,
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  formatMemoryDocumentWithKeywords,
  inferMemoryMetadata,
  parseMemoryDocument,
  type MemoryMetadata,
} from '../../src/memory_document.js';

describe('memory document contract', () => {
  it('preserves the legacy document format when versioned metadata is absent', () => {
    const metadata: MemoryMetadata = {
      kind: 'durable',
      project: 'threadnote',
      references: ['threadnote://resources/repos/threadnote/README.md'],
      sourceAgentClient: 'codex',
      status: 'active',
      timestamp: '2026-07-23T10:00:00.000Z',
      topic: 'recall',
    };

    const document = formatMemoryDocument('MEMORY', metadata, 'Use the shared ranker.');

    expect(document).toBe(
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: threadnote',
        'topic: recall',
        'source_agent_client: codex',
        'timestamp: 2026-07-23T10:00:00.000Z',
        'references: threadnote://resources/repos/threadnote/README.md',
        '',
        'Use the shared ranker.',
      ].join('\n'),
    );
    expect(parseMemoryDocument('threadnote://user/me/memory.md', document)?.metadata).toEqual(metadata);
  });

  it('round-trips authority, validity, provenance, evidence, and typed relations', () => {
    const metadata: MemoryMetadata = {
      authority: 'user_approved',
      candidateId: 'candidate-1',
      createdAt: '2026-07-23T10:00:00.000Z',
      evidence: ['session:turn-12', 'commit:abc123'],
      kind: 'durable',
      keywords: ['stalled worker recovery', 'lease renewal'],
      lastReviewed: '2026-07-23T10:10:00.000Z',
      memoryId: 'tn_01k0example',
      project: 'threadnote',
      relations: [
        {type: 'depends_on', uri: 'threadnote://resources/repos/threadnote/docs/effect.md'},
        {type: 'supersedes', uri: 'threadnote://user/me/memories/old.md'},
      ],
      schemaVersion: 2,
      sourceHash: 'sha256:abc123',
      sourceAgentClient: 'codex',
      sourceCommit: 'abc123',
      sourceObservedAt: '2026-07-23T10:00:00.000Z',
      sourceSessionId: 'session-1',
      status: 'active',
      timestamp: '2026-07-23T10:11:00.000Z',
      topic: 'recall',
      trust: 'approved',
      updatedAt: '2026-07-23T10:11:00.000Z',
      validFrom: '2026-07-23T00:00:00.000Z',
      validTo: '2027-07-23T00:00:00.000Z',
      visibility: 'personal',
      workspaceScope: 'packages/recall',
    };

    const document = formatMemoryDocument('MEMORY', metadata, 'Effect workflows compose upward.');
    const parsed = parseMemoryDocument('threadnote://user/me/memory.md', document);

    expect(parsed?.metadata).toEqual(metadata);
    expect(parsed?.body).toBe('Effect workflows compose upward.');
  });

  it('keeps enriched documents readable through the legacy header contract', () => {
    const document = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        keywords: ['stalled worker recovery', 'automatic task rescheduling'],
        project: 'orion-worker',
        sourceAgentClient: 'codex',
        status: 'active',
        timestamp: '2026-07-23T10:00:00.000Z',
        topic: 'lease-renewal',
      },
      'The coordinator renews worker leases after a stalled heartbeat.',
    );
    const legacyKnownHeaders = Object.fromEntries(
      document
        .slice(0, document.indexOf('\n\n'))
        .split('\n')
        .slice(1)
        .filter(line => !line.startsWith('keywords:'))
        .map(line => {
          const separator = line.indexOf(':');
          return [line.slice(0, separator), line.slice(separator + 1).trim()];
        }),
    );

    expect(legacyKnownHeaders).toMatchObject({
      kind: 'durable',
      project: 'orion-worker',
      source_agent_client: 'codex',
      status: 'active',
      topic: 'lease-renewal',
    });
    expect(document.split('\n\n')[1]).toBe('The coordinator renews worker leases after a stalled heartbeat.');
  });

  it('adds enrichment without dropping unknown headers or rewriting the body', () => {
    const original = [
      'MEMORY',
      'kind: durable',
      'status: active',
      'future_writer_field: preserve-me',
      'keywords: old alias',
      'source_agent_client: codex',
      'timestamp: 2026-07-23T10:00:00.000Z',
      '',
      'Body spacing stays intact.',
      '',
      'Second paragraph.',
      '',
      '<!-- MEMORY_FIELDS',
      '{"version":1}',
      '-->',
    ].join('\n');

    const enriched = formatMemoryDocumentWithKeywords(original, ['new paraphrase', 'another alias']);

    expect(enriched).toContain('future_writer_field: preserve-me');
    expect(enriched).not.toContain('keywords: old alias');
    expect(enriched).toContain('keywords: new paraphrase\nkeywords: another alias');
    expect(enriched.split('\n\n').slice(1).join('\n\n')).toBe(
      ['Body spacing stays intact.', '', 'Second paragraph.'].join('\n'),
    );
    expect(enriched).not.toContain('MEMORY_FIELDS');
  });

  it('excludes the legacy managed memory-fields trailer from the parsed body', () => {
    const document = [
      'MEMORY',
      'kind: durable',
      'status: active',
      'source_agent_client: codex',
      'timestamp: 2026-07-23T10:00:00.000Z',
      '',
      'Only this text belongs to the memory body.',
      '',
      '<!-- MEMORY_FIELDS',
      '{',
      '  "version": 1',
      '}',
      '-->',
    ].join('\n');

    const parsed = parseMemoryDocument('threadnote://user/me/memory.md', document);

    expect(parsed?.body).toBe('Only this text belongs to the memory body.');
    expect(parsed?.content).toBe(document);
    expect(canonicalMemoryDocumentContent(document)).toBe(
      document.slice(0, document.indexOf('\n\n<!-- MEMORY_FIELDS')),
    );
  });

  it('accepts reviewed-candidate authority without allowing ordinary memories to self-elevate', () => {
    const uri = 'threadnote://user/me/memories/durable/projects/threadnote/recall.md';
    expect(boundedMemoryAuthority(uri, {authority: 'canonical_repo', trust: 'approved'})).toBe('agent_generated');
    expect(boundedMemoryTrust(uri, {authority: 'canonical_repo', trust: 'approved'})).toBe('inferred');
    const reviewed: Partial<MemoryMetadata> = {
      authority: 'user_approved',
      candidateId: 'candidate-1',
      lastReviewed: '2026-07-23T10:00:00.000Z',
      sourceObservedAt: '2026-07-23T09:59:00.000Z',
      trust: 'approved',
    };
    expect(boundedMemoryAuthority(uri, reviewed)).toBe('user_approved');
    expect(boundedMemoryTrust(uri, reviewed)).toBe('approved');
    const projectNamedShared = 'threadnote://user/me/memories/durable/projects/shared/topic.md';
    expect(boundedMemoryAuthority(projectNamedShared)).toBe('agent_generated');
    expect(boundedMemoryTrust(projectNamedShared)).toBe('inferred');
    const teamShared = 'threadnote://user/me/memories/shared/team/durable/projects/threadnote/topic.md';
    expect(boundedMemoryAuthority(teamShared)).toBe('reviewed_shared');
    expect(boundedMemoryTrust(teamShared)).toBe('approved');
    const importedResource = 'threadnote://resources/imports/external.md';
    expect(boundedMemoryAuthority(importedResource)).toBe('external');
    expect(boundedMemoryTrust(importedResource)).toBe('untrusted');
    expect(boundedMemoryAuthority(importedResource, undefined, {canonicalResource: true})).toBe('canonical_repo');
    expect(boundedMemoryTrust(importedResource, undefined, {canonicalResource: true})).toBe('approved');
  });

  it('rejects line breaks in scalar and repeated metadata headers', () => {
    const metadata: MemoryMetadata = {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'codex',
      sourceSessionId: 'session-1\ncandidate_id: injected',
      status: 'active',
      timestamp: '2026-07-23T10:00:00.000Z',
      topic: 'recall',
    };

    expect(() => formatMemoryDocument('MEMORY', metadata, 'Body')).toThrow(
      'Memory metadata source_session_id must not contain line breaks.',
    );
    expect(() =>
      formatMemoryDocument(
        'MEMORY',
        {...metadata, evidence: ['safe\nsupersedes: injected'], sourceSessionId: undefined},
        'Body',
      ),
    ).toThrow('Memory metadata evidence must not contain line breaks.');
  });

  it('ignores malformed and untyped relations', () => {
    const parsed = parseMemoryDocument(
      'threadnote://user/me/memory.md',
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'source_agent_client: codex',
        'timestamp: 2026-07-23T10:00:00.000Z',
        'relation: unknown threadnote://user/me/other.md',
        'relation: related_to https://example.com',
        '',
        'Body',
      ].join('\n'),
    );

    expect(parsed?.metadata.relations).toBeUndefined();
  });

  it('infers legacy repo and task aliases', () => {
    expect(
      inferMemoryMetadata(
        ['HANDOFF', 'repo: threadnote', 'task: recall-quality', 'source_agent_client: claude', '', 'Body'].join('\n'),
      ),
    ).toMatchObject({
      kind: 'handoff',
      project: 'threadnote',
      sourceAgentClient: 'claude',
      topic: 'recall-quality',
    });
  });
});
