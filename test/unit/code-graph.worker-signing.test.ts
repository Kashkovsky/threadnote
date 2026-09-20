import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {SystemInfo} from '../../src/effect/system.js';
import {generateGraphSharePublisherKey} from '../../src/code_graph/sharing/artifacts.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {makeGraphWorkerSigner, verifyGraphWorkerSignature} from '../../src/code_graph/sharing/worker/signing.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '../helpers/fast-check-property.js';

const layer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));
const identity = sha256Digest('approved provider, principal, repository and profile');
const fixture = Effect.fn('test.workerSigning.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-worker-signing-'});
  return {fs, home, target: path.join(home, 'graph-sharing/worker-keys', identity.slice(7) + '.json')};
});

describe('graph worker signing identities', () => {
  effectIt.effect('creates one private signing key across concurrent sessions and isolates another authority', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const signers = yield* Effect.forEach(Array.from({length: 8}), () => makeGraphWorkerSigner(f.home, identity), {
          concurrency: 8,
        });
        expect(new Set(signers.map(signer => signer.publicKey)).size).toBe(1);
        expect((yield* makeGraphWorkerSigner(f.home, identity)).publicKey).toBe(signers[0].publicKey);
        expect((yield* makeGraphWorkerSigner(f.home, sha256Digest('another principal'))).publicKey).not.toBe(
          signers[0].publicKey,
        );
        const saved = JSON.parse(yield* f.fs.readFileString(f.target));
        expect(JSON.stringify(signers)).not.toContain(saved.privateKey);
        if ((yield* SystemInfo).platform !== 'win32') expect((yield* f.fs.stat(f.target)).mode & 0o077).toBe(0);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  fcEffectProp(
    effectIt,
    'signatures are deterministic and bind the exact bytes, operation domain and enrolled key',
    {body: FC.uint8Array({minLength: 1, maxLength: 256})},
    ({body}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const signer = yield* makeGraphWorkerSigner(f.home, identity);
        const signature = yield* signer.sign('attestation', body);
        expect(yield* signer.sign('attestation', new Uint8Array(body))).toBe(signature);
        yield* verifyGraphWorkerSignature(signer.publicKey, 'attestation', body, signature);
        const changed = new Uint8Array(body);
        changed[0] ^= 1;
        for (const [key, kind, bytes, signed] of [
          [signer.publicKey, 'attestation', changed, signature],
          [signer.publicKey, 'announcement', body, signature],
          ['0'.repeat(64), 'attestation', body, signature],
          [signer.publicKey, 'attestation', body, '0'.repeat(128)],
        ] as const)
          expect((yield* Effect.result(verifyGraphWorkerSignature(key, kind, bytes, signed)))._tag).toBe('Failure');
      }).pipe(provideTestLayer(layer)),
    {fastCheck: {numRuns: 25}},
  );

  effectIt.effect('refuses corrupted private keys without replacing them or exposing key material', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* makeGraphWorkerSigner(f.home, identity);
      const saved = JSON.parse(yield* f.fs.readFileString(f.target));
      const other = yield* generateGraphSharePublisherKey();
      for (const override of [{publicKey: 'a'.repeat(64)}, {privateKey: other.privateKey}]) {
        const invalid = JSON.stringify({...saved, ...override});
        yield* f.fs.writeFileString(f.target, invalid);
        const rejected = yield* Effect.result(makeGraphWorkerSigner(f.home, identity));
        expect(rejected._tag).toBe('Failure');
        expect(JSON.stringify(rejected)).not.toContain(saved.privateKey);
        expect(JSON.stringify(rejected)).not.toContain(other.privateKey);
        expect(yield* f.fs.readFileString(f.target)).toBe(invalid);
      }
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('bounds signing inputs and rejects invalid authority and signature encodings', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect((yield* Effect.result(makeGraphWorkerSigner(f.home, '../another-key')))._tag).toBe('Failure');
      const signer = yield* makeGraphWorkerSigner(f.home, identity);
      expect((yield* Effect.result(signer.sign('announcement', new Uint8Array(65_537))))._tag).toBe('Failure');
      expect(
        (yield* Effect.result(
          verifyGraphWorkerSignature(signer.publicKey, 'attestation', new Uint8Array(1), 'not-a-signature'),
        ))._tag,
      ).toBe('Failure');
    }).pipe(provideTestLayer(layer)),
  );
});
