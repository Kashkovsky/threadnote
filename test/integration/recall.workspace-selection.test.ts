import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {loadRecallIndexData} from '../../src/recall/index.js';
import {prepareRecallSections} from '../../src/recall/runtime.js';

function memoryContent(topic: string, workspaceScope: string | undefined, body: string): string {
  return [
    'MEMORY',
    'kind: durable',
    'status: active',
    'project: monorepo',
    `topic: ${topic}`,
    ...(workspaceScope === undefined ? [] : [`workspace_scope: ${workspaceScope}`]),
    'source_agent_client: integration-test',
    'timestamp: 2026-08-20T00:00:00.000Z',
    '',
    body,
  ].join('\n');
}

function handoffContent(topic: string, branch: string, timestamp: string): string {
  return [
    'MEMORY',
    'kind: handoff',
    'status: active',
    'project: monorepo',
    `topic: ${topic}`,
    'source_agent_client: integration-test',
    `timestamp: ${timestamp}`,
    '',
    'repo: monorepo',
    `branch: ${branch}`,
    'task: Continue the current branch handoff feature implementation.',
  ].join('\n');
}

effectIt.effect(
  'sources late package and repo-wide targets before limiting misleading scope-text siblings',
  () => {
    let home: string | undefined;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      home = yield* fs.makeTempDirectory({prefix: 'threadnote-workspace-selection-'});
      const memoryRoot = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'projects', 'monorepo');
      yield* fs.makeDirectory(memoryRoot, {recursive: true});
      const localNoise = Array.from({length: 420}, (_unused, index) => ({
        content: memoryContent(`local-noise-${index}`, 'apps/search', 'Unrelated package-local operational note.'),
        filename: `local-${String(index).padStart(3, '0')}.md`,
      }));
      const topicalSiblings = Array.from({length: 125}, (_unused, index) => ({
        content: memoryContent(
          'checkout-retry-contract',
          `apps/shadow-${index}`,
          'Checkout retry contract. Checkout retry contract. Checkout retry contract uses bounded attempts.',
        ),
        filename: `sibling-${String(index).padStart(3, '0')}.md`,
      }));
      const packageTargetFilename = 'zy-current-package-target.md';
      const repoWideTargetFilename = 'zz-repo-wide-target.md';
      yield* Effect.forEach(
        [
          ...localNoise,
          ...topicalSiblings,
          {
            content: memoryContent(
              'package-retry-policy',
              'apps/search',
              'The package uses a bounded checkout retry contract.',
            ),
            filename: packageTargetFilename,
          },
          {
            content: memoryContent(
              'package-retry-policy',
              undefined,
              'The package uses a bounded checkout retry contract.',
            ),
            filename: repoWideTargetFilename,
          },
        ],
        entry => fs.writeFileString(path.join(memoryRoot, entry.filename), entry.content),
        {concurrency: 32, discard: true},
      );

      const config = {account: 'local', agentContextHome: home, user: 'me'};
      const query = 'checkout retry contract';
      const prepared = yield* prepareRecallSections(config, {
        allowExactRescue: true,
        exactMatches: [],
        feedbackQuery: query,
        includeInactive: false,
        limit: 5,
        passes: [],
        project: 'monorepo',
        query,
        readRecords: () => Effect.succeed([]),
        semanticResult: Option.none(),
        workspaceScope: 'apps/search',
      });
      const packageTargetUri = `threadnote://user/me/memories/durable/projects/monorepo/${packageTargetFilename}`;
      const repoWideTargetUri = `threadnote://user/me/memories/durable/projects/monorepo/${repoWideTargetFilename}`;
      const globalTopical = yield* loadRecallIndexData(config, {
        includeInactive: false,
        limit: 100,
        query,
      });

      expect(globalTopical.candidates.map(candidate => candidate.uri)).not.toContain(packageTargetUri);
      expect(globalTopical.candidates.map(candidate => candidate.uri)).not.toContain(repoWideTargetUri);
      const preparedUris = prepared.ranked.map(result => result.uri);
      expect(preparedUris).toEqual(expect.arrayContaining([packageTargetUri, repoWideTargetUri]));
      expect(preparedUris.indexOf(packageTargetUri)).toBeLessThan(preparedUris.indexOf(repoWideTargetUri));
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (!home) return;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(home, {force: true, recursive: true}).pipe(Effect.catch(() => Effect.void));
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    );
  },
  30_000,
);

effectIt.effect(
  'admits a custom-topic handoff by its recorded branch beyond a full sibling preselection window',
  () => {
    let home: string | undefined;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      home = yield* fs.makeTempDirectory({prefix: 'threadnote-branch-selection-'});
      const handoffRoot = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'handoffs', 'active', 'monorepo');
      yield* fs.makeDirectory(handoffRoot, {recursive: true});
      const siblings = Array.from({length: 125}, (_unused, index) => ({
        content: handoffContent(
          `current-branch-latest-handoff-durable-feature-memory-${index}`,
          `feature/shadow-${index}`,
          '2026-08-20T00:00:00.000Z',
        ),
        filename: `sibling-${String(index).padStart(3, '0')}.md`,
      }));
      const targetFilename = 'zz-recorded-selection.md';
      yield* Effect.forEach(
        [
          ...siblings,
          {
            content: handoffContent(
              'current-branch-latest-handoff-durable-feature-memory-target',
              'feature/search-recall',
              '2026-07-01T00:00:00.000Z',
            ),
            filename: targetFilename,
          },
        ],
        entry => fs.writeFileString(path.join(handoffRoot, entry.filename), entry.content),
        {concurrency: 32, discard: true},
      );

      const config = {account: 'local', agentContextHome: home, user: 'me'};
      const query = 'current branch latest handoff durable feature memory';
      const targetUri = `threadnote://user/me/memories/handoffs/active/monorepo/${targetFilename}`;
      const globalTopical = yield* loadRecallIndexData(config, {
        includeInactive: false,
        limit: 100,
        query,
      });
      const branchSupplemental = yield* loadRecallIndexData(config, {
        includeInactive: false,
        limit: 100,
        query: `${query} feature/search-recall`,
      });
      const prepared = yield* prepareRecallSections(config, {
        allowExactRescue: true,
        exactMatches: [],
        feedbackQuery: query,
        includeInactive: false,
        limit: 5,
        passes: [],
        project: 'monorepo',
        query,
        readRecords: () => Effect.succeed([]),
        semanticResult: Option.none(),
        workspaceBranch: 'feature/search-recall',
      });

      expect(globalTopical.candidates.map(candidate => candidate.uri)).not.toContain(targetUri);
      const sourcedTarget = branchSupplemental.candidates.find(candidate => candidate.uri === targetUri);
      expect(sourcedTarget?.fields?.topic).toBe('current-branch-latest-handoff-durable-feature-memory-target');
      expect(sourcedTarget?.text).toMatch(/^branch: feature\/search-recall$/m);
      expect(prepared.ranked[0]?.uri).toBe(targetUri);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (!home) return;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(home, {force: true, recursive: true}).pipe(Effect.catch(() => Effect.void));
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    );
  },
  30_000,
);
