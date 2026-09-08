import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Path, Redacted} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'effect/testing/FastCheck';
import {CommandExecutor} from '../../src/effect/command.js';
import {makeGraphControlCredentialLoader} from '../../src/code_graph/sharing/control_credentials.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const scope = {
  coordinatorUrl: 'https://graph.example.test/team',
  organization: 'acme',
  profileDigest: sha256Digest('profile'),
  repositoryId: 'a'.repeat(64),
};
const binding = {
  audience: 'https://graph.example.test',
  coordinatorUrl: scope.coordinatorUrl,
  helper: 'fixture',
  issuer: 'https://login.example.test/',
  organization: scope.organization,
};

const fixture = Effect.fn('test.controlCredentials.fixture')(function* (
  options: {
    readonly configured?: boolean;
    readonly denied?: boolean;
    readonly response?: (now: number, calls: number) => unknown;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-control-credentials-'});
  const directory = path.join(home, 'graph-sharing');
  const config = path.join(directory, 'control-credentials.json');
  yield* fs.makeDirectory(directory);
  if (options.configured !== false)
    yield* fs.writeFileString(config, JSON.stringify({bindings: [binding], schemaVersion: 1}));
  let calls = 0;
  const loader = yield* makeGraphControlCredentialLoader(home, scope, 'graph:contribute').pipe(
    Effect.provideService(CommandExecutor, {
      execute: (executable, args, options_) =>
        Effect.gen(function* () {
          calls++;
          expect(executable).toBe('threadnote-credential-fixture');
          expect(args).toEqual(['get']);
          expect(options_?.timeoutMs).toBe(5000);
          expect(options_?.maxOutputBytes).toBe(32768);
          expect(JSON.parse(new TextDecoder().decode(options_?.input))).toEqual({
            ...scope,
            audience: binding.audience,
            issuer: binding.issuer,
            interactive: false,
            schemaVersion: 1,
            scopes: ['graph:contribute'],
          });
          const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
          return {
            exitCode: options.denied ? 1 : 0,
            stderr: 'synthetic-private-helper-detail',
            stdout: JSON.stringify(
              options.response?.(now, calls) ?? {
                accessToken: 'synthetic.token.' + calls,
                audience: binding.audience,
                expiresAt: now + 600,
                issuer: binding.issuer,
                schemaVersion: 1,
                subject: 'synthetic-principal',
              },
            ),
          };
        }),
      executeStreaming: () => Effect.succeed({exitCode: 1, stdout: '', stderr: ''}),
    }),
  );
  return {loader, calls: () => calls, config};
});

describe('graph control credential discovery', () => {
  effectIt.effect.prop(
    'never returns expired credentials after arbitrary idle gaps',
    {gaps: FC.array(FC.integer({min: 0, max: 720_000}), {minLength: 1, maxLength: 8})},
    ({gaps}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let previous = yield* f.loader.load;
        for (const gap of gaps) {
          yield* TestClock.adjust(gap);
          const now = (yield* Clock.currentTimeMillis) / 1000;
          const next = yield* f.loader.load;
          expect(next.expiresAt).toBeGreaterThan(now);
          expect(next.identity).toBe(previous.identity);
          if (previous.expiresAt <= now) expect(next).not.toBe(previous);
          previous = next;
        }
      }).pipe(provideTestLayer(BunServices.layer)),
    {fastCheck: {numRuns: 35}},
  );

  effectIt.effect('caches a scoped credential across parallel calls and coordinates invalidation', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const wave = () => Effect.forEach(Array.from({length: 8}), () => f.loader.load, {concurrency: 8});
      const first = yield* wave();
      expect(f.calls()).toBe(1);
      expect(new Set(first.map(item => item.identity)).size).toBe(1);
      expect(Redacted.value(first[0].authorization)).toBe('Bearer synthetic.token.1');
      expect(JSON.stringify(first)).not.toContain('synthetic.token');
      f.loader.invalidate(first[0]);
      const second = yield* wave();
      expect(f.calls()).toBe(2);
      f.loader.invalidate(first[1]);
      expect(yield* f.loader.load).toBe(second[0]);
      yield* TestClock.adjust(300_001);
      yield* wave();
      expect(f.calls()).toBe(3);
    }).pipe(provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('does not invoke a helper without an exact approved local binding', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* fixture({configured: false});
      expect((yield* Effect.result(f.loader.load))._tag).toBe('Failure');
      for (const changed of [
        {...binding, coordinatorUrl: 'https://graph.example.test/other'},
        {...binding, organization: 'another'},
        {...binding, helper: '../untrusted'},
        {...binding, coordinatorUrl: 'https://graph.example.test/team/../team'},
        {...binding, issuer: 'http://login.example.test/'},
        {...binding, secret: 'must-not-store-tokens'},
      ]) {
        yield* fs.writeFileString(f.config, JSON.stringify({bindings: [changed], schemaVersion: 1}));
        expect((yield* Effect.result(f.loader.load))._tag).toBe('Failure');
      }
      expect(f.calls()).toBe(0);
    }).pipe(provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('rechecks local revocation before serving a cached token', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* fixture();
      yield* f.loader.load;
      yield* fs.writeFileString(f.config, JSON.stringify({bindings: [], schemaVersion: 1}));
      expect((yield* Effect.result(f.loader.load))._tag).toBe('Failure');
      expect(f.calls()).toBe(1);
    }).pipe(provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('binds identity changes to a different enrollment authority', () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        response: (now, calls) => ({
          accessToken: 'synthetic-token',
          audience: binding.audience,
          expiresAt: now + 600,
          issuer: binding.issuer,
          schemaVersion: 1,
          subject: 'principal-' + calls,
        }),
      });
      const first = yield* f.loader.load;
      f.loader.invalidate(first);
      const second = yield* f.loader.load;
      expect(first.principalId).not.toBe(second.principalId);
      expect(first.identity).not.toBe(second.identity);
    }).pipe(provideTestLayer(BunServices.layer)),
  );

  effectIt.effect('rejects malformed, expired and foreign helper output without exposing its contents', () =>
    Effect.gen(function* () {
      for (const override of [
        {expiresAt: 0},
        {audience: 'https://other.example.test'},
        {issuer: 'https://other.example.test/'},
        {accessToken: 'synthetic-private-helper-detail\r\nheader: bad'},
        {unknown: true},
      ]) {
        const f = yield* fixture({
          response: now => ({
            accessToken: 'synthetic-private-helper-detail',
            audience: binding.audience,
            expiresAt: now + 600,
            issuer: binding.issuer,
            schemaVersion: 1,
            subject: 'principal',
            ...override,
          }),
        });
        const result = yield* Effect.result(f.loader.load);
        expect(result._tag).toBe('Failure');
        expect(JSON.stringify(result)).not.toContain('synthetic-private-helper-detail');
      }
      const denied = yield* fixture({denied: true});
      const failure = yield* Effect.result(denied.loader.load);
      expect(failure._tag).toBe('Failure');
      expect(JSON.stringify(failure)).not.toContain('synthetic-private-helper-detail');
    }).pipe(provideTestLayer(BunServices.layer)),
  );
});
