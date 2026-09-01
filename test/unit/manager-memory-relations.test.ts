import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Path, Ref} from 'effect';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {ResourceIoFailed, ResourceStore} from '../../src/effect/resource-store.js';
import {MEMORY_SCHEMA_VERSION} from '../../src/memory/code_citation.js';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '../../src/memory/document.js';
import {memoryIdentityAlias} from '../../src/memory/identity_alias.js';
import {readMemoryRecordsByUri} from '../../src/memory/index.js';
import {updateManagerMemoryRelations} from '../../src/manager/memory_relations.js';
import {assertManagerRawPersonalMemorySave, assertManagerRawSharedMemorySave} from '../../src/manager/memory_save.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {startManagerTestServer} from '../helpers/manager-test-server.js';
import {mkdir, mkdtemp, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';

const personalUri = 'threadnote://user/test/memories/durable/projects/threadnote/source.md';
const sharedUri = 'threadnote://user/test/memories/shared/default/durable/projects/threadnote/source.md';
const base = [
  'MEMORY',
  'kind: durable',
  'status: active',
  'project: threadnote',
  'topic: source',
  'memory_id: tn_manager_source',
  'relation: depends_on threadnote://memory/tn_manager_target',
  '',
  'Original body.',
].join('\n');

describe('Manager raw memory relation boundary', () => {
  it('allows body edits while preserving exact relation headers', () => {
    const updated = base.replace('Original body.', 'Updated body.');

    expect(() => assertManagerRawPersonalMemorySave(personalUri, base, base, updated)).not.toThrow();
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, base, base, updated)).not.toThrow();
  });

  it('allows a browser-normalized LF body edit of an existing CRLF memory', () => {
    const existing = base.replaceAll('\n', '\r\n');
    const updated = base.replace('Original body.', 'Updated body.');

    expect(() => assertManagerRawPersonalMemorySave(personalUri, existing, existing, updated)).not.toThrow();
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, existing, existing, updated)).not.toThrow();
  });

  it.each([
    ['add', base.replace('\n\nOriginal', '\nrelation: related_to threadnote://memory/tn_other\n\nOriginal')],
    ['change', base.replace('depends_on', 'related_to')],
    ['remove', base.replace('relation: depends_on threadnote://memory/tn_manager_target\n', '')],
  ])('rejects a raw %s relation edit until structured Manager authoring exists', (_operation, updated) => {
    expect(() => assertManagerRawPersonalMemorySave(personalUri, base, base, updated)).toThrow(
      'Raw Manager saves cannot change typed memory relations',
    );
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, base, base, updated)).toThrow(
      'Raw Manager saves cannot change typed memory relations',
    );
  });

  it('rejects changing the source identity into a preserved self relation', () => {
    const updated = base.replace('memory_id: tn_manager_source', 'memory_id: tn_manager_target');

    expect(() => assertManagerRawPersonalMemorySave(personalUri, base, base, updated)).toThrow(
      'Raw Manager saves cannot change stable memory_id',
    );
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, base, base, updated)).toThrow(
      'Raw Manager saves cannot change stable memory_id',
    );
  });

  effectIt.effect('adds, replaces, and removes relations through identity-safe CAS while preserving the memory', () =>
    Effect.gen(function* () {
      const fixture = yield* relationFixture();
      const targetContent = memoryContent('tn_manager_target', 'target', 'Target body.');
      const supersededContent = memoryContent('tn_manager_older', 'older', 'Older body.');
      const sourceContent = memoryContent('tn_manager_source', 'source', 'Original source body.', {
        keywords: ['preserve-me'],
        supersedes: memoryIdentityAlias('tn_manager_older'),
      });
      yield* fixture.store.write(fixture.location, fixture.sourceUri, sourceContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, fixture.targetUri, targetContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, fixture.olderUri, supersededContent, {mode: 'create'});

      const added = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [{type: 'depends_on', uri: fixture.targetUri}],
        uri: fixture.sourceUri,
      });
      expect(added.relations).toEqual([{type: 'depends_on', uri: memoryIdentityAlias('tn_manager_target')}]);
      const [stored] = yield* readMemoryRecordsByUri(fixture.config, [fixture.sourceUri]);
      expect(stored?.body).toBe('Original source body.');
      expect(stored?.metadata.keywords).toEqual(['preserve-me']);
      expect(stored?.metadata.supersedes).toBe(memoryIdentityAlias('tn_manager_older'));

      const changed = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: added.content,
        relations: [{type: 'evidence_for', uri: memoryIdentityAlias('tn_manager_target')}],
        uri: fixture.sourceUri,
      });
      expect(changed.relations).toEqual([{type: 'evidence_for', uri: memoryIdentityAlias('tn_manager_target')}]);
      const removed = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: changed.content,
        relations: [],
        uri: fixture.sourceUri,
      });
      expect(removed.relations).toEqual([]);
      expect(parseMemoryDocument(fixture.sourceUri, removed.content)?.metadata.relations).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects stale, self, duplicate, and out-of-scope structured relation writes', () =>
    Effect.gen(function* () {
      const fixture = yield* relationFixture();
      const sourceContent = memoryContent('tn_manager_source', 'source', 'Source.');
      const targetContent = memoryContent('tn_manager_target', 'target', 'Target.');
      yield* fixture.store.write(fixture.location, fixture.sourceUri, sourceContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, fixture.targetUri, targetContent, {mode: 'create'});

      const stale = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: `${sourceContent}\nchanged`,
        relations: [],
        uri: fixture.sourceUri,
      }).pipe(Effect.flip);
      const self = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [{type: 'related_to', uri: fixture.sourceUri}],
        uri: fixture.sourceUri,
      }).pipe(Effect.exit);
      const duplicate = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [
          {type: 'related_to', uri: fixture.targetUri},
          {type: 'related_to', uri: fixture.targetUri},
        ],
        uri: fixture.sourceUri,
      }).pipe(Effect.exit);
      const foreign = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [],
        uri: 'threadnote://user/other/memories/durable/projects/threadnote/source.md',
      }).pipe(Effect.flip);
      expect(stale).toMatchObject({code: 'memory-relations-conflict', status: 409});
      expect(String(stale)).toContain('changed after it was opened');
      expect(String(self)).toContain('cannot relate to itself');
      expect(String(duplicate)).toContain('Duplicate memory relations');
      expect(foreign).toMatchObject({code: 'memory-relations-forbidden', status: 403});
      expect(String(foreign)).toContain('current user memory corpus');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('returns structured HTTP statuses for stale and invalid relation editor requests', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-manager-relations-http-'));
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'manifest.yaml'),
      user: 'test',
    } as const;
    const sourceContent = memoryContent('tn_manager_source', 'source', 'Source.');
    const sourcePath = join(home, 'data', 'local', 'user', 'test', 'memories', 'durable', 'projects', 'threadnote');
    await mkdir(sourcePath, {recursive: true});
    await writeFile(join(sourcePath, 'source.md'), sourceContent);
    const server = await startManagerTestServer(config, 'relations-secret');
    try {
      const response = await fetch(`${server.url}/api/memory/relations`, {
        body: JSON.stringify({expectedContent: `${sourceContent}\nstale`, relations: [], uri: personalUri}),
        headers: {authorization: 'Bearer relations-secret', 'content-type': 'application/json'},
        method: 'POST',
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: 'memory-relations-conflict',
        error: 'The memory changed after it was opened. Reload and retry.',
        retryAfterMilliseconds: 0,
      });

      const malformedSource = await fetch(`${server.url}/api/memory/relations`, {
        body: JSON.stringify({expectedContent: sourceContent, relations: [], uri: 'not-a-threadnote-uri'}),
        headers: {authorization: 'Bearer relations-secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(malformedSource.status).toBe(400);
      expect(await malformedSource.json()).toMatchObject({code: 'memory-relations-invalid'});

      const invalidRelation = await fetch(`${server.url}/api/memory/relations`, {
        body: JSON.stringify({
          expectedContent: sourceContent,
          relations: [{type: 'invented_relation', uri: personalUri}],
          uri: personalUri,
        }),
        headers: {authorization: 'Bearer relations-secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(invalidRelation.status).toBe(400);
      expect(await invalidRelation.json()).toMatchObject({code: 'memory-relations-invalid'});
    } finally {
      await server.close();
      await rm(home, {force: true, recursive: true});
    }
  });

  effectIt.effect('keeps operational relation failures private and distinct from conflicts', () =>
    Effect.gen(function* () {
      const fixture = yield* relationFixture();
      const sourceContent = memoryContent('tn_manager_source', 'source', 'Source.');
      const targetContent = memoryContent('tn_manager_target', 'target', 'Target.');
      yield* fixture.store.write(fixture.location, fixture.sourceUri, sourceContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, fixture.targetUri, targetContent, {mode: 'create'});
      const failingStore = ResourceStore.of({
        ...fixture.store,
        writeChecked: (_location, uri) =>
          Effect.fail(
            new ResourceIoFailed({
              cause: new Error('/private/storage/detail'),
              message: '/private/storage/detail',
              operation: 'write',
              uri,
            }),
          ),
      });

      const failure = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [{type: 'related_to', uri: fixture.targetUri}],
        uri: fixture.sourceUri,
      }).pipe(Effect.provideService(ResourceStore, failingStore), Effect.flip);

      expect(failure).toMatchObject({code: 'memory-relations-operation-failed', status: 500});
      expect(failure.message).toBe('Threadnote could not update the memory relations. Reload and retry.');
      expect(failure.message).not.toContain('/private/storage/detail');

      const readFailingStore = ResourceStore.of({
        ...fixture.store,
        read: (location, uri) =>
          uri === fixture.targetUri
            ? Effect.fail(
                new ResourceIoFailed({
                  cause: new Error('/private/target/detail'),
                  message: '/private/target/detail',
                  operation: 'read',
                  uri,
                }),
              )
            : fixture.store.read(location, uri),
      });
      const resolutionFailure = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [{type: 'related_to', uri: fixture.targetUri}],
        uri: fixture.sourceUri,
      }).pipe(Effect.provideService(ResourceStore, readFailingStore), Effect.flip);
      expect(resolutionFailure).toMatchObject({code: 'memory-relations-operation-failed', status: 500});
      expect(resolutionFailure.message).not.toContain('/private/target/detail');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps shared relation targets inside the source team for URIs and stable aliases', () =>
    Effect.gen(function* () {
      const fixture = yield* relationFixture();
      const sharedRoot = 'threadnote://user/test/memories/shared';
      const sourceUri = `${sharedRoot}/alpha/durable/projects/threadnote/source.md`;
      const personalTargetUri = 'threadnote://user/test/memories/durable/projects/threadnote/personal-target.md';
      const otherTeamTargetUri = `${sharedRoot}/beta/durable/projects/threadnote/shared-target.md`;
      const sourceContent = memoryContent('tn_manager_shared_source', 'source', 'Shared source.', {
        visibility: 'shared',
      });
      const personalTargetContent = memoryContent('tn_manager_personal_target', 'personal-target', 'Personal target.');
      const otherTeamTargetContent = memoryContent(
        'tn_manager_other_team_target',
        'shared-target',
        'Other team target.',
        {visibility: 'shared'},
      );
      yield* fixture.store.write(fixture.location, sourceUri, sourceContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, personalTargetUri, personalTargetContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, otherTeamTargetUri, otherTeamTargetContent, {mode: 'create'});

      const rejectedTargets = [
        {message: 'authorized memory scope', uri: personalTargetUri},
        {message: 'authorized memory scope', uri: otherTeamTargetUri},
        {message: 'authorized active corpus', uri: memoryIdentityAlias('tn_manager_personal_target')},
        {message: 'authorized active corpus', uri: memoryIdentityAlias('tn_manager_other_team_target')},
      ];
      for (const target of rejectedTargets) {
        const result = yield* updateManagerMemoryRelations(fixture.config, {
          expectedContent: sourceContent,
          relations: [{type: 'related_to', uri: target.uri}],
          uri: sourceUri,
        }).pipe(Effect.exit);
        expect(String(result)).toContain(target.message);
      }
      const [stored] = yield* readMemoryRecordsByUri(fixture.config, [sourceUri]);
      expect(stored?.content).toBe(sourceContent);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('returns a conflict when a relation target changes immediately before the locked write', () =>
    Effect.gen(function* () {
      const fixture = yield* relationFixture();
      const sourceContent = memoryContent('tn_manager_source', 'source', 'Source.');
      const targetContent = memoryContent('tn_manager_target', 'target', 'Target.');
      const changedTargetContent = memoryContent('tn_manager_target', 'target', 'Changed target.');
      yield* fixture.store.write(fixture.location, fixture.sourceUri, sourceContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, fixture.targetUri, targetContent, {mode: 'create'});
      const racingStore = ResourceStore.of({
        ...fixture.store,
        writeChecked: (location, uri, content, options, check) =>
          fixture.store
            .write(fixture.location, fixture.targetUri, changedTargetContent, {mode: 'replace'})
            .pipe(Effect.andThen(fixture.store.writeChecked(location, uri, content, options, check))),
      });

      const conflict = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [{type: 'related_to', uri: fixture.targetUri}],
        uri: fixture.sourceUri,
      }).pipe(Effect.provideService(ResourceStore, racingStore), Effect.flip);

      expect(conflict).toMatchObject({code: 'memory-relations-conflict', status: 409});
      expect(conflict.message).toContain('target changed during the write');
      const [storedSource, storedTarget] = yield* readMemoryRecordsByUri(fixture.config, [
        fixture.sourceUri,
        fixture.targetUri,
      ]);
      expect(storedSource?.content).toBe(sourceContent);
      expect(storedTarget?.content).toBe(changedTargetContent);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'rejects an update when the source changes after Manager validation but before writer preparation',
    () =>
      Effect.gen(function* () {
        const fixture = yield* relationFixture();
        const sourceContent = memoryContent('tn_manager_source', 'source', 'Original source body.');
        const targetContent = memoryContent('tn_manager_target', 'target', 'Target body.');
        const concurrentContent = memoryContent('tn_manager_source', 'source', 'Concurrent source body.', {
          keywords: ['concurrent-edit'],
        });
        yield* fixture.store.write(fixture.location, fixture.sourceUri, sourceContent, {mode: 'create'});
        yield* fixture.store.write(fixture.location, fixture.targetUri, targetContent, {mode: 'create'});

        const targetRead = yield* Deferred.make<void>();
        const resumeResolution = yield* Deferred.make<void>();
        const targetReadCount = yield* Ref.make(0);
        const interceptedStore = ResourceStore.of({
          ...fixture.store,
          read: (location, uri) =>
            fixture.store
              .read(location, uri)
              .pipe(
                Effect.tap(() =>
                  uri === fixture.targetUri
                    ? Ref.getAndUpdate(targetReadCount, count => count + 1).pipe(
                        Effect.flatMap(count =>
                          count === 0
                            ? Deferred.succeed(targetRead, undefined).pipe(
                                Effect.andThen(Deferred.await(resumeResolution)),
                              )
                            : Effect.void,
                        ),
                      )
                    : Effect.void,
                ),
              ),
        });
        const update = yield* updateManagerMemoryRelations(fixture.config, {
          expectedContent: sourceContent,
          relations: [{type: 'depends_on', uri: fixture.targetUri}],
          uri: fixture.sourceUri,
        }).pipe(Effect.provideService(ResourceStore, interceptedStore), Effect.forkScoped);

        yield* Deferred.await(targetRead);
        yield* fixture.store.write(fixture.location, fixture.sourceUri, concurrentContent, {mode: 'replace'});
        yield* Deferred.succeed(resumeResolution, undefined);
        const result = yield* Fiber.join(update).pipe(Effect.exit);

        expect(String(result)).toContain('changed while its replacement was being prepared');
        const [stored] = yield* readMemoryRecordsByUri(fixture.config, [fixture.sourceUri]);
        expect(stored?.content).toBe(concurrentContent);
        expect(stored?.metadata.relations).toBeUndefined();
      }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function config() {
  return {
    account: 'local',
    agentContextHome: '/tmp/threadnote-manager-memory-relations',
    agentId: 'threadnote',
    manifestPath: '/tmp/threadnote-manager-memory-relations/manifest.json',
    user: 'test',
  } as const;
}

const relationFixture = Effect.fn('test.managerRelationFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-manager-relations-'});
  const config = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(home, 'manifest.yaml'),
    user: 'test',
  } as const;
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  const store = yield* ResourceStore;
  const root = 'threadnote://user/test/memories/durable/projects/threadnote';
  return {
    config,
    location: {account: config.account, home, user: config.user},
    olderUri: `${root}/older.md`,
    sourceUri: `${root}/source.md`,
    store,
    targetUri: `${root}/target.md`,
  } as const;
});

function memoryContent(memoryId: string, topic: string, body: string, overrides: Partial<MemoryMetadata> = {}): string {
  return formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      memoryId,
      project: 'threadnote',
      schemaVersion: MEMORY_SCHEMA_VERSION,
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-08-31T00:00:00.000Z',
      topic,
      visibility: 'personal',
      ...overrides,
    },
    body,
  );
}
