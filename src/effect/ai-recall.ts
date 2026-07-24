import {Context, Effect, Layer, Schema} from 'effect';
import {LanguageModel} from 'effect/unstable/ai';
import {shouldExpandRecall, type RecallConfidenceLevel} from '../recall/rank.js';
import type {RuntimeConfig} from '../types.js';
import {
  effectAiLanguageModelLayer,
  ensureEffectAiReady,
  type EffectAiConfiguration,
  type ResolvedEffectAiConfiguration,
} from './ai-consolidator.js';
import {sha256Hex} from './digest.js';

const MAX_RECALL_REWRITES = 2;
const MAX_RECALL_REWRITE_LENGTH = 512;
const MAX_RECALL_EXPANSION_SCOPES = 1;
const MAX_RECALL_EXPANSION_CACHE_ENTRIES = 128;
const RECALL_EXPANSION_TIMEOUT_MILLISECONDS = 5_000;
const RECALL_VOCABULARY_DESCRIPTION_SEPARATOR = ' :: ';

export interface RecallExpansionInput {
  readonly project?: string;
  readonly query: string;
  readonly vocabulary?: readonly string[];
}

export class AiRecallExpansionFailed extends Schema.TaggedErrorClass<AiRecallExpansionFailed>()(
  'AiRecallExpansionFailed',
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

const RecallExpansionDraft = Schema.Struct({
  queries: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_RECALL_REWRITE_LENGTH)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_RECALL_REWRITES)),
});

export class RecallQueryExpander extends Context.Service<
  RecallQueryExpander,
  {
    readonly expand: (input: RecallExpansionInput) => Effect.Effect<readonly string[], AiRecallExpansionFailed>;
  }
>()('threadnote/effect/RecallQueryExpander') {}

export const expandRecallQueryEffect = Effect.fn('RecallQueryExpander.expand')(function* (input: RecallExpansionInput) {
  const expander = yield* RecallQueryExpander;
  return yield* expander.expand(input);
});

export function recallQueryExpanderLayer(config: EffectAiConfiguration): Layer.Layer<RecallQueryExpander> {
  return Layer.effect(
    RecallQueryExpander,
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel;
      return RecallQueryExpander.of({
        expand: input =>
          model
            .generateObject({
              objectName: 'threadnote_recall_query_expansion',
              prompt: recallExpansionPrompt(input),
              schema: RecallExpansionDraft,
            })
            .pipe(
              Effect.map(response => normalizeRecallRewrites(input.query, response.value.queries, input.vocabulary)),
              Effect.mapError(cause =>
                cause instanceof AiRecallExpansionFailed
                  ? cause
                  : new AiRecallExpansionFailed({
                      cause,
                      message: 'Effect AI recall query expansion failed.',
                    }),
              ),
            ),
      });
    }),
  ).pipe(Layer.provide(effectAiLanguageModelLayer(config, 128)));
}

const expansionCache = new Map<string, readonly string[]>();

export const runEffectAiRecallExpansion = Effect.fn('RecallQueryExpander.run')(function* (
  input: RecallExpansionInput,
  config: EffectAiConfiguration,
) {
  const fingerprint = yield* sha256Hex(
    [
      config.apiUrl ?? '',
      config.model,
      input.project ?? '',
      normalizeQuery(input.query),
      ...(input.vocabulary ?? []),
    ].join('\u0000'),
  );
  const cached = expansionCache.get(fingerprint);
  if (cached) {
    expansionCache.delete(fingerprint);
    expansionCache.set(fingerprint, cached);
    return cached;
  }
  const rewrites = yield* expandRecallQueryEffect(input).pipe(
    Effect.provide(recallQueryExpanderLayer(config)),
    Effect.timeoutOrElse({
      duration: RECALL_EXPANSION_TIMEOUT_MILLISECONDS,
      orElse: () => Effect.succeed([]),
    }),
    Effect.catch(() => Effect.succeed([])),
  );
  expansionCache.set(fingerprint, rewrites);
  while (expansionCache.size > MAX_RECALL_EXPANSION_CACHE_ENTRIES) {
    const oldest = expansionCache.keys().next().value;
    if (oldest === undefined) break;
    expansionCache.delete(oldest);
  }
  return rewrites;
});

export const expandWeakRecallQueryEffect = Effect.fn('RecallQueryExpander.expandWeakRecall')(function* (
  input: RecallExpansionInput & {readonly confidence: {readonly level: RecallConfidenceLevel} | undefined},
  runtimeConfig: Pick<RuntimeConfig, 'agentContextHome'>,
  resolved: ResolvedEffectAiConfiguration | undefined,
) {
  if (!shouldExpandRecall(input.confidence)) return [];
  if (!resolved) return [];
  const ready = yield* ensureEffectAiReady(runtimeConfig, resolved).pipe(
    Effect.as(true),
    Effect.timeoutOrElse({
      duration: RECALL_EXPANSION_TIMEOUT_MILLISECONDS,
      orElse: () => Effect.succeed(false),
    }),
    Effect.catch(() => Effect.succeed(false)),
  );
  if (!ready) return [];
  const config = resolved.configuration;
  const expansionInput = isLoopbackAiEndpoint(config.apiUrl) ? input : {project: input.project, query: input.query};
  const rewrites = yield* runEffectAiRecallExpansion(expansionInput, config);
  return limitRecallRewritesForConfidence(input.confidence, rewrites);
});

export {shouldExpandRecall};

export function limitRecallRewritesForConfidence(
  confidence: {readonly level: RecallConfidenceLevel} | undefined,
  rewrites: readonly string[],
): readonly string[] {
  return confidence?.level === 'medium' ? rewrites.slice(0, 1) : rewrites;
}

export function recallMinimumScoreAfterExpansion(threshold: number, explicitThreshold: boolean): number | undefined {
  return explicitThreshold ? threshold : undefined;
}

export function normalizeRecallRewrites(
  originalQuery: string,
  rewrites: readonly string[],
  vocabulary?: readonly string[],
): readonly string[] {
  const original = normalizeQuery(originalQuery).toLowerCase();
  const vocabularyTerms = vocabulary
    ?.map(term => normalizeQuery(term.split(RECALL_VOCABULARY_DESCRIPTION_SEPARATOR, 1)[0] ?? ''))
    .filter(term => term.length > 0);
  const seen = new Set<string>([original]);
  const normalized: string[] = [];
  for (const rewrite of rewrites) {
    const rawCandidate = normalizeQuery(rewrite);
    const groundedTerm = vocabularyTerms
      ?.filter(term => containsExactTerm(rawCandidate, term))
      .sort((left, right) => right.length - left.length)[0];
    const candidate = vocabularyTerms && vocabularyTerms.length > 0 ? groundedTerm : rawCandidate;
    const key = candidate?.toLowerCase();
    if (!candidate || !key || candidate.length > MAX_RECALL_REWRITE_LENGTH || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(candidate);
    if (normalized.length === MAX_RECALL_REWRITES) break;
  }
  return normalized;
}

export function boundedRecallExpansionScopes(scopes: readonly (string | undefined)[]): readonly (string | undefined)[] {
  const seen = new Set<string>();
  const bounded: Array<string | undefined> = [];
  for (const scope of scopes) {
    const key = scope ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    bounded.push(scope);
    if (bounded.length === MAX_RECALL_EXPANSION_SCOPES) break;
  }
  return bounded;
}

function recallExpansionPrompt(input: RecallExpansionInput): string {
  const localVocabulary = input.vocabulary?.filter(term => term.trim().length > 0);
  if (localVocabulary && localVocabulary.length > 0) {
    return [
      'Select at most two memory-search topics from the local project vocabulary.',
      'Match the meaning of the original query to the most relevant existing topic or identifier.',
      'Judge the whole query; do not select a topic because it matches only one incidental word.',
      'Treat generic project, platform, device, and app words as context rather than the primary match.',
      'Resolve paraphrases into their conventional technical mechanism, then prefer the candidate whose topic or excerpt names that mechanism.',
      'Return one query by default. Return two only when two vocabulary items are near-equal semantic matches.',
      'Every query must contain at least one vocabulary item copied exactly, including punctuation.',
      'Prefer an exact vocabulary item over an invented synonym or hyphenated paraphrase.',
      'Add original query terms only when they help disambiguate the selected vocabulary item.',
      'Candidate entries use "topic :: local index excerpt". Copy only the topic before "::", not the excerpt.',
      'Do not answer the question, write prose, or introduce another topic.',
      `Project: ${input.project ?? 'unknown'}`,
      `Original query: ${input.query}`,
      `Local candidates:\n${localVocabulary.map(candidate => `- ${candidate}`).join('\n')}`,
    ].join('\n');
  }
  return [
    'Rewrite a weak memory-search query into at most two concise keyword-style retrieval queries.',
    'Translate conversational wording into likely source-code, configuration, and feature terminology.',
    'Each array item must be one complete search phrase, not one token.',
    'Keep the original topic and nouns; do not answer the question, write prose, or introduce another topic.',
    'Preserve identifiers, quoted strings, version numbers, platform names, and proper nouns exactly.',
    'Do not add facts that are not implied by the query or project.',
    `Project: ${input.project ?? 'unknown'}`,
    `Original query: ${input.query}`,
  ].join('\n');
}

export function isLoopbackAiEndpoint(apiUrl: string | undefined): boolean {
  if (!apiUrl) return false;
  try {
    const hostname = new URL(apiUrl).hostname.toLowerCase();
    return (
      hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost' || hostname.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

export function localRecallAiEnabled(config: EffectAiConfiguration | undefined): boolean {
  return config !== undefined && isLoopbackAiEndpoint(config.apiUrl);
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

function containsExactTerm(candidate: string, term: string): boolean {
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedTerm = term.toLowerCase();
  let offset = normalizedCandidate.indexOf(normalizedTerm);
  while (offset >= 0) {
    const before = normalizedCandidate[offset - 1];
    const after = normalizedCandidate[offset + normalizedTerm.length];
    if ((!before || !/[a-z0-9]/.test(before)) && (!after || !/[a-z0-9]/.test(after))) {
      return true;
    }
    offset = normalizedCandidate.indexOf(normalizedTerm, offset + 1);
  }
  return false;
}
