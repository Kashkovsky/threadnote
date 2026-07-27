import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {ResourceStore} from '../../src/effect/resource-store.js';
import {runObsidianInboxScan} from '../../src/obsidian_inbox.js';
import {
  runObsidianProjectionAdd,
  runObsidianProjectionPublish,
  runObsidianProjectionRemove,
  runObsidianProjectionSync,
} from '../../src/obsidian_projection.js';
import {
  runObsidianSourceAdd,
  runObsidianSourceInventory,
  runObsidianSourceRemove,
  syncObsidianSourcesBeforeRecall,
} from '../../src/obsidian_source.js';
import {loadRecallIndexData} from '../../src/recall/index.js';
import type {RuntimeConfig} from '../../src/types.js';
import {runEffect} from '../helpers/effect-runtime.js';

const temporaryDirectories: string[] = [];

function runtime(home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: join(home, 'seed-manifest.yaml'),
    user: 'tester',
  };
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, content);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {force: true, recursive: true})));
});

describe('Obsidian zero-plugin bridge', () => {
  it('inventories allowlisted notes, projects memories, and forms idempotent Inbox candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-obsidian-'));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    const vault = join(root, 'vault');
    const config = runtime(home);
    await mkdir(vault, {recursive: true});
    await write(join(vault, 'Engineering', 'Auth.md'), '# Mobile authentication\n\nUse the token mediator.');
    await write(join(vault, 'Engineering', 'Secret.md'), `# Do not ingest\n\nsk-${'a'.repeat(24)}`);
    await write(
      join(vault, 'Threadnote Inbox', 'Bridge.md'),
      [
        '---',
        'threadnote_candidate: true',
        'kind: durable',
        'project: threadnote',
        'topic: obsidian-bridge',
        'category: invariant',
        '---',
        '',
        'External notes never override canonical repository guidance.',
      ].join('\n'),
    );

    await runEffect(
      runObsidianSourceAdd(config, {
        apply: true,
        id: 'engineering',
        inbox: 'Threadnote Inbox',
        include: ['**/*.md'],
        vault,
      }),
    );
    const inventory = await runEffect(captureConsole(runObsidianSourceInventory(config, 'engineering')));
    expect(inventory.output).toContain('ADD       Engineering/Auth.md');
    expect(inventory.output).toContain('SKIP      Engineering/Secret.md');
    expect(inventory.output).not.toContain('Bridge.md');

    const initialSourceSync = await runEffect(syncObsidianSourcesBeforeRecall(config));
    expect(initialSourceSync.syncedSources).toEqual(['engineering']);
    expect(await runEffect(syncObsidianSourcesBeforeRecall(config))).toEqual({
      syncedSources: [],
      warnings: [expect.stringMatching(/skipped 1 note/)],
    });
    const externalUri = 'threadnote://resources/external/obsidian/engineering/Engineering/Auth.md';
    expect(
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          return yield* store.read(
            {account: config.account, home: config.agentContextHome, user: config.user},
            externalUri,
          );
        }),
      ),
    ).toContain('Use the token mediator');
    await write(
      join(vault, 'Engineering', 'Auth.md'),
      '# Mobile authentication\n\nUse the refreshed token mediator policy.',
    );
    expect((await runEffect(syncObsidianSourcesBeforeRecall(config))).syncedSources).toEqual(['engineering']);
    expect(
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          return yield* store.read(
            {account: config.account, home: config.agentContextHome, user: config.user},
            externalUri,
          );
        }),
      ),
    ).toContain('refreshed token mediator policy');
    const externalRecallIndex = await runEffect(
      loadRecallIndexData(config, {
        includeInactive: false,
        query: 'Mobile authentication token mediator',
      }),
    );
    expect(externalRecallIndex.candidates.map(candidate => candidate.uri)).toContain(externalUri);

    const memoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/obsidian-bridge.md';
    const unselectedMemoryUri =
      'threadnote://user/tester/memories/durable/projects/threadnote/unselected-obsidian-bridge.md';
    await runEffect(
      Effect.gen(function* () {
        const store = yield* ResourceStore;
        yield* store.write(
          {account: config.account, home: config.agentContextHome, user: config.user},
          memoryUri,
          [
            'MEMORY',
            'schema_version: 3',
            'memory_id: tn_bridge',
            'kind: durable',
            'status: active',
            'project: threadnote',
            'topic: obsidian-bridge',
            'source_agent_client: codex',
            'timestamp: 2026-07-27T00:00:00.000Z',
            'created_at: 2026-07-27T00:00:00.000Z',
            'updated_at: 2026-07-27T00:00:00.000Z',
            'visibility: personal',
            '',
            'Obsidian is a surface; Threadnote remains authoritative.',
          ].join('\n'),
          {mode: 'upsert'},
        );
        yield* store.write(
          {account: config.account, home: config.agentContextHome, user: config.user},
          unselectedMemoryUri,
          [
            'MEMORY',
            'schema_version: 3',
            'memory_id: tn_unselected',
            'kind: durable',
            'status: active',
            'project: threadnote',
            'topic: unselected-obsidian-bridge',
            'source_agent_client: codex',
            'timestamp: 2026-07-27T00:00:00.000Z',
            '',
            'This memory must stay out of the vault until explicitly selected.',
          ].join('\n'),
          {mode: 'upsert'},
        );
      }),
    );
    await runEffect(
      runObsidianProjectionAdd(config, {
        apply: true,
        folder: 'Threadnote',
        id: 'memory',
        vault,
      }),
    );

    const projectedDirectory = join(vault, 'Threadnote', 'Memories', 'threadnote', 'durable');
    const projected = join(projectedDirectory, 'obsidian-bridge--tn_bridge.md');
    const publishPreview = await runEffect(
      captureConsole(
        runObsidianProjectionPublish(config, {
          apply: false,
          id: 'memory',
          uris: [memoryUri],
        }),
      ),
    );
    expect(publishPreview.output).toContain('Would publish 1 selected memory URI');
    await expect(readFile(projected, 'utf8')).rejects.toThrow();

    await runEffect(
      runObsidianProjectionPublish(config, {
        apply: true,
        id: 'memory',
        uris: [memoryUri],
      }),
    );
    const projectedContent = await readFile(projected, 'utf8');
    expect(projectedContent).toContain('threadnote_id: tn_bridge');
    expect(projectedContent).toContain('threadnote_uri: threadnote://user/tester/memories/');
    expect(projectedContent).toContain('Threadnote is authoritative');
    expect(await readdir(projectedDirectory)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^unselected-obsidian-bridge--/)]),
    );
    expect(await readFile(join(vault, 'Threadnote', 'Views', 'Active Handoffs.base'), 'utf8')).toContain(
      'threadnote_generated',
    );

    const firstInbox = await runEffect(
      captureConsole(runObsidianInboxScan(config, {apply: true, source: 'engineering'})),
    );
    expect(firstInbox.output).toContain('Created 1 candidate review');
    const secondInbox = await runEffect(
      captureConsole(runObsidianInboxScan(config, {apply: true, source: 'engineering'})),
    );
    expect(secondInbox.output).toContain('UNCHANGED Bridge.md');
    expect(secondInbox.output).toContain('No new candidate reviews were created');
    const reviewDirectory = join(home, 'threadnote', 'candidates', 'v1', 'reviews');
    expect((await readdir(reviewDirectory)).filter(name => name.endsWith('.json'))).toHaveLength(1);

    const noOpProjection = await runEffect(
      captureConsole(runObsidianProjectionSync(config, {apply: false, id: 'memory'})),
    );
    expect(noOpProjection.output).toContain('UNCHANGED');
    expect(noOpProjection.output).not.toContain('UPDATE');

    await write(projected, `${projectedContent}\nUser edit that must survive ordinary sync.\n`);
    const driftedProjection = await runEffect(
      captureConsole(runObsidianProjectionSync(config, {apply: true, id: 'memory'})),
    );
    expect(driftedProjection.output).toContain('DRIFT');
    expect(await readFile(projected, 'utf8')).toContain('User edit that must survive ordinary sync.');

    await runEffect(runObsidianProjectionSync(config, {apply: true, force: true, id: 'memory'}));
    expect(await readFile(projected, 'utf8')).toBe(projectedContent);

    const userNote = join(vault, 'Threadnote', 'My notes.md');
    await write(userNote, 'This file is not managed by Threadnote.');
    await runEffect(runObsidianProjectionRemove(config, {apply: true, id: 'memory'}));
    expect(await readFile(userNote, 'utf8')).toBe('This file is not managed by Threadnote.');
    await rm(vault, {force: true, recursive: true});
    expect((await runEffect(syncObsidianSourcesBeforeRecall(config))).warnings).toEqual([
      expect.stringMatching(/Auto-sync for Obsidian source "engineering" failed:.*not a directory/i),
    ]);
    await runEffect(runObsidianSourceRemove(config, {apply: true, id: 'engineering'}));
    await expect(
      runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          return yield* store.read(
            {account: config.account, home: config.agentContextHome, user: config.user},
            externalUri,
          );
        }),
      ),
    ).rejects.toThrow();
  });
});
