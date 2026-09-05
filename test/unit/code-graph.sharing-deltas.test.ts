import {describe, expect, it as effectIt} from '@effect/vitest';
import {it} from 'vitest';
import {Effect, FileSystem, Layer} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {codeGraphCheckpointFileFactCacheIdentity} from '../../src/code_graph/checkpoint/file_fact_identity.js';
import {
  decodeCodeGraphCheckpointPackV1,
  encodeCodeGraphCheckpointPackV1,
} from '../../src/code_graph/checkpoint/pack.js';
import {
  parseCodeGraphCheckpointHeaderV1,
  type CodeGraphCheckpointFileFactRecordV1,
  type CodeGraphCheckpointFileRecordV1,
  type CodeGraphCheckpointMetadataV1,
  type CodeGraphCheckpointRecordV1,
} from '../../src/code_graph/checkpoint/schema.js';
import {
  GRAPH_SHARE_DELTA_MEDIA_TYPE,
  parseGraphShareFrontierManifest,
  type GraphShareFrontierManifestV1,
} from '../../src/code_graph/sharing/artifacts.js';
import {putCasBytes, readVerifiedCasBlob} from '../../src/code_graph/sharing/cas.js';
import {putGraphShareCheckpointLayers} from '../../src/code_graph/sharing/checkpoint_cas.js';
import {
  applyCheckpointRecords,
  graphShareApplyBaseMatches,
  graphShareApplyIsAlreadyAtTarget,
  graphShareDeltaClosureComplete,
  planGraphSharePublication,
} from '../../src/code_graph/sharing/delta.js';
import {composeGraphShareTargetRecords, encodeGraphShareDeltaPack} from '../../src/code_graph/sharing/delta_pack.js';
import {parseSha256Digest, sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES} from '../../src/code_graph/sharing/oci.js';
import {defaultGraphShareProfile} from '../../src/code_graph/sharing/profile.js';
import {SystemInfo} from '../../src/effect/system.js';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';

const SHA256_ZERO = '0'.repeat(64);
const SHA1_ZERO = '0'.repeat(40);
const UTF8 = new TextEncoder();

function metadataFor(eligibleFiles: number, commit = SHA1_ZERO): CodeGraphCheckpointMetadataV1 {
  return {
    abi: {
      checkpointSemanticVersion: 2,
      graphSchemaVersion: 1,
      inventoryPolicyVersion: 1,
      languagePacks: [],
      lexicalLogicalFormatVersion: 1,
      pathPolicy: 'repository-relative-posix-v1',
      referenceResolutionVersion: 'resolution-v1',
      workspaceModelVersion: 'workspace-v1',
    },
    coverage: {eligibleFiles, excludedFiles: 0, reasons: [], state: 'complete'},
    repository: {
      caseMode: 'sensitive',
      displayName: 'checkpoint-fixture',
      objectFormat: 'sha1',
      repositoryId: SHA256_ZERO,
    },
    reuse: {
      fileSetFingerprint: SHA256_ZERO,
      formatVersion: 2,
      resolutionSurfaceVersion: 1,
      workspaceFingerprint: SHA256_ZERO,
    },
    source: {
      commit,
      extractorSet: 'typescript-v1',
      graphContentId: `cgc_${SHA1_ZERO}`,
    },
  };
}

function fileRecord(path: string): CodeGraphCheckpointFileRecordV1 {
  return {
    blobId: SHA1_ZERO,
    contentHash: SHA256_ZERO,
    kind: 'file',
    language: 'typescript',
    mode: '100644',
    path,
    size: UTF8.encode(path).byteLength,
    source: 'commit',
  };
}

function factRecord(path: string): CodeGraphCheckpointFileFactRecordV1 {
  const facts = {diagnostics: [], edges: [], path, symbols: []};
  return {
    cacheIdentity: codeGraphCheckpointFileFactCacheIdentity(facts),
    factRole: 'materialized',
    facts,
    kind: 'file-fact',
    path,
  };
}

function recordsFor(paths: readonly string[]): CodeGraphCheckpointRecordV1[] {
  return paths.flatMap(path => [fileRecord(path), factRecord(path)]);
}

const MANIFEST: GraphShareFrontierManifestV1 = {
  branch: 'refs/heads/main',
  checkpoint: {
    manifestDigest: `sha256:${'1'.repeat(64)}`,
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

const profileFrontier = defaultGraphShareProfile({
  branch: 'refs/heads/main',
  canonicalRemote: 'github.com/acme/graph-share',
  organization: 'acme',
  publisherKeyFingerprint: `sha256:${'f'.repeat(64)}`,
  repositoryId: 'e'.repeat(64),
}).frontier;

const layer = Layer.mergeAll(BunServices.layer, BunHttpClient.layer, SystemInfo.layer);

describe('graph share TCG1 deltas', () => {
  it('decodes checkpoint packs without packKind and fail-closes on unknown header fields', () => {
    const encoded = encodeCodeGraphCheckpointPackV1(metadataFor(1), recordsFor(['src/a.ts']));
    const {packKind: _packKind, ...legacy} = encoded.header;
    expect(parseCodeGraphCheckpointHeaderV1(legacy).packKind).toBeUndefined();
    expect(() => parseCodeGraphCheckpointHeaderV1({...encoded.header, extra: true})).toThrow(/unknown field/i);
  });

  it('encodes a delta pack with deletion order-keys and applies onto a checkpoint', () => {
    const base = encodeCodeGraphCheckpointPackV1(
      metadataFor(2, '1'.repeat(40)),
      recordsFor(['src/a.ts', 'src/gone.ts']),
    );
    const target = encodeCodeGraphCheckpointPackV1(
      metadataFor(2, '2'.repeat(40)),
      recordsFor(['src/a.ts', 'src/next.ts']),
    );
    const delta = encodeGraphShareDeltaPack({
      base: {
        commit: '1'.repeat(40),
        logicalDigest: base.header.logical,
        snapshotId: 'cgsn_base',
      },
      previousRecords: decodeCodeGraphCheckpointPackV1(base.bytes).records,
      target: {header: target.header, records: decodeCodeGraphCheckpointPackV1(target.bytes).records},
    });
    expect(delta.header.packKind).toBe('delta');
    expect(delta.header.deletions?.some(key => key.identity.includes('src/gone.ts'))).toBe(true);
    const applied = applyCheckpointRecords(decodeCodeGraphCheckpointPackV1(base.bytes).records, {
      deletions: delta.header.deletions ?? [],
      upserts: decodeCodeGraphCheckpointPackV1(delta.bytes).records,
    });
    const composed = encodeCodeGraphCheckpointPackV1(metadataFor(2, '2'.repeat(40)), applied);
    expect(composed.header.logical.digest).toBe(target.header.logical.digest);
  });

  it('plans compaction without closure proof and a delta when the overlay proof is complete', () => {
    const base = encodeCodeGraphCheckpointPackV1(metadataFor(1), recordsFor(['src/a.ts']));
    const target = encodeCodeGraphCheckpointPackV1(metadataFor(1, '2'.repeat(40)), recordsFor(['src/a.ts']));
    expect(graphShareDeltaClosureComplete(base.header, target.header)).toBe(true);
    expect(
      graphShareDeltaClosureComplete(base.header, {
        ...target.header,
        reuse: {...target.header.reuse!, workspaceFingerprint: '1'.repeat(64)},
      }),
    ).toBe(false);
    expect(
      planGraphSharePublication({
        chainDeltaBytes: 0,
        chainDeltaCount: 0,
        checkpointAgeSeconds: 0,
        closureComplete: false,
        nextDeltaBytes: 16,
        profile: profileFrontier,
      }),
    ).toBe('compact');
    expect(
      planGraphSharePublication({
        chainDeltaBytes: 0,
        chainDeltaCount: 0,
        checkpointAgeSeconds: 0,
        closureComplete: true,
        nextDeltaBytes: 16,
        profile: profileFrontier,
      }),
    ).toBe('delta');
    expect(
      planGraphSharePublication({
        chainDeltaBytes: 0,
        chainDeltaCount: profileFrontier.compactAfterDeltas,
        checkpointAgeSeconds: 0,
        closureComplete: true,
        nextDeltaBytes: 16,
        profile: profileFrontier,
      }),
    ).toBe('compact');
  });

  it('treats target reapply as a no-op and rejects a wrong installed base before writes', () => {
    const selected: GraphShareFrontierManifestV1 = {
      ...MANIFEST,
      deltas: [
        {
          baseSnapshotId: MANIFEST.checkpoint.snapshotId,
          manifestDigest: parseSha256Digest(`sha256:${'4'.repeat(64)}`),
          targetCommit: 'b'.repeat(40),
          targetSnapshotId: 'cgsn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
      snapshotId: 'cgsn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sourceCommit: 'b'.repeat(40),
    };
    expect(parseGraphShareFrontierManifest(selected)).toEqual(selected);
    expect(
      graphShareApplyIsAlreadyAtTarget(
        {
          checkpointDigest: selected.checkpoint.manifestDigest,
          frontierCommit: selected.sourceCommit,
          snapshotId: selected.snapshotId,
        },
        selected,
      ),
    ).toBe(true);
    expect(
      graphShareApplyBaseMatches({checkpointDigest: `sha256:${'9'.repeat(64)}`, snapshotId: 'cgsn_other'}, selected),
    ).toBe(false);
    expect(
      graphShareApplyBaseMatches(
        {checkpointDigest: selected.checkpoint.manifestDigest, snapshotId: selected.checkpoint.snapshotId},
        selected,
      ),
    ).toBe(true);
    expect(
      graphShareApplyBaseMatches({checkpointDigest: `sha256:${'9'.repeat(64)}`, snapshotId: 'cgsn_previous'}, MANIFEST),
    ).toBe(true);
  });

  effectIt.effect.prop(
    'checkpoint plus ordered deltas equals an independent clean encode of the target',
    {
      basePaths: FC.uniqueArray(FC.constantFrom('src/a.ts', 'src/b.ts', 'src/c.ts'), {maxLength: 3, minLength: 1}),
      extraPaths: FC.uniqueArray(FC.constantFrom('src/d.ts', 'src/e.ts'), {maxLength: 2}),
    },
    ({basePaths, extraPaths}) =>
      Effect.sync(() => {
        const targetPaths = [...new Set([...basePaths.slice(0, Math.max(1, basePaths.length - 1)), ...extraPaths])];
        const base = encodeCodeGraphCheckpointPackV1(
          metadataFor(basePaths.length, '1'.repeat(40)),
          recordsFor(basePaths),
        );
        const target = encodeCodeGraphCheckpointPackV1(
          metadataFor(targetPaths.length, '2'.repeat(40)),
          recordsFor(targetPaths),
        );
        const baseRecords = decodeCodeGraphCheckpointPackV1(base.bytes).records;
        const targetRecords = decodeCodeGraphCheckpointPackV1(target.bytes).records;
        const delta = encodeGraphShareDeltaPack({
          base: {commit: '1'.repeat(40), logicalDigest: base.header.logical, snapshotId: 'cgsn_base'},
          previousRecords: baseRecords,
          target: {header: target.header, records: targetRecords},
        });
        const applied = composeGraphShareTargetRecords(baseRecords, [
          {header: delta.header, records: decodeCodeGraphCheckpointPackV1(delta.bytes).records},
        ]);
        const independently = encodeCodeGraphCheckpointPackV1(metadataFor(targetPaths.length, '2'.repeat(40)), [
          ...targetRecords,
        ]);
        expect(
          encodeCodeGraphCheckpointPackV1(metadataFor(targetPaths.length, '2'.repeat(40)), applied).header.logical,
        ).toEqual(independently.header.logical);
        expect(independently.header.logical.digest).toBe(target.header.logical.digest);
      }),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect.prop(
    'compaction preserves logicalGraphDigest and rejects a non-descendant frontier chain',
    {
      generation: FC.integer({min: 2, max: 8}),
    },
    ({generation}) =>
      Effect.sync(() => {
        const first = parseGraphShareFrontierManifest(MANIFEST);
        const second = parseGraphShareFrontierManifest({
          ...MANIFEST,
          generation,
          previousManifestDigest: sha256Digest('prev'),
        });
        expect(second.generation).toBeGreaterThan(first.generation);
        expect(second.logicalGraphDigest).toBe(first.logicalGraphDigest);
        expect(() =>
          parseGraphShareFrontierManifest({
            ...MANIFEST,
            deltas: [
              {
                baseSnapshotId: 'cgsn_not-the-checkpoint',
                manifestDigest: `sha256:${'4'.repeat(64)}`,
                targetCommit: 'b'.repeat(40),
                targetSnapshotId: 'cgsn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              },
            ],
            snapshotId: 'cgsn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            sourceCommit: 'b'.repeat(40),
          }),
        ).toThrow(/chain|baseSnapshotId/i);
      }),
    {fastCheck: {numRuns: 16}},
  );

  effectIt.effect('keeps each published delta layer at or under 32 MiB', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const casRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-delta-layer-'});
      const base = encodeCodeGraphCheckpointPackV1(metadataFor(1, '1'.repeat(40)), recordsFor(['src/a.ts']));
      const target = encodeCodeGraphCheckpointPackV1(
        metadataFor(2, '2'.repeat(40)),
        recordsFor(['src/a.ts', 'src/next.ts']),
      );
      const delta = encodeGraphShareDeltaPack({
        base: {commit: '1'.repeat(40), logicalDigest: base.header.logical, snapshotId: 'cgsn_base'},
        previousRecords: decodeCodeGraphCheckpointPackV1(base.bytes).records,
        target: {header: target.header, records: decodeCodeGraphCheckpointPackV1(target.bytes).records},
      });
      const digest = yield* putCasBytes(casRoot, delta.bytes);
      const layers = yield* putGraphShareCheckpointLayers(casRoot, digest, GRAPH_SHARE_DELTA_MEDIA_TYPE);
      expect(layers.metadata.mediaType).toBe(GRAPH_SHARE_DELTA_MEDIA_TYPE);
      expect(delta.bytes.byteLength).toBeLessThanOrEqual(GRAPH_SHARE_HTTP_CAS_MAX_BYTES);
      for (const chunk of layers.metadata.chunks) {
        const bytes = yield* readVerifiedCasBlob(casRoot, chunk.digest);
        expect(bytes.byteLength).toBeLessThanOrEqual(GRAPH_SHARE_HTTP_CAS_MAX_BYTES);
      }
    }).pipe(provideTestLayer(layer)),
  );
});
