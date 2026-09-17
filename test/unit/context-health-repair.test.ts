import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  applyContextHealthRepairProposalV1,
  contextHealthRepairProposalRevisionV1,
  previewContextHealthRepairPlanV1,
  type ContextHealthRepairProposalV1,
} from '../../src/memory/context_health_repair.js';
import {
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryRecord,
} from '../../src/memory/document.js';
import type {ContextHealthFindingV1, ContextHealthReportV1} from '../../src/memory/context_health.js';

const PROJECT = 'threadnote';
const NOW = '2026-09-17T12:00:00.000Z';

describe('context health repair proposals', () => {
  it('projects exact bounded mutations and leaves evidence inputs unchanged', () => {
    const expired = record('expired', 'Expired memory.', {
      memoryId: 'tn_expired',
      relations: [{type: 'references', uri: 'threadnote://memory/tn_keep'}],
      validTo: '2026-09-16T00:00:00.000Z',
    });
    const duplicate = record('duplicate', 'Duplicate memory.', {memoryId: 'tn_duplicate'});
    const survivor = record('survivor', 'Duplicate memory.', {memoryId: 'tn_survivor'});
    const related = record('related', 'Related memory.', {
      memoryId: 'tn_related',
      relations: [
        {type: 'depends_on', uri: 'threadnote://memory/tn_missing'},
        {type: 'references', uri: 'threadnote://memory/tn_keep'},
      ],
    });
    const report = healthReport([
      finding('validity-expired', 'archive-memory', expired.uri),
      finding('exact-duplicate', 'deduplicate-memory', duplicate.uri, survivor.uri),
      finding('relation-target-missing', 'repair-relation', related.uri, 'threadnote://memory/tn_missing'),
      finding('citation-changed', 'repair-citation', related.uri, `${related.uri}#tncc_changed`),
    ]);
    const records = [expired, duplicate, survivor, related];
    const originalReport = structuredClone(report);
    const originalRecords = structuredClone(records);

    const preview = previewContextHealthRepairPlanV1(report, records);
    const boundedPreview = previewContextHealthRepairPlanV1(report, records, {limit: 3});

    expect(preview.proposals).toHaveLength(4);
    expect(preview.omittedProposals).toBe(0);
    expect(boundedPreview.proposals).toHaveLength(3);
    expect(boundedPreview.omittedProposals).toBe(1);
    expect(preview.sourceOmittedFindings).toBe(0);
    expect(preview.proposals.every(proposal => /^[a-f0-9]{64}$/u.test(proposal.revision))).toBe(true);
    expect(preview.proposals.flatMap(proposal => proposal.preconditions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({expectedProject: PROJECT, uri: expired.uri}),
        expect.objectContaining({expectedProject: PROJECT, uri: duplicate.uri}),
        expect.objectContaining({expectedProject: PROJECT, uri: survivor.uri}),
      ]),
    );
    expect(preview.proposals.map(proposal => proposal.mutation.kind)).toEqual(
      expect.arrayContaining(['archive-memory', 'remove-relations', 'review-only']),
    );
    expect(report).toEqual(originalReport);
    expect(records).toEqual(originalRecords);
  });

  it('applies a relation repair immutably and recognizes its exact postcondition', () => {
    const source = record('source', 'Body is preserved.', {
      memoryId: 'tn_source',
      relations: [
        {type: 'depends_on', uri: 'threadnote://memory/tn_missing'},
        {type: 'references', uri: 'threadnote://memory/tn_keep'},
      ],
    });
    const otherProject = record('other', 'Other project.', {project: 'other'});
    const proposal = onlyProposal(
      healthReport([
        finding('relation-target-missing', 'repair-relation', source.uri, 'threadnote://memory/tn_missing'),
      ]),
      [source, otherProject],
    );
    const original = structuredClone([source, otherProject]);

    const applied = applyContextHealthRepairProposalV1({
      expectedRevision: proposal.revision,
      proposal,
      records: [source, otherProject],
    });

    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('expected relation repair to apply');
    const updated = applied.records.find(item => item.uri === source.uri);
    expect(updated).toMatchObject({
      body: source.body,
      metadata: {
        memoryId: 'tn_source',
        relations: [{type: 'references', uri: 'threadnote://memory/tn_keep'}],
      },
    });
    expect(updated?.content).toContain('unknown_header: preserved');
    expect(applied.records.find(item => item.uri === otherProject.uri)).toBe(otherProject);
    expect([source, otherProject]).toEqual(original);

    const repeated = applyContextHealthRepairProposalV1({
      expectedRevision: proposal.revision,
      proposal,
      records: applied.records,
    });
    expect(repeated).toMatchObject({status: 'already-applied'});
  });

  it('makes archive replay receipt-idempotent and stale snapshots stable conflicts', () => {
    const source = record('source', 'Archive me.', {
      memoryId: 'tn_source',
      relations: [{type: 'references', uri: 'threadnote://memory/tn_keep'}],
      validTo: '2026-09-16T00:00:00.000Z',
    });
    const proposal = onlyProposal(healthReport([finding('validity-expired', 'archive-memory', source.uri)]), [source]);
    const applied = applyContextHealthRepairProposalV1({
      expectedRevision: proposal.revision,
      proposal,
      records: [source],
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('expected archive to apply');
    expect(applied.records).toEqual([]);

    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: proposal.revision,
        proposal,
        receipt: applied.receipt,
        records: applied.records,
      }),
    ).toMatchObject({status: 'already-applied'});

    const missingWithoutReceipt = applyContextHealthRepairProposalV1({
      expectedRevision: proposal.revision,
      proposal,
      records: applied.records,
    });
    const repeatedConflict = applyContextHealthRepairProposalV1({
      expectedRevision: proposal.revision,
      proposal,
      records: applied.records,
    });
    expect(missingWithoutReceipt).toMatchObject({
      conflict: {code: 'subject-missing'},
      status: 'conflict',
    });
    expect(repeatedConflict).toEqual(missingWithoutReceipt);
  });

  it('fails closed across projects, revisions, changed content, and forged receipts', () => {
    const source = record('source', 'Archive me.', {validTo: '2026-09-16T00:00:00.000Z'});
    const proposal = onlyProposal(healthReport([finding('validity-expired', 'archive-memory', source.uri)]), [source]);
    const crossProject = record(
      'source',
      'Archive me.',
      {project: 'other', validTo: '2026-09-16T00:00:00.000Z'},
      source.uri,
    );
    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: proposal.revision,
        proposal,
        records: [crossProject],
      }),
    ).toMatchObject({conflict: {code: 'project-mismatch'}, status: 'conflict'});
    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: '0'.repeat(64),
        proposal,
        records: [source],
      }),
    ).toMatchObject({conflict: {code: 'revision-mismatch'}, status: 'conflict'});
    const changed = record('source', 'Changed after preview.', {validTo: '2026-09-16T00:00:00.000Z'});
    const staleInput = {expectedRevision: proposal.revision, proposal, records: [changed]};
    const stale = applyContextHealthRepairProposalV1(staleInput);
    expect(stale).toMatchObject({conflict: {code: 'precondition-failed'}, status: 'conflict'});
    expect(applyContextHealthRepairProposalV1(staleInput)).toEqual(stale);
    expect(stale.records[0]).toBe(changed);
    expect(
      applyContextHealthRepairProposalV1({
        expectedRevision: proposal.revision,
        proposal,
        receipt: {
          proposalId: proposal.proposalId,
          resultHash: 'f'.repeat(64),
          revision: proposal.revision,
          version: 1,
        },
        records: [],
      }),
    ).toMatchObject({conflict: {code: 'receipt-mismatch'}, status: 'conflict'});
  });

  it('keeps every shared-memory repair review-only', () => {
    const sharedUri = 'threadnote://user/me/memories/shared/default/durable/projects/threadnote/shared.md';
    const shared = record(
      'shared',
      'Shared memory.',
      {
        relations: [{type: 'depends_on', uri: 'threadnote://memory/tn_missing'}],
        validTo: '2026-09-16T00:00:00.000Z',
      },
      sharedUri,
    );
    const survivor = record('survivor', 'Shared memory.');
    const cases = [
      finding('validity-expired', 'archive-memory', sharedUri),
      finding('exact-duplicate', 'deduplicate-memory', sharedUri, survivor.uri),
      finding('relation-target-missing', 'repair-relation', sharedUri, 'threadnote://memory/tn_missing'),
    ];

    for (const item of cases) {
      const proposal = onlyProposal(healthReport([item]), [shared, survivor]);
      expect(proposal.mutation).toMatchObject({kind: 'review-only', subjectUri: sharedUri});
      expect(proposal.preconditions).toEqual([]);
      expect(
        applyContextHealthRepairProposalV1({
          expectedRevision: proposal.revision,
          proposal,
          records: [shared, survivor],
        }),
      ).toMatchObject({status: 'review-required'});
    }
  });

  it('requires manual lifecycle review before archiving preference or smoke memories', () => {
    for (const kind of ['preference', 'smoke'] as const) {
      const source = record(kind, `${kind} memory.`, {
        kind,
        validTo: '2026-09-16T00:00:00.000Z',
      });
      const survivor = record(`${kind}-survivor`, `${kind} memory.`, {kind});
      for (const item of [
        finding('validity-expired', 'archive-memory', source.uri),
        finding('exact-duplicate', 'deduplicate-memory', source.uri, survivor.uri),
      ]) {
        const proposal = onlyProposal(healthReport([item]), [source, survivor]);
        expect(proposal.mutation).toMatchObject({kind: 'review-only', repairKind: item.repair.kind});
        expect(proposal.preconditions).toEqual([]);
      }
    }
  });

  it('keeps proposal identity order-independent and revisions content-sensitive', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z]{1,12}$/u), {maxLength: 30}), values => {
        const records = values.map((value, index) =>
          record(`memory-${index}`, value, {validTo: '2026-09-16T00:00:00.000Z'}),
        );
        const findings = records.map(item => finding('validity-expired', 'archive-memory', item.uri));
        const report = healthReport(findings);
        const forward = previewContextHealthRepairPlanV1(report, records);
        const reverse = previewContextHealthRepairPlanV1(
          {...report, findings: [...findings].reverse()},
          [...records].reverse(),
        );
        expect(reverse).toEqual(forward);
        expect(records.every((item, index) => item.body === values[index])).toBe(true);
      }),
      {numRuns: 50},
    );

    const source = record('source', 'Initial.', {validTo: '2026-09-16T00:00:00.000Z'});
    const findingInput = finding('validity-expired', 'archive-memory', source.uri);
    const first = onlyProposal(healthReport([findingInput]), [source]);
    const changed = onlyProposal(healthReport([findingInput]), [record('source', 'Changed.', source.metadata)]);
    expect(changed.proposalId).toBe(first.proposalId);
    expect(changed.revision).not.toBe(first.revision);
    expect(contextHealthRepairProposalRevisionV1(first)).toBe(first.revision);
  });
});

function onlyProposal(report: ContextHealthReportV1, records: readonly MemoryRecord[]): ContextHealthRepairProposalV1 {
  const proposals = previewContextHealthRepairPlanV1(report, records).proposals;
  expect(proposals).toHaveLength(1);
  return proposals[0];
}

function record(
  topic: string,
  body: string,
  metadata: Partial<MemoryMetadata> = {},
  uri = `threadnote://user/me/memories/durable/projects/${metadata.project ?? PROJECT}/${topic}.md`,
): MemoryRecord {
  const complete: MemoryMetadata = {
    kind: 'durable',
    project: PROJECT,
    sourceAgentClient: 'codex',
    status: 'active',
    timestamp: NOW,
    topic,
    ...metadata,
  };
  const content = formatMemoryDocument(complete.kind === 'handoff' ? 'HANDOFF' : 'MEMORY', complete, body).replace(
    '\n\n',
    '\nunknown_header: preserved\n\n',
  );
  const parsed = parseMemoryDocument(uri, content);
  if (parsed === undefined) throw new Error('invalid test memory');
  return parsed;
}

function healthReport(findings: readonly ContextHealthFindingV1[]): ContextHealthReportV1 {
  return {
    findings,
    limit: 100,
    omittedFindings: 0,
    project: PROJECT,
    recordsScanned: findings.length,
    version: 1,
  };
}

function finding(
  category: ContextHealthFindingV1['category'],
  kind: ContextHealthFindingV1['repair']['kind'],
  subjectUri: string,
  targetUri?: string,
): ContextHealthFindingV1 {
  const uris = [subjectUri, ...(targetUri === undefined || targetUri.includes('#') ? [] : [targetUri])].sort();
  return {
    category,
    confidence: category === 'citation-changed' ? 'medium' : 'high',
    id: [category, ...uris].join('\0'),
    repair: {
      kind,
      subjectUri,
      summary: `Review ${category}.`,
      ...(targetUri === undefined ? {} : {targetUri}),
    },
    repairability: category === 'citation-changed' ? 'reviewable' : 'reviewable',
    severity: category === 'validity-expired' ? 'critical' : 'high',
    summary: category,
    uris,
  };
}
