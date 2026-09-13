import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer} from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {graphShareParseActionKey} from '../../src/code_graph/sharing/action.js';
import {
  enqueuePersistedGraphShareContribution,
  readGraphShareContributionQueue,
} from '../../src/code_graph/sharing/contribution.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {graphSharingUnavailable} from '../../src/code_graph/sharing/errors.js';
import {graphShareParseResultArtifact} from '../../src/code_graph/sharing/parse_result.js';
import {
  acknowledgeGraphShareSignedCandidatePage,
  graphShareSignedCandidateIdentity,
  listGraphShareSignedCandidatePageIds,
  persistGraphShareSignedCandidates,
  readGraphShareSignedCandidatePage,
} from '../../src/code_graph/sharing/signed_candidate.js';
import {
  graphWorkerDeliveryScope,
  listGraphWorkerDeliveryOutboxOperations,
  markGraphWorkerDeliveryAdmitted,
  prepareGraphWorkerDeliveryOutbox,
  readGraphWorkerDeliveryOutboxOperation,
} from '../../src/code_graph/sharing/worker_delivery_outbox.js';
import {
  finishAdmittedGraphWorkerResult,
  submitPreparedGraphWorkerResult,
} from '../../src/code_graph/sharing/worker_delivery.js';
import {signGraphWorkerResultAnnouncement} from '../../src/code_graph/sharing/worker_announcement.js';
import {createGraphWorkerResultArtifact} from '../../src/code_graph/sharing/worker_result.js';
import {makeGraphWorkerSigner} from '../../src/code_graph/sharing/worker_signing.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const layer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));
const encode = (value: unknown) => new TextEncoder().encode(canonicalJson(value));

const fixture = Effect.fn('test.workerDelivery.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-worker-delivery-'});
  const signer = yield* makeGraphWorkerSigner(home, sha256Digest('credential identity'));
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const sourceCommit = '1'.repeat(40);
  const repositoryId = 'c'.repeat(64);
  const action = {
    contentHash: 'a'.repeat(64),
    extractorSet: 'b'.repeat(64),
    languageAndRole: 'typescript:source',
    normalizedPath: 'src/index.ts',
    repositoryId,
  };
  const result = graphShareParseResultArtifact({
    ...action,
    actionKey: graphShareParseActionKey(action),
    gitBlobId: 'd'.repeat(40),
    facts: {path: action.normalizedPath, diagnostics: [], edges: [], symbols: []},
  });
  const resultBytes = encode(result);
  const resultDigest = sha256Digest(resultBytes);
  const profileDigest = sha256Digest('profile');
  const authority = {
    expiresAt: now + 3600,
    graphAbi: 'e'.repeat(64),
    principalId: sha256Digest('first principal'),
    profileDigest,
    repositoryId,
    signingPublicKey: signer.publicKey,
    workerId: 'gw_' + 'f'.repeat(32),
  };
  const candidate = {
    actionKey: result.actionKey,
    batchId: sourceCommit,
    casRoot: `${home}/cas`,
    extractorSet: action.extractorSet,
    graphAbi: authority.graphAbi,
    organization: 'threadnote',
    partialCoverage: false,
    platform: {architecture: 'x64' as const, os: 'linux' as const},
    profileDigest,
    queuedAtMilliseconds: now * 1000,
    releaseIdentity: '4.6.11-local.gfixture',
    resourceLimits: [],
    resultDigest,
    resultSize: resultBytes.byteLength,
    semanticDigest: result.semanticDigest,
    snapshotId: `cgsn_${'2'.repeat(40)}`,
    sourceCommit,
  };
  yield* persistGraphShareSignedCandidates(home, repositoryId, [candidate]);
  const [candidatePageId] = yield* listGraphShareSignedCandidatePageIds(home, repositoryId);
  const selfAttestation = sha256Digest(
    canonicalJson({kind: 'contributor-self', payloadDigest: resultDigest, schemaVersion: 1}),
  );
  yield* enqueuePersistedGraphShareContribution(
    home,
    repositoryId,
    'join',
    {
      actionKey: result.actionKey,
      attestationDigest: selfAttestation,
      batchId: sourceCommit,
      resultManifestDigest: resultDigest,
      semanticDigest: result.semanticDigest,
    },
    'passive',
  );
  const artifact = yield* createGraphWorkerResultArtifact({
    metadata: {
      batchId: sourceCommit,
      graphAbi: authority.graphAbi,
      identityClass: 'oauth-principal',
      issuedAt: now,
      partialCoverage: false,
      platform: candidate.platform,
      principalId: authority.principalId,
      profileDigest,
      releaseIdentity: candidate.releaseIdentity,
      repositoryId,
      resourceLimits: [],
      sourceCommit,
      workerId: authority.workerId,
    },
    resultBytes,
    signer,
  });
  const announcement = yield* signGraphWorkerResultAnnouncement({artifact, expected: authority, signer});
  const prepared = yield* prepareGraphWorkerDeliveryOutbox({
    announcement,
    artifact,
    authority,
    candidate,
    candidatePageId,
    repositoryId,
    threadnoteHome: home,
  });
  const scope = graphWorkerDeliveryScope(authority, candidate.organization);
  return {artifact, candidate, candidatePageId, home, prepared, repositoryId, scope};
});

describe('automatic signed graph worker delivery', () => {
  effectIt.effect('preserves exact prepared bytes on outage and retires only after echoed admission and page ACK', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        let uploaded = 0;
        const request = {repositoryId: f.repositoryId, threadnoteHome: f.home};
        const first = yield* submitPreparedGraphWorkerResult(request, f.scope, f.prepared.operation, {
          isAuthorized: Effect.succeed(true),
          upload: Effect.sync(() => {
            uploaded += 1;
          }),
          announce: Effect.fail(graphSharingUnavailable('Coordinator unavailable.')),
        }).pipe(Effect.result);
        expect(first._tag).toBe('Failure');
        expect(uploaded).toBe(1);
        const restarted = yield* readGraphWorkerDeliveryOutboxOperation(
          f.home,
          f.scope,
          f.prepared.operation.operationId,
        );
        expect(restarted?.operation.state).toBe('prepared');
        expect(restarted?.artifact).toEqual(f.artifact);
        expect(
          (yield* readGraphShareSignedCandidatePage(f.home, f.repositoryId, f.candidatePageId))?.candidates,
        ).toHaveLength(1);
        expect((yield* readGraphShareContributionQueue(f.home, f.repositoryId, 'passive')).announcements).toHaveLength(
          1,
        );
        yield* submitPreparedGraphWorkerResult(request, f.scope, restarted!.operation, {
          isAuthorized: Effect.succeed(true),
          upload: Effect.sync(() => {
            uploaded += 1;
          }),
          announce: Effect.succeed({
            status: 201,
            body: {idempotencyKey: restarted!.operation.operationId, status: 'accepted'},
          }),
        });
        expect(uploaded).toBe(2);
        expect(yield* listGraphShareSignedCandidatePageIds(f.home, f.repositoryId)).toEqual([]);
        expect((yield* readGraphShareContributionQueue(f.home, f.repositoryId, 'passive')).announcements).toEqual([]);
        expect(yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope)).toEqual([]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('does not enumerate or dispatch an old principal outbox after credentials switch', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const switched = {...f.scope, principalId: sha256Digest('second principal')};
        expect(yield* listGraphWorkerDeliveryOutboxOperations(f.home, switched)).toEqual([]);
        let uploaded = false;
        const denied = yield* submitPreparedGraphWorkerResult(
          {repositoryId: f.repositoryId, threadnoteHome: f.home},
          f.scope,
          f.prepared.operation,
          {
            isAuthorized: Effect.succeed(false),
            upload: Effect.sync(() => {
              uploaded = true;
            }),
            announce: Effect.succeed({
              status: 201,
              body: {idempotencyKey: f.prepared.operation.operationId, status: 'accepted'},
            }),
          },
        ).pipe(Effect.result);
        expect(denied._tag).toBe('Failure');
        expect(uploaded).toBe(false);
        expect((yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope))[0].state).toBe('prepared');
        expect(
          (yield* readGraphShareSignedCandidatePage(f.home, f.repositoryId, f.candidatePageId))?.candidates,
        ).toHaveLength(1);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('keeps the candidate queued when admission returns a different operation ID', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const attempted = yield* submitPreparedGraphWorkerResult(
          {repositoryId: f.repositoryId, threadnoteHome: f.home},
          f.scope,
          f.prepared.operation,
          {
            isAuthorized: Effect.succeed(true),
            upload: Effect.void,
            announce: Effect.succeed({
              status: 201,
              body: {idempotencyKey: sha256Digest('different'), status: 'accepted'},
            }),
          },
        ).pipe(Effect.result);
        expect(attempted._tag).toBe('Failure');
        expect((yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope))[0].state).toBe('prepared');
        expect(
          (yield* readGraphShareSignedCandidatePage(f.home, f.repositoryId, f.candidatePageId))?.candidates,
        ).toHaveLength(1);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('finds an exact candidate moved to a new page before retiring an admitted operation', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const identity = graphShareSignedCandidateIdentity(f.candidate);
        yield* acknowledgeGraphShareSignedCandidatePage(f.home, f.repositoryId, f.candidatePageId, new Set([identity]));
        const other = {...f.candidate, snapshotId: `cgsn_${'3'.repeat(40)}`};
        yield* persistGraphShareSignedCandidates(f.home, f.repositoryId, [f.candidate, other]);
        const [newPageId] = yield* listGraphShareSignedCandidatePageIds(f.home, f.repositoryId);
        expect(newPageId).not.toBe(f.candidatePageId);
        const admitted = yield* markGraphWorkerDeliveryAdmitted({
          scope: f.scope,
          candidateIdentity: identity,
          candidatePageId: f.candidatePageId,
          operationId: f.prepared.operation.operationId,
          response: {idempotencyKey: f.prepared.operation.operationId, status: 'accepted'},
          threadnoteHome: f.home,
        });
        yield* finishAdmittedGraphWorkerResult(
          {repositoryId: f.repositoryId, threadnoteHome: f.home},
          f.scope,
          admitted,
        );
        const [remainingPage] = yield* listGraphShareSignedCandidatePageIds(f.home, f.repositoryId);
        expect((yield* readGraphShareSignedCandidatePage(f.home, f.repositoryId, remainingPage))?.candidates).toEqual([
          other,
        ]);
        expect(yield* listGraphWorkerDeliveryOutboxOperations(f.home, f.scope)).toEqual([]);
      }).pipe(provideTestLayer(layer)),
    ),
  );
});
