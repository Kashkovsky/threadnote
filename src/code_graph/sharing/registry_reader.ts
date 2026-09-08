import {Effect} from 'effect';
import {GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE, parseGraphShareFrontierManifest} from './artifacts.js';
import {decodeJsonBytes} from './atomic.js';
import {putCasBytes} from './cas.js';
import {parseGraphShareCheckpointMetadata} from './checkpoint_cas.js';
import {graphShareFrontierPointerFromOciDescriptor, parseGraphShareOciDescriptor} from './descriptor.js';
import {parseSha256Digest, sha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {
  GRAPH_SHARE_HTTP_CAS_MAX_BYTES,
  assertGraphShareDiscoveryTag,
  graphSharePayloadLooksLikeGitObject,
} from './oci.js';
import {makeGraphShareRegistryHttp} from './registry_http.js';
import {parseGraphShareRegistryTarget} from './registry_reference.js';

export const makeGraphShareRegistryReader = Effect.fn('codeGraph.sharing.registryReader')(function* (
  reference: string,
) {
  const target = yield* Effect.try({
    try: () => parseGraphShareRegistryTarget(reference),
    catch: () => graphSharingFailure('OCI registry reference is invalid.'),
  });
  const request = yield* makeGraphShareRegistryHttp(target);
  return {
    readBlob: (digest: string, expectedSize?: number) =>
      Effect.gen(function* () {
        const expected = yield* Effect.try({
          try: () => parseSha256Digest(digest),
          catch: () => graphSharingFailure('Registry blob digest is invalid.'),
        });
        if (
          expectedSize !== undefined &&
          (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > GRAPH_SHARE_HTTP_CAS_MAX_BYTES)
        ) {
          return yield* graphSharingFailure('Registry blob size is invalid.');
        }
        const response = yield* request(
          `/v2/${target.repository}/blobs/${expected}`,
          expectedSize ?? GRAPH_SHARE_HTTP_CAS_MAX_BYTES,
          'application/octet-stream',
        );
        if (
          sha256Digest(response.bytes) !== expected ||
          (expectedSize !== undefined && response.bytes.byteLength !== expectedSize) ||
          (response.headers['docker-content-digest'] !== undefined &&
            response.headers['docker-content-digest'] !== expected) ||
          graphSharePayloadLooksLikeGitObject(response.bytes)
        ) {
          return yield* graphSharingFailure('Registry blob verification failed.');
        }
        return response.bytes;
      }),
    readManifest: (tag: string) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => assertGraphShareDiscoveryTag(tag),
          catch: () => graphSharingFailure('Registry discovery tag is invalid.'),
        });
        const response = yield* request(
          `/v2/${target.repository}/manifests/${tag}`,
          1_048_576,
          GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
        );
        const digest = sha256Digest(response.bytes);
        if (
          response.headers['content-type']?.split(';')[0]?.trim() !== GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE ||
          (response.headers['docker-content-digest'] !== undefined &&
            response.headers['docker-content-digest'] !== digest)
        ) {
          return yield* graphSharingFailure('Registry manifest verification failed.');
        }
        const json = yield* decodeJsonBytes(response.bytes).pipe(
          Effect.mapError(() => graphSharingFailure('Registry manifest is invalid.')),
        );
        const descriptor = yield* Effect.try({
          try: () => parseGraphShareOciDescriptor(json),
          catch: () => graphSharingFailure('Registry manifest is unsupported.'),
        });
        return {bytes: response.bytes, descriptor, digest};
      }),
  };
});

export type GraphShareRegistryReader = Effect.Success<ReturnType<typeof makeGraphShareRegistryReader>>;

export const discoverGraphShareRegistryFrontier = Effect.fn('codeGraph.sharing.discoverRegistryFrontier')(function* (
  casRoot: string,
  reader: GraphShareRegistryReader,
  tag: string,
) {
  const manifest = yield* reader.readManifest(tag);
  const blobs: Uint8Array[] = [];
  for (const entry of [manifest.descriptor.config, ...manifest.descriptor.layers]) {
    const bytes = yield* reader.readBlob(entry.digest, entry.size);
    if (bytes.byteLength !== entry.size)
      return yield* graphSharingFailure('Registry layer size does not match its descriptor.');
    yield* putCasBytes(casRoot, bytes);
    blobs.push(bytes);
  }
  const pointer = graphShareFrontierPointerFromOciDescriptor(manifest.descriptor);
  const frontierJson = yield* decodeJsonBytes(blobs[1]);
  const metadataJson = yield* decodeJsonBytes(blobs[3]);
  const frontier = yield* Effect.try({
    try: () => parseGraphShareFrontierManifest(frontierJson),
    catch: () => graphSharingFailure('Registry frontier is invalid.'),
  });
  const metadata = yield* Effect.try({
    try: () => parseGraphShareCheckpointMetadata(metadataJson),
    catch: () => graphSharingFailure('Registry checkpoint metadata is invalid.'),
  });
  if (
    metadata.artifactDigest !== frontier.checkpoint.manifestDigest ||
    (frontier.checkpoint.metadataDigest !== undefined && frontier.checkpoint.metadataDigest !== pointer.metadataDigest)
  ) {
    return yield* graphSharingFailure('Registry checkpoint metadata is not covered by the frontier.');
  }
  yield* putCasBytes(casRoot, manifest.bytes);
  return {...pointer, schemaVersion: 1 as const};
});
