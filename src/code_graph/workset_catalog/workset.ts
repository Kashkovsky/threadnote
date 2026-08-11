import {Effect, FileSystem, Result} from 'effect';
import {sha256HexSync} from '../../crypto/sha256.js';
import {requireWorkset} from '../../manifest.js';
import type {ProjectManifest, ResolvedWorkset, RuntimeConfig} from '../../types.js';
import {expandPath} from '../../utils.js';
import {resolveCodeGraphCrossRepositoryBridges} from '../cross_repository/resolver.js';
import {readCodeGraphReadySnapshotMonikers} from '../cross_repository/snapshot_monikers.js';
import {
  readPublishedCodeGraphWorksetCatalogBridgeSetSummary,
  replaceCodeGraphWorksetCatalogBridgeSet,
  type CodeGraphCrossRepositoryBridgeSetSummaryV1,
} from '../cross_repository/store.js';
import type {CodeGraphMonikerV1} from '../cross_repository/types.js';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from '../indexer.js';
import {CodeGraphQueryService} from '../query.js';
import {
  CodeGraphRepositoryError,
  CodeGraphStoreError,
  type CodeGraphSnapshot,
  type CodeGraphStatus,
  type CodeGraphStoreFailureCode,
  type CodeGraphStoreRecovery,
  type RepositoryIdentity,
} from '../types.js';
import {stageCodeGraphWorksetRoutingProjectionScoped} from './projection_builder.js';
import {
  publishCodeGraphWorksetCatalogGeneration,
  readPublishedCodeGraphWorksetCatalogGeneration,
  registerCodeGraphQualifiedRef,
  stageCodeGraphWorksetCatalogGenerationFromReceipts,
} from './store.js';
import type {
  CodeGraphWorksetCatalogGenerationDigestMemberV1,
  CodeGraphWorksetCatalogGenerationReceiptV1,
  CodeGraphWorksetCatalogPublishedGenerationV1,
  CodeGraphWorksetCatalogPublishedMemberV1,
} from './types.js';

export const CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_DEFAULT = 2;
export const CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_MAXIMUM = 8;

export type CodeGraphWorksetPrepareMemberV1 =
  | {
      readonly project: string;
      readonly projectionDigest: string;
      readonly repositoryId: string;
      readonly snapshotId: string;
      readonly state: 'ready';
      readonly symbolCount: number;
    }
  | {
      readonly project: string;
      readonly reason: 'unknown-project';
      readonly state: 'excluded';
    }
  | {
      readonly project: string;
      readonly reason: 'index-failed' | 'projection-failed';
      readonly state: 'failed';
    }
  | {
      readonly project: string;
      readonly reason: 'missing-path';
      readonly state: 'missing';
    };

export interface CodeGraphWorksetPrepareResultV1 {
  readonly bridges?: CodeGraphWorksetPrepareBridgeReceiptV1;
  readonly manifestDigest: string;
  readonly members: readonly CodeGraphWorksetPrepareMemberV1[];
  readonly published?: CodeGraphWorksetCatalogGenerationReceiptV1;
  readonly state: 'failed' | 'ready';
  readonly type: 'code-graph-workset-prepare';
  readonly version: 1;
  readonly workset: string;
}

export interface CodeGraphWorksetPrepareBridgeReceiptV1 {
  readonly bridgeCount: number;
  readonly digest: string;
  readonly monikerCount: number;
  readonly rejectionCount: number;
  readonly resolverVersion: number;
  readonly state: 'ready' | 'unavailable';
  readonly unavailableRepositories: readonly string[];
  readonly warnings: readonly string[];
}

export interface CodeGraphWorksetBridgePreparationMemberV1 {
  readonly assertLease: Effect.Effect<void, unknown>;
  readonly identity: Pick<RepositoryIdentity, 'checkoutId' | 'repositoryId' | 'worktreeId'>;
  readonly project: string;
  readonly repositoryId: string;
  readonly snapshotId: string;
}

export type CodeGraphWorksetStatusMemberStateV1 =
  'current' | 'deferred' | 'excluded' | 'failed' | 'missing' | 'stale' | 'uncatalogued';

export interface CodeGraphWorksetStatusMemberV1 {
  readonly detail?: {
    readonly code: CodeGraphStoreFailureCode | 'repository';
    readonly recovery?: CodeGraphStoreRecovery;
    readonly retryable: boolean;
  };
  readonly project: string;
  readonly reason?:
    | 'catalog-generation-drift'
    | 'checkout-drift'
    | 'identity-drift'
    | 'invalid-repository'
    | 'missing-path'
    | 'no-ready-snapshot'
    | 'snapshot-drift'
    | 'status-corrupt'
    | 'status-failed'
    | 'status-incompatible'
    | 'status-unavailable'
    | 'unknown-project'
    | 'worktree-drift'
    | 'worktree-stale';
  readonly repositoryId?: string;
  readonly snapshotId?: string;
  readonly state: CodeGraphWorksetStatusMemberStateV1;
}

export interface CodeGraphWorksetStatusResultV1 {
  readonly bridges?: CodeGraphCrossRepositoryBridgeSetSummaryV1;
  readonly catalog: {
    readonly generation?: {readonly digest: string; readonly id: string};
    readonly manifestDigest?: string;
    readonly state: 'missing' | 'ready' | 'stale';
  };
  readonly coverage: {
    readonly current: number;
    readonly requested: number;
    readonly states: Readonly<Record<CodeGraphWorksetStatusMemberStateV1, number>>;
  };
  readonly manifestDigest: string;
  readonly members: readonly CodeGraphWorksetStatusMemberV1[];
  readonly type: 'code-graph-workset-status';
  readonly version: 1;
  readonly warnings: readonly string[];
  readonly workset: string;
}

export interface PrepareCodeGraphWorksetOptionsV1 {
  readonly concurrency?: number;
}

export function codeGraphWorksetManifestDigest(workset: ResolvedWorkset): string {
  const projects = workset.projects
    .map(project => [project.name, project.path, project.uri] as const)
    .sort(compareProjectDigestEntry);
  const unresolved = [...workset.unresolvedProjects].sort(compareText);
  return sha256HexSync(
    JSON.stringify(['threadnote-code-graph-workset-manifest-v1', workset.name, projects, unresolved]),
  );
}

/**
 * Attempt every configured member, derive routing-only projections for the
 * ready subset, and atomically publish that non-empty subset. Missing or failed
 * members remain explicit receipts; an incomplete projection never reaches the
 * generation pointer.
 */
const prepareCodeGraphWorksetScoped = Effect.fn('codeGraphWorkset.prepareScoped')(function* (
  config: RuntimeConfig,
  worksetName: string,
  options: PrepareCodeGraphWorksetOptionsV1 = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const indexer = yield* CodeGraphIndexer;
  const workset = yield* requireWorkset(config.manifestPath, worksetName);
  const concurrency = yield* Effect.try({
    try: () => prepareConcurrency(options.concurrency),
    catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
  });
  const manifestDigest = codeGraphWorksetManifestDigest(workset);
  const indexed = yield* Effect.forEach(
    workset.projects,
    project => prepareConfiguredSnapshot(config, project, fs, indexer),
    {concurrency},
  );
  // Projection reads and catalog appends are deliberately serial: at most one
  // normalized symbol page is live across the complete preparation.
  const configured: readonly PreparedMemberWithProjection[] = yield* Effect.forEach(
    indexed,
    member => stageConfiguredMember(config, member),
    {concurrency: 1},
  );
  const unresolved: readonly PreparedMemberWithProjection[] = workset.unresolvedProjects.map(
    project =>
      ({
        project: safeLabel(project),
        reason: 'unknown-project',
        state: 'excluded',
      }) as const satisfies CodeGraphWorksetPrepareMemberV1,
  );
  const members: readonly PreparedMemberWithProjection[] = [...configured, ...unresolved];
  const generationMembers = members.flatMap(member =>
    member.state === 'ready' ? [preparedGenerationMember(member)] : [],
  );
  if (generationMembers.length === 0) {
    return prepareResult(workset.name, manifestDigest, members, undefined);
  }
  yield* assertPreparedMemberLeases(members);
  const staged = yield* stageCodeGraphWorksetCatalogGenerationFromReceipts(config.agentContextHome, {
    manifestDigest,
    members: generationMembers,
    worksetName: workset.name,
  });
  const bridgeMembers = members.filter((member): member is PreparedReadyMember => member.state === 'ready');
  const bridges = yield* prepareCodeGraphWorksetBridgesForGeneration(config, staged.id, bridgeMembers);
  yield* assertPreparedMemberLeases(members);
  const published = yield* publishCodeGraphWorksetCatalogGeneration(config.agentContextHome, {
    beforePointerSwap: () => assertPreparedMemberLeases(members),
    generationId: staged.id,
    worksetName: workset.name,
  });
  return prepareResult(workset.name, manifestDigest, members, published, bridges);
});

export const prepareCodeGraphWorkset = Effect.fn('codeGraphWorkset.prepare')(function* (
  config: RuntimeConfig,
  worksetName: string,
  options: PrepareCodeGraphWorksetOptionsV1 = {},
) {
  // Every member projection lease remains registered in this shared scope until
  // the complete generation has been atomically published (or preparation
  // fails), so an early projection cannot disappear while later members build.
  return yield* prepareCodeGraphWorksetScoped(config, worksetName, options).pipe(Effect.scoped);
});

/** Read manifest, ready-snapshot, and published-catalog drift without cold indexing. */
export const inspectCodeGraphWorksetStatus = Effect.fn('codeGraphWorkset.status')(function* (
  config: RuntimeConfig,
  worksetName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const query = yield* CodeGraphQueryService;
  const workset = yield* requireWorkset(config.manifestPath, worksetName);
  const manifestDigest = codeGraphWorksetManifestDigest(workset);
  const published = yield* readPublishedCodeGraphWorksetCatalogGeneration(config.agentContextHome, workset.name);
  const bridges =
    published === undefined
      ? undefined
      : yield* readPublishedCodeGraphWorksetCatalogBridgeSetSummary(config.agentContextHome, published.id).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
  const publishedByProject = new Map(published?.members.map(member => [member.repositoryKey, member]) ?? []);
  const configured = yield* Effect.forEach(
    workset.projects,
    project => inspectConfiguredMember(config, project, publishedByProject.get(safeLabel(project.name)), fs, query),
    {concurrency: CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_DEFAULT},
  );
  const unresolved = workset.unresolvedProjects.map(
    project =>
      ({
        project: safeLabel(project),
        reason: 'unknown-project',
        state: 'excluded',
      }) as const satisfies CodeGraphWorksetStatusMemberV1,
  );
  let members: readonly CodeGraphWorksetStatusMemberV1[] = [...configured, ...unresolved];
  const generationDrift =
    published !== undefined && !codeGraphWorksetCatalogGenerationMatches(workset, manifestDigest, published);
  if (generationDrift) {
    members = members.map(member =>
      member.state === 'current' ? {...member, reason: 'catalog-generation-drift', state: 'stale'} : member,
    );
  }
  const states = statusStateCounts(members);
  const catalogState =
    published === undefined ? 'missing' : generationDrift || states.current !== members.length ? 'stale' : 'ready';
  const warnings = [
    ...(published === undefined ? ['No published routing catalog exists; run `threadnote workset prepare`.'] : []),
    ...(generationDrift ? ['The published catalog generation does not match the current workset manifest.'] : []),
    ...(unresolved.length > 0 ? ['The workset names projects that are absent from the seed manifest.'] : []),
    ...(published !== undefined && bridges === undefined
      ? ['The published workset generation has no readable cross-repository bridge receipt.']
      : []),
    ...(bridges !== undefined && bridges.coverage.state !== 'complete'
      ? ['Cross-repository bridge coverage is incomplete; path and impact will not infer missing edges.']
      : []),
  ];
  return {
    ...(bridges === undefined ? {} : {bridges}),
    catalog: {
      ...(published === undefined ? {} : {generation: {digest: published.digest, id: published.id}}),
      ...(published === undefined ? {} : {manifestDigest: published.manifestDigest}),
      state: catalogState,
    },
    coverage: {current: states.current, requested: members.length, states},
    manifestDigest,
    members,
    type: 'code-graph-workset-status',
    version: 1,
    warnings,
    workset: workset.name,
  } as const satisfies CodeGraphWorksetStatusResultV1;
});

function prepareConfiguredSnapshot(
  config: RuntimeConfig,
  project: ProjectManifest,
  fs: FileSystem.FileSystem,
  indexer: CodeGraphIndexerShape,
) {
  return Effect.gen(function* () {
    const cwd = yield* expandPath(project.path);
    if (!(yield* fs.exists(cwd))) return failedPrepareMember(project.name, 'missing-path');
    const indexed = yield* indexer.index({cwd, ensureVectors: false, threadnoteHome: config.agentContextHome});
    return {
      indexed: {identity: indexed.identity, snapshot: indexed.snapshot},
      project: safeLabel(project.name),
      state: 'indexed',
    } as const;
  }).pipe(Effect.catch(() => Effect.succeed(failedPrepareMember(project.name, 'index-failed'))));
}

function stageConfiguredMember(config: RuntimeConfig, member: PreparedSnapshotMember) {
  return Effect.gen(function* () {
    if (member.state !== 'indexed') return member;
    return yield* stageCodeGraphWorksetRoutingProjectionScoped({
      identity: member.indexed.identity,
      snapshotId: member.indexed.snapshot.id,
      threadnoteHome: config.agentContextHome,
    }).pipe(
      Effect.map(built => ({
        assertLease: built.assertLease,
        identity: member.indexed.identity,
        project: member.project,
        projectionDigest: built.receipt.projectionDigest,
        repositoryId: built.receipt.repositoryId,
        snapshotId: built.receipt.snapshotId,
        state: 'ready' as const,
        symbolCount: built.receipt.symbolCount,
      })),
      Effect.catch(() => Effect.succeed(failedPrepareMember(member.project, 'projection-failed'))),
    );
  });
}

function inspectConfiguredMember(
  config: RuntimeConfig,
  project: ProjectManifest,
  published: CodeGraphWorksetCatalogPublishedMemberV1 | undefined,
  fs: FileSystem.FileSystem,
  query: {
    readonly status: (
      threadnoteHome: string,
      cwd: string,
      options?: {readonly requestMaintenance?: boolean},
    ) => Effect.Effect<CodeGraphStatus, unknown>;
  },
) {
  return Effect.gen(function* () {
    const cwd = yield* expandPath(project.path);
    if (!(yield* fs.exists(cwd))) {
      return {project: safeLabel(project.name), reason: 'missing-path', state: 'missing'} as const;
    }
    const status = yield* query.status(config.agentContextHome, cwd, {requestMaintenance: false});
    return classifyCodeGraphWorksetStatusMember(project.name, status, published);
  }).pipe(Effect.catch(error => Effect.succeed(classifyCodeGraphWorksetStatusFailure(project.name, error))));
}

/** Convert status failures to bounded pathless diagnostics without erasing typed storage causes. */
export function classifyCodeGraphWorksetStatusFailure(project: string, error: unknown): CodeGraphWorksetStatusMemberV1 {
  if (error instanceof CodeGraphRepositoryError) {
    return {
      detail: {code: 'repository', retryable: false},
      project: safeLabel(project),
      reason: 'invalid-repository',
      state: 'failed',
    };
  }
  if (error instanceof CodeGraphStoreError) {
    const reason =
      error.code === 'confirmed-corruption'
        ? 'status-corrupt'
        : error.code === 'incompatible-schema' || error.code === 'schema-additive'
          ? 'status-incompatible'
          : error.code === 'busy' || error.code === 'transient-io'
            ? 'status-unavailable'
            : 'status-failed';
    return {
      detail: {code: error.code, recovery: error.recovery, retryable: error.retryable},
      project: safeLabel(project),
      reason,
      state: 'failed',
    };
  }
  return {
    detail: {code: 'unknown', retryable: false},
    project: safeLabel(project),
    reason: 'status-failed',
    state: 'failed',
  };
}

export function classifyCodeGraphWorksetStatusMember(
  project: string,
  status: Pick<CodeGraphStatus, 'identity' | 'readySnapshot' | 'stale'>,
  published: CodeGraphWorksetCatalogPublishedMemberV1 | undefined,
): CodeGraphWorksetStatusMemberV1 {
  const common = {
    project: safeLabel(project),
    repositoryId: status.identity.repositoryId,
    ...(status.readySnapshot === undefined ? {} : {snapshotId: status.readySnapshot.id}),
  };
  if (status.readySnapshot === undefined) return {...common, reason: 'no-ready-snapshot', state: 'deferred'};
  if (published === undefined) return {...common, state: 'uncatalogued'};
  if (published.repositoryId !== status.identity.repositoryId)
    return {...common, reason: 'identity-drift', state: 'stale'};
  if (published.checkoutId !== status.identity.checkoutId) return {...common, reason: 'checkout-drift', state: 'stale'};
  if (published.worktreeId !== status.identity.worktreeId) return {...common, reason: 'worktree-drift', state: 'stale'};
  if (published.snapshotId !== status.readySnapshot.id) return {...common, reason: 'snapshot-drift', state: 'stale'};
  if (status.stale) return {...common, reason: 'worktree-stale', state: 'stale'};
  return {...common, state: 'current'};
}

/**
 * Validate both the digest receipt and a unique non-empty subset of configured
 * project keys. Coverage gaps remain queryable facts without allowing unknown
 * or duplicated catalog members to pass solely on a manifest digest.
 */
export function codeGraphWorksetCatalogGenerationMatches(
  workset: ResolvedWorkset,
  manifestDigest: string,
  published: CodeGraphWorksetCatalogPublishedGenerationV1,
): boolean {
  if (published.manifestDigest !== manifestDigest) return false;
  const expected = new Set(workset.projects.map(project => safeLabel(project.name)));
  const actual = published.members.map(member => member.repositoryKey);
  if (actual.length === 0 || new Set(actual).size !== actual.length) return false;
  return actual.every(repositoryKey => expected.has(repositoryKey));
}

function preparedGenerationMember(member: PreparedReadyMember): CodeGraphWorksetCatalogGenerationDigestMemberV1 {
  return {
    projectionDigest: member.projectionDigest,
    repositoryId: member.repositoryId,
    repositoryKey: member.project,
    snapshotId: member.snapshotId,
  };
}

type PreparedReadyMember = Extract<CodeGraphWorksetPrepareMemberV1, {readonly state: 'ready'}> & {
  readonly assertLease: Effect.Effect<void, unknown>;
  readonly identity: Pick<RepositoryIdentity, 'checkoutId' | 'repositoryId' | 'worktreeId'>;
};

type PreparedSnapshotMember =
  | {
      readonly indexed: {readonly identity: RepositoryIdentity; readonly snapshot: CodeGraphSnapshot};
      readonly project: string;
      readonly state: 'indexed';
    }
  | Exclude<CodeGraphWorksetPrepareMemberV1, {readonly state: 'ready'}>;

type PreparedMemberWithProjection =
  PreparedReadyMember | Exclude<CodeGraphWorksetPrepareMemberV1, {readonly state: 'ready'}>;

function failedPrepareMember(
  project: string,
  reason: 'index-failed' | 'missing-path' | 'projection-failed',
): Exclude<CodeGraphWorksetPrepareMemberV1, {readonly state: 'excluded' | 'ready'}> {
  if (reason === 'missing-path') return {project: safeLabel(project), reason, state: 'missing'};
  return {project: safeLabel(project), reason, state: 'failed'};
}

function prepareResult(
  workset: string,
  manifestDigest: string,
  members: readonly PreparedMemberWithProjection[],
  published: CodeGraphWorksetCatalogGenerationReceiptV1 | undefined,
  bridges?: CodeGraphWorksetPrepareBridgeReceiptV1,
): CodeGraphWorksetPrepareResultV1 {
  return {
    ...(bridges === undefined ? {} : {bridges}),
    manifestDigest,
    members: members.map(publicPrepareMember),
    ...(published === undefined ? {} : {published}),
    state: published === undefined ? 'failed' : 'ready',
    type: 'code-graph-workset-prepare',
    version: 1,
    workset,
  };
}

function publicPrepareMember(member: PreparedMemberWithProjection): CodeGraphWorksetPrepareMemberV1 {
  if (member.state !== 'ready') return member;
  const {assertLease: _assertLease, identity: _identity, ...receipt} = member;
  return receipt;
}

export const prepareCodeGraphWorksetBridgesForGeneration = Effect.fn('codeGraphWorkset.prepareBridgesForGeneration')(
  function* (config: RuntimeConfig, generationId: string, ready: readonly CodeGraphWorksetBridgePreparationMemberV1[]) {
    const loaded = yield* Effect.forEach(
      ready,
      member =>
        readCodeGraphReadySnapshotMonikers({
          identity: member.identity,
          snapshotId: member.snapshotId,
          threadnoteHome: config.agentContextHome,
        }).pipe(
          Effect.map(monikers => ({member, monikers, state: 'ready' as const})),
          Effect.catch(() => Effect.succeed({member, state: 'unavailable' as const})),
        ),
      {concurrency: CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_DEFAULT},
    );
    const unavailableRepositories = loaded
      .filter(value => value.state === 'unavailable')
      .map(value => value.member.project)
      .sort(compareText);
    if (unavailableRepositories.length > 0) {
      const stored = yield* replaceCodeGraphWorksetCatalogBridgeSet(config.agentContextHome, {
        bridges: [],
        coverage: {
          diagnostics: ['moniker-read-failed'],
          failedRepositoryCount: unavailableRepositories.length,
          rejectionCount: 0,
          repositoriesRead: ready.length - unavailableRepositories.length,
          state: ready.length === unavailableRepositories.length ? 'failed' : 'partial',
        },
        generationId,
      });
      return {
        bridgeCount: 0,
        digest: stored.digest,
        monikerCount: 0,
        rejectionCount: 0,
        resolverVersion: stored.resolverVersion,
        state: 'unavailable' as const,
        unavailableRepositories,
        warnings: [
          'Cross-repository bridges were withheld because one or more ready snapshots had no readable canonical moniker surface.',
        ],
      } satisfies CodeGraphWorksetPrepareBridgeReceiptV1;
    }
    const repositories = loaded.map(value => {
      if (value.state !== 'ready') throw new Error('Unreachable bridge preparation state.');
      return {
        monikers: value.monikers,
        repositoryId: value.member.repositoryId,
        repositoryKey: value.member.project,
        snapshotId: value.member.snapshotId,
      };
    });
    const resolution = yield* Effect.result(
      Effect.try({
        try: () => resolveCodeGraphCrossRepositoryBridges(repositories),
        catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
    );
    if (Result.isFailure(resolution)) {
      const stored = yield* replaceCodeGraphWorksetCatalogBridgeSet(config.agentContextHome, {
        bridges: [],
        coverage: {
          diagnostics: ['resolver-failed'],
          failedRepositoryCount: ready.length,
          rejectionCount: 0,
          repositoriesRead: 0,
          state: 'failed',
        },
        generationId,
      });
      return {
        bridgeCount: 0,
        digest: stored.digest,
        monikerCount: repositories.reduce((total, value) => total + value.monikers.length, 0),
        rejectionCount: 0,
        resolverVersion: stored.resolverVersion,
        state: 'unavailable' as const,
        unavailableRepositories: ready.map(value => value.project).sort(compareText),
        warnings: ['Cross-repository bridges were withheld because deterministic resolution failed.'],
      } satisfies CodeGraphWorksetPrepareBridgeReceiptV1;
    }
    yield* registerBridgeQualifiedRefs(config.agentContextHome, repositories);
    yield* assertBridgeMemberLeases(ready);
    const stored = yield* replaceCodeGraphWorksetCatalogBridgeSet(config.agentContextHome, {
      bridges: resolution.success.bridges,
      coverage: {
        diagnostics: resolution.success.rejections.length === 0 ? [] : ['resolver-rejections'],
        failedRepositoryCount: 0,
        rejectionCount: resolution.success.rejections.length,
        repositoriesRead: ready.length,
        state: 'complete',
      },
      generationId,
    });
    return {
      bridgeCount: stored.bridgeCount,
      digest: stored.digest,
      monikerCount: repositories.reduce((total, value) => total + value.monikers.length, 0),
      rejectionCount: resolution.success.rejections.length,
      resolverVersion: stored.resolverVersion,
      state: 'ready' as const,
      unavailableRepositories: [],
      warnings:
        resolution.success.rejections.length === 0
          ? []
          : [
              `${resolution.success.rejections.length} cross-repository import${resolution.success.rejections.length === 1 ? ' was' : 's were'} rejected as ambiguous or version-incompatible.`,
            ],
    } satisfies CodeGraphWorksetPrepareBridgeReceiptV1;
  },
);

function registerBridgeQualifiedRefs(
  threadnoteHome: string,
  repositories: readonly {
    readonly monikers: readonly CodeGraphMonikerV1[];
    readonly repositoryId: string;
  }[],
) {
  const refs = new Map<string, {readonly nodeId: string; readonly repositoryId: string}>();
  for (const repository of repositories) {
    for (const moniker of repository.monikers) {
      if (moniker.scheme !== 'protobuf') continue;
      const candidate = {nodeId: moniker.symbolId, repositoryId: repository.repositoryId};
      refs.set(`${candidate.repositoryId}\0${candidate.nodeId}`, candidate);
    }
  }
  return Effect.forEach(
    [...refs.values()].sort(
      (left, right) => compareText(left.repositoryId, right.repositoryId) || compareText(left.nodeId, right.nodeId),
    ),
    ref => registerCodeGraphQualifiedRef(threadnoteHome, ref),
    {concurrency: 1, discard: true},
  );
}

function assertPreparedMemberLeases(members: readonly PreparedMemberWithProjection[]) {
  return Effect.forEach(members, member => (member.state === 'ready' ? member.assertLease : Effect.void), {
    concurrency: CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_DEFAULT,
    discard: true,
  });
}

function assertBridgeMemberLeases(members: readonly CodeGraphWorksetBridgePreparationMemberV1[]) {
  return Effect.forEach(members, member => member.assertLease, {
    concurrency: CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_DEFAULT,
    discard: true,
  });
}

function statusStateCounts(
  members: readonly CodeGraphWorksetStatusMemberV1[],
): Record<CodeGraphWorksetStatusMemberStateV1, number> {
  const counts: Record<CodeGraphWorksetStatusMemberStateV1, number> = {
    current: 0,
    deferred: 0,
    excluded: 0,
    failed: 0,
    missing: 0,
    stale: 0,
    uncatalogued: 0,
  };
  for (const member of members) counts[member.state] += 1;
  return counts;
}

function prepareConcurrency(value: number | undefined): number {
  const concurrency = value ?? CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_DEFAULT;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_MAXIMUM
  ) {
    throw new Error(
      `Workset prepare concurrency must be an integer from 1 to ${CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_MAXIMUM}.`,
    );
  }
  return concurrency;
}

function safeLabel(value: string): string {
  const normalized = value.replace(/[\r\n\t\0]/gu, ' ').trim();
  return normalized.slice(0, 256) || 'unknown';
}

function compareProjectDigestEntry(
  left: readonly [string, string, string],
  right: readonly [string, string, string],
): number {
  return compareText(left[0], right[0]) || compareText(left[1], right[1]) || compareText(left[2], right[2]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
