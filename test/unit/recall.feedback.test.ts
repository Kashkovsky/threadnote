import {Effect} from 'effect';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  aggregateRecallFeedback,
  loadRecallFeedback,
  recallQueryFingerprint,
  recordRecallFeedback,
  type RecallFeedbackEvent,
} from '../../src/recall/feedback.js';
import {join, mkdir, mkdtemp, readFile, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect as run} from '../helpers/effect-runtime.js';

describe('recall feedback', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp('threadnote-feedback-');
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  it('stores only a query fingerprint and suppresses repeated reinforcement', async () => {
    const input = {
      action: 'useful' as const,
      project: 'threadnote',
      query: 'Threadnote recall quality',
      timestamp: '2026-07-23T10:00:00.000Z',
      uri: 'viking://user/me/memory.md',
    };
    expect((await run(recordRecallFeedback(directory, input))).recorded).toBe(true);
    expect((await run(recordRecallFeedback(directory, input))).recorded).toBe(false);

    const feedback = await run(
      loadRecallFeedback(directory, {
        now: new Date('2026-07-23T10:00:00.000Z'),
        project: 'threadnote',
        query: input.query,
      }),
    );
    expect(feedback.get(input.uri)).toBeCloseTo(0.15);
    const queryFingerprint = await run(recallQueryFingerprint(input.query));
    expect(queryFingerprint).toHaveLength(64);
    const stored = await readFile(join(directory, 'feedback', 'recall-events-v1.jsonl'), 'utf8');
    expect(stored).not.toContain(input.query);
    expect(stored).toContain(queryFingerprint);
  });

  it('keeps pins project-scoped, decays old events, and bounds the total signal', async () => {
    const anotherQueryFingerprint = await run(recallQueryFingerprint('another query'));
    const currentQueryFingerprint = await run(recallQueryFingerprint('current query'));
    const event = (
      action: RecallFeedbackEvent['action'],
      project: string,
      timestamp: string,
      queryFingerprint = anotherQueryFingerprint,
    ): RecallFeedbackEvent => ({
      action,
      project,
      queryFingerprint,
      rankerVersion: 'hybrid-v1',
      timestamp,
      uri: 'viking://user/me/memory.md',
      version: 1,
    });
    const events = [
      event('pin', 'threadnote', '2026-07-23T00:00:00.000Z'),
      event('pin', 'other', '2026-07-23T00:00:00.000Z'),
      ...Array.from({length: 10}, () =>
        event('wrong', 'threadnote', '2025-01-01T00:00:00.000Z', currentQueryFingerprint),
      ),
    ];

    const scores = await run(
      aggregateRecallFeedback(events, {
        now: new Date('2026-07-23T00:00:00.000Z'),
        project: 'threadnote',
        query: 'current query',
      }),
    );

    expect(scores.get('viking://user/me/memory.md')).toBeGreaterThanOrEqual(-1);
    expect(scores.get('viking://user/me/memory.md')).toBeLessThan(0.4);
  });

  it('ignores legacy projectless pins and compacts expired events on write', async () => {
    const feedbackDirectory = join(directory, 'feedback');
    const feedbackPath = join(feedbackDirectory, 'recall-events-v1.jsonl');
    const projectlessPin: RecallFeedbackEvent = {
      action: 'pin',
      queryFingerprint: await run(recallQueryFingerprint('query')),
      rankerVersion: 'hybrid-v1',
      timestamp: '2026-07-23T00:00:00.000Z',
      uri: 'viking://user/me/projectless-pin.md',
      version: 1,
    };
    expect(
      (
        await run(
          aggregateRecallFeedback([projectlessPin], {
            now: new Date('2026-07-23T00:00:00.000Z'),
            project: 'threadnote',
            query: 'query',
          }),
        )
      ).has(projectlessPin.uri),
    ).toBe(false);

    await mkdir(feedbackDirectory, {recursive: true});
    await writeFile(
      feedbackPath,
      `${JSON.stringify({
        ...projectlessPin,
        action: 'useful',
        timestamp: '2020-01-01T00:00:00.000Z',
        uri: 'viking://user/me/expired.md',
      })}\n`,
      'utf8',
    );
    await run(
      recordRecallFeedback(directory, {
        action: 'useful',
        project: 'threadnote',
        query: 'query',
        timestamp: '2026-07-23T00:00:00.000Z',
        uri: 'viking://user/me/current.md',
      }),
    );

    const stored = await readFile(feedbackPath, 'utf8');
    expect(stored).toContain('viking://user/me/current.md');
    expect(stored).not.toContain('viking://user/me/expired.md');
  });

  it('serializes concurrent feedback rewrites without losing an event', async () => {
    await run(
      Effect.all(
        ['one', 'two'].map(suffix =>
          recordRecallFeedback(directory, {
            action: 'useful',
            project: 'threadnote',
            query: `query-${suffix}`,
            timestamp: '2026-07-23T00:00:00.000Z',
            uri: `viking://user/me/${suffix}.md`,
          }),
        ),
        {concurrency: 2},
      ),
    );

    const stored = await readFile(join(directory, 'feedback', 'recall-events-v1.jsonl'), 'utf8');
    expect(stored.trim().split('\n')).toHaveLength(2);
  });
});
