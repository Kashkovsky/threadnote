import {Cause, Clock, Console, Effect, Option, Result} from 'effect';
import {MAX_RECALL_SELECTION_CANDIDATES, type RecallSelectionCandidate} from '../effect/ai/recall.js';
import type {MemoryRecord} from '../memory_document.js';
import {buildRecallSections, memoryUriProjectSegment, type ExactMatch, type RecallHit} from '../utils.js';
import {rerankWithSelectedLocalModel} from '../models/inference.js';
import {LocalModelCatalog, type LocalModelManifest} from '../models/catalog.js';
import {readModelSelection} from '../models/selection.js';
import {LocalModelStore} from '../models/store.js';
import {loadRecallFeedback} from './feedback.js';
import {
  currentRecallCorpusGeneration,
  loadRecallIndexData,
  loadRecallIndexDataBatch,
  recallUriMatchesScopes,
} from './index.js';
import type {RecallCandidate} from './rank.js';
import {recallLexicalTerms, recallTokens} from './tokenize.js';
import {normalizeRecallRerankerScore} from './reranker-score.js';
import {
  ensureVectorIndex,
  rebuildVectorIndex,
  selectedSemanticScores,
  VectorCorpusGenerationChanged,
  VectorIndexCorrupt,
  vectorIndexMatchesGeneration,
} from '../search/vector-index.js';

interface RecallRuntimeConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

interface PrepareRecallSectionsInput<R> {
  readonly allowExactRescue: boolean;
  readonly allowedUriScopes?: readonly string[];
  readonly candidateUris?: readonly string[];
  readonly exactMatches: readonly ExactMatch[];
  readonly feedbackQuery: string;
  readonly includeInactive: boolean;
  readonly limit: number;
  readonly minimumScore?: number;
  readonly passes: ReadonlyArray<readonly RecallHit[]>;
  readonly preferredUriScopes?: readonly string[];
  readonly project?: string;
  readonly query: string;
  readonly queryVariants?: readonly string[];
  readonly readRecords: (uris: readonly string[]) => Effect.Effect<readonly MemoryRecord[], unknown, R>;
  readonly rerankerCache?: RecallRerankerCache;
  readonly seedUris?: readonly string[];
  readonly semanticResult?: Option.Option<RecallSemanticScoresResult>;
  readonly semanticGenerationMismatchPolicy?: 'fallback' | 'reload';
}

const INDEX_CANDIDATE_MULTIPLIER = 10;
const INDEX_CANDIDATE_MINIMUM = 100;
const EXPANSION_VOCABULARY_LIMIT = 50;
const EXPANSION_VOCABULARY_INDEX_SAMPLE_LIMIT = 200;
const EXPANSION_VOCABULARY_RANKED_RESERVE = 25;
const EXPANSION_DESCRIPTION_TERM_LIMIT = 6;
const EXPANSION_DESCRIPTION_LENGTH_LIMIT = 80;
const EXPANSION_DESCRIPTION_SEPARATOR = ' :: ';
const MAX_DETERMINISTIC_QUERY_VARIANTS = 3;
const MINIMUM_QUERY_VARIANT_TERMS = 2;
const NATIVE_RERANK_CANDIDATE_LIMIT = 32;
const NATIVE_RERANK_DOCUMENT_LIMIT = 4_000;
const SEMANTIC_GENERATION_RETRY_LIMIT = 2;
export const MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS = 15_000;

export interface RecallRerankerCache {
  readonly scores: Map<string, number>;
  unavailable: boolean;
}

export function createRecallRerankerCache(): RecallRerankerCache {
  return {scores: new Map(), unavailable: false};
}

export function deterministicRecallQueryVariants(query: string): readonly string[] {
  const clauses = query
    .split(/\s+(?:and|or)\s+|[,;]+/i)
    .map(clause => clause.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (clauses.length < 2 || clauses.some(clause => recallTokens(clause).length < MINIMUM_QUERY_VARIANT_TERMS)) {
    return [];
  }
  return clauses.slice(0, MAX_DETERMINISTIC_QUERY_VARIANTS);
}

function recallQueryVariants(query: string, supplied: readonly string[] | undefined): readonly string[] {
  const seen = new Set([query.trim().toLowerCase()]);
  const variants: string[] = [];
  for (const variant of [...deterministicRecallQueryVariants(query), ...(supplied ?? [])]) {
    const normalized = variant.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    variants.push(normalized);
  }
  return variants;
}

/**
 * Shared Effect orchestration for CLI and MCP recall. The entry points remain
 * responsible for their search passes and rendering, while record hydration,
 * feedback, local-index loading, and hybrid ranking follow one implementation.
 */
export const prepareRecallSections = Effect.fn('recall.prepareSections')(function* <R>(
  config: RecallRuntimeConfig,
  input: PrepareRecallSectionsInput<R>,
) {
  let semanticResult =
    input.semanticResult === undefined
      ? yield* loadRecallSemanticScoresResult(config, input.query, input.limit)
      : Option.getOrElse(input.semanticResult, emptyRecallSemanticScoresResult);
  for (let retry = 0; ; retry += 1) {
    const prepared = yield* prepareRecallSectionsAttempt(config, input, semanticResult);
    if (yield* semanticResultMatchesLexicalSnapshot(config, semanticResult, prepared.generations)) {
      return {...prepared.sections, semanticResult};
    }
    if (input.semanticGenerationMismatchPolicy === 'fallback' || retry >= SEMANTIC_GENERATION_RETRY_LIMIT) {
      const lexicalOnly = yield* prepareRecallSectionsAttempt(
        config,
        input,
        emptyRecallSemanticScoresResult(semanticResult.warning),
      );
      return {...lexicalOnly.sections, semanticResult: emptyRecallSemanticScoresResult(semanticResult.warning)};
    }
    semanticResult = yield* loadRecallSemanticScoresResult(config, input.query, input.limit);
  }
});

const prepareRecallSectionsAttempt = Effect.fn('recall.prepareSectionsAttempt')(function* <R>(
  config: RecallRuntimeConfig,
  input: PrepareRecallSectionsInput<R>,
  semanticResult: RecallSemanticScoresResult,
) {
  const semanticScores = Option.getOrUndefined(semanticResult.scores);
  const rankingUris = [
    ...new Set([
      ...input.passes.flatMap(pass => pass.map(hit => hit.uri.replace(/#.*$/, ''))),
      ...input.exactMatches.map(match => match.uri.replace(/#.*$/, '')),
      ...(semanticScores?.keys() ?? []),
    ]),
  ];
  const records = yield* input.readRecords(rankingUris);
  const now = new Date(yield* Clock.currentTimeMillis);
  const queryVariants = recallQueryVariants(input.query, input.queryVariants);
  const indexQueries = [input.query, ...queryVariants];
  const scopeSets: ReadonlyArray<readonly string[] | undefined> = input.allowedUriScopes?.length
    ? [input.allowedUriScopes]
    : input.preferredUriScopes?.length
      ? [input.preferredUriScopes, undefined]
      : [undefined];
  const [feedbackByUri, recallIndexes] = yield* Effect.all(
    [
      loadRecallFeedback(config.agentContextHome, {
        now,
        project: input.project,
        query: input.feedbackQuery,
      }),
      loadRecallIndexDataBatch(config, {
        includeInactive: input.includeInactive,
        selections: indexQueries.flatMap(indexQuery =>
          scopeSets.map(allowedUriScopes => ({
            allowedUriScopes,
            limit: Math.max(INDEX_CANDIDATE_MINIMUM, input.limit * INDEX_CANDIDATE_MULTIPLIER),
            query: indexQuery,
            requiredUris: rankingUris,
          })),
        ),
      }).pipe(Effect.catch(() => Effect.succeed([]))),
    ],
    {concurrency: 2},
  );
  const flattenedRecallIndexes = recallIndexes;
  const generations = [
    ...new Set(flattenedRecallIndexes.flatMap(index => (index?.generation ? [index.generation] : []))),
  ];
  const recallIndex = flattenedRecallIndexes.find(index => index !== undefined);
  const recallIndexCandidateSets = flattenedRecallIndexes.map(index => index?.candidates ?? []);
  const semanticCandidates = mergeRecallIndexCandidates(recallIndexCandidateSets).map(candidate => {
    const semantic = semanticScores?.get(candidate.uri.replace(/#.*$/, ''));
    return semantic === undefined ? candidate : {...candidate, semantic};
  });
  const indexedCandidates = yield* applySelectedNativeReranker(
    config.agentContextHome,
    input.query,
    semanticCandidates,
    input.rerankerCache,
  ).pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        if (input.rerankerCache) input.rerankerCache.unavailable = true;
        return applyCachedRerankerScores(semanticCandidates, input.rerankerCache);
      }),
    ),
  );
  const expansionCandidates = mergeRecallExpansionCandidates(recallIndexCandidateSets, rankingUris);
  const sections = buildRecallSections(input.passes, input.exactMatches, input.limit, {
    allowExactRescue: input.allowExactRescue,
    allowedUriScopes: input.allowedUriScopes,
    candidateUris: input.candidateUris,
    corpusStatistics: recallIndex?.corpusStatistics,
    feedbackByUri,
    includeInactive: input.includeInactive,
    indexedCandidates,
    minimumScore: input.minimumScore,
    now,
    project: input.project,
    query: input.query,
    queryVariants,
    records,
    seedUris: input.seedUris,
  });
  return {generations, sections: {...sections, expansionCandidates}};
});

export interface RecallSemanticScoresResult {
  readonly corpusGeneration: Option.Option<string>;
  readonly scores: Option.Option<ReadonlyMap<string, number>>;
  readonly warning: Option.Option<string>;
}

export type BoundedRecallSemanticRetrieval<A> =
  | {readonly status: 'completed'; readonly value: A}
  | {readonly cause: Cause.Cause<unknown>; readonly status: 'failed'}
  | {readonly status: 'timed-out'};

export interface McpRecallSemanticScoresResult {
  readonly result: RecallSemanticScoresResult;
  readonly status: 'available' | 'failed' | 'timed-out' | 'unavailable';
}

function emptyRecallSemanticScoresResult(warning: Option.Option<string> = Option.none()): RecallSemanticScoresResult {
  return {
    corpusGeneration: Option.none(),
    scores: Option.none(),
    warning,
  };
}

export function boundedRecallSemanticRetrieval<A, E, R>(
  retrieval: Effect.Effect<A, E, R>,
): Effect.Effect<BoundedRecallSemanticRetrieval<A>, never, R> {
  return retrieval.pipe(
    Effect.map(value => ({status: 'completed' as const, value})),
    Effect.catchCause(cause =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.succeed({cause: cause as Cause.Cause<unknown>, status: 'failed' as const}),
    ),
    Effect.timeoutOrElse({
      duration: MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS,
      orElse: () => Effect.succeed({status: 'timed-out' as const}),
    }),
  );
}

/**
 * MCP recall uses only the already-active lexical/vector generations. It never
 * builds, repairs, or retries derived storage while a client request is open.
 */
export const loadMcpRecallSemanticScoresResult = Effect.fn('recall.loadMcpSemanticScoresResult')(function* (
  config: RecallRuntimeConfig,
  query: string,
  limit: number,
) {
  const semanticLimit = Math.max(INDEX_CANDIDATE_MINIMUM, limit * INDEX_CANDIDATE_MULTIPLIER);
  const attempt = yield* boundedRecallSemanticRetrieval(
    loadReadOnlySemanticScoresAttempt(config, query, semanticLimit),
  );
  if (attempt.status === 'timed-out') {
    return {
      result: emptyRecallSemanticScoresResult(Option.some(semanticRecallTimeoutWarning())),
      status: 'timed-out',
    } satisfies McpRecallSemanticScoresResult;
  }
  if (attempt.status === 'failed') {
    return {
      result: emptyRecallSemanticScoresResult(Option.some(semanticRecallFailureWarning(attempt.cause))),
      status: 'failed',
    } satisfies McpRecallSemanticScoresResult;
  }
  if (attempt.value === undefined || attempt.value.scores === undefined) {
    return {result: emptyRecallSemanticScoresResult(), status: 'unavailable'} satisfies McpRecallSemanticScoresResult;
  }
  return {
    result: {
      corpusGeneration: Option.some(attempt.value.corpusGeneration),
      scores: Option.fromNullishOr(attempt.value.scores),
      warning: Option.none(),
    },
    status: 'available',
  } satisfies McpRecallSemanticScoresResult;
});

const loadReadOnlySemanticScoresAttempt = Effect.fn('recall.loadReadOnlySemanticScoresAttempt')(function* (
  config: RecallRuntimeConfig,
  query: string,
  limit: number,
) {
  const selection = yield* readModelSelection(config.agentContextHome);
  const modelId = selection.roles.embedding;
  if (!modelId) return undefined;
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(modelId);
  if (manifest.role !== 'embedding') return undefined;
  const store = yield* LocalModelStore;
  const installed = yield* store.status(config.agentContextHome, manifest);
  if (!installed.installed) return undefined;
  const corpusGeneration = yield* currentRecallCorpusGeneration(config);
  if (Option.isNone(corpusGeneration)) return undefined;
  if (!(yield* vectorIndexMatchesGeneration(config.agentContextHome, manifest, corpusGeneration.value))) {
    return undefined;
  }
  const scores = yield* selectedSemanticScores(config, query, {
    corpusGeneration: corpusGeneration.value,
    currentCorpusGeneration: () => currentRecallCorpusGeneration(config),
    limit,
  });
  return {corpusGeneration: corpusGeneration.value, scores};
});

const semanticResultMatchesLexicalSnapshot = Effect.fn('recall.semanticResultMatchesLexicalSnapshot')(function* (
  config: RecallRuntimeConfig,
  semanticResult: RecallSemanticScoresResult,
  snapshotGenerations: readonly string[],
) {
  if (Option.isNone(semanticResult.scores)) return true;
  if (Option.isNone(semanticResult.corpusGeneration)) return false;
  const semanticGeneration = semanticResult.corpusGeneration.value;
  if (snapshotGenerations.length !== 1 || snapshotGenerations[0] !== semanticGeneration) {
    return false;
  }
  const currentGeneration = yield* currentRecallCorpusGeneration(config);
  return Option.isSome(currentGeneration) && currentGeneration.value === semanticGeneration;
});

export const loadRecallSemanticScoresResult = Effect.fn('recall.loadSemanticScoresResult')(function* (
  config: RecallRuntimeConfig,
  query: string,
  limit: number,
) {
  return yield* Effect.gen(function* () {
    const selection = yield* readModelSelection(config.agentContextHome);
    const modelId = selection.roles.embedding;
    if (!modelId) return undefined;
    const catalog = yield* LocalModelCatalog;
    const manifest = yield* catalog.get(modelId);
    if (manifest.role !== 'embedding') return undefined;
    const store = yield* LocalModelStore;
    const installed = yield* store.status(config.agentContextHome, manifest);
    if (!installed.installed) return undefined;
    const semanticLimit = Math.max(INDEX_CANDIDATE_MINIMUM, limit * INDEX_CANDIDATE_MULTIPLIER);
    return yield* loadCurrentSemanticScores(config, manifest, query, semanticLimit);
  }).pipe(
    Effect.map(snapshot =>
      snapshot === undefined
        ? emptyRecallSemanticScoresResult()
        : ({
            corpusGeneration: Option.some(snapshot.corpusGeneration),
            scores: Option.fromNullishOr(snapshot.scores),
            warning: Option.none(),
          } satisfies RecallSemanticScoresResult),
    ),
    Effect.catchCause(cause =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.succeed(emptyRecallSemanticScoresResult(Option.some(semanticRecallFailureWarning(cause)))),
    ),
  );
});

const loadCurrentSemanticScores = Effect.fn('recall.loadCurrentSemanticScores')(function* (
  config: RecallRuntimeConfig,
  manifest: LocalModelManifest,
  query: string,
  limit: number,
) {
  for (let retry = 0; retry <= SEMANTIC_GENERATION_RETRY_LIMIT; retry += 1) {
    const attempt = yield* loadSemanticScoresAttempt(config, manifest, query, limit).pipe(Effect.result);
    if (Result.isSuccess(attempt)) return attempt.success;
    if (attempt.failure instanceof VectorCorpusGenerationChanged && retry < SEMANTIC_GENERATION_RETRY_LIMIT) {
      continue;
    }
    return yield* Effect.fail(attempt.failure);
  }
  return yield* Effect.die(new Error('Semantic generation retry loop exhausted without a result.'));
});

const loadSemanticScoresAttempt = Effect.fn('recall.loadSemanticScoresAttempt')(function* (
  config: RecallRuntimeConfig,
  manifest: LocalModelManifest,
  query: string,
  limit: number,
) {
  const fence = () => currentRecallCorpusGeneration(config);
  const snapshot = yield* loadRecallIndexData(config, {
    includeInactive: false,
    limit: 0,
    query: '',
  });
  let corpusGeneration = snapshot.generation;
  if (!(yield* vectorIndexMatchesGeneration(config.agentContextHome, manifest, corpusGeneration))) {
    const index = yield* loadRecallIndexData(config, {includeInactive: false});
    corpusGeneration = index.generation;
    yield* ensureVectorIndex(config, manifest, index.candidates, {
      corpusGeneration,
      currentCorpusGeneration: fence,
    });
  }
  return yield* selectedSemanticScores(config, query, {
    corpusGeneration,
    currentCorpusGeneration: fence,
    limit,
  }).pipe(
    Effect.map(scores => ({corpusGeneration, scores})),
    Effect.catchIf(
      (error): error is VectorIndexCorrupt => error instanceof VectorIndexCorrupt,
      () =>
        Effect.gen(function* () {
          const index = yield* loadRecallIndexData(config, {includeInactive: false});
          yield* rebuildVectorIndex(config, manifest, index.candidates, {
            corpusGeneration: index.generation,
            currentCorpusGeneration: fence,
          });
          const scores = yield* selectedSemanticScores(config, query, {
            corpusGeneration: index.generation,
            currentCorpusGeneration: fence,
            limit,
          });
          return {corpusGeneration: index.generation, scores};
        }),
    ),
  );
});

export const loadRecallSemanticScores = Effect.fn('recall.loadSemanticScores')(function* (
  config: RecallRuntimeConfig,
  query: string,
  limit: number,
) {
  const result = yield* loadRecallSemanticScoresResult(config, query, limit);
  if (Option.isSome(result.warning)) yield* Console.warn(result.warning.value);
  return Option.getOrUndefined(result.scores);
});

function semanticRecallFailureWarning(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const failureType =
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    error._tag === 'EmbeddingFailed' &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.includes('isolated worker retry was exhausted')
      ? 'LocalModelWorkerRetryExhausted'
      : semanticRecallFailureType(error);
  return (
    `Local AI recall warning: semantic retrieval failed (${failureType}); deterministic lexical recall continued. ` +
    'Run threadnote doctor --dry-run if this repeats.'
  );
}

function semanticRecallTimeoutWarning(): string {
  return (
    `Local AI recall warning: semantic retrieval timed out after ${MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS}ms; ` +
    'deterministic lexical recall continued. Run threadnote doctor --dry-run if this repeats.'
  );
}

function semanticRecallFailureType(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('_tag' in error) || typeof error._tag !== 'string') {
    return 'SemanticRecallUnavailable';
  }
  return [
    'EmbeddingFailed',
    'InferenceInterrupted',
    'InsufficientMemory',
    'ModelLoadFailed',
    'ModelNotInstalled',
    'NativeRuntimeUnavailable',
    'UnsupportedNativeRuntime',
    'VectorIndexCorrupt',
  ].includes(error._tag)
    ? error._tag
    : 'SemanticRecallUnavailable';
}

const applySelectedNativeReranker = Effect.fn('recall.applySelectedNativeReranker')(function* (
  home: string,
  query: string,
  candidates: readonly RecallCandidate[],
  cache?: RecallRerankerCache,
) {
  const shortlist = candidates.slice(0, NATIVE_RERANK_CANDIDATE_LIMIT);
  if (shortlist.length === 0) return candidates;
  const missing = shortlist.filter(candidate => !cache?.scores.has(rerankerCacheKey(candidate)));
  if (missing.length === 0 || cache?.unavailable === true) {
    return applyCachedRerankerScores(candidates, cache);
  }
  const scores = yield* rerankWithSelectedLocalModel(
    home,
    query,
    missing.map(candidate => candidate.text.slice(0, NATIVE_RERANK_DOCUMENT_LIMIT)),
  );
  if (!scores) {
    if (cache) cache.unavailable = true;
    return applyCachedRerankerScores(candidates, cache);
  }
  const scoresByKey = cache?.scores ?? new Map<string, number>();
  for (const [index, candidate] of missing.entries()) {
    scoresByKey.set(rerankerCacheKey(candidate), normalizeRecallRerankerScore(scores[index] ?? 0));
  }
  return applyCachedRerankerScores(candidates, {scores: scoresByKey, unavailable: false});
});

function applyCachedRerankerScores(
  candidates: readonly RecallCandidate[],
  cache: RecallRerankerCache | undefined,
): readonly RecallCandidate[] {
  if (!cache || cache.scores.size === 0) return candidates;
  return candidates.map(candidate => {
    const reranker = cache.scores.get(rerankerCacheKey(candidate));
    return reranker === undefined ? candidate : {...candidate, reranker};
  });
}

function rerankerCacheKey(candidate: RecallCandidate): string {
  return `${candidate.uri}\u0000${candidate.text}`;
}

export function buildRecallSelectionCandidates(
  ranked: readonly RecallHit[],
  indexedCandidates: readonly RecallCandidate[],
  limit: number,
): readonly RecallSelectionCandidate[] {
  const indexedByUri = new Map(indexedCandidates.map(candidate => [candidate.uri.replace(/#.*$/, ''), candidate]));
  return ranked.slice(0, Math.min(limit, MAX_RECALL_SELECTION_CANDIDATES)).map((hit, index) => {
    const uri = hit.uri.replace(/#.*$/, '');
    const indexed = indexedByUri.get(uri);
    const uriTopic = uri.slice(uri.lastIndexOf('/') + 1).replace(/\.[a-z0-9]+$/i, '');
    const project =
      indexed?.fields?.project ??
      memoryUriProjectSegment(uri) ??
      /^threadnote:\/\/resources\/repos\/([^/]+)/.exec(uri)?.[1];
    const fields = [
      `category=${hit.category}`,
      project ? `project=${project}` : undefined,
      `topic=${indexed?.fields?.topic ?? uriTopic}`,
      indexed?.fields?.title ? `title=${indexed.fields.title}` : undefined,
      indexed?.fields?.keywords?.length ? `keywords=${indexed.fields.keywords.join(', ')}` : undefined,
    ].filter((field): field is string => field !== undefined);
    const excerpt = recallSelectionExcerpt(indexed?.text || hit.snippet || '');
    return {
      id: `c${index + 1}`,
      summary: [...fields, excerpt ? `excerpt=${excerpt}` : undefined]
        .filter((part): part is string => part !== undefined)
        .join(' | '),
      uri,
    };
  });
}

export function buildRecallIndexSelectionCandidates(
  indexedCandidates: readonly RecallCandidate[],
  project: string | undefined,
  limit: number,
): readonly RecallSelectionCandidate[] {
  const normalizedProject = project?.trim().toLowerCase();
  const candidates = normalizedProject
    ? indexedCandidates.filter(candidate => candidate.fields?.project?.trim().toLowerCase() === normalizedProject)
    : indexedCandidates;
  return candidates.slice(0, Math.min(limit, MAX_RECALL_SELECTION_CANDIDATES)).map((candidate, index) => {
    const uri = candidate.uri.replace(/#.*$/, '');
    const uriTopic = uri.slice(uri.lastIndexOf('/') + 1).replace(/\.[a-z0-9]+$/i, '');
    const fields = [
      candidate.kind ? `kind=${candidate.kind}` : 'category=resource',
      candidate.fields?.project ? `project=${candidate.fields.project}` : undefined,
      `topic=${candidate.fields?.topic ?? uriTopic}`,
      candidate.fields?.title ? `title=${candidate.fields.title}` : undefined,
      candidate.fields?.keywords?.length ? `keywords=${candidate.fields.keywords.join(', ')}` : undefined,
    ].filter((field): field is string => field !== undefined);
    const excerpt = recallSelectionExcerpt(candidate.text);
    return {
      id: `c${index + 1}`,
      summary: [...fields, excerpt ? `excerpt=${excerpt}` : undefined]
        .filter((part): part is string => part !== undefined)
        .join(' | '),
      uri,
    };
  });
}

export function recallSelectionQueries(
  candidates: readonly RecallSelectionCandidate[],
  indexedCandidates: readonly RecallCandidate[],
  selectedIds: readonly string[],
  originalQuery: string,
  limit: number,
): readonly string[] {
  const selectedUris = new Set(
    candidates.filter(candidate => selectedIds.includes(candidate.id)).map(candidate => candidate.uri),
  );
  const queryTerms = new Map(
    recallTokens(originalQuery).flatMap(term => {
      const weight = /^\p{Lu}[\p{Lu}\p{N}_.-]{2,}$/u.test(term) ? 4 : 1;
      return recallLexicalTerms(term).map(normalized => [normalized, weight] as const);
    }),
  );
  const selectedCandidates = indexedCandidates
    .map((candidate, index) => {
      const fieldTerms = new Set(
        recallLexicalTerms(
          [candidate.fields?.topic, candidate.fields?.title, ...(candidate.fields?.keywords ?? [])]
            .filter((value): value is string => value !== undefined)
            .join(' '),
        ),
      );
      const bodyTerms = new Set(recallLexicalTerms(candidate.text));
      return {
        candidate,
        index,
        overlap: [...queryTerms].reduce(
          (score, [term, weight]) =>
            score + (fieldTerms.has(term) ? weight * 2 : 0) + (bodyTerms.has(term) ? weight : 0),
          0,
        ),
      };
    })
    .filter(({candidate}) => selectedUris.has(candidate.uri.replace(/#.*$/, '')))
    .sort((left, right) => right.overlap - left.overlap || left.index - right.index);
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const {candidate} of selectedCandidates) {
    const query = candidate.fields?.topic?.trim() || candidate.fields?.title?.trim();
    const key = query?.toLowerCase();
    if (!query || !key || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length === limit) break;
  }
  return queries;
}

function recallSelectionExcerpt(value: string): string {
  const terms: string[] = [];
  let previous = '';
  for (const term of value.replace(/\s+/g, ' ').trim().split(' ')) {
    const key = term.toLowerCase();
    if (!term || key === previous) continue;
    terms.push(term);
    previous = key;
  }
  return terms.join(' ').slice(0, 240).trim();
}

export function recallSelectionAnchorIds(
  candidates: readonly RecallSelectionCandidate[],
  ranked: readonly RecallHit[],
): readonly string[] {
  const idByUri = new Map(candidates.map(candidate => [candidate.uri, candidate.id]));
  return ranked
    .slice(0, 2)
    .filter(hit => !hit.rankWarnings?.some(warning => warning.includes('lexical-only')))
    .map(hit => idByUri.get(hit.uri.replace(/#.*$/, '')))
    .filter((id): id is string => id !== undefined);
}

export function selectedRecallCandidateUris(
  candidates: readonly RecallSelectionCandidate[],
  selectedIds: readonly string[],
  anchorIds: readonly string[] = [],
): readonly string[] {
  if (selectedIds.length === 0) {
    return [];
  }
  const selected = new Set([...anchorIds, ...selectedIds]);
  return candidates
    .filter(candidate => selected.has(candidate.id))
    .slice(0, 8)
    .map(candidate => candidate.uri);
}

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
  const rankedCandidates = (input.rankedCandidates ?? []).filter(candidate =>
    recallUriMatchesScopes(candidate.uri, input.allowedUriScopes),
  );
  const rankedVocabulary = recallExpansionVocabulary(rankedCandidates, input.project);
  if (rankedVocabulary.length >= EXPANSION_VOCABULARY_LIMIT) {
    return rankedVocabulary;
  }
  const index = yield* loadRecallIndexData(config, {
    allowedUriScopes: input.allowedUriScopes,
    includeInactive: input.includeInactive,
    limit: EXPANSION_VOCABULARY_INDEX_SAMPLE_LIMIT,
    project: input.project,
  });
  return recallExpansionVocabulary(mergeRecallIndexCandidates([rankedCandidates, index.candidates]), input.project);
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

export function mergeRecallExpansionCandidates(
  candidateSets: readonly (readonly RecallCandidate[])[],
  requiredUris: readonly string[],
): readonly RecallCandidate[] {
  const required = new Set(requiredUris.map(uri => uri.replace(/#.*$/, '')));
  return mergeRecallIndexCandidates(
    candidateSets.map(candidates => [
      ...candidates.filter(candidate => !required.has(candidate.uri.replace(/#.*$/, ''))),
      ...candidates.filter(candidate => required.has(candidate.uri.replace(/#.*$/, ''))),
    ]),
  );
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
