import {selectRemoteCanonicalCitations} from '../../src/remote_memory/citation_sources.js';
import {createMemoryCodeCitation} from '../../src/memory/code_citation.js';
import {requestFingerprint} from '../../src/remote_memory/remember_fingerprint.js';
import type {AuthorizedRemotePrincipal} from '../../src/remote_memory/authorization.js';
import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {normalizeRemoteCitationSources} from '../../src/memory_domain/citation_sources.js';
import {parseRemoteRememberInputV1} from '../../src/memory_domain/contracts.js';
import {
  durableProposalPayload,
  durableProposalRememberInput,
  remoteDurableProposalRequestHash,
} from '../../src/remote_memory/proposals.js';
import {makeRemoteDocument} from '../../src/remote_memory/remote_document.js';
import {formatMemoryDocument, parseMemoryDocument} from '../../src/memory/document.js';
import {richRemoteMemoryMetadata} from '../helpers/remote-memory-document.js';

const uri = 'threadnote://share/share-1/memories/durable/project/donor.md';
const citationId = `tncc_${'a'.repeat(40)}`;
const input = {
  kind: 'durable' as const,
  operationId: 'operation',
  project: 'project',
  text: 'Body.',
  topic: 'target',
  version: 1 as const,
};

describe('remote citation selectors', () => {
  it('normalizes permutations and duplicates without changing input or proposal identity', () => {
    FC.assert(
      FC.property(FC.array(FC.integer({min: 0, max: 99}), {maxLength: 4}), values => {
        const sources = values.map(value => ({uri, citationId: `tncc_${value.toString(16).padStart(40, '0')}`}));
        const before = structuredClone(sources);
        const reversed = [...sources, ...sources].reverse();
        expect(normalizeRemoteCitationSources(reversed)).toEqual(normalizeRemoteCitationSources(sources));
        expect(sources).toEqual(before);
        const hash = (citationSources: typeof sources) =>
          remoteDurableProposalRequestHash({
            operationId: 'operation',
            payload: {...input, citationSources},
            principalId: 'principal',
            tenantId: 'tenant',
            shareId: 'share-1',
          });
        expect(hash(reversed)).toBe(hash(sources));
        const principal = {shareId: 'share-1'} as AuthorizedRemotePrincipal;
        expect(requestFingerprint(principal, {...input, citationSources: reversed})).toBe(
          requestFingerprint(principal, {...input, citationSources: sources}),
        );
      }),
      {numRuns: 100},
    );
  });

  it('rejects aliases, malformed selectors, excess properties, and unbounded lists', () => {
    for (const citationSources of [
      [{uri, citationId, sourceDirty: false}],
      [{uri, citationId: 'invented'}],
      [{uri: 'threadnote://memory/tn_alias', citationId}],
      Array.from({length: 9}, () => ({uri, citationId})),
    ])
      expect(() => parseRemoteRememberInputV1({...input, citationSources})).toThrow();
    expect(() => parseRemoteRememberInputV1({...input, codeCitations: []})).toThrow();
  });

  it('fails closed for missing IDs, inactive bodies, malformed and unsafe donor evidence', () => {
    const metadata = {...richRemoteMemoryMetadata(), project: 'project', topic: 'donor'};
    const citation = metadata.codeCitations![0];
    const {id: _id, ...citationInput} = citation;
    const sources = [{uri, citationId: citation.id}];
    const body = formatMemoryDocument('MEMORY', metadata, 'Donor.');
    expect(selectRemoteCanonicalCitations(uri, body, sources)).toEqual([citation]);
    expect(() => selectRemoteCanonicalCitations(uri, body, [{uri, citationId}])).toThrow('does not exist');
    for (const content of [
      body.replace('status: active', 'status: archived'),
      body.replace('code_citation: {', 'code_citation: invalid{'),
      body.replace(`schema_version: ${metadata.schemaVersion}`, 'schema_version: 999'),
      formatMemoryDocument(
        'MEMORY',
        {...metadata, codeCitations: [createMemoryCodeCitation({...citationInput, sourceDirty: true})]},
        'Dirty.',
      ),
      formatMemoryDocument(
        'MEMORY',
        {...metadata, codeCitations: [createMemoryCodeCitation({...citationInput, repositoryIdentityKind: 'local'})]},
        'Local.',
      ),
    ])
      expect(() => selectRemoteCanonicalCitations(uri, content, sources)).toThrow();
  });

  it('preserves selector omission and explicit clear through proposal storage and approval', () => {
    const omitted = durableProposalPayload(input);
    expect(omitted).not.toHaveProperty('citationSources');
    expect(durableProposalRememberInput(omitted, 'approval')).not.toHaveProperty('citationSources');
    const clear = durableProposalPayload({...input, citationSources: []});
    expect(durableProposalRememberInput(clear, 'approval').citationSources).toEqual([]);
  });

  it('preserves, clears, or replaces immutable citations independently from body edits', () => {
    const metadata = richRemoteMemoryMetadata();
    const prior = formatMemoryDocument('MEMORY', metadata, 'Before');
    const render = (hasCurrent: boolean, citations?: typeof metadata.codeCitations) =>
      parseMemoryDocument(
        uri,
        makeRemoteDocument(
          input,
          hasCurrent,
          uri,
          'remote',
          new Date('2026-09-16T00:00:00Z'),
          hasCurrent ? prior : undefined,
          'tn_test',
          citations,
        ).content,
      )?.metadata.codeCitations;
    expect(render(false)).toBeUndefined();
    expect(render(true)).toEqual(metadata.codeCitations);
    expect(render(true, [])).toBeUndefined();
    expect(render(false, metadata.codeCitations)).toEqual(metadata.codeCitations);
  });
});
