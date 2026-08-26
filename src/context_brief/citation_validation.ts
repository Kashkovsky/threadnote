import {Clock, Effect, FileSystem, Path} from 'effect';
import {
  createCodeGraphSourceSpanCanonicalizer,
  type CodeGraphEffectiveFileHashMatches,
  type CodeGraphEffectiveFilePathObservation,
  type CodeGraphEffectiveSnapshotCitationEvidence,
  type CodeGraphEffectiveSymbolLocatorMatches,
  type CodeGraphSymbolSemanticLocatorV1,
} from '../code_graph/citation_primitives.js';
import {readContainedStableRegularFile} from '../code_graph/inventory_contained_file.js';
import {decodeUtf8} from '../code_graph/inventory_content.js';
import {previewCodeGraphInventory} from '../code_graph/inventory.js';
import {CodeGraphQueryService} from '../code_graph/query.js';
import {CodeGraphStore} from '../code_graph/store.js';
import type {CodeGraphStatus, CodeGraphSymbol, RepositoryIdentityExpectation} from '../code_graph/types.js';
import {readPublishedCodeGraphWorksetCatalogGeneration} from '../code_graph/workset_catalog/store.js';
import type {
  CodeGraphWorksetCatalogPublishedGenerationV1,
  CodeGraphWorksetCatalogPublishedMemberV1,
} from '../code_graph/workset_catalog/types.js';
import {codeGraphWorksetManifestDigest} from '../code_graph/workset_catalog/workset.js';
import {sha256Hex} from '../effect/digest.js';
import {SystemInfo} from '../effect/system.js';
import {requireWorkset} from '../manifest.js';
import type {MemoryCodeCitationV1} from '../memory_code_citation.js';
import type {ResolvedWorkset, RuntimeConfig} from '../types.js';
import {expandPath} from '../utils.js';
import type {
  ContextBriefCitationValidationFenceV2,
  ContextBriefCitationValidationReceiptV2,
  ContextBriefMemoryCandidateV1,
  ContextBriefMemoryCitationValidationV2,
  ContextBriefScopeV1,
} from './types.js';

export const CONTEXT_BRIEF_MAXIMUM_CITATION_VALIDATIONS = 96 as const;
export const CONTEXT_BRIEF_MAXIMUM_CITED_REPOSITORIES = 32 as const;
const RELOCATION_MATCH_LIMIT = 2;
const VALIDATION_CONCURRENCY = 4;
const VALIDATION_CACHE_LIMIT = 512;
const validationReceiptCache = new Map<string, ContextBriefCitationValidationReceiptV2>();

interface CitationTask {
  readonly citation: MemoryCodeCitationV1;
  readonly index: number;
  readonly uri: string;
}

interface ReadyRepository {
  readonly cwd: string;
  readonly expected?: RepositoryIdentityExpectation;
  readonly status: CodeGraphStatus;
}

interface ValidationRepositoryTarget {
  readonly cwd: string;
  readonly expected?: RepositoryIdentityExpectation;
}

interface ValidationScopeResolution {
  readonly ambiguousRepositoryIds: ReadonlySet<string>;
  readonly requiredSnapshot?: Extract<ContextBriefCitationValidationFenceV2, {readonly kind: 'repository'}>;
  readonly targets: readonly ValidationRepositoryTarget[];
  readonly unavailableReason: 'graph-stale' | 'repository-unavailable';
  readonly worksetGeneration?: {readonly digest: string; readonly id: string; readonly workset: string};
}

export interface ContextBriefWorksetValidationRoute {
  readonly ambiguousRepositoryIds: ReadonlySet<string>;
  readonly members: readonly {
    readonly projectPath: string;
    readonly published: CodeGraphWorksetCatalogPublishedMemberV1;
  }[];
  readonly generation?: {readonly digest: string; readonly id: string};
  readonly stale: boolean;
}

interface ValidatedCitation {
  readonly cacheHit: boolean;
  readonly receipt: ContextBriefCitationValidationReceiptV2;
}

/** Validate selected-memory citations against exact-current, already-ready graph snapshots. */
export const validateContextBriefMemoryCitations = Effect.fn('contextBrief.validateMemoryCitations')(function* (
  config: RuntimeConfig,
  scope: ContextBriefScopeV1,
  candidates: readonly ContextBriefMemoryCandidateV1[],
  fence?: ContextBriefCitationValidationFenceV2,
) {
  const allTasks = candidates.flatMap(candidate =>
    candidate.codeCitations.map((citation, index) => ({citation, index, uri: candidate.uri})),
  );
  if (allTasks.length === 0) return [] as readonly ContextBriefMemoryCitationValidationV2[];
  const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const unknown = (
    citation: MemoryCodeCitationV1,
    reason: Parameters<typeof unknownReceipt>[1],
  ): ContextBriefCitationValidationReceiptV2 => unknownReceipt(citation, reason, observedAt);
  const admitted = allTasks.slice(0, CONTEXT_BRIEF_MAXIMUM_CITATION_VALIDATIONS);
  const deferred = allTasks.slice(CONTEXT_BRIEF_MAXIMUM_CITATION_VALIDATIONS);
  const repositoryIds = [...new Set(admitted.map(task => task.citation.repositoryId))];
  const admittedRepositoryIds = new Set(repositoryIds.slice(0, CONTEXT_BRIEF_MAXIMUM_CITED_REPOSITORIES));
  const overflowRepositoryIds = new Set(repositoryIds.slice(CONTEXT_BRIEF_MAXIMUM_CITED_REPOSITORIES));
  const resolution: ValidationScopeResolution = yield* validationScopeTargets(
    config,
    scope,
    admittedRepositoryIds,
    fence,
  );
  const byRepository = new Map<string, CitationTask[]>();
  for (const task of admitted) {
    const group = byRepository.get(task.citation.repositoryId) ?? [];
    group.push(task);
    byRepository.set(task.citation.repositoryId, group);
  }
  type ValidationTuple = readonly [CitationTask, ContextBriefCitationValidationReceiptV2, boolean];
  const validated: ValidationTuple[] = [];
  const eligibleByRepository = new Map<string, CitationTask[]>();
  for (const [repositoryId, tasks] of byRepository) {
    if (overflowRepositoryIds.has(repositoryId)) {
      validated.push(...tasks.map(task => [task, unknown(task.citation, 'citation-limit'), false] as const));
    } else if (resolution.ambiguousRepositoryIds.has(repositoryId)) {
      validated.push(...tasks.map(task => [task, unknown(task.citation, 'repository-ambiguous'), false] as const));
    } else {
      eligibleByRepository.set(repositoryId, tasks);
    }
  }
  const query = yield* CodeGraphQueryService;
  const statusOptions = {observeWorktree: true, requestMaintenance: false} as const;
  const observations = yield* Effect.forEach(
    resolution.targets,
    target => {
      const use = (status: CodeGraphStatus) => {
        const repositoryId = status.identity.repositoryId;
        const tasks = eligibleByRepository.get(repositoryId);
        if (tasks === undefined) return Effect.succeed(undefined);
        if (
          resolution.requiredSnapshot !== undefined &&
          (repositoryId !== resolution.requiredSnapshot.repositoryId ||
            status.readySnapshot?.id !== resolution.requiredSnapshot.snapshotId)
        ) {
          return Effect.succeed(undefined);
        }
        const repository = {...target, status} satisfies ReadyRepository;
        if (status.readySnapshot === undefined || status.stale || status.freshness !== 'current') {
          return Effect.succeed({
            repositoryId,
            tuples: tasks.map(task => [task, unknown(task.citation, 'graph-stale'), false] as const),
          });
        }
        return validateRepositoryTasks(config, repository, tasks, observedAt).pipe(
          Effect.map(results => ({
            repositoryId,
            tuples: tasks.map((task, index) => [task, results[index]!.receipt, results[index]!.cacheHit] as const),
          })),
          Effect.catch(() =>
            Effect.succeed({
              repositoryId,
              tuples: tasks.map(task => [task, unknown(task.citation, 'validation-error'), false] as const),
            }),
          ),
        );
      };
      const statusAndValidate = query.withStatusSession
        ? query.withStatusSession(config.agentContextHome, target.cwd, target.expected, statusOptions, use)
        : (target.expected === undefined
            ? query.status(config.agentContextHome, target.cwd, statusOptions)
            : query.statusForPublishedIdentity(config.agentContextHome, target.cwd, target.expected, statusOptions)
          ).pipe(Effect.flatMap(use));
      return statusAndValidate.pipe(Effect.option);
    },
    {concurrency: VALIDATION_CONCURRENCY},
  );
  const matchedRepositoryIds = new Set<string>();
  for (const observation of observations) {
    if (observation._tag === 'None' || observation.value === undefined) continue;
    matchedRepositoryIds.add(observation.value.repositoryId);
    validated.push(...observation.value.tuples);
  }
  for (const [repositoryId, tasks] of eligibleByRepository) {
    if (matchedRepositoryIds.has(repositoryId)) continue;
    validated.push(...tasks.map(task => [task, unknown(task.citation, resolution.unavailableReason), false] as const));
  }

  const receiptsByUri = new Map<string, ContextBriefCitationValidationReceiptV2[]>();
  const cacheHitsByUri = new Map<string, number>();
  for (const [task, receipt, cacheHit] of validated) {
    const receipts = receiptsByUri.get(task.uri) ?? [];
    receipts.push(receipt);
    receiptsByUri.set(task.uri, receipts);
    if (cacheHit) cacheHitsByUri.set(task.uri, (cacheHitsByUri.get(task.uri) ?? 0) + 1);
  }
  for (const task of deferred) {
    const receipts = receiptsByUri.get(task.uri) ?? [];
    receipts.push(unknown(task.citation, 'citation-limit'));
    receiptsByUri.set(task.uri, receipts);
  }
  if (
    resolution.worksetGeneration !== undefined &&
    !(yield* worksetGenerationIsStillPublished(config, resolution.worksetGeneration))
  ) {
    return candidates.flatMap(candidate =>
      candidate.codeCitations.length === 0
        ? []
        : [
            {
              receipts: candidate.codeCitations.map(citation => unknown(citation, 'graph-stale')),
              uri: candidate.uri,
            },
          ],
    ) as readonly ContextBriefMemoryCitationValidationV2[];
  }
  return candidates.flatMap(candidate => {
    const receipts = receiptsByUri.get(candidate.uri);
    if (!receipts) return [];
    const byId = new Map(receipts.map(receipt => [receipt.citationId, receipt]));
    return [
      {
        ...(cacheHitsByUri.has(candidate.uri) ? {cacheHits: cacheHitsByUri.get(candidate.uri)!} : {}),
        receipts: candidate.codeCitations.flatMap(citation => {
          const receipt = byId.get(citation.id);
          return receipt ? [receipt] : [];
        }),
        uri: candidate.uri,
      },
    ];
  }) as readonly ContextBriefMemoryCitationValidationV2[];
});

const validateRepositoryTasks = Effect.fn('contextBrief.validateRepositoryCitationTasks')(function* (
  config: RuntimeConfig,
  repository: ReadyRepository,
  tasks: readonly CitationTask[],
  observedAt: string,
) {
  const store = yield* CodeGraphStore;
  const query = yield* CodeGraphQueryService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const snapshot = repository.status.readySnapshot!;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        store.acquireSnapshotLease(repository.status.databasePath, snapshot.id, 60_000),
        token =>
          store.releaseSnapshotLease(repository.status.databasePath, token).pipe(Effect.catch(() => Effect.void)),
      );
      const cacheKeys = tasks.map(task => validationCacheKey(repository.status, snapshot.id, task.citation.id));
      const cached = cacheKeys.map(validationCacheGet);
      const uncachedTasks = tasks.filter((_, index) => cached[index] === undefined);
      const computed = new Map<CitationTask, ContextBriefCitationValidationReceiptV2>();

      if (uncachedTasks.length > 0) {
        const citations = uncachedTasks.map(task => task.citation);
        const symbolCitations = citations.filter(citation => citation.target.kind === 'symbol');
        const locators = symbolCitations.map(symbolLocator);
        const evidence = yield* store.effectiveSnapshotCitationEvidence(repository.status.databasePath, snapshot.id, {
          contentHashes: citations.map(citation => citation.fileContentHash.value),
          limitPerContentHash: RELOCATION_MATCH_LIMIT,
          limitPerSemanticLocator: RELOCATION_MATCH_LIMIT,
          paths: citations.map(citation => citation.path),
          semanticLocators: locators,
          symbolIds: symbolCitations.flatMap(citation =>
            citation.target.kind === 'symbol' ? [citation.target.nodeId] : [],
          ),
        });
        const pathByPath = new Map(evidence.filesByPaths.map(observation => [observation.path, observation]));
        const hashesByHash = new Map(evidence.filesByContentHashes.map(matches => [matches.contentHash, matches]));
        const exactById = new Map(evidence.symbolsByIds.map(symbol => [symbol.id, symbol]));
        const locatorsByKey = new Map(
          evidence.symbolsBySemanticLocators.map(matches => [locatorKey(matches.locator), matches]),
        );
        const requiresInventoryCoverageProof =
          evidence.fileInventoryCoverage === 'incomplete' &&
          citations.some(citation => {
            const pathObservation = pathByPath.get(citation.path);
            const relocation = hashesByHash.get(citation.fileContentHash.value);
            return (
              pathObservation?.file === undefined && relocation?.truncated === false && relocation.files.length === 0
            );
          });
        const preview = requiresInventoryCoverageProof
          ? yield* previewCodeGraphInventory(repository.status.identity).pipe(Effect.option)
          : undefined;
        const fileInventoryCoverage =
          evidence.fileInventoryCoverage === 'complete' ||
          (preview?._tag === 'Some' &&
            preview.value.commit === snapshot.commit &&
            preview.value.dirty === snapshot.dirty &&
            preview.value.omittedUnsafeWorktreeFiles === 0 &&
            preview.value.repositoryId === repository.status.identity.repositoryId &&
            preview.value.worktreeId === repository.status.identity.worktreeId &&
            preview.value.totals.eligible.files === snapshot.fileCount &&
            preview.value.totals.skipped.files === 0)
            ? ('complete' as const)
            : ('incomplete' as const);
        const repositoryRoot = yield* fs.realPath(repository.status.identity.repoRoot);
        type PreparedSource = ReturnType<typeof createCodeGraphSourceSpanCanonicalizer>;
        const sourceCache = new Map<string, PreparedSource>();
        const readSource = (repositoryPath: string, expectedHash: string) => {
          const key = `${repositoryPath}\u0000${expectedHash}`;
          const cachedSource = sourceCache.get(key);
          if (cachedSource) return Effect.succeed(cachedSource);
          return Effect.gen(function* () {
            const bytes = yield* readContainedStableRegularFile(fs, path, repositoryRoot, repositoryPath);
            if ((yield* sha256Hex(bytes)) !== expectedHash) return yield* Effect.fail('source-drift' as const);
            const source = decodeUtf8(bytes);
            if (source === undefined) return yield* Effect.fail('source-not-utf8' as const);
            const prepared = createCodeGraphSourceSpanCanonicalizer(source);
            sourceCache.set(key, prepared);
            return prepared;
          });
        };

        const receipts = yield* Effect.forEach(
          uncachedTasks,
          task => {
            const citation = task.citation;
            if (citation.target.kind === 'file') {
              return Effect.succeed(
                validateContextBriefFileCitation(
                  citation,
                  pathByPath.get(citation.path),
                  hashesByHash.get(citation.fileContentHash.value),
                  snapshot,
                  observedAt,
                  fileInventoryCoverage,
                ),
              );
            }
            return validateContextBriefSymbolCitation(
              citation as MemoryCodeCitationV1 & {
                readonly target: Extract<MemoryCodeCitationV1['target'], {readonly kind: 'symbol'}>;
              },
              exactById.get(citation.target.nodeId),
              locatorsByKey.get(locatorKey(symbolLocator(citation))),
              pathByPath.get(citation.path),
              hashesByHash.get(citation.fileContentHash.value),
              snapshot,
              readSource,
              observedAt,
              fileInventoryCoverage,
            );
          },
          {concurrency: VALIDATION_CONCURRENCY},
        );
        for (const [index, task] of uncachedTasks.entries()) computed.set(task, receipts[index]!);
      }

      const after = yield* repository.expected === undefined
        ? query.status(config.agentContextHome, repository.cwd, {
            observeWorktree: true,
            requestMaintenance: false,
          })
        : query.statusForPublishedIdentity(config.agentContextHome, repository.cwd, repository.expected, {
            observeWorktree: true,
            requestMaintenance: false,
          });
      if (!sameExactSnapshot(repository.status, after)) {
        return tasks.map(task => ({
          cacheHit: false,
          receipt: unknownReceipt(task.citation, 'graph-stale', observedAt),
        })) satisfies readonly ValidatedCitation[];
      }

      return tasks.map((task, index) => {
        const cachedReceipt = cached[index];
        if (cachedReceipt !== undefined) return {cacheHit: true, receipt: {...cachedReceipt, observedAt}};
        const computedReceipt = computed.get(task)!;
        if (computedReceipt.reason !== 'validation-error') validationCacheSet(cacheKeys[index]!, computedReceipt);
        return {cacheHit: false, receipt: computedReceipt};
      }) satisfies readonly ValidatedCitation[];
    }),
  );
});

export function validateContextBriefFileCitation(
  citation: MemoryCodeCitationV1,
  pathObservation: CodeGraphEffectiveFilePathObservation | undefined,
  relocation: CodeGraphEffectiveFileHashMatches | undefined,
  snapshot: NonNullable<CodeGraphStatus['readySnapshot']>,
  observedAt: string,
  fileInventoryCoverage: CodeGraphEffectiveSnapshotCitationEvidence['fileInventoryCoverage'] = 'incomplete',
): ContextBriefCitationValidationReceiptV2 {
  const result = (
    status: ContextBriefCitationValidationReceiptV2['status'],
    reason: ContextBriefCitationValidationReceiptV2['reason'],
    observation: ReceiptObservation,
  ) => receipt(citation, snapshot, status, reason, observation, observedAt);
  const exactFile = pathObservation?.file;
  if (exactFile?.contentHash === citation.fileContentHash.value) {
    return result('exact', 'exact', {
      candidateCount: 1,
      coverage: 'current-complete',
      observedPath: exactFile.path,
      strategy: 'file-path',
    });
  }
  // An occupied original locator with different bytes is changed. A duplicate
  // elsewhere must never rescue it into a false-fresh relocation.
  if (exactFile) {
    return result('changed', 'source-changed', {
      candidateCount: 1,
      coverage: 'current-complete',
      observedPath: exactFile.path,
      strategy: 'file-path',
    });
  }
  const matches = relocation?.files ?? [];
  if (relocation?.truncated || matches.length > 1) {
    return result('unknown', 'ambiguous-relocation', {
      candidateCount: matches.length,
      coverage: 'current-complete',
      strategy: 'content-hash',
    });
  }
  if (matches.length === 1) {
    return result(
      matches[0]!.path === citation.path ? 'exact' : 'relocated',
      matches[0]!.path === citation.path ? 'exact' : 'relocated',
      {
        candidateCount: 1,
        coverage: 'current-complete',
        observedPath: matches[0]!.path,
        strategy: 'content-hash',
      },
    );
  }
  if (fileInventoryCoverage === 'complete') {
    return result('deleted', 'source-deleted', {
      candidateCount: 0,
      coverage: 'current-complete',
      strategy: 'content-hash',
    });
  }
  // The graph intentionally excludes unsupported/ignored/generated paths, so
  // absence from its inventory is not repository-wide deletion proof.
  return result('unknown', 'graph-incomplete', {
    candidateCount: 0,
    coverage: 'incomplete',
    strategy: 'content-hash',
  });
}

export const validateContextBriefSymbolCitation = Effect.fn('contextBrief.validateSymbolCitation')(function* (
  citation: MemoryCodeCitationV1 & {
    readonly target: Extract<MemoryCodeCitationV1['target'], {readonly kind: 'symbol'}>;
  },
  exactSymbol: CodeGraphSymbol | undefined,
  locatorMatches: CodeGraphEffectiveSymbolLocatorMatches | undefined,
  pathObservation: CodeGraphEffectiveFilePathObservation | undefined,
  relocation: CodeGraphEffectiveFileHashMatches | undefined,
  snapshot: NonNullable<CodeGraphStatus['readySnapshot']>,
  readSource: (
    path: string,
    expectedHash: string,
  ) => Effect.Effect<ReturnType<typeof createCodeGraphSourceSpanCanonicalizer>, unknown, SystemInfo>,
  observedAt: string,
  fileInventoryCoverage: CodeGraphEffectiveSnapshotCitationEvidence['fileInventoryCoverage'] = 'incomplete',
) {
  const result = (
    status: ContextBriefCitationValidationReceiptV2['status'],
    reason: ContextBriefCitationValidationReceiptV2['reason'],
    observation: ReceiptObservation,
  ) => receipt(citation, snapshot, status, reason, observation, observedAt);
  if (snapshot.extractorSet !== citation.extractorSet) {
    return result('unknown', 'extractor-mismatch', {
      candidateCount: 0,
      coverage: 'incomplete',
      strategy: 'none',
    });
  }
  const citedLocator = symbolLocator(citation);
  const observe = Effect.fn('contextBrief.observeSymbolCitationCandidate')(function* (symbol: CodeGraphSymbol) {
    if (!sameSymbolLocator(citedLocator, symbolLocatorFromSymbol(symbol))) return undefined;
    const signatureMatches =
      citation.target.signatureHash === undefined
        ? true
        : symbol.signature !== undefined &&
          (yield* sha256Hex(symbol.signature)) === citation.target.signatureHash.value;
    const source = yield* readSource(symbol.path, symbol.contentHash).pipe(Effect.option);
    if (source._tag === 'None') return undefined;
    const fragment = source.value.fragment(symbol.span);
    if (!fragment.ok) return undefined;
    return {
      fragmentMatches: fragment.fragment.sha256 === citation.target.fragmentHash.value,
      signatureMatches,
      symbol,
    };
  });

  if (exactSymbol) {
    if (!sameSymbolLocator(citedLocator, symbolLocatorFromSymbol(exactSymbol))) {
      return result('unknown', 'validation-error', symbolObservation(exactSymbol, 1, 'incomplete', 'node-id'));
    }
    const exact = yield* observe(exactSymbol);
    if (exact === undefined) {
      return result('unknown', 'validation-error', symbolObservation(exactSymbol, 1, 'incomplete', 'node-id'));
    }
    if (!exact.fragmentMatches || !exact.signatureMatches) {
      return result('changed', 'source-changed', symbolObservation(exactSymbol, 1, 'current-complete', 'node-id'));
    }
    const stayed = exactSymbol.path === citation.path && sameSpan(exactSymbol.span, citation.target.span);
    return result(
      stayed ? 'exact' : 'relocated',
      stayed ? 'exact' : 'relocated',
      symbolObservation(exactSymbol, 1, 'current-complete', 'node-id'),
    );
  }

  const candidates = new Map<string, CodeGraphSymbol>();
  for (const symbol of locatorMatches?.symbols ?? []) candidates.set(symbol.id, symbol);
  const exactFile = pathObservation?.file;
  const originalLocatorCandidates = [...candidates.values()].filter(
    symbol => symbol.path === citation.path && sameSpan(symbol.span, citation.target.span),
  );
  if (originalLocatorCandidates.length === 1) {
    const original = yield* observe(originalLocatorCandidates[0]!);
    if (original === undefined) {
      return result('unknown', 'validation-error', {
        candidateCount: candidates.size,
        coverage: 'incomplete',
        strategy: 'semantic-locator',
      });
    }
    if (!original.fragmentMatches || !original.signatureMatches) {
      return result(
        'changed',
        'source-changed',
        symbolObservation(original.symbol, candidates.size, 'current-complete', 'semantic-locator'),
      );
    }
    const exact = original.symbol.id === citation.target.nodeId;
    return result(
      exact ? 'exact' : 'relocated',
      exact ? 'exact' : 'relocated',
      symbolObservation(original.symbol, candidates.size, 'current-complete', 'semantic-locator'),
    );
  }
  if (originalLocatorCandidates.length > 1) {
    return result('unknown', 'ambiguous-relocation', {
      candidateCount: candidates.size,
      coverage: 'current-complete',
      strategy: 'semantic-locator',
    });
  }
  if (candidates.size > 1 || locatorMatches?.truncated) {
    return result('unknown', 'ambiguous-relocation', {
      candidateCount: candidates.size,
      coverage: 'current-complete',
      strategy: 'semantic-locator',
    });
  }
  const observed: {
    readonly fragmentMatches: boolean;
    readonly signatureMatches: boolean;
    readonly symbol: CodeGraphSymbol;
  }[] = [];
  let readFailed = false;
  for (const symbol of candidates.values()) {
    const observation = yield* observe(symbol);
    if (observation === undefined) readFailed = true;
    else observed.push(observation);
  }
  const matching = observed.filter(item => item.fragmentMatches && item.signatureMatches);
  if (readFailed) {
    return result('unknown', 'validation-error', {
      candidateCount: candidates.size,
      coverage: 'incomplete',
      strategy: 'semantic-locator',
    });
  }
  if (matching.length === 1) {
    const match = matching[0]!.symbol;
    const exact =
      match.id === citation.target.nodeId && match.path === citation.path && sameSpan(match.span, citation.target.span);
    return result(
      exact ? 'exact' : 'relocated',
      exact ? 'exact' : 'relocated',
      symbolObservation(match, 1, 'current-complete', 'semantic-locator'),
    );
  }
  if (observed.length === 1) {
    return result(
      'changed',
      'source-changed',
      symbolObservation(observed[0]!.symbol, 1, 'current-complete', 'semantic-locator'),
    );
  }
  if (exactFile?.contentHash === citation.fileContentHash.value) {
    return result('unknown', 'graph-incomplete', {
      candidateCount: candidates.size,
      coverage: 'incomplete',
      observedPath: exactFile.path,
      strategy: 'file-path',
    });
  }
  if (exactFile) {
    return result('unknown', 'graph-incomplete', {
      candidateCount: 0,
      coverage: 'incomplete',
      observedPath: exactFile.path,
      strategy: 'file-path',
    });
  }
  if (relocation?.truncated || (relocation?.files.length ?? 0) > 0) {
    return result('unknown', 'graph-incomplete', {
      candidateCount: relocation?.files.length ?? 0,
      coverage: 'incomplete',
      strategy: 'content-hash',
    });
  }
  if (fileInventoryCoverage === 'complete') {
    return result('deleted', 'source-deleted', {
      candidateCount: 0,
      coverage: 'current-complete',
      strategy: 'content-hash',
    });
  }
  return result('unknown', 'graph-incomplete', {
    candidateCount: candidates.size,
    coverage: 'incomplete',
    strategy: 'none',
  });
});

function sameSpan(left: CodeGraphSymbol['span'], right: CodeGraphSymbol['span']): boolean {
  return (
    left.line === right.line &&
    left.column === right.column &&
    left.endLine === right.endLine &&
    left.endColumn === right.endColumn
  );
}

function symbolLocator(citation: MemoryCodeCitationV1): CodeGraphSymbolSemanticLocatorV1 {
  if (citation.target.kind !== 'symbol') throw new Error('Symbol locator requires a symbol citation.');
  return {
    kind: citation.target.symbolKind,
    language: citation.target.language,
    name: citation.target.name,
    qualifiedName: citation.target.qualifiedName,
    version: 1,
  };
}

function symbolLocatorFromSymbol(symbol: CodeGraphSymbol): CodeGraphSymbolSemanticLocatorV1 {
  return {
    kind: symbol.kind,
    language: symbol.language,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    version: 1,
  };
}

function sameSymbolLocator(left: CodeGraphSymbolSemanticLocatorV1, right: CodeGraphSymbolSemanticLocatorV1): boolean {
  return locatorKey(left) === locatorKey(right);
}

function locatorKey(locator: CodeGraphSymbolSemanticLocatorV1): string {
  return JSON.stringify([locator.version, locator.language, locator.kind, locator.name, locator.qualifiedName]);
}

interface ReceiptObservation {
  readonly candidateCount: number;
  readonly coverage: ContextBriefCitationValidationReceiptV2['coverage'];
  readonly observedLocator?: ContextBriefCitationValidationReceiptV2['observedLocator'];
  readonly observedNodeId?: string;
  readonly observedPath?: string;
  readonly observedSpan?: CodeGraphSymbol['span'];
  readonly strategy: ContextBriefCitationValidationReceiptV2['strategy'];
}

function symbolObservation(
  symbol: CodeGraphSymbol,
  candidateCount: number,
  coverage: ReceiptObservation['coverage'],
  strategy: ReceiptObservation['strategy'],
): ReceiptObservation {
  return {
    candidateCount,
    coverage,
    observedLocator: symbolLocatorFromSymbol(symbol),
    observedNodeId: symbol.id,
    observedPath: symbol.path,
    observedSpan: symbol.span,
    strategy,
  };
}

function receipt(
  citation: MemoryCodeCitationV1,
  snapshot: NonNullable<CodeGraphStatus['readySnapshot']>,
  status: ContextBriefCitationValidationReceiptV2['status'],
  reason: ContextBriefCitationValidationReceiptV2['reason'],
  observation: ReceiptObservation,
  observedAt: string,
): ContextBriefCitationValidationReceiptV2 {
  return {
    candidateCount: observation.candidateCount,
    citationId: citation.id,
    coverage: observation.coverage,
    kind: citation.target.kind,
    observedAt,
    ...(observation.observedLocator === undefined ? {} : {observedLocator: observation.observedLocator}),
    ...(observation.observedNodeId === undefined ? {} : {observedNodeId: observation.observedNodeId}),
    ...(observation.observedPath === undefined ? {} : {observedPath: observation.observedPath}),
    ...(observation.observedSpan === undefined ? {} : {observedSpan: observation.observedSpan}),
    reason,
    repositoryId: citation.repositoryId,
    snapshotCommit: snapshot.commit,
    ...(snapshot.completedAt === undefined ? {} : {snapshotCompletedAt: snapshot.completedAt}),
    snapshotId: snapshot.id,
    sourcePath: citation.path,
    status,
    strategy: observation.strategy,
    validatorVersion: 1,
  };
}

function unknownReceipt(
  citation: MemoryCodeCitationV1,
  reason: Extract<
    ContextBriefCitationValidationReceiptV2['reason'],
    'citation-limit' | 'graph-stale' | 'repository-ambiguous' | 'repository-unavailable' | 'validation-error'
  >,
  observedAt: string,
): ContextBriefCitationValidationReceiptV2 {
  return {
    candidateCount: 0,
    citationId: citation.id,
    coverage: 'incomplete',
    kind: citation.target.kind,
    observedAt,
    reason,
    repositoryId: citation.repositoryId,
    sourcePath: citation.path,
    status: 'unknown',
    strategy: 'none',
    validatorVersion: 1,
  };
}

const validationScopeTargets = Effect.fn('contextBrief.validationScopeTargets')(function* (
  config: RuntimeConfig,
  scope: ContextBriefScopeV1,
  admittedRepositoryIds: ReadonlySet<string>,
  fence: ContextBriefCitationValidationFenceV2 | undefined,
) {
  if (scope.kind === 'repository') {
    if (fence?.kind === 'workset') {
      return {
        ambiguousRepositoryIds: new Set<string>(),
        targets: [],
        unavailableReason: 'graph-stale',
      } satisfies ValidationScopeResolution;
    }
    return {
      ambiguousRepositoryIds: new Set<string>(),
      ...(fence === undefined ? {} : {requiredSnapshot: fence}),
      targets: [{cwd: scope.callerCwd}],
      unavailableReason: fence === undefined ? 'repository-unavailable' : 'graph-stale',
    } satisfies ValidationScopeResolution;
  }
  const workset = yield* requireWorkset(config.manifestPath, scope.name);
  const published = yield* readPublishedCodeGraphWorksetCatalogGeneration(config.agentContextHome, workset.name).pipe(
    Effect.option,
  );
  const expectedGeneration =
    fence === undefined
      ? undefined
      : fence.kind === 'workset' && fence.workset === workset.name
        ? fence.generation
        : {digest: '', id: ''};
  const route = routeContextBriefWorksetValidation(
    workset,
    published._tag === 'Some' ? published.value : undefined,
    admittedRepositoryIds,
    expectedGeneration,
  );
  const expanded = yield* Effect.forEach(
    route.members,
    member =>
      expandPath(member.projectPath).pipe(
        Effect.map(cwd => ({cwd, expected: member.published}) satisfies ValidationRepositoryTarget),
        Effect.option,
      ),
    {concurrency: VALIDATION_CONCURRENCY},
  );
  return {
    ambiguousRepositoryIds: route.ambiguousRepositoryIds,
    targets: expanded.flatMap(target => (target._tag === 'Some' ? [target.value] : [])),
    unavailableReason: route.stale ? 'graph-stale' : 'repository-unavailable',
    ...(route.generation === undefined ? {} : {worksetGeneration: {...route.generation, workset: workset.name}}),
  } satisfies ValidationScopeResolution;
});

/**
 * Route only cited repositories through one published workset generation.
 * Scanning manifest metadata is cheap; repository discovery/status is bounded
 * by the admitted citation IDs and never fans out across the entire workset.
 */
export function routeContextBriefWorksetValidation(
  workset: ResolvedWorkset,
  published: CodeGraphWorksetCatalogPublishedGenerationV1 | undefined,
  admittedRepositoryIds: ReadonlySet<string>,
  expectedGeneration?: {readonly digest: string; readonly id: string},
): ContextBriefWorksetValidationRoute {
  if (
    published === undefined ||
    published.worksetName !== workset.name ||
    published.manifestDigest !== codeGraphWorksetManifestDigest(workset) ||
    (expectedGeneration !== undefined &&
      (published.id !== expectedGeneration.id || published.digest !== expectedGeneration.digest))
  ) {
    return {ambiguousRepositoryIds: new Set<string>(), members: [], stale: true};
  }
  const projectsByKey = new Map(workset.projects.map(project => [worksetRepositoryKey(project.name), project]));
  const routedByRepository = new Map<
    string,
    {readonly projectPath: string; readonly published: CodeGraphWorksetCatalogPublishedMemberV1}[]
  >();
  for (const member of published.members) {
    if (!admittedRepositoryIds.has(member.repositoryId)) continue;
    const project = projectsByKey.get(member.repositoryKey);
    if (project === undefined) continue;
    const routes = routedByRepository.get(member.repositoryId) ?? [];
    routes.push({projectPath: project.path, published: member});
    routedByRepository.set(member.repositoryId, routes);
  }
  const ambiguousRepositoryIds = new Set<string>();
  const members: Array<{
    readonly projectPath: string;
    readonly published: CodeGraphWorksetCatalogPublishedMemberV1;
  }> = [];
  for (const repositoryId of admittedRepositoryIds) {
    const routes = routedByRepository.get(repositoryId) ?? [];
    if (routes.length > 1) ambiguousRepositoryIds.add(repositoryId);
    else if (routes.length === 1) members.push(routes[0]!);
  }
  return {
    ambiguousRepositoryIds,
    generation: {digest: published.digest, id: published.id},
    members,
    stale: false,
  };
}

const worksetGenerationIsStillPublished = Effect.fn('contextBrief.worksetGenerationStillPublished')(function* (
  config: RuntimeConfig,
  expected: {readonly digest: string; readonly id: string; readonly workset: string},
) {
  const published = yield* readPublishedCodeGraphWorksetCatalogGeneration(
    config.agentContextHome,
    expected.workset,
  ).pipe(Effect.option);
  return (
    published._tag === 'Some' && published.value?.id === expected.id && published.value?.digest === expected.digest
  );
});

function worksetRepositoryKey(value: string): string {
  const normalized = value.replace(/[\r\n\t\0]/gu, ' ').trim();
  return normalized.slice(0, 256) || 'unknown';
}

function sameExactSnapshot(before: CodeGraphStatus, after: CodeGraphStatus): boolean {
  return (
    !after.stale &&
    after.freshness === 'current' &&
    before.databasePath === after.databasePath &&
    before.identity.repositoryId === after.identity.repositoryId &&
    before.identity.worktreeId === after.identity.worktreeId &&
    before.readySnapshot?.id === after.readySnapshot?.id
  );
}

function validationCacheKey(status: CodeGraphStatus, snapshotId: string, citationId: string): string {
  return `${status.identity.repositoryId}\u0000${status.identity.worktreeId}\u0000${snapshotId}\u0000${citationId}`;
}

function validationCacheGet(key: string): ContextBriefCitationValidationReceiptV2 | undefined {
  const cached = validationReceiptCache.get(key);
  if (cached === undefined) return undefined;
  validationReceiptCache.delete(key);
  validationReceiptCache.set(key, cached);
  return cached;
}

function validationCacheSet(key: string, receipt: ContextBriefCitationValidationReceiptV2): void {
  validationReceiptCache.delete(key);
  validationReceiptCache.set(key, receipt);
  while (validationReceiptCache.size > VALIDATION_CACHE_LIMIT) {
    const oldest = validationReceiptCache.keys().next().value;
    if (oldest === undefined) break;
    validationReceiptCache.delete(oldest);
  }
}
