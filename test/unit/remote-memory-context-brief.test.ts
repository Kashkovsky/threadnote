import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import type {RemoteMemoryReceiptV1} from '../../src/memory_domain/receipts.js';
import {
  normalizeRemoteContextBriefAnchors,
  projectRemoteContextBrief,
  remoteContextBriefAnchorSelectors,
} from '../../src/remote_memory/context_brief.js';

const receipt: RemoteMemoryReceiptV1 = {
  consistency: 'current',
  indexedGeneration: 1,
  policyVersion: 'policy-v1',
  requestId: 'request-1',
  shareGeneration: 1,
  shareId: 'share-1',
  sharePolicyVersion: 'share-policy-v1',
  tenantId: 'tenant-1',
  version: 1,
};

describe('remote Context Brief', () => {
  it('derives the same opaque selector set for every anchor order', () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}$/u);
    const anchor = fc.record({
      path: fc.array(segment, {minLength: 1, maxLength: 3}).map(segments => `${segments.join('/')}.ts`),
      repositoryId: fc.stringMatching(/^[a-f]{64}$/u),
    });
    fc.assert(
      fc.property(fc.array(anchor, {maxLength: 8}), anchors => {
        const forward = remoteContextBriefAnchorSelectors(anchors)
          .map(selector => selector.selectorDigest)
          .sort();
        const backward = remoteContextBriefAnchorSelectors([...anchors].reverse())
          .map(selector => selector.selectorDigest)
          .sort();
        expect(backward).toEqual(forward);
      }),
      {numRuns: 50},
    );
  });

  it('deduplicates anchors and preserves remote-only provenance guidance within budget', () => {
    const anchors = normalizeRemoteContextBriefAnchors([
      {path: 'src/remote_memory/tools.ts', repositoryId: 'a'.repeat(64)},
      {path: 'src/remote_memory/tools.ts', repositoryId: 'a'.repeat(64)},
    ])!;
    const projected = projectRemoteContextBrief({
      anchors,
      budgetTokens: 1_500,
      directSearchComplete: true,
      directSearchTruncated: false,
      matchedAnchorOrdinals: [0],
      receipt,
      results: [
        {
          anchorOrdinals: [0],
          evidence: 'anchor',
          excerpt: 'capture-time only',
          kind: 'durable',
          project: 'threadnote',
          revision: 'revision-1',
          score: 1,
          status: 'active',
          topic: 'architecture',
          uri: 'threadnote://share/share-1/memories/durable/threadnote/architecture.md',
        },
        {
          evidence: 'lexical',
          excerpt: 'handoff',
          kind: 'handoff',
          project: 'threadnote',
          revision: 'revision-2',
          score: 0.5,
          status: 'active',
          topic: 'handoff',
          uri: 'threadnote://share/share-1/memories/handoffs/active/threadnote/handoff.md',
        },
      ],
      task: 'Trace the remote brief.',
    });
    const serialized = JSON.stringify(projected);
    expect(
      Buffer.byteLength(projected.text) + Buffer.byteLength(JSON.stringify(projected.structuredContent)),
    ).toBeLessThanOrEqual(1_500 * 3);
    expect(projected.structuredContent.durable).toHaveLength(1);
    expect(projected.structuredContent.activeHandoffs).toHaveLength(1);
    expect(serialized).toContain('capture-time provenance');
    expect(serialized).toContain('threadnote-local');
    expect(serialized).not.toMatch(/\b(exact|relocated)\b/u);
  });

  it('bounds a maximum-length task within the minimum response budget', () => {
    const projected = projectRemoteContextBrief({
      anchors: [],
      budgetTokens: 800,
      directSearchComplete: true,
      directSearchTruncated: false,
      matchedAnchorOrdinals: [],
      receipt,
      results: [],
      task: 'x'.repeat(4_096),
    });

    expect(
      Buffer.byteLength(projected.text) + Buffer.byteLength(JSON.stringify(projected.structuredContent)),
    ).toBeLessThanOrEqual(800 * 3);
    expect(projected.structuredContent.task).toMatchObject({truncated: true});
  });

  it('reports verified anchor matches omitted by the projection budget', () => {
    const projected = projectRemoteContextBrief({
      anchors: [
        {path: 'src/a.ts', repositoryId: 'a'.repeat(64)},
        {path: 'src/b.ts', repositoryId: 'a'.repeat(64)},
      ],
      budgetTokens: 800,
      directSearchComplete: false,
      directSearchTruncated: true,
      matchedAnchorOrdinals: [0, 1],
      receipt,
      results: Array.from({length: 24}, (_, index) => ({
        anchorOrdinals: index === 23 ? [1] : [0],
        evidence: 'anchor' as const,
        excerpt: 'x'.repeat(1_000),
        kind: 'durable' as const,
        project: 'threadnote',
        revision: `revision-${index}`,
        score: 1,
        status: 'active' as const,
        topic: `topic-${index}`,
        uri: `threadnote://share/share-1/memories/durable/threadnote/topic-${index}.md`,
      })),
      task: 'Trace anchors.',
    });
    const anchors = projected.structuredContent.anchors as {
      coverage: {
        directSearchTruncated: boolean;
        matchedAnchorOrdinals: number[];
        omittedMatchedAnchorOrdinals: number[];
        returnedAnchorOrdinals: number[];
        unmatchedAnchorOrdinals: number[];
        unresolvedAnchorOrdinals: number[];
      };
    };

    expect(anchors.coverage).toMatchObject({
      directSearchTruncated: true,
      matchedAnchorOrdinals: [0, 1],
      unmatchedAnchorOrdinals: [],
    });
    expect(anchors.coverage.returnedAnchorOrdinals).toContain(0);
    expect(anchors.coverage.omittedMatchedAnchorOrdinals).toContain(1);
    expect(anchors.coverage.unresolvedAnchorOrdinals).toEqual([]);
  });

  it('keeps absent anchors unresolved while backlink repair is incomplete', () => {
    const projected = projectRemoteContextBrief({
      anchors: [
        {path: 'src/a.ts', repositoryId: 'a'.repeat(64)},
        {path: 'src/b.ts', repositoryId: 'a'.repeat(64)},
      ],
      budgetTokens: 800,
      directSearchComplete: false,
      directSearchTruncated: false,
      matchedAnchorOrdinals: [0],
      receipt,
      results: [],
      task: 'Trace pending repair.',
    });
    const anchors = projected.structuredContent.anchors as {
      coverage: {unmatchedAnchorOrdinals: number[]; unresolvedAnchorOrdinals: number[]};
    };

    expect(anchors.coverage.unmatchedAnchorOrdinals).toEqual([]);
    expect(anchors.coverage.unresolvedAnchorOrdinals).toEqual([1]);
  });
});
