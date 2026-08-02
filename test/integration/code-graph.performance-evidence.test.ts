import {Effect, FileSystem} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assertPerformanceControlSet,
  assertManagerVisualizationBounds,
  benchmarkConcurrentWorktreeIsolation,
  benchmarkManagerPerformance,
  benchmarkStorageEnvironment,
  privacySafeExternalControlPath,
  privacySafeExternalControlQuery,
  publicGitHubRepositoryEvidence,
  retainedExternalControlEvidence,
  type ExternalQueryControlResult,
  type ExternalRepositoryQueryControl,
} from '../../scripts/benchmark-code-graph.js';
import {prepareCodeGraphFixture} from '../../scripts/code-graph-fixture.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

const PERFORMANCE_CONTROLS = [
  {expectedLanguage: 'java', expectedPath: 'src/Main.java', query: 'Main'},
  {expectedLanguage: 'kotlin', expectedPath: 'src/App.kt', query: 'App'},
  {expectedLanguage: 'typescript', expectedPath: 'src/index.ts', query: 'indexSymbol'},
  {expectedLanguage: 'bazel-build', expectedPath: 'build/rules.bzl', query: 'buildRule'},
] as const satisfies readonly ExternalRepositoryQueryControl[];

describe('external performance evidence', () => {
  it('normalizes only public GitHub identities and privacy-safe controls', () => {
    expect(publicGitHubRepositoryEvidence('https://github.com/JetBrains/intellij-community.git')).toEqual({
      name: 'JetBrains/intellij-community',
      url: 'https://github.com/JetBrains/intellij-community',
    });
    expect(publicGitHubRepositoryEvidence('git@github.com:JetBrains/intellij-community.git')).toEqual({
      name: 'JetBrains/intellij-community',
      url: 'https://github.com/JetBrains/intellij-community',
    });
    expect(publicGitHubRepositoryEvidence('ssh://git@github.com/JetBrains/intellij-community.git')).toEqual({
      name: 'JetBrains/intellij-community',
      url: 'https://github.com/JetBrains/intellij-community',
    });
    expect(() => publicGitHubRepositoryEvidence('https://token@github.com/owner/repository.git')).toThrow(
      'public GitHub repository URL',
    );
    expect(() => publicGitHubRepositoryEvidence('/local/private/repository')).toThrow('public GitHub repository URL');
    expect(privacySafeExternalControlQuery('  ProgressManager  ')).toBe('ProgressManager');
    expect(privacySafeExternalControlPath('src/main.ts')).toBe('src/main.ts');
    expect(() => privacySafeExternalControlQuery('customer secret phrase')).toThrow('privacy-safe public symbol');
    expect(() => privacySafeExternalControlPath('../outside.ts')).toThrow('repository-relative paths');
    for (const sensitive of [
      '/Users/alice/private-repository',
      'C:/Users/alice/private-repository',
      `ghp_${'a'.repeat(32)}`,
      `sk-proj-${'a'.repeat(32)}`,
    ]) {
      expect(() => privacySafeExternalControlQuery(sensitive)).toThrow('privacy-safe public symbol');
      expect(() => privacySafeExternalControlPath(sensitive)).toThrow('repository-relative paths');
    }
    expect(privacySafeExternalControlPath('src/home/component.ts')).toBe('src/home/component.ts');
  });

  it('normalizes equivalent public GitHub transports and repository-relative paths', () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,20}$/);
    fc.assert(
      fc.property(segment, segment, (owner, repository) => {
        const expected = {name: `${owner}/${repository}`, url: `https://github.com/${owner}/${repository}`};
        expect(publicGitHubRepositoryEvidence(`https://github.com/${owner}/${repository}.git`)).toEqual(expected);
        expect(publicGitHubRepositoryEvidence(`git@github.com:${owner}/${repository}.git`)).toEqual(expected);
        expect(publicGitHubRepositoryEvidence(`ssh://git@github.com/${owner}/${repository}.git`)).toEqual(expected);
      }),
    );
    fc.assert(
      fc.property(
        fc.array(
          segment.filter(value => value !== '.' && value !== '..'),
          {minLength: 1, maxLength: 8},
        ),
        segments => {
          const portable = segments.join('/');
          expect(privacySafeExternalControlPath(portable)).toBe(portable);
          expect(privacySafeExternalControlPath(segments.join('\\'))).toBe(portable);
        },
      ),
    );
  });

  it('requires the release evidence language set and emits deterministic stable-node controls', () => {
    assertPerformanceControlSet(PERFORMANCE_CONTROLS);
    expect(() => assertPerformanceControlSet(PERFORMANCE_CONTROLS.slice(0, 3))).toThrow('exactly java, kotlin');
    expect(() => assertPerformanceControlSet([...PERFORMANCE_CONTROLS, PERFORMANCE_CONTROLS[0]])).toThrow(
      'exactly java, kotlin',
    );
    const results: readonly ExternalQueryControlResult[] = PERFORMANCE_CONTROLS.map((control, index) => ({
      digest: `${index}`.repeat(64),
      durationMilliseconds: index + 1,
      expectedMatches: 1,
      language: control.expectedLanguage,
      returnedNodes: 2,
      stableNodeId: `cgs_${String(index + 1).repeat(32)}`,
    }));
    expect(JSON.parse(retainedExternalControlEvidence(PERFORMANCE_CONTROLS, results))).toEqual({
      bazel: {path: 'build/rules.bzl', query: 'buildRule', stableNodeId: `cgs_${'4'.repeat(32)}`},
      java: {path: 'src/Main.java', query: 'Main', stableNodeId: `cgs_${'1'.repeat(32)}`},
      kotlin: {path: 'src/App.kt', query: 'App', stableNodeId: `cgs_${'2'.repeat(32)}`},
      typescript: {path: 'src/index.ts', query: 'indexSymbol', stableNodeId: `cgs_${'3'.repeat(32)}`},
    });
  });

  it('reports only privacy-safe filesystem and storage-medium categories', async () => {
    const evidence = await Effect.runPromise(
      benchmarkStorageEnvironment(process.cwd()).pipe(Effect.provide(ApplicationLayer)),
    );
    expect(evidence.filesystem).toMatch(/^[a-z0-9._+-]+$/);
    expect(['rotational', 'solid-state', 'unknown', 'virtual-or-network']).toContain(evidence.medium);
  });

  it('rejects Manager responses that exceed or misreport their requested graph budget', () => {
    const limits = {edgeLimit: 1_500, nodeLimit: 500};
    const bounded = {edges: [], nodes: [], paging: {...limits, hasMore: false}};
    expect(() => assertManagerVisualizationBounds('bounded', bounded, limits)).not.toThrow();
    expect(() =>
      assertManagerVisualizationBounds(
        'too many nodes',
        {...bounded, nodes: Array.from({length: limits.nodeLimit + 1}, () => ({}) as never)},
        limits,
      ),
    ).toThrow('exceeded or misreported');
    expect(() =>
      assertManagerVisualizationBounds(
        'misreported paging',
        {...bounded, paging: {...bounded.paging, edgeLimit: limits.edgeLimit - 1}},
        limits,
      ),
    ).toThrow('exceeded or misreported');
  });

  it('measures real Manager catalog, visualization, detail, query, payload, and client render work', async () => {
    const evidence = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* prepareCodeGraphFixture('code-graph-v1');
          const indexer = yield* CodeGraphIndexer;
          const summary = yield* indexer.index({cwd: fixture.repository, threadnoteHome: fixture.home});
          return yield* benchmarkManagerPerformance(
            fixture.home,
            summary.identity.repositoryId,
            summary.snapshot.id,
            'exclusive file lock',
            2,
            1,
          );
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(evidence.catalogColdMilliseconds).toHaveLength(1);
    expect(evidence.catalogWarmMilliseconds).toHaveLength(2);
    expect(evidence.overviewColdMilliseconds).toHaveLength(1);
    expect(evidence.overviewWarmMilliseconds).toHaveLength(2);
    expect(evidence.detailColdMilliseconds).toHaveLength(1);
    expect(evidence.nodeDetailColdMilliseconds).toHaveLength(1);
    expect(evidence.queryMilliseconds).toHaveLength(2);
    expect(evidence.queryPayloadBytes).toHaveLength(2);
    expect(evidence.renderProxyMilliseconds).toHaveLength(2);
    expect(evidence.maxResponsePayloadBytes.every(bytes => bytes > 0)).toBe(true);
    expect(evidence).toMatchObject({
      edgeBudget: 1_500,
      nodeBudget: 500,
      snapshotBindingPassed: true,
      staleRequestCancellationPassed: true,
    });
  }, 30_000);

  it('indexes and reads two dirty linked worktrees concurrently without cross-contamination', async () => {
    const evidence = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-worktree-evidence-home-'});
          return yield* benchmarkConcurrentWorktreeIsolation(home);
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );
    expect(evidence).toMatchObject({
      indexedFiles: 2,
      isolationPassed: true,
      simultaneousWorktrees: 2,
      topology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home',
    });
    expect(evidence.durationMilliseconds).toBeGreaterThan(0);
  }, 30_000);
});
