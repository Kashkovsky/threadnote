import {expect, it} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {ResourceStore} from '../../src/effect/resource-store.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {preparePersonalMemoryWrite, writeDurableMemory} from '../../src/mcp/server/memory.js';
import {MEMORY_SCHEMA_VERSION} from '../../src/memory/code_citation.js';
import {formatMemoryDocument, type MemoryMetadata} from '../../src/memory/document.js';
import {resolveAuthoredMemoryRelations} from '../../src/memory/relations.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('MCP personal-memory schema rewrite guard', () => {
  it.effect('rejects a second writer that upgrades the replace target after preparation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-schema-race-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/schema-race.md';
        const metadata: MemoryMetadata = {
          kind: 'durable',
          project: 'threadnote',
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'codex',
          status: 'active',
          timestamp: '2026-08-26T20:00:00.000Z',
          topic: 'schema-race',
        };
        const original = formatMemoryDocument('MEMORY', metadata, 'Writer A observed schema v4.');
        const future = original
          .replace(`schema_version: ${MEMORY_SCHEMA_VERSION}`, `schema_version: ${MEMORY_SCHEMA_VERSION + 1}`)
          .replace('\n\n', '\nfuture_writer_field: preserve-me\n\n');
        const store = yield* ResourceStore;
        const location = {account: config.account, home: config.agentContextHome, user: config.user};
        yield* store.write(location, uri, original, {mode: 'create'});
        const params = {
          bodyText: 'Writer A replacement must not overwrite writer B.',
          metadata,
          replaceUri: uri,
        } as const;
        const prepared = yield* preparePersonalMemoryWrite(config, params);

        yield* store.write(location, uri, future, {mode: 'replace'});
        const result = yield* writeDurableMemory(config, {...params, prepared});
        const text = result.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');

        expect(result.isError).toBe(true);
        expect(text).toContain('newer than supported');
        expect(yield* store.read(location, uri)).toBe(future);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('leaves the source untouched when a validated relation target changes before commit', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-relation-race-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        const targetUri = 'threadnote://user/tester/memories/durable/projects/threadnote/relation-target.md';
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/relation-source.md';
        const targetMetadata: MemoryMetadata = {
          kind: 'durable',
          memoryId: 'tn_relation_race_target',
          project: 'threadnote',
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'codex',
          status: 'active',
          timestamp: '2026-08-31T00:00:00.000Z',
          topic: 'relation-target',
        };
        const original = formatMemoryDocument('MEMORY', targetMetadata, 'Original relation target.');
        const changed = formatMemoryDocument('MEMORY', targetMetadata, 'Changed relation target.');
        const sourceMetadata: MemoryMetadata = {
          ...targetMetadata,
          memoryId: 'tn_relation_race_source',
          relations: [{type: 'depends_on', uri: 'threadnote://memory/tn_relation_race_target'}],
          topic: 'relation-source',
        };
        const store = yield* ResourceStore;
        const location = {account: config.account, home: config.agentContextHome, user: config.user};
        yield* store.write(location, targetUri, original, {mode: 'create'});
        const params = {
          bodyText: 'Source must not commit against stale target bytes.',
          expectedSourceContent: [{content: original, uri: targetUri}],
          metadata: sourceMetadata,
        } as const;
        const prepared = yield* preparePersonalMemoryWrite(config, params);

        yield* store.write(location, targetUri, changed, {mode: 'replace'});
        const result = yield* writeDurableMemory(config, {...params, prepared});
        const text = result.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');

        expect(result.isError).toBe(true);
        expect(text).toContain('changed after this mutation was planned');
        expect(yield* store.read(location, targetUri)).toBe(changed);
        expect(Exit.isFailure(yield* Effect.exit(store.read(location, sourceUri)))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects a relation commit when the target identity becomes conflicted after validation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-relation-identity-race-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        const scope = 'threadnote://user/tester/memories';
        const targetUri = 'threadnote://user/tester/memories/durable/projects/threadnote/identity-target.md';
        const conflictUri = 'threadnote://user/tester/memories/durable/projects/threadnote/identity-conflict.md';
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/identity-source.md';
        const targetMetadata: MemoryMetadata = {
          kind: 'durable',
          memoryId: 'tn_relation_identity_race_target',
          project: 'threadnote',
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'codex',
          status: 'active',
          timestamp: '2026-08-31T00:00:00.000Z',
          topic: 'identity-target',
        };
        const target = formatMemoryDocument('MEMORY', targetMetadata, 'Original identity target.');
        const store = yield* ResourceStore;
        const location = {account: config.account, home: config.agentContextHome, user: config.user};
        yield* store.write(location, targetUri, target, {mode: 'create'});
        const authored = yield* resolveAuthoredMemoryRelations(config, [{type: 'depends_on', uri: targetUri}], {
          allowedUriScopes: [scope],
          sourceMemoryId: 'tn_relation_identity_race_source',
        });
        const sourceMetadata: MemoryMetadata = {
          ...targetMetadata,
          memoryId: 'tn_relation_identity_race_source',
          relations: authored.relations,
          topic: 'identity-source',
        };
        const conflict = formatMemoryDocument(
          'MEMORY',
          {...targetMetadata, topic: 'identity-conflict'},
          'Divergent content introduces an identity conflict.',
        );

        // Simulate a serialized writer whose best-effort recall invalidation failed:
        // the live conflict exists, but the identity index still has its cached generation.
        yield* fs.writeFileString(
          path.join(
            home,
            'data',
            'local',
            'user',
            'tester',
            'memories',
            'durable',
            'projects',
            'threadnote',
            'identity-conflict.md',
          ),
          conflict,
        );
        const result = yield* writeDurableMemory(config, {
          bodyText: 'The source must not commit against an ambiguous identity.',
          expectedSourceContent: authored.targets,
          metadata: sourceMetadata,
        });
        const text = result.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');

        expect(result.isError).toBe(true);
        expect(text).toContain('identity became ambiguous or moved during the write');
        expect(yield* store.read(location, targetUri)).toBe(target);
        expect(yield* store.read(location, conflictUri)).toBe(conflict);
        expect(Exit.isFailure(yield* Effect.exit(store.read(location, sourceUri)))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
