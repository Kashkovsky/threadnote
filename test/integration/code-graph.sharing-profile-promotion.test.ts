import {expect, it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {graphRegistryFixture} from '../helpers/graph-registry.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {decodeJsonBytes, readJsonFile, writePrivateJsonFile} from '../../src/code_graph/sharing/atomic.js';
import {readVerifiedCasBlob} from '../../src/code_graph/sharing/cas.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {
  graphShareEnrollmentPath,
  graphSharingCasBlobPath,
  graphSharingFrontierPointerPath,
  graphSharingLayout,
} from '../../src/code_graph/sharing/layout.js';
import {
  parseGraphShareEnrollment,
  parseGraphShareProfile,
  parseGraphShareProfilePointer,
} from '../../src/code_graph/sharing/profile.js';
import {
  runGraphPublisherBootstrap,
  runGraphPublisherProfilePromote,
  runGraphShareInit,
} from '../../src/code_graph/sharing/publisher.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

const canonicalRegistry = 'oci://registry.example.test/acme/canonical';
const workerRegistry = 'oci://registry.example.test/acme/worker';

function rejected<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const result = yield* Effect.exit(effect);
    if (Exit.isSuccess(result)) return yield* Effect.die('Expected an operation failure');
    return Cause.squash(result.cause);
  });
}

const repositoryFixture = Effect.fn('test.publisherProfilePromotion.repositoryFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-profile-promotion-'});
  const repository = path.join(root, 'repository');
  const cas = path.join(root, 'cas');
  const config = {agentContextHome: path.join(root, 'publisher-home')} as Parameters<typeof runGraphShareInit>[0];
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
  const commit = (message: string) =>
    git(['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', message]);
  yield* fs.makeDirectory(repository);
  yield* git(['init', '-q', '--initial-branch=main']);
  yield* git(['remote', 'add', 'origin', 'https://github.com/acme/profile-promotion-test.git']);
  yield* fs.writeFileString(path.join(repository, 'index.ts'), 'export const value = 1;\n');
  yield* git(['add', 'index.ts']);
  yield* commit('base');
  return {cas, config, fs, git, path, repository, commit};
});

const fixture = Effect.fn('test.publisherProfilePromotion.fixture')(function* () {
  const base = yield* repositoryFixture();
  const {cas, config, fs, git, path, repository, commit} = base;
  const registry = yield* graphRegistryFixture();
  const initialized = yield* runGraphShareInit(config, {
    cas,
    cwd: repository,
    organization: 'acme',
    registry: canonicalRegistry,
    workerRegistry,
    writeConfig: true,
  });
  const pointer = parseGraphShareProfilePointer(initialized.enrollment.profile);
  if (pointer.kind !== 'cas') return yield* Effect.die('Initial enrollment must be CAS-pinned');
  const profile = parseGraphShareProfile(yield* decodeJsonBytes(yield* readVerifiedCasBlob(cas, pointer.bodyDigest)));
  expect(profile.registry).toEqual({canonical: canonicalRegistry, worker: workerRegistry});
  const enrollmentPath = graphShareEnrollmentPath(path, repository);
  const enrollment = parseGraphShareEnrollment(initialized.enrollment);
  yield* git(['add', '.threadnote/graph-share.json']);
  yield* commit('stage CAS profile');
  const head = (yield* git(['rev-parse', 'HEAD'])).stdout.trim();
  const enrollmentBytes = yield* fs.readFileString(enrollmentPath);
  const keyPath = graphSharingLayout(path, config.agentContextHome, cas).publisherKeyPath;
  const promote = (registryReference = canonicalRegistry) =>
    registry.provide(runGraphPublisherProfilePromote(config, {cas, cwd: repository, registry: registryReference}));
  return {...base, enrollment, enrollmentBytes, enrollmentPath, head, keyPath, promote, registry};
});

effectIt.effect('publishes the staged v1 profile and returns a stable v2 candidate without changing Git', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.promote();
      expect(first.enrollment).toMatchObject({
        profile: `${canonicalRegistry}@${first.manifestDigest}`,
        profileDigest: first.profileDigest,
        publisherKeyFingerprint: f.enrollment.publisherKeyFingerprint,
        repositoryId: f.enrollment.repositoryId,
        schemaVersion: 2,
      });
      expect(first.manifestDigest).not.toBe(first.profileDigest);
      expect(first.profileDigest).toBe(f.enrollment.profile.slice('cas://'.length));
      expect(yield* f.fs.readFileString(f.enrollmentPath)).toBe(f.enrollmentBytes);
      expect((yield* f.git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(f.head);
      expect((yield* f.git(['status', '--porcelain'])).stdout).toBe('');
      expect(f.registry.manifests.has(first.manifestDigest)).toBe(true);
      expect(f.registry.manifests.has(`tn-profile-${first.manifestDigest.slice('sha256:'.length)}`)).toBe(true);
      expect(f.registry.requests.some(request => request.method === 'PUT')).toBe(true);

      const retry = yield* f.promote();
      expect(retry).toEqual(first);
      expect(
        f.registry.requests.filter(
          request =>
            request.method === 'PUT' &&
            request.pathname ===
              `/v2/acme/canonical/manifests/tn-profile-${first.manifestDigest.slice('sha256:'.length)}`,
        ),
      ).toHaveLength(1);
      expect(yield* f.fs.readFileString(f.enrollmentPath)).toBe(f.enrollmentBytes);
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);

effectIt.effect('stages a fresh org outside Git history and replaces its temporary v1 file only after promotion', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* repositoryFixture();
      const registry = yield* graphRegistryFixture();
      const initialHead = (yield* f.git(['rev-parse', 'HEAD'])).stdout.trim();
      const staged = yield* runGraphShareInit(f.config, {
        cas: f.cas,
        cwd: f.repository,
        organization: 'acme',
        registry: canonicalRegistry,
        workerRegistry,
        writeConfig: true,
      });
      const stagedBytes = yield* f.fs.readFileString(staged.enrollmentPath);
      expect(parseGraphShareEnrollment(JSON.parse(stagedBytes))).toEqual(staged.enrollment);
      const promoted = yield* registry.provide(
        runGraphPublisherProfilePromote(f.config, {cas: f.cas, cwd: f.repository, registry: canonicalRegistry}),
      );
      expect(yield* f.fs.readFileString(staged.enrollmentPath)).toBe(stagedBytes);
      expect((yield* f.git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(initialHead);
      yield* f.fs.writeFileString(staged.enrollmentPath, `${JSON.stringify(promoted.enrollment, undefined, 2)}\n`);
      expect(parseGraphShareEnrollment(JSON.parse(yield* f.fs.readFileString(staged.enrollmentPath)))).toEqual(
        promoted.enrollment,
      );
      expect((yield* f.git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(initialHead);
      expect((yield* f.git(['status', '--porcelain'])).stdout).toContain('.threadnote/');
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);

effectIt.effect('bootstraps from the promoted v2 pointer only while its persisted manifest remains verified', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture();
      const promoted = yield* f.promote();
      yield* f.fs.writeFileString(f.enrollmentPath, `${JSON.stringify(promoted.enrollment, undefined, 2)}\n`);
      yield* f.git(['add', '.threadnote/graph-share.json']);
      yield* f.commit('enroll verified OCI profile');
      const indexer = yield* CodeGraphIndexer;
      yield* indexer.index({
        cwd: f.repository,
        ensureVectors: false,
        force: true,
        threadnoteHome: f.config.agentContextHome,
      });
      const manifestPath = graphSharingCasBlobPath(f.path, f.cas, promoted.manifestDigest.slice('sha256:'.length));
      const manifestBytes = yield* f.fs.readFile(manifestPath);
      yield* f.fs.remove(manifestPath);
      const requestsBefore = f.registry.requests.length;
      const frontierPath = graphSharingFrontierPointerPath(
        f.path,
        graphSharingLayout(f.path, f.config.agentContextHome, f.cas).frontiersRoot,
        promoted.enrollment.repositoryId,
      );
      expect(
        yield* rejected(f.registry.provide(runGraphPublisherBootstrap(f.config, {cas: f.cas, cwd: f.repository}))),
      ).toBeInstanceOf(Error);
      expect(f.registry.requests).toHaveLength(requestsBefore);
      expect(yield* f.fs.exists(frontierPath)).toBe(false);
      yield* f.fs.writeFile(manifestPath, manifestBytes);
      const bootstrapped = yield* f.registry.provide(
        runGraphPublisherBootstrap(f.config, {cas: f.cas, cwd: f.repository}),
      );
      expect(bootstrapped.profileDigest).toBe(promoted.profileDigest);
      expect(bootstrapped.publication.status).toBe('acknowledged');
      expect(yield* f.fs.exists(frontierPath)).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);

effectIt.effect('rejects mismatched repository, key, and registry before any registry request', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture();
      const identity = yield* resolveRepositoryIdentity(f.repository);
      expect(identity.repositoryId).toBe(f.enrollment.repositoryId);
      const cases = [
        {
          enrollment: {...f.enrollment, repositoryId: 'f'.repeat(64)},
          message: /repository|enrollment/iu,
          registry: canonicalRegistry,
        },
        {
          enrollment: {...f.enrollment, publisherKeyFingerprint: sha256Digest('different publisher key')},
          message: /authority|publisher key|profile/iu,
          registry: canonicalRegistry,
        },
        {
          enrollment: f.enrollment,
          message: /authority|registry/iu,
          registry: workerRegistry,
        },
      ];
      for (const candidate of cases) {
        yield* writePrivateJsonFile(f.enrollmentPath, candidate.enrollment);
        const pointerBeforePromotion = yield* f.fs.readFileString(f.enrollmentPath);
        const failure = yield* rejected(f.promote(candidate.registry));
        expect(failure).toMatchObject({kind: 'verification-failed', message: expect.stringMatching(candidate.message)});
        expect(f.registry.requests).toHaveLength(0);
        expect(yield* f.fs.readFileString(f.enrollmentPath)).toBe(pointerBeforePromotion);
      }
      yield* writePrivateJsonFile(f.enrollmentPath, f.enrollment);
      expect(parseGraphShareEnrollment(yield* readJsonFile(f.enrollmentPath))).toEqual(f.enrollment);
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);

effectIt.effect('validates both exact, distinct OCI init references before writing an enrollment pointer', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* repositoryFixture();
      const enrollmentPath = graphShareEnrollmentPath(f.path, f.repository);
      const cases = [
        {registry: canonicalRegistry, message: /both --registry and --worker-registry/iu},
        {workerRegistry, message: /both --registry and --worker-registry/iu},
        {
          registry: canonicalRegistry,
          workerRegistry: canonicalRegistry,
          message: /must differ/iu,
        },
        {
          registry: 'oci://publisher:secret@registry.example.test/acme/canonical',
          workerRegistry,
          message: /canonical OCI registry reference is invalid/iu,
        },
        {
          registry: 'oci://Registry.example.test/acme/canonical',
          workerRegistry,
          message: /canonical OCI registry reference is invalid/iu,
        },
      ];
      for (const invalid of cases) {
        const failure = yield* rejected(
          runGraphShareInit(f.config, {
            cas: f.cas,
            cwd: f.repository,
            organization: 'acme',
            writeConfig: true,
            ...invalid,
          }),
        );
        expect(failure).toMatchObject({kind: 'verification-failed', message: expect.stringMatching(invalid.message)});
        expect(yield* f.fs.exists(enrollmentPath)).toBe(false);
      }
      const keyPath = graphSharingLayout(f.path, f.config.agentContextHome, f.cas).publisherKeyPath;
      expect(yield* f.fs.exists(keyPath)).toBe(false);
      expect((yield* f.git(['status', '--porcelain'])).stdout).toBe('');
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);

effectIt.effect('rejects a missing persisted signing key before any registry request', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.remove(f.keyPath);
      const failure = yield* rejected(f.promote());
      expect(failure).toMatchObject({
        kind: 'verification-failed',
        message: expect.stringMatching(/persisted publisher signing key/iu),
      });
      expect(f.registry.requests).toHaveLength(0);
      expect(yield* f.fs.readFileString(f.enrollmentPath)).toBe(f.enrollmentBytes);
    }).pipe(provideTestLayer(ApplicationLayer)),
  ),
);
