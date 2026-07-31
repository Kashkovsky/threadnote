import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {afterEach, describe} from 'vitest';
import {SystemInfo} from '../../src/effect/system.js';
import {
  readThreadnoteProcessDiagnostics,
  threadnoteHomeForProcess,
  withThreadnoteProcessActivity,
  withThreadnoteProcessRegistration,
} from '../../src/process_diagnostics.js';

let temporaryRoot: string | undefined;

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, {force: true, recursive: true});
  temporaryRoot = undefined;
});

describe('process diagnostics', () => {
  it.effect('reports base and nested graph roles, then removes its owned registration', () =>
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

          yield* withThreadnoteProcessActivity(
            'graph-waiter',
            'repository-lock',
            Effect.gen(function* () {
              expect(process.title).toBe('threadnote:graph-waiter');
              const waiting = yield* readThreadnoteProcessDiagnostics(config);
              expect(waiting.processes[0]).toMatchObject({
                currentOperation: 'repository-lock',
                role: 'graph-waiter',
              });

              yield* withThreadnoteProcessActivity(
                'graph-builder',
                'index-repository',
                Effect.gen(function* () {
                  expect(process.title).toBe('threadnote:graph-builder');
                  const building = yield* readThreadnoteProcessDiagnostics(config);
                  expect(building.processes[0]).toMatchObject({
                    currentOperation: 'index-repository',
                    role: 'graph-builder',
                  });
                }),
              );

              const waitingAgain = yield* readThreadnoteProcessDiagnostics(config);
              expect(process.title).toBe('threadnote:graph-waiter');
              expect(waitingAgain.processes[0]).toMatchObject({
                currentOperation: 'repository-lock',
                role: 'graph-waiter',
              });
            }),
          );
        }),
      );

      expect(process.title).toBe(originalTitle);
      expect((yield* readThreadnoteProcessDiagnostics(config)).processes).toEqual([]);
    }).pipe(Effect.provide(SystemInfo.layer), Effect.provide(BunServices.layer)),
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
    }).pipe(Effect.provide(SystemInfo.layer), Effect.provide(BunServices.layer)),
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
    }).pipe(Effect.provide(SystemInfo.layer), Effect.provide(BunServices.layer)),
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
      ).pipe(Effect.provide(SystemInfo.layer), Effect.provide(BunServices.layer)),
    {fastCheck: {numRuns: 30}},
  );
});
