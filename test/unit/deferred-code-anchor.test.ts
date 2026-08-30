import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {runCommandEffect} from '../../src/effect/command.js';
import {ResourceIoFailed, ResourceStore} from '../../src/effect/resource-store.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  discardOtherDeferredCodeAnchorIntents,
  withDeferredCodeAnchorMutationLocks,
  deferredCodeAnchorDoctorCheck,
  findUrisWithDeferredCodeAnchorIntents,
  finalizeDeferredCodeAnchors,
  stageDeferredCodeAnchorIntent,
  type DeferredCodeAnchorWriteRequest,
} from '../../src/memory/deferred_code_anchor.js';
import {MEMORY_SCHEMA_VERSION} from '../../src/memory/code_citation.js';
import {formatMemoryDocument, type MemoryMetadata} from '../../src/memory/document.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const MEMORY_URI = 'threadnote://user/tester/memories/durable/projects/threadnote/deferred.md';

describe('deferred code-anchor outbox', () => {
  effectIt.effect('serializes descendant stores behind parent intent cleanup', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const parentUri = 'threadnote://user/tester/memories/durable/projects/threadnote';
        const childUri = `${parentUri}/deferred.md`;
        const ownerEntered = yield* Deferred.make<void>();
        const releaseOwner = yield* Deferred.make<void>();
        const contenderAttempted = yield* Deferred.make<void>();
        const contenderEntered = yield* Deferred.make<void>();
        const events: string[] = [];
        const owner = yield* withDeferredCodeAnchorMutationLocks(
          fixture.fs,
          fixture.config,
          [parentUri],
          Effect.gen(function* () {
            events.push('parent-remove');
            yield* Deferred.succeed(ownerEntered, undefined);
            yield* Deferred.await(releaseOwner);
            events.push('parent-intent-cleanup');
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(ownerEntered);

        const contender = yield* Deferred.succeed(contenderAttempted, undefined).pipe(
          Effect.andThen(
            withDeferredCodeAnchorMutationLocks(
              fixture.fs,
              fixture.config,
              [childUri],
              Effect.sync(() => {
                events.push('descendant-store');
              }).pipe(Effect.tap(() => Deferred.succeed(contenderEntered, undefined))),
            ),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(contenderAttempted);
        yield* Effect.yieldNow;

        expect(yield* Deferred.isDone(contenderEntered)).toBe(false);
        yield* Deferred.succeed(releaseOwner, undefined);
        yield* Fiber.join(owner);
        yield* Fiber.join(contender);
        expect(events).toEqual(['parent-remove', 'parent-intent-cleanup', 'descendant-store']);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('keeps the previous recovery intent until a staged replacement is committed', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.fs.makeDirectory(fixture.outbox, {recursive: true, mode: 0o777});
        yield* fixture.fs.chmod(fixture.outbox, 0o777);
        const first = yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'First revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/first.ts']),
        });
        const second = yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Replacement revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/second.ts']),
        });

        expect(first.intentId).not.toBe(second.intentId);
        const stagedNames = (yield* fixture.fs.readDirectory(fixture.outbox)).filter(name => name.endsWith('.json'));
        expect(stagedNames).toHaveLength(2);
        expect(yield* deferredCodeAnchorDoctorCheck(fixture.config)).toEqual({
          detail: '2 private code-anchor intent(s) are pending finalization',
          name: 'deferred code anchors',
          status: 'warn',
        });
        if (process.platform !== 'win32') {
          expect((yield* fixture.fs.stat(fixture.outbox)).mode & 0o777).toBe(0o700);
          for (const name of stagedNames) {
            expect((yield* fixture.fs.stat(fixture.path.join(fixture.outbox, name))).mode & 0o777).toBe(0o600);
          }
        }
        expect(
          yield* findUrisWithDeferredCodeAnchorIntents(fixture.config, [
            MEMORY_URI,
            'threadnote://user/tester/memories/durable/projects/threadnote/unrelated.md',
          ]),
        ).toEqual(new Set([MEMORY_URI]));

        yield* discardOtherDeferredCodeAnchorIntents(fixture.config, MEMORY_URI, second.intentId);
        const remaining = (yield* fixture.fs.readDirectory(fixture.outbox)).filter(name => name.endsWith('.json'));
        expect(remaining).toHaveLength(1);
        expect(yield* fixture.fs.readFileString(fixture.path.join(fixture.outbox, remaining[0]!))).toContain(
          second.intentId,
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('reports a malformed private intent instead of silently skipping it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.fs.makeDirectory(fixture.outbox, {recursive: true, mode: 0o700});
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.outbox, `${'a'.repeat(64)}-tnca_corrupt.json`),
          '{not-json}\n',
          {mode: 0o600},
        );

        expect(yield* deferredCodeAnchorDoctorCheck(fixture.config)).toEqual({
          detail:
            '1 malformed or unreadable private intent(s); run `threadnote finalize-code-refs` for a bounded failure receipt',
          name: 'deferred code anchors',
          status: 'fail',
        });

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config);
        expect(receipt).toMatchObject({
          conflictCount: 0,
          failedCount: 1,
          finalizedCount: 0,
          items: [
            {
              code: 'invalid-intent',
              reason: 'Private deferred code-anchor intent is unreadable or malformed.',
              state: 'failed',
            },
          ],
          pendingCount: 0,
          scannedCount: 1,
        });
        expect(receipt.items[0]).not.toHaveProperty('memoryUri');
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('keeps a valid intent when canonical memory observation fails transiently', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/pending.ts']),
        });
        const store = yield* ResourceStore;
        const failingStore = ResourceStore.of({
          ...store,
          read: (_location, uri) =>
            Effect.fail(
              new ResourceIoFailed({
                cause: new Error('synthetic transient failure'),
                message: 'synthetic transient failure',
                operation: 'read',
                uri,
              }),
            ),
        });

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config).pipe(
          Effect.provideService(ResourceStore, failingStore),
        );
        expect(receipt).toMatchObject({
          failedCount: 1,
          items: [
            {
              code: 'finalization-error',
              memoryUri: MEMORY_URI,
              reason: 'Deferred code-anchor finalization failed safely; retry or run threadnote doctor --dry-run.',
              state: 'failed',
            },
          ],
          scannedCount: 1,
        });
        expect((yield* fixture.fs.readDirectory(fixture.outbox)).filter(name => name.endsWith('.json'))).toHaveLength(
          1,
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('keeps model-facing capture failures free of private locators and checkout paths', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const privateLocator = 'cgs_private_locator_that_must_not_escape';
        const content = memoryContent(fixture.metadata, 'Pending revision.');
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: content,
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, [privateLocator]),
        });
        const store = yield* ResourceStore;
        yield* store.write(
          {
            account: fixture.config.account,
            home: fixture.config.agentContextHome,
            user: fixture.config.user,
          },
          MEMORY_URI,
          content,
          {mode: 'create'},
        );

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config);

        expect(receipt).toMatchObject({
          failedCount: 1,
          items: [
            {
              code: 'citation-capture-failed',
              memoryUri: MEMORY_URI,
              reason: 'Code citation capture failed safely; retry or run threadnote doctor --dry-run.',
              state: 'failed',
            },
          ],
        });
        expect(JSON.stringify(receipt)).not.toContain(privateLocator);
        expect(JSON.stringify(receipt)).not.toContain(fixture.repository);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('rotates bounded scans so an early permanent failure cannot starve later intents', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/later.ts']),
        });
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.outbox, `${'0'.repeat(64)}.json`), '{not-json}\n', {
          mode: 0o600,
        });

        expect(yield* finalizeDeferredCodeAnchors(fixture.config, {limit: 1})).toMatchObject({
          failedCount: 1,
          items: [{code: 'invalid-intent', state: 'failed'}],
          scannedCount: 1,
        });
        expect(yield* finalizeDeferredCodeAnchors(fixture.config, {limit: 1})).toMatchObject({
          conflictCount: 1,
          items: [{memoryUri: MEMORY_URI, reason: 'canonical-memory-missing', state: 'conflict'}],
          scannedCount: 1,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('refuses a pending intent whose file permissions are no longer private', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/private.ts']),
        });
        const [name] = yield* fixture.fs.readDirectory(fixture.outbox);
        yield* fixture.fs.chmod(fixture.path.join(fixture.outbox, name!), 0o644);

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config);
        expect(receipt).toMatchObject({
          failedCount: 1,
          items: [{code: 'invalid-intent', state: 'failed'}],
          scannedCount: 1,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('does not follow a pending-intent symbolic link', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/symlink.ts']),
        });
        const [name] = yield* fixture.fs.readDirectory(fixture.outbox);
        const pendingPath = fixture.path.join(fixture.outbox, name!);
        const movedPath = fixture.path.join(fixture.config.agentContextHome, 'outside-intent.json');
        yield* fixture.fs.rename(pendingPath, movedPath);
        yield* fixture.fs.symlink(movedPath, pendingPath);

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config);
        expect(receipt).toMatchObject({
          failedCount: 1,
          items: [{code: 'invalid-intent', state: 'failed'}],
          scannedCount: 1,
        });
        expect(yield* fixture.fs.readFileString(movedPath)).toContain('src/symlink.ts');
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('refuses a symbolic link at the private outbox boundary', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const outside = fixture.path.join(fixture.config.agentContextHome, 'outside-outbox');
        yield* fixture.fs.makeDirectory(fixture.path.dirname(fixture.outbox), {recursive: true});
        yield* fixture.fs.makeDirectory(outside);
        yield* fixture.fs.symlink(outside, fixture.outbox);

        const failure = yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/outbox-link.ts']),
        }).pipe(Effect.flip);
        expect(String(failure)).toContain('Deferred code-anchor outbox must not be a symbolic link');
        expect(yield* fixture.fs.readDirectory(outside)).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('rejects an intent whose content no longer matches its addressed URI', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
          memoryMetadata: fixture.metadata,
          memoryUri: MEMORY_URI,
          request: deferredRequest(fixture.repository, ['src/tampered.ts']),
        });
        const [name] = yield* fixture.fs.readDirectory(fixture.outbox);
        const pendingPath = fixture.path.join(fixture.outbox, name!);
        const intent = JSON.parse(yield* fixture.fs.readFileString(pendingPath)) as Record<string, unknown>;
        intent.memoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/other.md';
        yield* fixture.fs.writeFileString(pendingPath, `${JSON.stringify(intent)}\n`, {mode: 0o600});

        const receipt = yield* finalizeDeferredCodeAnchors(fixture.config);
        expect(receipt).toMatchObject({
          failedCount: 1,
          items: [{code: 'invalid-intent', state: 'failed'}],
          scannedCount: 1,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('binds the caller checkout and recovery receipt into the intent address', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const stage = () =>
          stageDeferredCodeAnchorIntent(fixture.config, {
            memoryContent: memoryContent(fixture.metadata, 'Pending revision.'),
            memoryMetadata: fixture.metadata,
            memoryUri: MEMORY_URI,
            request: deferredRequest(fixture.repository, ['src/tampered-context.ts']),
          });
        yield* stage();
        const [name] = yield* fixture.fs.readDirectory(fixture.outbox);
        const pendingPath = fixture.path.join(fixture.outbox, name!);
        const callerTamper = JSON.parse(yield* fixture.fs.readFileString(pendingPath)) as Record<string, unknown>;
        callerTamper.callerCwd = fixture.config.agentContextHome;
        yield* fixture.fs.writeFileString(pendingPath, `${JSON.stringify(callerTamper)}\n`, {mode: 0o600});
        expect(yield* finalizeDeferredCodeAnchors(fixture.config)).toMatchObject({
          failedCount: 1,
          items: [{code: 'invalid-intent', state: 'failed'}],
        });

        yield* stage();
        const recoveryTamper = JSON.parse(yield* fixture.fs.readFileString(pendingPath)) as {
          recovery: {observedGraph: {stale: boolean}};
        };
        recoveryTamper.recovery.observedGraph.stale = false;
        yield* fixture.fs.writeFileString(pendingPath, `${JSON.stringify(recoveryTamper)}\n`, {mode: 0o600});
        expect(yield* finalizeDeferredCodeAnchors(fixture.config)).toMatchObject({
          failedCount: 1,
          items: [{code: 'invalid-intent', state: 'failed'}],
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
});

const makeFixture = Effect.fn('deferredCodeAnchorTest.makeFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-deferred-anchor-'});
  const repository = path.join(home, 'repository');
  yield* fs.makeDirectory(repository);
  yield* runCommandEffect('git', ['init', '--quiet'], {cwd: repository});
  yield* runCommandEffect(
    'git',
    [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '--allow-empty',
      '--quiet',
      '--message',
      'fixture',
    ],
    {cwd: repository},
  );
  const manifestPath = path.join(home, 'seed-manifest.yaml');
  yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath,
    user: 'tester',
  };
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId: 'tn_deferred_test',
    project: 'threadnote',
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-08-29T00:00:00.000Z',
    topic: 'deferred',
    visibility: 'personal',
  };
  return {
    config,
    fs,
    metadata,
    outbox: path.join(home, 'data', 'local', 'user', 'tester', 'private', 'deferred-code-anchors', 'v1'),
    path,
    repository,
  };
});

function deferredRequest(callerCwd: string, codeRefs: readonly string[]): DeferredCodeAnchorWriteRequest {
  return {
    callerCwd,
    codeRefs,
    recovery: {
      code: 'ready-graph-unavailable' as const,
      indexingStarted: false as const,
      observedGraph: {freshness: 'stale', readySnapshot: 'absent', stale: true},
      preparation: {
        action: 'index-current-graph' as const,
        arguments: [] as const,
        command: 'threadnote graph index --no-vectors' as const,
        target: 'callerCwd' as const,
      },
      recovery: 'prepare-current-graph' as const,
      retryCondition: 'after-current-graph-ready' as const,
      retryable: true as const,
      type: 'memory-code-citation-capture-recovery' as const,
      version: 1 as const,
    },
  };
}

function memoryContent(metadata: MemoryMetadata, body: string): string {
  return formatMemoryDocument('MEMORY', metadata, body);
}
