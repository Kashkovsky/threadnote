import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {getAgentAdapter} from '../../src/agent_integration/adapters.js';
import type {AgentAdapter} from '../../src/agent_integration/adapters/contract.js';
import {planAgentSurface} from '../../src/agent_integration/surfaces.js';
import {parseContextBriefRequestV1} from '../../src/context_brief/types.js';
import {captureConsole} from '../../src/effect/console.js';
import {sha256Hex} from '../../src/effect/digest.js';
import {ApplicationLayer, type ApplicationServices} from '../../src/effect/runtime.js';
import {getThreadnoteVersion} from '../../src/release/runtime_version.js';
import {recallIndexStatus} from '../../src/recall/index.js';
import {getRuntimeConfig} from '../../src/runtime.js';
import {runInitManifest} from '../../src/seeding.js';
import {
  parseSetupReceiptV1,
  SETUP_MAX_DURATION_MILLISECONDS,
  setupRecovery,
  type SetupReceiptOperationV1,
} from '../../src/setup/contract.js';
import {
  runSetupWith,
  SetupOperationError,
  type SetupOperationOutcome,
  type SetupOrchestratorDependencies,
} from '../../src/setup/index.js';
import {createSetupPlan, setupOperationDefinitions} from '../../src/setup/planner.js';
import {withSetupMutationLock} from '../../src/setup/lock.js';
import {
  agentSurfaceTargetMatches,
  productionSetupDependencies,
  resolveSetupRuntimeConfig,
  seedSetupProject,
  setupBriefIsSourceVerified,
  setupContextBriefRequest,
  setupRepositorySourceHash,
  setupSurfaceAction,
} from '../../src/setup/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {runOmpHooksInstall} from '../../src/omp_hooks.js';
import type {RuntimeConfig} from '../../src/types.js';
import {readLocalValueEvents} from '../../src/value_report/events.js';
import {runCommand} from '../../src/utils.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const run = <A, E>(effect: Effect.Effect<A, E, ApplicationServices>) => effect.pipe(provideTestLayer(ApplicationLayer));
const digest = 'a'.repeat(64);
const EXPECTED_SETUP_TASK =
  'Orient this agent to the current repository architecture, durable decisions, active handoffs, and next safe step.';

describe('setup contracts', () => {
  it('rejects excess receipt fields and invalid recovery references', () => {
    const receipt = validReceipt();
    expect(() => parseSetupReceiptV1({...receipt, privateContent: 'must not be stored'})).toThrow();
    expect(() =>
      parseSetupReceiptV1({...receipt, recovery: {resumeOperationIds: ['missing'], undoOperationIds: []}}),
    ).toThrow(/unknown operation/u);
  });

  it('accepts bounded long-running setup evidence and rejects durations beyond retention', () => {
    const receipt = validReceipt();
    expect(
      parseSetupReceiptV1({
        ...receipt,
        verification: {...receipt.verification, durationMilliseconds: SETUP_MAX_DURATION_MILLISECONDS},
      }).verification?.durationMilliseconds,
    ).toBe(SETUP_MAX_DURATION_MILLISECONDS);
    expect(() =>
      parseSetupReceiptV1({
        ...receipt,
        verification: {...receipt.verification, durationMilliseconds: SETUP_MAX_DURATION_MILLISECONDS + 1},
      }),
    ).toThrow();
  });

  it('derives resume and undo independently from status and proven setup ownership', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), {maxLength: 8, minLength: 1}), reversible => {
        const operations = reversible.map(
          (value, index) =>
            ({
              attempt: 1,
              id: `operation-${index}`,
              inputHash: digest,
              kind: 'manifest.ensure',
              ownership: 'setup-created',
              ownershipEvidence: 'successful-mutation',
              reversible: value,
              status: index % 2 === 0 ? 'applied' : 'pending',
            }) satisfies SetupReceiptOperationV1,
        );
        const recovery = setupRecovery(operations);
        expect(recovery.resumeOperationIds).toEqual(
          operations.filter(operation => operation.status === 'pending').map(operation => operation.id),
        );
        expect(recovery.undoOperationIds).toEqual(
          operations
            .filter(operation => operation.reversible)
            .map(operation => operation.id)
            .reverse(),
        );
      }),
      {numRuns: 100},
    );
  });

  it('only derives undo from an operation whose successful mutation recorded setup ownership', () => {
    const operation = {
      attempt: 2,
      id: 'surface:gemini-cli',
      inputHash: digest,
      kind: 'surface.ensure',
      ownership: 'preexisting',
      reversible: true,
      status: 'already-current',
    } satisfies SetupReceiptOperationV1;
    expect(setupRecovery([operation]).undoOperationIds).toEqual([]);
  });

  it('keeps capability-equivalent adapters on the same dependency-ordered operation shape', () => {
    const gemini = getAgentAdapter('gemini-cli')!;
    const qwen = getAgentAdapter('qwen-code')!;
    const shape = (adapter: typeof gemini) =>
      setupOperationDefinitions(adapter).map(operation => ({
        dependencyCount: operation.dependsOn.length,
        kind: operation.kind,
        reversible: operation.reversible,
      }));
    expect(shape(gemini)).toEqual(shape(qwen));
  });

  it('plans managed hooks only when the adapter declares an executable strategy', () => {
    const base = getAgentAdapter('gemini-cli')!;
    const managedCatalog = {
      ...base.catalog,
      capabilities: {...base.catalog.capabilities, hooks: {status: 'managed' as const}},
    };
    const withoutStrategy = {...base, catalog: managedCatalog} satisfies AgentAdapter;
    const withStrategy = {
      ...withoutStrategy,
      hooks: {client: 'claude' as const, kind: 'legacy-client' as const},
    } satisfies AgentAdapter;
    expect(setupOperationDefinitions(withoutStrategy).some(operation => operation.kind === 'surface.hooks')).toBe(
      false,
    );
    expect(setupOperationDefinitions(withStrategy).some(operation => operation.kind === 'surface.hooks')).toBe(true);
  });

  it('classifies surface actions without treating disabled or stale installs as current', () => {
    expect(setupSurfaceAction({detail: '', state: 'absent'})).toBe('install');
    expect(setupSurfaceAction({detail: '', state: 'current'})).toBe('reuse');
    expect(setupSurfaceAction({detail: '', state: 'disabled'})).toBe('repair');
    expect(setupSurfaceAction({detail: '', state: 'stale'})).toBe('repair');
    expect(setupSurfaceAction({detail: '', state: 'manual'})).toBe('unsupported');
  });

  it('matches an installed surface to the exact receipt scope and repository target', () => {
    expect(agentSurfaceTargetMatches(undefined, 'user', '/repo')).toBe(true);
    expect(agentSurfaceTargetMatches({scope: 'user'}, 'user', '/repo')).toBe(true);
    expect(agentSurfaceTargetMatches({cwd: '/repo', scope: 'project'}, 'project', '/repo')).toBe(true);
    expect(agentSurfaceTargetMatches({cwd: '/other', scope: 'project'}, 'project', '/repo')).toBe(false);
    expect(agentSurfaceTargetMatches({scope: 'user'}, 'project', '/repo')).toBe(false);
  });

  it('requires fresh, complete, non-empty repository evidence', () => {
    const brief = {
      coverage: {graph: {complete: true}, omissions: {graphCards: 0, graphContracts: 0}},
      graph: {cards: [{}], contracts: []},
      scope: {freshness: 'fresh', readyRepositories: 1, requestedRepositories: 1},
    } as unknown as Parameters<typeof setupBriefIsSourceVerified>[0];
    expect(setupBriefIsSourceVerified(brief)).toBe(true);
    expect(setupBriefIsSourceVerified({...brief, graph: {...brief.graph, cards: [], contracts: []}})).toBe(false);
    expect(setupBriefIsSourceVerified({...brief, scope: {...brief.scope, freshness: 'stale'}})).toBe(false);
  });

  it('accepts graph evidence omitted by the projection budget', () => {
    const brief = {
      coverage: {graph: {complete: true}, omissions: {graphCards: 1, graphContracts: 2}},
      graph: {cards: [], contracts: []},
      scope: {freshness: 'fresh', readyRepositories: 1, requestedRepositories: 1},
    } as unknown as Parameters<typeof setupBriefIsSourceVerified>[0];
    expect(setupBriefIsSourceVerified(brief)).toBe(true);
    expect(
      setupBriefIsSourceVerified({
        ...brief,
        coverage: {
          ...brief.coverage,
          omissions: {...brief.coverage.omissions, graphCards: 0, graphContracts: 0},
        },
      }),
    ).toBe(false);
  });

  it('counts returned and omitted graph evidence as one source-evidence total', () => {
    fc.assert(
      fc.property(
        fc.nat({max: 4}),
        fc.nat({max: 4}),
        fc.nat({max: 4}),
        fc.nat({max: 4}),
        (cards, contracts, omittedCards, omittedContracts) => {
          const brief = {
            coverage: {
              graph: {complete: true},
              omissions: {graphCards: omittedCards, graphContracts: omittedContracts},
            },
            graph: {
              cards: Array.from({length: cards}, () => ({})),
              contracts: Array.from({length: contracts}, () => ({})),
            },
            scope: {freshness: 'fresh', readyRepositories: 1, requestedRepositories: 1},
          } as unknown as Parameters<typeof setupBriefIsSourceVerified>[0];
          expect(setupBriefIsSourceVerified(brief)).toBe(cards + contracts + omittedCards + omittedContracts > 0);
        },
      ),
      {numRuns: 100},
    );
  });

  it('keeps the setup verification request within the current Context Brief contract', () => {
    expect(parseContextBriefRequestV1(setupContextBriefRequest('/repository', 'verify setup')).budgetTokens).toBe(
      1_500,
    );
  });
});

describe('setup orchestration', () => {
  effectIt.effect('uses the user manifest for setup unless a manifest override is explicit', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-setup-runtime-'});
        const home = `${root}/home`;
        const explicitManifest = `${root}/explicit.yaml`;

        const implicit = yield* getRuntimeConfig({home});
        expect(implicit.manifestSource).toBe('bundled-example');
        expect((yield* resolveSetupRuntimeConfig(implicit)).manifestPath).toBe(`${home}/seed-manifest.yaml`);
        const explicit = yield* getRuntimeConfig({home, manifest: explicitManifest});
        expect((yield* resolveSetupRuntimeConfig(explicit)).manifestPath).toBe(explicitManifest);
      }),
    ).pipe(run),
  );

  effectIt.effect('serializes direct manifest mutation with setup ownership inspection', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-setup-lock-'});
        const repository = `${root}/repository`;
        const home = `${root}/home`;
        const manifestPath = `${home}/manifest.yaml`;
        yield* fs.makeDirectory(repository, {recursive: true});
        yield* runCommand('git', ['init'], {cwd: repository});
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* withSetupMutationLock(
          home,
          Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(acquired);
        expect(yield* fs.exists(`${home}.setup-mutation.lock`)).toBe(true);
        expect(yield* fs.exists(`${home}/locks/setup-mutation.lock`)).toBe(false);
        const mutation = yield* runInitManifest(
          {account: 'local', agentContextHome: home, agentId: 'threadnote', manifestPath, user: 'tester'},
          {path: manifestPath, repo: [repository]},
        ).pipe(Effect.forkScoped);
        yield* Effect.sleep('100 millis');
        expect(yield* fs.exists(manifestPath)).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(mutation);
        expect(yield* fs.exists(manifestPath)).toBe(true);
      }),
    ).pipe(TestClock.withLive, run),
  );

  effectIt.effect('rolls OMP hooks back at the receipt target after the active host root changes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-setup-omp-target-'});
        const home = `${root}/home`;
        const hostA = `${root}/agent-a`;
        const hostB = `${root}/agent-b`;
        let activeHost = hostA;
        const system = SystemInfo.of({
          ...baseSystem,
          environment: () => ({PI_CODING_AGENT_DIR: activeHost}),
          homeDirectory: home,
        });
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: `${home}/manifest.yaml`,
          user: 'tester',
        };
        const adapter = getAgentAdapter('omp-agent')!;
        const installed = yield* productionSetupDependencies
          .ensureHooks(config, adapter, true)
          .pipe(Effect.provideService(SystemInfo, system));
        if (installed.afterHash === undefined || installed.subsystemReceiptRef === undefined)
          return yield* Effect.die('Expected exact OMP hook receipt evidence.');
        activeHost = hostB;
        yield* runOmpHooksInstall({apply: true, hostRoot: hostB});
        const operation = {
          afterHash: installed.afterHash,
          attempt: 1,
          id: 'hooks:omp-agent',
          inputHash: digest,
          kind: 'surface.hooks',
          ownership: 'setup-created',
          ownershipEvidence: 'successful-mutation',
          reversible: true,
          status: 'applied',
          subsystemReceiptRef: installed.subsystemReceiptRef,
        } satisfies SetupReceiptOperationV1;
        yield* productionSetupDependencies
          .removeHooks(config, adapter, operation)
          .pipe(Effect.provideService(SystemInfo, system));
        expect(yield* fs.exists(`${hostA}/hooks/pre/threadnote.ts`)).toBe(false);
        expect(yield* fs.exists(`${hostB}/hooks/pre/threadnote.ts`)).toBe(true);
      }),
    ).pipe(run),
  );

  effectIt.effect('targets the explicitly resolved repository for project-scoped surfaces', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-setup-target-'});
        const repository = `${root}/repository`;
        yield* fs.makeDirectory(repository, {recursive: true});
        yield* runCommand('git', ['init'], {cwd: repository});
        const adapter = getAgentAdapter('kiro-cli')!;
        const plan = yield* planAgentSurface(
          {
            account: 'local',
            agentContextHome: `${root}/home`,
            agentId: 'threadnote',
            manifestPath: `${root}/manifest.yaml`,
            user: 'tester',
          },
          adapter,
          {cwd: repository, scope: 'project'},
        );
        expect(plan.cwd).toBe(repository);
        const projectDefault = yield* planAgentSurface(
          {
            account: 'local',
            agentContextHome: `${root}/default-home`,
            agentId: 'threadnote',
            manifestPath: `${root}/default-manifest.yaml`,
            user: 'tester',
          },
          getAgentAdapter('roo-project')!,
          {cwd: repository},
        );
        expect(projectDefault.scope).toBe('project');
        expect(projectDefault.cwd).toBe(repository);
        const base = getAgentAdapter('gemini-cli')!;
        const managedWithoutStrategy = {
          ...base,
          catalog: {
            ...base.catalog,
            capabilities: {...base.catalog.capabilities, hooks: {status: 'managed' as const}},
          },
        } satisfies AgentAdapter;
        const invalid = yield* createSetupPlan({
          adapter: managedWithoutStrategy,
          manifestPath: `${root}/invalid-manifest.yaml`,
          projectRoot: repository,
          task: 'reject partial setup',
          threadnoteVersion: '5.0.0',
        }).pipe(Effect.flip);
        expect(invalid).toMatchObject({_tag: 'SetupOperationError'});
      }),
    ).pipe(run),
  );

  effectIt.effect('keeps seed preview valid when the manifest merge has not been applied yet', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-setup-preview-'});
        const repository = `${root}/repository`;
        const configured = `${root}/configured`;
        const manifestPath = `${root}/manifest.yaml`;
        yield* fs.makeDirectory(repository, {recursive: true});
        yield* fs.makeDirectory(configured, {recursive: true});
        yield* fs.writeFileString(
          manifestPath,
          `version: 1\nprojects:\n  - name: configured\n    path: ${configured}\n    uri: threadnote://resources/repos/configured\n    seed: []\n`,
        );
        const preview = yield* captureConsole(
          seedSetupProject(
            {
              account: 'local',
              agentContextHome: `${root}/home`,
              agentId: 'threadnote',
              manifestPath,
              user: 'tester',
            },
            repository,
            false,
          ),
        );
        expect(preview.output).toContain('after merging the repository into the manifest');
      }),
    ).pipe(run),
  );

  effectIt.effect('expands manifest project paths before selecting the setup project', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-setup-project-path-'});
        const repository = `${root}/repository`;
        const home = `${root}/threadnote-home`;
        const manifestPath = `${home}/seed-manifest.yaml`;
        const system = SystemInfo.of({...baseSystem, homeDirectory: root});
        yield* fs.makeDirectory(repository, {recursive: true});
        yield* fs.makeDirectory(home, {recursive: true});
        yield* fs.writeFileString(
          manifestPath,
          'version: 1\nprojects:\n  - name: repository\n    path: ~/repository\n' +
            '    uri: threadnote://resources/repos/repository\n    seed: []\n',
        );

        const result = yield* seedSetupProject(
          {account: 'local', agentContextHome: home, agentId: 'threadnote', manifestPath, user: 'tester'},
          repository,
          true,
        ).pipe(Effect.provideService(SystemInfo, system));

        expect(result.status).toBe('applied');
        expect(
          (yield* recallIndexStatus({account: 'local', agentContextHome: home, user: 'tester'}, false)).ready,
        ).toBe(true);
      }),
    ).pipe(run),
  );

  effectIt.effect('creates a stable plan and makes repeated apply a receipt-backed no-op', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-setup-'});
        const repository = `${root}/repository`;
        const home = `${root}/home`;
        yield* fs.makeDirectory(repository, {recursive: true});
        yield* runCommand('git', ['init'], {cwd: repository});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: `${home}/seed-manifest.yaml`,
          user: 'tester',
        };
        const adapter = getAgentAdapter('gemini-cli')!;
        const resolvedRepository = yield* fs.realPath(repository);
        const firstPlan = yield* createSetupPlan({
          adapter,
          manifestPath: config.manifestPath,
          projectRoot: repository,
          task: 'verify setup',
          threadnoteVersion: '5.0.0',
        });
        const secondPlan = yield* createSetupPlan({
          adapter,
          manifestPath: config.manifestPath,
          projectRoot: repository,
          task: 'verify setup',
          threadnoteVersion: '5.0.0',
        });
        expect(secondPlan).toEqual(firstPlan);
        expect(
          (yield* createSetupPlan({
            adapter,
            manifestPath: config.manifestPath,
            projectRoot: repository,
            task: 'verify setup',
            threadnoteVersion: '5.0.1',
          })).planHash,
        ).not.toBe(firstPlan.planHash);
        yield* fs.writeFileString(`${repository}/tracked.txt`, 'source\n');
        yield* runCommand('git', ['add', 'tracked.txt'], {cwd: repository});
        yield* runCommand(
          'git',
          ['-c', 'user.name=Threadnote', '-c', 'user.email=test@example.com', 'commit', '-m', 'source'],
          {cwd: repository},
        );
        expect(
          (yield* createSetupPlan({
            adapter,
            manifestPath: config.manifestPath,
            projectRoot: repository,
            task: 'verify setup',
            threadnoteVersion: '5.0.0',
          })).planHash,
        ).not.toBe(firstPlan.planHash);

        const calls: string[] = [];
        const contextTasks: string[] = [];
        let inspectionFails = false;
        let surfaceInstalled = false;
        const applied = (name: string, extra: Partial<SetupOperationOutcome> = {}) =>
          Effect.sync(() => calls.push(name)).pipe(
            Effect.as({ownership: 'setup-created', status: 'applied', ...extra} as SetupOperationOutcome),
          );
        const dependencies: SetupOrchestratorDependencies<ApplicationServices> = {
          contextBrief: (_config, _projectRoot, task) =>
            Effect.gen(function* () {
              calls.push('context-brief');
              contextTasks.push(task);
              return {
                finalOutput: 'verified brief',
                ownership: 'preexisting',
                status: 'verified',
                verification: validVerification(yield* setupRepositorySourceHash(resolvedRepository)),
              } satisfies SetupOperationOutcome;
            }),
          doctor: () => applied('doctor', {ownership: 'preexisting', status: 'verified'}),
          ensureCore: () => applied('core'),
          ensureHooks: () => applied('hooks'),
          ensureManifest: () =>
            Effect.gen(function* () {
              calls.push('manifest');
              const before = (yield* fs.exists(config.manifestPath))
                ? yield* sha256Hex(yield* fs.readFileString(config.manifestPath))
                : undefined;
              yield* fs.makeDirectory(home, {recursive: true});
              const content =
                `version: 1\nprojects:\n  - name: repository\n    path: ${repository}\n` +
                '    uri: threadnote://resources/repos/repository\n    seed: []\n';
              yield* fs.writeFileString(config.manifestPath, content);
              return {
                afterHash: yield* sha256Hex(content),
                ...(before === undefined ? {} : {beforeHash: before}),
                ownership: before === undefined ? 'setup-created' : 'preexisting',
                status: 'applied',
                subsystemReceiptRef: config.manifestPath,
              } satisfies SetupOperationOutcome;
            }),
          ensureSurface: (_config, _adapter, receivedProjectRoot, apply) => {
            expect(receivedProjectRoot).toBe(resolvedRepository);
            if (!apply || surfaceInstalled)
              return Effect.succeed({
                ownership: 'preexisting',
                status: 'already-current',
              } satisfies SetupOperationOutcome).pipe(
                Effect.tap(() => Effect.sync(() => apply && calls.push('surface'))),
              );
            surfaceInstalled = true;
            return applied('surface');
          },
          indexGraph: () => applied('graph', {ownership: 'preexisting'}),
          inspectReversible: (_config, _adapter, _projectRoot, kind) =>
            inspectionFails
              ? SetupOperationError.make({message: 'inspection unavailable'})
              : kind === 'manifest.ensure'
                ? Effect.gen(function* () {
                    const beforeHash = (yield* fs.exists(config.manifestPath))
                      ? yield* sha256Hex(yield* fs.readFileString(config.manifestPath))
                      : undefined;
                    return {
                      ...(beforeHash === undefined ? {} : {beforeHash}),
                      ownership: beforeHash === undefined ? 'setup-created' : 'preexisting',
                      status: beforeHash === undefined ? 'applied' : 'already-current',
                      subsystemReceiptRef: config.manifestPath,
                    } satisfies SetupOperationOutcome;
                  })
                : Effect.succeed({
                    ownership: surfaceInstalled ? 'preexisting' : 'setup-created',
                    status: surfaceInstalled ? 'already-current' : 'applied',
                  } satisfies SetupOperationOutcome),
          removeHooks: () => applied('remove-hooks'),
          removeSurface: () =>
            Effect.sync(() => {
              calls.push('remove-surface');
              surfaceInstalled = false;
              return {ownership: 'setup-created', status: 'applied'} satisfies SetupOperationOutcome;
            }),
          seedProject: () => applied('seed', {ownership: 'preexisting'}),
        };

        const first = yield* captureConsole(
          runSetupWith(config, adapter, {apply: true, cwd: repository}, dependencies),
        );
        const firstCalls = [...calls];
        const second = yield* captureConsole(
          runSetupWith(config, adapter, {apply: true, cwd: repository}, dependencies),
        );

        expect(first.value?.status).toBe('completed');
        expect(second.value).toEqual(first.value);
        expect(calls).toEqual([...firstCalls, 'doctor', 'context-brief']);
        expect(contextTasks).toEqual([EXPECTED_SETUP_TASK, EXPECTED_SETUP_TASK]);
        expect(second.output).toContain('Setup is already complete');
        expect(second.output).toContain('verified brief');
        const firstEvents = yield* readLocalValueEvents(home);
        expect(firstEvents.filter(event => event.kind === 'setup')).toHaveLength(1);
        const firstLifecycle = firstEvents.filter(event => event.kind === 'setup-lifecycle');
        expect(firstLifecycle.map(event => event.phase)).toEqual(['started', 'completed']);
        expect(firstLifecycle[1]?.timeToFirstEvidenceMilliseconds).toBeGreaterThanOrEqual(0);
        expect(JSON.stringify(firstLifecycle)).not.toContain(repository);
        expect(JSON.stringify(firstLifecycle)).not.toContain('verify setup');
        const receiptFiles = yield* fs.readDirectory(`${home}/setup`);
        expect(receiptFiles).toHaveLength(1);
        expect(parseSetupReceiptV1(JSON.parse(yield* fs.readFileString(`${home}/setup/${receiptFiles[0]}`)))).toEqual(
          first.value,
        );
        const previousVersionReceipt = parseSetupReceiptV1({
          ...first.value,
          operations: first.value!.operations.map(operation => ({...operation, inputHash: 'b'.repeat(64)})),
          planHash: 'b'.repeat(64),
          threadnoteVersion: '4.9.0',
        });
        yield* fs.writeFileString(
          `${home}/setup/${receiptFiles[0]}`,
          `${JSON.stringify(previousVersionReceipt, undefined, 2)}\n`,
        );
        const upgraded = yield* captureConsole(
          runSetupWith(config, adapter, {apply: true, cwd: repository}, dependencies),
        );
        expect(upgraded.value?.operations.find(operation => operation.kind === 'surface.ensure')).toMatchObject({
          ownership: 'setup-created',
          ownershipEvidence: 'successful-mutation',
        });
        const receiptBeforeInspectionFailure = yield* fs.readFileString(`${home}/setup/${receiptFiles[0]}`);
        inspectionFails = true;
        yield* fs.writeFileString(`${repository}/tracked.txt`, 'inspection changed source\n');
        const inspectionFailure = yield* captureConsole(
          runSetupWith(config, adapter, {apply: true, cwd: repository}, dependencies),
        ).pipe(Effect.exit);
        expect(inspectionFailure._tag).toBe('Failure');
        expect(yield* fs.readFileString(`${home}/setup/${receiptFiles[0]}`)).toBe(receiptBeforeInspectionFailure);
        inspectionFails = false;
        yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
        yield* captureConsole(runSetupWith(config, adapter, {apply: true, cwd: repository}, dependencies));
        expect(calls).toHaveLength(firstCalls.length * 3 + 2);
        expect((yield* readLocalValueEvents(home)).filter(event => event.kind === 'setup')).toHaveLength(3);
        expect(
          parseSetupReceiptV1(JSON.parse(yield* fs.readFileString(`${home}/setup/${receiptFiles[0]}`))).status,
        ).toBe('completed');
        yield* fs.writeFileString(`${repository}/tracked.txt`, 'changed source\n');
        yield* captureConsole(runSetupWith(config, adapter, {apply: true, cwd: repository}, dependencies));
        expect(calls).toHaveLength(firstCalls.length * 4 + 2);
        expect((yield* readLocalValueEvents(home)).filter(event => event.kind === 'setup')).toHaveLength(4);
        const undoPreview = yield* captureConsole(
          runSetupWith(config, adapter, {cwd: repository, undo: true}, dependencies),
        );
        expect(undoPreview.output).toContain('undo surface:gemini-cli');
        expect(undoPreview.output).not.toContain('undo manifest');
        expect(yield* fs.exists(config.manifestPath)).toBe(true);
        const undone = yield* captureConsole(
          runSetupWith(config, adapter, {apply: true, cwd: repository, undo: true}, dependencies),
        );
        if (undone.value === undefined) return yield* Effect.die('Expected an undo receipt.');
        expect(undone.value.status).toBe('rolled-back');
        expect(undone.value.recovery.undoOperationIds).toEqual([]);
        expect(undone.value.recovery.resumeOperationIds).toEqual(['surface:gemini-cli']);
        expect(yield* fs.exists(config.manifestPath)).toBe(true);
        expect(calls.at(-1)).toBe('remove-surface');
        expect((yield* readLocalValueEvents(home)).filter(event => event.kind === 'setup')).toHaveLength(4);
        const rollingBack = parseSetupReceiptV1({
          ...Object.fromEntries(Object.entries(undone.value).filter(([key]) => key !== 'rolledBackAt')),
          status: 'rolling-back',
        });
        yield* fs.writeFileString(`${home}/setup/${receiptFiles[0]}`, `${JSON.stringify(rollingBack, undefined, 2)}\n`);
        const finalized = yield* captureConsole(
          runSetupWith(config, adapter, {apply: true, cwd: repository, undo: true}, dependencies),
        );
        expect(finalized.value?.status).toBe('rolled-back');
        const beforeReapply = calls.length;
        const reapplied = yield* captureConsole(
          runSetupWith(config, adapter, {apply: true, cwd: repository}, dependencies),
        );
        expect(reapplied.value?.status).toBe('completed');
        expect(calls).toHaveLength(beforeReapply + firstCalls.length);
        expect(yield* fs.exists(config.manifestPath)).toBe(true);
        expect((yield* readLocalValueEvents(home)).filter(event => event.kind === 'setup')).toHaveLength(5);
        expect(
          (yield* readLocalValueEvents(home))
            .filter(event => event.kind === 'setup-lifecycle')
            .map(event => event.phase),
        ).toEqual([
          'started',
          'completed',
          'started',
          'completed',
          'started',
          'failed',
          'started',
          'completed',
          'started',
          'completed',
          'started',
          'completed',
        ]);
      }),
    ).pipe(TestClock.withLive, run),
  );

  effectIt.effect('resumes failures without replaying mutations or claiming ambiguous ownership', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-setup-resume-'});
        const repository = `${root}/repository`;
        const home = `${root}/home`;
        yield* fs.makeDirectory(repository, {recursive: true});
        yield* runCommand('git', ['init'], {cwd: repository});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: `${home}/manifest.yaml`,
          user: 'tester',
        };
        const adapter = getAgentAdapter('gemini-cli')!;
        const calls: string[] = [];
        let graphAttempts = 0;
        const applied = (name: string, status: SetupOperationOutcome['status'] = 'applied') =>
          Effect.sync(() => calls.push(name)).pipe(
            Effect.as({ownership: 'preexisting', status} satisfies SetupOperationOutcome),
          );
        const dependencies: SetupOrchestratorDependencies<ApplicationServices> = {
          contextBrief: () =>
            applied('context-brief', 'verified').pipe(
              Effect.map(outcome => ({
                ...outcome,
                verification: {
                  contextBriefHash: digest,
                  durationMilliseconds: 1,
                  freshness: 'fresh' as const,
                  graphCards: 1,
                  graphContracts: 0,
                  readyRepositories: 1 as const,
                  repositorySourceHash: digest,
                  requestedRepositories: 1 as const,
                  sourceVerified: true as const,
                },
              })),
            ),
          doctor: () => applied('doctor', 'verified'),
          ensureCore: () => applied('core'),
          ensureHooks: () => applied('hooks'),
          ensureManifest: () => applied('manifest'),
          ensureSurface: () =>
            Effect.sync(() => calls.push('surface')).pipe(
              Effect.as({
                ownership: 'preexisting',
                status: 'applied',
                supportedAgentReuse: true,
              } satisfies SetupOperationOutcome),
            ),
          indexGraph: () =>
            Effect.gen(function* () {
              calls.push('graph');
              graphAttempts += 1;
              if (graphAttempts === 1) return yield* SetupOperationError.make({message: 'graph unavailable'});
              return {ownership: 'preexisting', status: 'applied'} satisfies SetupOperationOutcome;
            }),
          inspectReversible: () =>
            Effect.succeed({ownership: 'setup-created', status: 'applied'} satisfies SetupOperationOutcome),
          removeHooks: () => applied('remove-hooks'),
          removeSurface: () => applied('remove-surface'),
          seedProject: () => applied('seed'),
        };

        const first = yield* captureConsole(
          runSetupWith(config, adapter, {apply: true, cwd: repository}, dependencies),
        ).pipe(Effect.exit);
        expect(first._tag).toBe('Failure');
        const receiptName = (yield* fs.readDirectory(`${home}/setup`))[0];
        const failed = parseSetupReceiptV1(JSON.parse(yield* fs.readFileString(`${home}/setup/${receiptName}`)));
        expect(failed.status).toBe('failed');
        expect(failed.recovery.resumeOperationIds).toEqual(['graph', 'doctor', 'context-brief']);
        expect(failed.recovery.undoOperationIds).toEqual([]);

        const completed = yield* captureConsole(
          runSetupWith(config, adapter, {apply: true, cwd: repository}, dependencies),
        );
        expect(completed.value?.status).toBe('completed');
        expect(completed.value?.recovery.undoOperationIds).toEqual([]);
        expect(completed.value?.supportedAgentReuse).toBe(1);
        expect(calls).toEqual(['core', 'manifest', 'seed', 'surface', 'graph', 'graph', 'doctor', 'context-brief']);
        const events = yield* readLocalValueEvents(home);
        expect(events.filter(event => event.kind === 'setup')).toEqual([
          expect.objectContaining({completed: 1, supportedAgentReuse: 1}),
        ]);
        expect(events.filter(event => event.kind === 'setup-lifecycle').map(event => event.phase)).toEqual([
          'started',
          'failed',
          'started',
          'completed',
        ]);
      }),
    ).pipe(TestClock.withLive, run),
  );

  effectIt.effect('re-delivers crash-window evidence and records a failed replay before retry', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-setup-crash-window-'});
        const repository = `${root}/repository`;
        const home = `${root}/home`;
        yield* fs.makeDirectory(repository, {recursive: true});
        yield* runCommand('git', ['init'], {cwd: repository});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: `${home}/manifest.yaml`,
          user: 'tester',
        };
        const adapter = getAgentAdapter('gemini-cli')!;
        const resolvedRepository = yield* fs.realPath(repository);
        const task = EXPECTED_SETUP_TASK;
        const threadnoteVersion = yield* getThreadnoteVersion();
        const plan = yield* createSetupPlan({
          adapter,
          manifestPath: config.manifestPath,
          projectRoot: resolvedRepository,
          scope: 'user',
          task,
          threadnoteVersion,
        });
        const receiptId = yield* sha256Hex(
          JSON.stringify({projectRoot: resolvedRepository, scope: 'user', surfaceId: adapter.catalog.id}),
        );
        const receiptPath = `${home}/setup/${adapter.catalog.id}-${receiptId.slice(0, 16)}.json`;
        const verification = validVerification(yield* setupRepositorySourceHash(resolvedRepository));
        const operations = plan.operations.map(operation => ({
          attempt: 1,
          id: operation.id,
          inputHash: operation.inputHash,
          kind: operation.kind,
          ownership: 'preexisting' as const,
          reversible: operation.reversible,
          status: operation.kind === 'context-brief.verify' ? ('verified' as const) : ('already-current' as const),
        }));
        const pending = parseSetupReceiptV1({
          operations,
          planHash: plan.planHash,
          receiptId,
          recovery: setupRecovery(operations),
          scope: 'user',
          startedAt: '2026-09-17T11:59:00.000Z',
          status: 'pending',
          surfaceId: adapter.catalog.id,
          threadnoteVersion: plan.threadnoteVersion,
          type: 'threadnote-setup-receipt',
          updatedAt: '2026-09-17T12:00:00.000Z',
          verification,
          version: 1,
        });
        yield* fs.makeDirectory(`${home}/setup`, {recursive: true});
        yield* fs.writeFileString(receiptPath, `${JSON.stringify(pending)}\n`);
        let executions = 0;
        let briefAttempts = 0;
        const unexpected = () =>
          Effect.sync(() => {
            executions += 1;
            return {ownership: 'preexisting', status: 'applied'} satisfies SetupOperationOutcome;
          });
        const dependencies: SetupOrchestratorDependencies<ApplicationServices> = {
          contextBrief: () =>
            Effect.gen(function* () {
              executions += 1;
              briefAttempts += 1;
              if (briefAttempts === 1) return yield* SetupOperationError.make({message: 'brief replay interrupted'});
              return {
                finalOutput: 're-delivered verified brief',
                ownership: 'preexisting',
                status: 'verified',
                verification,
              } satisfies SetupOperationOutcome;
            }),
          doctor: unexpected,
          ensureCore: unexpected,
          ensureHooks: unexpected,
          ensureManifest: unexpected,
          ensureSurface: unexpected,
          indexGraph: unexpected,
          inspectReversible: unexpected,
          removeHooks: unexpected,
          removeSurface: unexpected,
          seedProject: unexpected,
        };
        const interrupted = yield* captureConsole(
          runSetupWith(config, adapter, {apply: true, cwd: repository}, dependencies),
        ).pipe(Effect.exit);
        expect(interrupted._tag).toBe('Failure');
        const failed = parseSetupReceiptV1(JSON.parse(yield* fs.readFileString(receiptPath)));
        expect(failed.status).toBe('failed');
        expect(failed.verification).toBeUndefined();
        expect(failed.operations.find(operation => operation.kind === 'context-brief.verify')?.status).toBe('failed');
        const completed = yield* captureConsole(
          runSetupWith(config, adapter, {apply: true, cwd: repository}, dependencies),
        );
        expect(completed.value?.status).toBe('completed');
        expect(completed.value?.verification).toEqual(verification);
        expect(completed.output).toContain('re-delivered verified brief');
        expect(executions).toBe(2);
        expect((yield* readLocalValueEvents(home)).filter(event => event.kind === 'setup')).toHaveLength(1);
      }),
    ).pipe(TestClock.withLive, run),
  );
});

function validVerification(repositorySourceHash = digest) {
  return {
    contextBriefHash: digest,
    durationMilliseconds: 10,
    freshness: 'fresh' as const,
    graphCards: 1,
    graphContracts: 0,
    readyRepositories: 1 as const,
    repositorySourceHash,
    requestedRepositories: 1 as const,
    sourceVerified: true as const,
  };
}

function validReceipt() {
  return {
    completedAt: '2026-09-17T12:00:00.000Z',
    operations: [
      {
        attempt: 1,
        id: 'context-brief',
        inputHash: digest,
        kind: 'context-brief.verify',
        ownership: 'preexisting',
        reversible: false,
        status: 'verified',
      },
    ],
    planHash: digest,
    receiptId: digest,
    recovery: {resumeOperationIds: [], undoOperationIds: []},
    startedAt: '2026-09-17T11:59:00.000Z',
    status: 'completed',
    surfaceId: 'gemini-cli',
    threadnoteVersion: '5.0.0-local.g123',
    type: 'threadnote-setup-receipt',
    updatedAt: '2026-09-17T12:00:00.000Z',
    verification: validVerification(),
    version: 1,
  } as const;
}
