import {Crypto, Effect, FileSystem, Path} from 'effect';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {runCodeGraphCheckpointExport} from '../checkpoint/commands.js';
import type {CliOutput} from '../../effect/cli_output.js';
import {SystemInfo} from '../../effect/system.js';
import {resolveRepositoryIdentity} from '../repository.js';
import type {RuntimeConfig} from '../../types.js';
import {
  generateGraphSharePublisherKey,
  parseGraphShareFrontierManifest,
  parseGraphShareFrontierPointer,
  parseGraphSharePublisherKey,
  signGraphShareFrontier,
  type GraphShareFrontierManifestV1,
  type GraphSharePublisherKeyV1,
} from './artifacts.js';
import {decodeJsonBytes, readJsonFile, writePrivateJsonFile} from './atomic.js';
import {putCasBytes, putCasFile, readVerifiedCasBlob} from './cas.js';
import {putGraphShareCheckpointLayers} from './checkpoint_cas.js';
import {putSignedGraphShareFrontierDocuments} from './descriptor.js';
import {parseSha256Digest, type Sha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {parseGraphShareListenAddress, recordPublishedFrontier, runGraphShareControlServer} from './control_server.js';
import {graphShareEnrollmentPath, graphSharingFrontierPointerPath, graphSharingLayout} from './layout.js';
import {
  assertEnrollmentMatchesIdentity,
  casProfilePointer,
  defaultGraphShareProfile,
  graphShareProfileDigest,
  parseGraphShareCoordinatorUrl,
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  parseGraphShareProfilePointer,
  type GraphShareEnrollmentV1,
  type GraphShareProfileV1,
} from './profile.js';
import {advanceGraphPublisherFrontier, ensureGraphSharePublishedOciDescriptor} from './publisher_cycle.js';
import {resolveGraphShareCasRoot, writeGraphShareClientState} from './trust.js';

export interface GraphShareInitOptions {
  readonly cas?: string;
  readonly coordinator?: string;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly organization?: string;
  readonly writeConfig?: boolean;
}

export interface GraphPublisherBootstrapOptions {
  readonly cas?: string;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly listen?: string;
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
    ...(options.coordinator === undefined ? {} : {coordinatorUrl: parseGraphShareCoordinatorUrl(options.coordinator)}),
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
  const profile = parseGraphShareProfile(yield* decodeJsonBytes(yield* readVerifiedCasBlob(casRoot, pointer.digest)));
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
  const layers = yield* putGraphShareCheckpointLayers(casRoot, checkpointDigest);
  const signed = yield* signGraphShareFrontier(
    key,
    manifestFromExport(exported, checkpointDigest, layers.metadataDigest, {
      branch: profile.source.branches[0] ?? 'refs/heads/main',
      generation: 1,
      previousManifestDigest: null,
      profileDigest,
      publisherFence: 1,
      repositoryId: identity.repositoryId,
    }),
  );
  const metadataBytes = yield* readVerifiedCasBlob(casRoot, layers.metadataDigest);
  const documents = yield* putSignedGraphShareFrontierDocuments(casRoot, signed, metadataBytes);
  const layout = graphSharingLayout(path, config.agentContextHome, casRoot);
  yield* writePrivateJsonFile(graphSharingFrontierPointerPath(path, layout.frontiersRoot, identity.repositoryId), {
    envelopeDigest: documents.envelopeDigest,
    manifestDigest: documents.manifestDigest,
    schemaVersion: 1,
  });
  return {
    checkpointDigest,
    descriptorDigest: documents.descriptorDigest,
    envelopeDigest: documents.envelopeDigest,
    generation: 1,
    manifestDigest: documents.manifestDigest,
    profileDigest,
    sourceCommit: exported.sourceCommit,
    type: 'code-graph-publisher-bootstrap' as const,
    version: 1 as const,
  };
});

export const runGraphPublisherServe = Effect.fn('codeGraph.sharing.publisherServe')(function* (
  config: RuntimeConfig,
  options: GraphPublisherBootstrapOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  if (options.cas !== undefined) yield* writeGraphShareClientState(config.agentContextHome, casRoot);
  const layout = graphSharingLayout(path, config.agentContextHome, casRoot);
  const pointerPath = graphSharingFrontierPointerPath(path, layout.frontiersRoot, identity.repositoryId);
  if (!(yield* fs.exists(pointerPath))) {
    return yield* runGraphPublisherBootstrap(config, options);
  }
  return yield* advanceGraphPublisherFrontier(config, {...options, forceFreeze: true});
});

export const runGraphPublisherListen = Effect.fn('codeGraph.sharing.publisherListen')(function* (
  config: RuntimeConfig,
  options: GraphPublisherBootstrapOptions & {
    readonly listen: string;
    readonly onReady: (output: {
      readonly coordinatorUrl: string;
      readonly envelopeDigest: string;
      readonly generation: number;
      readonly listening: true;
      readonly manifestDigest: string;
      readonly port: number;
      readonly sourceCommit: string;
      readonly type: 'code-graph-publisher-serve';
      readonly version: 1;
    }) => Effect.Effect<void, unknown, CliOutput>;
  },
) {
  const published = yield* runGraphPublisherServe(config, options);
  const path = yield* Path.Path;
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  const enrollment = parseGraphShareEnrollment(yield* readJsonFile(graphShareEnrollmentPath(path, identity.repoRoot)));
  const pointer = parseGraphShareProfilePointer(enrollment.profile);
  const profile = parseGraphShareProfile(yield* decodeJsonBytes(yield* readVerifiedCasBlob(casRoot, pointer.digest)));
  const branch = profile.source.branches[0] ?? 'refs/heads/main';
  const descriptorDigest =
    published.descriptorDigest ??
    (yield* ensureDescriptorForPointer(config.agentContextHome, casRoot, identity.repositoryId, {
      envelopeDigest: published.envelopeDigest,
      manifestDigest: published.manifestDigest,
    })).descriptorDigest;
  yield* recordPublishedFrontier(
    {
      casRoot,
      organization: profile.organization,
      repositoryId: identity.repositoryId,
      threadnoteHome: config.agentContextHome,
    },
    {
      branch,
      descriptorDigest,
      envelopeDigest: published.envelopeDigest,
      generation: published.generation,
      manifestDigest: published.manifestDigest,
      repositoryId: identity.repositoryId,
      sourceCommit: published.sourceCommit,
    },
  );
  return yield* runGraphShareControlServer({
    casRoot,
    listen: parseGraphShareListenAddress(options.listen),
    onListening: info =>
      options.onReady({
        coordinatorUrl: info.url,
        envelopeDigest: published.envelopeDigest,
        generation: published.generation,
        listening: true,
        manifestDigest: published.manifestDigest,
        port: info.port,
        sourceCommit: published.sourceCommit,
        type: 'code-graph-publisher-serve',
        version: 1,
      }),
    organization: profile.organization,
    republish: stateRef =>
      advanceGraphPublisherFrontier(config, {
        ...options,
        forceFreeze: false,
        stateRef,
      }).pipe(
        Effect.map(result => ({
          branch,
          descriptorDigest: result.descriptorDigest,
          envelopeDigest: result.envelopeDigest,
          generation: result.generation,
          manifestDigest: result.manifestDigest,
          published: result.published,
          repositoryId: identity.repositoryId,
          sourceCommit: result.sourceCommit,
        })),
      ),
    repositoryId: identity.repositoryId,
    threadnoteHome: config.agentContextHome,
  });
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

function manifestFromExport(
  exported: {
    readonly graphAbi: string;
    readonly graphContentId: string;
    readonly logicalDigest: string;
    readonly snapshotId: string;
    readonly sourceCommit: string;
  },
  checkpointDigest: Sha256Digest,
  metadataDigest: Sha256Digest,
  meta: {
    readonly branch: string;
    readonly generation: number;
    readonly previousManifestDigest: Sha256Digest | null;
    readonly profileDigest: Sha256Digest;
    readonly publisherFence: number;
    readonly repositoryId: string;
  },
): GraphShareFrontierManifestV1 {
  return {
    branch: meta.branch,
    checkpoint: {
      manifestDigest: checkpointDigest,
      metadataDigest,
      snapshotId: exported.snapshotId,
      sourceCommit: exported.sourceCommit,
    },
    deltas: [],
    generation: meta.generation,
    graphAbi: exported.graphAbi,
    graphContentId: exported.graphContentId,
    logicalGraphDigest: parseSha256Digest(exported.logicalDigest),
    previousManifestDigest: meta.previousManifestDigest,
    profileDigest: meta.profileDigest,
    publisherFence: meta.publisherFence,
    repositoryId: meta.repositoryId,
    schemaVersion: 1,
    snapshotId: exported.snapshotId,
    sourceCommit: exported.sourceCommit,
  };
}

const ensureDescriptorForPointer = Effect.fn('codeGraph.sharing.ensureDescriptorForPointer')(function* (
  threadnoteHome: string,
  casRoot: string,
  repositoryId: string,
  pointer: {readonly envelopeDigest: Sha256Digest; readonly manifestDigest: Sha256Digest},
) {
  const layout = graphSharingLayout(yield* Path.Path, threadnoteHome, casRoot);
  const stored = parseGraphShareFrontierPointer(
    yield* readJsonFile(graphSharingFrontierPointerPath(yield* Path.Path, layout.frontiersRoot, repositoryId)),
  );
  const current = parseGraphShareFrontierManifest(
    yield* decodeJsonBytes(yield* readVerifiedCasBlob(casRoot, stored.manifestDigest)),
  );
  if (current.checkpoint.metadataDigest === undefined) {
    return yield* graphSharingFailure('Published frontier is missing checkpoint metadata for an OCI descriptor.');
  }
  if (stored.manifestDigest !== pointer.manifestDigest || stored.envelopeDigest !== pointer.envelopeDigest) {
    return yield* graphSharingFailure('Frontier pointer does not match the published generation.');
  }
  return yield* ensureGraphSharePublishedOciDescriptor(casRoot, stored, current.checkpoint.metadataDigest);
});

function commandCwd(value: string | undefined) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return path.resolve(value?.trim() || system.currentDirectory());
  });
}

export type {GraphShareProfileV1};
