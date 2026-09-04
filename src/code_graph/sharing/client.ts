import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
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
} from './artifacts.js';
import {readJsonFile, writePrivateBytesFile, writePrivateJsonFile} from './atomic.js';
import {verifyCasBlob} from './cas.js';
import {parseSha256Digest} from './digest.js';
import {GraphSharingError, graphSharingFailure} from './errors.js';
import {graphShareEnrollmentPath, graphSharingFrontierPointerPath, graphSharingLayout} from './layout.js';
import {
  assertEnrollmentMatchesIdentity,
  assertProfileMatchesEnrollment,
  graphShareProfileDigest,
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  parseGraphShareProfilePointer,
  type GraphShareEnrollmentV1,
} from './profile.js';
import {removeSharedGraphProvenance, writeSharedGraphProvenance} from './provenance.js';
import {
  lookupGraphShareTrustReceipt,
  removeGraphShareTrustReceipt,
  resolveGraphShareCasRoot,
  trustReceiptFromEnrollment,
  writeGraphShareClientState,
  writeGraphShareTrustReceipt,
  type GraphShareAccessMode,
} from './trust.js';

export interface GraphShareJoinOptions {
  readonly cas?: string;
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

const sharingProgress = (
  onProgress: SharedGraphImportRequest['onProgress'],
  subphase: 'applying-deltas' | 'building-local-overlay' | 'discovering-shared-base' | 'downloading-checkpoint',
) => onProgress?.({phase: 'sharing', subphase}) ?? Effect.void;

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
  const profile = parseGraphShareProfile(
    JSON.parse(new TextDecoder().decode(yield* verifyCasBlob(casRoot, pointer.digest))) as unknown,
  );
  const profileDigest = graphShareProfileDigest(profile);
  assertProfileMatchesEnrollment(profile, enrollment, profileDigest);
  const accessMode: GraphShareAccessMode = options.readOnly ? 'read-only' : 'join';
  const receipt = yield* writeGraphShareTrustReceipt(
    config.agentContextHome,
    trustReceiptFromEnrollment(enrollment, profile, profileDigest, accessMode),
  );
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
  if (options.purge) yield* removeSharedGraphProvenance(config.agentContextHome, identity.checkoutId);
  return {
    purged: Boolean(options.purge),
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
  const casRoot = yield* resolveGraphShareCasRoot(request.threadnoteHome);
  yield* sharingProgress(request.onProgress, 'downloading-checkpoint');
  return yield* importVerifiedSharedCheckpoint({
    casRoot,
    enrollment: enrollment.value,
    request,
  }).pipe(
    Effect.catch(() =>
      quarantineSharedFailure(request.threadnoteHome, 'Shared graph import failed.').pipe(
        Effect.as({imported: false as const, reason: 'quarantined' as const}),
      ),
    ),
  );
});

const importVerifiedSharedCheckpoint = Effect.fn('codeGraph.sharing.importVerifiedCheckpoint')(function* (input: {
  readonly casRoot: string;
  readonly enrollment: GraphShareEnrollmentV1;
  readonly request: SharedGraphImportRequest;
}) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pointer = yield* decodeValue(
    parseGraphShareProfilePointer,
    input.enrollment.profile,
    'Enrollment profile pointer is invalid.',
  );
  const profile = yield* decodeJson(
    yield* verifyCasBlob(input.casRoot, pointer.digest),
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
  const layout = graphSharingLayout(path, input.request.threadnoteHome, input.casRoot);
  const frontierPointer = yield* decodeValue(
    parseGraphShareFrontierPointer,
    yield* readJsonFile(
      graphSharingFrontierPointerPath(path, layout.frontiersRoot, input.request.identity.repositoryId),
    ),
    'Frontier pointer is invalid.',
  );
  const manifest = yield* decodeJson(
    yield* verifyCasBlob(input.casRoot, frontierPointer.manifestDigest),
    parseGraphShareFrontierManifest,
    'Frontier manifest is invalid.',
  );
  const envelope = yield* decodeJson(
    yield* verifyCasBlob(input.casRoot, frontierPointer.envelopeDigest),
    parseGraphShareSignatureEnvelope,
    'Frontier signature envelope is invalid.',
  );
  yield* verifyGraphShareFrontier(parseSha256Digest(input.enrollment.publisherKeyFingerprint), manifest, envelope);
  if (manifest.repositoryId !== input.request.identity.repositoryId || manifest.profileDigest !== profileDigest) {
    return yield* graphSharingFailure('Frontier manifest does not match the enrolled repository profile.');
  }
  const checkpointBytes = yield* verifyCasBlob(input.casRoot, manifest.checkpoint.manifestDigest);
  const spool = path.join(layout.root, 'downloads', `${yield* crypto.randomUUIDv4}.cgcp`);
  yield* writePrivateBytesFile(spool, checkpointBytes);
  yield* sharingProgress(input.request.onProgress, 'applying-deltas');
  const imported = yield* importCodeGraphCheckpointSnapshot(runtimeConfigForHome(input.request.threadnoteHome), {
    cwd: input.request.cwd,
    expectedDigest: manifest.checkpoint.manifestDigest,
    followOnIndex: false,
    input: spool,
    quiet: true,
  });
  yield* fs.remove(spool, {force: true});
  yield* sharingProgress(input.request.onProgress, 'building-local-overlay');
  yield* writeSharedGraphProvenance(input.request.threadnoteHome, input.request.identity.checkoutId, {
    checkpointDigest: manifest.checkpoint.manifestDigest,
    frontierCommit: manifest.sourceCommit,
    profileDigest,
    repositoryId: input.request.identity.repositoryId,
    schemaVersion: 1,
    snapshotId: imported.result.snapshotId,
  });
  return {imported: true as const, snapshotId: imported.result.snapshotId};
});

const quarantineSharedFailure = Effect.fn('codeGraph.sharing.quarantine')(function* (
  threadnoteHome: string,
  cause: unknown,
) {
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const layout = graphSharingLayout(path, threadnoteHome);
  const message = cause instanceof Error ? cause.message : String(cause);
  yield* writePrivateJsonFile(path.join(layout.quarantineRoot, `${yield* crypto.randomUUIDv4}.json`), {
    message,
    schemaVersion: 1,
  });
});

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

function decodeJson<A>(bytes: Uint8Array, parse: (value: unknown) => A, message: string) {
  return decodeValue(text => parse(JSON.parse(new TextDecoder().decode(text)) as unknown), bytes, message);
}

function decodeValue<A, I>(parse: (value: I) => A, value: I, message: string) {
  return Effect.try({
    try: () => parse(value),
    catch: cause => (Schema.is(GraphSharingError)(cause) ? cause : graphSharingFailure(message, cause)),
  });
}
