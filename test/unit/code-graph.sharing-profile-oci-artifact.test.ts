import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {
  GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE,
  GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  GRAPH_SHARE_PROFILE_MEDIA_TYPE,
} from '../../src/code_graph/sharing/artifacts.js';
import {
  GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES,
  GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST,
} from '../../src/code_graph/sharing/descriptor.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {
  GRAPH_SHARE_PROFILE_OCI_BODY_MAX_BYTES,
  GRAPH_SHARE_PROFILE_OCI_MANIFEST_MAX_BYTES,
  graphShareProfileOciArtifact,
  parseGraphShareProfileOciArtifact,
} from '../../src/code_graph/sharing/profile_oci_artifact.js';
import {defaultGraphShareProfile, parseGraphShareProfile} from '../../src/code_graph/sharing/profile.js';

const UTF8 = new TextEncoder();
const PROFILE = defaultGraphShareProfile({
  branch: 'refs/heads/main',
  canonicalRemote: 'github.com/acme/monorepo',
  organization: 'acme',
  publisherKeyFingerprint: `sha256:${'a'.repeat(64)}`,
  repositoryId: 'b'.repeat(64),
});

function manifestFrom(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function withManifest(value: unknown, profileBytes = graphShareProfileOciArtifact(PROFILE).profileBytes) {
  const manifestBytes = UTF8.encode(canonicalJson(value));
  return () => parseGraphShareProfileOciArtifact(manifestBytes, sha256Digest(manifestBytes), profileBytes);
}

describe('OCI graph profile artifact', () => {
  it('publishes one canonical profile layer under a distinct manifest digest', () => {
    const artifact = graphShareProfileOciArtifact(PROFILE);
    const manifest = manifestFrom(artifact.manifestBytes);
    expect(artifact.manifestDigest).toBe(sha256Digest(artifact.manifestBytes));
    expect(artifact.profileDigest).toBe(sha256Digest(artifact.profileBytes));
    expect(artifact.manifestDigest).not.toBe(artifact.profileDigest);
    expect(manifest).toEqual({
      artifactType: GRAPH_SHARE_PROFILE_MEDIA_TYPE,
      config: {
        digest: GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST,
        mediaType: GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE,
        size: GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES.byteLength,
      },
      layers: [
        {
          digest: artifact.profileDigest,
          mediaType: GRAPH_SHARE_PROFILE_MEDIA_TYPE,
          size: artifact.profileBytes.byteLength,
        },
      ],
      mediaType: GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      schemaVersion: 2,
    });
    expect(
      parseGraphShareProfileOciArtifact(artifact.manifestBytes, artifact.manifestDigest, artifact.profileBytes),
    ).toEqual(PROFILE);
  });

  it('is deterministic under object-key reordering without mutating input', () => {
    FC.assert(
      FC.property(FC.boolean(), reversed => {
        const reordered = parseGraphShareProfile(reorderKeys(PROFILE, reversed));
        const before = canonicalJson(reordered);
        const artifact = graphShareProfileOciArtifact(reordered);
        const reference = graphShareProfileOciArtifact(PROFILE);
        expect(artifact.manifestDigest).toBe(reference.manifestDigest);
        expect(artifact.profileDigest).toBe(reference.profileDigest);
        expect(canonicalJson(reordered)).toBe(before);
      }),
      {numRuns: 20},
    );
  });

  it('rejects manifest type, config, layer count, extra fields, and noncanonical bytes', () => {
    const artifact = graphShareProfileOciArtifact(PROFILE);
    const manifest = manifestFrom(artifact.manifestBytes);
    const config = manifest.config as Record<string, unknown>;
    const layer = (manifest.layers as Record<string, unknown>[])[0];
    for (const mutation of [
      {...manifest, artifactType: 'application/octet-stream'},
      {...manifest, mediaType: 'application/vnd.oci.image.index.v1+json'},
      {...manifest, schemaVersion: 1},
      {...manifest, annotations: {name: 'profile'}},
      {...manifest, layers: []},
      {...manifest, layers: [layer, layer]},
      {...manifest, config: {...config, digest: sha256Digest('wrong')}},
      {...manifest, config: {...config, size: 0}},
      {...manifest, config: {...config, mediaType: GRAPH_SHARE_PROFILE_MEDIA_TYPE}},
      {...manifest, config: {...config, annotations: {foo: 'bar'}}},
      {...manifest, layers: [{...layer, digest: sha256Digest('wrong')}]},
      {...manifest, layers: [{...layer, size: artifact.profileBytes.byteLength + 1}]},
      {...manifest, layers: [{...layer, mediaType: 'application/octet-stream'}]},
      {...manifest, layers: [{...layer, annotations: {foo: 'bar'}}]},
    ]) {
      expect(withManifest(mutation)).toThrow();
    }
    expect(() =>
      parseGraphShareProfileOciArtifact(artifact.manifestBytes, artifact.profileDigest, artifact.profileBytes),
    ).toThrow(/manifest digest/i);
    const padded = UTF8.encode(` ${new TextDecoder().decode(artifact.manifestBytes)}`);
    expect(() => parseGraphShareProfileOciArtifact(padded, sha256Digest(padded), artifact.profileBytes)).toThrow(
      /canonical JSON/i,
    );
    const duplicate = UTF8.encode(
      new TextDecoder()
        .decode(artifact.manifestBytes)
        .replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'),
    );
    expect(() => parseGraphShareProfileOciArtifact(duplicate, sha256Digest(duplicate), artifact.profileBytes)).toThrow(
      /canonical JSON/i,
    );
    const oversized = new Uint8Array(GRAPH_SHARE_PROFILE_OCI_MANIFEST_MAX_BYTES + 1);
    expect(() => parseGraphShareProfileOciArtifact(oversized, sha256Digest(oversized), artifact.profileBytes)).toThrow(
      /size is invalid/i,
    );
  });

  it('rejects changed, noncanonical, malformed, or invalid profile bodies', () => {
    const artifact = graphShareProfileOciArtifact(PROFILE);
    const changed = UTF8.encode(canonicalJson({...PROFILE, organization: 'other'}));
    expect(() => parseGraphShareProfileOciArtifact(artifact.manifestBytes, artifact.manifestDigest, changed)).toThrow(
      /layer digest or size/i,
    );
    const padded = UTF8.encode(` ${new TextDecoder().decode(artifact.profileBytes)}`);
    const manifest = manifestFrom(artifact.manifestBytes);
    const layer = (manifest.layers as Record<string, unknown>[])[0];
    const paddedManifest = {...manifest, layers: [{...layer, digest: sha256Digest(padded), size: padded.byteLength}]};
    expect(withManifest(paddedManifest, padded)).toThrow(/canonical JSON/i);
    const malformed = new Uint8Array([0xc3, 0x28]);
    const malformedManifest = {
      ...manifest,
      layers: [{...layer, digest: sha256Digest(malformed), size: malformed.byteLength}],
    };
    expect(withManifest(malformedManifest, malformed)).toThrow(/canonical JSON/i);
    const invalid = UTF8.encode(canonicalJson({...PROFILE, credential: 'unexpected'}));
    const invalidManifest = {
      ...manifest,
      layers: [{...layer, digest: sha256Digest(invalid), size: invalid.byteLength}],
    };
    expect(withManifest(invalidManifest, invalid)).toThrow(/profile is invalid/i);
    expect(() =>
      parseGraphShareProfileOciArtifact(
        artifact.manifestBytes,
        artifact.manifestDigest,
        new Uint8Array(GRAPH_SHARE_PROFILE_OCI_BODY_MAX_BYTES + 1),
      ),
    ).toThrow(/size is invalid/i);
  });
});

function reorderKeys(value: unknown, reverse: boolean): unknown {
  if (Array.isArray(value)) return value.map(item => reorderKeys(item, reverse));
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    const ordered = reverse ? keys.slice().reverse() : keys.slice().sort();
    return Object.fromEntries(ordered.map(key => [key, reorderKeys((value as Record<string, unknown>)[key], reverse)]));
  }
  return value;
}
