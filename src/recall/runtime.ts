import {Clock, Effect} from 'effect';
import type {MemoryRecord} from '../memory_document.js';
import {buildRecallSections, type ExactMatch, type RecallHit} from '../utils.js';
import {loadRecallFeedback} from './feedback.js';
import {loadRecallIndexData} from './index.js';
import type {RecallCandidate} from './rank.js';

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
  readonly minimumScore?: number;
  readonly passes: ReadonlyArray<readonly RecallHit[]>;
  readonly project?: string;
  readonly query: string;
  readonly queryVariants?: readonly string[];
  readonly readRecords: (uris: readonly string[]) => Effect.Effect<readonly MemoryRecord[], unknown, R>;
  readonly seedUris?: readonly string[];
}

const INDEX_CANDIDATE_MULTIPLIER = 10;
const INDEX_CANDIDATE_MINIMUM = 100;
const EXPANSION_VOCABULARY_LIMIT = 50;
const EXPANSION_VOCABULARY_RANKED_RESERVE = 25;
const EXPANSION_DESCRIPTION_TERM_LIMIT = 6;
const EXPANSION_DESCRIPTION_LENGTH_LIMIT = 80;
const EXPANSION_DESCRIPTION_SEPARATOR = ' :: ';

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
  const indexQueries = [input.query, ...(input.queryVariants ?? [])];
  const [feedbackByUri, recallIndexes] = yield* Effect.all(
    [
      loadRecallFeedback(config.agentContextHome, {
        now,
        project: input.project,
        query: input.feedbackQuery,
      }),
      Effect.forEach(
        indexQueries,
        indexQuery =>
          loadRecallIndexData(config, {
            allowedUriScopes: input.allowedUriScopes,
            includeInactive: input.includeInactive,
            limit: Math.max(INDEX_CANDIDATE_MINIMUM, input.limit * INDEX_CANDIDATE_MULTIPLIER),
            query: indexQuery,
            requiredUris: rankingUris,
          }).pipe(Effect.catch(() => Effect.succeed(undefined))),
        {concurrency: 2},
      ),
    ],
    {concurrency: 2},
  );
  const recallIndex = recallIndexes.find(index => index !== undefined);
  const indexedCandidates = mergeRecallIndexCandidates(recallIndexes.map(index => index?.candidates ?? []));
  const sections = buildRecallSections(input.passes, input.exactMatches, input.limit, {
    allowExactRescue: input.allowExactRescue,
    allowedUriScopes: input.allowedUriScopes,
    corpusStatistics: recallIndex?.corpusStatistics,
    feedbackByUri,
    includeInactive: input.includeInactive,
    indexedCandidates,
    minimumScore: input.minimumScore,
    now,
    project: input.project,
    query: input.query,
    queryVariants: input.queryVariants,
    records,
    seedUris: input.seedUris,
  });
  return {...sections, expansionCandidates: indexedCandidates};
});

export const loadRecallExpansionVocabulary = Effect.fn('recall.loadExpansionVocabulary')(function* (
  config: RecallRuntimeConfig,
  input: {
    readonly allowedUriScopes?: readonly string[];
    readonly includeInactive: boolean;
    readonly project?: string;
    readonly rankedCandidates?: readonly RecallCandidate[];
  },
) {
  if (!input.project) return [];
  const index = yield* loadRecallIndexData(config, {includeInactive: input.includeInactive});
  const mergedCandidates = mergeRecallIndexCandidates([input.rankedCandidates ?? [], index.candidates]);
  const candidates = input.allowedUriScopes?.length
    ? mergedCandidates.filter(candidate =>
        input.allowedUriScopes?.some(scope => candidate.uri === scope || candidate.uri.startsWith(`${scope}/`)),
      )
    : mergedCandidates;
  return recallExpansionVocabulary(candidates, input.project);
});

export function mergeRecallIndexCandidates(
  candidateSets: readonly (readonly RecallCandidate[])[],
): readonly RecallCandidate[] {
  const seen = new Set<string>();
  const merged: RecallCandidate[] = [];
  const maximumLength = Math.max(0, ...candidateSets.map(candidates => candidates.length));
  for (let index = 0; index < maximumLength; index += 1) {
    for (const candidates of candidateSets) {
      const candidate = candidates[index];
      if (!candidate || seen.has(candidate.uri)) continue;
      seen.add(candidate.uri);
      merged.push(candidate);
    }
  }
  return merged;
}

export function recallExpansionVocabulary(
  candidates: readonly RecallCandidate[],
  project: string | undefined,
): readonly string[] {
  if (!project) return [];
  const normalizedProject = project.trim().toLowerCase();
  const seen = new Set<string>();
  const vocabulary: string[] = [];
  const projectCandidates = prioritizeRecallExpansionCandidates(
    candidates.filter(candidate => candidate.fields?.project?.trim().toLowerCase() === normalizedProject),
  );
  const append = (term: string | undefined, dedupeTerm = term): boolean => {
    const value = term?.trim();
    const dedupeValue = dedupeTerm?.trim();
    const key = dedupeValue?.toLowerCase();
    if (!value || !dedupeValue || dedupeValue.length > 120 || !key || seen.has(key)) return false;
    seen.add(key);
    vocabulary.push(value);
    return vocabulary.length === EXPANSION_VOCABULARY_LIMIT;
  };
  for (const candidate of projectCandidates) {
    const topic = candidate.fields?.topic?.trim();
    const description = recallExpansionDescription(candidate.text);
    if (append(topic && description ? `${topic}${EXPANSION_DESCRIPTION_SEPARATOR}${description}` : topic, topic)) {
      return vocabulary;
    }
  }
  for (const candidate of projectCandidates) {
    for (const identifier of candidate.fields?.identifiers ?? []) {
      if (append(identifier)) return vocabulary;
    }
  }
  return vocabulary;
}

function prioritizeRecallExpansionCandidates(candidates: readonly RecallCandidate[]): readonly RecallCandidate[] {
  const prioritized: RecallCandidate[] = [];
  const seen = new Set<string>();
  const append = (candidate: RecallCandidate): void => {
    if (seen.has(candidate.uri)) return;
    seen.add(candidate.uri);
    prioritized.push(candidate);
  };
  for (const candidate of candidates.slice(0, EXPANSION_VOCABULARY_RANKED_RESERVE)) append(candidate);
  for (const candidate of [...candidates].sort((left, right) => timestampValue(right) - timestampValue(left))) {
    append(candidate);
  }
  for (const candidate of candidates) append(candidate);
  return prioritized;
}

function timestampValue(candidate: RecallCandidate): number {
  if (!candidate.timestamp) return Number.NEGATIVE_INFINITY;
  const value = Date.parse(candidate.timestamp);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function recallExpansionDescription(text: string): string {
  const terms: string[] = [];
  let previous = '';
  for (const rawTerm of text.split(/\s+/)) {
    const term = rawTerm.trim();
    const key = term.toLowerCase();
    if (!term || key === previous) continue;
    terms.push(term);
    previous = key;
    if (terms.length === EXPANSION_DESCRIPTION_TERM_LIMIT) break;
  }
  return terms.join(' ').slice(0, EXPANSION_DESCRIPTION_LENGTH_LIMIT).trim();
}
