import {Crypto, Effect, FileSystem, Path} from 'effect';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {runCodeGraphCheckpointExport} from '../checkpoint/commands.js';
import {SystemInfo} from '../../effect/system.js';
import {resolveRepositoryIdentity} from '../repository.js';
import type {RuntimeConfig} from '../../types.js';
import {
  generateGraphSharePublisherKey,
  parseGraphSharePublisherKey,
  signGraphShareFrontier,
  type GraphShareFrontierManifestV1,
  type GraphSharePublisherKeyV1,
} from './artifacts.js';
import {readJsonFile, writePrivateJsonFile} from './atomic.js';
import {putCasBytes, putCasFile, verifyCasBlob} from './cas.js';
import {parseSha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {graphShareEnrollmentPath, graphSharingFrontierPointerPath, graphSharingLayout} from './layout.js';
import {
  assertEnrollmentMatchesIdentity,
  casProfilePointer,
  defaultGraphShareProfile,
  graphShareProfileDigest,
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  parseGraphShareProfilePointer,
  type GraphShareEnrollmentV1,
  type GraphShareProfileV1,
} from './profile.js';
import {resolveGraphShareCasRoot, writeGraphShareClientState} from './trust.js';

export interface GraphShareInitOptions {
  readonly cas?: string;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly organization?: string;
  readonly writeConfig?: boolean;
}

export interface GraphPublisherBootstrapOptions {
  readonly cas?: string;
  readonly cwd?: string;
  readonly json?: boolean;
}

export const runGraphShareInit = Effect.fn('codeGraph.sharing.init')(function* (
  config: RuntimeConfig,
  options: GraphShareInitOptions,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  if (identity.remoteIdentity === undefined) {
    return yield* graphSharingFailure(
      'Graph share init requires a credential-free origin remote such as github.com/org/repository.',
    );
  }
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  if (options.cas !== undefined) yield* writeGraphShareClientState(config.agentContextHome, casRoot);
  const key = yield* loadOrCreatePublisherKey(config.agentContextHome);
  const branch = identity.branch === undefined ? 'refs/heads/main' : `refs/heads/${identity.branch}`;
  const profile = defaultGraphShareProfile({
    branch,
    canonicalRemote: identity.remoteIdentity,
    organization: options.organization?.trim() || 'local',
    publisherKeyFingerprint: key.fingerprint,
    repositoryId: identity.repositoryId,
  });
  const profileDigest = graphShareProfileDigest(profile);
  yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(profile)));
  const enrollment: GraphShareEnrollmentV1 = {
    profile: casProfilePointer(profileDigest),
    publisherKeyFingerprint: key.fingerprint,
    repositoryId: identity.repositoryId,
    schemaVersion: 1,
  };
  const enrollmentPath = graphShareEnrollmentPath(path, identity.repoRoot);
  if (options.writeConfig) {
    if (yield* fs.exists(enrollmentPath)) {
      return yield* graphSharingFailure(`Enrollment file already exists: ${enrollmentPath}`);
    }
    yield* fs.makeDirectory(path.dirname(enrollmentPath), {recursive: true, mode: 0o755});
    yield* fs.writeFileString(enrollmentPath, `${JSON.stringify(enrollment, undefined, 2)}\n`);
  }
  return {
    enrollment,
    enrollmentPath,
    profileDigest,
    publisherKeyFingerprint: key.fingerprint,
    type: 'code-graph-share-init' as const,
    version: 1 as const,
    written: Boolean(options.writeConfig),
  };
});

export const runGraphPublisherBootstrap = Effect.fn('codeGraph.sharing.publisherBootstrap')(function* (
  config: RuntimeConfig,
  options: GraphPublisherBootstrapOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  if (options.cas !== undefined) yield* writeGraphShareClientState(config.agentContextHome, casRoot);
  const enrollment = parseGraphShareEnrollment(yield* readJsonFile(graphShareEnrollmentPath(path, identity.repoRoot)));
  assertEnrollmentMatchesIdentity(enrollment, identity.repositoryId);
  const key = yield* loadOrCreatePublisherKey(config.agentContextHome);
  if (key.fingerprint !== enrollment.publisherKeyFingerprint) {
    return yield* graphSharingFailure('Publisher key fingerprint does not match enrollment.');
  }
  const pointer = parseGraphShareProfilePointer(enrollment.profile);
  const profile = parseGraphShareProfile(
    JSON.parse(new TextDecoder().decode(yield* verifyCasBlob(casRoot, pointer.digest))) as unknown,
  );
  const profileDigest = graphShareProfileDigest(profile);
  if (profileDigest !== pointer.digest || profile.repositoryId !== enrollment.repositoryId) {
    return yield* graphSharingFailure('Published profile digest does not match enrollment.');
  }
  const spool = path.join(casRoot, 'spool', `${yield* crypto.randomUUIDv4}.cgcp`);
  const exported = yield* runCodeGraphCheckpointExport(config, {cwd, output: spool, quiet: true});
  const checkpointDigest = yield* putCasFile(casRoot, spool);
  yield* fs.remove(spool, {force: true});
  if (checkpointDigest !== parseSha256Digest(exported.artifact.digest)) {
    return yield* graphSharingFailure('Checkpoint CAS digest does not match the exported artifact.');
  }
  const manifest: GraphShareFrontierManifestV1 = {
    branch: profile.source.branches[0] ?? 'refs/heads/main',
    checkpoint: {
      manifestDigest: checkpointDigest,
      snapshotId: exported.snapshotId,
      sourceCommit: exported.sourceCommit,
    },
    deltas: [],
    generation: 1,
    graphAbi: exported.graphAbi,
    graphContentId: exported.graphContentId,
    logicalGraphDigest: parseSha256Digest(exported.logicalDigest),
    previousManifestDigest: null,
    profileDigest,
    publisherFence: 1,
    repositoryId: identity.repositoryId,
    schemaVersion: 1,
    snapshotId: exported.snapshotId,
    sourceCommit: exported.sourceCommit,
  };
  const signed = yield* signGraphShareFrontier(key, manifest);
  const manifestDigest = yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(manifest)));
  const envelopeDigest = yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(signed.envelope)));
  const layout = graphSharingLayout(path, config.agentContextHome, casRoot);
  yield* writePrivateJsonFile(graphSharingFrontierPointerPath(path, layout.frontiersRoot, identity.repositoryId), {
    envelopeDigest,
    manifestDigest,
    schemaVersion: 1,
  });
  return {
    checkpointDigest,
    envelopeDigest,
    manifestDigest,
    profileDigest,
    sourceCommit: exported.sourceCommit,
    type: 'code-graph-publisher-bootstrap' as const,
    version: 1 as const,
  };
});

export const loadOrCreatePublisherKey = Effect.fn('codeGraph.sharing.loadOrCreatePublisherKey')(function* (
  threadnoteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, threadnoteHome);
  if (yield* fs.exists(layout.publisherKeyPath)) {
    return parseGraphSharePublisherKey(yield* readJsonFile(layout.publisherKeyPath));
  }
  const key: GraphSharePublisherKeyV1 = yield* generateGraphSharePublisherKey();
  yield* writePrivateJsonFile(layout.publisherKeyPath, key);
  return key;
});

function commandCwd(value: string | undefined) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return path.resolve(value?.trim() || system.currentDirectory());
  });
}

export type {GraphShareProfileV1};
