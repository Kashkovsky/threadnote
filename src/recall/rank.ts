import type {MemoryAuthority, MemoryRelation, MemoryTrust} from '../memory_document.js';
import type {MemoryKind, MemoryStatus} from '../types.js';

export const RECALL_RANKER_VERSION = 'hybrid-v2';

export interface RecallFields {
  readonly identifiers?: readonly string[];
  readonly keywords?: readonly string[];
  readonly project?: string;
  readonly title?: string;
  readonly topic?: string;
}

export interface RecallCandidate {
  readonly authority?: MemoryAuthority;
  readonly exactTerms?: readonly string[];
  readonly feedback?: number;
  readonly fields?: RecallFields;
  readonly kind?: MemoryKind;
  readonly relations?: readonly MemoryRelation[];
  readonly reranker?: number;
  readonly semantic?: number;
  readonly status?: MemoryStatus;
  readonly text: string;
  readonly timestamp?: string;
  readonly trust?: MemoryTrust;
  readonly uri: string;
  readonly validFrom?: string;
  readonly validTo?: string;
}

export interface RecallRankContext {
  readonly allowExactRescue?: boolean;
  readonly corpusStatistics?: RecallCorpusStatistics;
  readonly includeInactive?: boolean;
  readonly includeTemporallyInvalid?: boolean;
  readonly minimumScore?: number;
  readonly now?: Date;
  readonly project?: string;
  readonly queryVariants?: readonly string[];
  readonly seedUris?: readonly string[];
}

export interface RecallCorpusStatistics {
  readonly averageDocumentLength: number;
  readonly documentCount: number;
  readonly documentFrequency: Readonly<Record<string, number>>;
  readonly totalDocumentLength: number;
}

export interface RecallSignals {
  readonly authority: number;
  readonly bm25: number;
  readonly exact: number;
  readonly feedback: number;
  readonly field: number;
  readonly freshness: number;
  readonly graph: number;
  readonly kindIntent: number;
  readonly lifecycle: number;
  readonly reranker: number;
  readonly scope: number;
  readonly semantic: number;
  readonly temporal: number;
}

export interface RecallReason {
  readonly code: string;
  readonly contribution: number;
  readonly detail: string;
}

export interface RankedRecallCandidate {
  readonly candidate: RecallCandidate;
  readonly finalScore: number;
  readonly passedRelevanceGate: boolean;
  readonly relevanceScore: number;
  readonly reasons: readonly RecallReason[];
  readonly signals: RecallSignals;
  readonly warnings: readonly string[];
}

export type RecallConfidenceLevel = 'high' | 'low' | 'medium' | 'no_answer';

export interface RecallConfidence {
  readonly level: RecallConfidenceLevel;
  readonly margin: number;
  readonly reason: string;
  readonly score: number;
}

export interface RankedRecallSet {
  readonly confidence: RecallConfidence;
  readonly rankerVersion: typeof RECALL_RANKER_VERSION;
  readonly results: readonly RankedRecallCandidate[];
}

export function shouldExpandRecall(confidence: {readonly level: RecallConfidenceLevel} | undefined): boolean {
  return confidence !== undefined && confidence.level !== 'high';
}

const SIGNAL_WEIGHTS = {
  authority: 0.04,
  bm25: 0.18,
  exact: 0.18,
  feedback: 0.03,
  field: 0.16,
  freshness: 0.04,
  graph: 0.07,
  kindIntent: 0.04,
  lifecycle: 0.05,
  reranker: 0.1,
  scope: 0.03,
  semantic: 0.16,
  temporal: 0.02,
} as const;

const FIELD_WEIGHTS = {
  identifiers: 0.15,
  keywords: 0.2,
  project: 0.2,
  title: 0.35,
  topic: 0.3,
} as const;

const BM25_SATURATION = 1.2;
const BM25_LENGTH_NORMALIZATION = 0.75;
const BM25_IDF_SMOOTHING = 0.5;
const FIELD_QUERY_COVERAGE_WEIGHT = 0.4;
const FIELD_VALUE_PRECISION_WEIGHT = 0.6;
const FIELD_EXACT_SUBSET_BONUS = 0.2;
const RELEVANCE_GATE_MINIMUM = 0.08;
const EXACT_TERM_RESCUE_MINIMUM = 0.75;
const EXACT_TERM_RESCUE_FIELD_MINIMUM = 0.35;
const EXACT_CONTEXTUAL_TERM_SCORE = 1;
const EXACT_MULTI_TERM_BASE_SCORE = 0.4;
const EXACT_MULTI_TERM_IDF_COVERAGE_WEIGHT = 0.6;
const EXACT_IDENTIFIER_SCORE = 0.9;
const EXACT_MULTI_TERM_MINIMUM = 2;
const NO_ANSWER_SCORE_MINIMUM = 0.2;
const LEXICAL_ONLY_ANSWER_MINIMUM = 0.5;
const LEXICAL_ONLY_FOCUSED_FIELD_MINIMUM = 0.08;
const SIGNAL_ABSENCE_MAXIMUM = 0.05;
const TEMPORALLY_INVALID_SCORE_MULTIPLIER = 0.25;
const UNKNOWN_FRESHNESS_SCORE = 0.5;
const UNKNOWN_SCOPE_SCORE = 0.5;

const intentTerms = (terms: string): ReadonlySet<string> => new Set(terms.split(' '));

const MEMORY_KIND_INTENT_TERMS: Readonly<Record<MemoryKind, ReadonlySet<string>>> = {
  durable: intentTerms('contract decision invariant policy unsupported'),
  handoff: intentTerms('branch current handoff status'),
  incident: intentTerms('failure incident outage regression'),
  preference: intentTerms('preference style tone'),
  smoke: intentTerms('smoke'),
};
const META_TOPIC_TERMS = intentTerms('audit backlog benchmark eval evaluation fixture');
const META_QUERY_INTENT_TERMS = intentTerms(
  'accuracy audit backlog benchmark eval evaluation fixture latency performance quality test testing trial',
);

const FRESHNESS_HALF_LIFE_DAYS: Readonly<Record<MemoryKind, number>> = {
  durable: 180,
  handoff: 14,
  incident: 90,
  preference: 365,
  smoke: 14,
};

const AUTHORITY_SCORES: Readonly<Record<MemoryAuthority, number>> = {
  agent_generated: 0.6,
  canonical_repo: 1,
  external: 0.45,
  reviewed_shared: 0.85,
  user_approved: 0.95,
};

const TRUST_SCORES: Readonly<Record<MemoryTrust, number>> = {
  approved: 1,
  inferred: 0.6,
  untrusted: 0.2,
};

const UNKNOWN_AUTHORITY_SCORE = 0.5;
const UNKNOWN_TRUST_SCORE = 0.5;
const AUTHORITY_BLEND_WEIGHT = 0.7;
const TRUST_BLEND_WEIGHT = 0.3;

const LIFECYCLE_SCORES: Readonly<Record<MemoryStatus, number>> = {
  active: 1,
  archived: 0.15,
  superseded: 0,
};

const LIFECYCLE_SCORE_MULTIPLIERS: Readonly<Record<MemoryStatus, number>> = {
  active: 1,
  archived: 0.35,
  superseded: 0.15,
};

const RELATION_WEIGHTS: Readonly<Record<MemoryRelation['type'], number>> = {
  depends_on: 0.9,
  evidence_for: 1,
  references: 0.65,
  related_to: 0.55,
  supersedes: 0.8,
};

const MAX_GRAPH_DISTANCE = 3;
const GRAPH_DISTANCE_PENALTY = 0.5;
const GRAPH_SEMANTIC_ANCHOR_MINIMUM = 0.65;
const MAX_GRAPH_SEMANTIC_ANCHORS = 2;
const SAME_IDENTITY_RELATION_WEIGHT = 0.75;
const SAME_IDENTITY_EDGE_WEIGHT = Math.sqrt(SAME_IDENTITY_RELATION_WEIGHT);
const IDENTITY_GRAPH_NODE_PREFIX = '\u0000identity:';
const EXPLANATION_CONTRIBUTION_MINIMUM = 0.005;
const CORROBORATING_SIGNAL_MINIMUM = 0.15;
const HIGH_CONFIDENCE_SCORE_MINIMUM = 0.58;
const HIGH_CONFIDENCE_MARGIN_MINIMUM = 0.08;
const HIGH_CONFIDENCE_SIGNAL_COUNT = 3;
const MEDIUM_CONFIDENCE_SCORE_MINIMUM = 0.36;
const MEDIUM_CONFIDENCE_SIGNAL_COUNT = 2;
const MILLISECONDS_PER_DAY = 86_400_000;
const HALF_LIFE_DECAY_BASE = 2;
const DETERMINISTIC_DEFAULT_NOW = new Date(0);

export function rankRecallCandidates(
  query: string,
  candidates: readonly RecallCandidate[],
  context: RecallRankContext = {},
): RankedRecallSet {
  const queryTermVariants = [
    tokenize(query),
    ...[...new Set(context.queryVariants?.map(variant => variant.trim()).filter(Boolean) ?? [])].map(tokenize),
  ];
  const corpus = candidates.map(candidate => recallDocumentTerms(candidate));
  const corpusStatistics = context.corpusStatistics ?? buildRecallCorpusStatistics(candidates);
  const semanticAnchors = candidates
    .filter(candidate => (candidate.semantic ?? 0) >= GRAPH_SEMANTIC_ANCHOR_MINIMUM)
    .sort((left, right) => (right.semantic ?? 0) - (left.semantic ?? 0))
    .slice(0, MAX_GRAPH_SEMANTIC_ANCHORS)
    .map(candidate => candidate.uri);
  const graphDistances = typedGraphDistances(candidates, [
    ...new Set([...(context.seedUris ?? []), ...semanticAnchors]),
  ]);
  const now = context.now ?? DETERMINISTIC_DEFAULT_NOW;
  const ranked = candidates
    .map((candidate, index) =>
      scoreCandidate(candidate, queryTermVariants, corpus[index] ?? [], corpusStatistics, graphDistances, {
        ...context,
        now,
      }),
    )
    .filter(
      result =>
        result.passedRelevanceGate &&
        (context.minimumScore === undefined ||
          result.relevanceScore >= context.minimumScore ||
          (context.allowExactRescue === true &&
            result.signals.exact >= EXACT_TERM_RESCUE_MINIMUM &&
            (result.signals.kindIntent === 1 ||
              result.signals.field >= EXACT_TERM_RESCUE_FIELD_MINIMUM ||
              qualifyingExactTerms(result.candidate).some(term => /[0-9_.-]/.test(term))))) &&
        (context.includeInactive === true || result.signals.lifecycle === LIFECYCLE_SCORES.active) &&
        (context.includeTemporallyInvalid === true || result.signals.temporal === 1),
    )
    .sort(
      (left, right) =>
        right.finalScore - left.finalScore ||
        right.signals.reranker - left.signals.reranker ||
        right.signals.semantic - left.signals.semantic ||
        left.candidate.uri.localeCompare(right.candidate.uri),
    );
  return {
    confidence: assessConfidence(ranked),
    rankerVersion: RECALL_RANKER_VERSION,
    results: ranked,
  };
}

function scoreCandidate(
  candidate: RecallCandidate,
  queryTermVariants: readonly (readonly string[])[],
  documentTerms: readonly string[],
  corpusStatistics: RecallCorpusStatistics,
  graphDistances: ReadonlyMap<string, {readonly distance: number; readonly weight: number}>,
  context: RecallRankContext & {readonly now: Date},
): RankedRecallCandidate {
  const originalQueryTerms = queryTermVariants[0] ?? [];
  const strongestVariant = (score: (queryTerms: readonly string[]) => number): number =>
    Math.max(0, ...queryTermVariants.map(score));
  const semantic = clamp(candidate.semantic ?? 0);
  const reranker = clamp(candidate.reranker ?? 0);
  const bm25 = strongestVariant(queryTerms => normalizedBm25(queryTerms, documentTerms, corpusStatistics));
  const topicalDocumentTerms = recallTopicalDocumentTerms(candidate);
  const topicalBm25 = strongestVariant(queryTerms =>
    normalizedBm25(queryTerms, topicalDocumentTerms, corpusStatistics),
  );
  const field = strongestVariant(queryTerms => fieldScore(queryTerms, candidate.fields, {includeProject: true}));
  const topicalField = strongestVariant(queryTerms =>
    fieldScore(queryTerms, candidate.fields, {includeProject: false}),
  );
  const graph = graphScore(candidate.uri, graphDistances);
  const scope = scopeScore(context.project, candidate.fields?.project);
  const kindIntent = kindIntentScore(originalQueryTerms, candidate.kind);
  const exactTerms = qualifyingExactTerms(candidate);
  const exact = strongestVariant(queryTerms =>
    exactTermScore(queryTerms, exactTerms, candidate.fields, corpusStatistics, {
      kindIntent,
    }),
  );
  const freshness = freshnessScore(candidate.timestamp, candidate.kind, context.now);
  const authority = authorityScore(candidate.authority, candidate.trust);
  const lifecycle = lifecycleScore(candidate.status);
  const temporal = temporalScore(candidate.validFrom, candidate.validTo, context.now);
  const feedback = clampSigned(candidate.feedback ?? 0);
  const signals: RecallSignals = {
    authority,
    bm25,
    exact,
    feedback,
    field,
    freshness,
    graph,
    kindIntent,
    lifecycle,
    reranker,
    scope,
    semantic,
    temporal,
  };
  const focusedLexicalEvidence =
    topicalField >= LEXICAL_ONLY_FOCUSED_FIELD_MINIMUM || exactTerms.some(term => /[0-9_.-]/.test(term));
  const passedRelevanceGate =
    Math.max(semantic, reranker, topicalBm25, exact, topicalField) >= RELEVANCE_GATE_MINIMUM &&
    (semantic > SIGNAL_ABSENCE_MAXIMUM ||
      reranker > SIGNAL_ABSENCE_MAXIMUM ||
      graph > SIGNAL_ABSENCE_MAXIMUM ||
      focusedLexicalEvidence) &&
    !metaTopicMismatch(originalQueryTerms, candidate.fields);
  const temporalMultiplier = temporal === 0 ? TEMPORALLY_INVALID_SCORE_MULTIPLIER : 1;
  const lifecycleMultiplier = LIFECYCLE_SCORE_MULTIPLIERS[candidate.status ?? 'active'];
  const relevanceScore = passedRelevanceGate ? clamp(weightedScore(signals) * temporalMultiplier) : 0;
  const finalScore = clamp(relevanceScore * lifecycleMultiplier);
  const reasons = explainSignals(signals, candidate, context);
  const lexicalOnly =
    semantic <= SIGNAL_ABSENCE_MAXIMUM &&
    reranker <= SIGNAL_ABSENCE_MAXIMUM &&
    graph <= SIGNAL_ABSENCE_MAXIMUM &&
    Math.max(bm25, exact, field) >= RELEVANCE_GATE_MINIMUM;
  const warnings = [
    ...(candidate.status && candidate.status !== 'active' ? [`memory is ${candidate.status}`] : []),
    ...(temporal === 0 ? ['outside temporal validity window'] : []),
    ...(lexicalOnly ? ['lexical-only result; no semantic or graph corroboration'] : []),
    ...(!passedRelevanceGate ? ['failed topical relevance gate'] : []),
  ];
  return {candidate, finalScore, passedRelevanceGate, reasons, relevanceScore, signals, warnings};
}

function weightedScore(signals: RecallSignals): number {
  return (
    signals.semantic * SIGNAL_WEIGHTS.semantic +
    signals.bm25 * SIGNAL_WEIGHTS.bm25 +
    signals.exact * SIGNAL_WEIGHTS.exact +
    signals.field * SIGNAL_WEIGHTS.field +
    signals.graph * SIGNAL_WEIGHTS.graph +
    signals.kindIntent * SIGNAL_WEIGHTS.kindIntent +
    signals.reranker * SIGNAL_WEIGHTS.reranker +
    signals.scope * SIGNAL_WEIGHTS.scope +
    signals.freshness * SIGNAL_WEIGHTS.freshness +
    signals.authority * SIGNAL_WEIGHTS.authority +
    signals.lifecycle * SIGNAL_WEIGHTS.lifecycle +
    signals.temporal * SIGNAL_WEIGHTS.temporal +
    signals.feedback * SIGNAL_WEIGHTS.feedback
  );
}

function exactTermScore(
  queryTerms: readonly string[],
  exactTerms: readonly string[] | undefined,
  fields: RecallFields | undefined,
  corpusStatistics: RecallCorpusStatistics,
  context: {readonly kindIntent: number},
): number {
  if (queryTerms.length === 0 || !exactTerms || exactTerms.length === 0) {
    return 0;
  }
  const uniqueQuery = new Set(queryTerms);
  const uniqueExactTerms = [...new Set(exactTerms.map(term => term.toLowerCase()))];
  const matchedTerms = uniqueExactTerms.filter(term => tokenize(term).some(token => uniqueQuery.has(token)));
  const matches = matchedTerms.length;
  if (matches === 0) {
    return 0;
  }
  const queryCoverage = matches / uniqueQuery.size;
  const exactPrecision = matches / uniqueExactTerms.length;
  if (matches >= EXACT_MULTI_TERM_MINIMUM && exactPrecision === 1) {
    const matchedQueryTerms = new Set(matchedTerms.flatMap(tokenize).filter(term => uniqueQuery.has(term)));
    const totalQueryWeight = [...uniqueQuery].reduce(
      (total, term) => total + inverseDocumentFrequency(term, corpusStatistics),
      0,
    );
    const matchedQueryWeight = [...matchedQueryTerms].reduce(
      (total, term) => total + inverseDocumentFrequency(term, corpusStatistics),
      0,
    );
    const idfWeightedCoverage = totalQueryWeight === 0 ? queryCoverage : matchedQueryWeight / totalQueryWeight;
    return clamp(
      Math.max(
        EXACT_TERM_RESCUE_MINIMUM,
        EXACT_MULTI_TERM_BASE_SCORE + idfWeightedCoverage * EXACT_MULTI_TERM_IDF_COVERAGE_WEIGHT,
      ),
    );
  }
  if (matches === 1 && exactPrecision === 1 && /[0-9_.-]/.test(matchedTerms[0] ?? '')) {
    return EXACT_IDENTIFIER_SCORE;
  }
  if (
    matches === 1 &&
    exactPrecision === 1 &&
    context.kindIntent === 1 &&
    focusedFieldContainsTerm(fields, matchedTerms[0] ?? '')
  ) {
    return EXACT_CONTEXTUAL_TERM_SCORE;
  }
  return queryCoverage * exactPrecision;
}

function focusedFieldContainsTerm(fields: RecallFields | undefined, term: string): boolean {
  if (!fields || term.length === 0) {
    return false;
  }
  const focusedTerms = new Set(
    [fields.title, fields.topic, ...(fields.keywords ?? []), ...(fields.identifiers ?? [])]
      .filter((value): value is string => typeof value === 'string')
      .flatMap(tokenize),
  );
  return tokenize(term).some(token => focusedTerms.has(token));
}

function metaTopicMismatch(queryTerms: readonly string[], fields: RecallFields | undefined): boolean {
  if (!fields || queryTerms.some(term => META_QUERY_INTENT_TERMS.has(term))) {
    return false;
  }
  const topicTerms = tokenize([fields.title ?? '', fields.topic ?? '']);
  return topicTerms.some(term => META_TOPIC_TERMS.has(term));
}

function normalizedBm25(
  queryTerms: readonly string[],
  documentTerms: readonly string[],
  corpusStatistics: RecallCorpusStatistics,
): number {
  if (queryTerms.length === 0 || documentTerms.length === 0) {
    return 0;
  }
  const termFrequency = new Map<string, number>();
  for (const term of documentTerms) {
    termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
  }
  let score = 0;
  let maximum = 0;
  for (const term of new Set(queryTerms)) {
    const frequency = termFrequency.get(term) ?? 0;
    const idf = inverseDocumentFrequency(term, corpusStatistics);
    maximum += idf * (BM25_SATURATION + 1);
    if (frequency === 0) {
      continue;
    }
    const denominator =
      frequency +
      BM25_SATURATION *
        (1 -
          BM25_LENGTH_NORMALIZATION +
          BM25_LENGTH_NORMALIZATION * (documentTerms.length / Math.max(1, corpusStatistics.averageDocumentLength)));
    score += idf * ((frequency * (BM25_SATURATION + 1)) / denominator);
  }
  return maximum === 0 ? 0 : clamp(score / maximum);
}

function inverseDocumentFrequency(term: string, corpusStatistics: RecallCorpusStatistics): number {
  const documentCount = Math.max(1, corpusStatistics.documentCount);
  const documentsWithTerm = corpusStatistics.documentFrequency[term] ?? 0;
  return Math.log(
    1 + (documentCount - documentsWithTerm + BM25_IDF_SMOOTHING) / (documentsWithTerm + BM25_IDF_SMOOTHING),
  );
}

function fieldScore(
  queryTerms: readonly string[],
  fields: RecallFields | undefined,
  options: {readonly includeProject: boolean},
): number {
  if (queryTerms.length === 0 || !fields) {
    return 0;
  }
  const uniqueQuery = new Set(queryTerms);
  const coverage = (
    value: string | readonly string[] | undefined,
    options: {readonly rewardExactSubset: boolean},
  ): number => {
    const terms = new Set(Array.isArray(value) ? value.flatMap(tokenize) : tokenize(value ?? ''));
    if (terms.size === 0) {
      return 0;
    }
    const matches = [...uniqueQuery].filter(term => terms.has(term)).length;
    const queryCoverage = matches / uniqueQuery.size;
    const valuePrecision = matches / terms.size;
    const exactSubsetBonus =
      options.rewardExactSubset && matches === terms.size && matches > 0 ? FIELD_EXACT_SUBSET_BONUS : 0;
    return clamp(
      queryCoverage * FIELD_QUERY_COVERAGE_WEIGHT + valuePrecision * FIELD_VALUE_PRECISION_WEIGHT + exactSubsetBonus,
    );
  };
  const keywordCoverage = Math.max(
    0,
    ...(fields.keywords ?? []).map(keyword => coverage(keyword, {rewardExactSubset: true})),
  );
  return clamp(
    coverage(fields.title, {rewardExactSubset: true}) * FIELD_WEIGHTS.title +
      coverage(fields.topic, {rewardExactSubset: true}) * FIELD_WEIGHTS.topic +
      (options.includeProject ? coverage(fields.project, {rewardExactSubset: false}) * FIELD_WEIGHTS.project : 0) +
      keywordCoverage * FIELD_WEIGHTS.keywords +
      coverage(fields.identifiers, {rewardExactSubset: true}) * FIELD_WEIGHTS.identifiers,
  );
}

function kindIntentScore(queryTerms: readonly string[], kind: MemoryKind | undefined): number {
  const requestedKinds = (Object.entries(MEMORY_KIND_INTENT_TERMS) as Array<[MemoryKind, ReadonlySet<string>]>)
    .filter(([_candidateKind, terms]) => queryTerms.some(term => terms.has(term)))
    .map(([candidateKind]) => candidateKind);
  if (requestedKinds.length === 0) {
    return 0;
  }
  return kind !== undefined && requestedKinds.includes(kind) ? 1 : 0;
}

function typedGraphDistances(
  candidates: readonly RecallCandidate[],
  seeds: readonly string[],
): ReadonlyMap<string, {readonly distance: number; readonly weight: number}> {
  if (seeds.length === 0) {
    return new Map();
  }
  const adjacency = new Map<string, Array<{readonly target: string; readonly weight: number}>>();
  const addEdge = (source: string, target: string, weight: number): void => {
    const edges = adjacency.get(source);
    if (edges) {
      edges.push({target, weight});
    } else {
      adjacency.set(source, [{target, weight}]);
    }
  };
  for (const candidate of candidates) {
    for (const relation of candidate.relations ?? []) {
      const weight = RELATION_WEIGHTS[relation.type];
      addEdge(candidate.uri, relation.uri, weight);
      addEdge(relation.uri, candidate.uri, weight);
    }
  }
  const sameIdentity = new Map<string, RecallCandidate[]>();
  for (const candidate of candidates) {
    const project = candidate.fields?.project?.trim().toLowerCase();
    const topic = candidate.fields?.topic?.trim().toLowerCase();
    if (!project || !topic) {
      continue;
    }
    const key = `${project}\n${topic}`;
    const group = sameIdentity.get(key);
    if (group) {
      group.push(candidate);
    } else {
      sameIdentity.set(key, [candidate]);
    }
  }
  for (const [identity, related] of sameIdentity) {
    const identityNode = `${IDENTITY_GRAPH_NODE_PREFIX}${identity}`;
    for (const candidate of related) {
      addEdge(candidate.uri, identityNode, SAME_IDENTITY_EDGE_WEIGHT);
      addEdge(identityNode, candidate.uri, SAME_IDENTITY_EDGE_WEIGHT);
    }
  }
  const distances = new Map<string, {distance: number; weight: number}>();
  const queue = seeds.map(uri => ({distance: 0, uri, weight: 1}));
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (!current || current.distance > MAX_GRAPH_DISTANCE) {
      continue;
    }
    const previous = distances.get(current.uri);
    if (previous && (previous.distance < current.distance || previous.weight >= current.weight)) {
      continue;
    }
    distances.set(current.uri, {distance: current.distance, weight: current.weight});
    for (const edge of adjacency.get(current.uri) ?? []) {
      queue.push({
        distance: current.distance + 1,
        uri: edge.target,
        weight: current.weight * edge.weight,
      });
    }
  }
  return distances;
}

function graphScore(
  uri: string,
  distances: ReadonlyMap<string, {readonly distance: number; readonly weight: number}>,
): number {
  const graph = distances.get(uri);
  return graph && graph.distance > 0 ? clamp(graph.weight / (1 + graph.distance * GRAPH_DISTANCE_PENALTY)) : 0;
}

function freshnessScore(timestamp: string | undefined, kind: MemoryKind | undefined, now: Date): number {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return UNKNOWN_FRESHNESS_SCORE;
  }
  const ageDays = Math.max(0, (now.getTime() - parsed) / MILLISECONDS_PER_DAY);
  const halfLifeDays = FRESHNESS_HALF_LIFE_DAYS[kind ?? 'durable'];
  return clamp(HALF_LIFE_DECAY_BASE ** (-ageDays / halfLifeDays));
}

function temporalScore(validFrom: string | undefined, validTo: string | undefined, now: Date): number {
  const nowMs = now.getTime();
  const fromMs = validFrom ? Date.parse(validFrom) : Number.NaN;
  const toMs = validTo ? Date.parse(validTo) : Number.NaN;
  if (Number.isFinite(fromMs) && nowMs < fromMs) {
    return 0;
  }
  if (Number.isFinite(toMs) && nowMs > toMs) {
    return 0;
  }
  return 1;
}

function authorityScore(authority: MemoryAuthority | undefined, trust: MemoryTrust | undefined): number {
  const authorityValue = authority ? AUTHORITY_SCORES[authority] : UNKNOWN_AUTHORITY_SCORE;
  const trustValue = trust ? TRUST_SCORES[trust] : UNKNOWN_TRUST_SCORE;
  return authorityValue * AUTHORITY_BLEND_WEIGHT + trustValue * TRUST_BLEND_WEIGHT;
}

function lifecycleScore(status: MemoryStatus | undefined): number {
  return status ? LIFECYCLE_SCORES[status] : LIFECYCLE_SCORES.active;
}

function scopeScore(currentProject: string | undefined, project: string | undefined): number {
  if (!currentProject || !project) {
    return UNKNOWN_SCOPE_SCORE;
  }
  return currentProject.toLowerCase() === project.toLowerCase() ? 1 : 0;
}

function explainSignals(
  signals: RecallSignals,
  candidate: RecallCandidate,
  context: RecallRankContext,
): readonly RecallReason[] {
  const reasons: RecallReason[] = [
    reason(
      'native_reranker',
      signals.reranker * SIGNAL_WEIGHTS.reranker,
      `native reranker score ${signals.reranker.toFixed(2)}`,
    ),
    reason(
      'semantic_similarity',
      signals.semantic * SIGNAL_WEIGHTS.semantic,
      `semantic similarity ${signals.semantic.toFixed(2)}`,
    ),
    reason('bm25_lexical', signals.bm25 * SIGNAL_WEIGHTS.bm25, `BM25/IDF lexical score ${signals.bm25.toFixed(2)}`),
    reason(
      'exact_term_match',
      signals.exact * SIGNAL_WEIGHTS.exact,
      `exact-term corroboration ${signals.exact.toFixed(2)}`,
    ),
    reason(
      'field_match',
      signals.field * SIGNAL_WEIGHTS.field,
      `title/topic/project/identifier score ${signals.field.toFixed(2)}`,
    ),
    reason(
      'graph_proximity',
      signals.graph * SIGNAL_WEIGHTS.graph,
      `typed graph proximity ${signals.graph.toFixed(2)}`,
    ),
    reason(
      'memory_kind_intent',
      signals.kindIntent * SIGNAL_WEIGHTS.kindIntent,
      `memory-kind intent ${signals.kindIntent.toFixed(2)}`,
    ),
    reason('freshness', signals.freshness * SIGNAL_WEIGHTS.freshness, `recency score ${signals.freshness.toFixed(2)}`),
    reason(
      'authority_trust',
      signals.authority * SIGNAL_WEIGHTS.authority,
      `authority/trust score ${signals.authority.toFixed(2)}`,
    ),
    reason(
      'lifecycle',
      signals.lifecycle * SIGNAL_WEIGHTS.lifecycle,
      `lifecycle score ${signals.lifecycle.toFixed(2)}`,
    ),
    reason(
      'temporal_validity',
      signals.temporal * SIGNAL_WEIGHTS.temporal,
      `temporal validity ${signals.temporal.toFixed(2)}`,
    ),
    reason(
      'user_feedback',
      signals.feedback * SIGNAL_WEIGHTS.feedback,
      `bounded user feedback ${signals.feedback.toFixed(2)}`,
    ),
  ];
  if (context.project && candidate.fields?.project) {
    reasons.push(
      reason('project_scope', signals.scope * SIGNAL_WEIGHTS.scope, `project scope ${signals.scope.toFixed(2)}`),
    );
  }
  return reasons
    .filter(item => Math.abs(item.contribution) >= EXPLANATION_CONTRIBUTION_MINIMUM)
    .sort((left, right) => right.contribution - left.contribution);
}

function reason(code: string, contribution: number, detail: string): RecallReason {
  return {code, contribution, detail};
}

function assessConfidence(results: readonly RankedRecallCandidate[]): RecallConfidence {
  const first = results[0]?.relevanceScore ?? 0;
  const second = results[1]?.relevanceScore ?? 0;
  const margin = Math.max(0, first - second);
  const topSignals = results[0]?.signals;
  const corroboratingSignals = results[0]
    ? [
        results[0].signals.semantic,
        results[0].signals.bm25,
        results[0].signals.exact,
        results[0].signals.field,
        results[0].signals.graph,
      ].filter(signal => signal >= CORROBORATING_SIGNAL_MINIMUM).length
    : 0;
  const weakLexicalOnly =
    topSignals !== undefined &&
    topSignals.semantic <= SIGNAL_ABSENCE_MAXIMUM &&
    topSignals.graph <= SIGNAL_ABSENCE_MAXIMUM &&
    Math.max(topSignals.bm25, topSignals.exact, topSignals.field) < LEXICAL_ONLY_ANSWER_MINIMUM;
  if (results.length === 0 || first < NO_ANSWER_SCORE_MINIMUM || weakLexicalOnly) {
    return {
      level: 'no_answer',
      margin,
      reason: 'No candidate passed the minimum combined relevance threshold.',
      score: first,
    };
  }
  if (
    first >= HIGH_CONFIDENCE_SCORE_MINIMUM &&
    (margin >= HIGH_CONFIDENCE_MARGIN_MINIMUM || corroboratingSignals >= HIGH_CONFIDENCE_SIGNAL_COUNT)
  ) {
    return {level: 'high', margin, reason: 'Strong top score with corroborating retrieval signals.', score: first};
  }
  if (first >= MEDIUM_CONFIDENCE_SCORE_MINIMUM && corroboratingSignals >= MEDIUM_CONFIDENCE_SIGNAL_COUNT) {
    return {level: 'medium', margin, reason: 'Useful match, but ranking evidence is not decisive.', score: first};
  }
  return {level: 'low', margin, reason: 'Only weak or single-signal evidence supports the top result.', score: first};
}

export function recallDocumentTerms(candidate: RecallCandidate): readonly string[] {
  return tokenize(
    [
      candidate.text,
      candidate.fields?.title,
      candidate.fields?.topic,
      candidate.fields?.project,
      ...(candidate.fields?.keywords ?? []),
      ...(candidate.fields?.identifiers ?? []),
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' '),
  );
}

function recallTopicalDocumentTerms(candidate: RecallCandidate): readonly string[] {
  return tokenize(
    [
      candidate.text,
      candidate.fields?.title,
      candidate.fields?.topic,
      ...(candidate.fields?.keywords ?? []),
      ...(candidate.fields?.identifiers ?? []),
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' '),
  );
}

function qualifyingExactTerms(candidate: RecallCandidate): readonly string[] {
  const topicalTerms = new Set(recallTopicalDocumentTerms(candidate));
  const projectTerms = new Set(tokenize(candidate.fields?.project ?? ''));
  const kindIntentTerms = candidate.kind ? MEMORY_KIND_INTENT_TERMS[candidate.kind] : undefined;
  return (candidate.exactTerms ?? []).filter(term => {
    const normalized = term.toLowerCase();
    return topicalTerms.has(normalized) && !projectTerms.has(normalized) && kindIntentTerms?.has(normalized) !== true;
  });
}

export function buildRecallCorpusStatistics(candidates: readonly RecallCandidate[]): RecallCorpusStatistics {
  const corpus = candidates.map(candidate => recallDocumentTerms(candidate));
  const frequencies: Record<string, number> = {};
  for (const terms of corpus) {
    for (const term of new Set(terms)) {
      frequencies[term] = (frequencies[term] ?? 0) + 1;
    }
  }
  const totalDocumentLength = corpus.reduce((sum, terms) => sum + terms.length, 0);
  return {
    averageDocumentLength: corpus.length === 0 ? 1 : totalDocumentLength / corpus.length,
    documentCount: corpus.length,
    documentFrequency: frequencies,
    totalDocumentLength,
  };
}

function tokenize(value: string | readonly string[]): readonly string[] {
  const text = typeof value === 'string' ? value : value.join(' ');
  return [...text.matchAll(/[a-z0-9][a-z0-9_.-]{1,}/gi)].flatMap(match => {
    const raw = match[0];
    const normalized = raw.toLowerCase();
    const components = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[._/-]+/)
      .map(term => term.toLowerCase())
      .filter(term => term.length >= 2 && term !== normalized);
    return [normalized, ...components];
  });
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
