import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {buildContextHealthReport} from '../../src/memory/context_health.js';
import {renderContextHealth} from '../../src/memory/context_health_commands.js';
import {
  analyzeContextHealthSemantics,
  MAXIMUM_CONTEXT_HEALTH_SEMANTIC_RECORDS,
} from '../../src/memory/context_health_semantic.js';
import {previewContextHealthRepairPlanV1} from '../../src/memory/context_health_repair.js';
import type {MemoryMetadata, MemoryRecord} from '../../src/memory/document.js';

const now = new Date('2026-09-18T08:00:00.000Z');

describe('context health semantic contradictions', () => {
  it('reports bounded review-only evidence that identifies both records and claims without bodies', () => {
    const required = record('required', '- Agents must load verified context before implementation.');
    const forbidden = record('forbidden', '- Agents must not load verified context before implementation.');
    const report = buildContextHealthReport({now, project: 'threadnote', records: [forbidden, required]});

    expect(report.status).toBe('findings');
    expect(report.semanticCompleteness).toMatchObject({
      analyzedRecords: 2,
      eligibleRecords: 2,
      state: 'complete',
      unknownRecords: 0,
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      category: 'semantic-contradiction',
      confidence: 'medium',
      repair: {kind: 'review-memory'},
      repairability: 'manual-review',
      uris: [forbidden.uri, required.uri].sort(),
    });
    expect(report.findings[0]?.semanticEvidence?.left.claimId).toMatch(/^tnclaim_[a-f0-9]{32}$/u);
    expect(report.findings[0]?.semanticEvidence?.right.claimId).toMatch(/^tnclaim_[a-f0-9]{32}$/u);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('Agents must');
    expect(serialized.length).toBeLessThan(8_000);
  });

  it('reports missing or bounded-away evidence as unknown and never clean', () => {
    const missing = record('missing', '# Heading only');
    const unavailable = buildContextHealthReport({now, project: 'threadnote', records: [missing]});
    expect(unavailable.status).toBe('unknown');
    expect(unavailable.semanticCompleteness).toMatchObject({
      analyzedRecords: 0,
      eligibleRecords: 1,
      state: 'unavailable',
      unknownRecords: 1,
      unknownReasons: [{count: 1, reason: 'no-claims'}],
    });
    expect(renderContextHealth(unavailable)).toContain('Semantic unknown evidence: no-claims=1.');
    const partialWithFinding = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [
        missing,
        record('positive', 'Memory retrieval must use verified context.'),
        record('negative', 'Memory retrieval must not use verified context.'),
      ],
    });
    expect(partialWithFinding.status).toBe('unknown');
    expect(partialWithFinding.findings).toEqual([expect.objectContaining({category: 'semantic-contradiction'})]);

    const records = Array.from({length: MAXIMUM_CONTEXT_HEALTH_SEMANTIC_RECORDS + 3}, (_, index) =>
      record(`bounded-${index}`, `Memory ${index} must retain deterministic evidence.`),
    );
    const partial = buildContextHealthReport({now, project: 'threadnote', records});
    expect(partial.status).toBe('unknown');
    expect(partial.semanticCompleteness).toMatchObject({
      eligibleRecords: records.length,
      state: 'partial',
      unknownRecords: 3,
    });
    expect(partial.semanticCompleteness.unknownReasons).toContainEqual({count: 3, reason: 'record-limit'});
  });

  it('preserves project, lifecycle, and durable-kind isolation', () => {
    const positive = record('positive', 'Deployments must use signed artifacts.');
    const negative = record('negative', 'Deployments must not use signed artifacts.');
    const otherProject = record('other-project', 'Deployments must not use signed artifacts.', {project: 'other'});
    const archived = record('archived', 'Deployments must not use signed artifacts.', {status: 'archived'});
    const handoff = record('handoff', 'Deployments must not use signed artifacts.', {kind: 'handoff'});

    const analysis = analyzeContextHealthSemantics({
      project: 'threadnote',
      records: [negative, otherProject, archived, handoff, positive],
    });
    expect(analysis.completeness).toMatchObject({eligibleRecords: 2, state: 'complete'});
    expect(analysis.contradictions).toHaveLength(1);
    expect(new Set([analysis.contradictions[0]?.left.recordUri, analysis.contradictions[0]?.right.recordUri])).toEqual(
      new Set([positive.uri, negative.uri]),
    );
  });

  it('keeps broad lexical negation matches medium-confidence and review-only', () => {
    const lexicalNegation = record('lexical-negation', 'No agents bypass signed artifacts.');
    const equivalentQuantifier = record('equivalent-quantifier', 'Zero agents bypass signed artifacts.');
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [lexicalNegation, equivalentQuantifier],
    });

    // The bounded heuristic intentionally treats any lexical "no" as opposing evidence.
    // Such matches can be false positives, so they must never become automatic repairs.
    expect(report.findings).toEqual([
      expect.objectContaining({
        category: 'semantic-contradiction',
        confidence: 'medium',
        repair: expect.objectContaining({kind: 'review-memory'}),
        repairability: 'manual-review',
      }),
    ]);
    expect(previewContextHealthRepairPlanV1(report, [lexicalNegation, equivalentQuantifier]).proposals).toEqual([
      expect.objectContaining({mutation: expect.objectContaining({kind: 'review-only'})}),
    ]);
  });

  it('is deterministic, order-invariant, and does not mutate records', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{3,12}$/u), {minLength: 1, maxLength: 24}),
        fc.array(fc.boolean(), {minLength: 1, maxLength: 24}),
        (subjects, polarities) => {
          const records = subjects.map((subject, index) =>
            record(
              `${subject}-${index}`,
              `${subject} must${polarities[index % polarities.length] ? ' not' : ''} retain verified context.`,
            ),
          );
          const original = structuredClone(records);
          const first = analyzeContextHealthSemantics({project: 'threadnote', records});
          const second = analyzeContextHealthSemantics({project: 'threadnote', records: [...records].reverse()});
          expect(second).toEqual(first);
          expect(records).toEqual(original);
        },
      ),
      {numRuns: 75},
    );
  });
});

function record(name: string, body: string, metadata: Partial<MemoryMetadata> = {}): MemoryRecord {
  return {
    body,
    content: body,
    headerTitle: metadata.kind === 'handoff' ? 'HANDOFF' : 'MEMORY',
    metadata: {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-09-18T00:00:00.000Z',
      topic: name,
      ...metadata,
    },
    uri: `threadnote://user/test/memories/durable/projects/${metadata.project ?? 'threadnote'}/${name}.md`,
  };
}
