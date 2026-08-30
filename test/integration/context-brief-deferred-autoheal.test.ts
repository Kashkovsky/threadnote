import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {retrieveContextBriefCodeLinkedMemoryEvidence} from '../../src/context_brief/memory_evidence.js';
import {planContextBrief} from '../../src/context_brief/planner.js';
import {runCommandEffect} from '../../src/effect/command.js';
import {ResourceStore} from '../../src/effect/resource-store.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  isDeferredCodeAnchorIntentFilename,
  stageDeferredCodeAnchorIntent,
} from '../../src/memory/deferred_code_anchor.js';
import {MEMORY_SCHEMA_VERSION} from '../../src/memory/code_citation.js';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '../../src/memory/document.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('Context Brief deferred code-anchor recovery', () => {
  effectIt.effect(
    'returns the backlink in the first brief after a direct graph publication bypassed the CLI hook',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-brief-autoheal-'});
          const repository = path.join(root, 'repository');
          const home = path.join(root, 'home');
          const manifestPath = path.join(home, 'seed-manifest.yaml');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.makeDirectory(home, {recursive: true});
          yield* fs.writeFileString(
            path.join(repository, 'src', 'index.ts'),
            'export function deferredBacklinkTarget(): string { return "ready"; }\n',
          );
          yield* fs.writeFileString(path.join(repository, 'package.json'), '{"name":"autoheal-fixture"}\n');
          yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
          yield* runCommandEffect('git', ['init', '--quiet'], {cwd: repository});
          yield* runCommandEffect('git', ['add', '.'], {cwd: repository});
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
          );

          const config: RuntimeConfig = {
            account: 'local',
            agentContextHome: home,
            agentId: 'threadnote',
            manifestPath,
            user: 'tester',
          };
          const memoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/context-brief-autoheal.md';
          const metadata: MemoryMetadata = {
            kind: 'durable',
            memoryId: 'tn_context_brief_autoheal',
            project: 'threadnote',
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'test',
            status: 'active',
            timestamp: '2026-08-30T00:00:00.000Z',
            topic: 'context-brief-autoheal',
            visibility: 'personal',
          };
          const body = 'The deferred backlink must appear in the first post-ready Context Brief.';
          const content = formatMemoryDocument('MEMORY', metadata, body);
          yield* stageDeferredCodeAnchorIntent(config, {
            memoryContent: content,
            memoryMetadata: metadata,
            memoryUri,
            request: {
              callerCwd: repository,
              codeRefs: ['src/index.ts'],
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
          const store = yield* ResourceStore;
          const location = {account: config.account, home, user: config.user} as const;
          yield* store.write(location, memoryUri, content, {mode: 'create'});

          // The service-level indexer deliberately bypasses the CLI graph-index
          // opportunity, leaving the consumer-side missed-wakeup fallback to prove.
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: home});
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

          const plan = planContextBrief({
            codeRefs: ['src/index.ts'],
            scope: {callerCwd: repository, kind: 'repository'},
            task: 'Find the decision attached to deferredBacklinkTarget.',
          });
          const first = yield* retrieveContextBriefCodeLinkedMemoryEvidence(config, plan.codeAnchors);
          expect(first.codeAnchorCoverage).toEqual({complete: true, matchedMemories: 1, requested: 1, resolved: 1});
          expect(first.candidates).toMatchObject([
            {
              codeLinkMatches: [{anchorOrdinal: 0, anchorPath: 'src/index.ts', matchKind: 'file-path'}],
              uri: memoryUri,
            },
          ]);
          expect(
            (yield* fs.readDirectory(pendingRoot, {recursive: true})).filter(name =>
              isDeferredCodeAnchorIntentFilename(path.basename(name)),
            ),
          ).toEqual([]);
          const finalized = parseMemoryDocument(memoryUri, yield* store.read(location, memoryUri));
          expect(finalized?.body).toBe(body);
          expect(finalized?.metadata).toMatchObject({
            codeCitations: [{path: 'src/index.ts'}],
            memoryId: metadata.memoryId,
            status: metadata.status,
            timestamp: metadata.timestamp,
            visibility: metadata.visibility,
          });

          const second = yield* retrieveContextBriefCodeLinkedMemoryEvidence(config, plan.codeAnchors);
          expect(second.candidates.map(candidate => candidate.uri)).toEqual([memoryUri]);
          expect(
            (yield* fs.readDirectory(pendingRoot, {recursive: true})).filter(name =>
              isDeferredCodeAnchorIntentFilename(path.basename(name)),
            ),
          ).toEqual([]);
        }),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );
});
