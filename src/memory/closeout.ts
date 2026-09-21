import {Console, Effect} from 'effect';
import {applyMemoryCandidate, type ApplyMemoryCandidateInput} from '../mcp/server/recall.js';
import {applyScrubber} from '../share/scrubber.js';
import type {RuntimeConfig} from '../types.js';
import {loadCandidateReview} from './candidate.js';
import {projectKnowledgeDeltaV1} from './knowledge_delta.js';
import {MemoryOperationError} from './migrations.js';

interface CloseoutRuntime {
  readonly agentContextHome: string;
}

export const runCloseoutPreview = Effect.fn('memory.closeout.preview')(function* (
  config: CloseoutRuntime,
  options: {
    readonly candidateId?: string;
    readonly editedText?: string;
    readonly json: boolean;
    readonly reviewId: string;
    readonly revision?: number;
  },
) {
  const review = yield* loadCandidateReview(config.agentContextHome, options.reviewId);
  const editedPreview = yield* previewEdit(options);
  const delta = yield* Effect.try({
    try: () => projectKnowledgeDeltaV1(review, editedPreview),
    catch: cause =>
      MemoryOperationError.make({message: cause instanceof Error ? cause.message : 'Invalid edited preview.'}),
  });
  if (options.json) {
    yield* Console.log(JSON.stringify(delta, null, 2));
    return;
  }
  const lines = [
    `Knowledge delta for ${delta.reviewId} (revision ${delta.revision})`,
    ...(delta.items.length === 0
      ? ['No candidates.']
      : delta.items.flatMap(item => [
          '',
          `${item.candidateId}: ${item.type} (${item.state})`,
          `  recommendation: ${item.recommendation}`,
          `  operation: ${item.mutationPreview.operation}`,
          ...(item.mutationPreview.replaceUri ? [`  replace: ${item.mutationPreview.replaceUri}`] : []),
          ...(item.mutationPreview.replacementSafety?.warning
            ? [`  WARNING: ${item.mutationPreview.replacementSafety.warning}`]
            : []),
          `  reason: ${item.comparisonReason}`,
          ...item.mutationPreview.bodyText.split('\n').map(line => `  ${line}`),
        ])),
  ];
  yield* Console.log(lines.join('\n'));
});

const previewEdit = Effect.fn('memory.closeout.previewEdit')(function* (options: {
  readonly candidateId?: string;
  readonly editedText?: string;
  readonly revision?: number;
}) {
  if (options.editedText === undefined) {
    if (options.candidateId !== undefined || options.revision !== undefined) {
      return yield* MemoryOperationError.make({
        message: '--candidate-id and --revision require --edited-text for a non-mutating edited preview.',
      });
    }
    return undefined;
  }
  if (options.candidateId === undefined || options.revision === undefined) {
    return yield* MemoryOperationError.make({
      message: '--edited-text requires --candidate-id and the current --revision.',
    });
  }
  const scrub = applyScrubber(options.editedText, {redact: true});
  if (scrub.blocker) {
    return yield* MemoryOperationError.make({
      message: `Refusing to preview edited candidate text: possible ${scrub.blocker}.`,
    });
  }
  return {bodyText: scrub.cleaned, candidateId: options.candidateId, revision: options.revision};
});

export const runCloseoutApply = (config: RuntimeConfig, input: ApplyMemoryCandidateInput) =>
  applyMemoryCandidate(config, input);

export const runCloseoutApplyWithReviewLockHeld = (config: RuntimeConfig, input: ApplyMemoryCandidateInput) =>
  applyMemoryCandidate(config, input, {reviewLockHeld: true});
