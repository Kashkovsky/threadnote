import {Effect} from 'effect';
import {GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES, GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST} from './descriptor.js';
import type {GraphShareRegistryPublication} from './registry_closure.js';
import type {makeGraphShareRegistryWriter} from './registry_writer.js';

type Writer = Pick<Effect.Success<ReturnType<typeof makeGraphShareRegistryWriter>>, 'putBlob' | 'putManifest'>;

export const uploadGraphShareRegistryArtifacts = Effect.fn('codeGraph.sharing.uploadRegistryArtifacts')(function* <
  E,
  R,
>(
  publication: Pick<GraphShareRegistryPublication, 'descriptorBytes' | 'descriptorDigest' | 'retention'>,
  writer: Writer,
  readBlob: (digest: string, maximum: number) => Effect.Effect<Uint8Array, E, R>,
) {
  // Eight in-flight blobs bound transfer fan-out and avoid serial HEAD retry starvation.
  yield* Effect.forEach(
    publication.retention.entries,
    entry =>
      Effect.gen(function* () {
        const bytes =
          entry.digest === GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST
            ? GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES
            : entry.digest === publication.descriptorDigest
              ? publication.descriptorBytes
              : yield* readBlob(entry.digest, entry.size);
        yield* writer.putBlob(entry.digest, bytes);
      }),
    {concurrency: 8, discard: true},
  );
  yield* writer.putManifest(publication.retention.tag, publication.retention.bytes);
  yield* writer.putManifest(publication.descriptorDigest, publication.descriptorBytes);
});
