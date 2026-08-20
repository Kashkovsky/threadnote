import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import type {RemoteMemoryReceiptV1} from '../../src/memory_domain/receipts.js';
import {projectRemoteRecallResponse} from '../../src/remote_memory/recall_projection.js';
import type {RemoteMemoryRecallResult} from '../../src/remote_memory/postgres_repository.js';

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

describe('remote recall projection', () => {
  it('keeps arbitrary ranked prefixes deterministic and within the declared token budget', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({maxLength: 800}), {maxLength: 100}),
        fc.integer({max: 1_500, min: 256}),
        fc.boolean(),
        (excerpts, budgetTokens, explain) => {
          const results = recallResults(excerpts);
          const projected = projectRemoteRecallResponse({receipt, results}, {budgetTokens, explain});
          const responseBytes =
            Buffer.byteLength(projected.text, 'utf8') +
            Buffer.byteLength(JSON.stringify(projected.structuredContent), 'utf8');
          expect(responseBytes).toBeLessThanOrEqual(budgetTokens * 3);
          expect(projected.structuredContent.estimatedTokens).toBe(Math.ceil(responseBytes / 3));
          expect(projected.structuredContent.results.map(result => result.uri)).toEqual(
            results.slice(0, projected.structuredContent.results.length).map(result => result.uri),
          );
          expect(projectRemoteRecallResponse({receipt, results}, {budgetTokens, explain})).toEqual(projected);
          if (!explain) {
            expect(projected.structuredContent.results.every(result => !('excerpt' in result))).toBe(true);
          }
        },
      ),
      {numRuns: 50},
    );
  });
});

function recallResults(excerpts: readonly string[]): RemoteMemoryRecallResult[] {
  return excerpts.map((excerpt, index) => ({
    excerpt,
    kind: index % 2 === 0 ? 'durable' : 'handoff',
    project: 'threadnote',
    revision: `revision-${index}`,
    score: Math.max(0, 1 - index / Math.max(1, excerpts.length)),
    status: 'active',
    topic: `topic-${index}`,
    uri: `threadnote://share/share-1/memories/durable/threadnote/topic-${index}.md`,
  }));
}
