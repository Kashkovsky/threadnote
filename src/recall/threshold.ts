import {Effect, Schema} from 'effect';
import {SystemInfo} from '../effect/system.js';

export interface RecallScoreThresholdPolicy {
  readonly source: 'default' | 'environment';
  readonly value: string;
}

export class InvalidRecallScoreThreshold extends Schema.TaggedError<InvalidRecallScoreThreshold>()(
  'InvalidRecallScoreThreshold',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export function validatedRecallScoreThreshold(value: string, source = 'Recall threshold'): string {
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!normalized || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw InvalidRecallScoreThreshold.make({message: `${source} must be a number from 0 to 1.`});
  }
  return String(parsed);
}

/**
 * Topical relevanceScore floor applied before lifecycle and trust multipliers.
 * Per-call CLI/MCP inputs take precedence at their call sites. The owned 0.3
 * default preserves the hybrid ranker's existing scale, while an environment
 * override is marked as configured so exact-match rescue cannot bypass it.
 */
export const recallScoreThresholdPolicy = Effect.fn('utils.recallScoreThresholdPolicy')(function* () {
  const configured = (yield* SystemInfo).environment().THREADNOTE_RECALL_THRESHOLD?.trim();
  if (!configured) return {source: 'default', value: '0.3'} satisfies RecallScoreThresholdPolicy;
  const value = yield* Effect.try({
    try: () => validatedRecallScoreThreshold(configured, 'THREADNOTE_RECALL_THRESHOLD'),
    catch: error =>
      Schema.is(InvalidRecallScoreThreshold)(error)
        ? error
        : InvalidRecallScoreThreshold.make({message: 'THREADNOTE_RECALL_THRESHOLD is invalid.'}),
  });
  return {source: 'environment', value} satisfies RecallScoreThresholdPolicy;
});

export const recallScoreThreshold = Effect.fn('utils.recallScoreThreshold')(function* () {
  return (yield* recallScoreThresholdPolicy()).value;
});
