import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Exit, FileSystem, Path, Result, Scope} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {codeGraphWorksetCatalogLayout} from '../../src/code_graph/workset_catalog/layout.js';
import {withCodeGraphMaintenanceIntent} from '../../src/code_graph/maintenance_gate.js';
import type {RuntimeConfig} from '../../src/types.js';
import {
  handleManagerWorksetRequest,
  managerWorksetJobSummary,
  managerWorksetRequestAllowedDuringMaintenance,
  mutateManagerWorksetDefinition,
  readManagerWorksetCatalog,
  readManagerWorksetDefinition,
  type ManagerWorksetDefinitionMutation,
} from '../../src/manager_worksets.js';
import {managerWorksetRepositoryLabel, PrepareJobPanel} from '../../src/manager_worksets_view.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {runEffect} from '../helpers/effect-runtime.js';
import {startManagerTestServer} from '../helpers/manager-test-server.js';
import {TestError} from '../helpers/test-error.js';
import {execFileSync} from '../helpers/node-child-process.js';
import {existsSync} from '../helpers/node-fs.js';
import {mkdtemp, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';

interface WorksetFixture {
  readonly config: RuntimeConfig;
  readonly fs: FileSystem.FileSystem;
  readonly manifestPath: string;
  readonly path: Path.Path;
  readonly root: string;
}

function fixture(rawForRoot: (root: string) => string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-manager-worksets-'});
    const home = path.join(root, 'home');
    const manifestPath = path.join(root, 'threadnote.yaml');
    yield* fs.makeDirectory(home, {recursive: true});
    yield* fs.writeFileString(manifestPath, rawForRoot(root));
    return {
      config: {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath,
        user: 'manager-test',
      },
      fs,
      manifestPath,
      path,
      root,
    } satisfies WorksetFixture;
  });
}

function manifest(root: string, worksets = ''): string {
  return [
    '# manifest heading',
    'version: 1',
    'projects:',
    '  # project inventory note',
    '  - name: api',
    `    path: ${root}/api`,
    '    uri: threadnote://resources/repos/api',
    '    seed: []',
    '  - name: billing',
    `    path: ${root}/billing`,
    '    uri: threadnote://resources/repos/billing',
    '    seed: []',
    '  - name: worker',
    `    path: ${root}/worker`,
    '    uri: threadnote://resources/repos/worker',
    '    seed: []',
    worksets,
    '',
  ]
    .filter(line => line !== '')
    .join('\n')
    .concat('\n');
}

function updateMutation(
  revision: string,
  projects: readonly string[],
  overrides: Partial<ManagerWorksetDefinitionMutation & {readonly name: string; readonly workset: string}> = {},
): ManagerWorksetDefinitionMutation {
  return {
    description: 'Shared runtime',
    expectedRevision: revision,
    name: 'platform',
    operation: 'update',
    projects,
    workset: 'platform',
    ...overrides,
  } as ManagerWorksetDefinitionMutation;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}

describe('Manager Worksets manifest transactions', () => {
  effectIt.effect('creates the first workset without replacing unrelated manifest text', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root => manifest(root));
        const catalog = yield* readManagerWorksetCatalog(current.config);
        const result = yield* mutateManagerWorksetDefinition(current.config, {
          description: 'First shared workspace',
          expectedRevision: catalog.revision,
          name: 'platform',
          operation: 'create',
          projects: ['api', 'billing'],
        });
        const raw = yield* current.fs.readFileString(current.manifestPath);
        const definition = yield* readManagerWorksetDefinition(current.config, 'platform');

        expect(result.changed).toBe(true);
        expect(result.catalog.definitions).toContainEqual({
          description: 'First shared workspace',
          memberCount: 2,
          name: 'platform',
        });
        expect(definition.members.map(member => member.project)).toEqual(['api', 'billing']);
        expect(raw).toContain('# manifest heading');
        expect(raw).toContain('# project inventory note');
        expect(raw).toContain('worksets:');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('observes unborn and linked-worktree branches through bounded Git porcelain', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root => manifest(root));
        const api = current.path.join(current.root, 'api');
        const billing = current.path.join(current.root, 'billing');
        const billingPrimary = current.path.join(current.root, 'billing-primary');
        const outside = current.path.join(current.root, 'outside-git');
        yield* current.fs.makeDirectory(api, {recursive: true});
        yield* current.fs.makeDirectory(billingPrimary, {recursive: true});
        yield* Effect.sync(() => {
          git(api, ['init', '-q', '-b', 'feature/worksets']);
          git(billingPrimary, ['init', '-q', '-b', 'main']);
          git(billingPrimary, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '--allow-empty',
            '-qm',
            'fixture',
          ]);
          git(billingPrimary, ['branch', 'billing-linked']);
          git(billingPrimary, ['worktree', 'add', '-q', billing, 'billing-linked']);
        });
        yield* current.fs.makeDirectory(outside, {recursive: true});
        yield* current.fs.writeFileString(current.path.join(outside, 'HEAD'), 'ref: refs/heads/private-secret\n');
        yield* current.fs.makeDirectory(current.path.join(current.root, 'worker', '.git'), {recursive: true});
        yield* current.fs.symlink(
          current.path.join(outside, 'HEAD'),
          current.path.join(current.root, 'worker', '.git', 'HEAD'),
        );

        const catalog = yield* readManagerWorksetCatalog(current.config);
        const projects = new Map(catalog.projects.map(project => [project.name, project]));

        expect(projects.get('api')).toMatchObject({branch: 'feature/worksets', branchState: 'current'});
        expect(projects.get('billing')).toMatchObject({branch: 'billing-linked', branchState: 'current'});
        expect(projects.get('worker')).toMatchObject({branchState: 'missing'});
        expect(JSON.stringify(catalog)).not.toContain('private-secret');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves retained YAML comments while adding, removing, and canonicalizing members', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(
            root,
            [
              'worksets:',
              '  # workset note',
              '  - name: platform # name note',
              '    description: Shared runtime # description note',
              '    projects:',
              '      # API member note',
              '      - API # owns ingress',
              '      # billing member note',
              '      - billing # owns invoices',
              '      - worker # remove me',
            ].join('\n'),
          ),
        );
        const catalog = yield* readManagerWorksetCatalog(current.config);
        const result = yield* mutateManagerWorksetDefinition(
          current.config,
          updateMutation(catalog.revision, ['api', 'billing']),
        );
        const raw = yield* current.fs.readFileString(current.manifestPath);

        expect(result.changed).toBe(true);
        expect(raw).toContain('# manifest heading');
        expect(raw).toContain('# project inventory note');
        expect(raw).toContain('# workset note');
        expect(raw).toContain('name: platform # name note');
        expect(raw).toContain('description: Shared runtime # description note');
        expect(raw).toContain('# API member note');
        expect(raw).toContain('- api # owns ingress');
        expect(raw).toContain('# billing member note');
        expect(raw).toContain('- billing # owns invoices');
        expect(raw).not.toContain('remove me');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects stale revisions without changing manifest bytes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(
            root,
            'worksets:\n  - name: platform\n    description: Shared runtime\n    projects: [api, billing]',
          ),
        );
        const before = yield* current.fs.readFileString(current.manifestPath);
        const error = yield* mutateManagerWorksetDefinition(
          current.config,
          updateMutation('0'.repeat(64), ['api', 'worker']),
        ).pipe(Effect.flip);

        expect(error).toMatchObject({code: 'revision-conflict', status: 409});
        expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reports symlink manifests read-only and leaves their target untouched', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(root, 'worksets:\n  - name: platform\n    description: Shared runtime\n    projects: [api]'),
        );
        const target = current.path.join(current.root, 'authoritative.yaml');
        const linked = current.path.join(current.root, 'linked.yaml');
        const raw = yield* current.fs.readFileString(current.manifestPath);
        yield* current.fs.writeFileString(target, raw);
        yield* current.fs.symlink(target, linked);
        const config = {...current.config, manifestPath: linked};
        const catalog = yield* readManagerWorksetCatalog(config);
        const error = yield* mutateManagerWorksetDefinition(
          config,
          updateMutation(catalog.revision, ['api', 'billing']),
        ).pipe(Effect.flip);

        expect(catalog).toMatchObject({editability: {reason: 'manifest-symlink', state: 'read-only'}, readOnly: true});
        expect(error).toMatchObject({code: 'manifest-symlink', status: 409});
        expect(yield* current.fs.readFileString(target)).toBe(raw);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails closed on aliased workset ASTs and ambiguous case-insensitive names', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const aliased = yield* fixture(root =>
          manifest(
            root,
            ['shared: &shared', '  name: platform', '  projects: [api]', 'worksets: [*shared]'].join('\n'),
          ),
        );
        const aliasedBefore = yield* aliased.fs.readFileString(aliased.manifestPath);
        const aliasedCatalog = yield* readManagerWorksetCatalog(aliased.config);
        const aliasError = yield* mutateManagerWorksetDefinition(
          aliased.config,
          updateMutation(aliasedCatalog.revision, ['api', 'billing']),
        ).pipe(Effect.flip);

        expect(aliasedCatalog.editability).toEqual({reason: 'unsupported-workset-yaml', state: 'read-only'});
        expect(aliasError).toMatchObject({code: 'manifest-invalid', status: 409});
        expect(yield* aliased.fs.readFileString(aliased.manifestPath)).toBe(aliasedBefore);

        const duplicate = yield* fixture(root =>
          manifest(
            root,
            [
              '  - name: API',
              `    path: ${root}/ambiguous-api`,
              '    uri: threadnote://resources/repos/ambiguous-api',
              '    seed: []',
              'worksets:',
              '  - name: platform',
              '    projects: [api]',
              '  - name: PLATFORM',
              '    projects: [billing]',
            ].join('\n'),
          ),
        );
        const duplicateBefore = yield* duplicate.fs.readFileString(duplicate.manifestPath);
        const duplicateError = yield* readManagerWorksetCatalog(duplicate.config).pipe(Effect.flip);
        const definitionError = yield* readManagerWorksetDefinition(duplicate.config, 'platform').pipe(Effect.flip);

        expect(duplicateError).toMatchObject({code: 'manifest-invalid', status: 409});
        expect(definitionError).toMatchObject({code: 'manifest-invalid', status: 409});
        expect(yield* duplicate.fs.readFileString(duplicate.manifestPath)).toBe(duplicateBefore);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('treats anchored mutable workset scalars and sequences as read-only', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const anchored = [
          ['worksets:', '  - name: &workset-name platform', '    projects: [api]', 'copied_name: *workset-name'],
          [
            'worksets:',
            '  - name: platform',
            '    projects: &workset-projects [api]',
            'copied_projects: *workset-projects',
          ],
          [
            'worksets:',
            '  - name: platform',
            '    projects: [&workset-project api]',
            'copied_project: *workset-project',
          ],
        ];
        yield* Effect.forEach(
          anchored,
          lines =>
            Effect.gen(function* () {
              const current = yield* fixture(root => manifest(root, lines.join('\n')));
              const before = yield* current.fs.readFileString(current.manifestPath);
              const catalog = yield* readManagerWorksetCatalog(current.config);
              const error = yield* mutateManagerWorksetDefinition(
                current.config,
                updateMutation(catalog.revision, ['api', 'billing']),
              ).pipe(Effect.flip);

              expect(catalog.editability).toEqual({reason: 'unsupported-workset-yaml', state: 'read-only'});
              expect(error).toMatchObject({code: 'manifest-invalid', status: 409});
              expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
            }),
          {concurrency: 1, discard: true},
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects misleading long or whitespace-sensitive manifest names without truncating them', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const unsafeName of [' platform ', 'x'.repeat(257)]) {
          const current = yield* fixture(root =>
            manifest(root, `worksets:\n  - name: ${JSON.stringify(unsafeName)}\n    projects: [api]`),
          );
          const before = yield* current.fs.readFileString(current.manifestPath);
          const error = yield* readManagerWorksetCatalog(current.config).pipe(Effect.flip);

          expect(error).toMatchObject({code: 'manifest-invalid', status: 409});
          expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
        }

        const maximumName = 'w'.repeat(256);
        const supported = yield* fixture(root =>
          manifest(root, `worksets:\n  - name: ${maximumName}\n    projects: [api]`),
        );
        const catalog = yield* readManagerWorksetCatalog(supported.config);
        expect(catalog.definitions[0]?.name).toBe(maximumName);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('allows exactly one concurrent mutation for one optimistic revision', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root => manifest(root));
        const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
        const outcomes = yield* TestClock.withLive(
          Effect.all(
            ['platform-a', 'platform-b'].map(name =>
              mutateManagerWorksetDefinition(current.config, {
                expectedRevision: revision,
                name,
                operation: 'create' as const,
                projects: ['api'],
              }).pipe(Effect.result),
            ),
            {concurrency: 'unbounded'},
          ),
        );
        const catalog = yield* readManagerWorksetCatalog(current.config);

        expect(outcomes.filter(Result.isSuccess)).toHaveLength(1);
        expect(outcomes.filter(Result.isFailure)).toHaveLength(1);
        expect(catalog.definitions).toHaveLength(1);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('commits rename and delete while a corrupt derived catalog is only a cleanup warning', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(root, 'worksets:\n  - name: platform\n    description: Shared runtime\n    projects: [api]'),
        );
        const layout = codeGraphWorksetCatalogLayout(current.path, current.config.agentContextHome);
        yield* current.fs.makeDirectory(current.path.dirname(layout.databasePath), {recursive: true});
        yield* current.fs.writeFileString(layout.databasePath, 'not a sqlite catalog');
        const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
        const renamed = yield* mutateManagerWorksetDefinition(
          current.config,
          updateMutation(revision, ['api', 'billing'], {name: 'platform-services'}),
        );
        const afterRename = yield* current.fs.readFileString(current.manifestPath);

        expect(renamed.changed).toBe(true);
        expect(renamed.catalog.definitions.map(definition => definition.name)).toEqual(['platform-services']);
        expect(renamed.warnings.join(' ')).toContain('needs catalog repair before retirement');
        expect(afterRename).toContain('name: platform-services');
        expect(afterRename).toContain('projects: [ api, billing ]');

        const deleted = yield* mutateManagerWorksetDefinition(current.config, {
          confirm: true,
          expectedRevision: renamed.catalog.revision,
          operation: 'delete',
          workset: 'platform-services',
        });
        const afterDelete = yield* current.fs.readFileString(current.manifestPath);

        expect(deleted.changed).toBe(true);
        expect(deleted.catalog.definitions).toEqual([]);
        expect(afterDelete).not.toContain('platform-services');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.prop(
    'keeps reorder-equivalent membership updates byte-stable',
    {order: fc.shuffledSubarray(['api', 'billing', 'worker'], {minLength: 3, maxLength: 3})},
    ({order}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const current = yield* fixture(root =>
            manifest(
              root,
              'worksets:\n  - name: platform\n    description: Shared runtime\n    projects: [api, billing, worker]',
            ),
          );
          const before = yield* current.fs.readFileString(current.manifestPath);
          const revision = (yield* readManagerWorksetCatalog(current.config)).revision;
          const result = yield* mutateManagerWorksetDefinition(current.config, updateMutation(revision, order));

          expect(result.changed).toBe(false);
          expect(yield* current.fs.readFileString(current.manifestPath)).toBe(before);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 12}},
  );
});

describe('Manager Worksets API and human labels', () => {
  it('routes Worksets only after auth and never cold-builds repository graphs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-manager-worksets-http-'));
    const config = {
      account: 'local',
      agentContextHome: join(root, 'home'),
      agentId: 'threadnote',
      manifestPath: join(root, 'threadnote.yaml'),
      user: 'manager-test',
    } satisfies RuntimeConfig;
    await writeFile(config.manifestPath, manifest(root));
    const server = await startManagerTestServer(config, 'workset-secret');
    const headers = {authorization: 'Bearer workset-secret'};
    try {
      expect((await fetch(`${server.url}/api/worksets`)).status).toBe(401);
      const catalogResponse = await fetch(`${server.url}/api/worksets`, {headers});
      const catalog = (await catalogResponse.json()) as {readonly revision: string};
      expect(catalogResponse.status).toBe(200);

      const createdResponse = await fetch(`${server.url}/api/worksets/definitions`, {
        body: JSON.stringify({
          expectedRevision: catalog.revision,
          name: 'platform',
          operation: 'create',
          projects: ['api', 'billing'],
        }),
        headers: {...headers, 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(createdResponse.status).toBe(200);
      const created = (await createdResponse.json()) as {readonly catalog: {readonly revision: string}};

      const definitionResponse = await fetch(`${server.url}/api/worksets/definition?workset=platform`, {headers});
      expect(definitionResponse.status).toBe(200);
      expect(await definitionResponse.json()).toMatchObject({
        members: [{project: 'api'}, {project: 'billing'}],
        name: 'platform',
      });

      const updatedResponse = await fetch(`${server.url}/api/worksets/definitions`, {
        body: JSON.stringify({
          description: 'Shared runtime services',
          expectedRevision: created.catalog.revision,
          name: 'platform',
          operation: 'update',
          projects: ['api'],
          workset: 'platform',
        }),
        headers: {...headers, 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(updatedResponse.status).toBe(200);
      const updated = (await updatedResponse.json()) as {readonly catalog: {readonly revision: string}};
      expect(
        await (await fetch(`${server.url}/api/worksets/definition?workset=platform`, {headers})).json(),
      ).toMatchObject({description: 'Shared runtime services', members: [{project: 'api'}]});

      const statusResponse = await fetch(`${server.url}/api/worksets/status?workset=platform`, {headers});
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({catalog: {state: 'missing'}, workset: 'platform'});

      const [definitionsDuringMaintenance, statusDuringMaintenance, jobsDuringMaintenance] = await runEffect(
        withCodeGraphMaintenanceIntent(
          config.agentContextHome,
          Effect.all(
            [
              Effect.promise(() => fetch(`${server.url}/api/worksets`, {headers})),
              Effect.promise(() => fetch(`${server.url}/api/worksets/status?workset=platform`, {headers})),
              Effect.promise(() => fetch(`${server.url}/api/worksets/jobs`, {headers})),
            ] as const,
            {concurrency: 'unbounded'},
          ),
        ),
      );
      expect(definitionsDuringMaintenance.status).toBe(200);
      expect(jobsDuringMaintenance.status).toBe(200);
      expect(statusDuringMaintenance.status).toBe(409);
      expect(await statusDuringMaintenance.json()).toMatchObject({code: 'maintenance-busy'});

      const queryResponse = await fetch(`${server.url}/api/worksets/query`, {
        body: JSON.stringify({query: 'checkout ownership', workset: 'platform'}),
        headers: {...headers, 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(queryResponse.status).toBe(409);
      expect(await queryResponse.json()).toMatchObject({code: 'catalog-missing'});
      expect(existsSync(join(config.agentContextHome, 'indexes', 'code-graph', 'repositories'))).toBe(false);

      const deletedResponse = await fetch(`${server.url}/api/worksets/definitions`, {
        body: JSON.stringify({
          confirm: true,
          expectedRevision: updated.catalog.revision,
          operation: 'delete',
          workset: 'platform',
        }),
        headers: {...headers, 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(deletedResponse.status).toBe(200);
      expect((await fetch(`${server.url}/api/worksets/definition?workset=platform`, {headers})).status).toBe(404);
    } finally {
      await server.close();
      await rm(root, {force: true, recursive: true});
    }
  });

  effectIt.effect('maps malformed or non-object JSON bodies to a pathless 400', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const jobScope = yield* Scope.Scope;
        const config = {
          account: 'local',
          agentContextHome: '/unused',
          agentId: 'threadnote',
          manifestPath: '/unused/manifest.yaml',
          user: 'manager-test',
        } satisfies RuntimeConfig;
        const failed = yield* handleManagerWorksetRequest({
          body: Effect.fail(new TestError('/private/parser/path')),
          config,
          contextKey: {},
          jobScope,
          method: 'POST',
          url: new URL('http://127.0.0.1/api/worksets/query'),
        });
        const nonObject = yield* handleManagerWorksetRequest({
          body: Effect.succeed([] as unknown as Record<string, unknown>),
          config,
          contextKey: {},
          jobScope,
          method: 'POST',
          url: new URL('http://127.0.0.1/api/worksets/query'),
        });

        expect(failed).toEqual({
          body: {code: 'invalid-json', error: 'Provide a JSON object request body.'},
          status: 400,
        });
        expect(nonObject).toEqual(failed);
        expect(JSON.stringify(failed)).not.toContain('/private');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('interrupts an active prepare when the Manager job scope closes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(root, 'worksets:\n  - name: platform\n    description: Shared runtime\n    projects: [api]'),
        );
        const contextKey = {};
        const readScope = yield* Scope.Scope;
        const jobScope = yield* Scope.make();
        const started = yield* Deferred.make<void>();
        const cleaned = yield* Deferred.make<void>();
        const startedResponse = yield* handleManagerWorksetRequest({
          body: Effect.succeed({workset: 'platform'}),
          config: current.config,
          contextKey,
          jobScope,
          method: 'POST',
          prepareWorkset: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(cleaned, undefined)),
            ),
          url: new URL('http://127.0.0.1/api/worksets/prepare'),
        });
        if (startedResponse === undefined) return yield* Effect.fail(new TestError('prepare route was not handled'));
        expect(startedResponse.status).toBe(202);
        const job = (startedResponse.body as {readonly job: {readonly id: string}}).job;
        yield* Deferred.await(started);

        yield* Scope.close(jobScope, Exit.void);
        yield* Deferred.await(cleaned);
        const detail = yield* handleManagerWorksetRequest({
          body: Effect.succeed({}),
          config: current.config,
          contextKey,
          jobScope: readScope,
          method: 'GET',
          url: new URL(`http://127.0.0.1/api/worksets/jobs/${job.id}`),
        });

        expect(detail).toMatchObject({
          body: {
            job: {
              progress: {
                message: 'Preparation stopped; refresh readiness to confirm whether an atomic publication completed.',
                phase: 'cancelled',
              },
              status: 'cancelled',
            },
          },
          status: 200,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('registers one Manager-lifetime finalizer while retaining only 32 completed jobs', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* fixture(root =>
          manifest(root, 'worksets:\n  - name: platform\n    description: Shared runtime\n    projects: [api]'),
        );
        const contextKey = {};
        const jobScope = yield* Scope.make();
        for (let index = 0; index < 33; index += 1) {
          const started = yield* handleManagerWorksetRequest({
            body: Effect.succeed({workset: 'platform'}),
            config: current.config,
            contextKey,
            jobScope,
            method: 'POST',
            prepareWorkset: (_config, workset) =>
              Effect.succeed({
                manifestDigest: 'd'.repeat(64),
                members: [],
                state: 'ready',
                type: 'code-graph-workset-prepare',
                version: 1,
                workset,
              }),
            url: new URL('http://127.0.0.1/api/worksets/prepare'),
          });
          if (started === undefined) return yield* Effect.fail(new TestError('prepare route was not handled'));
          const id = (started.body as {readonly job: {readonly id: string}}).job.id;
          yield* Effect.yieldNow;
          const detail = yield* handleManagerWorksetRequest({
            body: Effect.succeed({}),
            config: current.config,
            contextKey,
            jobScope,
            method: 'GET',
            url: new URL(`http://127.0.0.1/api/worksets/jobs/${id}`),
          });
          expect(detail).toMatchObject({body: {job: {status: 'completed'}}, status: 200});
          expect(jobScope.state._tag).toBe('Open');
          if (jobScope.state._tag === 'Open') expect(jobScope.state.finalizers.size).toBe(1);
        }
        const listed = yield* handleManagerWorksetRequest({
          body: Effect.succeed({}),
          config: current.config,
          contextKey,
          jobScope,
          method: 'GET',
          url: new URL('http://127.0.0.1/api/worksets/jobs'),
        });
        const listedJobs = (listed?.body as {readonly jobs: readonly unknown[]} | undefined)?.jobs;
        expect(listedJobs).toHaveLength(32);
        yield* Scope.close(jobScope, Exit.void);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('keeps only manifest and job operations available during graph maintenance', () => {
    expect(managerWorksetRequestAllowedDuringMaintenance('GET', '/api/worksets')).toBe(true);
    expect(managerWorksetRequestAllowedDuringMaintenance('GET', '/api/worksets/definition')).toBe(true);
    expect(managerWorksetRequestAllowedDuringMaintenance('GET', '/api/worksets/jobs')).toBe(true);
    expect(managerWorksetRequestAllowedDuringMaintenance('POST', '/api/worksets/jobs/cancel')).toBe(true);
    expect(managerWorksetRequestAllowedDuringMaintenance('GET', '/api/worksets/status')).toBe(false);
    expect(managerWorksetRequestAllowedDuringMaintenance('POST', '/api/worksets/prepare')).toBe(false);
    expect(managerWorksetRequestAllowedDuringMaintenance('POST', '/api/worksets/query')).toBe(false);
    expect(managerWorksetRequestAllowedDuringMaintenance('POST', '/api/worksets/context-brief')).toBe(false);
  });

  it('renders repository name, observed branch, and folder before opaque identifiers', () => {
    const definition = {
      configuredMembers: 1,
      members: [
        {
          branch: 'feature/worksets',
          branchState: 'current' as const,
          configured: true,
          folder: 'api-service',
          path: '/workspace/api-service',
          project: 'api',
        },
      ],
      name: 'platform',
      unresolvedMembers: 0,
    };
    expect(managerWorksetRepositoryLabel('api', definition)).toBe(
      'api · observed branch feature/worksets · api-service · /workspace/api-service',
    );
    expect(managerWorksetRepositoryLabel('a'.repeat(64))).toBe('Repository aaaaaaaa…');
  });

  it('renders terminal prepare receipts without repository or snapshot IDs as primary labels', () => {
    const repositoryId = 'b'.repeat(64);
    const snapshotId = `cgsn_${'c'.repeat(40)}-direct`;
    const job = {
      createdAt: '2026-08-12T12:00:00.000Z',
      error: 'No ready generation was published; review member receipts.',
      id: 'cgwj_example',
      progress: {completed: 2, message: 'Preparation finished without publishing.', phase: 'failed' as const, total: 2},
      result: {
        manifestDigest: 'd'.repeat(64),
        members: [
          {
            project: 'api',
            projectionDigest: 'e'.repeat(64),
            repositoryId,
            snapshotId,
            state: 'ready' as const,
            symbolCount: 42,
          },
          {project: 'worker', reason: 'index-failed' as const, state: 'failed' as const},
        ],
        state: 'failed' as const,
        type: 'code-graph-workset-prepare' as const,
        version: 1 as const,
        workset: 'platform',
      },
      status: 'failed' as const,
      workset: 'platform',
    };
    const markup = renderToStaticMarkup(
      createElement(PrepareJobPanel, {
        definition: {
          configuredMembers: 2,
          members: [
            {
              branch: 'main',
              branchState: 'current',
              configured: true,
              folder: 'api',
              path: '/workspace/api',
              project: 'api',
            },
            {
              branchState: 'missing',
              configured: true,
              folder: 'worker',
              path: '/workspace/worker',
              project: 'worker',
            },
          ],
          name: 'platform',
          unresolvedMembers: 0,
        },
        job,
        onCancel: () => undefined,
      }),
    );

    expect(markup).toContain('api');
    expect(markup).toContain('observed branch main');
    expect(markup).toContain('/workspace/api');
    expect(markup).toContain('worker');
    expect(markup).toContain('index-failed');
    expect(markup).not.toContain(repositoryId);
    expect(markup).not.toContain(snapshotId);
    expect(managerWorksetJobSummary(job)).not.toHaveProperty('result');
    expect(JSON.stringify(managerWorksetJobSummary(job))).not.toContain(repositoryId);
  });
});
