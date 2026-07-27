import {Clock, Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {SEED_STATE_FILE} from '../constants.js';
import {sha256Hex} from '../effect/digest.js';
import {scanFilesWithinBoundary} from '../effect/safe_scan.js';
import {SystemInfo} from '../effect/system.js';
import {parseSeedManifest, uriSegment} from '../manifest.js';
import {
  boundedMemoryAuthority,
  boundedMemoryTrust,
  parseMemoryDocument,
  type MemoryRelation,
} from '../memory_document.js';
import {redactSensitiveText} from '../scrubber.js';
import type {ProjectManifest} from '../types.js';
import {expandPath, globToRegExp} from '../utils.js';
import {
  buildRecallCorpusStatistics,
  recallDocumentTerms,
  type RecallCandidate,
  type RecallCorpusStatistics,
} from './rank.js';

interface RecallIndexSource {
  readonly modifiedAt?: string;
  readonly path: string;
  readonly size: number;
  readonly uri: string;
}

interface RecallIndexCache {
  readonly authorityPolicyByUri: Readonly<Record<string, string>>;
  readonly candidates: readonly RecallCandidate[];
  readonly corpusStatistics: RecallCorpusStatistics;
  readonly includeInactive: boolean;
  readonly postings: Readonly<Record<string, readonly RecallIndexPosting[]>>;
  readonly sources: readonly RecallIndexSource[];
  readonly uriLookup: Readonly<Record<string, number>>;
  readonly validatedAt: number;
  readonly version: typeof RECALL_INDEX_CACHE_VERSION;
}

interface RecallIndexPosting {
  readonly documentLength: number;
  readonly fieldWeight: number;
  readonly termFrequency: number;
  readonly uri: string;
}

interface CanonicalResourcePolicy {
  readonly entryKeyByUri: ReadonlyMap<string, string>;
  readonly sourcePathByUri: ReadonlyMap<string, string>;
}

interface SeedStateEntry {
  readonly mtimeMs: number;
  readonly size: number;
}

interface RecallIndexConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

export interface RecallIndexData {
  readonly candidates: readonly RecallCandidate[];
  readonly corpusStatistics: RecallCorpusStatistics;
}

const RECALL_INDEX_CACHE_VERSION = 6;
const ACTIVE_CACHE_FILENAME = `recall-index-v${RECALL_INDEX_CACHE_VERSION}.json`;
const INACTIVE_CACHE_FILENAME = `recall-index-v${RECALL_INDEX_CACHE_VERSION}-with-inactive.json`;
const CACHE_VALIDATION_INTERVAL_MILLISECONDS = 30_000;
const MAX_INDEXED_FILE_BYTES = 512 * 1_024;
const DEFAULT_QUERY_RESULT_LIMIT = 100;
const QUERY_POSTING_POOL_MULTIPLIER = 5;
const MINIMUM_QUERY_POSTING_POOL = 500;
const MAX_QUERY_TERMS = 32;
const POSTING_IDENTIFIER_WEIGHT = 4;
const POSTING_TITLE_WEIGHT = 3;
const POSTING_TOPIC_WEIGHT = 2;
const POSTING_KEYWORD_WEIGHT = 2;
const POSTING_PROJECT_WEIGHT = 1;
const POSTING_BODY_WEIGHT = 1;
const POSTING_BM25_SATURATION = 1.2;
const POSTING_BM25_LENGTH_NORMALIZATION = 0.75;
const POSTING_BM25_IDF_SMOOTHING = 0.5;
const SEED_FILE_MTIME_TOLERANCE_MILLISECONDS = 1;
const TEXT_EXTENSIONS = new Set(['.json', '.md', '.mdx', '.txt', '.yaml', '.yml']);
const IDENTIFIER_PATTERN = /[a-z0-9][a-z0-9_.-]{2,}/gi;
const decodedCacheByPath = new Map<string, RecallIndexCache>();
const decodedCacheGenerationByPath = new Map<string, string | null>();
const dirtyCachePaths = new Set<string>();
let staleGenerationCounter = 0;

interface LoadRecallIndexOptions {
  readonly allowedUriScopes?: readonly string[];
  readonly forceRefresh?: boolean;
  readonly includeInactive: boolean;
  readonly limit?: number;
  readonly query?: string;
  readonly requiredUris?: readonly string[];
}

interface LoadRecallIndexBatchOptions {
  readonly forceRefresh?: boolean;
  readonly includeInactive: boolean;
  readonly selections: readonly Omit<LoadRecallIndexOptions, 'forceRefresh' | 'includeInactive'>[];
}

const loadRecallIndexCache = Effect.fn('recall.loadIndexCache')(function* (
  config: RecallIndexConfig,
  options: Pick<LoadRecallIndexOptions, 'forceRefresh' | 'includeInactive'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const cachePath = pathService.join(
    config.agentContextHome,
    'cache',
    options.includeInactive ? INACTIVE_CACHE_FILENAME : ACTIVE_CACHE_FILENAME,
  );
  const cached = yield* readCache(fs, cachePath, options.forceRefresh === true);
  const now = yield* Clock.currentTimeMillis;
  if (
    options.forceRefresh !== true &&
    cached?.includeInactive === options.includeInactive &&
    now - cached.validatedAt < CACHE_VALIDATION_INTERVAL_MILLISECONDS
  ) {
    return cached;
  }
  const canonicalResourcePolicy = yield* loadCanonicalResourcePolicy(config);
  const roots = recallIndexRoots(config, pathService);
  const sources: RecallIndexSource[] = [];
  for (const root of roots) {
    if (!(yield* fs.exists(root.path))) {
      continue;
    }
    const files = yield* scanFilesWithinBoundary(fs, root.path, root.path, {
      includeDirectory: path => !excludedDirectory(path, options.includeInactive),
      includeFile: path => !excludedFile(path),
    });
    sources.push(
      ...files
        .filter(file => file.size <= MAX_INDEXED_FILE_BYTES)
        .map(file => ({
          modifiedAt: file.modifiedAt?.toISOString(),
          path: file.path,
          size: file.size,
          uri: `${root.uri}/${pathService.relative(root.path, file.path).split(pathService.sep).join('/')}`,
        })),
    );
  }
  sources.sort((left, right) => left.uri.localeCompare(right.uri));
  if (
    options.forceRefresh !== true &&
    cached?.includeInactive === options.includeInactive &&
    sameStringRecord(cached.authorityPolicyByUri, canonicalResourcePolicy.entryKeyByUri) &&
    sameSources(cached.sources, sources)
  ) {
    const validatedCache = {...cached, validatedAt: Math.max(now, cached.validatedAt + 1)};
    yield* writeCacheAtomically(fs, cachePath, validatedCache);
    return validatedCache;
  }

  const cachedSourceByUri = new Map(cached?.sources.map(source => [source.uri, source]));
  const changedUris = new Set<string>();
  const candidates: RecallCandidate[] = [];
  for (const source of sources) {
    const cachedSource = cachedSourceByUri.get(source.uri);
    const cachedCandidateIndex = cached?.uriLookup[source.uri];
    const cachedCandidate = cachedCandidateIndex === undefined ? undefined : cached?.candidates[cachedCandidateIndex];
    const authorityPolicyChanged =
      cached?.authorityPolicyByUri[source.uri] !== canonicalResourcePolicy.entryKeyByUri.get(source.uri);
    if (
      options.forceRefresh !== true &&
      !authorityPolicyChanged &&
      cachedSource &&
      cachedCandidate &&
      sameSource(cachedSource, source)
    ) {
      candidates.push(cachedCandidate);
    } else {
      const content = yield* fs.readFileString(source.path);
      const canonicalResource = yield* verifyCanonicalResource(fs, source.uri, content, canonicalResourcePolicy);
      candidates.push(indexCandidate(source.uri, content, canonicalResource));
      changedUris.add(source.uri);
    }
  }
  const currentUris = new Set(sources.map(source => source.uri));
  const removedUris = new Set((cached?.sources ?? []).map(source => source.uri).filter(uri => !currentUris.has(uri)));
  const corpusStatistics = cached
    ? updateRecallCorpusStatistics(cached, candidates, changedUris, removedUris)
    : buildRecallCorpusStatistics(candidates);
  const {postings, uriLookup} = cached
    ? updateRecallIndexLookups(cached, candidates, changedUris, removedUris)
    : buildRecallIndexLookups(candidates);
  const cache: RecallIndexCache = {
    authorityPolicyByUri: Object.fromEntries(canonicalResourcePolicy.entryKeyByUri),
    candidates,
    corpusStatistics,
    includeInactive: options.includeInactive,
    postings,
    sources,
    uriLookup,
    validatedAt: Math.max(now, (cached?.validatedAt ?? -1) + 1),
    version: RECALL_INDEX_CACHE_VERSION,
  };
  yield* writeCacheAtomically(fs, cachePath, cache);
  return cache;
});

export const loadRecallIndexData = Effect.fn('recall.loadIndexData')(function* (
  config: RecallIndexConfig,
  options: LoadRecallIndexOptions,
) {
  const cache = yield* loadRecallIndexCache(config, options);
  return selectRecallIndexData(cache, options);
});

export const loadRecallIndexDataBatch = Effect.fn('recall.loadIndexDataBatch')(function* (
  config: RecallIndexConfig,
  options: LoadRecallIndexBatchOptions,
) {
  const cache = yield* loadRecallIndexCache(config, options);
  return options.selections.map(selection =>
    selectRecallIndexData(cache, {
      ...selection,
      includeInactive: options.includeInactive,
    }),
  );
});

export const loadRecallIndex = Effect.fn('recall.loadIndex')(function* (
  config: RecallIndexConfig,
  options: LoadRecallIndexOptions,
) {
  return (yield* loadRecallIndexData(config, options)).candidates;
});

export const clearRecallIndexMemoryCache = Effect.fn('recall.clearMemoryCache')(function* () {
  yield* Effect.sync(() => {
    decodedCacheByPath.clear();
    decodedCacheGenerationByPath.clear();
  });
});

export const expireRecallIndexValidation = Effect.fn('recall.expireValidation')(function* (
  agentContextHome: string,
  includeInactive: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const cachePath = pathService.join(
    agentContextHome,
    'cache',
    includeInactive ? INACTIVE_CACHE_FILENAME : ACTIVE_CACHE_FILENAME,
  );
  const cached = yield* Effect.sync(() => decodedCacheByPath.get(cachePath));
  yield* fs.makeDirectory(pathService.dirname(cachePath), {recursive: true});
  const generation = yield* writeStaleGeneration(fs, cachePath);
  yield* Effect.sync(() => {
    if (cached) {
      decodedCacheByPath.set(cachePath, {...cached, validatedAt: 0});
      decodedCacheGenerationByPath.set(cachePath, generation);
      dirtyCachePaths.delete(cachePath);
    } else {
      dirtyCachePaths.add(cachePath);
      decodedCacheByPath.delete(cachePath);
      decodedCacheGenerationByPath.delete(cachePath);
    }
  });
});

function selectRecallIndexData(cache: RecallIndexCache, options: LoadRecallIndexOptions): RecallIndexData {
  if (options.query === undefined) {
    return {candidates: cache.candidates, corpusStatistics: cache.corpusStatistics};
  }
  const selected: RecallCandidate[] = [];
  const selectedIndexes = new Set<number>();
  for (const uri of options.requiredUris ?? []) {
    const candidateIndex = cache.uriLookup[stripRecallAnchor(uri)];
    const candidate = candidateIndex === undefined ? undefined : cache.candidates[candidateIndex];
    if (
      candidate &&
      uriMatchesScopes(candidate.uri, options.allowedUriScopes) &&
      !selectedIndexes.has(candidateIndex)
    ) {
      selectedIndexes.add(candidateIndex);
      selected.push(candidate);
    }
  }
  const resultLimit = options.limit ?? DEFAULT_QUERY_RESULT_LIMIT;
  const postingPoolLimit = Math.max(MINIMUM_QUERY_POSTING_POOL, resultLimit * QUERY_POSTING_POOL_MULTIPLIER);
  const scores = new Map<number, number>();
  const queryTerms = selectQueryTerms(indexTerms(options.query), cache, options.allowedUriScopes);
  for (const term of queryTerms) {
    const termPostings = cache.postings[term];
    type TermCandidate = {
      readonly candidateIndex: number;
      readonly posting: RecallIndexPosting;
      readonly score: number;
    };
    const compareTermCandidates = (left: TermCandidate, right: TermCandidate): number =>
      right.score - left.score ||
      right.posting.fieldWeight - left.posting.fieldWeight ||
      left.posting.uri.localeCompare(right.posting.uri);
    const termCandidates: TermCandidate[] = [];
    for (const posting of termPostings ?? []) {
      const candidateIndex = cache.uriLookup[posting.uri];
      const candidate = candidateIndex === undefined ? undefined : cache.candidates[candidateIndex];
      if (!candidate || !uriMatchesScopes(candidate.uri, options.allowedUriScopes)) {
        continue;
      }
      offerBoundedBest(
        termCandidates,
        {
          candidateIndex,
          posting,
          score: postingLexicalScore(posting, term, cache.corpusStatistics),
        },
        postingPoolLimit,
        compareTermCandidates,
      );
    }
    termCandidates.sort(compareTermCandidates);
    for (const {candidateIndex, score} of termCandidates) {
      const candidate = cache.candidates[candidateIndex];
      if (!candidate) {
        continue;
      }
      scores.set(candidateIndex, (scores.get(candidateIndex) ?? 0) + score);
    }
  }
  const rankedIndexes = [...scores]
    .sort(
      ([leftIndex, leftScore], [rightIndex, rightScore]) =>
        rightScore - leftScore ||
        (cache.candidates[leftIndex]?.uri ?? '').localeCompare(cache.candidates[rightIndex]?.uri ?? ''),
    )
    .slice(0, resultLimit)
    .map(([candidateIndex]) => candidateIndex);
  for (const candidateIndex of rankedIndexes) {
    const candidate = cache.candidates[candidateIndex];
    if (candidate && !selectedIndexes.has(candidateIndex)) {
      selectedIndexes.add(candidateIndex);
      selected.push(candidate);
    }
  }
  return {candidates: selected, corpusStatistics: cache.corpusStatistics};
}

function buildRecallIndexLookups(candidates: readonly RecallCandidate[]): {
  readonly postings: Readonly<Record<string, readonly RecallIndexPosting[]>>;
  readonly uriLookup: Readonly<Record<string, number>>;
} {
  const postingsByTerm = new Map<string, RecallIndexPosting[]>();
  const uriLookup: Record<string, number> = {};
  candidates.forEach((candidate, candidateIndex) => {
    uriLookup[stripRecallAnchor(candidate.uri)] = candidateIndex;
    for (const [term, posting] of candidatePostings(candidate)) {
      const entries = postingsByTerm.get(term);
      if (entries) {
        entries.push(posting);
      } else {
        postingsByTerm.set(term, [posting]);
      }
    }
  });
  for (const [term, entries] of postingsByTerm) {
    postingsByTerm.set(term, [...sortPostings(entries)]);
  }
  const postings = Object.fromEntries(postingsByTerm);
  return {postings, uriLookup};
}

function updateRecallIndexLookups(
  cached: RecallIndexCache,
  candidates: readonly RecallCandidate[],
  changedUris: ReadonlySet<string>,
  removedUris: ReadonlySet<string>,
): {
  readonly postings: Readonly<Record<string, readonly RecallIndexPosting[]>>;
  readonly uriLookup: Readonly<Record<string, number>>;
} {
  const affectedUris = new Set([...changedUris, ...removedUris]);
  const changedCandidates = candidates.filter(candidate => changedUris.has(stripRecallAnchor(candidate.uri)));
  const affectedTerms = new Set<string>();
  for (const uri of affectedUris) {
    const candidateIndex = cached.uriLookup[uri];
    const candidate = candidateIndex === undefined ? undefined : cached.candidates[candidateIndex];
    for (const term of candidate ? candidatePostings(candidate).keys() : []) {
      affectedTerms.add(term);
    }
  }
  const changedPostings = new Map<string, RecallIndexPosting[]>();
  for (const candidate of changedCandidates) {
    for (const [term, posting] of candidatePostings(candidate)) {
      affectedTerms.add(term);
      const entries = changedPostings.get(term);
      if (entries) {
        entries.push(posting);
      } else {
        changedPostings.set(term, [posting]);
      }
    }
  }
  const postings = {...cached.postings} as Record<string, readonly RecallIndexPosting[]>;
  for (const term of affectedTerms) {
    postings[term] = sortPostings([
      ...(cached.postings[term] ?? []).filter(posting => !affectedUris.has(posting.uri)),
      ...(changedPostings.get(term) ?? []),
    ]);
  }
  const uriLookup: Record<string, number> = {};
  candidates.forEach((candidate, candidateIndex) => {
    uriLookup[stripRecallAnchor(candidate.uri)] = candidateIndex;
  });
  return {postings, uriLookup};
}

function updateRecallCorpusStatistics(
  cached: RecallIndexCache,
  candidates: readonly RecallCandidate[],
  changedUris: ReadonlySet<string>,
  removedUris: ReadonlySet<string>,
): RecallCorpusStatistics {
  const affectedUris = new Set([...changedUris, ...removedUris]);
  const oldCandidates = [...affectedUris]
    .map(uri => {
      const index = cached.uriLookup[uri];
      return index === undefined ? undefined : cached.candidates[index];
    })
    .filter((candidate): candidate is RecallCandidate => candidate !== undefined);
  const newCandidates = candidates.filter(candidate => changedUris.has(stripRecallAnchor(candidate.uri)));
  const documentFrequency = {...cached.corpusStatistics.documentFrequency};
  const adjust = (candidate: RecallCandidate, delta: number): void => {
    for (const term of new Set(recallDocumentTerms(candidate))) {
      documentFrequency[term] = (documentFrequency[term] ?? 0) + delta;
    }
  };
  oldCandidates.forEach(candidate => adjust(candidate, -1));
  newCandidates.forEach(candidate => adjust(candidate, 1));
  const documentCount = cached.corpusStatistics.documentCount - oldCandidates.length + newCandidates.length;
  const totalDocumentLength =
    cached.corpusStatistics.totalDocumentLength -
    oldCandidates.reduce((sum, candidate) => sum + recallDocumentTerms(candidate).length, 0) +
    newCandidates.reduce((sum, candidate) => sum + recallDocumentTerms(candidate).length, 0);
  return {
    averageDocumentLength: documentCount === 0 ? 1 : totalDocumentLength / documentCount,
    documentCount,
    documentFrequency,
    totalDocumentLength,
  };
}

function candidatePostings(candidate: RecallCandidate): ReadonlyMap<string, RecallIndexPosting> {
  const weights = new Map<string, number>();
  const add = (value: string | readonly string[] | undefined, weight: number): void => {
    if (value === undefined) {
      return;
    }
    for (const term of new Set(indexTerms(typeof value === 'string' ? value : value.join(' ')))) {
      weights.set(term, Math.max(weight, weights.get(term) ?? 0));
    }
  };
  add(candidate.text, POSTING_BODY_WEIGHT);
  add(candidate.fields?.project, POSTING_PROJECT_WEIGHT);
  add(candidate.fields?.topic, POSTING_TOPIC_WEIGHT);
  add(candidate.fields?.keywords, POSTING_KEYWORD_WEIGHT);
  add(candidate.fields?.title, POSTING_TITLE_WEIGHT);
  add(candidate.fields?.identifiers, POSTING_IDENTIFIER_WEIGHT);
  const documentTerms = recallDocumentTerms(candidate);
  const termFrequencies = new Map<string, number>();
  for (const term of documentTerms) {
    termFrequencies.set(term, (termFrequencies.get(term) ?? 0) + 1);
  }
  return new Map(
    [...weights].map(([term, fieldWeight]) => [
      term,
      {
        documentLength: documentTerms.length,
        fieldWeight,
        termFrequency: termFrequencies.get(term) ?? 1,
        uri: stripRecallAnchor(candidate.uri),
      },
    ]),
  );
}

function sortPostings(postings: readonly RecallIndexPosting[]): readonly RecallIndexPosting[] {
  return [...postings].sort(
    (left, right) =>
      right.fieldWeight - left.fieldWeight ||
      right.termFrequency - left.termFrequency ||
      left.documentLength - right.documentLength ||
      left.uri.localeCompare(right.uri),
  );
}

function postingLexicalScore(
  posting: RecallIndexPosting,
  term: string,
  corpusStatistics: RecallCorpusStatistics,
): number {
  const documentCount = Math.max(1, corpusStatistics.documentCount);
  const documentsWithTerm = corpusStatistics.documentFrequency[term] ?? 0;
  const inverseDocumentFrequency = Math.log(
    1 +
      (documentCount - documentsWithTerm + POSTING_BM25_IDF_SMOOTHING) /
        (documentsWithTerm + POSTING_BM25_IDF_SMOOTHING),
  );
  const denominator =
    posting.termFrequency +
    POSTING_BM25_SATURATION *
      (1 -
        POSTING_BM25_LENGTH_NORMALIZATION +
        POSTING_BM25_LENGTH_NORMALIZATION *
          (posting.documentLength / Math.max(1, corpusStatistics.averageDocumentLength)));
  const bm25 = inverseDocumentFrequency * ((posting.termFrequency * (POSTING_BM25_SATURATION + 1)) / denominator);
  return bm25 + posting.fieldWeight / POSTING_IDENTIFIER_WEIGHT;
}

function selectQueryTerms(
  terms: readonly string[],
  cache: RecallIndexCache,
  allowedUriScopes: readonly string[] | undefined,
): readonly string[] {
  const scoped = allowedUriScopes !== undefined && allowedUriScopes.length > 0;
  const documentCount = Math.max(
    1,
    scoped
      ? cache.candidates.filter(candidate => uriMatchesScopes(candidate.uri, allowedUriScopes)).length
      : cache.corpusStatistics.documentCount,
  );
  const documentFrequency = (term: string): number =>
    scoped
      ? (cache.postings[term] ?? []).filter(posting => uriMatchesScopes(posting.uri, allowedUriScopes)).length
      : (cache.corpusStatistics.documentFrequency[term] ?? 0);
  return [...new Set(terms)]
    .map(term => ({frequency: documentFrequency(term), term}))
    .filter(item => item.frequency > 0)
    .sort((left, right) => {
      const leftIdf = Math.log(
        1 +
          (documentCount - left.frequency + POSTING_BM25_IDF_SMOOTHING) / (left.frequency + POSTING_BM25_IDF_SMOOTHING),
      );
      const rightIdf = Math.log(
        1 +
          (documentCount - right.frequency + POSTING_BM25_IDF_SMOOTHING) /
            (right.frequency + POSTING_BM25_IDF_SMOOTHING),
      );
      return rightIdf - leftIdf || left.term.localeCompare(right.term);
    })
    .slice(0, MAX_QUERY_TERMS)
    .map(item => item.term);
}

function uriMatchesScopes(uri: string, scopes: readonly string[] | undefined): boolean {
  if (!scopes || scopes.length === 0) {
    return true;
  }
  const documentUri = stripRecallAnchor(uri);
  return scopes.some(scope => {
    const normalizedScope = stripRecallAnchor(scope).replace(/\/+$/, '');
    return documentUri === normalizedScope || documentUri.startsWith(`${normalizedScope}/`);
  });
}

function stripRecallAnchor(uri: string): string {
  return uri.replace(/#.*$/, '');
}

function recallIndexRoots(
  config: RecallIndexConfig,
  pathService: Path.Path,
): readonly {readonly path: string; readonly uri: string}[] {
  const storageRoot = pathService.join(config.agentContextHome, 'data', config.account);
  return [
    {path: pathService.join(storageRoot, 'resources'), uri: 'threadnote://resources'},
    {
      path: pathService.join(storageRoot, 'user', uriSegment(config.user), 'memories'),
      uri: `threadnote://user/${uriSegment(config.user)}/memories`,
    },
  ];
}

function excludedDirectory(path: string, includeInactive: boolean): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.includes('/agent-artifacts/packs/')) {
    return true;
  }
  return !includeInactive && (normalized.includes('/archived/') || normalized.includes('/superseded/'));
}

function excludedFile(path: string): boolean {
  const extensionIndex = path.lastIndexOf('.');
  const extension = extensionIndex === -1 ? '' : path.slice(extensionIndex).toLowerCase();
  const normalized = path.replaceAll('\\', '/');
  return (
    !TEXT_EXTENSIONS.has(extension) ||
    /\/\.(?:abstract|overview)\.md$/.test(normalized) ||
    normalized.includes('/agent-artifacts/packs/')
  );
}

function indexCandidate(uri: string, content: string, canonicalResource: boolean): RecallCandidate {
  const memory = parseMemoryDocument(uri, content);
  const text = redactSensitiveText(memory?.body ?? content);
  const fields = {
    identifiers: identifiers(text),
    keywords: memory?.metadata.keywords,
    project: memory?.metadata.project ?? resourceProject(uri),
    title: firstHeading(text) ?? uriBasename(uri),
    topic: memory?.metadata.topic ?? uriTopic(uri),
  };
  return {
    authority: boundedMemoryAuthority(uri, memory?.metadata, {canonicalResource}),
    fields,
    kind: memory?.metadata.kind,
    relations: memoryRelations(memory),
    status: memory?.metadata.status,
    text: indexTerms(text).join(' '),
    timestamp: memory?.metadata.timestamp,
    trust: boundedMemoryTrust(uri, memory?.metadata, {canonicalResource}),
    uri,
    validFrom: memory?.metadata.validFrom,
    validTo: memory?.metadata.validTo,
  };
}

function memoryRelations(memory: ReturnType<typeof parseMemoryDocument>): readonly MemoryRelation[] | undefined {
  if (!memory) {
    return undefined;
  }
  const relations: MemoryRelation[] = [
    ...(memory.metadata.relations ?? []),
    ...(memory.metadata.references ?? []).map(uri => ({type: 'references' as const, uri})),
    ...(memory.metadata.evidence ?? [])
      .filter(evidence => evidence.startsWith('threadnote://'))
      .map(uri => ({type: 'evidence_for' as const, uri})),
    ...(memory.metadata.supersedes ? [{type: 'supersedes' as const, uri: memory.metadata.supersedes}] : []),
  ];
  return relations.length > 0 ? relations : undefined;
}

function indexTerms(value: string): readonly string[] {
  const terms: string[] = [];
  for (const match of value.matchAll(IDENTIFIER_PATTERN)) {
    const raw = match[0];
    const original = raw.toLowerCase();
    terms.push(original);
    terms.push(
      ...raw
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[._/-]+/)
        .map(term => term.toLowerCase())
        .filter(term => term.length >= 2),
    );
  }
  return terms;
}

function identifiers(value: string): readonly string[] {
  return [
    ...new Set(
      [...value.matchAll(IDENTIFIER_PATTERN)]
        .map(match => match[0].toLowerCase())
        .filter(term => /[0-9_.-]/.test(term)),
    ),
  ].slice(0, 64);
}

function firstHeading(value: string): string | undefined {
  return /^#{1,3}\s+(.+)$/m.exec(value)?.[1]?.trim();
}

function resourceProject(uri: string): string | undefined {
  return /^threadnote:\/\/resources\/repos\/([^/]+)/.exec(uri)?.[1];
}

function uriTopic(uri: string): string {
  return uriBasename(uri).replace(/\.[a-z0-9]+$/i, '');
}

function uriBasename(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

function sameSources(left: readonly RecallIndexSource[], right: readonly RecallIndexSource[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSource(left: RecallIndexSource, right: RecallIndexSource): boolean {
  return (
    left.modifiedAt === right.modifiedAt &&
    left.path === right.path &&
    left.size === right.size &&
    left.uri === right.uri
  );
}

function sameStringRecord(left: Readonly<Record<string, string>>, right: ReadonlyMap<string, string>): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === right.size && leftEntries.every(([key, value]) => right.get(key) === value);
}

function readCache(
  fs: FileSystem.FileSystem,
  path: string,
  bypassMemory: boolean,
): Effect.Effect<RecallIndexCache | undefined, unknown> {
  return Effect.gen(function* () {
    if (dirtyCachePaths.has(path)) {
      return undefined;
    }
    const staleGeneration = yield* readStaleGeneration(fs, path);
    if (!bypassMemory) {
      const decoded = decodedCacheByPath.get(path);
      if (decoded && decodedCacheGenerationByPath.get(path) === staleGeneration) {
        return decoded;
      }
    }
    if (staleGeneration !== null) {
      return undefined;
    }
    if (!(yield* fs.exists(path))) {
      return undefined;
    }
    const raw = yield* fs.readFileString(path);
    const value = Option.getOrUndefined(Option.liftThrowable((content: string): unknown => JSON.parse(content))(raw));
    const parsed = parseCache(value);
    if (parsed) {
      decodedCacheByPath.set(path, parsed);
      decodedCacheGenerationByPath.set(path, null);
    }
    return parsed;
  });
}

function readStaleGeneration(fs: FileSystem.FileSystem, path: string): Effect.Effect<string | null, never> {
  return Effect.gen(function* () {
    const stalePath = `${path}.stale`;
    if (!(yield* fs.exists(stalePath).pipe(Effect.catch(() => Effect.succeed(false))))) {
      return null;
    }
    return yield* fs.readFileString(stalePath).pipe(
      Effect.map(value => value.trim() || 'present'),
      Effect.catch(() => Effect.succeed('present')),
    );
  });
}

const writeStaleGeneration = Effect.fn('recall.writeStaleGeneration')(function* (
  fs: FileSystem.FileSystem,
  path: string,
) {
  const system = yield* SystemInfo;
  const counter = yield* Effect.sync(() => {
    staleGenerationCounter += 1;
    return staleGenerationCounter;
  });
  const generation = `${yield* Clock.currentTimeMillis}:${system.processId}:${counter}`;
  yield* fs.writeFileString(`${path}.stale`, `${generation}\n`, {mode: 0o600});
  return generation;
});

function loadCanonicalResourcePolicy(
  config: RecallIndexConfig,
): Effect.Effect<CanonicalResourcePolicy, never, Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo> {
  if (!config.manifestPath) {
    return Effect.succeed({entryKeyByUri: new Map(), sourcePathByUri: new Map()});
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const manifestRaw = yield* fs.readFileString(config.manifestPath as string);
    const manifest = yield* Effect.try({
      try: () => parseSeedManifest(manifestRaw, config.manifestPath as string),
      catch: cause => cause,
    });
    const seedStateRaw = yield* fs.readFileString(pathService.join(config.agentContextHome, SEED_STATE_FILE));
    const seedState = yield* Effect.try({
      try: () => parseSeedState(seedStateRaw),
      catch: cause => cause,
    });
    const entryKeyByUri = new Map<string, string>();
    const sourcePathByUri = new Map<string, string>();
    for (const [uri, recorded] of [...seedState].sort(([left], [right]) => left.localeCompare(right))) {
      const source = yield* resolveSeededResourceSource(fs, manifest.projects, uri, recorded);
      if (!source) {
        continue;
      }
      const match = seededResourceMatch(manifest.projects, uri);
      if (!match) {
        continue;
      }
      sourcePathByUri.set(uri, source);
      entryKeyByUri.set(
        uri,
        yield* sha256Hex(
          JSON.stringify({
            project: {
              path: yield* expandPath(match.project.path),
              seed: [...match.project.seed],
              uri: normalizedResourceRoot(match.project.uri),
            },
            recorded,
            source,
            uri,
          }),
        ),
      );
    }
    return {entryKeyByUri, sourcePathByUri};
  }).pipe(
    Effect.catch(() =>
      Effect.succeed({
        entryKeyByUri: new Map<string, string>(),
        sourcePathByUri: new Map<string, string>(),
      }),
    ),
  );
}

function parseSeedState(raw: string): ReadonlyMap<string, SeedStateEntry> {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('files' in value) ||
    typeof value.files !== 'object' ||
    value.files === null
  ) {
    return new Map();
  }
  const entries: Array<[string, SeedStateEntry]> = [];
  for (const [uri, entry] of Object.entries(value.files)) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'mtimeMs' in entry &&
      typeof entry.mtimeMs === 'number' &&
      Number.isFinite(entry.mtimeMs) &&
      'size' in entry &&
      typeof entry.size === 'number' &&
      Number.isFinite(entry.size)
    ) {
      entries.push([uri, {mtimeMs: entry.mtimeMs, size: entry.size}]);
    }
  }
  return new Map(entries);
}

function resolveSeededResourceSource(
  fs: FileSystem.FileSystem,
  projects: readonly ProjectManifest[],
  uri: string,
  recorded: SeedStateEntry,
): Effect.Effect<string | undefined, never, Path.Path | SystemInfo> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const match = seededResourceMatch(projects, uri);
    if (!match) {
      return undefined;
    }
    const projectRoot = yield* expandPath(match.project.path);
    const sourcePath = pathService.join(projectRoot, ...match.relativePath.split('/'));
    const relativeSourcePath = pathService.relative(projectRoot, sourcePath);
    if (
      relativeSourcePath === '' ||
      relativeSourcePath.startsWith(`..${pathService.sep}`) ||
      relativeSourcePath === '..' ||
      pathService.isAbsolute(relativeSourcePath)
    ) {
      return undefined;
    }
    const [realProjectRoot, realSourcePath, info] = yield* Effect.all([
      fs.realPath(projectRoot),
      fs.realPath(sourcePath),
      fs.stat(sourcePath),
    ]);
    const realRelativePath = pathService.relative(realProjectRoot, realSourcePath);
    if (
      realRelativePath.startsWith(`..${pathService.sep}`) ||
      realRelativePath === '..' ||
      pathService.isAbsolute(realRelativePath) ||
      info.type !== 'File' ||
      Number(info.size) !== recorded.size
    ) {
      return undefined;
    }
    const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime();
    if (modifiedAt === undefined || Math.abs(modifiedAt - recorded.mtimeMs) > SEED_FILE_MTIME_TOLERANCE_MILLISECONDS) {
      return undefined;
    }
    return sourcePath;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

function seededResourceMatch(
  projects: readonly ProjectManifest[],
  uri: string,
): {readonly project: ProjectManifest; readonly relativePath: string} | undefined {
  for (const project of projects) {
    const root = normalizedResourceRoot(project.uri);
    if (!uri.startsWith(`${root}/`)) {
      continue;
    }
    const relativePath = uri.slice(root.length + 1).replaceAll('\\', '/');
    if (
      relativePath.length === 0 ||
      relativePath.startsWith('/') ||
      relativePath.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
      !project.seed.some(pattern => globToRegExp(pattern.replaceAll('\\', '/')).test(relativePath))
    ) {
      continue;
    }
    return {project, relativePath};
  }
  return undefined;
}

function normalizedResourceRoot(uri: string): string {
  return stripRecallAnchor(uri).replace(/\/+$/, '');
}

function verifyCanonicalResource(
  fs: FileSystem.FileSystem,
  uri: string,
  indexedContent: string,
  policy: CanonicalResourcePolicy,
): Effect.Effect<boolean, never> {
  const sourcePath = policy.sourcePathByUri.get(uri);
  if (!sourcePath) {
    return Effect.succeed(false);
  }
  return fs.readFileString(sourcePath).pipe(
    Effect.map(sourceContent => sourceContent === indexedContent),
    Effect.catch(() => Effect.succeed(false)),
  );
}

function parseCache(value: unknown): RecallIndexCache | undefined {
  if (
    !isPlainRecord(value) ||
    !('version' in value) ||
    value.version !== RECALL_INDEX_CACHE_VERSION ||
    !('sources' in value) ||
    !Array.isArray(value.sources) ||
    !value.sources.every(recallIndexSourceIsValid) ||
    !('includeInactive' in value) ||
    typeof value.includeInactive !== 'boolean' ||
    !('validatedAt' in value) ||
    !isFiniteNumber(value.validatedAt) ||
    !('candidates' in value) ||
    !Array.isArray(value.candidates) ||
    !value.candidates.every(recallCandidateIsValid) ||
    !('authorityPolicyByUri' in value) ||
    !isPlainRecord(value.authorityPolicyByUri) ||
    !Object.values(value.authorityPolicyByUri).every(entry => typeof entry === 'string') ||
    !('corpusStatistics' in value) ||
    !recallCorpusStatisticsIsValid(value.corpusStatistics) ||
    !('uriLookup' in value) ||
    !recallUriLookupIsValid(value.uriLookup, value.candidates) ||
    !('postings' in value) ||
    !recallPostingsAreValid(value.postings, value.candidates, value.uriLookup)
  ) {
    return undefined;
  }
  const sourceUris = new Set(value.sources.map(source => source.uri));
  if (
    value.corpusStatistics.documentCount !== value.candidates.length ||
    value.sources.length !== value.candidates.length ||
    sourceUris.size !== value.sources.length ||
    !value.candidates.every(candidate => sourceUris.has(stripRecallAnchor(candidate.uri)))
  ) {
    return undefined;
  }
  return value as unknown as RecallIndexCache;
}

function recallCorpusStatisticsIsValid(value: unknown): value is RecallCorpusStatistics {
  return (
    isPlainRecord(value) &&
    'averageDocumentLength' in value &&
    isFiniteNumber(value.averageDocumentLength) &&
    value.averageDocumentLength > 0 &&
    'documentCount' in value &&
    isNonNegativeInteger(value.documentCount) &&
    'documentFrequency' in value &&
    isPlainRecord(value.documentFrequency) &&
    Object.values(value.documentFrequency).every(isNonNegativeInteger) &&
    'totalDocumentLength' in value &&
    isFiniteNumber(value.totalDocumentLength) &&
    value.totalDocumentLength >= 0
  );
}

function recallIndexSourceIsValid(value: unknown): value is RecallIndexSource {
  return (
    isPlainRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.uri === 'string' &&
    isFiniteNumber(value.size) &&
    value.size >= 0 &&
    (value.modifiedAt === undefined || typeof value.modifiedAt === 'string')
  );
}

function recallCandidateIsValid(value: unknown): value is RecallCandidate {
  if (!isPlainRecord(value) || typeof value.uri !== 'string' || typeof value.text !== 'string') {
    return false;
  }
  const stringValues = ['authority', 'kind', 'status', 'timestamp', 'trust', 'validFrom', 'validTo'] as const;
  if (stringValues.some(key => value[key] !== undefined && typeof value[key] !== 'string')) {
    return false;
  }
  const numberValues = ['feedback', 'reranker', 'semantic'] as const;
  if (numberValues.some(key => value[key] !== undefined && !isFiniteNumber(value[key]))) {
    return false;
  }
  if (value.exactTerms !== undefined && !isStringArray(value.exactTerms)) {
    return false;
  }
  if (value.fields !== undefined) {
    if (!isPlainRecord(value.fields)) return false;
    const fields = value.fields;
    if (
      !['project', 'title', 'topic'].every(key => fields[key] === undefined || typeof fields[key] === 'string') ||
      !['identifiers', 'keywords'].every(key => fields[key] === undefined || isStringArray(fields[key]))
    ) {
      return false;
    }
  }
  return (
    value.relations === undefined ||
    (Array.isArray(value.relations) &&
      value.relations.every(
        relation => isPlainRecord(relation) && typeof relation.type === 'string' && typeof relation.uri === 'string',
      ))
  );
}

function recallPostingsAreValid(
  value: unknown,
  candidates: readonly RecallCandidate[],
  uriLookup: Readonly<Record<string, number>>,
): value is Readonly<Record<string, readonly RecallIndexPosting[]>> {
  if (!isPlainRecord(value)) {
    return false;
  }
  const coveredUris = new Set<string>();
  for (const postings of Object.values(value)) {
    if (!Array.isArray(postings)) {
      return false;
    }
    for (const posting of postings) {
      if (
        !isPlainRecord(posting) ||
        typeof posting.uri !== 'string' ||
        !isFiniteNumber(posting.documentLength) ||
        posting.documentLength < 0 ||
        !isFiniteNumber(posting.fieldWeight) ||
        posting.fieldWeight < 0 ||
        !isFiniteNumber(posting.termFrequency) ||
        posting.termFrequency < 0
      ) {
        return false;
      }
      const candidateIndex = uriLookup[posting.uri];
      if (candidateIndex === undefined || stripRecallAnchor(candidates[candidateIndex]?.uri ?? '') !== posting.uri) {
        return false;
      }
      coveredUris.add(posting.uri);
    }
  }
  return candidates.every(candidate => coveredUris.has(stripRecallAnchor(candidate.uri)));
}

function recallUriLookupIsValid(
  value: unknown,
  candidates: readonly RecallCandidate[],
): value is Readonly<Record<string, number>> {
  if (!isPlainRecord(value)) {
    return false;
  }
  const expected = new Map<string, number>();
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const uri = stripRecallAnchor(candidate.uri);
    if (expected.has(uri)) {
      return false;
    }
    expected.set(uri, candidateIndex);
  }
  const entries = Object.entries(value);
  return (
    entries.length === expected.size && entries.every(([uri, candidateIndex]) => expected.get(uri) === candidateIndex)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

/**
 * Keep a max-heap whose root is the worst retained item. `compareBestFirst`
 * follows Array.sort semantics: negative means the left item is better.
 */
function offerBoundedBest<T>(heap: T[], item: T, limit: number, compareBestFirst: (left: T, right: T) => number): void {
  if (limit <= 0) return;
  if (heap.length < limit) {
    heap.push(item);
    bubbleWorstUp(heap, heap.length - 1, compareBestFirst);
    return;
  }
  if (compareBestFirst(item, heap[0]!) >= 0) return;
  heap[0] = item;
  sinkWorstDown(heap, 0, compareBestFirst);
}

function bubbleWorstUp<T>(heap: T[], start: number, compareBestFirst: (left: T, right: T) => number): void {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareBestFirst(heap[index]!, heap[parent]!) <= 0) break;
    [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
    index = parent;
  }
}

function sinkWorstDown<T>(heap: T[], start: number, compareBestFirst: (left: T, right: T) => number): void {
  let index = start;
  for (;;) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    const worse = right < heap.length && compareBestFirst(heap[right]!, heap[left]!) > 0 ? right : left;
    if (compareBestFirst(heap[worse]!, heap[index]!) <= 0) return;
    [heap[index], heap[worse]] = [heap[worse]!, heap[index]!];
    index = worse;
  }
}

function writeCacheAtomically(
  fs: FileSystem.FileSystem,
  path: string,
  cache: RecallIndexCache,
): Effect.Effect<void, unknown, Crypto.Crypto | Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
    const crypto = yield* Crypto.Crypto;
    const temporaryPath = `${path}.${yield* crypto.randomUUIDv4}.tmp`;
    yield* fs.writeFileString(temporaryPath, `${JSON.stringify(cache)}\n`, {mode: 0o600});
    yield* fs
      .rename(temporaryPath, path)
      .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.catch(() => Effect.void))));
    yield* fs.remove(`${path}.stale`, {force: true});
    yield* Effect.sync(() => {
      decodedCacheByPath.set(path, cache);
      decodedCacheGenerationByPath.set(path, null);
      dirtyCachePaths.delete(path);
    });
  });
}
