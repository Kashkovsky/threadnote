import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {CodeGraphQueryService} from '../../src/code_graph/query.js';
import type {CodeGraphStatus} from '../../src/code_graph/types.js';
import {createCodeGraphWorksetRoutingProjection} from '../../src/code_graph/workset_catalog/projection.js';
import {
  publishCodeGraphWorksetCatalogGeneration,
  registerCodeGraphQualifiedRef,
  stageCodeGraphWorksetCatalogGeneration,
} from '../../src/code_graph/workset_catalog/store.js';
import {CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION} from '../../src/code_graph/workset_catalog/types.js';
import {codeGraphWorksetManifestDigest} from '../../src/code_graph/workset_catalog/workset.js';
import {resolveCodeGraphQualifiedRefTargets} from '../../src/code_graph/workset_query_v2.js';
import {SystemInfo} from '../../src/effect/system.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('batched repository-qualified reference routing', () => {
  effectIt.effect('probes only the caller and cited members of a current published generation', () => {
    const repositoriesByCwd = new Map<string, string>();
    let statusCalls = 0;
    const query = CodeGraphQueryService.of({
      status: (_home: string, cwd: string) =>
        Effect.sync(() => {
          statusCalls += 1;
          return status(cwd, repositoriesByCwd.get(cwd)!);
        }),
    } as unknown as Parameters<typeof CodeGraphQueryService.of>[0]);

    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-qualified-ref-batch-'});
        const home = path.join(root, 'home');
        yield* fs.makeDirectory(home, {recursive: true});
        const projects = Array.from({length: 128}, (_, index) => {
          const cwd = path.join(root, `project-${index}`);
          const repositoryId = index.toString(16).padStart(64, '0');
          repositoriesByCwd.set(cwd, repositoryId);
          return {cwd, index, repositoryId};
        });
        yield* Effect.forEach(projects, project => fs.makeDirectory(project.cwd, {recursive: true}), {concurrency: 16});
        const manifestPath = path.join(home, 'seed-manifest.yaml');
        yield* fs.writeFileString(
          manifestPath,
          [
            'version: 1',
            'projects:',
            ...projects.flatMap(project => [
              `  - name: project-${project.index}`,
              `    path: ${JSON.stringify(project.cwd)}`,
              `    uri: threadnote://resources/repos/project-${project.index}`,
              '    seed: []',
            ]),
            'worksets:',
            '  - name: citation-routing',
            '    projects:',
            '      - project-5',
            '      - project-77',
            '',
          ].join('\n'),
        );
        const config: RuntimeConfig = {
          account: 'test',
          agentContextHome: home,
          agentId: 'test-agent',
          manifestPath,
          user: 'test-user',
        };
        const routedProjects = [projects[5]!, projects[77]!].map(project => ({
          name: `project-${project.index}`,
          path: project.cwd,
          seed: [] as const,
          uri: `threadnote://resources/repos/project-${project.index}`,
        }));
        const workset = {name: 'citation-routing', projects: routedProjects, unresolvedProjects: [] as const};
        const staged = yield* catalogTestEffect(
          stageCodeGraphWorksetCatalogGeneration(home, {
            manifestDigest: codeGraphWorksetManifestDigest(workset),
            members: routedProjects.map((project, index) => ({
              projection: routingProjection(projects[index === 0 ? 5 : 77]!.repositoryId, index),
              repositoryKey: project.name,
            })),
            worksetName: workset.name,
          }),
        );
        yield* catalogTestEffect(
          publishCodeGraphWorksetCatalogGeneration(home, {
            generationId: staged.id,
            worksetName: workset.name,
          }),
        );
        const first = yield* catalogTestEffect(
          registerCodeGraphQualifiedRef(home, {
            nodeId: `cgs_${'a'.repeat(32)}`,
            repositoryId: projects[5]!.repositoryId,
          }),
        );
        const second = yield* catalogTestEffect(
          registerCodeGraphQualifiedRef(home, {
            nodeId: `cgs_${'b'.repeat(32)}`,
            repositoryId: projects[77]!.repositoryId,
          }),
        );

        const resolved = yield* resolveCodeGraphQualifiedRefTargets(
          config,
          [first.ref, second.ref, first.ref],
          projects[0]!.cwd,
        );

        expect(resolved.map(target => target.cwd)).toEqual([projects[5]!.cwd, projects[77]!.cwd, projects[5]!.cwd]);
        expect(statusCalls).toBe(3);
      }).pipe(
        provideTestLayer(
          Layer.mergeAll(BunServices.layer, SystemInfo.layer, Layer.succeed(CodeGraphQueryService, query)),
        ),
      ),
    );
  });
});

function catalogTestEffect<A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> {
  // The real platform layer is supplied by the enclosing Effect example; the
  // catalog API currently exposes a deliberately broad inferred environment.
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- narrow the fully provided test boundary
  return effect as Effect.Effect<A, E>;
}

function routingProjection(repositoryId: string, seed: number) {
  const digest = (value: string) => sha256HexSync(`${seed}:${value}`);
  return createCodeGraphWorksetRoutingProjection({
    checkoutId: digest('checkout'),
    commitId: digest('commit').slice(0, 40),
    componentCount: 1,
    extractorGeneration: 13,
    projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
    repositoryId,
    snapshotDigest: digest('snapshot-digest'),
    snapshotId: `cgsn_${digest('snapshot').slice(0, 40)}`,
    symbols: [
      {
        exported: true,
        kind: 'function',
        language: 'typescript',
        lookupKeys: [`fixture.symbol.${seed}`],
        name: `symbol${seed}`,
        nodeId: `cgs_${digest('node').slice(0, 40)}`,
        path: `src/symbol-${seed}.ts`,
        qualifiedName: `fixture.symbol${seed}`,
        span: {column: 1, endColumn: 10, endLine: 1, line: 1},
        terms: [{term: `symbol-${seed}`, weight: 4}],
      },
    ],
    worktreeId: digest('worktree'),
  });
}

function status(cwd: string, repositoryId: string): CodeGraphStatus {
  return {
    databasePath: `${cwd}/graph.sqlite`,
    freshness: 'current',
    identity: {
      caseMode: 'sensitive',
      checkoutId: `checkout-${repositoryId}`,
      displayName: repositoryId,
      gitCommonDirectory: `${cwd}/.git`,
      headCommit: 'c'.repeat(40),
      objectFormat: 'sha1',
      repoRoot: cwd,
      repositoryId,
      worktreeId: repositoryId,
    },
    languagePacks: [],
    readySnapshot: {
      commit: 'c'.repeat(40),
      dirty: false,
      edgeCount: 0,
      extractorSet: 'native-code-graph-13',
      fileCount: 1,
      id: `cgsn_${repositoryId.slice(0, 40)}`,
      repositoryId,
      state: 'ready',
      symbolCount: 1,
      worktreeId: repositoryId,
    },
    stale: false,
  };
}
