import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {applyMaintenanceMetadataV1, previewMaintenanceMetadataV1} from '../../src/memory/maintenance_metadata.js';
import {
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryRecord,
} from '../../src/memory/document.js';

const URI = 'threadnote://user/test/memories/durable/projects/threadnote/topic.md';
const NOW = '2026-09-18T12:00:00.000Z';

describe('maintenance metadata proposals', () => {
  it('sets, clears, and preserves independently without changing body or unrelated headers', () => {
    const source = record({owner: 'old', reviewAfter: '2026-10-01T00:00:00.000Z', validTo: '2026-11-01T00:00:00.000Z'});
    const original = `${source.content}\nunknown_header: preserved`;
    const target = parseMemoryDocument(URI, original)!;
    const preview = previewMaintenanceMetadataV1([target], URI, {
      owner: null,
      reviewAfter: '2026-12-01T00:00:00.000Z',
    });
    expect(preview.status).toBe('preview');
    if (preview.status !== 'preview') throw new Error('expected preview');
    const applied = applyMaintenanceMetadataV1({
      approved: true,
      expectedContentHash: preview.proposal.expectedContentHash,
      expectedRevision: preview.proposal.revision,
      proposal: preview.proposal,
      record: target,
      updatedAt: NOW,
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('expected apply');
    const updated = parseMemoryDocument(URI, applied.content)!;
    expect(updated.body).toBe(target.body);
    expect(updated.metadata.owner).toBeUndefined();
    expect(updated.content).toContain('review_after: 2026-12-01T00:00:00.000Z');
    expect(updated.content).toContain('valid_to: 2026-11-01T00:00:00.000Z');
    expect(updated.content).toContain('unknown_header: preserved');
    expect(updated.metadata.memoryId).toBe('tn_topic');
    expect(updated.metadata.relations).toEqual(target.metadata.relations);
  });

  it('fails closed for stale content, shared targets, invalid data, and ambiguous stable IDs', () => {
    const source = record();
    const preview = previewMaintenanceMetadataV1([source], URI, {owner: 'maintainer'});
    expect(preview.status).toBe('preview');
    if (preview.status !== 'preview') throw new Error('expected preview');
    expect(
      applyMaintenanceMetadataV1({
        approved: true,
        expectedContentHash: preview.proposal.expectedContentHash,
        expectedRevision: preview.proposal.revision,
        proposal: preview.proposal,
        record: record({}, URI, 'Changed body.'),
        updatedAt: NOW,
      }),
    ).toMatchObject({code: 'content-changed', status: 'conflict'});
    expect(previewMaintenanceMetadataV1([source], URI, {reviewAfter: '2026-10-01'})).toMatchObject({
      code: 'invalid-date',
    });
    expect(previewMaintenanceMetadataV1([source], URI, {owner: 'token=super-secret'})).toMatchObject({
      code: 'invalid-owner',
    });
    const shared = record({}, 'threadnote://user/test/memories/shared/default/durable/projects/threadnote/topic.md');
    expect(previewMaintenanceMetadataV1([shared], shared.uri, {owner: 'owner'})).toMatchObject({
      code: 'target-ineligible',
    });
    const duplicate = record({memoryId: 'tn_topic'}, URI.replace('topic.md', 'second.md'));
    expect(
      previewMaintenanceMetadataV1([source, duplicate], 'threadnote://memory/tn_topic', {owner: 'owner'}),
    ).toMatchObject({
      code: 'ambiguous-identity',
    });
  });

  it('is deterministically previewed, idempotent after apply, and preserves unrelated metadata for bounded patches', () => {
    fc.assert(
      fc.property(
        fc.option(fc.stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,15}$/u), {nil: undefined}),
        fc.constantFrom<undefined | null | string>(undefined, null, '2026-12-01T00:00:00.000Z'),
        fc.constantFrom<undefined | null | string>(undefined, null, '2027-01-01T00:00:00.000Z'),
        (owner, reviewAfter, validTo) => {
          const source = record({
            owner: 'before',
            reviewAfter: '2026-10-01T00:00:00.000Z',
            validTo: '2026-11-01T00:00:00.000Z',
          });
          const patch = {owner, reviewAfter, validTo};
          const first = previewMaintenanceMetadataV1([source], URI, patch);
          const second = previewMaintenanceMetadataV1([source], URI, patch);
          expect(first).toEqual(second);
          if (first.status !== 'preview') return;
          const applied = applyMaintenanceMetadataV1({
            approved: true,
            expectedContentHash: first.proposal.expectedContentHash,
            expectedRevision: first.proposal.revision,
            proposal: first.proposal,
            record: source,
            updatedAt: NOW,
          });
          expect(applied.status).toBe('applied');
          if (applied.status !== 'applied') return;
          const after = parseMemoryDocument(URI, applied.content)!;
          expect(after.body).toBe(source.body);
          expect(after.metadata.memoryId).toBe(source.metadata.memoryId);
          expect(after.metadata.relations).toEqual(source.metadata.relations);
          expect(
            applyMaintenanceMetadataV1({
              approved: true,
              expectedContentHash: first.proposal.expectedContentHash,
              expectedRevision: first.proposal.revision,
              proposal: first.proposal,
              record: after,
              updatedAt: NOW,
            }),
          ).toMatchObject({status: 'already-applied'});
        },
      ),
      {numRuns: 60},
    );
  });
});

function record(overrides: Partial<MemoryMetadata> = {}, uri = URI, body = 'Body is preserved.'): MemoryRecord {
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId: 'tn_topic',
    project: 'threadnote',
    relations: [{type: 'references', uri: 'threadnote://memory/tn_other'}],
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
  return parseMemoryDocument(uri, formatMemoryDocument('MEMORY', metadata, body))!;
}
