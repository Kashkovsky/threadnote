import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {it} from 'vitest';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {codeGraphCheckpointAbiInputV1} from '../../src/code_graph/checkpoint/compatibility.js';
import {codeGraphCheckpointAbiDigestV1} from '../../src/code_graph/checkpoint/pack.js';
import {codeGraphCommittedContentHash} from '../../src/code_graph/content_identity.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../../src/code_graph/languages/registry.js';
import {graphShareParseActionKey} from '../../src/code_graph/sharing/action.js';
import {putCasBytes} from '../../src/code_graph/sharing/cas.js';
import {sha256Digest, sha256HexFromDigest} from '../../src/code_graph/sharing/digest.js';
import {graphShareParseResultArtifact} from '../../src/code_graph/sharing/parse_result.js';
import {
  appendGraphSharePendingSignedCandidates,
  appendGraphShareSignedCandidates,
  finalizeGraphShareSignedCandidates,
  parseGraphSharePendingSignedCandidateQueue,
  parseGraphShareSignedCandidateQueue,
  pendingCandidateQueuePath,
  persistGraphSharePendingSignedCandidates,
  signedCandidateQueuePath,
  type GraphSharePendingSignedCandidate,
  type GraphShareSignedCandidateV2,
} from '../../src/code_graph/sharing/signed_candidate.js';
import type {CodeGraphStoreShape} from '../../src/code_graph/store_shape.js';
import type {CodeGraphInventoryFile, CodeGraphSnapshot} from '../../src/code_graph/types.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const layer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));
const packs = BUILTIN_LANGUAGE_PACK_REGISTRY.activePackProvenance(['src/index.ts', 'src/main.py']);
const commit = 'a'.repeat(40);
const repositoryId = 'b'.repeat(64);
const profileDigest = sha256Digest('producer-profile');
const pathName = 'src/index.ts';
const blobId = 'd'.repeat(40);
const contentHash = codeGraphCommittedContentHash('sha1', blobId);
const facts = {diagnostics: [], edges: [], path: pathName, symbols: []};
const file: CodeGraphInventoryFile = {
  blobId,
  contentHash,
  language: 'typescript',
  mode: '100644',
  path: pathName,
  size: 12,
  source: 'commit',
};
const actionKey = graphShareParseActionKey({
  contentHash,
  extractorSet: packs[0].cacheIdentity,
  languageAndRole: 'typescript:source',
  normalizedPath: pathName,
  repositoryId,
});
const result = graphShareParseResultArtifact({
  actionKey,
  contentHash,
  extractorSet: packs[0].cacheIdentity,
  facts,
  gitBlobId: blobId,
  languageAndRole: 'typescript:source',
  normalizedPath: pathName,
  repositoryId,
});
const resultBytes = new TextEncoder().encode(canonicalJson(result));
const snapshot: CodeGraphSnapshot = {
  commit,
  dirty: false,
  edgeCount: 0,
  extractorSet: 'e'.repeat(64),
  fileCount: 2,
  id: `cgsn_${'f'.repeat(40)}`,
  repositoryId,
  state: 'ready',
  symbolCount: 0,
  worktreeId: '1'.repeat(64),
};
const pendingFixture: GraphSharePendingSignedCandidate = {
  actionKey,
  batchId: commit,
  casRoot: '/private/cas',
  extractorSet: packs[0].cacheIdentity,
  organization: 'acme',
  platform: {architecture: 'arm64', os: 'darwin'},
  profileDigest,
  queuedAtMilliseconds: 1_000,
  releaseIdentity: 'fixture-release',
  resultDigest: sha256Digest(resultBytes),
  resultSize: resultBytes.byteLength,
  semanticDigest: result.semanticDigest,
  sourceCommit: commit,
};
const candidateFixture: GraphShareSignedCandidateV2 = {
  ...pendingFixture,
  graphAbi: '2'.repeat(64),
  partialCoverage: false,
  resourceLimits: [],
  snapshotId: snapshot.id,
};

const fixture = Effect.fn('test.signedCandidate.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-signed-candidates-'});
  const casRoot = path.join(home, 'cas');
  const resultDigest = yield* putCasBytes(casRoot, resultBytes);
  const pending = {...pendingFixture, casRoot, resultDigest};
  const root = path.join(home, 'graph-sharing');
  yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  yield* fs.writeFileString(
    path.join(root, 'trust-receipts.json'),
    JSON.stringify({
      schemaVersion: 1,
      receipts: [
        {
          accessMode: 'join',
          organization: 'acme',
          policyVersion: 1,
          profileDigest,
          publisherKeyFingerprint: sha256Digest('publisher'),
          registryCanonical: 'cas://local',
          repositoryId,
          client: {casRoot, contributionMode: 'passive'},
        },
      ],
    }),
  );
  const observed: string[] = [];
  const store = {
    snapshotPackProvenance: (_databasePath: string, id: string) => {
      observed.push(`packs:${id}`);
      return Effect.succeed(packs);
    },
    effectiveSnapshotFilesByPaths: (_databasePath: string, id: string, paths: readonly string[]) => {
      observed.push(`files:${id}`);
      return Effect.succeed(
        paths.map(pathValue => ({path: pathValue, file: pathValue === file.path ? file : undefined})),
      );
    },
    loadCachedFacts: (_databasePath: string, files: readonly CodeGraphInventoryFile[], extractorSet: string) => {
      observed.push(`cache:${extractorSet}`);
      return Effect.succeed({bytes: resultBytes.byteLength, facts: new Map(files.map(item => [item.path, facts]))});
    },
  } as unknown as CodeGraphStoreShape;
  return {casRoot, fs, home, observed, path, pending, store};
});

describe('producer-bound signed candidate evidence', () => {
  effectIt.effect(
    'reconciles durable pre-cache evidence after restart using exact ready snapshot facts and full ABI',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* persistGraphSharePendingSignedCandidates({
          candidates: [f.pending],
          repositoryId,
          threadnoteHome: f.home,
        });
        const outcome = yield* finalizeGraphShareSignedCandidates({
          databasePath: '/exact/ready.sqlite',
          repositoryId,
          skippedFiles: 3,
          snapshot,
          store: f.store,
          threadnoteHome: f.home,
        });
        expect(outcome).toEqual({examined: 1, queued: 1, verified: 1});
        const final = parseGraphShareSignedCandidateQueue(
          JSON.parse(yield* f.fs.readFileString(signedCandidateQueuePath(f.path, f.home, repositoryId))),
        );
        expect(final.schemaVersion).toBe(2);
        expect(final.candidates).toHaveLength(1);
        expect(final.candidates[0]).toMatchObject({
          actionKey,
          graphAbi: codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(packs)).digest,
          organization: 'acme',
          partialCoverage: true,
          profileDigest,
          releaseIdentity: 'fixture-release',
          resourceLimits: [],
          sourceCommit: commit,
        });
        expect(final.candidates[0].graphAbi).not.toBe(
          codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1([packs[0]])).digest,
        );
        expect(f.observed).toEqual([`packs:${snapshot.id}`, `files:${snapshot.id}`, `cache:${packs[0].cacheIdentity}`]);
        const pending = parseGraphSharePendingSignedCandidateQueue(
          JSON.parse(yield* f.fs.readFileString(pendingCandidateQueuePath(f.path, f.home, repositoryId))),
        );
        expect(pending.candidates).toEqual([]);
        if ((yield* SystemInfo).platform !== 'win32')
          expect((yield* f.fs.stat(signedCandidateQueuePath(f.path, f.home, repositoryId))).mode & 0o777).toBe(0o600);
      }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect(
    'refuses dirty and source-mismatched snapshots with valid provenance, and missing provenance separately',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* persistGraphSharePendingSignedCandidates({
          candidates: [f.pending],
          repositoryId,
          threadnoteHome: f.home,
        });
        const finalize = (current: CodeGraphSnapshot, store = f.store) =>
          finalizeGraphShareSignedCandidates({
            databasePath: '/exact/ready.sqlite',
            repositoryId,
            skippedFiles: 0,
            snapshot: current,
            store,
            threadnoteHome: f.home,
          });
        expect((yield* finalize({...snapshot, dirty: true})).queued).toBe(0);
        expect(f.observed).toEqual([]);
        expect((yield* finalize({...snapshot, commit: '9'.repeat(40)})).queued).toBe(0);
        expect(f.observed).toEqual([`packs:${snapshot.id}`]);
        const missing = {snapshotPackProvenance: () => Effect.void} as unknown as CodeGraphStoreShape;
        expect((yield* finalize(snapshot, missing)).queued).toBe(0);
        expect(yield* f.fs.exists(signedCandidateQueuePath(f.path, f.home, repositoryId))).toBe(false);
      }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('keeps pending evidence when the trust profile changes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* persistGraphSharePendingSignedCandidates({candidates: [f.pending], repositoryId, threadnoteHome: f.home});
      const target = f.path.join(f.home, 'graph-sharing', 'trust-receipts.json');
      const switched = JSON.parse(yield* f.fs.readFileString(target));
      switched.receipts[0].profileDigest = sha256Digest('different-profile');
      yield* f.fs.writeFileString(target, JSON.stringify(switched));
      expect(
        (yield* finalizeGraphShareSignedCandidates({
          databasePath: '/exact/ready.sqlite',
          repositoryId,
          skippedFiles: 0,
          snapshot,
          store: f.store,
          threadnoteHome: f.home,
        })).queued,
      ).toBe(0);
      expect(yield* f.fs.exists(signedCandidateQueuePath(f.path, f.home, repositoryId))).toBe(false);
      const pending = parseGraphSharePendingSignedCandidateQueue(
        JSON.parse(yield* f.fs.readFileString(pendingCandidateQueuePath(f.path, f.home, repositoryId))),
      );
      expect(pending.candidates).toHaveLength(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('refuses changed CAS bytes and cached facts without losing producer evidence', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* persistGraphSharePendingSignedCandidates({candidates: [f.pending], repositoryId, threadnoteHome: f.home});
      const finalize = (store: CodeGraphStoreShape) =>
        finalizeGraphShareSignedCandidates({
          databasePath: '/exact/ready.sqlite',
          repositoryId,
          skippedFiles: 0,
          snapshot,
          store,
          threadnoteHome: f.home,
        });
      const casPath = f.path.join(f.casRoot, 'sha256', sha256HexFromDigest(f.pending.resultDigest));
      yield* f.fs.writeFileString(casPath, 'changed result bytes');
      expect((yield* finalize(f.store)).queued).toBe(0);
      yield* f.fs.writeFile(casPath, resultBytes);
      const changedCache = {
        ...f.store,
        loadCachedFacts: () =>
          Effect.succeed({bytes: 1, facts: new Map([[pathName, {...facts, symbols: [{name: 'changed'}]}]])}),
      } as unknown as CodeGraphStoreShape;
      expect((yield* finalize(changedCache)).queued).toBe(0);
      expect((yield* finalize(f.store)).verified).toBe(1);
    }).pipe(provideTestLayer(layer)),
  );

  it('deduplicates and bounds pending/final queues without mutating input or changing retained order', () => {
    FC.assert(
      FC.property(FC.array(FC.integer({min: 0, max: 600}), {maxLength: 620}), ordinals => {
        const additions = ordinals.map(index => ({
          ...pendingFixture,
          actionKey: index.toString(16).padStart(64, '0'),
        }));
        const before = JSON.stringify(additions);
        const pending = appendGraphSharePendingSignedCandidates({candidates: [], schemaVersion: 1}, additions, 1_000);
        expect(appendGraphSharePendingSignedCandidates(pending, additions, 1_000)).toEqual(pending);
        expect(JSON.stringify(additions)).toBe(before);
        expect(pending.candidates.map(item => item.actionKey)).toEqual(
          [...new Set(ordinals.map(index => index.toString(16).padStart(64, '0')))].slice(-512),
        );
        const final = appendGraphShareSignedCandidates(
          {candidates: [], schemaVersion: 2},
          pending.candidates.map(item => ({...item, ...candidateFixture, actionKey: item.actionKey})),
          1_000,
        );
        expect(appendGraphShareSignedCandidates(final, final.candidates, 1_000)).toEqual(final);
        expect(new TextEncoder().encode(JSON.stringify(final)).byteLength).toBeLessThanOrEqual(512 * 1024);
      }),
      {numRuns: 30},
    );
  });

  it('discards pre-release final v1 evidence and rejects unsupported fields or commit/batch mismatch', () => {
    expect(parseGraphShareSignedCandidateQueue({candidates: [candidateFixture], schemaVersion: 1})).toEqual({
      candidates: [],
      schemaVersion: 2,
    });
    expect(() =>
      parseGraphShareSignedCandidateQueue({candidates: [{...candidateFixture, invented: true}], schemaVersion: 2}),
    ).toThrow();
    expect(() =>
      parseGraphSharePendingSignedCandidateQueue({candidates: [{...pendingFixture, invented: true}], schemaVersion: 1}),
    ).toThrow();
    expect(() =>
      parseGraphSharePendingSignedCandidateQueue({
        candidates: [{...pendingFixture, batchId: '0'.repeat(40)}],
        schemaVersion: 1,
      }),
    ).toThrow();
  });
});
