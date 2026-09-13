import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {it} from 'vitest';
import {codeGraphCheckpointAbiInputV1} from '../../src/code_graph/checkpoint/compatibility.js';
import {codeGraphCheckpointAbiDigestV1} from '../../src/code_graph/checkpoint/pack.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../../src/code_graph/languages/registry.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {
  appendGraphShareSignedCandidates,
  finalizeGraphShareSignedCandidates,
  makeGraphShareSignedCandidateCollector,
  parseGraphShareSignedCandidateQueue,
  signedCandidateQueuePath,
  type GraphSharePendingSignedCandidate,
  type GraphShareSignedCandidateV1,
} from '../../src/code_graph/sharing/signed_candidate.js';
import type {CodeGraphStoreShape} from '../../src/code_graph/store_shape.js';
import type {CodeGraphSnapshot} from '../../src/code_graph/types.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const layer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));
const packs = BUILTIN_LANGUAGE_PACK_REGISTRY.activePackProvenance(['src/index.ts', 'src/main.py']);
const commit = 'a'.repeat(40);
const repositoryId = 'b'.repeat(64);
const pending: GraphSharePendingSignedCandidate = {
  actionKey: 'c'.repeat(64),
  batchId: commit,
  casRoot: '/private/cas',
  extractorSet: packs[0].cacheIdentity,
  resultDigest: sha256Digest('result bytes'),
  resultSize: 12,
  semanticDigest: sha256Digest('semantic facts'),
  sourceCommit: commit,
};
const snapshot: CodeGraphSnapshot = {
  commit,
  dirty: false,
  edgeCount: 0,
  extractorSet: 'd'.repeat(64),
  fileCount: 2,
  id: `cgsn_${'e'.repeat(40)}`,
  repositoryId,
  state: 'ready',
  symbolCount: 0,
  worktreeId: 'f'.repeat(64),
};
const candidate: GraphShareSignedCandidateV1 = {
  ...pending,
  graphAbi: '1'.repeat(64),
  partialCoverage: false,
  platform: {architecture: 'arm64', os: 'darwin'},
  queuedAtMilliseconds: 1_000,
  releaseIdentity: '4.6.11-local.gproducer',
  resourceLimits: [],
  snapshotId: snapshot.id,
};

describe('producer-bound signed candidate evidence', () => {
  effectIt.effect(
    'uses the exact ready snapshot pack set and completed coverage, preserving the producer release',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-signed-candidates-'});
        const collector = makeGraphShareSignedCandidateCollector();
        collector.capture({...pending, casRoot: path.join(home, 'cas')});
        const store = {
          snapshotPackProvenance: (databasePath: string, snapshotId: string) => {
            expect(databasePath).toBe('/exact/ready.sqlite');
            expect(snapshotId).toBe(snapshot.id);
            return Effect.succeed(packs);
          },
        } as unknown as CodeGraphStoreShape;
        const result = yield* finalizeGraphShareSignedCandidates({
          candidates: collector.snapshot(),
          databasePath: '/exact/ready.sqlite',
          platform: {architecture: 'arm64', os: 'darwin'},
          releaseIdentity: '4.6.11-local.gproducer',
          repositoryId,
          skippedFiles: 3,
          snapshot,
          store,
          threadnoteHome: home,
        });
        expect(result.queued).toBe(1);
        const target = signedCandidateQueuePath(path, home, repositoryId);
        const loaded = parseGraphShareSignedCandidateQueue(JSON.parse(yield* fs.readFileString(target)));
        expect(loaded.candidates).toHaveLength(1);
        expect(loaded.candidates[0]).toMatchObject({
          actionKey: pending.actionKey,
          graphAbi: codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(packs)).digest,
          partialCoverage: true,
          releaseIdentity: '4.6.11-local.gproducer',
          sourceCommit: commit,
        });
        expect(loaded.candidates[0].graphAbi).not.toBe(
          codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1([packs[0]])).digest,
        );
        expect(loaded.candidates[0].resourceLimits).toEqual([]);
        if ((yield* SystemInfo).platform !== 'win32') expect((yield* fs.stat(target)).mode & 0o777).toBe(0o600);
      }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('refuses dirty, stale, or provenance-free snapshots before writing candidate state', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-signed-refusal-'});
      const target = signedCandidateQueuePath(path, home, repositoryId);
      const store = {snapshotPackProvenance: () => Effect.void} as unknown as CodeGraphStoreShape;
      for (const rejected of [{...snapshot, dirty: true}, {...snapshot, commit: 'f'.repeat(40)}, snapshot]) {
        expect(
          (yield* finalizeGraphShareSignedCandidates({
            candidates: [pending],
            databasePath: '/exact/ready.sqlite',
            platform: {architecture: 'arm64', os: 'darwin'},
            releaseIdentity: '4.6.11-local.gproducer',
            repositoryId,
            skippedFiles: 0,
            snapshot: rejected,
            store,
            threadnoteHome: home,
          })).queued,
        ).toBe(0);
      }
      expect(yield* fs.exists(target)).toBe(false);
    }).pipe(provideTestLayer(layer)),
  );

  it('bounds and deduplicates candidates without mutating prior state or reordering retained entries', () => {
    FC.assert(
      FC.property(FC.array(FC.integer({min: 0, max: 600}), {maxLength: 620}), ordinals => {
        const additions = ordinals.map(index => ({
          ...candidate,
          actionKey: index.toString(16).padStart(64, '0'),
        }));
        const before = JSON.stringify(additions);
        const once = appendGraphShareSignedCandidates({candidates: [], schemaVersion: 1}, additions, 1_000);
        const twice = appendGraphShareSignedCandidates(once, additions, 1_000);
        expect(twice).toEqual(once);
        expect(JSON.stringify(additions)).toBe(before);
        expect(once.candidates.map(item => item.actionKey)).toEqual(
          [...new Set(ordinals.map(index => index.toString(16).padStart(64, '0')))].slice(-512),
        );
        expect(new TextEncoder().encode(JSON.stringify(once)).byteLength).toBeLessThanOrEqual(512 * 1024);
      }),
      {numRuns: 30},
    );
  });

  it('keeps the legacy announcement schema separate and rejects unsupported candidate fields', () => {
    expect(() =>
      parseGraphShareSignedCandidateQueue({candidates: [{...candidate, invented: true}], schemaVersion: 1}),
    ).toThrow();
    expect(() =>
      parseGraphShareSignedCandidateQueue({candidates: [candidate], schemaVersion: 1, invented: true}),
    ).toThrow();
  });
});
