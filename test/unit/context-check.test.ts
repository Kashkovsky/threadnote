import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  buildContextHealthReport,
  type ContextHealthFindingV1,
  type ContextHealthReportV1,
} from '../../src/memory/context_health.js';
import type {MemoryRecord} from '../../src/memory/document.js';
import {
  buildContextCheckReport,
  parseContextCheckReportJson,
  projectContextCheckReportSarif,
  serializeContextCheckReportJson,
} from '../../src/context_check/index.js';

function healthReport(findings: readonly ContextHealthFindingV1[], omittedFindings = 0): ContextHealthReportV1 {
  return {findings, limit: 100, omittedFindings, project: 'threadnote', recordsScanned: 4, version: 1};
}

function finding(category: ContextHealthFindingV1['category'], uris: readonly string[]): ContextHealthFindingV1 {
  return {
    category,
    confidence: category === 'citation-unknown' ? 'low' : 'high',
    id: `${category}\u0000${uris.join('\u0000')}`,
    repair: {kind: 'review-memory', summary: 'A reviewable repair.'},
    repairability: category === 'citation-unknown' ? 'requires-evidence' : 'reviewable',
    severity: category === 'citation-unknown' ? 'low' : 'high',
    summary: 'A health finding that intentionally does not contain a memory body.',
    uris,
  };
}

describe('buildContextCheckReport', () => {
  it('preserves exit classification at every output limit, including zero', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('citation-changed' as const, 'citation-unknown' as const), {maxLength: 30}),
        fc.integer({min: 0, max: 30}),
        (categories, limit) => {
          const uris = categories.map((_, index) => `threadnote://memory/${index}`);
          const report = buildContextCheckReport({
            healthReport: healthReport(categories.map((category, index) => finding(category, [uris[index]]))),
            limit,
            selection: {affectedMemoryUris: uris, changedPaths: ['source.ts'], status: 'available'},
          });
          expect(report.exitCode).toBe(categories.includes('citation-unknown') ? 2 : categories.length ? 1 : 0);
          expect(report.findings.length + report.omittedFindings).toBe(categories.length);
          if (report.exitCode === 2 && limit === 0) {
            expect(projectContextCheckReportSarif(report).runs[0].results).toEqual([
              expect.objectContaining({ruleId: 'threadnote/context-check/evidence-unavailable'}),
            ]);
          }
        },
      ),
      {numRuns: 60},
    );
  });

  it('does not let a truncated health scan claim clean', () => {
    expect(
      buildContextCheckReport({
        healthReport: healthReport([], 1),
        limit: 0,
        selection: {affectedMemoryUris: [], changedPaths: [], status: 'available'},
      }),
    ).toMatchObject({evidenceReason: 'health-report-truncated', exitCode: 2});
  });

  it('isolates findings to explicitly affected memories and preserves unknown evidence', () => {
    const report = buildContextCheckReport({
      healthReport: healthReport([
        finding('citation-changed', ['threadnote://memory/changed']),
        finding('citation-unknown', ['threadnote://memory/changed']),
        finding('validity-expired', ['threadnote://memory/unaffected']),
      ]),
      selection: {
        affectedMemoryUris: ['threadnote://memory/changed'],
        changedPaths: ['src/changed.ts'],
        status: 'available',
      },
    });

    expect(report.findings.map(item => item.category)).toEqual(['citation-changed', 'citation-unknown']);
    expect(report.exitClassification).toBe('invalid-or-required-evidence-unavailable');
    expect(report.exitCode).toBe(2);
    expect(report.evidenceStatus).toBe('complete');
    expect(JSON.stringify(report)).not.toContain('A health finding');
  });

  it('retains cross-record findings when only one participant is affected', () => {
    const affected = duplicateRecord('affected');
    const unaffected = duplicateRecord('unaffected');
    const report = buildContextCheckReport({
      healthReport: buildContextHealthReport({
        now: new Date('2026-09-17T00:00:00.000Z'),
        project: 'threadnote',
        records: [affected, unaffected],
      }),
      selection: {
        affectedMemoryUris: [affected.uri],
        changedPaths: ['src/affected.ts'],
        status: 'available',
      },
    });

    expect(report.findings).toEqual([expect.objectContaining({category: 'exact-duplicate'})]);
  });

  it('reports unavailable affected-memory evidence separately from unknown health findings', () => {
    const report = buildContextCheckReport({
      healthReport: healthReport([finding('citation-changed', ['threadnote://memory/changed'])]),
      selection: {reason: 'affected-memory-evidence-unavailable', status: 'unavailable'},
    });

    expect(report).toMatchObject({
      evidenceStatus: 'unavailable',
      exitClassification: 'invalid-or-required-evidence-unavailable',
      findings: [],
    });
    expect(projectContextCheckReportSarif(report).runs[0]?.results[0]).toMatchObject({
      ruleId: 'threadnote/context-check/evidence-unavailable',
    });
  });

  it('projects deterministic bounded JSON and SARIF without memory bodies', () => {
    const report = buildContextCheckReport({
      limit: 1,
      healthReport: healthReport([
        finding('validity-expired', ['threadnote://memory/a']),
        finding('citation-changed', ['threadnote://memory/b']),
      ]),
      selection: {
        affectedMemoryUris: ['threadnote://memory/b', 'threadnote://memory/a'],
        changedPaths: ['src/b.ts', 'src/a.ts'],
        status: 'available',
      },
    });
    const json = serializeContextCheckReportJson(report);
    const sarif = projectContextCheckReportSarif(report);

    expect(parseContextCheckReportJson(json)).toEqual(report);
    expect(json).not.toContain('threadnote://memory');
    expect(json).not.toContain('A health finding');
    expect(JSON.stringify(sarif)).not.toContain('threadnote://memory');
    expect(JSON.stringify(sarif)).not.toContain('A health finding');
    expect(sarif.runs[0]?.results).toHaveLength(1);
  });

  it('rejects excess, out-of-range, and internally inconsistent report JSON', () => {
    const report = buildContextCheckReport({
      healthReport: healthReport([finding('citation-changed', ['threadnote://memory/changed'])]),
      selection: {
        affectedMemoryUris: ['threadnote://memory/changed'],
        changedPaths: ['src/changed.ts'],
        status: 'available',
      },
    });
    for (const invalid of [
      {...report, extra: true},
      {...report, omittedFindings: -1},
      {...report, exitClassification: 'clean', exitCode: 0},
      {...report, findings: [{...report.findings[0], severity: 'severe'}]},
    ]) {
      expect(() => parseContextCheckReportJson(JSON.stringify(invalid))).toThrow('Invalid ContextCheckReportV1');
    }
  });

  it('has input-order-stable fingerprints, serialization, and affected-set isolation', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,10}$/u), {maxLength: 20}),
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,10}$/u), {maxLength: 20}),
        (affected, unaffected) => {
          const selectedUris = affected.map(value => `threadnote://memory/${value}`);
          const records = [
            ...selectedUris.map(uri => finding('citation-changed', [uri])),
            ...unaffected.map(value => finding('validity-expired', [`threadnote://memory/other-${value}`])),
          ];
          const input = {
            healthReport: healthReport(records),
            selection: {
              affectedMemoryUris: selectedUris,
              changedPaths: ['src/context.ts'],
              status: 'available' as const,
            },
          };
          const first = buildContextCheckReport(input);
          const second = buildContextCheckReport({
            ...input,
            healthReport: healthReport([...records].reverse()),
            selection: {...input.selection, affectedMemoryUris: [...selectedUris].reverse()},
          });

          expect(first.findings.map(item => item.fingerprint)).toEqual(second.findings.map(item => item.fingerprint));
          expect(parseContextCheckReportJson(serializeContextCheckReportJson(first))).toEqual(first);
          expect(first.findings).toHaveLength(selectedUris.length);
        },
      ),
      {numRuns: 50},
    );
  });
});

function duplicateRecord(name: string): MemoryRecord {
  return {
    body: 'The exact shared invariant.',
    content: 'The exact shared invariant.',
    headerTitle: 'MEMORY',
    metadata: {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-09-01T00:00:00.000Z',
      topic: 'exact-duplicate',
    },
    uri: `threadnote://user/test/memories/durable/projects/threadnote/${name}.md`,
  };
}
