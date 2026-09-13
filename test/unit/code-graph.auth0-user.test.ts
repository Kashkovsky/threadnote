import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {
  configureGraphAuth0User,
  getGraphAuth0UserCredential,
  loginGraphAuth0User,
  type Auth0UserBackend,
} from '../../src/code_graph/sharing/auth0_user.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {graphSharingUnavailable} from '../../src/code_graph/sharing/errors.js';
import {SystemInfo} from '../../src/effect/system.js';
import {CommandExecutor} from '../../src/effect/command.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '../helpers/fast-check-property.js';

const systemLayer = SystemInfo.layer;
const layer = Layer.merge(systemLayer, CommandExecutor.layer.pipe(Layer.provide(systemLayer))).pipe(
  Layer.provideMerge(BunServices.layer),
);
const config = {
  audience: 'https://threadnote.io/graph',
  clientId: 'publicNativeClient123456',
  coordinatorUrl: 'https://graph.example.test/team',
  issuer: 'https://example.eu.auth0.com/',
  organization: 'acme',
};
const request = {
  audience: config.audience,
  coordinatorUrl: config.coordinatorUrl,
  interactive: false,
  issuer: config.issuer,
  organization: config.organization,
  profileDigest: sha256Digest('profile'),
  repositoryId: 'a'.repeat(64),
  schemaVersion: 1,
  scopes: ['graph:contribute'],
};

const fixture = Effect.fn('test.auth0User.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-auth0-user-'});
  const root = path.join(home, 'graph-sharing');
  yield* fs.makeDirectory(root);
  yield* fs.writeFileString(
    path.join(root, 'auth0-user.json'),
    JSON.stringify({
      bindings: [{...config, schemaVersion: 1}],
      schemaVersion: 1,
    }),
  );
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  let saved = JSON.stringify({
    accessToken: 'old.token',
    audience: config.audience,
    clientId: config.clientId,
    expiresAt: now + 5,
    issuer: config.issuer,
    refreshToken: 'old-refresh-token',
    schemaVersion: 1,
    scopes: ['graph:read', 'graph:contribute'],
    subject: 'auth0|one',
  });
  let refreshes = 0;
  let writes = 0;
  let reads = 0;
  let failFinalWrite = false;
  let nextSubject = 'auth0|one';
  const backend: Auth0UserBackend = {
    read: () =>
      Effect.sync(() => {
        reads++;
        return saved;
      }),
    write: (_account, value) =>
      Effect.gen(function* () {
        writes++;
        if (failFinalWrite && writes === 2) return yield* graphSharingUnavailable('synthetic-keychain-failure');
        saved = value;
      }),
    remove: () => Effect.void,
    post: (_config, endpoint, form) =>
      Effect.sync(() => {
        expect(endpoint).toBe('token');
        expect(form.grant_type).toBe('refresh_token');
        expect(form.refresh_token).toBe('old-refresh-token');
        refreshes++;
        return {
          status: 200,
          body: {
            access_token: 'next.token',
            refresh_token: 'next-refresh-token',
            token_type: 'Bearer',
          },
        };
      }),
    verify: () =>
      Effect.succeed({
        expiresAt: now + 300,
        issuer: config.issuer,
        scopes: new Set(['graph:read', 'graph:contribute']),
        subject: nextSubject,
      }),
  };
  return {
    backend,
    home,
    get: () => getGraphAuth0UserCredential(home, request, backend),
    reads: () => reads,
    refreshes: () => refreshes,
    saved: () => JSON.parse(saved) as Record<string, unknown>,
    setFailFinalWrite: () => {
      failFinalWrite = true;
    },
    setSubject: (value: string) => {
      nextSubject = value;
    },
    writes: () => writes,
  };
});

describe('Auth0 user graph credentials', () => {
  fcEffectProp(
    effectIt,
    'serializes arbitrary simultaneous requests to one rotating refresh',
    {callers: FC.integer({min: 1, max: 8})},
    ({callers}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const results = yield* Effect.forEach(Array.from({length: callers}), () => f.get(), {concurrency: callers});
        expect(results).toHaveLength(callers);
        expect(new Set(results.map(result => result.accessToken))).toEqual(new Set(['next.token']));
        expect(f.refreshes()).toBe(1);
        expect(f.writes()).toBe(2);
        expect(f.reads()).toBe(callers);
        expect(f.saved().refreshToken).toBe('next-refresh-token');
      }).pipe(provideTestLayer(layer), TestClock.withLive),
    {fastCheck: {numRuns: 12}},
  );

  effectIt.effect('marks refresh uncertain before exchange and never replays after Keychain persistence failure', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setFailFinalWrite();
      expect((yield* Effect.result(f.get()))._tag).toBe('Failure');
      expect(f.saved().state).toBe('refreshing');
      expect((yield* Effect.result(f.get()))._tag).toBe('Failure');
      expect(f.refreshes()).toBe(1);
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect('rejects a changed subject and leaves the session requiring login', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setSubject('auth0|other');
      expect((yield* Effect.result(f.get()))._tag).toBe('Failure');
      expect(f.saved().state).toBe('refreshing');
      expect(f.refreshes()).toBe(1);
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect('denies a changed issuer and never reads Keychain', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const result = yield* Effect.result(
        getGraphAuth0UserCredential(
          f.home,
          {
            ...request,
            issuer: 'https://another.eu.auth0.com/',
          },
          f.backend,
        ),
      );
      expect(result._tag).toBe('Failure');
      expect(f.reads()).toBe(0);
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect('requests offline access and completes a one-time Device Flow without a client secret', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let tokenCalls = 0;
      const backend: Auth0UserBackend = {
        ...f.backend,
        post: (_config, endpoint, form) =>
          Effect.sync(() => {
            expect(form.client_id).toBe(config.clientId);
            expect(Object.keys(form)).not.toContain('client_secret');
            if (endpoint === 'device') {
              expect(form.audience).toBe(config.audience);
              expect(form.scope).toContain('offline_access');
              return {
                status: 200,
                body: {
                  device_code: 'opaque-device-code',
                  user_code: 'ABCD-EFGH',
                  verification_uri: 'https://example.eu.auth0.com/activate',
                  expires_in: 30,
                  interval: 1,
                },
              };
            }
            expect(form.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code');
            tokenCalls++;
            return tokenCalls === 1
              ? {status: 403, body: {error: 'authorization_pending'}}
              : {
                  status: 200,
                  body: {
                    access_token: 'next.token',
                    refresh_token: 'next-refresh-token',
                    token_type: 'Bearer',
                  },
                };
          }),
      };
      expect((yield* loginGraphAuth0User(f.home, backend)).authenticated).toBe(true);
      expect(tokenCalls).toBe(2);
      expect(f.saved().refreshToken).toBe('next-refresh-token');
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect('rejects a Device Flow verification URL outside the configured issuer', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let polls = 0;
      const backend: Auth0UserBackend = {
        ...f.backend,
        post: () =>
          Effect.sync(() => {
            polls++;
            return {
              status: 200,
              body: {
                device_code: 'opaque-device-code',
                user_code: 'ABCD-EFGH',
                verification_uri: 'https://other.example.test/activate',
                expires_in: 30,
                interval: 1,
              },
            };
          }),
      };
      expect((yield* Effect.result(loginGraphAuth0User(f.home, backend)))._tag).toBe('Failure');
      expect(polls).toBe(1);
      expect(f.writes()).toBe(0);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('configures only public client data and the exact built-in helper binding', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-auth0-config-'});
      yield* configureGraphAuth0User({agentContextHome: home} as RuntimeConfig, config);
      const root = path.join(home, 'graph-sharing');
      const binding = JSON.parse(yield* fs.readFileString(path.join(root, 'control-credentials.json')));
      expect(binding.bindings).toEqual([
        {
          audience: config.audience,
          coordinatorUrl: config.coordinatorUrl,
          helper: 'auth0',
          issuer: config.issuer,
          organization: config.organization,
        },
      ]);
      const publicConfig = yield* fs.readFileString(path.join(root, 'auth0-user.json'));
      expect(JSON.parse(publicConfig).bindings).toHaveLength(1);
      expect(publicConfig).not.toContain('refresh_token');
      expect(publicConfig).not.toContain('client_secret');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('preserves separate Auth0 public clients for two organizations', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-auth0-multi-org-'});
      const second = {
        ...config,
        clientId: 'anotherPublicClient123456',
        coordinatorUrl: 'https://graph.example.test/second',
        organization: 'another',
      };
      const runtime = {agentContextHome: home} as RuntimeConfig;
      yield* configureGraphAuth0User(runtime, config);
      yield* configureGraphAuth0User(runtime, second);
      const accounts: string[] = [];
      let selected = config;
      const expiresAt = Math.floor((yield* Clock.currentTimeMillis) / 1000) + 300;
      const backend: Auth0UserBackend = {
        read: account =>
          Effect.sync(() => {
            accounts.push(account);
            return JSON.stringify({
              accessToken: 'synthetic.token',
              audience: selected.audience,
              clientId: selected.clientId,
              expiresAt,
              issuer: selected.issuer,
              refreshToken: 'synthetic-refresh',
              schemaVersion: 1,
              scopes: ['graph:read', 'graph:contribute'],
              subject: 'auth0|one',
            });
          }),
        write: () => Effect.void,
        remove: () => Effect.void,
        post: () => Effect.die('unexpected-network'),
        verify: () => Effect.die('unexpected-verification'),
      };
      expect((yield* getGraphAuth0UserCredential(home, request, backend)).accessToken).toBe('synthetic.token');
      selected = second;
      expect(
        (yield* getGraphAuth0UserCredential(
          home,
          {
            ...request,
            coordinatorUrl: second.coordinatorUrl,
            organization: second.organization,
          },
          backend,
        )).accessToken,
      ).toBe('synthetic.token');
      expect(new Set(accounts).size).toBe(2);
      expect((yield* Effect.result(loginGraphAuth0User(home, backend)))._tag).toBe('Failure');
      let loginClient: string | undefined;
      const selectedBackend: Auth0UserBackend = {
        ...backend,
        post: selectedConfig =>
          Effect.sync(() => {
            loginClient = selectedConfig.clientId;
            return {status: 400, body: {error: 'synthetic-denial'}};
          }),
      };
      expect(
        (yield* Effect.result(
          loginGraphAuth0User(home, selectedBackend, {
            coordinatorUrl: second.coordinatorUrl,
            organization: second.organization,
          }),
        ))._tag,
      ).toBe('Failure');
      expect(loginClient).toBe(second.clientId);
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );
});
