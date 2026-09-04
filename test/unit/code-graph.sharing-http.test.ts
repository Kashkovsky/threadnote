import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Deferred, Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'effect/testing/FastCheck';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {decodeJsonBytes, readJsonFile} from '../../src/code_graph/sharing/atomic.js';
import {
  graphShareControlAnnounceResult,
  graphShareControlGetCas,
  graphShareControlGetJson,
  graphShareControlGetStatus,
  graphShareControlPostJson,
  graphShareControlPutCas,
} from '../../src/code_graph/sharing/control_client.js';
import {runGraphShareControlServer} from '../../src/code_graph/sharing/control_server.js';
import {sha256Digest, sha256HexFromDigest} from '../../src/code_graph/sharing/digest.js';
import {GraphSharingError} from '../../src/code_graph/sharing/errors.js';
import {graphSharingLayout} from '../../src/code_graph/sharing/layout.js';
import {graphSharePayloadLooksLikeGitObject} from '../../src/code_graph/sharing/oci.js';
import {SystemInfo} from '../../src/effect/system.js';

const sharingLayer = Layer.mergeAll(BunServices.layer, BunHttpClient.layer, SystemInfo.layer);

describe('graph share live coordinator and digest CAS', () => {
  effectIt.effect('serves CAS blobs, rejects Git objects, and never accepts source on the control API', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-http-'});
        const casRoot = path.join(home, 'cas');
        yield* fs.makeDirectory(casRoot, {recursive: true, mode: 0o700});
        const ready = yield* Deferred.make<{readonly port: number; readonly url: string}>();
        yield* Effect.forkScoped(
          runGraphShareControlServer({
            casRoot,
            listen: {hostname: '127.0.0.1', port: 0},
            onListening: info => Deferred.succeed(ready, info).pipe(Effect.asVoid),
            organization: 'acme',
            repositoryId: 'a'.repeat(64),
            threadnoteHome: home,
          }),
        );
        const info = yield* Deferred.await(ready);
        const payload = new TextEncoder().encode('{"kind":"parse-result"}');
        const digest = yield* graphShareControlPutCas(info.url, payload);
        expect(digest).toBe(sha256Digest(payload));
        const fetched = yield* graphShareControlGetCas(info.url, digest);
        expect(new TextDecoder().decode(fetched)).toBe('{"kind":"parse-result"}');
        const gitBlob = new TextEncoder().encode('blob 4\0test');
        expect(graphSharePayloadLooksLikeGitObject(gitBlob)).toBe(true);
        const gitRejected = yield* graphShareControlPutCas(info.url, gitBlob).pipe(
          Effect.as(false),
          Effect.catchIf(
            error => Schema.is(GraphSharingError)(error),
            () => Effect.succeed(true),
          ),
        );
        expect(gitRejected).toBe(true);
        const treeHex = sha256HexFromDigest(sha256Digest(gitBlob));
        const missingTree = yield* graphShareControlGetCas(info.url, `sha256:${treeHex}`).pipe(
          Effect.as(false),
          Effect.catchIf(
            error => Schema.is(GraphSharingError)(error) && error.kind === 'unavailable',
            () => Effect.succeed(true),
          ),
        );
        expect(missingTree).toBe(true);
        const wellKnown = yield* graphShareControlGetJson(info.url, '/.well-known/threadnote-graph');
        expect(wellKnown).toMatchObject({organization: 'acme', protocolVersions: ['v1']});
        const sourceRejected = yield* graphShareControlPostJson(info.url, '/v1/results', {
          source: 'fn main() {}',
        });
        expect(sourceRejected.status).toBe(400);
        const client = yield* HttpClient.HttpClient;
        const malformed = yield* client.execute(
          HttpClientRequest.post(`${info.url}/v1/results`).pipe(
            HttpClientRequest.bodyUint8Array(new TextEncoder().encode('{'), 'application/json'),
          ),
        );
        expect(malformed.status).toBe(400);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  effectIt.effect.prop(
    'graph-sharing JSON bytes round-trip I-JSON objects independently of JSON.parse',
    {
      generation: FC.integer({max: 10_000, min: 0}),
      organization: FC.array(FC.constantFrom(...'0123456789abcdef'), {maxLength: 16, minLength: 1}).map(characters =>
        characters.join(''),
      ),
    },
    ({generation, organization}) =>
      Effect.gen(function* () {
        const value = {generation, organization, protocolVersions: ['v1'] as const};
        const decoded = yield* decodeJsonBytes(new TextEncoder().encode(JSON.stringify(value)));
        expect(decoded).toEqual({...value, protocolVersions: ['v1']});
      }),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('commits concurrent result announcements without dropping receipts', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-race-'});
        const casRoot = path.join(home, 'cas');
        yield* fs.makeDirectory(casRoot, {recursive: true, mode: 0o700});
        const ready = yield* Deferred.make<{readonly port: number; readonly url: string}>();
        yield* Effect.forkScoped(
          runGraphShareControlServer({
            casRoot,
            listen: {hostname: '127.0.0.1', port: 0},
            onListening: info => Deferred.succeed(ready, info).pipe(Effect.asVoid),
            organization: 'acme',
            repositoryId: 'a'.repeat(64),
            threadnoteHome: home,
          }),
        );
        const info = yield* Deferred.await(ready);
        const announcements = [0, 1, 2, 3, 4, 5, 6, 7].map(index => ({
          actionKey: index.toString(16).repeat(64).slice(0, 64),
          attestationDigest: sha256Digest(`att-${index}`),
          batchId: 'b'.repeat(40),
          resultManifestDigest: sha256Digest(`res-${index}`),
          semanticDigest: sha256Digest(`sem-${index}`),
        }));
        yield* Effect.forEach(
          announcements,
          (announcement, index) => graphShareControlAnnounceResult(info.url, announcement, `k${index}`),
          {concurrency: 'unbounded'},
        );
        const status = yield* graphShareControlGetStatus(info.url);
        expect(status.receipts).toHaveLength(announcements.length);
        const persisted = (yield* readJsonFile(graphSharingLayout(path, home).coordinatorStatePath)) as {
          readonly receipts: {readonly receipts: readonly unknown[]};
        };
        expect(persisted.receipts.receipts).toHaveLength(announcements.length);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );
});
