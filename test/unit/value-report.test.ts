import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {aggregateValueReportV1, parseValueReportV1, type ValueReportInputV1} from '../../src/value_report/index.js';
import {summarizeLocalValueEvents, type LocalValueEventV1} from '../../src/value_report/events.js';
import type {RecallFeedbackEvent} from '../../src/recall/feedback.js';

const feedbackEvent = (action: RecallFeedbackEvent['action'], timestamp: string): RecallFeedbackEvent => ({
  action,
  project: 'local-project',
  queryFingerprint: 'a'.repeat(64),
  rankerVersion: 'hybrid-v1',
  timestamp,
  uri: 'threadnote://private/memory',
  version: 1,
});

describe('value report', () => {
  it('projects bounded count-only metrics from feedback and explicit inputs', () => {
    const input: ValueReportInputV1 = {
      feedbackEvents: [
        feedbackEvent('useful', '2026-09-01T00:00:00.000Z'),
        feedbackEvent('wrong', '2026-09-02T00:00:00.000Z'),
        feedbackEvent('pin', '2026-08-01T00:00:00.000Z'),
      ],
      period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
      project: 'local-project',
      counts: {
        contextBrief: {
          attempts: 3,
          successful: 2,
          requestedCodeAnchors: 5,
          resolvedCodeAnchors: 4,
          coverageGaps: 1,
          estimatedTokens: 100,
          followUpGraphOperations: 2,
          followUpRecallOperations: 1,
          timeToFirstSuccessfulMillisecondsSamples: [300, 100, 200],
        },
        knowledgeDelta: {proposed: 4, approved: 2, edited: 1, rejected: 1, deferred: 0},
        health: {opened: 2, resolved: 1},
        setup: {
          completed: 1,
          failed: 1,
          started: 2,
          supportedAgentReuse: 1,
          timeToFirstEvidenceMillisecondsSamples: [300, 100, 200],
        },
      },
    };

    const report = aggregateValueReportV1(input);
    expect(report).toMatchObject({
      type: 'value-report',
      version: 1,
      scope: 'local',
      feedback: {useful: 1, wrong: 1, dismiss: 0, pin: 0, total: 2},
      contextBrief: {
        attempts: 3,
        successful: 2,
        requestedCodeAnchors: 5,
        resolvedCodeAnchors: 4,
        timeToFirstSuccessfulMilliseconds: 200,
      },
      setup: {
        availability: 'available',
        completed: 1,
        failed: 1,
        started: 2,
        supportedAgentReuse: 1,
        timeToFirstEvidenceMilliseconds: 200,
      },
    });
    expect(JSON.stringify(report)).not.toContain('local-project');
    expect(JSON.stringify(report)).not.toContain('private');
    expect(parseValueReportV1(report)).toEqual(report);
  });

  it('is deterministic and order invariant for feedback and timing samples', () => {
    const input: ValueReportInputV1 = {
      feedbackEvents: [
        feedbackEvent('useful', '2026-09-01T00:00:00.000Z'),
        feedbackEvent('wrong', '2026-09-02T00:00:00.000Z'),
      ],
      period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
      counts: {contextBrief: {timeToFirstSuccessfulMillisecondsSamples: [4, 1, 9]}},
    };
    const reversed = {
      ...input,
      feedbackEvents: [...input.feedbackEvents!].reverse(),
      counts: {contextBrief: {timeToFirstSuccessfulMillisecondsSamples: [9, 4, 1]}},
    };
    expect(aggregateValueReportV1(input)).toEqual(aggregateValueReportV1(reversed));
    FC.assert(
      FC.property(FC.array(FC.integer({min: 0, max: 10_000}), {maxLength: 32}), values => {
        const report = aggregateValueReportV1({
          period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
          counts: {contextBrief: {timeToFirstSuccessfulMillisecondsSamples: values}},
        });
        const shuffled = [...values].reverse();
        return (
          JSON.stringify(report) ===
          JSON.stringify(
            aggregateValueReportV1({
              period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
              counts: {contextBrief: {timeToFirstSuccessfulMillisecondsSamples: shuffled}},
            }),
          )
        );
      }),
      {numRuns: 25},
    );
  });

  it('clamps untrusted counts and durations to the report bounds', () => {
    const report = aggregateValueReportV1({
      period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
      counts: {
        contextBrief: {
          attempts: Number.MAX_SAFE_INTEGER,
          estimatedTokens: Number.MAX_SAFE_INTEGER,
          timeToFirstSuccessfulMillisecondsSamples: [Number.MAX_SAFE_INTEGER],
        },
      },
    });
    expect(report.contextBrief.attempts).toBe(10_000);
    expect(report.contextBrief.estimatedTokens).toBe(10_000);
    expect(report.contextBrief.timeToFirstSuccessfulMilliseconds).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it('summarizes local count-only events independently of storage order', () => {
    FC.assert(
      FC.property(FC.array(FC.integer({min: 0, max: 1_000}), {maxLength: 40}), durations => {
        const events: readonly LocalValueEventV1[] = durations.map((durationMilliseconds, index) => ({
          coverageGaps: index % 3,
          durationMilliseconds,
          estimatedTokens: index,
          kind: 'context-brief',
          project: index % 2 === 0 ? 'threadnote' : 'other',
          requestedCodeAnchors: index % 4,
          resolvedCodeAnchors: index % 4,
          successful: index % 5 !== 0,
          timestamp: `2026-09-${String((index % 20) + 1).padStart(2, '0')}T00:00:00.000Z`,
          version: 1,
        }));
        const options = {
          from: new Date('2026-09-01T00:00:00.000Z'),
          project: 'threadnote',
          to: new Date('2026-09-30T00:00:00.000Z'),
        };
        expect(summarizeLocalValueEvents(events, options)).toEqual(
          summarizeLocalValueEvents([...events].reverse(), options),
        );
      }),
      {numRuns: 40},
    );
  });

  it('keeps legacy setup completions readable and aggregates content-free lifecycle timing', () => {
    const events: readonly LocalValueEventV1[] = [
      {
        completed: 1,
        kind: 'setup',
        supportedAgentReuse: 1,
        timestamp: '2026-09-03T00:00:00.000Z',
        version: 1,
      },
      {
        durationMilliseconds: 0,
        kind: 'setup-lifecycle',
        phase: 'started',
        timestamp: '2026-09-03T00:00:00.000Z',
        version: 1,
      },
      {
        durationMilliseconds: 250,
        kind: 'setup-lifecycle',
        phase: 'completed',
        timeToFirstEvidenceMilliseconds: 250,
        timestamp: '2026-09-03T00:00:00.250Z',
        version: 1,
      },
    ];
    const counts = summarizeLocalValueEvents(events, {
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(counts.setup).toEqual({
      completed: 1,
      failed: 0,
      started: 1,
      supportedAgentReuse: 1,
      timeToFirstEvidenceMillisecondsSamples: [250],
    });
    expect(aggregateValueReportV1({counts, period: {from: '2026-09-01', to: '2026-09-30'}}).setup).toEqual({
      availability: 'available',
      completed: 1,
      failed: 0,
      started: 1,
      supportedAgentReuse: 1,
      timeToFirstEvidenceMilliseconds: 250,
    });
  });
});
