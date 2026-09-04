import {Clock, Crypto, Effect, FileSystem, Path, Ref} from 'effect';
import {runCodeGraphCheckpointExport} from '../checkpoint/commands.js';
import {CodeGraphIndexer} from '../indexer.js';
import {codeGraphDirectPersistentCapacityProtector} from '../indexer_materialization.js';
import {codeGraphLayout} from '../layout.js';
import {CodeGraphMaintenanceCoordinator} from '../maintenance_coordinator.js';
import {resolveRepositoryIdentity} from '../repository.js';
import {CodeGraphStore} from '../store.js';
import {SystemInfo} from '../../effect/system.js';
import type {RuntimeConfig} from '../../types.js';
import {
  generateGraphSharePublisherKey,
  parseGraphSharePublisherKey,
  parseGraphShareFrontierManifest,
  parseGraphShareFrontierPointer,
  signGraphShareFrontier,
  graphShareFrontierDigest,
  type GraphShareFrontierManifestV1,
  type GraphSharePublisherKeyV1,
} from './artifacts.js';
import {decodeJsonBytes, readJsonFile, writePrivateJsonFile} from './atomic.js';
import {putCasFile, readVerifiedCasBlob} from './cas.js';
import {putGraphShareCheckpointLayers} from './checkpoint_cas.js';
import {putGraphShareOciDescriptor, putSignedGraphShareFrontierDocuments} from './descriptor.js';
import {loadGraphShareCoordinatorState, updateGraphShareCoordinatorMachine} from './control_server.js';
import type {GraphShareCoordinatorStateV1} from './control_protocol.js';
import {parseSha256Digest, type Sha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {
  assembleGraphShareBatch,
  failGraphShareBatch,
  freezeGraphShareBatch,
  observeCanonicalHead,
  publishGraphShareBatch,
  verifyGraphShareBatch,
  type GraphShareFrontierMachineV1,
  type GraphShareFrontierPhase,
  type GraphShareFrontierThresholds,
} from './frontier.js';
import {graphShareCommitDiffStats, graphShareCommitIsAncestor} from './git.js';
import {graphShareEnrollmentPath, graphSharingFrontierPointerPath, graphSharingLayout} from './layout.js';
import {
  hydratePublisherParseCache,
  verifyGraphShareParseReceipt,
  type VerifiedGraphShareParseReceipt,
} from './parse_cache.js';
import {
  assertEnrollmentMatchesIdentity,
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  parseGraphShareProfilePointer,
  type GraphShareProfileV1,
} from './profile.js';
import {selectGraphShareResultsForFrozenMachine} from './receipts.js';
import {resolveGraphShareCasRoot} from './trust.js';
import type {RepositoryIdentity} from '../types.js';

export interface GraphPublisherCycleOptions {
  readonly cas?: string;
  readonly cwd?: string;
  readonly forceFreeze?: boolean;
  readonly json?: boolean;
  readonly listen?: string;
  readonly onMachine?: (machine: GraphShareFrontierMachineV1) => Effect.Effect<void>;
  readonly stateRef?: Ref.Ref<GraphShareCoordinatorStateV1>;
}

const FORCE_FREEZE_THRESHOLDS: GraphShareFrontierThresholds = {
  maximumAgeSeconds: 0,
  maximumChangedBytes: 1,
  maximumChangedFiles: 1,
};

export interface GraphPublisherAdvanceResult {
  readonly checkpointDigest: Sha256Digest;
  readonly descriptorDigest?: Sha256Digest;
  readonly envelopeDigest: Sha256Digest;
  readonly generation: number;
  readonly manifestDigest: Sha256Digest;
  readonly phase: GraphShareFrontierPhase;
  readonly profileDigest: Sha256Digest;
  readonly published: boolean;
  readonly sourceCommit: string;
  readonly type: 'code-graph-publisher-serve';
  readonly version: 1;
}

export const advanceGraphPublisherFrontier = Effect.fn('codeGraph.sharing.advancePublisherFrontier')(function* (
  config: RuntimeConfig,
  options: GraphPublisherCycleOptions,
) {
  const clockNow = yield* Clock.currentTimeMillis;
  const nowSeconds = Math.floor(clockNow / 1_000);
  const cwd = yield* commandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  const path = yield* Path.Path;
  const enrollment = parseGraphShareEnrollment(yield* readJsonFile(graphShareEnrollmentPath(path, identity.repoRoot)));
  assertEnrollmentMatchesIdentity(enrollment, identity.repositoryId);
  const profilePointer = parseGraphShareProfilePointer(enrollment.profile);
  const profile = parseGraphShareProfile(
    yield* decodeJsonBytes(yield* readVerifiedCasBlob(casRoot, profilePointer.digest)),
  );
  const layout = graphSharingLayout(path, config.agentContextHome, casRoot);
  const pointerPath = graphSharingFrontierPointerPath(path, layout.frontiersRoot, identity.repositoryId);
  const pointer = parseGraphShareFrontierPointer(yield* readJsonFile(pointerPath));
  const current = parseGraphShareFrontierManifest(
    yield* decodeJsonBytes(yield* readVerifiedCasBlob(casRoot, pointer.manifestDigest)),
  );
  const coordinatorOptions = {
    organization: profile.organization,
    repositoryId: identity.repositoryId,
    threadnoteHome: config.agentContextHome,
  };
  const coordinator = yield* loadGraphShareCoordinatorState(coordinatorOptions);
  let machine =
    coordinator.machine.generation === 0 && coordinator.machine.publishedFrontier === null
      ? {
          ...coordinator.machine,
          generation: current.generation,
          observedHead: current.sourceCommit,
          phase: 'published' as const,
          previousManifestDigest: pointer.manifestDigest,
          publishedFrontier: current.sourceCommit,
        }
      : coordinator.machine;
  const publishedCommit = machine.publishedFrontier ?? current.sourceCommit;
  const descendant = yield* graphShareCommitIsAncestor(identity.repoRoot, publishedCommit, identity.headCommit);
  machine = observeCanonicalHead(machine, {
    commit: identity.headCommit,
    isDescendantOfPublished: descendant || identity.headCommit === publishedCommit,
    nowSeconds,
  });
  yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
  if (identity.headCommit === publishedCommit) {
    return currentPointer(current, pointer, machine.phase);
  }
  if (!descendant) {
    return currentPointer(current, pointer, machine.phase);
  }
  const stats = yield* graphShareCommitDiffStats(identity.repoRoot, publishedCommit, identity.headCommit);
  const actionKeys = coordinator.receipts.receipts
    .filter(receipt => receipt.batchId === identity.headCommit || receipt.batchId === machine.frozenBatchId)
    .map(receipt => receipt.actionKey);
  machine = freezeGraphShareBatch(machine, {
    actionKeys,
    changedBytes: options.forceFreeze === true ? 1 : stats.changedBytes,
    changedFiles: options.forceFreeze === true ? 1 : stats.changedFiles,
    nowSeconds,
    thresholds: options.forceFreeze === true ? FORCE_FREEZE_THRESHOLDS : profileThresholds(profile),
  });
  yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
  if (machine.phase !== 'frozen') {
    return currentPointer(current, pointer, machine.phase);
  }
  const selected = selectGraphShareResultsForFrozenMachine(coordinator.receipts, machine);
  const verified = [];
  for (const announcement of selected.selected) {
    const receipt = yield* verifyGraphShareParseReceipt({
      announcement,
      casRoot,
      graphAbi: current.graphAbi,
      repositoryId: identity.repositoryId,
    }).pipe(Effect.option);
    if (receipt._tag === 'None') {
      machine = failGraphShareBatch(machine);
      yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
      return currentPointer(current, pointer, machine.phase);
    }
    verified.push(receipt.value);
  }
  yield* hydratePublisherFacts(config, identity, verified).pipe(Effect.ignore);
  const indexer = yield* CodeGraphIndexer;
  yield* indexer.index({cwd, ensureVectors: false, threadnoteHome: config.agentContextHome});
  machine = assembleGraphShareBatch(machine);
  yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
  machine = verifyGraphShareBatch(machine);
  yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
  const published = yield* exportSignedGeneration(config, options, current, identity.repositoryId);
  machine = publishGraphShareBatch(machine, published.manifestDigest);
  yield* persistMachine(coordinatorOptions, machine, options.onMachine, options.stateRef);
  return {
    ...published,
    phase: machine.phase,
    published: true,
    type: 'code-graph-publisher-serve' as const,
    version: 1 as const,
  };
});

function persistMachine(
  options: {readonly organization: string; readonly repositoryId: string; readonly threadnoteHome: string},
  machine: GraphShareFrontierMachineV1,
  onMachine?: (machine: GraphShareFrontierMachineV1) => Effect.Effect<void>,
  stateRef?: Ref.Ref<GraphShareCoordinatorStateV1>,
) {
  return updateGraphShareCoordinatorMachine(options, machine, stateRef).pipe(
    Effect.andThen(onMachine?.(machine) ?? Effect.void),
  );
}

function profileThresholds(profile: GraphShareProfileV1): GraphShareFrontierThresholds {
  return {
    maximumAgeSeconds: profile.frontier.batchMaximumAgeSeconds,
    maximumChangedBytes: profile.frontier.batchMaximumChangedBytes,
    maximumChangedFiles: profile.frontier.batchMaximumChangedFiles,
  };
}

function currentPointer(
  current: GraphShareFrontierManifestV1,
  pointer: {readonly envelopeDigest: Sha256Digest; readonly manifestDigest: Sha256Digest},
  phase: GraphShareFrontierPhase,
): GraphPublisherAdvanceResult {
  return {
    checkpointDigest: current.checkpoint.manifestDigest,
    envelopeDigest: pointer.envelopeDigest,
    generation: current.generation,
    manifestDigest: pointer.manifestDigest,
    phase,
    profileDigest: current.profileDigest,
    published: false,
    sourceCommit: current.sourceCommit,
    type: 'code-graph-publisher-serve',
    version: 1,
  };
}

export const ensureGraphSharePublishedOciDescriptor = Effect.fn('codeGraph.sharing.ensurePublishedOciDescriptor')(
  function* (
    casRoot: string,
    pointer: {readonly envelopeDigest: Sha256Digest; readonly manifestDigest: Sha256Digest},
    metadataDigest: Sha256Digest,
  ) {
    return yield* putGraphShareOciDescriptor(casRoot, {
      envelope: yield* readVerifiedCasBlob(casRoot, pointer.envelopeDigest),
      frontier: yield* readVerifiedCasBlob(casRoot, pointer.manifestDigest),
      metadata: yield* readVerifiedCasBlob(casRoot, metadataDigest),
    });
  },
);

const hydratePublisherFacts = Effect.fn('codeGraph.sharing.hydratePublisherFacts')(function* (
  config: RuntimeConfig,
  identity: RepositoryIdentity,
  verified: readonly VerifiedGraphShareParseReceipt[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const maintenance = yield* CodeGraphMaintenanceCoordinator;
  const crypto = yield* Crypto.Crypto;
  const system = yield* SystemInfo;
  const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
  return yield* hydratePublisherParseCache({
    databasePath: layout.databasePath,
    persistentCapacityProtector: codeGraphDirectPersistentCapacityProtector({
      capacityProtection: {
        availableDiskBytes: (target: string) => system.availableDiskBytes(target),
        crypto,
        maintenance,
        path,
        system,
        temporaryDirectory: system.tempDirectory,
        walAutoCheckpointPages: 1_000,
      },
      fs,
      identity,
      layout,
      threadnoteHome: config.agentContextHome,
    }),
    store,
    verified,
  });
});

const exportSignedGeneration = Effect.fn('codeGraph.sharing.exportSignedGeneration')(function* (
  config: RuntimeConfig,
  options: GraphPublisherCycleOptions,
  current: GraphShareFrontierManifestV1,
  repositoryId: string,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* commandCwd(options.cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  const key = yield* loadPublisherKey(config.agentContextHome);
  const spool = path.join(casRoot, 'spool', `${yield* crypto.randomUUIDv4}.cgcp`);
  const exported = yield* runCodeGraphCheckpointExport(config, {cwd, output: spool, quiet: true});
  const checkpointDigest = yield* putCasFile(casRoot, spool);
  yield* fs.remove(spool, {force: true});
  if (checkpointDigest !== parseSha256Digest(exported.artifact.digest)) {
    return yield* graphSharingFailure('Checkpoint CAS digest does not match the exported artifact.');
  }
  const layers = yield* putGraphShareCheckpointLayers(casRoot, checkpointDigest);
  const signed = yield* signGraphShareFrontier(key, {
    branch: current.branch,
    checkpoint: {
      manifestDigest: checkpointDigest,
      metadataDigest: layers.metadataDigest,
      snapshotId: exported.snapshotId,
      sourceCommit: exported.sourceCommit,
    },
    deltas: [],
    generation: current.generation + 1,
    graphAbi: exported.graphAbi,
    graphContentId: exported.graphContentId,
    logicalGraphDigest: parseSha256Digest(exported.logicalDigest),
    previousManifestDigest: graphShareFrontierDigest(current),
    profileDigest: current.profileDigest,
    publisherFence: current.publisherFence,
    repositoryId,
    schemaVersion: 1,
    snapshotId: exported.snapshotId,
    sourceCommit: exported.sourceCommit,
  });
  const metadataBytes = yield* readVerifiedCasBlob(casRoot, layers.metadataDigest);
  const documents = yield* putSignedGraphShareFrontierDocuments(casRoot, signed, metadataBytes);
  const layout = graphSharingLayout(path, config.agentContextHome, casRoot);
  yield* writePrivateJsonFile(graphSharingFrontierPointerPath(path, layout.frontiersRoot, repositoryId), {
    envelopeDigest: documents.envelopeDigest,
    manifestDigest: documents.manifestDigest,
    schemaVersion: 1,
  });
  return {
    checkpointDigest,
    descriptorDigest: documents.descriptorDigest,
    envelopeDigest: documents.envelopeDigest,
    generation: current.generation + 1,
    manifestDigest: documents.manifestDigest,
    profileDigest: current.profileDigest,
    sourceCommit: exported.sourceCommit,
  };
});

const loadPublisherKey = Effect.fn('codeGraph.sharing.cycleLoadPublisherKey')(function* (threadnoteHome: string) {
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
