import {it as effectIt} from '@effect/vitest';
import {DateTime, Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  loadRecallFeedback,
  readRecallFeedbackEvents,
  recallQueryFingerprint,
  recordRecallFeedback,
  summarizeRecallFeedback,
} from '../../src/recall/feedback.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('applied recall feedback', () => {
  effectIt.effect('reads legacy v1 events and keeps applied distinct, deduplicated, and decayed', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-applied-feedback-'});
        const feedbackDirectory = path.join(home, 'feedback');
        const feedbackPath = path.join(feedbackDirectory, 'recall-events-v1.jsonl');
        const query = 'Apply this recalled decision';
        const queryFingerprint = yield* recallQueryFingerprint(query);
        yield* fs.makeDirectory(feedbackDirectory, {recursive: true});
        yield* fs.writeFileString(
          feedbackPath,
          `${JSON.stringify({
            action: 'useful',
            project: 'threadnote',
            queryFingerprint,
            rankerVersion: 'hybrid-v1',
            timestamp: '2026-09-01T00:00:00.000Z',
            uri: 'threadnote://user/tester/memories/legacy.md',
            version: 1,
          })}\n`,
        );

        const input = {
          action: 'applied' as const,
          project: 'threadnote',
          query,
          timestamp: '2026-09-02T00:00:00.000Z',
          uri: 'threadnote://user/tester/memories/applied.md',
        };
        expect((yield* recordRecallFeedback(home, input)).recorded).toBe(true);
        expect((yield* recordRecallFeedback(home, input)).recorded).toBe(false);

        const events = yield* readRecallFeedbackEvents(home);
        expect(summarizeRecallFeedback(events)).toEqual({applied: 1, dismiss: 0, pin: 0, useful: 1, wrong: 0});

        const current = yield* loadRecallFeedback(home, {
          now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-02T00:00:00.000Z')),
          project: 'threadnote',
          query,
        });
        const decayed = yield* loadRecallFeedback(home, {
          now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-12-01T00:00:00.000Z')),
          project: 'threadnote',
          query,
        });
        expect(current.get(input.uri)).toBeCloseTo(0.3);
        expect(decayed.get(input.uri)).toBeGreaterThan(0);
        expect(decayed.get(input.uri)).toBeLessThan(current.get(input.uri)!);
        expect(yield* fs.readFileString(feedbackPath)).not.toContain(query);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
