import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from '../../src/code_graph/indexer.js';
import type {CodeGraphIndexSummary} from '../../src/code_graph/types.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {ResourceStore} from '../../src/effect/resource-store.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {MEMORY_SCHEMA_VERSION} from '../../src/memory/code_citation.js';
import {
  isDeferredCodeAnchorIntentFilename,
  stageDeferredCodeAnchorIntent,
} from '../../src/memory/deferred_code_anchor.js';
import {withDeferredCodeAnchorIndexHeal} from '../../src/memory/deferred_code_anchor_index_heal.js';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '../../src/memory/document.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '../helpers/test-error.js';

const WRAP_HEAL_URI = 'threadnote://user/tester/memories/durable/projects/threadnote/wrap-heal.md';

describe('in-process graph-index deferred-anchor recovery', () => {
  effectIt.effect('heals matching intents after a successful in-process index', () => {
    const summary = indexSummary();
    const healed: Array<{readonly cwd: string; readonly home: string; readonly worktreeId: string}> = [];
    const inner = indexer({
      index: () => Effect.succeed(summary),
    });

    return Effect.gen(function* () {
      const published = yield* withDeferredCodeAnchorIndexHeal(inner, (options, publishedSummary) =>
        Effect.sync(() => {
          healed.push({
            cwd: options.cwd,
            home: options.threadnoteHome,
            worktreeId: publishedSummary.identity.worktreeId,
          });
        }),
      ).index({
        cwd: '/repo',
        threadnoteHome: '/threadnote-home',
      });

      expect(published).toBe(summary);
      expect(healed).toEqual([{cwd: '/repo', home: '/threadnote-home', worktreeId: summary.identity.worktreeId}]);
    });
  });

  effectIt.effect('does not heal when index fails', () => {
    const healed: string[] = [];
    const inner = indexer({
      index: () => Effect.fail(TestError.make({message: 'index failed'})),
    });

    return Effect.gen(function* () {
      const failure = yield* withDeferredCodeAnchorIndexHeal(inner, () =>
        Effect.sync(() => {
          healed.push('healed');
        }),
      )
        .index({cwd: '/repo', threadnoteHome: '/threadnote-home'})
        .pipe(Effect.flip);

      expect(failure).toMatchObject({message: 'index failed'});
      expect(healed).toEqual([]);
    });
  });

  effectIt.effect('keeps a successful index when heal fails closed', () => {
    const summary = indexSummary();
    const inner = indexer({
      index: () => Effect.succeed(summary),
    });

    return Effect.gen(function* () {
      expect(
        yield* withDeferredCodeAnchorIndexHeal(inner, () =>
          Effect.fail(TestError.make({message: 'heal failed'})).pipe(Effect.asVoid),
        ).index({
          cwd: '/repo',
          threadnoteHome: '/threadnote-home',
        }),
      ).toBe(summary);
    });
  });

  effectIt.effect('does not heal historical ensureCommit publication', () => {
    const healed: string[] = [];
    const inner = indexer({
      ensureCommit: () => Effect.succeed({leaseToken: 'lease', snapshot: indexSummary().snapshot}),
    });

    return Effect.gen(function* () {
      yield* withDeferredCodeAnchorIndexHeal(inner, () =>
        Effect.sync(() => {
          healed.push('healed');
        }),
      ).ensureCommit({
        commit: 'b'.repeat(40),
        cwd: '/repo',
        threadnoteHome: '/threadnote-home',
      });
      expect(healed).toEqual([]);
    });
  });

  effectIt.effect(
    'finalizes a matching intent after ApplicationLayer in-process index',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-wrap-heal-'});
          const repository = path.join(root, 'repository');
          const home = path.join(root, 'home');
          const manifestPath = path.join(home, 'seed-manifest.yaml');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.makeDirectory(home, {recursive: true});
          yield* fs.writeFileString(path.join(repository, 'src', 'heal.ts'), 'export const wrapHeal = "ready";\n');
          yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
          yield* runCommandEffect('git', ['init', '--quiet'], {cwd: repository}).pipe(TestClock.withLive);
          yield* runCommandEffect('git', ['add', '.'], {cwd: repository}).pipe(TestClock.withLive);
          yield* runCommandEffect(
            'git',
            [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '--quiet',
              '--message',
              'fixture',
            ],
            {cwd: repository},
          ).pipe(TestClock.withLive);

          const config: RuntimeConfig = {
            account: 'local',
            agentContextHome: home,
            agentId: 'threadnote',
            manifestPath,
            user: 'tester',
          };
          const metadata: MemoryMetadata = {
            kind: 'durable',
            memoryId: 'tn_wrap_heal',
            project: 'threadnote',
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'test',
            status: 'active',
            timestamp: '2026-09-10T00:00:00.000Z',
            topic: 'wrap-heal',
            visibility: 'personal',
          };
          const body = 'Wrap heal must cite after in-process index.';
          const content = formatMemoryDocument('MEMORY', metadata, body);
          const store = yield* ResourceStore;
          const location = {account: config.account, home, user: config.user} as const;
          yield* store.write(location, WRAP_HEAL_URI, content, {mode: 'create'});
          yield* stageDeferredCodeAnchorIntent(config, {
            memoryContent: content,
            memoryMetadata: metadata,
            memoryUri: WRAP_HEAL_URI,
            request: {
              callerCwd: repository,
              codeRefs: ['src/heal.ts'],
              recovery: {
                code: 'ready-graph-unavailable',
                indexingStarted: false,
                observedGraph: {freshness: 'stale', readySnapshot: 'absent', stale: true},
                preparation: {
                  action: 'index-current-graph',
                  arguments: [],
                  command: 'threadnote graph index --no-vectors',
                  target: 'callerCwd',
                },
                recovery: 'prepare-current-graph',
                retryCondition: 'after-current-graph-ready',
                retryable: true,
                type: 'memory-code-citation-capture-recovery',
                version: 1,
              },
            },
          });
          const pendingRoot = path.join(
            home,
            'data',
            'local',
            'user',
            'tester',
            'private',
            'deferred-code-anchors',
            'v1',
          );
          expect(
            (yield* fs.readDirectory(pendingRoot, {recursive: true})).filter(name =>
              isDeferredCodeAnchorIntentFilename(path.basename(name)),
            ),
          ).toHaveLength(1);

          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: home}).pipe(TestClock.withLive);

          expect(
            (yield* fs.readDirectory(pendingRoot, {recursive: true})).filter(name =>
              isDeferredCodeAnchorIntentFilename(path.basename(name)),
            ),
          ).toEqual([]);
          const finalized = parseMemoryDocument(WRAP_HEAL_URI, yield* store.read(location, WRAP_HEAL_URI));
          expect(finalized?.body).toBe(body);
          expect(finalized?.metadata).toMatchObject({
            codeCitations: [{path: 'src/heal.ts'}],
            memoryId: metadata.memoryId,
            status: metadata.status,
          });
        }),
      ).pipe(withTesterUser, provideTestLayer(ApplicationLayer)),
    60_000,
  );
});

function withTesterUser<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    return yield* effect.pipe(
      Effect.provideService(
        SystemInfo,
        SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), THREADNOTE_USER: 'tester'}),
        }),
      ),
    );
  });
}

function indexer(overrides: Partial<CodeGraphIndexerShape>): CodeGraphIndexerShape {
  return {
    ensureCommit: () => Effect.die(TestError.make({message: 'unexpected ensureCommit'})),
    index: () => Effect.die(TestError.make({message: 'unexpected index'})),
    ...overrides,
  };
}

function indexSummary(): CodeGraphIndexSummary {
  return {
    diagnostics: [],
    durationMs: 1,
    identity: {
      caseMode: 'sensitive',
      checkoutId: 'a'.repeat(64),
      displayName: 'fixture',
      gitCommonDirectory: '/repo/.git',
      headCommit: 'b'.repeat(40),
      objectFormat: 'sha1',
      repoRoot: '/repo',
      repositoryId: 'c'.repeat(64),
      worktreeId: 'd'.repeat(64),
    },
    reusedFiles: 0,
    skippedFiles: 0,
    snapshot: {
      commit: 'b'.repeat(40),
      completedAt: '2026-09-10T00:00:00.000Z',
      dirty: false,
      edgeCount: 0,
      extractorSet: 'e'.repeat(64),
      fileCount: 1,
      id: `cgsn_${'1'.repeat(40)}`,
      repositoryId: 'c'.repeat(64),
      state: 'ready',
      symbolCount: 1,
      worktreeId: 'd'.repeat(64),
    },
  };
}
