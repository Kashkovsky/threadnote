import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {graphShareParseActionKey} from '../../src/code_graph/sharing/action.js';
import {sha256Digest, sha256HexFromDigest} from '../../src/code_graph/sharing/digest.js';
import {graphShareParseResultArtifact} from '../../src/code_graph/sharing/parse_result.js';
import {
  markGraphWorkerDeliveryAdmitted,
  prepareGraphWorkerDeliveryOutbox,
  readGraphWorkerDeliveryOutbox,
  retireGraphWorkerDeliveryOutbox,
} from '../../src/code_graph/sharing/worker_delivery_outbox.js';
import {signGraphWorkerResultAnnouncement} from '../../src/code_graph/sharing/worker_announcement.js';
import {createGraphWorkerResultArtifact} from '../../src/code_graph/sharing/worker_result.js';
import {makeGraphWorkerSigner} from '../../src/code_graph/sharing/worker_signing.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const layer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));
const encode = (value: unknown) => new TextEncoder().encode(canonicalJson(value));

const fixture = Effect.fn('test.workerOutbox.fixture')(function* (diagnostic = '', existingHome?: string) {
  const fs = yield* FileSystem.FileSystem;
  const home = existingHome ?? (yield* fs.makeTempDirectoryScoped({prefix: 'graph-worker-outbox-'}));
  const signer = yield* makeGraphWorkerSigner(home, sha256Digest('outbox fixture'));
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const action = {
    contentHash: 'a'.repeat(64), extractorSet: 'b'.repeat(64),
    languageAndRole: 'typescript:source', normalizedPath: 'src/index.ts', repositoryId: 'c'.repeat(64),
  };
  const result = graphShareParseResultArtifact({
    ...action, actionKey: graphShareParseActionKey(action), gitBlobId: 'd'.repeat(40),
    facts: {path: action.normalizedPath, diagnostics: diagnostic ? [diagnostic] : [], edges: [], symbols: []},
  });
  const authority = {
    expiresAt: now + 3600, graphAbi: 'e'.repeat(64), principalId: sha256Digest('principal'),
    profileDigest: sha256Digest('profile'), repositoryId: action.repositoryId,
    signingPublicKey: signer.publicKey, workerId: 'gw_' + 'f'.repeat(32),
  };
  const sourceCommit = '1'.repeat(40);
  const candidate = {
    actionKey: result.actionKey, batchId: sourceCommit, casRoot: '/private/cas',
    extractorSet: action.extractorSet, graphAbi: authority.graphAbi, organization: 'threadnote',
    partialCoverage: false, platform: {architecture: 'x64' as const, os: 'linux' as const},
    profileDigest: authority.profileDigest, queuedAtMilliseconds: now * 1000,
    releaseIdentity: '4.6.11-local.gfixture', resourceLimits: [],
    resultDigest: sha256Digest(encode(result)), resultSize: encode(result).byteLength,
    semanticDigest: result.semanticDigest, snapshotId: `cgsn_${'2'.repeat(40)}`,
    sourceCommit,
  };
  const artifact = yield* createGraphWorkerResultArtifact({
    metadata: {
      batchId: sourceCommit, graphAbi: authority.graphAbi, identityClass: 'oauth-principal',
      issuedAt: now, partialCoverage: candidate.partialCoverage, platform: candidate.platform,
      principalId: authority.principalId, profileDigest: authority.profileDigest,
      releaseIdentity: candidate.releaseIdentity, repositoryId: authority.repositoryId,
      resourceLimits: [], sourceCommit, workerId: authority.workerId,
    },
    resultBytes: encode(result), signer,
  });
  const announcement = yield* signGraphWorkerResultAnnouncement({artifact, expected: authority, signer});
  const input = {announcement, artifact, authority, candidate, candidatePageId: '3'.repeat(64),
    repositoryId: authority.repositoryId, threadnoteHome: home};
  return {home, input, result};
});

describe('private signed worker delivery outbox', () => {
  effectIt.effect('survives restart and a lost admission ACK, then retires only after exact candidate ACK', () =>
    Effect.gen(function* () {
      const {input} = yield* fixture();
      const first = yield* prepareGraphWorkerDeliveryOutbox(input);
      expect(first.prepared).toBe(true);
      const replay = yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, input.repositoryId);
      expect(replay).toHaveLength(1);
      expect(replay[0].artifact).toEqual(input.artifact);
      expect((yield* prepareGraphWorkerDeliveryOutbox(input)).prepared).toBe(false);
      const anotherPage = yield* prepareGraphWorkerDeliveryOutbox({...input, candidatePageId: '8'.repeat(64)});
      expect(anotherPage.prepared).toBe(false);
      expect(anotherPage.sourcePageId).toBe('8'.repeat(64));
      const response = {idempotencyKey: first.operation.operationId, status: 'accepted' as const};
      const ackInput = {candidateIdentity: first.operation.candidateIdentity,
        candidatePageId: first.operation.candidatePageId, operationId: first.operation.operationId,
        repositoryId: input.repositoryId, response, threadnoteHome: input.threadnoteHome};
      expect((yield* Effect.result(retireGraphWorkerDeliveryOutbox({...ackInput, candidateAbsent: true})))._tag).toBe('Failure');
      expect((yield* Effect.result(markGraphWorkerDeliveryAdmitted({...ackInput,
        response: {...response, idempotencyKey: sha256Digest('wrong')}})))._tag).toBe('Failure');
      expect((yield* markGraphWorkerDeliveryAdmitted(ackInput)).state).toBe('admitted');
      expect((yield* markGraphWorkerDeliveryAdmitted(ackInput)).state).toBe('admitted');
      expect((yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, input.repositoryId))[0].operation.state).toBe('admitted');
      expect(yield* retireGraphWorkerDeliveryOutbox({...ackInput, candidateAbsent: true})).toBe(true);
      expect(yield* retireGraphWorkerDeliveryOutbox({...ackInput, candidateAbsent: true})).toBe(false);
      expect(yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, input.repositoryId)).toEqual([]);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('rejects replay after a content-addressed blob is changed or replaced by a symlink', () =>
    Effect.gen(function* () {
      const {input} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const prepared = yield* prepareGraphWorkerDeliveryOutbox(input);
      const blob = path.join(input.threadnoteHome, 'graph-sharing', 'worker-delivery', input.repositoryId,
        'sha256', sha256HexFromDigest(prepared.operation.resultDigest));
      yield* fs.writeFile(blob, new Uint8Array([1, 2, 3]));
      expect((yield* Effect.result(readGraphWorkerDeliveryOutbox(input.threadnoteHome, input.repositoryId)))._tag).toBe('Failure');
      yield* fs.remove(blob);
      yield* fs.symlink(input.threadnoteHome, blob);
      expect((yield* Effect.result(readGraphWorkerDeliveryOutbox(input.threadnoteHome, input.repositoryId)))._tag).toBe('Failure');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('enforces aggregate stored blob quota without evicting a queued operation', () =>
    Effect.gen(function* () {
      const {input} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const first = yield* prepareGraphWorkerDeliveryOutbox(input);
      const second = yield* fixture('another result', input.threadnoteHome);
      const directory = path.join(input.threadnoteHome, 'graph-sharing', 'worker-delivery', input.repositoryId, 'sha256');
      const payload = new Uint8Array(32 * 1_048_576);
      for (const char of ['4', '5', '6', '7']) yield* fs.writeFile(path.join(directory, char.repeat(64)), payload);
      expect((yield* Effect.result(prepareGraphWorkerDeliveryOutbox(second.input)))._tag).toBe('Failure');
      expect((yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, input.repositoryId))[0].operation.operationId)
        .toBe(first.operation.operationId);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('refuses metadata that changes signed scope or adds unknown announcement fields', () =>
    Effect.gen(function* () {
      const {input} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* prepareGraphWorkerDeliveryOutbox(input);
      const metadata = path.join(input.threadnoteHome, 'graph-sharing', 'worker-delivery', input.repositoryId, 'outbox.json');
      const original = yield* fs.readFileString(metadata);
      const document = JSON.parse(original);
      document.operations[0].announcement.body.unknown = true;
      yield* fs.writeFileString(metadata, JSON.stringify(document));
      expect((yield* Effect.result(readGraphWorkerDeliveryOutbox(input.threadnoteHome, input.repositoryId)))._tag).toBe('Failure');
      document.operations[0].announcement.body.unknown = undefined;
      document.operations[0].organization = 'another-org';
      yield* fs.writeFileString(metadata, JSON.stringify(document));
      expect((yield* Effect.result(readGraphWorkerDeliveryOutbox(input.threadnoteHome, input.repositoryId)))._tag).toBe('Failure');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('reuses a verified orphan blob after an interrupted preparation', () =>
    Effect.gen(function* () {
      const {input} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(input.threadnoteHome, 'graph-sharing', 'worker-delivery', input.repositoryId, 'sha256');
      yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
      const target = path.join(directory, sha256HexFromDigest(sha256Digest(input.artifact.resultBytes)));
      yield* fs.writeFile(target, input.artifact.resultBytes, {mode: 0o600});
      expect(yield* prepareGraphWorkerDeliveryOutbox(input)).toMatchObject({prepared: true});
      expect((yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, input.repositoryId))[0].artifact.resultBytes)
        .toEqual(new Uint8Array(input.artifact.resultBytes));
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect.prop('preparation snapshots caller bytes and keeps exact replay across arbitrary facts', {
    diagnostic: FC.string({maxLength: 64}),
  }, ({diagnostic}) =>
    Effect.gen(function* () {
      const {input} = yield* fixture(diagnostic);
      const expected = new Uint8Array(input.artifact.resultBytes);
      const first = yield* prepareGraphWorkerDeliveryOutbox(input);
      input.artifact.resultBytes.fill(0);
      input.candidate.casRoot = '/mutated';
      const replay = yield* readGraphWorkerDeliveryOutbox(input.threadnoteHome, input.repositoryId);
      expect(replay[0].artifact.resultBytes).toEqual(expected);
      expect(replay[0].operation.candidate.casRoot).toBe('/private/cas');
      expect(replay[0].operation.operationId).toBe(first.operation.operationId);
    }).pipe(provideTestLayer(layer)),
  );
});
