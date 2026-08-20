import {Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {boundedRecallPhysicalCandidateLimit} from './index_query.js';
import {
  combineRecallSqlPredicates,
  recallUriScopePredicate,
  recallWorkspaceScopePredicate,
  type RecallSqlPredicate,
  type RecallWorkspaceScopeMode,
} from './index_scope.js';
import type {RecallCorpusStatistics} from './rank.js';

interface RecallDocumentSampleRow {
  readonly candidate_json: string;
  readonly id: number;
  readonly uri: string;
}

export function recallProjectMatches(project: string | undefined, candidateProject: string | undefined): boolean {
  const normalizedProject = project?.trim().toLowerCase();
  return !normalizedProject || candidateProject?.trim().toLowerCase() === normalizedProject;
}

export function recallProjectPredicate(alias: string, project: string | undefined): RecallSqlPredicate {
  const normalizedProject = project?.trim().toLowerCase();
  return normalizedProject
    ? {params: [normalizedProject], restricted: true, sql: `${alias}.project = ?`}
    : {params: [], restricted: false, sql: '1 = 1'};
}

export function selectRecallDocumentSample(
  sql: SqlClient.SqlClient,
  options: {
    readonly allowedUriScopes?: readonly string[];
    readonly limit?: number;
    readonly project?: string;
    readonly workspaceScope?: string;
    readonly workspaceScopeMode?: RecallWorkspaceScopeMode;
  },
) {
  const normalizedLimit = options.limit === undefined ? undefined : Math.max(0, Math.floor(options.limit));
  if (normalizedLimit === 0) return Effect.succeed<readonly RecallDocumentSampleRow[]>([]);
  const scope = combineRecallSqlPredicates(
    recallUriScopePredicate('d', options.allowedUriScopes),
    recallProjectPredicate('d', options.project),
    recallWorkspaceScopePredicate('d', options.workspaceScope, options.workspaceScopeMode),
  );
  const physicalLimit =
    normalizedLimit === undefined ? undefined : boundedRecallPhysicalCandidateLimit(normalizedLimit);
  const bounded = physicalLimit === undefined ? '' : ' LIMIT ?';
  const order = normalizedLimit === undefined ? 'd.uri' : 'd.source_modified_at DESC, d.uri';
  return sql.unsafe<RecallDocumentSampleRow>(
    `SELECT d.id, d.uri, d.candidate_json
     FROM documents AS d
     WHERE ${scope.sql}
     ORDER BY ${order}${bounded}`,
    [...scope.params, ...(physicalLimit === undefined ? [] : [physicalLimit])],
  );
}

/** Cheaply reject an empty project/workspace lane before scoring its query postings. */
export function recallSelectionHasDocuments(
  sql: SqlClient.SqlClient,
  options: {
    readonly allowedUriScopes?: readonly string[];
    readonly project?: string;
    readonly workspaceScope?: string;
    readonly workspaceScopeMode?: RecallWorkspaceScopeMode;
  },
) {
  const scope = combineRecallSqlPredicates(
    recallUriScopePredicate('d', options.allowedUriScopes),
    recallProjectPredicate('d', options.project),
    recallWorkspaceScopePredicate('d', options.workspaceScope, options.workspaceScopeMode),
  );
  return sql
    .unsafe<{readonly present: number}>(
      `SELECT 1 AS present FROM documents AS d WHERE ${scope.sql} LIMIT 1`,
      scope.params,
    )
    .pipe(Effect.map(rows => rows.length > 0));
}

export function selectRecallQueryTermStatistics(
  sql: SqlClient.SqlClient,
  terms: readonly string[],
  corpusStatistics: RecallCorpusStatistics,
  options: {
    readonly allowedUriScopes?: readonly string[];
    readonly project?: string;
    readonly workspaceScope?: string;
    readonly workspaceScopeMode?: RecallWorkspaceScopeMode;
  },
) {
  if (
    (!options.allowedUriScopes || options.allowedUriScopes.length === 0) &&
    options.project === undefined &&
    options.workspaceScope === undefined
  ) {
    return Effect.succeed<RecallCorpusStatistics>(corpusStatistics);
  }
  return Effect.gen(function* () {
    const uriScope = recallUriScopePredicate('d', options.allowedUriScopes);
    const workspace = recallWorkspaceScopePredicate('d', options.workspaceScope, options.workspaceScopeMode);
    const scope = combineRecallSqlPredicates(uriScope, recallProjectPredicate('d', options.project), workspace);
    const indexHint = uriScope.restricted
      ? ' INDEXED BY documents_uri'
      : workspace.restricted
        ? ' INDEXED BY documents_workspace_scope_uri'
        : '';
    const aggregateRows = yield* sql.unsafe<{
      readonly document_count: number;
      readonly total_document_length: number;
    }>(
      `SELECT COUNT(*) AS document_count, COALESCE(SUM(document_length), 0) AS total_document_length
       FROM (
         SELECT d.logical_key, MAX(d.document_length) AS document_length
         FROM documents AS d${indexHint}
         WHERE ${scope.sql}
         GROUP BY d.logical_key
       )`,
      scope.params,
    );
    const frequencies: Array<{readonly document_frequency: number; readonly term: string}> = [];
    for (let index = 0; index < terms.length; index += 300) {
      const batch = terms.slice(index, index + 300);
      frequencies.push(
        ...(yield* sql.unsafe<{readonly document_frequency: number; readonly term: string}>(
          `SELECT p.term, COUNT(DISTINCT d.logical_key) AS document_frequency
           FROM documents AS d${indexHint}
           INNER JOIN postings AS p ON p.document_id = d.id
           WHERE p.term IN (${batch.map(() => '?').join(', ')})
             AND ${scope.sql}
           GROUP BY p.term`,
          [...batch, ...scope.params],
        )),
      );
    }
    const documentCount = aggregateRows[0]?.document_count ?? 0;
    const totalDocumentLength = aggregateRows[0]?.total_document_length ?? 0;
    return {
      averageDocumentLength: documentCount === 0 ? 1 : totalDocumentLength / documentCount,
      documentCount,
      documentFrequency: Object.assign(
        Object.create(null) as Record<string, number>,
        Object.fromEntries(frequencies.map(row => [row.term, row.document_frequency])),
      ),
      totalDocumentLength,
    } satisfies RecallCorpusStatistics;
  });
}

/** Conservative proof that the topical query returned every possible logical match. */
export function recallQuerySelectionIsExhaustive(input: {
  readonly candidateDecodeLimit: number;
  readonly deduplicatedCandidateCount: number;
  readonly documentFrequency: Readonly<Record<string, number>>;
  readonly indexedQueryTerms: readonly string[];
  readonly postingPoolLimit: number;
  readonly postingTerms: readonly string[];
  readonly queryTerms: readonly string[];
  readonly rankedDocumentCount: number;
  readonly resultLimit: number;
}): boolean {
  const postingCountByTerm = new Map<string, number>();
  for (const term of input.postingTerms) postingCountByTerm.set(term, (postingCountByTerm.get(term) ?? 0) + 1);
  const indexedTermsWithPostings = input.indexedQueryTerms.filter(term => (input.documentFrequency[term] ?? 0) > 0);
  return (
    input.queryTerms.length === indexedTermsWithPostings.length &&
    input.queryTerms.every(term => (postingCountByTerm.get(term) ?? 0) < input.postingPoolLimit) &&
    input.rankedDocumentCount <= input.candidateDecodeLimit &&
    input.deduplicatedCandidateCount <= input.resultLimit
  );
}
