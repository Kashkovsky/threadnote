import {Clock, Effect} from 'effect';
import type {MemoryRecord} from '../memory_document.js';
import {buildRecallSections, type ExactMatch, type RecallHit} from '../utils.js';
import {loadRecallFeedback} from './feedback.js';
import {loadRecallIndexData} from './index.js';

interface RecallRuntimeConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

interface PrepareRecallSectionsInput<R> {
  readonly allowExactRescue: boolean;
  readonly allowedUriScopes?: readonly string[];
  readonly exactMatches: readonly ExactMatch[];
  readonly feedbackQuery: string;
  readonly includeInactive: boolean;
  readonly limit: number;
  readonly minimumScore: number;
  readonly passes: ReadonlyArray<readonly RecallHit[]>;
  readonly project?: string;
  readonly query: string;
  readonly readRecords: (uris: readonly string[]) => Effect.Effect<readonly MemoryRecord[], unknown, R>;
  readonly seedUris?: readonly string[];
}

const INDEX_CANDIDATE_MULTIPLIER = 10;
const INDEX_CANDIDATE_MINIMUM = 100;

/**
 * Shared Effect orchestration for CLI and MCP recall. The entry points remain
 * responsible for their search passes and rendering, while record hydration,
 * feedback, local-index loading, and hybrid ranking follow one implementation.
 */
export const prepareRecallSections = Effect.fn('recall.prepareSections')(function* <R>(
  config: RecallRuntimeConfig,
  input: PrepareRecallSectionsInput<R>,
) {
  const rankingUris = [
    ...new Set([
      ...input.passes.flatMap(pass => pass.map(hit => hit.uri.replace(/#.*$/, ''))),
      ...input.exactMatches.map(match => match.uri.replace(/#.*$/, '')),
    ]),
  ];
  const records = yield* input.readRecords(rankingUris);
  const now = new Date(yield* Clock.currentTimeMillis);
  const [feedbackByUri, recallIndex] = yield* Effect.all(
    [
      loadRecallFeedback(config.agentContextHome, {
        now,
        project: input.project,
        query: input.feedbackQuery,
      }),
      loadRecallIndexData(config, {
        allowedUriScopes: input.allowedUriScopes,
        includeInactive: input.includeInactive,
        limit: Math.max(INDEX_CANDIDATE_MINIMUM, input.limit * INDEX_CANDIDATE_MULTIPLIER),
        query: input.query,
        requiredUris: rankingUris,
      }).pipe(Effect.catch(() => Effect.succeed(undefined))),
    ],
    {concurrency: 2},
  );
  return buildRecallSections(input.passes, input.exactMatches, input.limit, {
    allowExactRescue: input.allowExactRescue,
    allowedUriScopes: input.allowedUriScopes,
    corpusStatistics: recallIndex?.corpusStatistics,
    feedbackByUri,
    includeInactive: input.includeInactive,
    indexedCandidates: recallIndex?.candidates,
    minimumScore: input.minimumScore,
    now,
    project: input.project,
    query: input.query,
    records,
    seedUris: input.seedUris,
  });
});
