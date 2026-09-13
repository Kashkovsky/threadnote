import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Cause, Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {it} from 'vitest';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {codeGraphCheckpointAbiInputV1} from '../../src/code_graph/checkpoint/compatibility.js';
import {codeGraphCheckpointAbiDigestV1} from '../../src/code_graph/checkpoint/pack.js';
import {codeGraphCommittedContentHash} from '../../src/code_graph/content_identity.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../../src/code_graph/languages/registry.js';
import {graphShareParseActionKey} from '../../src/code_graph/sharing/action.js';
import {putCasBytes} from '../../src/code_graph/sharing/cas.js';
import {sha256Digest, sha256HexFromDigest} from '../../src/code_graph/sharing/digest.js';
import {graphShareParseResultArtifact} from '../../src/code_graph/sharing/parse_result.js';
import {
  acknowledgeGraphShareSignedCandidatePage,
  finalizeGraphShareSignedCandidates,
  graphShareSignedCandidateIdentity,
  listGraphShareSignedCandidatePageIds,
  parseGraphSharePendingSignedCandidateQueue,
  parseGraphShareSignedCandidateQueue,
  pendingCandidateQueuePath,
  persistGraphSharePendingSignedCandidates,
  persistGraphShareSignedCandidates,
  readGraphShareSignedCandidatePage,
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
        const finalIds = yield* listGraphShareSignedCandidatePageIds(f.home, repositoryId);
        expect(finalIds).toHaveLength(1);
        const final = yield* readGraphShareSignedCandidatePage(f.home, repositoryId, finalIds[0]);
        expect(final?.candidates).toHaveLength(1);
        expect(final!.candidates[0]).toMatchObject({
          actionKey,
          graphAbi: codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(packs)).digest,
          organization: 'acme',
          partialCoverage: true,
          profileDigest,
          releaseIdentity: 'fixture-release',
          resourceLimits: [],
          sourceCommit: commit,
        });
        expect(final!.candidates[0].graphAbi).not.toBe(
          codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1([packs[0]])).digest,
        );
        expect(f.observed).toEqual([`packs:${snapshot.id}`, `files:${snapshot.id}`, `cache:${packs[0].cacheIdentity}`]);
        const pending = JSON.parse(yield* f.fs.readFileString(pendingCandidateQueuePath(f.path, f.home, repositoryId)));
        expect(pending.segments).toEqual([]);
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
      const pending = JSON.parse(yield* f.fs.readFileString(pendingCandidateQueuePath(f.path, f.home, repositoryId)));
      expect(pending.segments).toHaveLength(1);
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

  effectIt.effect('retains more than 512 pending and final records across a restart and acknowledges exactly one', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-signed-journal-capacity-'});
      const additions = Array.from({length: 600}, (_, index) => ({
        ...pendingFixture,
        actionKey: index.toString(16).padStart(64, '0'),
      }));
      expect(
        (yield* persistGraphSharePendingSignedCandidates({
          candidates: additions,
          repositoryId,
          threadnoteHome: home,
        })).queued,
      ).toBe(600);
      const pendingPath = pendingCandidateQueuePath(path, home, repositoryId);
      const pendingManifest = JSON.parse(yield* fs.readFileString(pendingPath));
      expect(pendingManifest.schemaVersion).toBe(2);
      expect(pendingManifest.segments.length).toBeGreaterThan(1);
      const recovered: GraphSharePendingSignedCandidate[] = [];
      for (const segment of pendingManifest.segments) {
        const page = parseGraphSharePendingSignedCandidateQueue(
          JSON.parse(yield* fs.readFileString(path.join(`${pendingPath}.d`, `${segment.id}.json`))),
        );
        recovered.push(...page.candidates);
      }
      expect(recovered.map(candidate => candidate.actionKey)).toEqual(additions.map(candidate => candidate.actionKey));
      const final = recovered.map(candidate => ({
        ...candidate,
        graphAbi: candidateFixture.graphAbi,
        partialCoverage: false,
        resourceLimits: [],
        snapshotId: snapshot.id,
      }));
      expect((yield* persistGraphShareSignedCandidates(home, repositoryId, final)).queued).toBe(600);
      const ids = yield* listGraphShareSignedCandidatePageIds(home, repositoryId);
      expect(ids.length).toBeGreaterThan(1);
      const pages = [];
      for (const id of ids) pages.push((yield* readGraphShareSignedCandidatePage(home, repositoryId, id))!);
      expect(pages.flatMap(page => page.candidates).map(candidate => candidate.actionKey)).toEqual(
        additions.map(candidate => candidate.actionKey),
      );
      const identity = graphShareSignedCandidateIdentity(pages[0].candidates[0]);
      expect(
        (yield* acknowledgeGraphShareSignedCandidatePage(home, repositoryId, ids[0], new Set([identity]))).acknowledged,
      ).toBe(1);
      expect(
        (yield* acknowledgeGraphShareSignedCandidatePage(home, repositoryId, ids[0], new Set([identity]))).absent,
      ).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('reconciles 520 committed source files from durable pending pages after producer restart', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const files = new Map<string, CodeGraphInventoryFile>();
      const factsByPath = new Map<string, typeof facts>();
      const pending: GraphSharePendingSignedCandidate[] = [];
      for (let index = 0; index < 520; index++) {
        const filePath = `src/file-${index}.ts`;
        const gitBlobId = (index + 1).toString(16).padStart(40, '0');
        const fileContentHash = codeGraphCommittedContentHash('sha1', gitBlobId);
        const fileFacts = {...facts, path: filePath};
        const key = graphShareParseActionKey({
          contentHash: fileContentHash,
          extractorSet: packs[0].cacheIdentity,
          languageAndRole: 'typescript:source',
          normalizedPath: filePath,
          repositoryId,
        });
        const artifact = graphShareParseResultArtifact({
          actionKey: key,
          contentHash: fileContentHash,
          extractorSet: packs[0].cacheIdentity,
          facts: fileFacts,
          gitBlobId,
          languageAndRole: 'typescript:source',
          normalizedPath: filePath,
          repositoryId,
        });
        const bytes = new TextEncoder().encode(canonicalJson(artifact));
        pending.push({
          ...f.pending,
          actionKey: key,
          resultDigest: yield* putCasBytes(f.casRoot, bytes),
          resultSize: bytes.byteLength,
          semanticDigest: artifact.semanticDigest,
        });
        files.set(filePath, {...file, blobId: gitBlobId, contentHash: fileContentHash, path: filePath});
        factsByPath.set(filePath, fileFacts);
      }
      expect(
        (yield* persistGraphSharePendingSignedCandidates({
          candidates: pending,
          repositoryId,
          threadnoteHome: f.home,
        })).queued,
      ).toBe(520);
      const restartedStore = {
        snapshotPackProvenance: () => Effect.succeed(packs),
        effectiveSnapshotFilesByPaths: (_databasePath: string, _snapshotId: string, paths: readonly string[]) =>
          Effect.succeed(paths.map(filePath => ({path: filePath, file: files.get(filePath)}))),
        loadCachedFacts: (_databasePath: string, selected: readonly CodeGraphInventoryFile[]) =>
          Effect.succeed({bytes: 0, facts: new Map(selected.map(item => [item.path, factsByPath.get(item.path)!]))}),
      } as unknown as CodeGraphStoreShape;
      const finalized = yield* finalizeGraphShareSignedCandidates({
        databasePath: '/exact/ready.sqlite',
        repositoryId,
        skippedFiles: 0,
        snapshot: {...snapshot, fileCount: 520},
        store: restartedStore,
        threadnoteHome: f.home,
      });
      expect(finalized).toEqual({examined: 520, queued: 520, verified: 520});
      const ids = yield* listGraphShareSignedCandidatePageIds(f.home, repositoryId);
      const observed: string[] = [];
      for (const id of ids) {
        const page = yield* readGraphShareSignedCandidatePage(f.home, repositoryId, id);
        observed.push(...(page?.candidates.map(candidate => candidate.actionKey) ?? []));
      }
      expect(observed).toEqual(pending.map(candidate => candidate.actionKey));
      const pendingManifest = JSON.parse(
        yield* f.fs.readFileString(pendingCandidateQueuePath(f.path, f.home, repositoryId)),
      );
      expect(pendingManifest.segments).toEqual([]);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('recovers an orphaned segment and a final append interrupted before pending acknowledgement', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const pendingPath = pendingCandidateQueuePath(f.path, f.home, repositoryId);
      const orphan = {...f.pending, actionKey: '0'.repeat(64)};
      const orphanBytes = `${JSON.stringify({candidates: [orphan], schemaVersion: 1})}\n`;
      const orphanPath = f.path.join(`${pendingPath}.d`, `${sha256HexSync(orphanBytes)}.json`);
      yield* f.fs.makeDirectory(f.path.dirname(orphanPath), {recursive: true});
      yield* f.fs.writeFileString(orphanPath, orphanBytes);
      yield* persistGraphSharePendingSignedCandidates({candidates: [f.pending], repositoryId, threadnoteHome: f.home});
      expect(yield* f.fs.exists(orphanPath)).toBe(false);
      const finished = {
        ...f.pending,
        graphAbi: codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(packs)).digest,
        partialCoverage: false,
        resourceLimits: [],
        snapshotId: snapshot.id,
      };
      yield* persistGraphShareSignedCandidates(f.home, repositoryId, [finished]);
      const replay = yield* finalizeGraphShareSignedCandidates({
        databasePath: '/exact/ready.sqlite',
        repositoryId,
        skippedFiles: 0,
        snapshot,
        store: f.store,
        threadnoteHome: f.home,
      });
      expect(replay).toEqual({examined: 1, queued: 0, verified: 1});
      expect(yield* listGraphShareSignedCandidatePageIds(f.home, repositoryId)).toHaveLength(1);
      const pendingManifest = JSON.parse(yield* f.fs.readFileString(pendingPath));
      expect(pendingManifest.segments).toEqual([]);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('deduplicates overlapping batches and rereads a rewritten page for the second acknowledgement', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const a = {...f.pending, actionKey: '1'.repeat(64)};
      const b = {...f.pending, actionKey: '2'.repeat(64)};
      const c = {...f.pending, actionKey: '3'.repeat(64)};
      expect(
        (yield* persistGraphSharePendingSignedCandidates({
          candidates: [a, b],
          repositoryId,
          threadnoteHome: f.home,
        })).queued,
      ).toBe(2);
      expect(
        (yield* persistGraphSharePendingSignedCandidates({
          candidates: [a, c],
          repositoryId,
          threadnoteHome: f.home,
        })).queued,
      ).toBe(1);
      const final = (candidate: GraphSharePendingSignedCandidate): GraphShareSignedCandidateV2 => ({
        ...candidate,
        graphAbi: candidateFixture.graphAbi,
        partialCoverage: false,
        resourceLimits: [],
        snapshotId: snapshot.id,
      });
      expect((yield* persistGraphShareSignedCandidates(f.home, repositoryId, [final(a), final(b)])).queued).toBe(2);
      expect((yield* persistGraphShareSignedCandidates(f.home, repositoryId, [final(a), final(c)])).queued).toBe(1);
      const ids = yield* listGraphShareSignedCandidatePageIds(f.home, repositoryId);
      const first = (yield* readGraphShareSignedCandidatePage(f.home, repositoryId, ids[0]))!;
      expect(first.candidates.map(candidate => candidate.actionKey)).toEqual([a.actionKey, b.actionKey]);
      const second = (yield* readGraphShareSignedCandidatePage(f.home, repositoryId, ids[1]))!;
      expect(second.candidates.map(candidate => candidate.actionKey)).toEqual([c.actionKey]);
      expect(
        (yield* acknowledgeGraphShareSignedCandidatePage(
          f.home,
          repositoryId,
          first.id,
          new Set([graphShareSignedCandidateIdentity(final(a))]),
        )).acknowledged,
      ).toBe(1);
      const stale = yield* acknowledgeGraphShareSignedCandidatePage(
        f.home,
        repositoryId,
        first.id,
        new Set([graphShareSignedCandidateIdentity(final(b))]),
      );
      expect(stale).toEqual({acknowledged: 0, absent: false});
      const currentIds = yield* listGraphShareSignedCandidatePageIds(f.home, repositoryId);
      const replacement = (yield* readGraphShareSignedCandidatePage(f.home, repositoryId, currentIds[0]))!;
      expect(replacement.candidates.map(candidate => candidate.actionKey)).toEqual([b.actionKey]);
      expect(
        (yield* acknowledgeGraphShareSignedCandidatePage(
          f.home,
          repositoryId,
          replacement.id,
          new Set([graphShareSignedCandidateIdentity(final(b))]),
        )).acknowledged,
      ).toBe(1);
      expect(
        (yield* acknowledgeGraphShareSignedCandidatePage(
          f.home,
          repositoryId,
          first.id,
          new Set([graphShareSignedCandidateIdentity(final(b))]),
        )).absent,
      ).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('rejects a symlinked segment directory before touching its target', () =>
    Effect.gen(function* () {
      if ((yield* SystemInfo).platform === 'win32') return;
      const f = yield* fixture();
      const pendingPath = pendingCandidateQueuePath(f.path, f.home, repositoryId);
      const outside = f.path.join(f.home, 'outside');
      yield* f.fs.makeDirectory(outside);
      const marker = f.path.join(outside, 'marker.txt');
      yield* f.fs.writeFileString(marker, 'unchanged');
      yield* f.fs.makeDirectory(f.path.dirname(pendingPath), {recursive: true});
      yield* f.fs.symlink(outside, `${pendingPath}.d`);
      const attempt = yield* Effect.exit(
        persistGraphSharePendingSignedCandidates({
          candidates: [f.pending],
          repositoryId,
          threadnoteHome: f.home,
        }),
      );
      expect(attempt._tag).toBe('Failure');
      if (attempt._tag === 'Failure') expect(Cause.pretty(attempt.cause)).toContain('symbolic link');
      expect(yield* f.fs.readFileString(marker)).toBe('unchanged');
      expect(yield* f.fs.exists(pendingPath)).toBe(false);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect.prop(
    'overlapping journal batches preserve first-seen order without duplicates',
    {
      first: FC.array(FC.integer({min: 0, max: 80}), {maxLength: 45}),
      second: FC.array(FC.integer({min: 0, max: 80}), {maxLength: 45}),
    },
    ({first, second}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-signed-journal-property-'});
        const additions = [...first, ...second].map(index => ({
          ...pendingFixture,
          actionKey: index.toString(16).padStart(64, '0'),
        }));
        const before = JSON.stringify(additions);
        yield* persistGraphSharePendingSignedCandidates({
          candidates: additions.slice(0, first.length),
          repositoryId,
          threadnoteHome: home,
        });
        const secondAdmission = yield* persistGraphSharePendingSignedCandidates({
          candidates: additions.slice(first.length),
          repositoryId,
          threadnoteHome: home,
        });
        expect(secondAdmission.queued).toBe(new Set([...first, ...second]).size - new Set(first).size);
        expect(
          (yield* persistGraphSharePendingSignedCandidates({
            candidates: additions,
            repositoryId,
            threadnoteHome: home,
          })).queued,
        ).toBe(0);
        expect(JSON.stringify(additions)).toBe(before);
        const pendingPath = pendingCandidateQueuePath(path, home, repositoryId);
        if (additions.length === 0) {
          expect(yield* fs.exists(pendingPath)).toBe(false);
          return;
        }
        const manifest = JSON.parse(yield* fs.readFileString(pendingPath));
        const observed: string[] = [];
        for (const segment of manifest.segments) {
          const page = parseGraphSharePendingSignedCandidateQueue(
            JSON.parse(yield* fs.readFileString(path.join(`${pendingPath}.d`, `${segment.id}.json`))),
          );
          observed.push(...page.candidates.map(candidate => candidate.actionKey));
        }
        expect(observed).toEqual([...new Set(additions.map(candidate => candidate.actionKey))]);
      }).pipe(provideTestLayer(layer)),
    {fastCheck: {numRuns: 20}},
  );

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
