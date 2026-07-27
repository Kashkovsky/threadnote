import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {TestClock} from 'effect/testing';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runExportPack, runForget, runImportPack, runList, runRead, runRecall, runRemember} from '../../src/memory.js';
import {loadRecallIndex} from '../../src/recall/index.js';
import {prepareRecallSections} from '../../src/recall/runtime.js';
import type {RuntimeConfig} from '../../src/types.js';

describe('native memory workflow', () => {
  it.effect('stores, reads, lists, recalls, and forgets in the owned canonical store', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-memory-'});
        const manifestPath = path.join(home, 'seed-manifest.yaml');
        yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath,
          user: 'tester',
        };
        yield* TestClock.setTime(Date.now());
        const uri = 'viking://user/tester/memories/durable/projects/threadnote/lease-recovery.md';

        yield* runRemember(config, {
          kind: 'durable',
          project: 'threadnote',
          sourceAgentClient: 'test',
          text: 'QX7 lease recovery resumes a worker after three missed heartbeats.',
          topic: 'lease-recovery',
        });

        const read = yield* captureConsole(runRead(config, uri, {}));
        expect(read.output).toContain('QX7 lease recovery');

        const list = yield* captureConsole(
          runList(config, 'viking://user/tester/memories/durable/projects/threadnote', {recursive: true}),
        );
        expect(list.output).toContain(uri);

        const indexed = yield* loadRecallIndex(config, {
          forceRefresh: true,
          includeInactive: false,
          query: 'QX7 missed heartbeat lease recovery',
        });
        expect(indexed.map(candidate => candidate.uri)).toContain(uri);

        const recall = yield* captureConsole(
          runRecall(config, {
            inferScope: false,
            query: 'QX7 missed heartbeat lease recovery',
          }),
        );
        expect(recall.output).toContain(uri);
        expect(recall.output).not.toContain('background service');

        yield* runForget(config, uri, {});
        expect(
          yield* fs.exists(
            path.join(
              home,
              'data',
              'viking',
              'local',
              'user',
              'tester',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'lease-recovery.md',
            ),
          ),
        ).toBe(false);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('round-trips the default pack root into the current user memories namespace', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-pack-'});
        const sourceHome = path.join(root, 'source');
        const targetHome = path.join(root, 'target');
        const packPath = path.join(root, 'memories.threadnote-pack.json');
        yield* fs.makeDirectory(sourceHome, {recursive: true});
        yield* fs.makeDirectory(targetHome, {recursive: true});
        const sourceConfig: RuntimeConfig = {
          account: 'local',
          agentContextHome: sourceHome,
          agentId: 'threadnote',
          manifestPath: path.join(sourceHome, 'seed-manifest.yaml'),
          user: 'source-user',
        };
        const targetConfig: RuntimeConfig = {
          ...sourceConfig,
          agentContextHome: targetHome,
          manifestPath: path.join(targetHome, 'seed-manifest.yaml'),
          user: 'target-user',
        };
        yield* TestClock.setTime(Date.now());
        yield* runRemember(sourceConfig, {
          kind: 'durable',
          project: 'threadnote',
          sourceAgentClient: 'test',
          text: 'Pack round-trip preserves the memories root.',
          topic: 'pack-root',
        });

        yield* runExportPack(sourceConfig, {path: packPath});
        yield* runImportPack(targetConfig, {path: packPath});

        const importedUri = 'viking://user/target-user/memories/durable/projects/threadnote/pack-root.md';
        expect((yield* captureConsole(runRead(targetConfig, importedUri, {}))).output).toContain(
          'Pack round-trip preserves',
        );
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('retains preferred project-scope candidates alongside the global fallback', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-preferred-recall-scope-'});
        const globalRoot = path.join(home, 'data', 'viking', 'local', 'resources', 'repos', 'alpha');
        const scopedRoot = path.join(home, 'data', 'viking', 'local', 'resources', 'repos', 'zeta');
        yield* fs.makeDirectory(globalRoot, {recursive: true});
        yield* fs.makeDirectory(scopedRoot, {recursive: true});
        yield* Effect.forEach(
          Array.from({length: 140}, (_, index) => index),
          index =>
            fs.writeFileString(
              path.join(globalRoot, `${String(index).padStart(3, '0')}.md`),
              `# Global ${index}\n\ncommon recall term`,
            ),
          {concurrency: 16},
        );
        yield* fs.writeFileString(path.join(scopedRoot, 'target.md'), '# Scoped target\n\ncommon recall term');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };

        const result = yield* prepareRecallSections(config, {
          allowExactRescue: false,
          exactMatches: [],
          feedbackQuery: 'common recall term',
          includeInactive: false,
          limit: 5,
          passes: [],
          preferredUriScopes: ['viking://resources/repos/zeta'],
          query: 'common recall term',
          readRecords: () => Effect.succeed([]),
          semanticScores: null,
        });

        expect(result.expansionCandidates.map(candidate => candidate.uri)).toContain(
          'viking://resources/repos/zeta/target.md',
        );
        expect(result.expansionCandidates.some(candidate => candidate.uri.includes('/repos/alpha/'))).toBe(true);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );
});
