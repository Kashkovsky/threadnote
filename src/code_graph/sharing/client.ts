import {Effect, Exit, FileSystem, Option, Path, Schema} from 'effect';
import {importCodeGraphCheckpointSnapshot} from '../checkpoint/commands.js';
import {SystemInfo} from '../../effect/system.js';
import {resolveRepositoryIdentity} from '../repository.js';
import type {CodeGraphProgress, RepositoryIdentity} from '../types.js';
import type {RuntimeConfig} from '../../types.js';
import {
  parseGraphShareFrontierManifest,
  parseGraphShareFrontierPointer,
  parseGraphShareSignatureEnvelope,
  verifyGraphShareFrontier,
  type GraphShareFrontierManifestV1,
} from './artifacts.js';
import {decodeJsonBytes, readJsonFile, writePrivateJsonFile} from './atomic.js';
import {readVerifiedCasBlob} from './cas.js';
import {ensureGraphShareCheckpointArtifact} from './checkpoint_cas.js';
import {GraphSharingError, graphSharingFailure, graphSharingUnavailable} from './errors.js';
import type {Sha256Digest} from './digest.js';
import {graphShareBlobExists, graphShareCommitIsAncestor} from './git.js';
import {graphShareControlGetFrontier, graphShareControlGetTag, mirrorCoordinatorCasBlob} from './control_client.js';
import {graphShareFrontierPointerFromOciDescriptor, parseGraphShareOciDescriptor} from './descriptor.js';
import {graphShareFrontierDiscoveryTag} from './namespace.js';
import {
  GRAPH_SHARE_CONTRIBUTION_MODES,
  effectiveGraphShareContributionMode,
  readGraphShareContributionQueue,
  type GraphShareContributionMode,
} from './contribution.js';
import {graphShareEnrollmentPath, graphSharingFrontierPointerPath, graphSharingLayout} from './layout.js';
import {planGraphWorkerActions, readAdvertisedGraphWorkerActions} from './worker.js';
import {
  assertEnrollmentMatchesIdentity,
  assertProfileMatchesEnrollment,
  graphShareProfileDigest,
  parseGraphShareCoordinatorUrl,
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  parseGraphShareProfilePointer,
  type GraphShareEnrollmentV1,
} from './profile.js';
import {
  readSharedGraphImportAttempt,
  readSharedGraphProvenance,
  removeSharedGraphProvenance,
  writeSharedGraphImportAttempt,
  writeSharedGraphProvenance,
  type SharedGraphImportAttemptV1,
} from './provenance.js';
import {
  lookupGraphShareTrustReceipt,
  readGraphShareClientState,
  removeGraphShareTrustReceipt,
  resolveGraphShareCasRoot,
  trustReceiptFromEnrollment,
  writeGraphShareClientState,
  writeGraphShareContributionMode,
  writeGraphShareCoordinatorUrl,
  writeGraphShareTrustReceipt,
  type GraphShareAccessMode,
  type GraphShareTrustReceiptV1,
} from './trust.js';

export interface GraphShareJoinOptions {
  readonly cas?: string;
  readonly coordinator?: string;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly readOnly?: boolean;
}

export interface GraphShareLeaveOptions {
  readonly cwd?: string;
  readonly json?: boolean;
  readonly purge?: boolean;
}

export interface GraphShareStatusOptions {
  readonly cas?: string;
  readonly cwd?: string;
  readonly json?: boolean;
}

export interface SharedGraphImportRequest {
  readonly cwd: string;
  readonly identity: RepositoryIdentity;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly threadnoteHome: string;
}

export type SharedGraphImportSkipReason =
  | 'already-installed'
  | 'invalid-enrollment'
  | 'quarantined'
  | 'repository-mismatch'
  | 'trust-pin-mismatch'
  | 'unavailable'
  | 'unenrolled'
  | 'untrusted';

export type SharedGraphImportResult =
  | {
      readonly atGeneration: number;
      readonly checkpointDigest: Sha256Digest;
      readonly imported: true;
      readonly snapshotId: string;
    }
  | {
      readonly imported: false;
      readonly reason: SharedGraphImportSkipReason;
      readonly atGeneration?: number;
      readonly checkpointDigest?: Sha256Digest;
      readonly snapshotId?: string;
    };

const sharingProgress = (
  onProgress: SharedGraphImportRequest['onProgress'],
  subphase: 'applying-deltas' | 'building-local-overlay' | 'discovering-shared-base' | 'downloading-checkpoint',
) => (onProgress?.({phase: 'sharing', subphase}) ?? Effect.void).pipe(Effect.ignore);

export const runGraphShareJoin = Effect.fn('codeGraph.sharing.join')(function* (
  config: RuntimeConfig,
  options: GraphShareJoinOptions,
) {
  const path = yield* Path.Path;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  if (options.cas !== undefined) yield* writeGraphShareClientState(config.agentContextHome, casRoot);
  const enrollment = parseGraphShareEnrollment(yield* readJsonFile(graphShareEnrollmentPath(path, identity.repoRoot)));
  assertEnrollmentMatchesIdentity(enrollment, identity.repositoryId);
  const pointer = parseGraphShareProfilePointer(enrollment.profile);
  if (options.coordinator !== undefined) {
    const coordinatorUrl = parseGraphShareCoordinatorUrl(options.coordinator);
    yield* writeGraphShareCoordinatorUrl(config.agentContextHome, coordinatorUrl);
    yield* mirrorCoordinatorCasBlob(casRoot, coordinatorUrl, pointer.digest);
  }
  const profile = yield* decodeJson(
    yield* readVerifiedCasBlob(casRoot, pointer.digest),
    parseGraphShareProfile,
    'Organization graph profile is invalid.',
  );
  const profileDigest = graphShareProfileDigest(profile);
  assertProfileMatchesEnrollment(profile, enrollment, profileDigest);
  if (profile.coordinator?.url !== undefined) {
    yield* writeGraphShareCoordinatorUrl(config.agentContextHome, profile.coordinator.url);
  }
  const accessMode: GraphShareAccessMode = options.readOnly ? 'read-only' : 'join';
  const receipt = yield* writeGraphShareTrustReceipt(
    config.agentContextHome,
    trustReceiptFromEnrollment(enrollment, profile, profileDigest, accessMode),
  );
  if (accessMode === 'join') {
    const state = yield* readGraphShareClientState(config.agentContextHome);
    if (state.contributionMode === undefined) {
      yield* writeGraphShareContributionMode(config.agentContextHome, profile.contribution.defaultMode);
    }
  }
  return {
    accessMode: receipt.accessMode,
    organization: receipt.organization,
    profileDigest: receipt.profileDigest,
    type: 'code-graph-share-join' as const,
    version: 1 as const,
  };
});

export const runGraphShareLeave = Effect.fn('codeGraph.sharing.leave')(function* (
  config: RuntimeConfig,
  options: GraphShareLeaveOptions,
) {
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  yield* removeGraphShareTrustReceipt(config.agentContextHome, identity.repositoryId);
  yield* removeSharedGraphProvenance(config.agentContextHome, identity.checkoutId);
  return {
    purged: true,
    repositoryId: identity.repositoryId,
    type: 'code-graph-share-leave' as const,
    version: 1 as const,
  };
});

export const runGraphShareStatus = Effect.fn('codeGraph.sharing.status')(function* (
  config: RuntimeConfig,
  options: GraphShareStatusOptions,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const enrollmentPath = graphShareEnrollmentPath(path, identity.repoRoot);
  const enrolled = yield* fs.exists(enrollmentPath);
  const enrollment = enrolled
    ? yield* readJsonFile(enrollmentPath).pipe(
        Effect.flatMap(value =>
          Effect.try({
            try: () => parseGraphShareEnrollment(value),
            catch: cause => graphSharingFailure('Enrollment pointer is invalid.', cause),
          }),
        ),
        Effect.option,
      )
    : Option.none();
  const enrollmentValid = Option.isSome(enrollment) && enrollment.value.repositoryId === identity.repositoryId;
  const trust = yield* lookupGraphShareTrustReceipt(config.agentContextHome, identity.repositoryId);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  const layout = graphSharingLayout(path, config.agentContextHome, casRoot);
  const pointerPath = graphSharingFrontierPointerPath(path, layout.frontiersRoot, identity.repositoryId);
  const frontier = enrolled && (yield* fs.exists(pointerPath)) ? yield* readJsonFile(pointerPath) : undefined;
  const lastImport = yield* readSharedGraphImportAttempt(config.agentContextHome, identity.checkoutId).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  return {
    accessMode: trust?.accessMode,
    enrolled,
    enrollmentValid,
    organization: trust?.organization,
    profileDigest: trust?.profileDigest,
    repositoryId: identity.repositoryId,
    trusted: trust !== undefined,
    type: 'code-graph-share-status' as const,
    version: 1 as const,
    ...(frontier === undefined ? {} : {frontier}),
    ...(lastImport === undefined ? {} : {lastImport}),
  };
});

export const maybeImportSharedGraphBase = Effect.fn('codeGraph.sharing.maybeImportSharedBase')(function* (
  request: SharedGraphImportRequest,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  yield* sharingProgress(request.onProgress, 'discovering-shared-base');
  const enrollmentPath = graphShareEnrollmentPath(path, request.identity.repoRoot);
  if (!(yield* fs.exists(enrollmentPath))) return {imported: false as const, reason: 'unenrolled' as const};
  const loaded = yield* readJsonFile(enrollmentPath).pipe(Effect.option);
  if (loaded._tag === 'None') return {imported: false as const, reason: 'invalid-enrollment' as const};
  const enrollment = yield* Effect.try({
    try: () => parseGraphShareEnrollment(loaded.value),
    catch: cause => graphSharingFailure('Enrollment pointer is invalid.', cause),
  }).pipe(Effect.option);
  if (enrollment._tag === 'None') return {imported: false as const, reason: 'invalid-enrollment' as const};
  if (enrollment.value.repositoryId !== request.identity.repositoryId) {
    return {imported: false as const, reason: 'repository-mismatch' as const};
  }
  const trust = yield* lookupGraphShareTrustReceipt(request.threadnoteHome, request.identity.repositoryId);
  if (trust === undefined) return {imported: false as const, reason: 'untrusted' as const};
  const enrollmentPointer = yield* decodeValue(
    parseGraphShareProfilePointer,
    enrollment.value.profile,
    'Enrollment profile pointer is invalid.',
  ).pipe(Effect.option);
  if (enrollmentPointer._tag === 'None') return {imported: false as const, reason: 'invalid-enrollment' as const};
  if (
    trust.publisherKeyFingerprint !== enrollment.value.publisherKeyFingerprint ||
    trust.profileDigest !== enrollmentPointer.value.digest
  ) {
    return {imported: false as const, reason: 'trust-pin-mismatch' as const};
  }
  const casRoot = yield* resolveGraphShareCasRoot(request.threadnoteHome);
  yield* sharingProgress(request.onProgress, 'downloading-checkpoint');
  return yield* importVerifiedSharedCheckpoint({
    casRoot,
    enrollment: enrollment.value,
    request,
    trust,
  }).pipe(
    Effect.catchIf(isUnavailableSharingFailure, () =>
      Effect.succeed({imported: false as const, reason: 'unavailable' as const}),
    ),
    Effect.catch(error =>
      quarantineSharedFailure(request.threadnoteHome, request.identity.repositoryId, error).pipe(
        Effect.as({imported: false as const, reason: 'quarantined' as const}),
      ),
    ),
  );
});

export const captureSharedGraphImportBase = Effect.fn('codeGraph.sharing.captureSharedImport')(function* (
  request: SharedGraphImportRequest,
) {
  const exit = yield* Effect.exit(maybeImportSharedGraphBase(request));
  const result: SharedGraphImportResult = Exit.isSuccess(exit)
    ? exit.value
    : {imported: false as const, reason: 'unavailable' as const};
  yield* writeSharedGraphImportAttempt(
    request.threadnoteHome,
    request.identity.checkoutId,
    sharedGraphImportAttemptFrom(result),
  ).pipe(Effect.ignore);
  return result;
});

const importVerifiedSharedCheckpoint = Effect.fn('codeGraph.sharing.importVerifiedCheckpoint')(function* (input: {
  readonly casRoot: string;
  readonly enrollment: GraphShareEnrollmentV1;
  readonly request: SharedGraphImportRequest;
  readonly trust: GraphShareTrustReceiptV1;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pointer = yield* decodeValue(
    parseGraphShareProfilePointer,
    input.enrollment.profile,
    'Enrollment profile pointer is invalid.',
  );
  const coordinatorHint = (yield* readGraphShareClientState(input.request.threadnoteHome)).coordinatorUrl;
  const profile = yield* decodeJson(
    yield* ensureSharedCasBlob(input.casRoot, pointer.digest, coordinatorHint),
    parseGraphShareProfile,
    'Organization graph profile is invalid.',
  );
  const profileDigest = graphShareProfileDigest(profile);
  yield* decodeValue(
    () => {
      assertProfileMatchesEnrollment(profile, input.enrollment, profileDigest);
      return profile;
    },
    undefined,
    'Profile does not match the enrollment pointer.',
  );
  if (profileDigest !== input.trust.profileDigest) {
    return {imported: false as const, reason: 'trust-pin-mismatch' as const};
  }
  const coordinatorUrl =
    (yield* readGraphShareClientState(input.request.threadnoteHome)).coordinatorUrl ?? profile.coordinator?.url;
  if (coordinatorUrl !== undefined) {
    yield* writeGraphShareCoordinatorUrl(input.request.threadnoteHome, coordinatorUrl);
    yield* refreshFrontierPointerFromCoordinator({
      branch: profile.source.branches[0] ?? 'refs/heads/main',
      casRoot: input.casRoot,
      coordinatorUrl,
      repositoryId: input.request.identity.repositoryId,
      threadnoteHome: input.request.threadnoteHome,
    }).pipe(Effect.catchIf(isUnavailableSharingFailure, () => Effect.void));
  }
  const layout = graphSharingLayout(path, input.request.threadnoteHome, input.casRoot);
  const pointerPath = graphSharingFrontierPointerPath(path, layout.frontiersRoot, input.request.identity.repositoryId);
  if (!(yield* fs.exists(pointerPath))) {
    return yield* graphSharingUnavailable('Shared frontier pointer is missing.');
  }
  const frontierPointer = yield* decodeValue(
    parseGraphShareFrontierPointer,
    yield* readJsonFile(pointerPath),
    'Frontier pointer is invalid.',
  );
  const manifest = yield* decodeJson(
    yield* ensureSharedCasBlob(input.casRoot, frontierPointer.manifestDigest, coordinatorUrl),
    parseGraphShareFrontierManifest,
    'Frontier manifest is invalid.',
  );
  const envelope = yield* decodeJson(
    yield* ensureSharedCasBlob(input.casRoot, frontierPointer.envelopeDigest, coordinatorUrl),
    parseGraphShareSignatureEnvelope,
    'Frontier signature envelope is invalid.',
  );
  yield* verifyGraphShareFrontier(input.trust.publisherKeyFingerprint, manifest, envelope);
  if (manifest.repositoryId !== input.request.identity.repositoryId || manifest.profileDigest !== profileDigest) {
    return yield* graphSharingFailure('Frontier manifest does not match the enrolled repository profile.');
  }
  const selected = yield* selectPublishedAncestorManifest(
    input.casRoot,
    input.request.identity,
    manifest,
    coordinatorUrl,
  );
  if (selected.deltas.length > 0) {
    return yield* graphSharingFailure(
      'Incremental frontier deltas are not applied until a checkpoint compaction is published.',
    );
  }
  const existing = yield* readSharedGraphProvenance(
    input.request.threadnoteHome,
    input.request.identity.checkoutId,
  ).pipe(Effect.orElseSucceed(() => undefined));
  if (
    existing?.checkpointDigest === selected.checkpoint.manifestDigest &&
    existing.repositoryId === input.request.identity.repositoryId &&
    existing.profileDigest === profileDigest
  ) {
    return {
      imported: false as const,
      reason: 'already-installed' as const,
      snapshotId: existing.snapshotId,
      checkpointDigest: selected.checkpoint.manifestDigest,
      atGeneration: selected.generation,
    };
  }
  const checkpointPath = yield* ensureGraphShareCheckpointArtifact({
    artifactDigest: selected.checkpoint.manifestDigest,
    casRoot: input.casRoot,
    ...(coordinatorUrl === undefined ? {} : {coordinatorUrl}),
    ...(selected.checkpoint.metadataDigest === undefined ? {} : {metadataDigest: selected.checkpoint.metadataDigest}),
  });
  yield* sharingProgress(input.request.onProgress, 'applying-deltas');
  const imported = yield* importCodeGraphCheckpointSnapshot(runtimeConfigForHome(input.request.threadnoteHome), {
    cwd: input.request.cwd,
    expectedDigest: selected.checkpoint.manifestDigest,
    followOnIndex: false,
    input: checkpointPath,
    quiet: true,
  });
  yield* sharingProgress(input.request.onProgress, 'building-local-overlay');
  yield* writeSharedGraphProvenance(input.request.threadnoteHome, input.request.identity.checkoutId, {
    checkpointDigest: selected.checkpoint.manifestDigest,
    frontierCommit: selected.sourceCommit,
    profileDigest,
    repositoryId: input.request.identity.repositoryId,
    schemaVersion: 1,
    snapshotId: imported.result.snapshotId,
  });
  return {
    imported: true as const,
    snapshotId: imported.result.snapshotId,
    checkpointDigest: selected.checkpoint.manifestDigest,
    atGeneration: selected.generation,
  };
});

export interface GraphShareContributeStatusOptions {
  readonly cwd?: string;
  readonly json?: boolean;
}

export interface GraphShareContributeSetOptions {
  readonly cwd?: string;
  readonly json?: boolean;
  readonly mode?: string;
}

export interface GraphWorkerOptions {
  readonly cas?: string;
  readonly cwd?: string;
  readonly json?: boolean;
}

export const runGraphContributeStatus = Effect.fn('codeGraph.sharing.contributeStatus')(function* (
  config: RuntimeConfig,
  options: GraphShareContributeStatusOptions,
) {
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const trust = yield* lookupGraphShareTrustReceipt(config.agentContextHome, identity.repositoryId);
  const state = yield* readGraphShareClientState(config.agentContextHome);
  const requested = state.contributionMode ?? 'off';
  const mode = effectiveGraphShareContributionMode(trust?.accessMode, requested);
  const queue = yield* readGraphShareContributionQueue(config.agentContextHome, identity.repositoryId, mode);
  return {
    accessMode: trust?.accessMode,
    mode,
    queued: queue.announcements.length,
    repositoryId: identity.repositoryId,
    type: 'code-graph-contribute-status' as const,
    version: 1 as const,
  };
});

export const runGraphContributeSet = Effect.fn('codeGraph.sharing.contributeSet')(function* (
  config: RuntimeConfig,
  options: GraphShareContributeSetOptions,
) {
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const trust = yield* lookupGraphShareTrustReceipt(config.agentContextHome, identity.repositoryId);
  const requested = yield* decodeContributionMode(options.mode);
  const mode = effectiveGraphShareContributionMode(trust?.accessMode, requested);
  yield* writeGraphShareContributionMode(config.agentContextHome, mode);
  return {
    accessMode: trust?.accessMode,
    mode,
    repositoryId: identity.repositoryId,
    type: 'code-graph-contribute-set' as const,
    version: 1 as const,
  };
});

export const runGraphWorker = Effect.fn('codeGraph.sharing.worker')(function* (
  config: RuntimeConfig,
  options: GraphWorkerOptions,
) {
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const trust = yield* lookupGraphShareTrustReceipt(config.agentContextHome, identity.repositoryId);
  if (trust?.accessMode !== 'join') {
    return {
      eligible: 0,
      skippedMissingBlob: 0,
      type: 'code-graph-worker' as const,
      version: 1 as const,
    };
  }
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  const advertised = yield* readAdvertisedGraphWorkerActions(config.agentContextHome, identity.repositoryId, casRoot);
  const presentBlobIds = new Set<string>();
  for (const action of advertised) {
    if (yield* graphShareBlobExists(identity.repoRoot, action.gitBlobId)) presentBlobIds.add(action.gitBlobId);
  }
  const plan = planGraphWorkerActions(advertised, presentBlobIds);
  return {
    eligible: plan.eligible.length,
    skippedMissingBlob: plan.skippedMissingBlob.length,
    type: 'code-graph-worker' as const,
    version: 1 as const,
  };
});

const quarantineSharedFailure = Effect.fn('codeGraph.sharing.quarantine')(function* (
  threadnoteHome: string,
  repositoryId: string,
  cause: unknown,
) {
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome);
  const message = cause instanceof Error ? cause.message : String(cause);
  yield* writePrivateJsonFile(path.join(layout.quarantineRoot, `${repositoryId}.json`), {
    message,
    repositoryId,
    schemaVersion: 1,
  });
});

function isUnavailableSharingFailure(error: unknown): error is GraphSharingError {
  return Schema.is(GraphSharingError)(error) && error.kind === 'unavailable';
}

function runtimeConfigForHome(threadnoteHome: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: threadnoteHome,
    agentId: 'threadnote',
    manifestPath: `${threadnoteHome}/seed-manifest.yaml`,
    user: 'local',
  };
}

function commandCwd(value: string | undefined) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return path.resolve(value?.trim() || system.currentDirectory());
  });
}

function decodeContributionMode(value: string | undefined) {
  return Effect.try({
    try: () => {
      if (value === undefined || value.trim().length === 0) {
        throw graphSharingFailure('Contribution mode must be off, passive, idle, or dedicated.');
      }
      const mode = value.trim();
      if ((GRAPH_SHARE_CONTRIBUTION_MODES as readonly string[]).includes(mode)) {
        return mode as GraphShareContributionMode;
      }
      throw graphSharingFailure('Contribution mode must be off, passive, idle, or dedicated.');
    },
    catch: cause =>
      Schema.is(GraphSharingError)(cause) ? cause : graphSharingFailure('Contribution mode is invalid.', cause),
  });
}

function decodeJson<A>(bytes: Uint8Array, parse: (value: unknown) => A, message: string) {
  return decodeJsonBytes(bytes).pipe(
    Effect.mapError(cause => graphSharingFailure(message, cause)),
    Effect.flatMap(value => decodeValue(parse, value, message)),
  );
}

export const GRAPH_SHARE_ANCESTOR_WALK_LIMIT = 64;

export const selectPublishedAncestorManifest = Effect.fn('codeGraph.sharing.selectPublishedAncestor')(function* (
  casRoot: string,
  identity: RepositoryIdentity,
  latest: GraphShareFrontierManifestV1,
  coordinatorUrl?: string,
) {
  let current = latest;
  for (let step = 0; step < GRAPH_SHARE_ANCESTOR_WALK_LIMIT; step += 1) {
    if (yield* graphShareCommitIsAncestor(identity.repoRoot, current.sourceCommit, identity.headCommit)) {
      return current;
    }
    if (current.previousManifestDigest === null) {
      return yield* graphSharingUnavailable('No published ancestor frontier for this HEAD.');
    }
    current = yield* decodeJson(
      yield* ensureSharedCasBlob(casRoot, current.previousManifestDigest, coordinatorUrl),
      parseGraphShareFrontierManifest,
      'Predecessor frontier manifest is invalid.',
    );
  }
  return yield* graphSharingUnavailable('Published ancestor walk exceeded the generation limit.');
});

const refreshFrontierPointerFromCoordinator = Effect.fn('codeGraph.sharing.refreshFrontierPointer')(function* (input: {
  readonly branch: string;
  readonly casRoot: string;
  readonly coordinatorUrl: string;
  readonly repositoryId: string;
  readonly threadnoteHome: string;
}) {
  const path = yield* Path.Path;
  const tagName = graphShareFrontierDiscoveryTag(input.repositoryId, input.branch);
  const fromDescriptor = yield* refreshFrontierPointerFromOciTag({
    casRoot: input.casRoot,
    coordinatorUrl: input.coordinatorUrl,
    tagName,
  }).pipe(Effect.option);
  const frontier =
    fromDescriptor._tag === 'Some'
      ? fromDescriptor.value
      : yield* graphShareControlGetFrontier(input.coordinatorUrl, tagName.slice('tn-frontier-'.length));
  yield* ensureSharedCasBlob(input.casRoot, frontier.manifestDigest, input.coordinatorUrl);
  yield* ensureSharedCasBlob(input.casRoot, frontier.envelopeDigest, input.coordinatorUrl);
  const layout = graphSharingLayout(path, input.threadnoteHome, input.casRoot);
  yield* writePrivateJsonFile(graphSharingFrontierPointerPath(path, layout.frontiersRoot, input.repositoryId), {
    envelopeDigest: frontier.envelopeDigest,
    manifestDigest: frontier.manifestDigest,
    schemaVersion: 1,
  });
});

const refreshFrontierPointerFromOciTag = Effect.fn('codeGraph.sharing.refreshFrontierFromOciTag')(function* (input: {
  readonly casRoot: string;
  readonly coordinatorUrl: string;
  readonly tagName: string;
}) {
  const descriptorDigest = yield* graphShareControlGetTag(input.coordinatorUrl, input.tagName);
  const descriptor = yield* decodeJson(
    yield* ensureSharedCasBlob(input.casRoot, descriptorDigest, input.coordinatorUrl),
    parseGraphShareOciDescriptor,
    'OCI descriptor is invalid.',
  );
  const pointer = graphShareFrontierPointerFromOciDescriptor(descriptor);
  yield* ensureSharedCasBlob(input.casRoot, pointer.metadataDigest, input.coordinatorUrl);
  return pointer;
});

const ensureSharedCasBlob = Effect.fn('codeGraph.sharing.ensureSharedCasBlob')(function* (
  casRoot: string,
  digest: string,
  coordinatorUrl: string | undefined,
) {
  return yield* readVerifiedCasBlob(casRoot, digest).pipe(
    Effect.catchIf(isUnavailableSharingFailure, () =>
      coordinatorUrl === undefined
        ? graphSharingUnavailable(`CAS object is missing: ${digest}`)
        : mirrorCoordinatorCasBlob(casRoot, coordinatorUrl, digest).pipe(
            Effect.andThen(readVerifiedCasBlob(casRoot, digest)),
          ),
    ),
  );
});

function decodeValue<A, I>(parse: (value: I) => A, value: I, message: string) {
  return Effect.try({
    try: () => parse(value),
    catch: cause => (Schema.is(GraphSharingError)(cause) ? cause : graphSharingFailure(message, cause)),
  });
}

export function sharedGraphImportAttemptFrom(result: SharedGraphImportResult): SharedGraphImportAttemptV1 {
  if (result.imported) {
    return {
      imported: true,
      reason: 'imported',
      atGeneration: result.atGeneration,
      checkpointDigest: result.checkpointDigest,
    };
  }
  return {
    imported: false,
    reason: result.reason,
    ...(result.atGeneration === undefined ? {} : {atGeneration: result.atGeneration}),
    ...(result.checkpointDigest === undefined ? {} : {checkpointDigest: result.checkpointDigest}),
  };
}
