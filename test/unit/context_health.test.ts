import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import type {MemoryMetadata, MemoryRecord} from '../../src/memory/document.js';
import {buildContextHealthReport} from '../../src/memory/context_health.js';

const now = new Date('2026-09-17T12:00:00.000Z');

function record(uri: string, body: string, metadata: Partial<MemoryMetadata> = {}): MemoryRecord {
  const complete = {
    kind: 'durable' as const,
    project: 'threadnote',
    sourceAgentClient: 'codex',
    status: 'active' as const,
    timestamp: '2026-09-01T00:00:00.000Z',
    topic: 'context-health',
    ...metadata,
  };
  return {
    body,
    content: [
      'MEMORY',
      `kind: ${complete.kind}`,
      `status: ${complete.status}`,
      `project: ${complete.project}`,
      `topic: ${complete.topic}`,
      `source_agent_client: ${complete.sourceAgentClient}`,
      `timestamp: ${complete.timestamp}`,
      '',
      body,
    ].join('\n'),
    headerTitle: complete.kind === 'handoff' ? 'HANDOFF' : 'MEMORY',
    metadata: complete,
    uri,
  };
}

describe('buildContextHealthReport', () => {
  it('reports independently actionable health findings from supplied evidence', () => {
    const expired = record('threadnote://user/me/memories/durable/projects/threadnote/expired.md', 'expired', {
      validTo: '2026-09-16T00:00:00.000Z',
    });
    const reviewed = record('threadnote://user/me/memories/durable/projects/threadnote/review.md', 'review', {
      reviewAfter: '2026-09-16',
    });
    const cited = record('threadnote://user/me/memories/durable/projects/threadnote/cited.md', 'citation');
    const related = record('threadnote://user/me/memories/durable/projects/threadnote/related.md', 'relation', {
      relations: [
        {type: 'depends_on', uri: 'threadnote://memory/tn_missing'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_inactive'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_conflicted'},
      ],
    });
    const first = record('threadnote://user/me/memories/durable/projects/threadnote/first.md', 'same body');
    const second = record('threadnote://user/me/memories/durable/projects/threadnote/second.md', 'same body');

    const report = buildContextHealthReport({
      candidateEvidence: [
        {candidateId: 'contradiction', comparison: 'contradiction', project: 'threadnote'},
        {candidateId: 'possible', comparison: 'possible_duplicate', project: 'threadnote'},
      ],
      citationValidations: [
        {
          receipts: [
            receipt('changed', 'source-changed'),
            receipt('deleted', 'source-deleted'),
            receipt('unknown', 'repository-unavailable'),
          ],
          uri: cited.uri,
        },
      ],
      now,
      project: 'threadnote',
      records: [
        second,
        related,
        cited,
        reviewed,
        expired,
        first,
        record('threadnote://user/me/memories/durable/projects/other/other.md', 'other', {project: 'other'}),
      ],
      relationEvidence: [
        {sourceUri: related.uri, status: 'missing', targetUri: 'threadnote://memory/tn_missing'},
        {sourceUri: related.uri, status: 'inactive', targetUri: 'threadnote://memory/tn_inactive'},
        {sourceUri: related.uri, status: 'conflicted', targetUri: 'threadnote://memory/tn_conflicted'},
      ],
    });

    expect(report.findings.map(finding => finding.category)).toEqual([
      'validity-expired',
      'citation-changed',
      'citation-missing',
      'relation-target-missing',
      'relation-target-inactive',
      'relation-target-conflicted',
      'review-overdue',
      'exact-duplicate',
      'candidate-contradiction',
      'candidate-possible-duplicate',
      'citation-unknown',
    ]);
    expect(report.findings.every(finding => finding.repair !== undefined)).toBe(true);
    expect(report.findings.find(finding => finding.category === 'citation-unknown')).toMatchObject({
      confidence: 'low',
      repairability: 'requires-evidence',
    });
    expect(report.recordsScanned).toBe(6);
  });

  it('is deterministic, bounded, and does not mutate inputs', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z]{1,12}$/u), {maxLength: 40}), values => {
        const records = values.map((body, index) =>
          record(`threadnote://user/me/memories/durable/projects/threadnote/${index}.md`, body, {
            validTo: index % 2 === 0 ? '2026-09-16T00:00:00.000Z' : undefined,
          }),
        );
        const original = structuredClone(records);
        const input = {limit: 7, now, project: 'threadnote', records};
        const first = buildContextHealthReport(input);
        const second = buildContextHealthReport({...input, records: [...records].reverse()});
        expect(first).toEqual(second);
        expect(first.findings.length).toBeLessThanOrEqual(7);
        expect(first.omittedFindings).toBeGreaterThanOrEqual(0);
        expect(records).toEqual(original);
      }),
      {numRuns: 50},
    );
  });

  it('applies URI scoping before the finding limit while retaining cross-record evidence', () => {
    fc.assert(
      fc.property(fc.integer({min: 101, max: 180}), unrelatedCount => {
        const affected = record('threadnote://user/me/memories/durable/projects/threadnote/affected.md', 'same body');
        const duplicate = record('threadnote://user/me/memories/durable/projects/threadnote/duplicate.md', 'same body');
        const unrelated = Array.from({length: unrelatedCount}, (_, index) =>
          record(`threadnote://user/me/memories/durable/projects/threadnote/unrelated-${index}.md`, `${index}`, {
            validTo: '2026-09-16T00:00:00.000Z',
          }),
        );
        const report = buildContextHealthReport({
          includeFindingUris: [affected.uri],
          now,
          project: 'threadnote',
          records: [...unrelated, duplicate, affected],
        });

        expect(report.findings).toEqual([expect.objectContaining({category: 'exact-duplicate'})]);
        expect(report.omittedFindings).toBe(0);
      }),
      {numRuns: 20},
    );
  });
});

function receipt(
  status: 'changed' | 'deleted' | 'unknown',
  reason: 'repository-unavailable' | 'source-changed' | 'source-deleted',
) {
  return {
    candidateCount: 0,
    citationId: `tncc_${status}`,
    coverage: status === 'unknown' ? ('incomplete' as const) : ('current-complete' as const),
    kind: 'file' as const,
    observedAt: now.toISOString(),
    reason,
    status,
    strategy: 'none' as const,
    validatorVersion: 1 as const,
  };
}
