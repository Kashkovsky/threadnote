import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {SystemInfo} from '../../src/effect/system.js';
import {makeGraphShareRegistryHttp} from '../../src/code_graph/sharing/registry_http.js';
import {parseGraphShareRegistryTarget} from '../../src/code_graph/sharing/registry_reference.js';
import {makeGraphShareRegistryReader} from '../../src/code_graph/sharing/registry_reader.js';
import {graphShareOciDescriptorFromLayers} from '../../src/code_graph/sharing/descriptor.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';

const layer = Layer.mergeAll(BunServices.layer, SystemInfo.layer, FetchHttpClient.layer);
const target = parseGraphShareRegistryTarget('oci://registry.example.test/acme/canonical');
const pathname = '/v2/acme/canonical/blobs/sha256:' + 'a'.repeat(64);
const secret = 'synthetic-helper-output';
const basic = 'Basic ' + Buffer.from('synthetic-reader:' + secret).toString('base64');
type Request = {readonly url: URL; readonly headers: Headers; readonly signal: AbortSignal | null | undefined};

const fixture = Effect.fn('test.registry.fixture')(function* (options: {
  readonly helper?: boolean;
  readonly helperDenied?: boolean;
  readonly helperResponse?: (call: number) => unknown;
  readonly handler: (request: Request) => Response;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-registry-auth-'});
  yield* fs.writeFileString(
    path.join(directory, 'config.json'),
    JSON.stringify(
      options.helper
        ? {
            credHelpers: {[target.registry]: 'fixture'},
            credsStore: 'unused',
            auths: {[target.registry]: {auth: 'must-not-use'}},
          }
        : {auths: {[target.registry]: {auth: 'must-not-use'}}},
    ),
  );
  const requests: Request[] = [];
  let helperCalls = 0;
  const fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      const request = {url: new URL(String(url)), headers: new Headers(init?.headers), signal: init?.signal};
      expect(init?.redirect).toBe('manual');
      expect(init?.credentials).toBe('omit');
      requests.push(request);
      return options.handler(request);
    },
    {preconnect: () => undefined},
  ) as typeof globalThis.fetch;
  const reader = yield* Effect.all({
    http: makeGraphShareRegistryHttp(target),
    registry: makeGraphShareRegistryReader('oci://registry.example.test/acme/canonical'),
  }).pipe(
    Effect.provideService(SystemInfo, {...system, environment: () => ({DOCKER_CONFIG: directory})}),
    Effect.provideService(CommandExecutor, {
      execute: (executable, args, input) =>
        Effect.sync(() => {
          helperCalls++;
          expect(executable).toBe('docker-credential-fixture');
          expect(args).toEqual(['get']);
          expect(new TextDecoder().decode(input?.input)).toBe(target.registry + '\n');
          expect(input?.maxOutputBytes).toBe(16384);
          expect(input?.timeoutMs).toBe(5000);
          return {
            exitCode: options.helperDenied ? 1 : 0,
            stderr: secret,
            stdout: JSON.stringify(
              options.helperResponse?.(helperCalls) ?? {Username: 'synthetic-reader', Secret: secret},
            ),
          };
        }),
      executeStreaming: () => Effect.succeed({exitCode: 1, stdout: '', stderr: ''}),
    }),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
  return {
    read: (maximum = 1024) => reader.http(pathname, maximum, 'application/octet-stream'),
    registry: reader.registry,
    requests,
    helperCalls: () => helperCalls,
  };
});

describe('registry authentication and bounded transport', () => {
  effectIt.effect('uses anonymous reads without falling back to plaintext Docker auths', () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        handler: request => {
          expect(request.headers.get('authorization')).toBeNull();
          return new Response('bytes');
        },
      });
      expect(new TextDecoder().decode((yield* f.read()).bytes)).toBe('bytes');
      expect(f.helperCalls()).toBe(0);
      expect(f.requests).toHaveLength(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('uses the selected helper only after an exact-origin Basic challenge', () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        helper: true,
        handler: request =>
          request.headers.get('authorization') === basic
            ? new Response('bytes')
            : new Response(null, {status: 401, headers: {'www-authenticate': 'Basic realm="synthetic"'}}),
      });
      yield* f.read();
      yield* f.read();
      expect(f.helperCalls()).toBe(1);
      expect(f.requests).toHaveLength(3);
      expect(f.requests[0]?.headers.get('authorization')).toBeNull();
      expect(f.requests.slice(1).every(request => request.headers.get('authorization') === basic)).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('requests only the exact pull scope and renews short-lived bearer tokens automatically', () =>
    Effect.gen(function* () {
      let issued = 0;
      const f = yield* fixture({
        helper: true,
        handler: request => {
          if (request.url.pathname === '/token') {
            expect(request.url.origin).toBe(target.origin);
            expect(request.url.searchParams.get('scope')).toBe(target.pullScope);
            expect([...request.url.searchParams.keys()].sort()).toEqual(['scope', 'service']);
            expect(request.headers.get('authorization')).toBe(basic);
            return Response.json({token: 'synthetic-token-' + ++issued, expires_in: 1});
          }
          return request.headers.get('authorization') === 'Bearer synthetic-token-' + issued && issued > 0
            ? new Response('bytes')
            : new Response(null, {
                status: 401,
                headers: {
                  'www-authenticate': `Bearer realm="${target.origin}/token",service="registry",scope="${target.pullScope}"`,
                },
              });
        },
      });
      yield* f.read();
      yield* f.read();
      expect(issued).toBe(1);
      expect(f.helperCalls()).toBe(1);
      yield* TestClock.adjust(1001);
      yield* f.read();
      expect(issued).toBe(2);
      expect(f.helperCalls()).toBe(2);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('denied helpers stop without anonymous or alternate-identity fallback and redact output', () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        helper: true,
        helperDenied: true,
        handler: () => new Response(null, {status: 401, headers: {'www-authenticate': 'Basic realm="synthetic"'}}),
      });
      const exit = yield* Effect.exit(f.read());
      expect(exit._tag).toBe('Failure');
      expect(JSON.stringify(exit)).not.toContain(secret);
      expect(f.requests).toHaveLength(1);
      expect(f.helperCalls()).toBe(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('rejects foreign realms, scope widening and redirects before credential use', () =>
    Effect.gen(function* () {
      for (const challenge of [
        'Bearer realm="https://foreign.example.test/token"',
        `Bearer realm="${target.origin}/token",scope="repository:acme/canonical:pull,push"`,
        `Bearer realm="${target.origin}/token?redirect=secret"`,
      ]) {
        const f = yield* fixture({
          helper: true,
          handler: () => new Response(null, {status: 401, headers: {'www-authenticate': challenge}}),
        });
        expect((yield* Effect.exit(f.read()))._tag).toBe('Failure');
        expect(f.requests).toHaveLength(1);
        expect(f.helperCalls()).toBe(0);
      }
      const f = yield* fixture({
        helper: true,
        handler: () =>
          new Response(null, {status: 307, headers: {location: 'https://foreign.example.test/blob?secret=signed'}}),
      });
      const exit = yield* Effect.exit(f.read());
      expect(exit._tag).toBe('Failure');
      expect(JSON.stringify(exit)).not.toContain('signed');
      expect(f.requests).toHaveLength(1);
      expect(f.helperCalls()).toBe(0);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('bounds authentication retries and aborts every completed request scope', () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        helper: true,
        handler: () => new Response(null, {status: 401, headers: {'www-authenticate': 'Basic realm="synthetic"'}}),
      });
      expect((yield* Effect.exit(f.read()))._tag).toBe('Failure');
      expect(f.requests).toHaveLength(3);
      expect(f.helperCalls()).toBe(2);
      expect(f.requests.every(request => request.signal?.aborted)).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('stops an oversized streaming response without Content-Length', () =>
    Effect.gen(function* () {
      let cancelled = false;
      const f = yield* fixture({
        handler: () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(8));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      });
      expect((yield* Effect.exit(f.read(12)))._tag).toBe('Failure');
      expect(cancelled).toBe(true);
      expect(f.requests[0]?.signal?.aborted).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );
  effectIt.effect('rejects unsupported helper identities and identity changes without exposing helper contents', () =>
    Effect.gen(function* () {
      for (const response of [
        {Username: '<token>', Secret: secret},
        {Username: 'user:other', Secret: secret},
        {Username: 'synthetic-reader', Secret: secret, ServerURL: 'foreign.example.test'},
      ]) {
        const f = yield* fixture({
          helper: true,
          helperResponse: () => response,
          handler: () => new Response(null, {status: 401, headers: {'www-authenticate': 'Basic realm="fixture"'}}),
        });
        const exit = yield* Effect.exit(f.read());
        expect(exit._tag).toBe('Failure');
        expect(JSON.stringify(exit)).not.toContain(secret);
        expect(f.requests).toHaveLength(1);
      }
      const f = yield* fixture({
        helper: true,
        helperResponse: call => ({Username: call === 1 ? 'first' : 'second', Secret: secret}),
        handler: () => new Response(null, {status: 401, headers: {'www-authenticate': 'Basic realm="fixture"'}}),
      });
      expect((yield* Effect.exit(f.read()))._tag).toBe('Failure');
      expect(f.helperCalls()).toBe(2);
      expect(f.requests).toHaveLength(2);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('verifies exact blob bytes, digest headers and descriptor size bounds', () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode('synthetic graph bytes'),
        digest = sha256Digest(bytes);
      const valid = yield* fixture({handler: () => new Response(bytes, {headers: {'docker-content-digest': digest}})});
      expect(new Uint8Array(yield* valid.registry.readBlob(digest, bytes.length))).toEqual(bytes);
      expect((yield* Effect.exit(valid.registry.readBlob(digest, bytes.length - 1)))._tag).toBe('Failure');
      for (const handler of [
        () => new Response('tampered'),
        () => new Response(bytes, {headers: {'docker-content-digest': sha256Digest('different')}}),
        () => new Response(null, {status: 404}),
      ]) {
        const invalid = yield* fixture({handler});
        expect((yield* Effect.exit(invalid.registry.readBlob(digest)))._tag).toBe('Failure');
      }
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('resolves a tag to the exact immutable OCI manifest bytes and refuses invalid headers', () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode('fixture');
      const descriptor = graphShareOciDescriptorFromLayers({frontier: bytes, envelope: bytes, metadata: bytes});
      const body = new TextEncoder().encode(canonicalJson(descriptor)),
        digest = sha256Digest(body);
      const valid = yield* fixture({
        handler: () =>
          new Response(body, {headers: {'content-type': descriptor.mediaType, 'docker-content-digest': digest}}),
      });
      const resolved = yield* valid.registry.readManifest('tn-frontier-' + 'a'.repeat(40));
      expect(resolved).toMatchObject({
        descriptor,
        digest,
      });
      expect(new Uint8Array(resolved.bytes)).toEqual(body);
      for (const headers of [
        {'content-type': 'application/json', 'docker-content-digest': digest},
        {'content-type': descriptor.mediaType, 'docker-content-digest': sha256Digest('different')},
      ]) {
        const invalid = yield* fixture({handler: () => new Response(body, {headers})});
        expect((yield* Effect.exit(invalid.registry.readManifest('tn-frontier-' + 'a'.repeat(40))))._tag).toBe(
          'Failure',
        );
      }
    }).pipe(provideTestLayer(layer)),
  );
});
