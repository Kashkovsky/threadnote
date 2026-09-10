import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {ResourceStore} from '../../src/effect/resource-store.js';
import {runNativeReadTool} from '../../src/mcp/server/memory.js';
import {memoryReadResourcesFromNativeResult} from '../../src/mcp/server/recall.js';
import {MEMORY_SCHEMA_VERSION} from '../../src/memory/code_citation.js';
import {formatMemoryDocument, type MemoryMetadata} from '../../src/memory/document.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const PRESENT_BODY = 'Present memory body for mixed batch read.';

function memoryMetadata(topic: string): MemoryMetadata {
  return {
    kind: 'durable',
    project: 'threadnote',
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceAgentClient: 'codex',
    status: 'active',
    timestamp: '2026-09-10T00:00:00.000Z',
    topic,
  };
}

function memoryUri(topic: string): string {
  return `threadnote://user/tester/memories/durable/projects/threadnote/${topic}.md`;
}

describe('MCP native batch read_context', () => {
  effectIt.effect('returns mixed success when some requested memories are missing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-read-batch-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        const presentUri = memoryUri('present-read');
        const missingUri = memoryUri('missing-read');
        const store = yield* ResourceStore;
        yield* store.write(
          {account: config.account, home: config.agentContextHome, user: config.user},
          presentUri,
          formatMemoryDocument('MEMORY', memoryMetadata('present-read'), PRESENT_BODY),
          {mode: 'create'},
        );

        const result = yield* runNativeReadTool(config, [missingUri, presentUri]);
        const texts = result.content.filter(item => item.type === 'text').map(item => item.text);
        const canonicalRead = result._meta?.['threadnote.io/canonical-read'] as
          | {readonly missing?: readonly string[]; readonly resources?: readonly {readonly requestedUri: string}[]}
          | undefined;

        expect(result.isError).not.toBe(true);
        expect(texts.some(text => text.includes(PRESENT_BODY))).toBe(true);
        expect(canonicalRead?.missing).toEqual([missingUri]);
        expect(canonicalRead?.resources?.map(resource => resource.requestedUri)).toEqual([presentUri]);
        expect(
          memoryReadResourcesFromNativeResult(result, [missingUri, presentUri])?.map(resource => resource.uri),
        ).toEqual([presentUri]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps the batch as an error when every requested memory is missing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-read-batch-missing-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };

        const result = yield* runNativeReadTool(config, [memoryUri('missing-a'), memoryUri('missing-b')]);
        expect(result.isError).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.prop(
    'succeeds for each present URI and errors only when none are present',
    {
      flags: FC.array(FC.boolean(), {maxLength: 4, minLength: 1}),
    },
    ({flags}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-read-batch-prop-'});
          const config: RuntimeConfig = {
            account: 'local',
            agentContextHome: home,
            agentId: 'threadnote',
            manifestPath: path.join(home, 'seed-manifest.yaml'),
            user: 'tester',
          };
          const store = yield* ResourceStore;
          const location = {account: config.account, home: config.agentContextHome, user: config.user};
          const uris = flags.map((_, index) => memoryUri(`batch-${index}`));
          yield* Effect.forEach(
            flags.flatMap((present, index) => (present ? [index] : [])),
            index =>
              store.write(
                location,
                uris[index],
                formatMemoryDocument('MEMORY', memoryMetadata(`batch-${index}`), `Present body ${index}`),
                {mode: 'create'},
              ),
            {concurrency: 1},
          );

          const result = yield* runNativeReadTool(config, uris);
          const presentCount = flags.filter(Boolean).length;
          const canonicalRead = result._meta?.['threadnote.io/canonical-read'] as
            {readonly resources?: readonly unknown[]} | undefined;
          expect(canonicalRead?.resources?.length ?? 0).toBe(presentCount);
          expect(result.isError === true).toBe(presentCount === 0);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 16}},
  );
});
