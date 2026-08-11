import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdtemp, readFile, rm} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {afterEach, beforeEach, describe} from 'vitest';
import {SystemInfo} from '../../src/effect/system.js';
import {
  readThreadnoteProcessDiagnostics,
  legacyProcessDoctorCheck,
  renderProcessDiagnosticsTable,
  threadnoteHomeForProcess,
  withThreadnoteProcessActivity,
  withThreadnoteProcessRegistration,
} from '../../src/process_diagnostics.js';

let temporaryRoot: string | undefined;
let installationTemporaryRoot: string | undefined;
let previousInstallationRoot: string | undefined;

beforeEach(async () => {
  previousInstallationRoot = process.env.THREADNOTE_INSTALL_ROOT;
  installationTemporaryRoot = await mkdtemp(join(tmpdir(), 'threadnote-process-installation-'));
  process.env.THREADNOTE_INSTALL_ROOT = installationTemporaryRoot;
});

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, {force: true, recursive: true});
  if (installationTemporaryRoot) await rm(installationTemporaryRoot, {force: true, recursive: true});
  if (previousInstallationRoot === undefined) delete process.env.THREADNOTE_INSTALL_ROOT;
  else process.env.THREADNOTE_INSTALL_ROOT = previousInstallationRoot;
  temporaryRoot = undefined;
  installationTemporaryRoot = undefined;
  previousInstallationRoot = undefined;
});

describe('process diagnostics', () => {
  it('aligns operation values with their header when preceding cells have different widths', () => {
    expect(
      renderProcessDiagnosticsTable([
        {
          ageMilliseconds: (12 * 60 * 60 + 55 * 60) * 1_000,
          currentOperation: 'mcp-server',
          parentProcessId: 42_478,
          processId: 79_155,
          releaseVersion: '4.0.3',
          role: 'mcp',
          rssBytes: 138.2 * 1024 * 1024,
          startedAt: '2026-08-04T00:00:00.000Z',
        },
        {
          ageMilliseconds: (44 * 60 + 23) * 1_000,
          currentOperation: 'repair',
          parentProcessId: 1_100,
          processId: 71_873,
          releaseVersion: '4.0.3',
          role: 'cli',
          rssBytes: 78 * 1024 * 1024,
          startedAt: '2026-08-05T00:00:00.000Z',
        },
      ]),
    ).toBe(
      [
        'PID    PPID   ROLE  VERSION  AGE     RSS        OPERATION',
        '79155  42478  mcp   4.0.3    12h55m  138.2 MiB  mcp-server',
        '71873  1100   cli   4.0.3    44m23s  78.0 MiB   repair',
      ].join('\n'),
    );
  });

  it('qualifies a process identity with the graph activity it is currently performing', () => {
    expect(
      renderProcessDiagnosticsTable([
        {
          activityRole: 'graph-builder',
          ageMilliseconds: (5 * 60 * 60 + 3 * 60) * 1_000,
          currentOperation: 'index-repository',
          parentProcessId: 23_265,
          processId: 27_543,
          releaseVersion: '4.0.6',
          role: 'cli',
          rssBytes: 746.4 * 1024 * 1024,
          startedAt: '2026-08-05T00:00:00.000Z',
        },
        {
          activityRole: 'graph-waiter',
          ageMilliseconds: 12 * 1_000,
          currentOperation: 'repository-lock',
          parentProcessId: 36_027,
          processId: 37_407,
          releaseVersion: '4.0.6',
          role: 'mcp',
          rssBytes: 685 * 1024 * 1024,
          startedAt: '2026-08-05T00:00:01.000Z',
        },
        {
          ageMilliseconds: 30 * 1_000,
          currentOperation: 'embed-many',
          parentProcessId: 27_543,
          processId: 51_730,
          releaseVersion: '4.0.6',
          role: 'local-model-worker',
          rssBytes: 634.1 * 1024 * 1024,
          startedAt: '2026-08-05T00:00:02.000Z',
        },
      ]),
    ).toBe(
      [
        'PID    PPID   ROLE                 VERSION  AGE   RSS        OPERATION',
        '27543  23265  cli (graph-builder)  4.0.6    5h3m  746.4 MiB  index-repository',
        '37407  36027  mcp (graph-waiter)   4.0.6    12s   685.0 MiB  repository-lock',
        '51730  27543  local-model-worker   4.0.6    30s   634.1 MiB  embed-many',
      ].join('\n'),
    );
  });

  it.prop(
    'keeps every operation value under its header for arbitrary preceding column widths',
    {
      processes: FC.array(
        FC.record({
          activityRole: FC.option(FC.constantFrom('graph-builder' as const, 'graph-waiter' as const), {nil: undefined}),
          ageMilliseconds: FC.integer({max: 14 * 24 * 60 * 60 * 1_000, min: 0}),
          currentOperation: FC.option(
            FC.constantFrom('diagnostics', 'index-repository', 'mcp-server', 'repair', 'repository-lock'),
            {nil: undefined},
          ),
          parentProcessId: FC.integer({max: 9_999_999, min: 0}),
          processId: FC.integer({max: 9_999_999, min: 1}),
          releaseVersion: FC.option(
            FC.constantFrom('4.0.3', '4.0.3-local.g0123456789abcdef0123456789abcdef01234567', 'unknown-build'),
            {nil: undefined},
          ),
          role: FC.constantFrom(
            'cli' as const,
            'graph-builder' as const,
            'graph-parser-worker' as const,
            'graph-waiter' as const,
            'legacy' as const,
            'local-model-worker' as const,
            'manager' as const,
            'mcp' as const,
          ),
          rssBytes: FC.option(FC.integer({max: 8 * 1024 * 1024 * 1024, min: 0}), {nil: undefined}),
          startedAt: FC.constant('2026-08-05T00:00:00.000Z'),
        }),
        {maxLength: 30, minLength: 1},
      ),
    },
    ({processes}) => {
      const lines = renderProcessDiagnosticsTable(processes).split('\n');
      const operationColumn = lines[0]!.indexOf('OPERATION');
      const roleColumn = lines[0]!.indexOf('ROLE');

      expect(operationColumn).toBeGreaterThan(0);
      expect(lines).toHaveLength(processes.length + 1);
      for (const [index, process] of processes.entries()) {
        expect(lines[index + 1]!.slice(operationColumn)).toBe(process.currentOperation ?? '-');
        // A nested activity qualifies the identity it runs under; it never replaces it.
        expect(lines[index + 1]!.slice(roleColumn)).toMatch(new RegExp(`^${process.role}(?: \\(|\\s|$)`));
      }
    },
    {fastCheck: {numRuns: 200}},
  );

  it.effect('reports a validated pre-registry release lease without exposing its private fields', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-legacy-process-home-'});
      const legacyProcessId = 1_234_567;
      const legacyVersion = '4.0.0-beta.19';
      const leasePath = join(installationTemporaryRoot!, 'leases', legacyVersion, `${legacyProcessId}.json`);
      yield* fileSystem.makeDirectory(join(installationTemporaryRoot!, 'leases', legacyVersion), {recursive: true});
      yield* fileSystem.writeFileString(
        leasePath,
        `${JSON.stringify({
          executable: '/private/repository/path/threadnote',
          parentProcessId: 7654,
          processId: legacyProcessId,
          processStartIdentity: 'matching-process-identity',
          startedAt: '2026-08-01T00:00:00.000Z',
          token: 'private-ownership-token',
          version: legacyVersion,
        })}\n`,
      );
      const olderVersion = '4.0.0-beta.18';
      const olderLeaseDirectory = join(installationTemporaryRoot!, 'leases', olderVersion);
      yield* fileSystem.makeDirectory(olderLeaseDirectory, {recursive: true});
      yield* fileSystem.writeFileString(
        join(olderLeaseDirectory, `${legacyProcessId}.json`),
        `${JSON.stringify({
          processId: legacyProcessId,
          processStartIdentity: 'matching-process-identity',
          startedAt: '2026-08-01T00:00:00.000Z',
          token: 'older-private-ownership-token',
          version: olderVersion,
        })}\n`,
      );
      const forgedRegistryPath = join(home, 'runtime', 'processes', `${legacyProcessId}.json`);
      yield* fileSystem.makeDirectory(join(home, 'runtime', 'processes'), {recursive: true});
      yield* fileSystem.writeFileString(
        forgedRegistryPath,
        `${JSON.stringify({
          baseRole: 'legacy',
          parentProcessId: 7654,
          processId: legacyProcessId,
          role: 'legacy',
          schemaVersion: 1,
          startedAt: '2026-08-01T00:00:00.000Z',
          token: 'not-a-valid-current-registry-role',
          updatedAt: '2026-08-01T00:00:00.000Z',
        })}\n`,
      );
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: processId => processId === legacyProcessId,
        processStartIdentity: processId =>
          Effect.succeed(processId === legacyProcessId ? 'matching-process-identity' : undefined),
      });

      const diagnostics = yield* readThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      const doctor = yield* legacyProcessDoctorCheck({agentContextHome: home}).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      expect(diagnostics.processes).toEqual([
        expect.objectContaining({
          parentProcessId: 7654,
          processId: legacyProcessId,
          releaseVersion: legacyVersion,
          role: 'legacy',
        }),
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain('private-ownership-token');
      expect(JSON.stringify(diagnostics)).not.toContain('/private/repository/path');
      expect(doctor).toMatchObject({status: 'warn'});
      expect(doctor.detail).toContain(legacyVersion);
      expect(yield* fileSystem.exists(forgedRegistryPath)).toBe(false);

      const reusedPidSystem = SystemInfo.of({
        ...testSystem,
        processStartIdentity: () => Effect.succeed('replacement-process-identity'),
      });
      expect(
        (yield* readThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
          Effect.provideService(SystemInfo, reusedPidSystem),
        )).processes,
      ).toEqual([]);
      expect(yield* fileSystem.exists(leasePath)).toBe(false);
    }).pipe(provideTestLayer(SystemInfo.layer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('keeps process identity as ROLE while nested activities update OPERATION and title', () =>
    Effect.gen(function* () {
      temporaryRoot = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-process-diagnostics-')));
      const config = {agentContextHome: temporaryRoot};
      const originalTitle = process.title;

      yield* withThreadnoteProcessRegistration(
        temporaryRoot,
        'mcp',
        Effect.gen(function* () {
          expect(process.title).toBe('threadnote:mcp');
          const base = yield* readThreadnoteProcessDiagnostics(config);
          expect(base.processes).toEqual([
            expect.objectContaining({
              parentProcessId: process.ppid,
              processId: process.pid,
              role: 'mcp',
              rssBytes: expect.any(Number),
            }),
          ]);
          const serialized = JSON.stringify(base);
          expect(serialized).not.toContain(temporaryRoot);
          expect(serialized).not.toContain(process.cwd());
          expect(serialized).not.toContain('token');
          const privateRegistration = yield* Effect.promise(() =>
            readFile(join(temporaryRoot!, 'runtime', 'processes', `${process.pid}.json`), 'utf8'),
          );
          expect(privateRegistration).not.toContain(temporaryRoot);
          expect(privateRegistration).not.toContain(process.cwd());

          expect(base.processes[0]).not.toHaveProperty('activityRole');

          yield* withThreadnoteProcessActivity(
            'graph-waiter',
            'repository-lock',
            Effect.gen(function* () {
              expect(process.title).toBe('threadnote:graph-waiter');
              const waiting = yield* readThreadnoteProcessDiagnostics(config);
              expect(waiting.processes[0]).toMatchObject({
                activityRole: 'graph-waiter',
                currentOperation: 'repository-lock',
                role: 'mcp',
              });

              yield* withThreadnoteProcessActivity(
                'graph-builder',
                'index-repository',
                Effect.gen(function* () {
                  expect(process.title).toBe('threadnote:graph-builder');
                  const building = yield* readThreadnoteProcessDiagnostics(config);
                  expect(building.processes[0]).toMatchObject({
                    activityRole: 'graph-builder',
                    currentOperation: 'index-repository',
                    role: 'mcp',
                  });
                }),
              );

              const waitingAgain = yield* readThreadnoteProcessDiagnostics(config);
              expect(process.title).toBe('threadnote:graph-waiter');
              expect(waitingAgain.processes[0]).toMatchObject({
                activityRole: 'graph-waiter',
                currentOperation: 'repository-lock',
                role: 'mcp',
              });
            }),
          );
        }),
      );

      expect(process.title).toBe(originalTitle);
      expect((yield* readThreadnoteProcessDiagnostics(config)).processes).toEqual([]);
    }).pipe(provideTestLayer(SystemInfo.layer), provideTestLayer(BunServices.layer)),
  );

  it.effect('reports a dedicated CLI graph build as a graph activity owned by a CLI process', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-cli-builder-'});
      const config = {agentContextHome: home};

      yield* withThreadnoteProcessRegistration(
        home,
        'cli',
        withThreadnoteProcessActivity(
          'graph-builder',
          'index-repository',
          Effect.gen(function* () {
            const diagnostics = yield* readThreadnoteProcessDiagnostics(config);
            expect(diagnostics.processes[0]).toMatchObject({
              activityRole: 'graph-builder',
              currentOperation: 'index-repository',
              role: 'cli',
            });
            expect(renderProcessDiagnosticsTable(diagnostics.processes)).toContain('cli (graph-builder)');
          }),
        ),
        'graph',
      );
    }).pipe(provideTestLayer(SystemInfo.layer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('resolves explicit process homes without leaking command arguments into diagnostics', () =>
    Effect.gen(function* () {
      const absoluteHome = join(tmpdir(), 'threadnote-home');
      expect(yield* threadnoteHomeForProcess(['--home', './private-home', 'processes'], {})).toBe(
        join(process.cwd(), 'private-home'),
      );
      expect(yield* threadnoteHomeForProcess(['processes', `--home=${absoluteHome}`], {})).toBe(absoluteHome);
      expect(
        yield* threadnoteHomeForProcess(['--home', './private-home', 'processes'], {
          THREADNOTE_CALLER_CWD: join(process.cwd(), 'caller-worktree'),
        }),
      ).toBe(join(process.cwd(), 'caller-worktree', 'private-home'));
    }).pipe(provideTestLayer(SystemInfo.layer), provideTestLayer(BunServices.layer)),
  );

  it.effect('falls back to runtime RSS when the host process query is unavailable', () =>
    Effect.gen(function* () {
      const nativeSystem = yield* SystemInfo;
      const expectedRssBytes = 42_000_000;
      const unavailableProcessId = 2_000_000_000;
      const systemWithoutPs = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: processId => processId === unavailableProcessId,
        memoryUsage: () => ({external: 0, heapUsed: 0, rss: expectedRssBytes}),
        processId: unavailableProcessId,
        processStartIdentity: () => Effect.succeed(undefined),
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-rss-'});

      yield* withThreadnoteProcessRegistration(
        home,
        'cli',
        Effect.gen(function* () {
          const diagnostics = yield* readThreadnoteProcessDiagnostics({agentContextHome: home});
          expect(diagnostics.processes).toEqual([
            expect.objectContaining({processId: unavailableProcessId, rssBytes: expectedRssBytes}),
          ]);
        }),
      ).pipe(Effect.provideService(SystemInfo, systemWithoutPs));
    }).pipe(provideTestLayer(SystemInfo.layer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.live('coalesces consecutive model batches while preserving operation and idle transitions', () =>
    Effect.gen(function* () {
      temporaryRoot = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-process-diagnostics-')));
      const fileSystem = yield* FileSystem.FileSystem;
      const registryRoot = join(temporaryRoot, 'runtime', 'processes');
      let registryWrites = 0;
      const countingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (file, data, options) => {
          if (file.startsWith(registryRoot) && file.endsWith('.tmp')) registryWrites += 1;
          return fileSystem.writeFileString(file, data, options);
        },
      });
      const config = {agentContextHome: temporaryRoot};
      const burstOptions = {idleTransitionDelayMilliseconds: 60_000} as const;

      yield* withThreadnoteProcessRegistration(
        temporaryRoot,
        'local-model-worker',
        Effect.gen(function* () {
          expect(registryWrites).toBe(1);
          for (let index = 0; index < 100; index += 1) {
            yield* withThreadnoteProcessActivity('local-model-worker', 'embed-many', Effect.void, burstOptions);
          }

          expect(registryWrites).toBe(2);
          expect((yield* readThreadnoteProcessDiagnostics(config)).processes[0]).toMatchObject({
            currentOperation: 'embed-many',
            role: 'local-model-worker',
          });

          yield* withThreadnoteProcessActivity('local-model-worker', 'rerank', Effect.void, burstOptions);
          expect(registryWrites).toBe(3);
          expect((yield* readThreadnoteProcessDiagnostics(config)).processes[0]).toMatchObject({
            currentOperation: 'rerank',
            role: 'local-model-worker',
          });

          yield* withThreadnoteProcessActivity(
            'local-model-worker',
            'diagnostics',
            Effect.gen(function* () {
              expect(registryWrites).toBe(4);
              expect((yield* readThreadnoteProcessDiagnostics(config)).processes[0]).toMatchObject({
                currentOperation: 'diagnostics',
                role: 'local-model-worker',
              });
            }),
            {idleTransitionDelayMilliseconds: 1},
          );
          yield* Effect.sleep('50 millis');
          expect(registryWrites).toBe(5);
          expect((yield* readThreadnoteProcessDiagnostics(config)).processes[0]).toMatchObject({
            currentOperation: 'model-stdio',
            role: 'local-model-worker',
          });
        }),
        'model-stdio',
      ).pipe(Effect.provideService(FileSystem.FileSystem, countingFileSystem));
    }).pipe(provideTestLayer(SystemInfo.layer), provideTestLayer(BunServices.layer)),
  );

  it.effect.prop(
    'writes one registry transition per adjacent model-operation run',
    {
      operations: FC.array(FC.constantFrom('diagnostics', 'embed-many', 'generate', 'rerank'), {
        maxLength: 50,
        minLength: 1,
      }),
    },
    ({operations}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-diagnostics-property-'});
          const registryRoot = join(home, 'runtime', 'processes');
          let registryWrites = 0;
          const countingFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            writeFileString: (file, data, options) => {
              if (file.startsWith(registryRoot) && file.endsWith('.tmp')) registryWrites += 1;
              return fileSystem.writeFileString(file, data, options);
            },
          });

          yield* withThreadnoteProcessRegistration(
            home,
            'local-model-worker',
            Effect.forEach(
              operations,
              operation =>
                withThreadnoteProcessActivity('local-model-worker', operation, Effect.void, {
                  idleTransitionDelayMilliseconds: 60_000,
                }),
              {concurrency: 1, discard: true},
            ).pipe(
              Effect.tap(() => {
                const operationRuns = operations.reduce(
                  (runs, operation, index) => runs + (index === 0 || operations[index - 1] !== operation ? 1 : 0),
                  0,
                );
                return Effect.sync(() => expect(registryWrites).toBe(1 + operationRuns));
              }),
            ),
            'model-stdio',
          ).pipe(Effect.provideService(FileSystem.FileSystem, countingFileSystem));
        }),
      ).pipe(provideTestLayer(SystemInfo.layer), provideTestLayer(BunServices.layer)),
    {fastCheck: {numRuns: 30}},
  );
});
