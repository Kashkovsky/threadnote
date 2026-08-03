import type {DocsArticle, DocsBlock, DocsSection} from '../content/docs.js';

type SearchFieldKind = 'body' | 'code' | 'heading' | 'keywords' | 'section' | 'summary' | 'title';

interface SearchField {
  readonly kind: SearchFieldKind;
  readonly label: string;
  readonly normalized: string;
  readonly text: string;
  readonly tokens: readonly string[];
  readonly weight: number;
}

interface IndexedArticle {
  readonly article: DocsArticle;
  readonly fields: readonly SearchField[];
  readonly order: number;
  readonly section: DocsSection;
}

export interface DocsSearchIndex {
  readonly articles: readonly IndexedArticle[];
}

export interface DocsSearchResult {
  readonly article: DocsArticle;
  readonly matchLabel: string;
  readonly matchedTerms: readonly string[];
  readonly score: number;
  readonly section: DocsSection;
  readonly snippet: string;
}

const QUERY_STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'from', 'how', 'in', 'is', 'of', 'on', 'the', 'to', 'with']);

export const DOCS_SEARCH_MAXIMUM_LENGTH = 256;
export const DOCS_SEARCH_MAXIMUM_TERMS = 12;
const DOCS_SEARCH_MAXIMUM_TERM_LENGTH = 64;

const fieldWeights: Readonly<Record<SearchFieldKind, number>> = {
  body: 3,
  code: 4,
  heading: 10,
  keywords: 6,
  section: 4,
  summary: 8,
  title: 16,
};

const phraseWeights: Readonly<Record<SearchFieldKind, number>> = {
  body: 1.25,
  code: 1.25,
  heading: 2.5,
  keywords: 2,
  section: 1,
  summary: 2,
  title: 3,
};

function plainText(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[`*_>#~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeDocsSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(value: string): readonly string[] {
  const normalized = normalizeDocsSearchText(value);
  return normalized ? normalized.split(' ') : [];
}

function queryTokens(value: string): readonly string[] {
  const tokens = tokenize(value.slice(0, DOCS_SEARCH_MAXIMUM_LENGTH))
    .filter(token => token.length > 1 && !QUERY_STOP_WORDS.has(token))
    .map(token => token.slice(0, DOCS_SEARCH_MAXIMUM_TERM_LENGTH));
  return [...new Set(tokens)].slice(0, DOCS_SEARCH_MAXIMUM_TERMS);
}

function field(kind: SearchFieldKind, label: string, value: string): SearchField {
  const text = plainText(value);
  return {
    kind,
    label,
    normalized: normalizeDocsSearchText(text),
    text,
    tokens: tokenize(text),
    weight: fieldWeights[kind],
  };
}

function blockText(block: DocsBlock): string {
  if ('text' in block) return block.text;
  if ('code' in block) return block.code;
  if ('items' in block) return block.items.join(' ');
  return [...block.headers, ...block.rows.flat()].join(' ');
}

function articleFields(article: DocsArticle, section: DocsSection): readonly SearchField[] {
  const fields: SearchField[] = [
    field('title', 'Title', article.title),
    field('section', 'Section', section.title),
    field('summary', 'Summary', article.summary),
  ];
  if (article.keywords?.length) fields.push(field('keywords', 'Related topics', article.keywords.join(' ')));

  let heading = '';
  for (const block of article.body) {
    if (block.type === 'heading') {
      heading = block.text;
      fields.push(field('heading', `Heading · ${block.text}`, block.text));
      continue;
    }
    const kind: SearchFieldKind = block.type === 'code' ? 'code' : 'body';
    fields.push(field(kind, heading ? `Under ${heading}` : 'Article content', blockText(block)));
  }
  return fields.filter(candidate => candidate.normalized.length > 0);
}

export function createDocsSearchIndex(sections: readonly DocsSection[]): DocsSearchIndex {
  let order = 0;
  return {
    articles: sections.flatMap(section =>
      section.articles.map(article => ({
        article,
        fields: articleFields(article, section),
        order: order++,
        section,
      })),
    ),
  };
}

function boundedEditDistance(left: string, right: string, maximum: number): number {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previous = Array.from({length: right.length + 1}, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const value = Math.min(
        (current[rightIndex - 1] ?? maximum + 1) + 1,
        (previous[rightIndex] ?? maximum + 1) + 1,
        (previous[rightIndex - 1] ?? maximum + 1) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maximum) return maximum + 1;
    previous = current;
  }
  return previous[right.length] ?? maximum + 1;
}

function tokenQuality(query: string, candidate: string): number {
  if (query === candidate) return 1;
  if (query.length >= 3 && candidate.startsWith(query)) return 0.72;
  if (candidate.length >= 4 && query.startsWith(candidate)) return 0.58;
  const maximumDistance = query.length >= 8 ? 2 : query.length >= 5 ? 1 : 0;
  if (maximumDistance > 0 && boundedEditDistance(query, candidate, maximumDistance) <= maximumDistance) return 0.4;
  return 0;
}

function bestTokenQuality(query: string, candidates: readonly string[]): number {
  let best = 0;
  for (const candidate of candidates) {
    best = Math.max(best, tokenQuality(query, candidate));
    if (best === 1) break;
  }
  return best;
}

function snippetAroundMatch(text: string, terms: readonly string[]): string {
  const compact = plainText(text);
  if (compact.length <= 210) return compact;
  const lower = compact.toLowerCase();
  const matchAt = terms.reduce((best, term) => {
    const index = lower.indexOf(term.toLowerCase());
    return index >= 0 && (best < 0 || index < best) ? index : best;
  }, -1);
  const startTarget = Math.max(0, (matchAt < 0 ? 0 : matchAt) - 72);
  const startBoundary = startTarget === 0 ? 0 : compact.indexOf(' ', startTarget);
  const start = startBoundary < 0 ? startTarget : startBoundary + 1;
  const endTarget = Math.min(compact.length, start + 210);
  const endBoundary = endTarget === compact.length ? compact.length : compact.lastIndexOf(' ', endTarget);
  const end = endBoundary <= start ? endTarget : endBoundary;
  return `${start > 0 ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`;
}

export function searchDocs(index: DocsSearchIndex, value: string, limit = 12): readonly DocsSearchResult[] {
  const boundedValue = value.slice(0, DOCS_SEARCH_MAXIMUM_LENGTH);
  const terms = queryTokens(boundedValue);
  if (terms.length === 0) {
    return index.articles.slice(0, Math.max(0, limit)).map(entry => ({
      article: entry.article,
      matchLabel: 'Recommended',
      matchedTerms: [],
      score: 0,
      section: entry.section,
      snippet: entry.article.summary,
    }));
  }

  const normalizedPhrase = normalizeDocsSearchText(boundedValue);
  return index.articles
    .map(entry => {
      const bestTermScores = new Map(terms.map(term => [term, 0]));
      let bestPhraseScore = 0;
      let bestField = entry.fields.find(candidate => candidate.kind === 'summary') ?? entry.fields[0]!;
      let bestFieldScore = -1;
      const matchedTerms = new Set<string>();

      for (const candidate of entry.fields) {
        let candidateScore = 0;
        for (const term of terms) {
          const quality = bestTokenQuality(term, candidate.tokens);
          if (quality <= 0) continue;
          matchedTerms.add(term);
          const termScore = candidate.weight * quality;
          candidateScore += termScore;
          bestTermScores.set(term, Math.max(bestTermScores.get(term) ?? 0, termScore));
        }
        if (normalizedPhrase.length > 2 && candidate.normalized.includes(normalizedPhrase)) {
          const phraseScore = candidate.weight * phraseWeights[candidate.kind];
          candidateScore += phraseScore;
          bestPhraseScore = Math.max(bestPhraseScore, phraseScore);
        }
        if (
          candidateScore > bestFieldScore &&
          candidate.kind !== 'keywords' &&
          candidate.kind !== 'section' &&
          candidate.kind !== 'title'
        ) {
          bestField = candidate;
          bestFieldScore = candidateScore;
        }
      }

      const coverage = matchedTerms.size / terms.length;
      const minimumCoverage = terms.length === 1 ? 1 : terms.length === 2 ? 1 : 2 / 3;
      if (coverage < minimumCoverage) return undefined;
      let score = [...bestTermScores.values()].reduce((total, termScore) => total + termScore, 0) + bestPhraseScore;
      score *= 0.55 + coverage * 0.45;
      return {
        article: entry.article,
        matchLabel: bestField.label,
        matchedTerms: [...matchedTerms],
        order: entry.order,
        score,
        section: entry.section,
        snippet: snippetAroundMatch(bestField.text, [...matchedTerms]),
      };
    })
    .filter((result): result is NonNullable<typeof result> => result !== undefined)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, Math.max(0, limit))
    .map(({order: _order, ...result}) => result);
}
