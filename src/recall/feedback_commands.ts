import {DateTime, Effect} from 'effect';
import {writeFinalCliOutput} from '../effect/cli_output.js';
import {MemoryOperationError, normalizeOptionalMetadata} from '../memory/migrations.js';
import {parseResourceId} from '../storage/resource-id.js';
import type {RuntimeConfig} from '../types.js';
import {recordRecallFeedback, type RecallFeedbackAction} from './feedback.js';

export interface RunRecallFeedbackOptionsV1 {
  readonly action: RecallFeedbackAction;
  readonly project?: string;
  readonly query: string;
  readonly uri: string;
}

export const runRecallFeedback = Effect.fn('runRecallFeedback')(function* (
  config: RuntimeConfig,
  options: RunRecallFeedbackOptionsV1,
) {
  const query = options.query.trim();
  if (!query) return yield* MemoryOperationError.make({message: 'Recall feedback requires the original query.'});
  const project = normalizeOptionalMetadata(options.project);
  if (options.action === 'pin' && project === undefined) {
    return yield* MemoryOperationError.make({message: 'Pinned feedback requires --project; pins are never global.'});
  }
  const uri = parseResourceId(options.uri).canonicalUri;
  const result = yield* recordRecallFeedback(config.agentContextHome, {
    action: options.action,
    project,
    query,
    timestamp: DateTime.formatIso(yield* DateTime.now),
    uri,
  });
  yield* writeFinalCliOutput(
    result.recorded
      ? `Recorded ${options.action} feedback for ${uri}.`
      : `Equivalent recent ${options.action} feedback already exists for ${uri}; no duplicate was added.`,
  );
});
