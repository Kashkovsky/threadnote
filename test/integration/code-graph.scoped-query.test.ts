import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {CodeGraphQueryService} from '../../src/code_graph/query.js';
import {prepareCodeGraphWorkset, inspectCodeGraphWorksetStatus} from '../../src/code_graph/workset_catalog/workset.js';
import {captureMemoryCodeCitations} from '../../src/memory/code_citation_capture.js';
import {
  readPublishedCodeGraphWorksetCatalogGeneration,
  registerCodeGraphQualifiedRef,
} from '../../src/code_graph/workset_catalog/store.js';
import {queryCodeGraphWorksetV2, resolveCodeGraphQualifiedRefTarget} from '../../src/code_graph/workset/query_v2.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('scoped graph retrieval', () => {
  effectIt.effect(
    'selects independent scoped views and discloses outside paths and equivalent old snapshots',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scope-query-'});
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scope-query-home-'});
        const write = (relative: string, body: string) =>
          fs
            .makeDirectory(path.dirname(path.join(root, relative)), {recursive: true})
            .pipe(Effect.andThen(fs.writeFileString(path.join(root, relative), body)));
        const git = (...args: string[]) => command.execute('git', ['-C', root, ...args]);
        yield* git('init', '-q');
        yield* git('config', 'user.name', 'Test');
        yield* git('config', 'user.email', 'test@example.test');
        yield* write('package.json', JSON.stringify({private: true, workspaces: ['apps/*']}));
        for (const name of ['a', 'b']) {
          yield* write(`apps/${name}/package.json`, JSON.stringify({name: `@fixture/${name}`}));
          yield* write(`apps/${name}/index.ts`, `export const value${name.toUpperCase()} = '${name}';\n`);
        }
        yield* write('apps/partial/package.json', JSON.stringify({name: '@fixture/partial'}));
        yield* write('apps/partial/tsconfig.json', JSON.stringify({references: [{path: '../missing'}]}));
        yield* write('apps/partial/index.ts', "export const partialValue = 'partial';\n");
        yield* git('add', '.');
        yield* git('commit', '-qm', 'fixture');
        const projects = ['a', 'b', 'partial'].map(name => ({
          name,
          path: root,
          seed: [],
          uri: `threadnote://resources/repos/${name}`,
          graph: {closure: 'dependencies' as const, roots: [`apps/${name}`]},
        }));
        const manifestPath = path.join(home, 'seed-manifest.yaml');
        yield* fs.writeFileString(
          manifestPath,
          JSON.stringify({
            version: 1,
            projects,
            worksets: [
              {name: 'both', projects: ['a', 'b']},
              {name: 'partial', projects: ['partial']},
            ],
          }),
        );
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const a = yield* indexer.index({cwd: root, project: projects[0], threadnoteHome: home, ensureVectors: false});
        const b = yield* indexer.index({cwd: root, project: projects[1], threadnoteHome: home, ensureVectors: false});
        yield* indexer.index({cwd: root, project: projects[2], threadnoteHome: home, ensureVectors: false});
        expect(a.snapshot.id).not.toBe(b.snapshot.id);
        const options = {
          cwd: root,
          project: 'a',
          manifestPath,
          threadnoteHome: home,
          refresh: false,
          requestMaintenance: false,
          strictFreshness: false,
        };
        const outside = yield* query.inspect({...options, operation: 'query', query: 'apps/b/index.ts'});
        expect(outside.nodes).toEqual([]);
        expect(outside.outsideProjectGraph).toMatchObject({state: 'outside-project-graph', paths: ['apps/b/index.ts']});
        const config = {account: 'test', agentId: 'test', user: 'test', agentContextHome: home, manifestPath};
        const workset = yield* prepareCodeGraphWorkset(config, 'both');
        expect(workset.state).toBe('ready');
        expect(workset.members.filter(member => member.state === 'ready')).toHaveLength(2);
        const published = yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'both');
        expect(published?.members).toMatchObject([
          {
            repositoryKey: 'a',
            scopeId: a.snapshot.scopeId,
            definitionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
            closureDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
            completeness: 'complete',
          },
          {
            repositoryKey: 'b',
            scopeId: b.snapshot.scopeId,
            definitionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
            closureDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
            completeness: 'complete',
          },
        ]);
        expect((yield* inspectCodeGraphWorksetStatus(config, 'both')).coverage.current).toBe(2);
        const partialWorkset = yield* prepareCodeGraphWorkset(config, 'partial');
        expect(partialWorkset.state).toBe('ready');
        const partialResult = yield* queryCodeGraphWorksetV2(config, {query: 'partialValue', worksetName: 'partial'});
        expect(partialResult.structuredContent.coverage.complete).toBe(false);
        expect(partialResult.structuredContent.repositories.partial.projectCoverage).toMatchObject({
          completeness: 'partial',
          project: 'partial',
        });
        yield* write('apps/b/index.ts', 'export const unrelatedChange = true;\n');
        yield* git('add', '.');
        yield* git('commit', '-qm', 'unrelated B');
        const status = yield* query.status(home, root, {project: 'a', manifestPath, requestMaintenance: false});
        expect(status.freshness).toBe('current');
        expect(status.readySnapshot?.id).toBe(a.snapshot.id);
        expect(status.projectCoverage).toMatchObject({
          project: 'a',
          kind: 'project',
          configuredRoots: ['apps/a'],
          reusedEquivalentSnapshot: true,
        });
        const result = yield* query.inspect({...options, operation: 'query', query: 'valueA'});
        expect(result.freshness).toBe('current');
        expect(result.nodes.some(node => node.path === 'apps/a/index.ts')).toBe(true);
        expect(result.nodes.some(node => node.path === 'apps/b/index.ts')).toBe(false);
        const node = result.nodes.find(node => node.path === 'apps/a/index.ts')!;
        const ref = yield* registerCodeGraphQualifiedRef(home, {
          repositoryId: result.repository.repositoryId,
          nodeId: node.id,
        });
        const target = yield* resolveCodeGraphQualifiedRefTarget(config, ref.ref, root, 'a');
        expect(target).toMatchObject({project: 'a', nodeId: node.id});
        const citation = yield* captureMemoryCodeCitations(config, {
          callerCwd: root,
          project: 'a',
          refs: ['apps/b/index.ts'],
        }).pipe(Effect.result);
        expect(citation).toMatchObject({failure: {failureCode: 'outside-project-graph'}});
        yield* fs.writeFileString(
          manifestPath,
          JSON.stringify({
            version: 1,
            projects: projects.map(project =>
              project.name === 'a' ? {...project, graph: {...project.graph, roots: ['apps/b']}} : project,
            ),
            worksets: [
              {name: 'both', projects: ['a', 'b']},
              {name: 'partial', projects: ['partial']},
            ],
          }),
        );
        const drifted = yield* query.status(home, root, {project: 'a', manifestPath, requestMaintenance: false});
        expect(drifted.readySnapshot).toBeUndefined();
        expect((yield* query.inspect({...options, operation: 'query', query: 'valueA'}).pipe(Effect.result))._tag).toBe(
          'Failure',
        );
        expect((yield* inspectCodeGraphWorksetStatus(config, 'both')).catalog.state).toBe('stale');
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );
});
