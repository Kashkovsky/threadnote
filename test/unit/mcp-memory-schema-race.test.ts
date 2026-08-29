import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {ResourceStore} from '../../src/effect/resource-store.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {preparePersonalMemoryWrite, writeDurableMemory} from '../../src/mcp/server/memory.js';
import {MEMORY_SCHEMA_VERSION} from '../../src/memory/code_citation.js';
import {formatMemoryDocument, type MemoryMetadata} from '../../src/memory/document.js';
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
});
