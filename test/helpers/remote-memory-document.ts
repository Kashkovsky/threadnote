import {createMemoryCodeCitation, MEMORY_SCHEMA_VERSION} from '../../src/memory/code_citation.js';
import type {MemoryMetadata} from '../../src/memory/document.js';

export function richRemoteMemoryMetadata(): MemoryMetadata {
  const timestamp = '2026-09-01T10:00:00.000Z';
  return {
    archivedFrom: 'threadnote://memory/tn_previous',
    authority: 'user_approved',
    candidateId: 'candidate-1',
    codeCitations: [
      createMemoryCodeCitation({
        extractorSet: 'native-code-graph-14',
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        path: 'src/example.ts',
        repositoryId: '1'.repeat(64),
        repositoryIdentityKind: 'remote',
        sourceCommit: '2'.repeat(40),
        sourceDirty: false,
        sourceGraphContentId: `cgc_${'3'.repeat(40)}`,
        sourceSnapshotId: `cgsn_${'4'.repeat(40)}`,
        target: {kind: 'file'},
        version: 1,
      }),
    ],
    createdAt: timestamp,
    evidence: ['session:turn-12', 'commit:abc123'],
    kind: 'durable',
    keywords: ['retained-keyword', 'second keyword', 'retained-keyword'],
    lastReviewed: timestamp,
    memoryId: 'tn_rich_memory',
    project: 'restricted',
    references: ['threadnote://memory/tn_first', 'threadnote://memory/tn_second'],
    relations: [
      {type: 'references', uri: 'threadnote://memory/tn_first'},
      {type: 'depends_on', uri: 'threadnote://memory/tn_second'},
    ],
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceHash: 'sha256:abc123',
    sourceAgentClient: 'codex',
    sourceCommit: 'abc123',
    sourceObservedAt: timestamp,
    sourceSessionId: 'session-1',
    status: 'active',
    supersedes: 'threadnote://memory/tn_previous',
    timestamp,
    topic: 'rich',
    trust: 'approved',
    updatedAt: timestamp,
    validFrom: timestamp,
    validTo: '2027-09-01T10:00:00.000Z',
    visibility: 'shared',
    workspaceScope: 'packages/example',
  };
}
