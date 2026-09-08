import {Effect, FileSystem, Path} from 'effect';
import {SystemInfo} from '../../effect/system.js';
import type {RuntimeConfig} from '../../types.js';
import {resolveRepositoryIdentity} from '../repository.js';
import {decodeJsonBytes, readBoundedPrivateBytes, readJsonFile} from './atomic.js';
import {readVerifiedCasBlob} from './cas.js';
import {graphShareEnrollmentPath, graphSharingFrontierPointerPath, graphSharingLayout} from './layout.js';
import {parseGraphShareFrontierPointer} from './artifacts.js';
import {readAuthenticatedGraphShareFrontier} from './frontier_acceptance.js';
import {graphSharingFailure} from './errors.js';
import {
  assertEnrollmentMatchesIdentity,
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  parseGraphShareProfilePointer,
} from './profile.js';
import {
  graphShareRegistryPublicationScope,
  publishGraphShareRegistryFrontier,
  type GraphShareRegistryPublicationResult,
} from './registry_publication.js';
import {graphSharePublicationAuthority, readGraphSharePublicationReceipt} from './registry_publication_state.js';
import {resolveGraphShareCasRoot} from './trust.js';

const loadGraphPublisherRegistry = Effect.fn('codeGraph.sharing.loadPublisherRegistry')(function* (
  config: RuntimeConfig,
  options: {readonly cas?: string; readonly cwd?: string},
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const cwd = path.resolve(options.cwd?.trim() || system.currentDirectory());
  const identity = yield* resolveRepositoryIdentity(cwd);
  const casRoot = yield* resolveGraphShareCasRoot(config.agentContextHome, options.cas);
  const enrollmentPath = graphShareEnrollmentPath(path, identity.repoRoot);
  if (!(yield* (yield* FileSystem.FileSystem).exists(enrollmentPath))) return undefined;
  const enrollment = parseGraphShareEnrollment(yield* readJsonFile(enrollmentPath));
  assertEnrollmentMatchesIdentity(enrollment, identity.repositoryId);
  const profile = parseGraphShareProfile(
    yield* decodeJsonBytes(
      yield* readVerifiedCasBlob(casRoot, parseGraphShareProfilePointer(enrollment.profile).digest),
    ),
  );
  const scope = graphShareRegistryPublicationScope({enrollment, profile});
  return {home: config.agentContextHome, casRoot, enrollment, profile, scope};
});

export const completeGraphPublisherRegistryPublication = Effect.fn('codeGraph.sharing.completeRegistryPublication')(
  function* (config: RuntimeConfig, options: {readonly cas?: string; readonly cwd?: string}) {
    const input = yield* loadGraphPublisherRegistry(config, options);
    if (input === undefined) return yield* graphSharingFailure('Publisher repository is not enrolled.');
    return yield* publishGraphShareRegistryFrontier(input);
  },
);

interface PublisherStatus {
  readonly enrolled: boolean;
  readonly localCandidate?: {
    readonly generation: number;
    readonly manifestDigest: string;
    readonly sourceCommit: string;
  };
  readonly publication?: GraphShareRegistryPublicationResult;
  readonly type: 'code-graph-publisher-status';
  readonly version: 1;
}

export const readGraphPublisherRegistryStatus = Effect.fn('codeGraph.sharing.publisherRegistryStatus')(function* (
  config: RuntimeConfig,
  options: {readonly cas?: string; readonly cwd?: string},
) {
  const input = yield* loadGraphPublisherRegistry(config, options);
  if (input === undefined) {
    const unenrolled: PublisherStatus = {enrolled: false, type: 'code-graph-publisher-status', version: 1};
    return unenrolled;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pointerPath = graphSharingFrontierPointerPath(
    path,
    graphSharingLayout(path, input.home, input.casRoot).frontiersRoot,
    input.scope.repositoryId,
  );
  const pointer = (yield* fs.exists(pointerPath))
    ? parseGraphShareFrontierPointer(yield* decodeJsonBytes(yield* readBoundedPrivateBytes(pointerPath, 4096)))
    : undefined;
  const manifest =
    pointer === undefined ? undefined : yield* readAuthenticatedGraphShareFrontier(input.casRoot, input.scope, pointer);
  const receipt = input.profile.registry.canonical.startsWith('oci://')
    ? yield* readGraphSharePublicationReceipt(
        input.home,
        graphSharePublicationAuthority(input.scope, input.profile.registry.canonical),
      )
    : undefined;
  const publication: GraphShareRegistryPublicationResult =
    receipt === undefined
      ? {status: 'local', changed: false}
      : {
          status:
            receipt.acknowledged !== undefined &&
            receipt.pending === undefined &&
            receipt.nextAttempt === 0 &&
            receipt.acknowledged.manifestDigest === pointer?.manifestDigest &&
            receipt.acknowledged.envelopeDigest === pointer.envelopeDigest
              ? 'acknowledged'
              : 'pending',
          changed: false,
          acknowledged: receipt.acknowledged,
          nextAttempt: receipt.nextAttempt,
          lastFailure: receipt.lastFailure,
        };
  const status: PublisherStatus = {
    enrolled: true,
    localCandidate:
      manifest === undefined || pointer === undefined
        ? undefined
        : {
            generation: manifest.generation,
            manifestDigest: pointer.manifestDigest,
            sourceCommit: manifest.sourceCommit,
          },
    publication,
    type: 'code-graph-publisher-status',
    version: 1,
  };
  return status;
});

export function graphPublisherPublicationMessage(input: {
  readonly generation: number;
  readonly manifestDigest: string;
  readonly sourceCommit: string;
  readonly publication: GraphShareRegistryPublicationResult;
}): string {
  if (input.publication.status === 'pending') {
    const confirmed = input.publication.acknowledged?.generation;
    return `Registry publication pending for local generation ${input.generation}; ${confirmed === undefined ? 'no confirmed remote frontier' : `last confirmed generation ${confirmed}`}.${input.publication.lastFailure === undefined ? '' : ` ${input.publication.lastFailure.message}`}`;
  }
  const selected = input.publication.acknowledged ?? input;
  return `${input.publication.status === 'local' ? 'Prepared local' : 'Published'} generation ${selected.generation} frontier ${selected.manifestDigest} for ${selected.sourceCommit}`;
}
