import {Effect, FileSystem, Path} from 'effect';
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient';
import {CommandExecutor} from '../../src/effect/command.js';
import {SystemInfo} from '../../src/effect/system.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';

export const graphRegistryFixture = Effect.fn('test.graphRegistry.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const executor = yield* CommandExecutor;
  const docker = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-synthetic-registry-'});
  yield* fs.writeFileString(
    path.join(docker, 'config.json'),
    JSON.stringify({credHelpers: {'registry.example.test': 'fixture'}}),
  );
  const blobs = new Map<string, Uint8Array>();
  const manifests = new Map<string, Uint8Array>();
  const requests: {method: string; pathname: string}[] = [];
  const state = {outage: false, loseTagAcknowledgement: false};
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://registry.example.test') throw new Error('Unexpected registry authority');
      const method = init?.method ?? 'GET';
      requests.push({method, pathname: url.pathname});
      if (state.outage) return new Response(null, {status: 503, headers: {'retry-after': '17'}});
      const prefix = '/v2/acme/canonical/';
      if (!url.pathname.startsWith(prefix)) throw new Error('Unexpected registry namespace');
      const suffix = url.pathname.slice(prefix.length);
      if (method === 'POST' && suffix === 'blobs/uploads/')
        return new Response(null, {status: 202, headers: {location: prefix + 'blobs/uploads/fixture?_state=opaque'}});
      if (method === 'DELETE') return new Response(null, {status: 204});
      if (method === 'PUT') {
        const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
        const digest = sha256Digest(bytes);
        if (suffix.startsWith('blobs/uploads/')) {
          if (url.searchParams.get('digest') !== digest) throw new Error('Invalid upload digest');
          blobs.set(digest, bytes);
        } else if (suffix.startsWith('manifests/')) {
          const ref = suffix.slice('manifests/'.length);
          manifests.set(ref, bytes);
          manifests.set(digest, bytes);
          if (ref.startsWith('tn-frontier-') && state.loseTagAcknowledgement)
            return new Response(null, {status: 503, headers: {'retry-after': '17'}});
        } else throw new Error('Unexpected mutation');
        return new Response(null, {status: 201, headers: {'docker-content-digest': digest}});
      }
      const manifest = suffix.startsWith('manifests/');
      const bytes = (manifest ? manifests : blobs).get(suffix.slice(manifest ? 'manifests/'.length : 'blobs/'.length));
      if (bytes === undefined) return new Response(null, {status: 404});
      return new Response(method === 'HEAD' ? null : Uint8Array.from(bytes), {
        headers: {
          'docker-content-digest': sha256Digest(bytes),
          'content-length': String(bytes.length),
          'content-type': manifest ? 'application/vnd.oci.image.manifest.v1+json' : 'application/octet-stream',
        },
      });
    },
    {preconnect: () => undefined},
  ) as typeof globalThis.fetch;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(SystemInfo, {
        ...system,
        environment: () => ({...system.environment(), DOCKER_CONFIG: docker}),
      }),
      Effect.provideService(CommandExecutor, {
        ...executor,
        execute: (executable, args, options) =>
          executable === 'docker-credential-fixture'
            ? Effect.succeed({
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify({Username: 'synthetic-publisher', Secret: 'fixture-only'}),
              })
            : executor.execute(executable, args, options),
      }),
    );
  return {blobs, manifests, requests, state, provide};
});
