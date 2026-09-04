import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {it} from 'vitest';
import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {readFile} from '../helpers/node-fs-promises.js';
import {dirname, join} from '../helpers/node-path.js';
import {fileURLToPath} from '../helpers/node-url.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {parseGraphShareFrontierManifest} from '../../src/code_graph/sharing/artifacts.js';
import {
  generateGraphSharePublisherKey,
  signGraphShareFrontier,
  type GraphShareFrontierManifestV1,
  type GraphShareSignatureEnvelopeV1,
} from '../../src/code_graph/sharing/artifacts.js';
import {putCasBytes} from '../../src/code_graph/sharing/cas.js';
import {maybeImportSharedGraphBase, selectPublishedAncestorManifest} from '../../src/code_graph/sharing/client.js';
import {sha256Digest, sha256HexFromDigest} from '../../src/code_graph/sharing/digest.js';
import {GraphSharingError} from '../../src/code_graph/sharing/errors.js';
import {
  graphSharingCasBlobPath,
  graphSharingLayout,
  graphSharingProvenancePath,
} from '../../src/code_graph/sharing/layout.js';
import {
  casProfilePointer,
  defaultGraphShareProfile,
  graphShareProfileDigest,
  parseGraphShareEnrollment,
} from '../../src/code_graph/sharing/profile.js';
import {
  loadSharedGraphQuerySource,
  readSharedGraphProvenance,
  writeSharedGraphProvenance,
} from '../../src/code_graph/sharing/provenance.js';
import {
  trustReceiptFromEnrollment,
  writeGraphShareClientState,
  writeGraphShareTrustReceipt,
} from '../../src/code_graph/sharing/trust.js';
import type {RepositoryIdentity} from '../../src/code_graph/types.js';
import {CommandExecutor, runCommandEffect} from '../../src/effect/command.js';
import {SystemInfo} from '../../src/effect/system.js';
import {CodeGraphLanguagePackRegistry} from '../../src/code_graph/languages/registry.js';
import {CodeGraphMaintenanceCoordinator} from '../../src/code_graph/maintenance_coordinator.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';

const sharingLayer = CodeGraphMaintenanceCoordinator.layer.pipe(
  Layer.provideMerge(CodeGraphLanguagePackRegistry.layer),
  Layer.provideMerge(Layer.merge(CodeGraphStore.layer, CommandExecutor.layer)),
  Layer.provideMerge(SystemInfo.layer),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(BunHttpClient.layer),
);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPOSITORY_ID = 'b'.repeat(64);
const CHECKOUT_ID = 'c'.repeat(64);
const CHECKPOINT_BYTES = new TextEncoder().encode('not-a-checkpoint');

describe('graph share import and inspect source', () => {
  it('does not start shared graph import from recall', async () => {
    const [indexer, recall, memory] = await Promise.all([
      readFile(join(repoRoot, 'src/code_graph/indexer_service.ts'), 'utf8'),
      readFile(join(repoRoot, 'src/mcp/server/recall.ts'), 'utf8'),
      readFile(join(repoRoot, 'src/mcp/server/memory.ts'), 'utf8'),
    ]);
    expect(indexer).toContain('maybeImportSharedGraphBase');
    expect(recall).not.toContain('maybeImportSharedGraphBase');
    expect(memory).not.toContain('maybeImportSharedGraphBase');
  });

  effectIt.effect('omits inspect source when provenance is corrupt, untrusted, or not the selected snapshot', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-source-'});
      const layout = graphSharingLayout(path, home);
      const provenancePath = graphSharingProvenancePath(path, layout.provenanceRoot, CHECKOUT_ID);
      yield* fs.makeDirectory(path.dirname(provenancePath), {recursive: true, mode: 0o700});
      yield* fs.writeFileString(provenancePath, '{not-json', {mode: 0o600});
      expect(
        yield* loadSharedGraphQuerySource({
          checkoutId: CHECKOUT_ID,
          localCommit: 'a'.repeat(40),
          repositoryId: REPOSITORY_ID,
          snapshot: {id: 'cgsn_imported'},
          threadnoteHome: home,
        }),
      ).toBeUndefined();
      const enrolled = yield* enrolledHome(home, {includeFrontier: false});
      yield* writeSharedGraphProvenance(home, CHECKOUT_ID, {
        checkpointDigest: sha256Digest(CHECKPOINT_BYTES),
        frontierCommit: 'a'.repeat(40),
        profileDigest: enrolled.profileDigest,
        repositoryId: REPOSITORY_ID,
        schemaVersion: 1,
        snapshotId: 'cgsn_imported',
      });
      expect(
        yield* loadSharedGraphQuerySource({
          checkoutId: CHECKOUT_ID,
          localCommit: 'a'.repeat(40),
          repositoryId: REPOSITORY_ID,
          snapshot: {id: 'cgsn_local'},
          threadnoteHome: home,
        }),
      ).toBeUndefined();
      expect(
        yield* loadSharedGraphQuerySource({
          checkoutId: CHECKOUT_ID,
          localCommit: 'a'.repeat(40),
          repositoryId: REPOSITORY_ID,
          snapshot: {baseSnapshotId: 'cgsn_imported', id: 'cgsn_overlay'},
          threadnoteHome: home,
        }),
      ).toMatchObject({kind: 'shared-base-plus-local-overlay', profileDigest: enrolled.profileDigest});
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('skips missing frontiers without quarantine and does not re-hash an installed checkpoint', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-import-'});
      const enrolled = yield* enrolledHome(home, {includeFrontier: false});
      const missing = yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home));
      expect(missing).toEqual({imported: false, reason: 'unavailable'});
      expect(yield* quarantineNames(home)).toEqual([]);
      const published = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: true});
      yield* writeSharedGraphProvenance(home, CHECKOUT_ID, {
        checkpointDigest: published.checkpointDigest,
        frontierCommit: 'a'.repeat(40),
        profileDigest: published.profileDigest,
        repositoryId: REPOSITORY_ID,
        schemaVersion: 1,
        snapshotId: 'cgsn_imported',
      });
      const skipped = yield* maybeImportSharedGraphBase(importRequest(published.repo, home));
      expect(skipped).toEqual({imported: false, reason: 'already-installed', snapshotId: 'cgsn_imported'});
      expect(yield* quarantineNames(home)).toEqual([]);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('skips import when the trust pin disagrees with enrollment', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-pin-'});
      const enrolled = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: true});
      yield* writeGraphShareTrustReceipt(home, {
        ...trustReceiptFromEnrollment(enrolled.enrollment, enrolled.profile, enrolled.profileDigest, 'read-only'),
        publisherKeyFingerprint: `sha256:${'f'.repeat(64)}`,
      });
      const result = yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home));
      expect(result).toEqual({imported: false, reason: 'trust-pin-mismatch'});
      expect(yield* quarantineNames(home)).toEqual([]);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('quarantines signature failures once per repository and always deletes the spool', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-quarantine-'});
      const enrolled = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: true});
      const tampered: GraphShareSignatureEnvelopeV1 = {
        ...enrolled.envelope,
        signature: flipHex(enrolled.envelope.signature),
      };
      const envelopeDigest = yield* putCasBytes(enrolled.casRoot, new TextEncoder().encode(canonicalJson(tampered)));
      const layout = graphSharingLayout(path, home, enrolled.casRoot);
      yield* fs.writeFileString(
        path.join(layout.frontiersRoot, REPOSITORY_ID, 'latest.json'),
        `${JSON.stringify({
          envelopeDigest,
          manifestDigest: enrolled.manifestDigest,
          schemaVersion: 1,
        })}\n`,
      );
      const first = yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home));
      const second = yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home));
      expect(first).toEqual({imported: false, reason: 'quarantined'});
      expect(second).toEqual({imported: false, reason: 'quarantined'});
      expect(yield* quarantineNames(home)).toEqual([`${REPOSITORY_ID}.json`]);
      const failed = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: false});
      yield* maybeImportSharedGraphBase(importRequest(failed.repo, home)).pipe(Effect.exit);
      const downloads = path.join(graphSharingLayout(path, home).root, 'downloads');
      const leftover = (yield* fs.exists(downloads)) ? yield* fs.readDirectory(downloads) : [];
      expect([...leftover]).toEqual([]);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('treats a missing checkpoint CAS blob as unavailable without quarantine', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-missing-cas-'});
      const enrolled = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: true});
      const result = yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home));
      expect(result).toEqual({imported: false, reason: 'unavailable'});
      expect(yield* quarantineNames(home)).toEqual([]);
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('quarantines a mutated checkpoint blob and leaves prior provenance snapshot id unchanged', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-cas-tamper-'});
      const enrolled = yield* enrolledHome(home, {includeFrontier: true, skipCheckpoint: false});
      yield* fs.writeFile(
        graphSharingCasBlobPath(path, enrolled.casRoot, sha256HexFromDigest(enrolled.checkpointDigest)),
        new TextEncoder().encode('mutated-checkpoint'),
      );
      yield* writeSharedGraphProvenance(home, CHECKOUT_ID, {
        checkpointDigest: `sha256:${'9'.repeat(64)}`,
        frontierCommit: 'a'.repeat(40),
        profileDigest: enrolled.profileDigest,
        repositoryId: REPOSITORY_ID,
        schemaVersion: 1,
        snapshotId: 'cgsn_previous',
      });
      const result = yield* maybeImportSharedGraphBase(importRequest(enrolled.repo, home));
      expect(result).toEqual({imported: false, reason: 'quarantined'});
      expect(yield* quarantineNames(home)).toEqual([`${REPOSITORY_ID}.json`]);
      expect((yield* readSharedGraphProvenance(home, CHECKOUT_ID))?.snapshotId).toBe('cgsn_previous');
      expect(
        yield* loadSharedGraphQuerySource({
          checkoutId: CHECKOUT_ID,
          localCommit: 'a'.repeat(40),
          repositoryId: REPOSITORY_ID,
          snapshot: {id: 'cgsn_imported'},
          threadnoteHome: home,
        }),
      ).toBeUndefined();
    }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('walks signed predecessor frontiers until HEAD is an ancestor', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-ancestor-'});
      const repo = path.join(home, 'repo');
      yield* fs.makeDirectory(path.join(repo, 'src'), {recursive: true});
      yield* fs.writeFileString(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
      yield* git(repo, ['init', '-q', '--initial-branch=main']);
      yield* git(repo, ['add', '.']);
      yield* git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'one']);
      const first = (yield* runCommandEffect('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
      yield* fs.writeFileString(path.join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
      yield* git(repo, ['add', '.']);
      yield* git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'two']);
      const second = (yield* runCommandEffect('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
      const casRoot = path.join(home, 'cas');
      const profileDigest = sha256Digest('profile');
      const gen1 = parseGraphShareFrontierManifest({
        branch: 'refs/heads/main',
        checkpoint: {
          manifestDigest: sha256Digest('c1'),
          snapshotId: 'cgsn_one',
          sourceCommit: first,
        },
        deltas: [],
        generation: 1,
        graphAbi: 'e'.repeat(64),
        graphContentId: `cgc_${'d'.repeat(40)}`,
        logicalGraphDigest: sha256Digest('g1'),
        previousManifestDigest: null,
        profileDigest,
        publisherFence: 1,
        repositoryId: 'b'.repeat(64),
        schemaVersion: 1,
        snapshotId: 'cgsn_one',
        sourceCommit: first,
      });
      const gen1Digest = yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(gen1)));
      const gen2 = parseGraphShareFrontierManifest({
        branch: 'refs/heads/main',
        checkpoint: {
          manifestDigest: sha256Digest('c2'),
          snapshotId: 'cgsn_two',
          sourceCommit: second,
        },
        deltas: [],
        generation: 2,
        graphAbi: 'e'.repeat(64),
        graphContentId: `cgc_${'d'.repeat(40)}`,
        logicalGraphDigest: sha256Digest('g2'),
        previousManifestDigest: gen1Digest,
        profileDigest,
        publisherFence: 1,
        repositoryId: 'b'.repeat(64),
        schemaVersion: 1,
        snapshotId: 'cgsn_two',
        sourceCommit: second,
      });
      yield* git(repo, ['checkout', '-q', first]);
      const identity = {
        branch: 'main',
        caseMode: 'sensitive' as const,
        checkoutId: 'c'.repeat(64),
        displayName: 'graph-share',
        gitCommonDirectory: repo,
        headCommit: first,
        objectFormat: 'sha1' as const,
        remoteIdentity: 'github.com/acme/graph-share',
        repoRoot: repo,
        repositoryId: 'b'.repeat(64),
        worktreeId: 'd'.repeat(64),
      };
      const selected = yield* selectPublishedAncestorManifest(casRoot, identity, gen2);
      expect(selected.sourceCommit).toBe(first);
      expect(selected.generation).toBe(1);
      const unavailable = yield* selectPublishedAncestorManifest(
        casRoot,
        {...identity, headCommit: 'f'.repeat(40)},
        gen1,
      ).pipe(
        Effect.as(false),
        Effect.catchIf(
          error => Schema.is(GraphSharingError)(error) && error.kind === 'unavailable',
          () => Effect.succeed(true),
        ),
      );
      expect(unavailable).toBe(true);
    }).pipe(provideTestLayer(sharingLayer)),
  );
});

function importRequest(repoRoot: string, home: string) {
  return {
    cwd: repoRoot,
    identity: identity(repoRoot),
    threadnoteHome: home,
  };
}

function identity(repo: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: CHECKOUT_ID,
    displayName: 'graph-share',
    gitCommonDirectory: repo,
    headCommit: 'a'.repeat(40),
    objectFormat: 'sha1',
    remoteIdentity: 'github.com/acme/graph-share',
    repoRoot: repo,
    repositoryId: REPOSITORY_ID,
    worktreeId: 'd'.repeat(64),
  };
}

const enrolledHome = Effect.fn('test.graphShare.enrolledHome')(function* (
  home: string,
  options: {readonly includeFrontier: boolean; readonly skipCheckpoint?: boolean},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = path.join(home, 'repository');
  const casRoot = path.join(home, 'cas');
  yield* fs.makeDirectory(path.join(repo, '.threadnote'), {recursive: true});
  yield* writeGraphShareClientState(home, casRoot);
  const key = yield* generateGraphSharePublisherKey();
  const profile = defaultGraphShareProfile({
    branch: 'refs/heads/main',
    canonicalRemote: 'github.com/acme/graph-share',
    organization: 'acme',
    publisherKeyFingerprint: key.fingerprint,
    repositoryId: REPOSITORY_ID,
  });
  const profileDigest = graphShareProfileDigest(profile);
  yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(profile)));
  const enrollment = parseGraphShareEnrollment({
    profile: casProfilePointer(profileDigest),
    publisherKeyFingerprint: key.fingerprint,
    repositoryId: REPOSITORY_ID,
    schemaVersion: 1,
  });
  yield* fs.writeFileString(path.join(repo, '.threadnote/graph-share.json'), `${JSON.stringify(enrollment)}\n`);
  yield* writeGraphShareTrustReceipt(home, trustReceiptFromEnrollment(enrollment, profile, profileDigest, 'read-only'));
  const checkpointDigest = sha256Digest(CHECKPOINT_BYTES);
  const manifest: GraphShareFrontierManifestV1 = {
    branch: 'refs/heads/main',
    checkpoint: {
      manifestDigest: checkpointDigest,
      snapshotId: 'cgsn_imported',
      sourceCommit: 'a'.repeat(40),
    },
    deltas: [],
    generation: 1,
    graphAbi: 'e'.repeat(64),
    graphContentId: `cgc_${'d'.repeat(40)}`,
    logicalGraphDigest: `sha256:${'2'.repeat(64)}`,
    previousManifestDigest: null,
    profileDigest,
    publisherFence: 1,
    repositoryId: REPOSITORY_ID,
    schemaVersion: 1,
    snapshotId: 'cgsn_imported',
    sourceCommit: 'a'.repeat(40),
  };
  const signed = yield* signGraphShareFrontier(key, manifest);
  const manifestDigest = yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(manifest)));
  const envelopeDigest = yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(signed.envelope)));
  if (options.includeFrontier) {
    const layout = graphSharingLayout(path, home, casRoot);
    yield* fs.makeDirectory(path.join(layout.frontiersRoot, REPOSITORY_ID), {recursive: true});
    yield* fs.writeFileString(
      path.join(layout.frontiersRoot, REPOSITORY_ID, 'latest.json'),
      `${JSON.stringify({envelopeDigest, manifestDigest, schemaVersion: 1})}\n`,
    );
    if (!options.skipCheckpoint) yield* putCasBytes(casRoot, CHECKPOINT_BYTES);
  }
  return {
    casRoot,
    checkpointDigest,
    enrollment,
    envelope: signed.envelope,
    manifestDigest,
    profile,
    profileDigest,
    repo,
  };
});

function quarantineNames(home: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = graphSharingLayout(path, home).quarantineRoot;
    if (!(yield* fs.exists(root))) return [];
    return [...(yield* fs.readDirectory(root))].sort();
  });
}

function flipHex(value: string): string {
  const last = value.at(-1) === 'a' ? 'b' : 'a';
  return `${value.slice(0, -1)}${last}`;
}

function git(repo: string, args: readonly string[]) {
  return runCommandEffect('git', ['-C', repo, ...args]);
}
