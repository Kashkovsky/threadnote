import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {ResourceStore} from '../../src/effect/resource-store.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {createMemoryCodeCitation, MEMORY_SCHEMA_VERSION} from '../../src/memory/code_citation.js';
import {formatMemoryDocument} from '../../src/memory/document.js';
import {runSharePublishTool} from '../../src/mcp/server/share.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('MCP share-publish citation policy', () => {
  it.effect('rechecks the exact source inside the publish lock after an initially clean read', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-share-policy-'});
        const worktree = path.join(home, 'share', 'worktrees', 'default');
        const gitdir = path.join(home, 'share', 'teams', 'default.gitdir');
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/policy.md';
        const sourcePath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'policy.md',
        );
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        yield* fs.makeDirectory(path.dirname(sourcePath), {recursive: true});
        yield* fs.makeDirectory(worktree, {recursive: true});
        yield* fs.makeDirectory(path.join(home, 'share'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'share', 'teams.json'),
          `${JSON.stringify(
            {
              defaultTeam: 'default',
              teams: {
                default: {
                  addedAt: '2026-08-26T20:00:00.000Z',
                  gitdir,
                  name: 'default',
                  remote: 'git@example.com:team/memories.git',
                  worktree,
                },
              },
              version: 1,
            },
            undefined,
            2,
          )}\n`,
        );
        const clean = citedMemory(false);
        const swapped = citedMemory(true);
        yield* fs.writeFileString(sourcePath, swapped);

        const realStore = yield* ResourceStore;
        let sourceReads = 0;
        const initialReadStore = ResourceStore.of({
          ...realStore,
          read: (location, uri) =>
            uri === sourceUri
              ? Effect.sync(() => (++sourceReads === 1 ? clean : swapped))
              : realStore.read(location, uri),
        });
        const result = yield* runSharePublishTool(config, sourceUri, {push: false}).pipe(
          Effect.provideService(ResourceStore, initialReadStore),
        );
        const text = result.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');

        expect(result.isError).toBe(true);
        expect(sourceReads).toBe(2);
        expect(text).toContain('dirty worktree cannot be shared');
        expect(yield* fs.readFileString(sourcePath)).toBe(swapped);
        expect(yield* fs.exists(path.join(worktree, 'durable', 'projects', 'threadnote', 'policy.md'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function citedMemory(sourceDirty: boolean): string {
  const citation = createMemoryCodeCitation({
    extractorSet: 'native-code-graph-13',
    fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
    path: 'src/mcp_server_share.ts',
    repositoryId: 'b'.repeat(64),
    repositoryIdentityKind: 'remote',
    sourceCommit: 'c'.repeat(40),
    sourceDirty,
    sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
    target: {kind: 'file'},
    version: 1,
  });
  return formatMemoryDocument(
    'MEMORY',
    {
      codeCitations: [citation],
      kind: 'durable',
      project: 'threadnote',
      schemaVersion: MEMORY_SCHEMA_VERSION,
      sourceAgentClient: 'codex',
      status: 'active',
      timestamp: '2026-08-26T20:00:00.000Z',
      topic: 'policy',
    },
    sourceDirty ? 'The source changed after the initial read.' : 'Initially clean source.',
  );
}
