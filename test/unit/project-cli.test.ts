import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {runCommandEffect} from '../../src/effect/command.js';
import {captureConsole} from '../../src/effect/console.js';
import {runCodeGraphScopeSet} from '../../src/effect/graph_scope_cli.js';
import {
  runProjectCreateCommand,
  runProjectDeleteCommand,
  runProjectListCommand,
  runProjectShowCommand,
  runProjectUpdateCommand,
} from '../../src/effect/project_cli.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {readManagerManifestProject, readManagerWorksetCatalog} from '../../src/manager/worksets.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

function projectFixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-project-cli-'});
    const home = path.join(root, 'home');
    const manifestPath = path.join(root, 'seed-manifest.yaml');
    const repository = path.join(root, 'repository');
    yield* fs.makeDirectory(home, {recursive: true});
    yield* fs.makeDirectory(repository, {recursive: true});
    yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
    yield* runCommandEffect('git', ['-C', repository, 'init', '-q', '-b', 'main']);
    const canonicalRepository = yield* fs.realPath(repository);
    return {
      config: {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath,
        user: 'project-cli-test',
      } satisfies RuntimeConfig,
      repository: canonicalRepository,
    };
  });
}

describe('project CLI', () => {
  effectIt.effect('creates multiple independently scoped projects for one monorepo root', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* projectFixture();
        const system = yield* SystemInfo;
        const created = yield* captureConsole(
          runCodeGraphScopeSet(fixture.config, {
            closure: 'dependencies',
            include: [],
            json: false,
            project: 'docs-web',
            roots: ['apps/docs'],
          }).pipe(
            Effect.provideService(SystemInfo, SystemInfo.of({...system, currentDirectory: () => fixture.repository})),
          ),
        );
        expect(created.output).toContain('Created project and graph scope for docs-web.');
        yield* captureConsole(
          runProjectCreateCommand(fixture.config, {
            json: false,
            name: 'docs-native',
            path: fixture.repository,
            seed: [],
          }),
        );
        yield* captureConsole(
          runCodeGraphScopeSet(fixture.config, {
            closure: 'dependencies',
            include: [],
            json: false,
            project: 'docs-native',
            roots: ['apps/docs-native'],
          }),
        );

        const web = yield* readManagerManifestProject(fixture.config, 'docs-web');
        const native = yield* readManagerManifestProject(fixture.config, 'docs-native');
        expect(web).toMatchObject({
          graph: {closure: 'dependencies', roots: ['apps/docs']},
          path: fixture.repository,
          uri: 'threadnote://resources/repos/docs-web',
        });
        expect(native).toMatchObject({
          graph: {closure: 'dependencies', roots: ['apps/docs-native']},
          path: fixture.repository,
          uri: 'threadnote://resources/repos/docs-native',
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('lists, shows, updates, renames, and deletes a Threadnote project', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* projectFixture();
        yield* captureConsole(
          runProjectCreateCommand(fixture.config, {
            json: false,
            name: 'Application UI',
            path: fixture.repository,
            seed: ['AGENTS.md'],
          }),
        );

        const listed = yield* captureConsole(runProjectListCommand(fixture.config, {json: true}));
        expect(JSON.parse(listed.output)).toMatchObject({
          projects: [{name: 'Application UI', path: fixture.repository}],
          version: 1,
        });
        const shown = yield* captureConsole(runProjectShowCommand(fixture.config, 'application ui', {json: true}));
        expect(JSON.parse(shown.output)).toMatchObject({
          project: {
            name: 'Application UI',
            seed: ['AGENTS.md'],
            uri: 'threadnote://resources/repos/application-ui',
          },
          version: 1,
        });

        yield* captureConsole(
          runProjectUpdateCommand(fixture.config, {
            clearSeed: false,
            json: false,
            name: 'Application Native',
            project: 'Application UI',
            seed: ['AGENTS.md', 'docs/**/*.md'],
          }),
        );
        expect(yield* readManagerManifestProject(fixture.config, 'Application Native')).toMatchObject({
          name: 'Application Native',
          seed: ['AGENTS.md', 'docs/**/*.md'],
          uri: 'threadnote://resources/repos/application-ui',
        });

        yield* captureConsole(
          runProjectDeleteCommand(fixture.config, {
            confirm: true,
            json: false,
            project: 'Application Native',
          }),
        );
        expect((yield* readManagerWorksetCatalog(fixture.config)).projects).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
