import {Effect} from 'effect';
import {GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES} from './descriptor.js';
import {graphSharingFailure} from './errors.js';
import {graphShareProfileDigest, parseGraphShareProfile, type GraphShareProfileV1} from './profile.js';
import {makeGraphShareRegistryReader} from './registry_reader.js';
import {parseGraphShareRegistryTarget} from './registry_reference.js';
import {makeGraphShareRegistryWriter} from './registry_writer.js';
import {sha256Digest} from './digest.js';
import {
  readGraphWorkerResultArtifact,
  verifyGraphWorkerResultIntegrity,
  type createGraphWorkerResultArtifact,
  type GraphWorkerResultAuthority,
} from './worker_result.js';

type Artifact = Effect.Success<ReturnType<typeof createGraphWorkerResultArtifact>>;
type Writer<E, R> = Pick<
  Effect.Success<ReturnType<typeof makeGraphShareRegistryWriter<E, R>>>,
  'putBlob' | 'putManifest'
>;

export const uploadGraphWorkerArtifactClosure = Effect.fn('codeGraph.sharing.uploadWorkerArtifactClosure')(function* <
  E,
  R,
>(input: {
  readonly artifact: Artifact;
  readonly authority: GraphWorkerResultAuthority;
  readonly isAuthorized: Effect.Effect<boolean, E, R>;
  readonly writer: Writer<E, R>;
}) {
  const artifact = {
    attestationBytes: new Uint8Array(input.artifact.attestationBytes),
    manifestBytes: new Uint8Array(input.artifact.manifestBytes),
    manifestDigest: input.artifact.manifestDigest,
    resultBytes: new Uint8Array(input.artifact.resultBytes),
  };
  const authority = {...input.authority};
  yield* verifyGraphWorkerResultIntegrity({...artifact, expected: authority});
  const guard = Effect.gen(function* () {
    if (!(yield* input.isAuthorized))
      return yield* graphSharingFailure('Graph worker delivery is no longer authorized.');
  });
  for (const bytes of [GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES, artifact.resultBytes, artifact.attestationBytes]) {
    yield* guard;
    yield* input.writer.putBlob(sha256Digest(bytes), bytes);
  }
  yield* guard;
  const committed = yield* input.writer.putManifest(artifact.manifestDigest, artifact.manifestBytes);
  if (committed !== artifact.manifestDigest)
    return yield* graphSharingFailure('Graph worker registry manifest acknowledgement is invalid.');
  yield* guard;
  return {manifestDigest: artifact.manifestDigest};
});

export const uploadGraphWorkerArtifactToRegistry = Effect.fn('codeGraph.sharing.uploadWorkerArtifactToRegistry')(
  function* <E, R>(input: {
    readonly artifact: Artifact;
    readonly authority: GraphWorkerResultAuthority;
    readonly isAuthorized: Effect.Effect<boolean, E, R>;
    readonly profile: GraphShareProfileV1;
  }) {
    const authority = {...input.authority};
    const workerRegistry = yield* Effect.try({
      try: () => graphWorkerRegistryForProfile(input.profile, authority),
      catch: cause => graphSharingFailure('Graph worker registry is outside its enrolled scope.', cause),
    });
    const writer = yield* makeGraphShareRegistryWriter(workerRegistry, input.isAuthorized);
    const sent = yield* uploadGraphWorkerArtifactClosure({...input, authority, writer});
    const reader = yield* makeGraphShareRegistryReader(workerRegistry, input.isAuthorized);
    yield* readGraphWorkerResultArtifact(reader, sent.manifestDigest, authority);
    if (!(yield* input.isAuthorized))
      return yield* graphSharingFailure('Graph worker delivery is no longer authorized.');
    return sent;
  },
);

export function graphWorkerRegistryForProfile(
  profileInput: GraphShareProfileV1,
  authority: Pick<GraphWorkerResultAuthority, 'profileDigest' | 'repositoryId'>,
): string {
  const profile = parseGraphShareProfile(profileInput);
  const workerRegistry = profile.registry.worker;
  const canonicalRegistry = profile.registry.canonical;
  if (
    !workerRegistry.startsWith('oci://') ||
    profile.repositoryId !== authority.repositoryId ||
    graphShareProfileDigest(profile) !== authority.profileDigest
  )
    throw graphSharingFailure('Graph worker registry is outside its enrolled scope.');
  const workerTarget = parseGraphShareRegistryTarget(workerRegistry);
  if (canonicalRegistry.startsWith('oci://')) {
    const canonicalTarget = parseGraphShareRegistryTarget(canonicalRegistry);
    if (workerTarget.origin === canonicalTarget.origin && workerTarget.repository === canonicalTarget.repository)
      throw graphSharingFailure('Graph worker registry overlaps the canonical namespace.');
  }
  return workerRegistry;
}
