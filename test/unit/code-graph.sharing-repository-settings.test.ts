import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'effect/testing/FastCheck';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {canonicalJson} from '../../src/code_graph/checkpoint/canonical_json.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {putCasBytes} from '../../src/code_graph/sharing/cas.js';
import {
  runGraphContributeSet,
  runGraphContributeStatus,
  runGraphShareJoin,
  runGraphShareLeave,
} from '../../src/code_graph/sharing/client.js';
import {casProfilePointer, defaultGraphShareProfile} from '../../src/code_graph/sharing/profile.js';
import {
  lookupGraphShareTrustReceipt,
  readGraphShareClientState,
  patchGraphShareClientState,
  trustReceiptFromEnrollment,
  writeGraphShareTrustReceipt,
  writeGraphShareRepositoryContributionMode,
} from '../../src/code_graph/sharing/trust.js';
import {resolveGraphShareRepositoryClient} from '../../src/code_graph/sharing/client_state.js';
import {drainQueuedGraphShareContributions} from '../../src/code_graph/sharing/parse_cache.js';
import {enqueuePersistedGraphShareContribution} from '../../src/code_graph/sharing/contribution.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {CommandExecutor, runCommandEffect} from '../../src/effect/command.js';
import {SystemInfo} from '../../src/effect/system.js';

const layer = CommandExecutor.layer.pipe(
  Layer.provideMerge(SystemInfo.layer),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(BunHttpClient.layer),
);

describe('repository-scoped graph sharing settings', () => {
  effectIt.effect.prop(
    'updates only the selected repository under arbitrary contribution-mode changes',
    {
      changes: FC.array(FC.tuple(FC.boolean(), FC.constantFrom('off', 'passive', 'idle', 'dedicated')), {
        maxLength: 12,
      }),
    },
    ({changes}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mode-property-'});
        const receipts = ['a', 'b'].map(id => ({
          accessMode: 'join' as const,
          client: {
            casRoot: `${home}/${id}`,
            contributionMode: 'passive' as const,
            coordinatorUrl: `https://${id}.example.invalid`,
          },
          organization: 'acme',
          policyVersion: 1 as const,
          profileDigest: sha256Digest(id),
          publisherKeyFingerprint: sha256Digest('publisher'),
          registryCanonical: 'cas://local',
          repositoryId: id.repeat(64),
        }));
        for (const receipt of receipts) yield* writeGraphShareTrustReceipt(home, receipt);
        const expected = ['passive', 'passive'];
        for (const [first, mode] of changes) {
          const index = first ? 0 : 1;
          const receipt = receipts[index];
          yield* writeGraphShareRepositoryContributionMode(home, receipt, receipt.client, mode);
          expected[index] = mode;
          for (const [ordinal, entry] of receipts.entries()) {
            expect(yield* lookupGraphShareTrustReceipt(home, entry.repositoryId)).toEqual({
              ...entry,
              client: {...entry.client, contributionMode: expected[ordinal]},
            });
          }
        }
      }).pipe(provideTestLayer(layer)),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('delivers each queue only to its repository endpoint and safely resolves legacy settings', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-repository-delivery-'});
        const config = runtimeConfig(root);
        const destinations: string[][] = [[], []];
        const servers = yield* Effect.forEach(destinations, requests =>
          Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                hostname: '127.0.0.1',
                port: 0,
                fetch: async request => {
                  requests.push(await request.text());
                  return Response.json({});
                },
              }),
            ),
            server => Effect.promise(() => server.stop(true)),
          ),
        );
        const a = yield* fixture(root, 'a', `http://127.0.0.1:${servers[0].port}`);
        const b = yield* fixture(root, 'b', `http://127.0.0.1:${servers[1].port}`);
        yield* runGraphShareJoin(config, {cwd: a.repo, cas: a.cas});
        yield* runGraphShareJoin(config, {cwd: b.repo, cas: b.cas});
        const announcement = {
          actionKey: 'c'.repeat(64),
          batchId: 'd'.repeat(40),
          semanticDigest: sha256Digest('semantic'),
          resultManifestDigest: yield* putCasBytes(a.cas, new TextEncoder().encode('{"repository":"a"}')),
          attestationDigest: yield* putCasBytes(a.cas, new TextEncoder().encode('{"attestation":"a"}')),
        };
        const enqueue = enqueuePersistedGraphShareContribution(
          config.agentContextHome,
          a.repositoryId,
          'join',
          announcement,
          'passive',
        );
        const drain = drainQueuedGraphShareContributions({identity: a, threadnoteHome: config.agentContextHome});
        yield* enqueue;
        expect(yield* drain).toEqual({sent: 1});
        expect(destinations[0]).toHaveLength(4);
        expect(destinations[1]).toEqual([]);
        const receipt = (yield* lookupGraphShareTrustReceipt(config.agentContextHome, a.repositoryId))!;
        const {client: _client, ...legacyReceipt} = receipt;
        yield* writeGraphShareTrustReceipt(config.agentContextHome, legacyReceipt);
        yield* patchGraphShareClientState(config.agentContextHome, {
          casRoot: a.cas,
          coordinatorUrl: b.coordinator,
          contributionMode: 'dedicated',
        });
        expect(yield* resolveGraphShareRepositoryClient(config.agentContextHome, legacyReceipt)).toMatchObject({
          coordinatorUrl: a.coordinator,
          contributionMode: 'passive',
        });
        yield* enqueue;
        expect(yield* drain).toEqual({sent: 1});
        expect(destinations[0]).toHaveLength(8);
        expect(destinations[1]).toEqual([]);
        yield* patchGraphShareClientState(config.agentContextHome, {contributionMode: 'off'});
        yield* enqueue;
        expect(yield* drain).toEqual({sent: 0});
        yield* runGraphShareJoin(config, {cwd: a.repo});
        expect((yield* runGraphContributeStatus(config, {cwd: a.repo})).mode).toBe('off');
        expect(yield* drain).toEqual({sent: 0});
        yield* runGraphShareLeave(config, {cwd: a.repo});
        expect(yield* drain).toEqual({sent: 0});
        expect(destinations[0]).toHaveLength(8);
        expect(destinations[1]).toEqual([]);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('refuses a legacy profile whose content does not match the repository trust pins', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-legacy-pins-'});
      const a = yield* fixture(root, 'a');
      const b = yield* fixture(root, 'b');
      const config = runtimeConfig(root);
      const receipt = trustReceiptFromEnrollment(
        {
          schemaVersion: 1,
          repositoryId: b.repositoryId,
          profile: casProfilePointer(a.digest),
          publisherKeyFingerprint: a.profile.trust.publisherKeys[0],
        },
        a.profile,
        a.digest,
        'join',
      );
      yield* patchGraphShareClientState(config.agentContextHome, {casRoot: a.cas, coordinatorUrl: b.coordinator});
      expect(
        Result.isFailure(
          yield* resolveGraphShareRepositoryClient(config.agentContextHome, receipt).pipe(Effect.result),
        ),
      ).toBe(true);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('keeps joined repositories transport and contribution choices independent', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-repository-settings-'});
        const config = runtimeConfig(root);
        const a = yield* fixture(root, 'a');
        const b = yield* fixture(root, 'b');
        yield* runGraphShareJoin(config, {cwd: a.repo, cas: a.cas});
        yield* runGraphContributeSet(config, {cwd: a.repo, mode: 'off'});
        yield* runGraphShareJoin(config, {cwd: b.repo, cas: b.cas});
        expect((yield* runGraphContributeStatus(config, {cwd: b.repo})).mode).toBe('passive');
        expect((yield* runGraphContributeSet(config, {cwd: b.repo, mode: 'dedicated'})).mode).toBe('passive');
        expect((yield* runGraphContributeStatus(config, {cwd: b.repo})).mode).toBe('passive');
        expect((yield* runGraphContributeStatus(config, {cwd: a.repo})).mode).toBe('off');
        expect(yield* readGraphShareClientState(config.agentContextHome)).toEqual({schemaVersion: 1});
        for (const item of [a, b]) {
          expect(yield* lookupGraphShareTrustReceipt(config.agentContextHome, item.repositoryId)).toMatchObject({
            profileDigest: item.digest,
            client: {casRoot: item.cas, coordinatorUrl: item.coordinator},
          });
        }
        yield* runGraphShareJoin(config, {cwd: a.repo});
        expect((yield* runGraphContributeStatus(config, {cwd: a.repo})).mode).toBe('off');
        yield* runGraphShareJoin(config, {cwd: b.repo, readOnly: true});
        yield* runGraphContributeSet(config, {cwd: b.repo, mode: 'dedicated'});
        expect((yield* runGraphContributeStatus(config, {cwd: b.repo})).mode).toBe('off');
        yield* runGraphShareLeave(config, {cwd: b.repo});
        yield* runGraphContributeSet(config, {cwd: b.repo, mode: 'passive'});
        expect(yield* lookupGraphShareTrustReceipt(config.agentContextHome, b.repositoryId)).toBeUndefined();
        expect((yield* runGraphContributeStatus(config, {cwd: a.repo})).mode).toBe('off');
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('leaves all existing settings intact when another join fails', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-repository-join-failure-'});
        const config = runtimeConfig(root);
        const a = yield* fixture(root, 'a');
        const b = yield* fixture(root, 'b');
        yield* runGraphShareJoin(config, {cwd: a.repo, cas: a.cas});
        const before = yield* readGraphShareClientState(config.agentContextHome);
        yield* fs.writeFileString(`${b.repo}/.threadnote/graph-share.json`, '{}');
        expect(Result.isFailure(yield* runGraphShareJoin(config, {cwd: b.repo, cas: b.cas}).pipe(Effect.result))).toBe(
          true,
        );
        expect(yield* readGraphShareClientState(config.agentContextHome)).toEqual(before);
        expect((yield* runGraphContributeStatus(config, {cwd: a.repo})).mode).toBe('passive');
      }).pipe(provideTestLayer(layer)),
    ),
  );
});

function runtimeConfig(root: string) {
  return {
    account: 'local' as const,
    agentContextHome: `${root}/home`,
    agentId: 'threadnote',
    manifestPath: `${root}/home/seed-manifest.yaml`,
    user: 'local',
  };
}

const fixture = Effect.fn('test.sharing.repositoryFixture')(function* (root: string, name: string, endpoint?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = path.join(root, name);
  const cas = path.join(root, `${name}-cas`);
  yield* fs.makeDirectory(path.join(repo, '.threadnote'), {recursive: true});
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);
  yield* git(['init', '-q', '--initial-branch=main']);
  yield* git(['remote', 'add', 'origin', `https://github.com/acme/${name}.git`]);
  yield* git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'base',
  ]);
  const identity = yield* resolveRepositoryIdentity(repo);
  const coordinator = endpoint ?? `https://${name}.example.invalid`;
  const profile = defaultGraphShareProfile({
    branch: 'main',
    canonicalRemote: `github.com/acme/${name}`,
    coordinatorUrl: coordinator,
    organization: 'acme',
    publisherKeyFingerprint: `sha256:${'a'.repeat(64)}`,
    repositoryId: identity.repositoryId,
  });
  const digest = yield* putCasBytes(cas, new TextEncoder().encode(canonicalJson(profile)));
  yield* fs.writeFileString(
    path.join(repo, '.threadnote/graph-share.json'),
    JSON.stringify({
      profile: casProfilePointer(digest),
      publisherKeyFingerprint: profile.trust.publisherKeys[0],
      repositoryId: identity.repositoryId,
      schemaVersion: 1,
    }),
  );
  return {cas, coordinator, digest, profile, repo, repositoryId: identity.repositoryId};
});
