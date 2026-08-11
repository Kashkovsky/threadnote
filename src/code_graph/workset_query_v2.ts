// oxlint-disable effecttsgo/lazy-effect -- Injected functions construct fresh clock and routing effects per invocation.
import {Clock, Effect, FileSystem} from 'effect';
import {readSeedManifest, requireWorkset} from '../manifest.js';
import type {ProjectManifest, RuntimeConfig} from '../types.js';
import {expandPath} from '../utils.js';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from './query.js';
import type {CodeGraphQueryResult, CodeGraphStatus, RepositoryIdentityExpectation} from './types.js';
import {
  attachCodeGraphWorksetBridgeRelationships,
  expandCodeGraphWorksetRouterWithBridges,
  materializeCodeGraphWorksetBridgeEndpointCards,
  mergeCodeGraphWorksetBridgeEndpointCards,
  readCodeGraphWorksetQueryBridgeExpansion,
  type CodeGraphWorksetQueryBridgeExpansionV1,
} from './cross_repository/query_expansion.js';
import type {CodeGraphCrossRepositoryBridgeV1} from './cross_repository/resolver.js';
import {makeCodeGraphWorksetCatalogCandidateSource} from './workset_catalog/candidate_source.js';
import {
  readCodeGraphWorksetResultSetPage,
  readPublishedCodeGraphWorksetCatalogGeneration,
  registerCodeGraphQualifiedRef,
  registerCodeGraphWorksetResultSet,
  resolveCodeGraphQualifiedRef,
} from './workset_catalog/store.js';
import {
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogPublishedGenerationV1,
  type CodeGraphWorksetCatalogPublishedMemberV1,
  type CodeGraphWorksetResultSetRegistrationV1,
} from './workset_catalog/types.js';
import {codeGraphWorksetCatalogGenerationMatches, codeGraphWorksetManifestDigest} from './workset_catalog/workset.js';
import {
  CODE_GRAPH_WORKSET_EVIDENCE_DEFAULT_ESTIMATED_TOKENS,
  CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
  codeGraphQualifiedRefHandle,
  isCodeGraphQualifiedRefHandle,
  projectCodeGraphWorksetEvidence,
  type CodeGraphWorksetQueryResultV2,
  type ProjectedCodeGraphWorksetEvidenceV1,
  type QualifiedCodeGraphRefV1,
  type RepositoryEvidenceReceiptV1,
  type WorksetCoverageV2,
} from './workset_evidence.js';
import {
  CODE_GRAPH_WORKSET_EXPANSION_SCHEDULE,
  selectCodeGraphWorksetAdaptiveExpansionBatch,
} from './workset_expansion.js';
import {rankCodeGraphWorksetEvidenceCards} from './workset_rank.js';
import {
  routeCodeGraphWorksetCatalogCandidates,
  type CodeGraphWorksetRouterRepositoryCandidateV1,
  type CodeGraphWorksetRouterResultV1,
} from './workset_router.js';

export const CODE_GRAPH_WORKSET_QUERY_V2_VERSION = 1 as const;

const DEFAULT_DEADLINE_MILLISECONDS = 3_000;
const MAXIMUM_DEADLINE_MILLISECONDS = 60_000;
// Logical cross-repository breadth is independent of both each repository's
// local node limit and the compact first-page transport projection.
const DEFAULT_EVIDENCE_CARDS = 40;
const MAXIMUM_EVIDENCE_CARDS = 512;
const DEFAULT_LOCAL_NODE_LIMIT = 20;
const DEFAULT_LOCAL_EDGE_LIMIT = 40;

export interface CodeGraphWorksetQueryV2MemberV1 {
  readonly deepQueryEligible: boolean;
  readonly published?: CodeGraphWorksetCatalogPublishedMemberV1;
  readonly receipt: RepositoryEvidenceReceiptV1;
  readonly repositoryKey: string;
}

export interface CodeGraphWorksetQueryV2InputV1 {
  readonly deadlineMilliseconds?: number;
  readonly depth?: number;
  readonly edgeLimit?: number;
  readonly evidenceCards?: number;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly maximumEstimatedTokens?: number;
  readonly members: readonly CodeGraphWorksetQueryV2MemberV1[];
  readonly nodeLimit?: number;
  readonly packageName?: string;
  readonly published: CodeGraphWorksetCatalogPublishedGenerationV1;
  readonly query: string;
  readonly worksetName: string;
}

export interface CodeGraphWorksetQueryV2InstrumentationV1 {
  readonly bridgeEdgesConsidered: number;
  readonly bridgeExpandedRepositories: number;
  readonly bridgeExpansionComplete: boolean;
  readonly cards: number;
  readonly databasesOpened: number;
  readonly deepQueryFailures: number;
  readonly deepQueriedRepositories: number;
  readonly expansionBatches: number;
  readonly relationships: number;
  readonly repositoriesConsidered: number;
  readonly responseStructuredBytes: number;
  readonly responseTextBytes: number;
  readonly responseTotalBytes: number;
  readonly version: typeof CODE_GRAPH_WORKSET_QUERY_V2_VERSION;
}

export interface CodeGraphWorksetQueryV2ExecutionV1 {
  readonly instrumentation: CodeGraphWorksetQueryV2InstrumentationV1;
  readonly logicalResult: CodeGraphWorksetQueryResultV2;
  readonly projected: ProjectedCodeGraphWorksetEvidenceV1;
}

export interface CodeGraphWorksetQueryV2DependenciesV1<R = never> {
  readonly deepQuery: (
    repository: CodeGraphWorksetRouterRepositoryCandidateV1,
  ) => Effect.Effect<CodeGraphQueryResult, unknown, R>;
  readonly nowMilliseconds: () => Effect.Effect<number, unknown, R>;
  readonly persist: (
    result: CodeGraphWorksetQueryResultV2,
    qualifiedRefs: readonly QualifiedCodeGraphRefV1[],
  ) => Effect.Effect<CodeGraphWorksetResultSetRegistrationV1, unknown, R>;
  readonly readBridgeExpansion: (
    router: CodeGraphWorksetRouterResultV1,
  ) => Effect.Effect<CodeGraphWorksetQueryBridgeExpansionV1, unknown, R>;
  readonly route: () => Effect.Effect<CodeGraphWorksetRouterResultV1, unknown, R>;
}

interface CodeGraphWorksetQueryV2TimingV1 {
  readonly startedAtMilliseconds?: number;
}

export interface QueryCodeGraphWorksetV2OptionsV1 {
  readonly deadlineMilliseconds?: number;
  readonly depth?: number;
  readonly edgeLimit?: number;
  readonly evidenceCards?: number;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly maximumEstimatedTokens?: number;
  readonly nodeLimit?: number;
  readonly packageName?: string;
  readonly query: string;
  readonly worksetName: string;
}

export interface ContinueCodeGraphWorksetV2OptionsV1 {
  readonly cursor: string;
  readonly maximumEstimatedTokens?: number;
}

export interface ResolvedCodeGraphQualifiedRefTargetV1 {
  readonly cwd: string;
  readonly nodeId: string;
  readonly ref: string;
  readonly repositoryId: string;
  readonly status: CodeGraphStatus;
}

/**
 * Run the deterministic Workset Search 2.0 orchestration against injected
 * routing, deep-read, and persistence boundaries. None of these boundaries is
 * allowed to attach, index, or otherwise mutate a repository graph.
 */
export const runCodeGraphWorksetQueryV2Core = Effect.fn('codeGraphWorksetV2.runCore')(function* <R>(
  dependencies: CodeGraphWorksetQueryV2DependenciesV1<R>,
  input: CodeGraphWorksetQueryV2InputV1,
  timing: CodeGraphWorksetQueryV2TimingV1 = {},
) {
  const prepared = validateCoreInput(input);
  const observedStarted = yield* dependencies.nowMilliseconds();
  const requestedStarted = timing.startedAtMilliseconds;
  if (requestedStarted !== undefined && (!Number.isSafeInteger(requestedStarted) || requestedStarted < 0)) {
    throw new Error('The deadline clock origin is invalid.');
  }
  const started = Math.min(observedStarted, requestedStarted ?? observedStarted);
  const catalogRouter = yield* dependencies.route();
  validateRouterReceipt(prepared, catalogRouter);
  const bridgeExpansion = yield* dependencies.readBridgeExpansion(catalogRouter);
  const router = expandCodeGraphWorksetRouterWithBridges(catalogRouter, prepared.published, bridgeExpansion);

  const membersByKey = new Map(prepared.members.map(member => [member.repositoryKey, member]));
  const selectedRepositoryKeys = new Set<string>();
  const attemptedRepositoryKeys = new Set<string>();
  const failures = new Set<string>();
  const successful = new Map<string, CodeGraphQueryResult>();
  let expansionBatches = 0;
  let phase = 0;
  let stopReason: WorksetCoverageV2['stopReason'] = 'exhaustion';

  for (;;) {
    const now = yield* dependencies.nowMilliseconds();
    const remainingMilliseconds = Math.max(0, prepared.deadlineMilliseconds - Math.max(0, now - started));
    const expansion = selectCodeGraphWorksetAdaptiveExpansionBatch({
      alreadySelectedRepositoryKeys: selectedRepositoryKeys,
      phase,
      remainingMilliseconds,
      repositories: router.repositories,
    });
    if (expansion.stopReason !== 'continue') {
      stopReason =
        expansion.stopReason === 'deadline' || expansion.stopReason === 'cancelled' ? 'deadline' : 'exhaustion';
      break;
    }
    expansionBatches += 1;
    for (const repository of expansion.repositories) selectedRepositoryKeys.add(repository.repositoryKey);
    const outcomes = yield* Effect.forEach(
      expansion.repositories,
      (repository): Effect.Effect<DeepQueryOutcome, unknown, R> => {
        const member = membersByKey.get(repository.repositoryKey);
        if (member === undefined || !member.deepQueryEligible || member.published === undefined) {
          return Effect.succeed({repository, state: 'skipped' as const});
        }
        return Effect.gen(function* () {
          const taskStarted = yield* dependencies.nowMilliseconds();
          const taskRemaining = Math.max(0, prepared.deadlineMilliseconds - Math.max(0, taskStarted - started));
          if (taskRemaining === 0) return {repository, state: 'timed-out' as const};
          attemptedRepositoryKeys.add(repository.repositoryKey);
          return yield* dependencies.deepQuery(repository).pipe(
            Effect.map(graph => ({graph, repository, state: 'ready' as const})),
            Effect.catch(() => Effect.succeed({repository, state: 'failed' as const})),
            Effect.timeoutOrElse({
              duration: taskRemaining,
              orElse: () => Effect.succeed({repository, state: 'timed-out' as const}),
            }),
          );
        });
      },
      {concurrency: expansion.concurrency},
    );
    const batchTimedOut = outcomes.some(outcome => outcome.state === 'timed-out');
    for (const outcome of outcomes) {
      if (outcome.state === 'ready') {
        validateDeepQueryResult(membersByKey.get(outcome.repository.repositoryKey), outcome.repository, outcome.graph);
        successful.set(outcome.repository.repositoryKey, outcome.graph);
      } else if (outcome.state === 'failed') {
        failures.add(outcome.repository.repositoryKey);
      }
    }

    if (batchTimedOut) {
      stopReason = 'deadline';
      break;
    }

    const afterBatch = yield* dependencies.nowMilliseconds();
    if (Math.max(0, afterBatch - started) >= prepared.deadlineMilliseconds) {
      stopReason = 'deadline';
      break;
    }

    const cards = rankSuccessfulResults(router, successful, MAXIMUM_EVIDENCE_CARDS);
    const remainingCandidates = router.repositories.length - selectedRepositoryKeys.size;
    if (cards.length > 0) {
      // Ambiguity gets one validation expansion (4 + 4 repositories). That is
      // the default deep-read work budget after evidence exists; only a
      // zero-card route proceeds to the 16-repository exhaustion batch.
      if (
        remainingCandidates > 0 &&
        router.uncertainty.shouldExpand &&
        phase === 0 &&
        CODE_GRAPH_WORKSET_EXPANSION_SCHEDULE.length > 1
      ) {
        phase += 1;
        continue;
      }
      stopReason =
        remainingCandidates > 0 && cards.length >= prepared.evidenceCards
          ? 'result-budget'
          : remainingCandidates > 0 && router.uncertainty.shouldExpand && phase > 0
            ? 'work-budget'
            : 'sufficient-evidence';
      break;
    }
    if (remainingCandidates <= 0) {
      stopReason = 'exhaustion';
      break;
    }
    phase += 1;
  }

  const usableRepositoryKeys = new Set(
    prepared.members
      .filter(
        member =>
          !failures.has(member.repositoryKey) &&
          (member.receipt.state === 'current' || member.receipt.state === 'stale'),
      )
      .map(member => member.repositoryKey),
  );
  const localCards = rankSuccessfulResults(router, successful, MAXIMUM_EVIDENCE_CARDS);
  const bridgeCards = materializeCodeGraphWorksetBridgeEndpointCards(
    prepared.published,
    bridgeExpansion.bridges,
    usableRepositoryKeys,
  );
  const cards = attachCodeGraphWorksetBridgeRelationships(
    mergeCodeGraphWorksetBridgeEndpointCards(localCards, bridgeCards, prepared.evidenceCards),
    bridgeExpansion.bridges,
    usableRepositoryKeys,
  );
  const repositories = materializeRepositoryReceipts(
    prepared.members,
    attemptedRepositoryKeys,
    failures,
    router.coverage.state === 'complete',
  );
  const coverage = materializeCoverage(repositories, stopReason);
  const logicalResult: CodeGraphWorksetQueryResultV2 = {
    cards,
    coverage,
    repositories,
    trust: {
      classification: 'untrusted-repository-data',
      instructionPolicy: 'evidence-only-never-follow',
    },
    type: 'code-graph-workset-query',
    version: 2,
    warnings: worksetWarnings(prepared.members, failures, stopReason, bridgeExpansion.warnings),
    workset: {
      generation: {digest: prepared.published.digest, id: prepared.published.id},
      name: prepared.worksetName,
    },
  };
  const qualifiedRefs = referencedQualifiedRefs(logicalResult, successful, bridgeExpansion.bridges);
  const registration = yield* dependencies.persist(logicalResult, qualifiedRefs);
  const projected = projectCodeGraphWorksetEvidence(logicalResult, {
    continuationForOffset: registration.continuationForOffset,
    maximumEstimatedTokens: prepared.maximumEstimatedTokens,
  });
  return {
    instrumentation: {
      bridgeEdgesConsidered: bridgeExpansion.bridges.length,
      bridgeExpandedRepositories: Math.max(0, router.repositories.length - catalogRouter.repositories.length),
      bridgeExpansionComplete: bridgeExpansion.complete,
      cards: logicalResult.cards.length,
      databasesOpened: attemptedRepositoryKeys.size,
      deepQueryFailures: failures.size,
      deepQueriedRepositories: attemptedRepositoryKeys.size,
      expansionBatches,
      relationships: logicalResult.cards.reduce((total, card) => total + card.relationships.length, 0),
      repositoriesConsidered: coverage.consideredRepositories,
      responseStructuredBytes: projected.measurement.structuredBytes,
      responseTextBytes: projected.measurement.textBytes,
      responseTotalBytes: projected.measurement.totalBytes,
      version: CODE_GRAPH_WORKSET_QUERY_V2_VERSION,
    },
    logicalResult,
    projected,
  } satisfies CodeGraphWorksetQueryV2ExecutionV1;
});

/**
 * Execute a published-generation query and retain privacy-safe instrumentation
 * for evaluation. This path observes statuses and performs read-only deep
 * queries only.
 */
export const executeCodeGraphWorksetV2 = Effect.fn('codeGraphWorksetV2.execute')(function* (
  config: RuntimeConfig,
  options: QueryCodeGraphWorksetV2OptionsV1,
) {
  const deadlineStartedAtMilliseconds = yield* Clock.currentTimeMillis;
  const deadlineMilliseconds = validateDeadlineMilliseconds(options.deadlineMilliseconds);
  const queryService = yield* CodeGraphQueryService;
  const runtime = yield* prepareRuntimeQuery(config, {...options, deadlineMilliseconds}, queryService);
  const source = yield* makeCodeGraphWorksetCatalogCandidateSource(config.agentContextHome);
  const execution = yield* runCodeGraphWorksetQueryV2Core(
    {
      deepQuery: repository => {
        const member = runtime.deepMembers.get(repository.repositoryKey);
        if (member === undefined)
          return Effect.fail(
            new CodeGraphWorksetCatalogError('missing', 'The routed repository has no validated ready snapshot.'),
          );
        return queryService.inspect({
          cwd: member.cwd,
          depth: options.depth,
          edgeLimit: options.edgeLimit ?? DEFAULT_LOCAL_EDGE_LIMIT,
          includeHeuristic: options.includeHeuristic,
          includeModelAssociations: options.includeModelAssociations,
          nodeLimit: options.nodeLimit ?? DEFAULT_LOCAL_NODE_LIMIT,
          operation: 'query',
          packageName: options.packageName,
          query: options.query,
          refresh: false,
          requestMaintenance: false,
          statusObservation: observationFromCodeGraphStatus(member.status),
          strictFreshness: false,
          threadnoteHome: config.agentContextHome,
        });
      },
      nowMilliseconds: () => Clock.currentTimeMillis,
      persist: (result, qualifiedRefs) =>
        Effect.gen(function* () {
          yield* Effect.forEach(qualifiedRefs, ref => registerCodeGraphQualifiedRef(config.agentContextHome, ref), {
            concurrency: 1,
            discard: true,
          });
          return yield* registerCodeGraphWorksetResultSet(config.agentContextHome, {
            projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
            result,
          });
        }),
      readBridgeExpansion: router =>
        readCodeGraphWorksetQueryBridgeExpansion(config.agentContextHome, runtime.input.published, router).pipe(
          Effect.catch(() =>
            Effect.succeed({
              bridges: [],
              complete: false,
              seededRepositories: Math.min(16, router.repositories.length),
              warnings: ['Cross-repository contract-neighbor expansion was unavailable for this query.'],
            } satisfies CodeGraphWorksetQueryBridgeExpansionV1),
          ),
        ),
      route: () =>
        routeCodeGraphWorksetCatalogCandidates(source, {
          limits: {repositoryLimit: Math.min(512, Math.max(64, runtime.input.members.length))},
          query: options.query,
          worksetName: runtime.input.worksetName,
        }),
    },
    runtime.input,
    {startedAtMilliseconds: deadlineStartedAtMilliseconds},
  );
  return execution;
});

/** Query a published generation through the compact agent transport projection. */
export const queryCodeGraphWorksetV2 = Effect.fn('codeGraphWorksetV2.query')(function* (
  config: RuntimeConfig,
  options: QueryCodeGraphWorksetV2OptionsV1,
) {
  const execution = yield* executeCodeGraphWorksetV2(config, options);
  return execution.projected;
});

/** Continue only from the pinned result sequence; routing and repository reads are deliberately absent. */
export const continueCodeGraphWorksetQueryV2 = Effect.fn('codeGraphWorksetV2.continue')(function* (
  config: RuntimeConfig,
  options: ContinueCodeGraphWorksetV2OptionsV1,
) {
  const page = yield* readCodeGraphWorksetResultSetPage(config.agentContextHome, {
    cursor: options.cursor,
    expectedProjectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
    limit: 128,
  });
  return projectCodeGraphWorksetEvidence(page.result, {
    continuationForOffset: page.continuationForOffset,
    continuationOffsetBase: page.offset,
    maximumEstimatedTokens: options.maximumEstimatedTokens,
    totalCards: page.totalCards - page.offset,
  });
});

/**
 * Resolve a cgr_ handle to one configured ready worktree without attaching or
 * building a graph. A caller-scoped matching worktree wins; otherwise sibling
 * worktrees remain an explicit ambiguity instead of leaking evidence.
 */
export const resolveCodeGraphQualifiedRefTarget = Effect.fn('codeGraphWorksetV2.resolveQualifiedRefTarget')(function* (
  config: RuntimeConfig,
  ref: string,
  callerCwd?: string,
) {
  if (!isCodeGraphQualifiedRefHandle(ref)) throw new Error('Qualified code graph reference is invalid.');
  const record = yield* resolveCodeGraphQualifiedRef(config.agentContextHome, {ref});
  const fs = yield* FileSystem.FileSystem;
  const queryService = yield* CodeGraphQueryService;
  const manifest = yield* readSeedManifest(config.manifestPath);
  const orderedPaths = [
    ...(callerCwd === undefined ? [] : [yield* expandPath(callerCwd)]),
    ...manifest.projects.map(project => project.path),
  ];
  const uniquePaths: string[] = [];
  const seenPaths = new Set<string>();
  for (const candidate of orderedPaths) {
    const cwd = yield* expandPath(candidate);
    if (seenPaths.has(cwd)) continue;
    seenPaths.add(cwd);
    uniquePaths.push(cwd);
  }
  const matches = yield* Effect.forEach(
    uniquePaths,
    cwd =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(cwd))) return undefined;
        const status = yield* queryService.status(config.agentContextHome, cwd, {requestMaintenance: false});
        return status.identity.repositoryId === record.repositoryId && status.readySnapshot !== undefined
          ? ({cwd, status} as const)
          : undefined;
      }).pipe(Effect.catch(() => Effect.succeed(undefined))),
    {concurrency: 4},
  );
  const available = matches.filter((value): value is NonNullable<typeof value> => value !== undefined);
  const caller = callerCwd === undefined ? undefined : yield* expandPath(callerCwd);
  const selected =
    available.find(candidate => candidate.cwd === caller) ?? (available.length === 1 ? available[0] : undefined);
  if (selected === undefined) {
    throw new Error(
      available.length === 0
        ? 'The qualified graph reference repository has no configured ready worktree.'
        : 'The qualified graph reference matches multiple worktrees; pass --cwd for the intended sibling.',
    );
  }
  return {
    cwd: selected.cwd,
    nodeId: record.nodeId,
    ref: record.ref,
    repositoryId: record.repositoryId,
    status: selected.status,
  } satisfies ResolvedCodeGraphQualifiedRefTargetV1;
});

interface PreparedCoreInput extends CodeGraphWorksetQueryV2InputV1 {
  readonly deadlineMilliseconds: number;
  readonly evidenceCards: number;
  readonly maximumEstimatedTokens: number;
}

type DeepQueryOutcome =
  | {
      readonly graph: CodeGraphQueryResult;
      readonly repository: CodeGraphWorksetRouterRepositoryCandidateV1;
      readonly state: 'ready';
    }
  | {
      readonly repository: CodeGraphWorksetRouterRepositoryCandidateV1;
      readonly state: 'failed' | 'skipped' | 'timed-out';
    };

function validateCoreInput(input: CodeGraphWorksetQueryV2InputV1): PreparedCoreInput {
  const query = boundedText(input.query, 'query', 4_096);
  const worksetName = boundedText(input.worksetName, 'workset name', 256);
  if (input.published.worksetName !== worksetName) throw new Error('Published generation belongs to another workset.');
  const members = [...input.members].sort((left, right) => compareText(left.repositoryKey, right.repositoryKey));
  const keys = new Set<string>();
  for (const member of members) {
    boundedText(member.repositoryKey, 'repository key', 256);
    if (keys.has(member.repositoryKey)) throw new Error(`Workset member ${member.repositoryKey} is duplicated.`);
    keys.add(member.repositoryKey);
    if (member.published !== undefined && member.published.repositoryKey !== member.repositoryKey) {
      throw new Error('Workset member publication key is inconsistent.');
    }
  }
  return {
    ...input,
    deadlineMilliseconds: validateDeadlineMilliseconds(input.deadlineMilliseconds),
    evidenceCards: boundedInteger(
      input.evidenceCards ?? DEFAULT_EVIDENCE_CARDS,
      'evidence card count',
      1,
      MAXIMUM_EVIDENCE_CARDS,
    ),
    maximumEstimatedTokens: input.maximumEstimatedTokens ?? CODE_GRAPH_WORKSET_EVIDENCE_DEFAULT_ESTIMATED_TOKENS,
    members,
    query,
    worksetName,
  };
}

function validateDeadlineMilliseconds(value: number | undefined): number {
  return boundedInteger(value ?? DEFAULT_DEADLINE_MILLISECONDS, 'deadline', 1, MAXIMUM_DEADLINE_MILLISECONDS);
}

function validateRouterReceipt(input: PreparedCoreInput, router: CodeGraphWorksetRouterResultV1): void {
  if (router.worksetName !== input.worksetName || router.generationId !== input.published.id) {
    throw new Error('Workset router result does not belong to the fenced published generation.');
  }
  if (router.coverage.state !== 'complete') throw new Error('Production workset routing coverage is partial.');
  if (router.coverage.eligibleMemberCount !== input.published.members.length) {
    throw new Error('Workset router eligible-member coverage does not match the published generation.');
  }
}

function validateDeepQueryResult(
  member: CodeGraphWorksetQueryV2MemberV1 | undefined,
  routed: CodeGraphWorksetRouterRepositoryCandidateV1,
  graph: CodeGraphQueryResult,
): void {
  const published = member?.published;
  if (
    member === undefined ||
    published === undefined ||
    graph.repository.repositoryId !== routed.repositoryId ||
    graph.repository.repositoryId !== published.repositoryId ||
    graph.snapshot.id !== routed.snapshotId ||
    graph.snapshot.id !== published.snapshotId ||
    graph.snapshot.worktreeId !== published.worktreeId ||
    graph.snapshot.commit !== published.commitId
  ) {
    throw new Error(`Deep-query provenance for ${routed.repositoryKey} does not match the published generation.`);
  }
}

function rankSuccessfulResults(
  router: CodeGraphWorksetRouterResultV1,
  successful: ReadonlyMap<string, CodeGraphQueryResult>,
  maximumCards: number,
) {
  return rankCodeGraphWorksetEvidenceCards({
    maximumCards,
    repositories: router.repositories.flatMap(repository => {
      const graph = successful.get(repository.repositoryKey);
      return graph === undefined ? [] : [{graph, repositoryKey: repository.repositoryKey}];
    }),
    router,
  });
}

function materializeRepositoryReceipts(
  members: readonly CodeGraphWorksetQueryV2MemberV1[],
  attempted: ReadonlySet<string>,
  failures: ReadonlySet<string>,
  routingComplete: boolean,
): Readonly<Record<string, RepositoryEvidenceReceiptV1>> {
  return Object.fromEntries(
    members.map(member => {
      const failed = failures.has(member.repositoryKey);
      const snapshot = member.receipt.snapshot;
      const considered = routingComplete && snapshot !== undefined;
      return [
        member.repositoryKey,
        {
          considered,
          deepQueried: attempted.has(member.repositoryKey),
          repositoryId: member.receipt.repositoryId,
          ...(snapshot === undefined ? {} : {snapshot}),
          state: failed ? 'failed' : member.receipt.state,
        } satisfies RepositoryEvidenceReceiptV1,
      ];
    }),
  );
}

function materializeCoverage(
  repositories: Readonly<Record<string, RepositoryEvidenceReceiptV1>>,
  stopReason: WorksetCoverageV2['stopReason'],
): WorksetCoverageV2 {
  const receipts = Object.values(repositories);
  const states = {
    current: receipts.filter(receipt => receipt.state === 'current').length,
    deferred: receipts.filter(receipt => receipt.state === 'deferred').length,
    excluded: receipts.filter(receipt => receipt.state === 'excluded').length,
    failed: receipts.filter(receipt => receipt.state === 'failed').length,
    missing: receipts.filter(receipt => receipt.state === 'missing').length,
    stale: receipts.filter(receipt => receipt.state === 'stale').length,
  };
  const cataloguedRepositories = receipts.filter(receipt => receipt.snapshot !== undefined).length;
  const consideredRepositories = receipts.filter(receipt => receipt.considered).length;
  return {
    cataloguedRepositories,
    complete: cataloguedRepositories === consideredRepositories,
    consideredRepositories,
    deepQueriedRepositories: receipts.filter(receipt => receipt.deepQueried).length,
    requestedRepositories: receipts.length,
    states,
    stopReason,
  };
}

function worksetWarnings(
  members: readonly CodeGraphWorksetQueryV2MemberV1[],
  failures: ReadonlySet<string>,
  stopReason: WorksetCoverageV2['stopReason'],
  bridgeWarnings: readonly string[],
): readonly string[] {
  return [
    ...(members.some(member => member.receipt.state !== 'current')
      ? ['One or more workset members are not current in the published generation.']
      : []),
    ...(failures.size > 0 ? [`${failures.size} repository deep read${failures.size === 1 ? '' : 's'} failed.`] : []),
    ...(stopReason === 'deadline' ? ['The workset query stopped at its read deadline.'] : []),
    ...(stopReason === 'work-budget'
      ? ['The workset query stopped after its bounded ambiguity-validation work budget.']
      : []),
    ...bridgeWarnings,
  ];
}

function referencedQualifiedRefs(
  result: CodeGraphWorksetQueryResultV2,
  successful: ReadonlyMap<string, CodeGraphQueryResult>,
  bridges: readonly CodeGraphCrossRepositoryBridgeV1[],
): readonly QualifiedCodeGraphRefV1[] {
  const candidates = new Map<string, QualifiedCodeGraphRefV1>();
  for (const graph of successful.values()) {
    const repositoryId = graph.repository.repositoryId;
    for (const node of graph.nodes) registerQualifiedCandidate(candidates, {nodeId: node.id, repositoryId});
    for (const edge of graph.edges) {
      if (edge.sourceId !== undefined) registerQualifiedCandidate(candidates, {nodeId: edge.sourceId, repositoryId});
      if (edge.targetId !== undefined) registerQualifiedCandidate(candidates, {nodeId: edge.targetId, repositoryId});
    }
  }
  const required = new Set<string>();
  const preparedBridgeRefs = new Set(
    bridges.flatMap(bridge =>
      [bridge.source.reference, bridge.target.reference].flatMap(reference =>
        reference.kind === 'qualified-ref' ? [reference.ref] : [],
      ),
    ),
  );
  for (const card of result.cards) {
    required.add(card.ref);
    for (const relationship of card.relationships) {
      required.add(relationship.source.ref);
      required.add(relationship.target.ref);
    }
  }
  return [...required].sort(compareText).flatMap(ref => {
    const candidate = candidates.get(ref);
    if (candidate !== undefined) return [candidate];
    // Protobuf bridge refs are registered from canonical monikers before the
    // generation pointer is published. Result-set persistence revalidates the
    // registry row; no node identity is reconstructed from an opaque handle.
    if (preparedBridgeRefs.has(ref)) return [];
    throw new Error(`Qualified reference ${ref} lacks exact repository/node evidence.`);
  });
}

function registerQualifiedCandidate(
  candidates: Map<string, QualifiedCodeGraphRefV1>,
  candidate: QualifiedCodeGraphRefV1,
): void {
  const ref = codeGraphQualifiedRefHandle(candidate);
  const existing = candidates.get(ref);
  if (
    existing !== undefined &&
    (existing.repositoryId !== candidate.repositoryId || existing.nodeId !== candidate.nodeId)
  ) {
    throw new Error('Qualified code graph reference collision detected.');
  }
  candidates.set(ref, candidate);
}

interface RuntimeDeepMember {
  readonly cwd: string;
  readonly status: CodeGraphStatus;
}

interface RuntimeQueryStatusService {
  readonly status: (
    threadnoteHome: string,
    cwd: string,
    options?: {readonly requestMaintenance?: boolean},
  ) => Effect.Effect<CodeGraphStatus, unknown>;
  readonly statusForPublishedIdentity: (
    threadnoteHome: string,
    cwd: string,
    expected: RepositoryIdentityExpectation,
    options?: {readonly requestMaintenance?: boolean},
  ) => Effect.Effect<CodeGraphStatus, unknown>;
}

function prepareRuntimeQuery(
  config: RuntimeConfig,
  options: QueryCodeGraphWorksetV2OptionsV1,
  queryService: RuntimeQueryStatusService,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workset = yield* requireWorkset(config.manifestPath, options.worksetName);
    const manifestDigest = codeGraphWorksetManifestDigest(workset);
    const published = yield* readPublishedCodeGraphWorksetCatalogGeneration(config.agentContextHome, workset.name);
    if (published === undefined) {
      return yield* Effect.fail(
        new CodeGraphWorksetCatalogError(
          'missing',
          `No published routing catalog exists for ${workset.name}; run \`threadnote workset prepare ${workset.name}\`.`,
        ),
      );
    }
    if (!codeGraphWorksetCatalogGenerationMatches(workset, manifestDigest, published)) {
      return yield* Effect.fail(
        new CodeGraphWorksetCatalogError(
          'stale',
          `The published routing catalog for ${workset.name} is stale; run \`threadnote workset prepare ${workset.name}\`.`,
        ),
      );
    }
    const publishedByKey = new Map(published.members.map(member => [member.repositoryKey, member]));
    const observed = yield* Effect.forEach(
      workset.projects,
      project => observeRuntimeMember(config, project, publishedByKey.get(safeLabel(project.name)), fs, queryService),
      {concurrency: 8},
    );
    const members = observed.map(value => value.member);
    const deepMembers = new Map(
      observed.flatMap(value =>
        'deep' in value && value.deep !== undefined ? [[value.member.repositoryKey, value.deep] as const] : [],
      ),
    );
    return {
      deepMembers,
      input: {
        deadlineMilliseconds: options.deadlineMilliseconds,
        depth: options.depth,
        edgeLimit: options.edgeLimit,
        evidenceCards: options.evidenceCards,
        includeHeuristic: options.includeHeuristic,
        includeModelAssociations: options.includeModelAssociations,
        maximumEstimatedTokens: options.maximumEstimatedTokens,
        members,
        nodeLimit: options.nodeLimit,
        packageName: options.packageName,
        published,
        query: options.query,
        worksetName: workset.name,
      } satisfies CodeGraphWorksetQueryV2InputV1,
    };
  });
}

function observeRuntimeMember(
  config: RuntimeConfig,
  project: ProjectManifest,
  published: CodeGraphWorksetCatalogPublishedMemberV1 | undefined,
  fs: FileSystem.FileSystem,
  queryService: RuntimeQueryStatusService,
) {
  const repositoryKey = safeLabel(project.name);
  const fallbackRepositoryId = published?.repositoryId ?? '0'.repeat(64);
  return Effect.gen(function* () {
    const cwd = yield* expandPath(project.path);
    if (!(yield* fs.exists(cwd))) {
      return {
        member: {
          deepQueryEligible: false,
          receipt: {
            considered: false,
            deepQueried: false,
            repositoryId: fallbackRepositoryId,
            state: 'missing',
          },
          repositoryKey,
        } satisfies CodeGraphWorksetQueryV2MemberV1,
      };
    }
    const status = yield* published === undefined
      ? queryService.status(config.agentContextHome, cwd, {requestMaintenance: false})
      : queryService.statusForPublishedIdentity(config.agentContextHome, cwd, published, {
          requestMaintenance: false,
        });
    const ready = status.readySnapshot;
    if (published === undefined) {
      return {
        member: {
          deepQueryEligible: false,
          receipt: {
            considered: false,
            deepQueried: false,
            repositoryId: status.identity.repositoryId,
            state: ready === undefined ? 'deferred' : 'excluded',
          },
          repositoryKey,
        } satisfies CodeGraphWorksetQueryV2MemberV1,
      };
    }
    const matches =
      ready !== undefined &&
      status.identity.repositoryId === published.repositoryId &&
      status.identity.checkoutId === published.checkoutId &&
      status.identity.worktreeId === published.worktreeId &&
      ready.id === published.snapshotId &&
      ready.commit === published.commitId;
    if (!matches || ready === undefined) {
      return {
        member: {
          deepQueryEligible: false,
          published,
          receipt: {
            considered: false,
            deepQueried: false,
            repositoryId: published.repositoryId,
            state: 'failed',
          },
          repositoryKey,
        } satisfies CodeGraphWorksetQueryV2MemberV1,
      };
    }
    const freshness = status.stale ? 'stale' : 'current';
    return {
      deep: {cwd, status} satisfies RuntimeDeepMember,
      member: {
        deepQueryEligible: true,
        published,
        receipt: {
          considered: true,
          deepQueried: false,
          repositoryId: published.repositoryId,
          snapshot: {
            checkoutId: published.checkoutId,
            commit: published.commitId,
            digest: published.snapshotDigest,
            dirty: ready.dirty,
            freshness,
            id: published.snapshotId,
            projectionDigest: published.projectionDigest,
            provenance: 'ready-snapshot',
            worktreeId: published.worktreeId,
          },
          state: freshness,
        },
        repositoryKey,
      } satisfies CodeGraphWorksetQueryV2MemberV1,
    };
  }).pipe(
    Effect.catch(() =>
      Effect.succeed({
        member: {
          deepQueryEligible: false,
          ...(published === undefined ? {} : {published}),
          receipt: {
            considered: false,
            deepQueried: false,
            repositoryId: fallbackRepositoryId,
            state: 'failed',
          },
          repositoryKey,
        } satisfies CodeGraphWorksetQueryV2MemberV1,
      }),
    ),
  );
}

function safeLabel(value: string): string {
  return [...value]
    .filter(character => (character.codePointAt(0) ?? 0) > 0x1f)
    .join('')
    .slice(0, 256);
}

function boundedText(value: string, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new Error(`Workset ${label} is invalid.`);
  }
  return value.trim();
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Workset ${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
