import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {
  GRAPH_SHARE_ATTESTATION_MEDIA_TYPE,
  GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE,
  GRAPH_SHARE_FRONTIER_MEDIA_TYPE,
  GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE,
  GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  GRAPH_SHARE_RECORDS_MEDIA_TYPE,
  GRAPH_SHARE_TCG1_MEDIA_TYPE,
  generateGraphSharePublisherKey,
  parseGraphShareFrontierManifest,
  signGraphShareFrontier,
  type GraphShareFrontierManifestV1,
} from '../../src/code_graph/sharing/artifacts.js';
import {parseGraphShareCheckpointMetadata} from '../../src/code_graph/sharing/checkpoint_cas.js';
import {
  GRAPH_SHARE_OCTET_STREAM_MEDIA_TYPE,
  graphShareFrontierPointerFromOciDescriptor,
  graphShareOciDescriptorCanonicalBytes,
  graphShareOciDescriptorFromLayers,
  graphShareOciLayerMediaTypes,
  graphShareProductionLayerMediaTypesUseRecords,
  parseGraphShareOciDescriptor,
  putSignedGraphShareFrontierDocuments,
} from '../../src/code_graph/sharing/descriptor.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES} from '../../src/code_graph/sharing/oci.js';
import {SystemInfo} from '../../src/effect/system.js';

const sharingLayer = Layer.mergeAll(BunServices.layer, BunHttpClient.layer, SystemInfo.layer);
const UTF8 = new TextEncoder();

const MANIFEST: GraphShareFrontierManifestV1 = {
  branch: 'refs/heads/main',
  checkpoint: {
    manifestDigest: `sha256:${'1'.repeat(64)}`,
    metadataDigest: `sha256:${'4'.repeat(64)}`,
    snapshotId: 'cgsn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceCommit: 'a'.repeat(40),
  },
  deltas: [],
  generation: 1,
  graphAbi: 'c'.repeat(64),
  graphContentId: 'cgc_' + 'd'.repeat(40),
  logicalGraphDigest: `sha256:${'2'.repeat(64)}`,
  previousManifestDigest: null,
  profileDigest: `sha256:${'3'.repeat(64)}`,
  publisherFence: 1,
  repositoryId: 'e'.repeat(64),
  schemaVersion: 1,
  snapshotId: 'cgsn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sourceCommit: 'a'.repeat(40),
};

describe('graph share OCI descriptor documents', () => {
  effectIt.effect('stores a parseable image manifest whose layer digests match body, envelope, and metadata', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-oci-'});
      const casRoot = path.join(home, 'cas');
      const metadata = {
        artifactDigest: sha256Digest('artifact'),
        chunks: [{digest: sha256Digest('frame-0'), ordinal: 0}],
        mediaType: GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE,
        prefixDigest: sha256Digest('prefix'),
        schemaVersion: 1 as const,
      };
      const metadataBytes = UTF8.encode(canonicalJson(metadata));
      const key = yield* generateGraphSharePublisherKey();
      const signed = yield* signGraphShareFrontier(key, MANIFEST);
      const published = yield* putSignedGraphShareFrontierDocuments(casRoot, signed, metadataBytes);
      expect(published.manifestDigest).toBe(sha256Digest(UTF8.encode(canonicalJson(signed.manifest))));
      expect(published.envelopeDigest).toBe(sha256Digest(UTF8.encode(canonicalJson(signed.envelope))));
      const parsed = parseGraphShareOciDescriptor(JSON.parse(canonicalJson(published.descriptor)) as unknown);
      expect(parsed).toEqual(published.descriptor);
      expect(parsed.mediaType).toBe(GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE);
      expect(parsed.artifactType).toBe(GRAPH_SHARE_FRONTIER_MEDIA_TYPE);
      expect(parsed.config.mediaType).toBe(GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE);
      expect(parsed.layers[0]).toMatchObject({
        digest: published.manifestDigest,
        mediaType: GRAPH_SHARE_FRONTIER_MEDIA_TYPE,
      });
      expect(parsed.layers[1]).toMatchObject({
        digest: published.envelopeDigest,
        mediaType: GRAPH_SHARE_ATTESTATION_MEDIA_TYPE,
      });
      expect(parsed.layers[2]).toMatchObject({
        digest: sha256Digest(metadataBytes),
        mediaType: GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE,
      });
      const pointer = graphShareFrontierPointerFromOciDescriptor(parsed);
      expect(pointer.manifestDigest).toBe(published.manifestDigest);
      expect(pointer.envelopeDigest).toBe(published.envelopeDigest);
      expect(parseGraphShareFrontierManifest(JSON.parse(canonicalJson(signed.manifest)) as unknown)).toEqual(
        signed.manifest,
      );
      expect(parseGraphShareCheckpointMetadata(JSON.parse(canonicalJson(metadata)) as unknown)).toEqual(metadata);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('rejects source fields, git-object keys, and the unused records media type', () =>
    Effect.sync(() => {
      const layers = {
        envelope: UTF8.encode('{"algorithm":"ed25519"}'),
        frontier: UTF8.encode(canonicalJson(MANIFEST)),
        metadata: UTF8.encode('{"schemaVersion":1}'),
      };
      const descriptor = graphShareOciDescriptorFromLayers(layers);
      const serialized = canonicalJson(descriptor);
      expect(serialized).not.toMatch(/sourceText|"source"|gitTree|blob |commit |tag |tree /u);
      expect(graphShareProductionLayerMediaTypesUseRecords(graphShareOciLayerMediaTypes(descriptor))).toBe(false);
      expect(graphShareProductionLayerMediaTypesUseRecords([GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE])).toBe(false);
      expect(GRAPH_SHARE_TCG1_MEDIA_TYPE).not.toBe(GRAPH_SHARE_RECORDS_MEDIA_TYPE);
      expect(GRAPH_SHARE_OCTET_STREAM_MEDIA_TYPE).not.toBe(GRAPH_SHARE_RECORDS_MEDIA_TYPE);
      expect(() => parseGraphShareOciDescriptor({...descriptor, source: 'fn main() {}'})).toThrow(/source or Git/i);
      expect(() => parseGraphShareOciDescriptor({...descriptor, gitTree: 'a'.repeat(40)})).toThrow(/source or Git/i);
      expect(() =>
        parseGraphShareOciDescriptor({
          ...descriptor,
          layers: [
            {...descriptor.layers[0], mediaType: GRAPH_SHARE_RECORDS_MEDIA_TYPE},
            descriptor.layers[1],
            descriptor.layers[2],
          ],
        }),
      ).toThrow(/unused records media type/i);
    }),
  );

  effectIt.effect.prop(
    'descriptor canonical JSON is idempotent and every layer stays at or under 32 MiB',
    {
      envelope: FC.uint8Array({maxLength: 64, minLength: 1}),
      frontier: FC.uint8Array({maxLength: 64, minLength: 1}),
      metadata: FC.uint8Array({maxLength: 64, minLength: 1}),
    },
    ({envelope, frontier, metadata}) =>
      Effect.sync(() => {
        const descriptor = graphShareOciDescriptorFromLayers({envelope, frontier, metadata});
        const once = canonicalJson(descriptor);
        const twice = canonicalJson(parseGraphShareOciDescriptor(JSON.parse(once) as unknown));
        expect(twice).toBe(once);
        expect(new TextDecoder().decode(graphShareOciDescriptorCanonicalBytes(descriptor))).toBe(once);
        for (const layer of descriptor.layers) {
          expect(layer.size).toBeLessThanOrEqual(GRAPH_SHARE_HTTP_CAS_MAX_BYTES);
        }
        expect(descriptor.config.size).toBeLessThanOrEqual(GRAPH_SHARE_HTTP_CAS_MAX_BYTES);
      }),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('rejects a layer larger than the HTTP CAS cap', () =>
    Effect.sync(() => {
      expect(() =>
        graphShareOciDescriptorFromLayers({
          envelope: UTF8.encode('envelope'),
          frontier: new Uint8Array(GRAPH_SHARE_HTTP_CAS_MAX_BYTES + 1),
          metadata: UTF8.encode('metadata'),
        }),
      ).toThrow(/HTTP transfer limit/i);
    }),
  );
});
