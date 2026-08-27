import {TestError} from '../helpers/test-error.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Exit, Fiber, FileSystem, Path, PlatformError} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  PRODUCTION_LOG_FILE_NAME,
  productionLogSupportExcerpt,
  runProductionLogs,
  withProductionLogging,
  withProductionPhaseTiming,
} from '../../src/effect/production_log.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import type {RuntimeConfig} from '../../src/types.js';
import {captureConsole} from '../../src/effect/console.js';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import {SystemInfo} from '../../src/effect/system.js';

interface ParsedProductionLogEntry {
  readonly component: string;
  readonly errorType?: string;
  readonly event: string;
  readonly invocationId: string;
  readonly operation: string;
  readonly outcome?: string;
  readonly phaseTimings?: readonly {
    readonly durationMilliseconds: number;
    readonly outcome: string;
    readonly phase: string;
  }[];
  readonly schemaVersion: number;
}

class PrivateFailure extends Error {
  override readonly name = 'PrivateFailure';
}

describe('production log writer', () => {
  effectIt.effect('does not create an unowned Threadnote home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-production-log-unowned-'});
        const home = path.join(root, 'missing-home');

        yield* withProductionLogging(home, {component: 'cli', operation: 'doctor'}, Effect.void);
        const excerpt = yield* productionLogSupportExcerpt(home, 1_000);

        expect(yield* fs.exists(home)).toBe(false);
        expect(excerpt).toEqual({content: '', discardedEntries: 0, includedEntries: 0, omittedEntries: 0});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('writes correlated success and typed-failure entries without application content', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {fs, home, path} = yield* ownedTestHome('privacy');
        const secret = 'sk-production-log-secret-value';
        const customerText = 'customer-memory-body-must-not-appear';
        const localPath = path.join(home, 'data', 'private.md');

        yield* withProductionLogging(home, {component: 'cli', operation: 'version'}, Effect.void);
        const failed = yield* Effect.exit(
          withProductionLogging(
            home,
            {component: 'cli', operation: 'remember'},
            Effect.fail(new PrivateFailure(`${secret} ${customerText} ${localPath}`)),
          ),
        );

        expect(Exit.isFailure(failed)).toBe(true);
        const content = yield* fs.readFileString(productionLogPath(path, home));
        const entries = parseEntries(content);
        expect(entries).toHaveLength(4);
        expect(entries[0]).toMatchObject({
          component: 'cli',
          event: 'invocation.started',
          operation: 'version',
          schemaVersion: 1,
        });
        expect(entries[1]).toMatchObject({event: 'invocation.finished', outcome: 'success'});
        expect(entries[0]?.invocationId).toBe(entries[1]?.invocationId);
        expect(entries[2]).toMatchObject({event: 'invocation.started', operation: 'remember'});
        expect(entries[3]).toMatchObject({
          errorType: 'PrivateFailure',
          event: 'invocation.finished',
          outcome: 'failure',
        });
        expect(entries[2]?.invocationId).toBe(entries[3]?.invocationId);
        expect(content).not.toContain(secret);
        expect(content).not.toContain(customerText);
        expect(content).not.toContain(localPath);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('blocks credential-shaped failure types and throwing diagnostic getters', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {fs, home, path} = yield* ownedTestHome('unsafe-error-types');
        const secretType = 'sk-1234567890abcdefghijkl';
        const secretNamedFailure = new TestError('private');
        secretNamedFailure.name = secretType;
        const taggedFailure = {_tag: secretType};
        const throwingFailure = new Proxy(
          {},
          {
            get: () => {
              throw new TestError('diagnostic getter should not escape');
            },
            has: () => true,
          },
        );

        const secretExit = yield* Effect.exit(
          withProductionLogging(home, {component: 'cli', operation: 'doctor'}, Effect.fail(secretNamedFailure)),
        );
        const throwingExit = yield* Effect.exit(
          withProductionLogging(home, {component: 'cli', operation: 'doctor'}, Effect.fail(throwingFailure)),
        );
        const taggedExit = yield* Effect.exit(
          withProductionLogging(home, {component: 'cli', operation: 'doctor'}, Effect.fail(taggedFailure)),
        );

        expect(Exit.isFailure(secretExit)).toBe(true);
        expect(Exit.isFailure(throwingExit)).toBe(true);
        expect(Exit.isFailure(taggedExit)).toBe(true);
        expect(Exit.isFailure(taggedExit) ? Cause.squash(taggedExit.cause) : undefined).toBe(taggedFailure);
        const content = yield* fs.readFileString(productionLogPath(path, home));
        expect(content).not.toContain(secretType);
        expect(parseEntries(content).filter(entry => entry.event === 'invocation.finished')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({errorType: 'UnknownError', outcome: 'failure'}),
            expect.objectContaining({errorType: 'UnknownError', outcome: 'failure'}),
            expect.objectContaining({errorType: 'UnknownError', outcome: 'failure'}),
          ]),
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves application results and executes once when log writes fail', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {fs, home, path} = yield* ownedTestHome('write-failure');
        yield* fs.writeFileString(path.join(home, 'logs'), 'blocks the logs directory');
        let successRuns = 0;
        let failureRuns = 0;

        const value = yield* withProductionLogging(
          home,
          {component: 'cli', operation: 'doctor'},
          Effect.sync(() => {
            successRuns += 1;
            return 'application-result';
          }),
        );
        const failed = yield* Effect.exit(
          withProductionLogging(
            home,
            {component: 'cli', operation: 'doctor'},
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                failureRuns += 1;
              });
              return yield* Effect.fail(new PrivateFailure('application failure'));
            }),
          ),
        );

        expect(value).toBe('application-result');
        expect(successRuns).toBe(1);
        expect(failureRuns).toBe(1);
        expect(Exit.isFailure(failed)).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('classifies MCP error results without recording their response text', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {fs, home, path} = yield* ownedTestHome('mcp-result');
        const responseText = 'private MCP response that must stay out of logs';

        yield* withProductionLogging(
          home,
          {
            component: 'mcp',
            operation: 'recall_context',
            reportedFailure: result => result.isError,
            reportedFailureType: 'McpToolError',
          },
          Effect.succeed({isError: true, responseText}),
        );

        const content = yield* fs.readFileString(productionLogPath(path, home));
        const entries = parseEntries(content);
        expect(entries.at(-1)).toMatchObject({
          component: 'mcp',
          errorType: 'McpToolError',
          operation: 'recall_context',
          outcome: 'failure',
        });
        expect(content).not.toContain(responseText);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('batches typed phase timings into the existing finished entry without application content', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {fs, home, path} = yield* ownedTestHome('phase-timings');
        const privateQuery = 'customer-query-must-not-appear';

        yield* withProductionLogging(
          home,
          {component: 'mcp', operation: 'recall_context'},
          Effect.gen(function* () {
            const syncFiber = yield* withProductionPhaseTiming('recall.shared-sync', Effect.sleep(25)).pipe(
              Effect.forkChild,
            );
            yield* TestClock.adjust(25);
            yield* Fiber.join(syncFiber);
            yield* withProductionPhaseTiming(
              'recall.semantic-retrieval',
              Effect.succeed({privateQuery, status: 'timed-out' as const}),
              result => result.status,
            );
          }),
        );

        const content = yield* fs.readFileString(productionLogPath(path, home));
        const entries = parseEntries(content);
        expect(entries).toHaveLength(2);
        expect(entries[1]?.phaseTimings).toEqual([
          {durationMilliseconds: 25, outcome: 'success', phase: 'recall.shared-sync'},
          {durationMilliseconds: 0, outcome: 'timed-out', phase: 'recall.semantic-retrieval'},
        ]);
        expect(content).not.toContain(privateQuery);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('serializes concurrent writers into valid JSON lines without losing entries', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {fs, home, path} = yield* ownedTestHome('concurrent');
        const invocationCount = 12;

        yield* Effect.all(
          Array.from({length: invocationCount}, () =>
            withProductionLogging(home, {component: 'mcp', operation: 'health'}, Effect.void),
          ),
          {concurrency: 'unbounded'},
        );

        const entries = parseEntries(yield* fs.readFileString(productionLogPath(path, home)));
        expect(entries).toHaveLength(invocationCount * 2);
        expect(new Set(entries.map(entry => entry.invocationId)).size).toBe(invocationCount);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retries a Windows sharing violation instead of dropping a lifecycle entry', () =>
    TestClock.withLive(
      windowsEntriesAfterTransientLockContention(1, 'PermissionDenied').pipe(
        Effect.flatMap(entries =>
          Effect.sync(() => {
            expect(entries).toHaveLength(2);
            expect(entries.map(entry => entry.event)).toEqual(['invocation.started', 'invocation.finished']);
            expect(entries[0]?.invocationId).toBe(entries[1]?.invocationId);
          }),
        ),
      ),
    ),
  );

  effectIt.effect.prop(
    'preserves Windows lifecycle pairs across bounded transient exclusive-create failures',
    {
      failures: fc.integer({min: 1, max: 4}),
      reason: fc.constantFrom('Busy' as const, 'PermissionDenied' as const, 'Unknown' as const, 'WouldBlock' as const),
    },
    ({failures, reason}) =>
      TestClock.withLive(
        windowsEntriesAfterTransientLockContention(failures, reason).pipe(
          Effect.flatMap(entries =>
            Effect.sync(() => {
              expect(entries).toHaveLength(2);
              expect(entries[0]?.event).toBe('invocation.started');
              expect(entries[1]?.event).toBe('invocation.finished');
              expect(entries[0]?.invocationId).toBe(entries[1]?.invocationId);
            }),
          ),
        ),
      ),
    {fastCheck: {numRuns: 12}},
  );

  effectIt.effect('keeps a persistent Windows sharing violation best-effort after the short retry cap', () =>
    TestClock.withLive(
      windowsEntriesAfterTransientLockContention(5, 'PermissionDenied').pipe(
        Effect.flatMap(entries =>
          Effect.sync(() => {
            expect(entries).toHaveLength(1);
            expect(entries[0]?.event).toBe('invocation.finished');
          }),
        ),
      ),
    ),
  );

  effectIt.effect('preserves both Windows lifecycle entries when lock contention exceeds five seconds', () =>
    windowsEntriesAfterLockContention(5_500).pipe(
      Effect.flatMap(entries =>
        Effect.sync(() => {
          expect(entries).toHaveLength(2);
          expect(entries.map(entry => entry.event)).toEqual(['invocation.started', 'invocation.finished']);
          expect(entries[0]?.invocationId).toBe(entries[1]?.invocationId);
        }),
      ),
    ),
  );

  effectIt.effect.prop(
    'preserves correlated Windows lifecycle entries across the extended bounded contention window',
    {releaseAfterMilliseconds: fc.integer({min: 5_025, max: 9_500})},
    ({releaseAfterMilliseconds}) =>
      windowsEntriesAfterLockContention(releaseAfterMilliseconds).pipe(
        Effect.flatMap(entries =>
          Effect.sync(() => {
            expect(entries).toHaveLength(2);
            expect(entries[0]?.event).toBe('invocation.started');
            expect(entries[1]?.event).toBe('invocation.finished');
            expect(entries[0]?.invocationId).toBe(entries[1]?.invocationId);
          }),
        ),
      ),
    {fastCheck: {numRuns: 12}},
  );

  effectIt.effect('keeps Windows production logging best-effort at the ten-second contention bound', () =>
    windowsEntriesAfterLockContention(10_025, {awaitApplicationStartBeforeRelease: true}).pipe(
      Effect.flatMap(entries =>
        Effect.sync(() => {
          expect(entries).toHaveLength(1);
          expect(entries[0]?.event).toBe('invocation.finished');
        }),
      ),
    ),
  );

  effectIt.effect('does not replace existing log history when Windows reports non-POSIX file modes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {fs, home, path} = yield* ownedTestHome('windows-file-mode');
        const nativeSystem = yield* SystemInfo;
        const windowsSystem = SystemInfo.of({...nativeSystem, platform: 'win32'});
        const runAsWindows = <A, E, R>(effect: Effect.Effect<A, E, R | SystemInfo>) =>
          effect.pipe(Effect.provideService(SystemInfo, windowsSystem));

        yield* runAsWindows(withProductionLogging(home, {component: 'cli', operation: 'version'}, Effect.void));
        const active = productionLogPath(path, home);
        yield* fs.chmod(active, 0o644);
        yield* runAsWindows(withProductionLogging(home, {component: 'cli', operation: 'doctor'}, Effect.void));

        const entries = parseEntries(yield* fs.readFileString(active));
        expect(entries).toHaveLength(4);
        expect(entries.map(entry => entry.operation)).toEqual(['version', 'version', 'doctor', 'doctor']);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rotates at the configured size and prunes files beyond retention', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {fs, home, path} = yield* ownedTestHome('rotation');
        const retainedRotations = 2;

        for (let index = 0; index < 16; index += 1) {
          yield* withProductionLogging(home, {component: 'cli', operation: 'doctor'}, Effect.void, {
            maxBytes: 1_200,
            rotatedFileCount: retainedRotations,
          });
        }

        const active = productionLogPath(path, home);
        const files = [active, `${active}.1`, `${active}.2`];
        const system = yield* SystemInfo;
        for (const file of files) {
          expect(yield* fs.exists(file)).toBe(true);
          expect(parseEntries(yield* fs.readFileString(file)).length).toBeGreaterThan(0);
          if (system.platform !== 'win32') {
            expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
          }
        }
        if (system.platform !== 'win32') {
          expect((yield* fs.stat(path.join(home, 'logs'))).mode & 0o777).toBe(0o700);
        }
        expect(yield* fs.exists(`${active}.3`)).toBe(false);
        expect((yield* fs.stat(active)).size <= 1_200n).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('lists support files and explains the privacy boundary', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {home, path} = yield* ownedTestHome('listing');
        yield* withProductionLogging(home, {component: 'cli', operation: 'logs'}, Effect.void);
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };

        const report = yield* captureConsole(runProductionLogs(config));

        expect(report.output).toContain(path.join(home, 'logs'));
        expect(report.output).toContain(PRODUCTION_LOG_FILE_NAME);
        expect(report.output).toContain('never command arguments, memory content, recall results, or MCP payloads');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps support excerpts bounded and retains the newest complete entries', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {home} = yield* ownedTestHome('excerpt-budget');
        for (const operation of ['doctor', 'recall', 'remember', 'logs']) {
          yield* withProductionLogging(home, {component: 'cli', operation}, Effect.void);
        }

        const maximumCharacters = 900;
        const excerpt = yield* productionLogSupportExcerpt(home, maximumCharacters);

        expect(excerpt.content.length).toBeLessThanOrEqual(maximumCharacters);
        expect(excerpt.includedEntries).toBeGreaterThan(0);
        expect(excerpt.omittedEntries).toBeGreaterThan(0);
        expect(excerpt.content).toContain('"operation":"logs"');
        expect(excerpt.content.trim().split('\n')).toHaveLength(excerpt.includedEntries);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('bounds oversized support reads and rejects non-file rotations', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {fs, home, path} = yield* ownedTestHome('bounded-read');
        yield* withProductionLogging(home, {component: 'cli', operation: 'doctor'}, Effect.void);
        const active = productionLogPath(path, home);
        const validLine = (yield* fs.readFileString(active)).trim().split('\n')[0] as string;
        yield* fs.writeFileString(active, `${validLine}\n`.repeat(4_000));
        yield* fs.makeDirectory(`${active}.5`);

        const excerpt = yield* productionLogSupportExcerpt(home, 1_000);

        expect(excerpt.content.length).toBeLessThanOrEqual(1_000);
        expect(excerpt.includedEntries).toBeGreaterThan(0);
        expect(excerpt.omittedEntries).toBeGreaterThan(0);
        expect(excerpt.discardedEntries).toBeGreaterThan(0);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not follow active or rotated log symlinks', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {fs, home, path} = yield* ownedTestHome('symlink');
        const system = yield* SystemInfo;
        if (system.platform === 'win32') {
          return;
        }
        const logsRoot = path.join(home, 'logs');
        const active = productionLogPath(path, home);
        const outside = path.join(path.dirname(home), 'outside.log');
        const outsideContent = 'OUTSIDE-LOG-MUST-NOT-CHANGE\n';
        yield* fs.makeDirectory(logsRoot, {recursive: true});
        yield* fs.writeFileString(outside, outsideContent, {mode: 0o644});
        yield* fs.chmod(outside, 0o644);
        yield* fs.symlink(outside, active);

        yield* withProductionLogging(home, {component: 'cli', operation: 'doctor'}, Effect.void);
        yield* fs.symlink(outside, `${active}.5`);
        const excerpt = yield* productionLogSupportExcerpt(home, 1_000);

        expect(yield* fs.readFileString(outside)).toBe(outsideContent);
        expect((yield* fs.stat(outside)).mode & 0o777).toBe(0o644);
        expect(yield* fs.readFileString(active)).toContain('"operation":"doctor"');
        expect(excerpt.content).not.toContain('OUTSIDE-LOG-MUST-NOT-CHANGE');
        expect(excerpt.discardedEntries).toBeGreaterThan(0);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function ownedTestHome(label: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-production-log-${label}-`});
    const home = path.join(root, 'home');
    yield* fs.makeDirectory(home, {recursive: true});
    yield* fs.writeFileString(
      path.join(home, 'layout.json'),
      `${JSON.stringify({createdBy: 'threadnote', version: 2})}\n`,
      {mode: 0o600},
    );
    return {fs, home, path};
  });
}

function windowsEntriesAfterLockContention(
  releaseAfterMilliseconds: number,
  options: {readonly awaitApplicationStartBeforeRelease?: boolean} = {},
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const {fs, home, path} = yield* ownedTestHome(`windows-contention-${releaseAfterMilliseconds}`);
      const lockPath = path.join(home, 'locks', 'production-log.lock');
      const acquired = yield* Deferred.make<void>();
      const contentionObserved = yield* Deferred.make<void>();
      const applicationStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const ownerFiber = yield* withExclusiveFileLock(
        fs,
        lockPath,
        {
          retryIntervalMilliseconds: 25,
          staleAfterMilliseconds: 30_000,
          waitTimeoutMilliseconds: 20_000,
        },
        Effect.gen(function* () {
          yield* Deferred.succeed(acquired, undefined);
          yield* Deferred.await(release);
        }),
      ).pipe(Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(acquired);

      const observedFs = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (candidate, content, options) =>
          fs
            .writeFileString(candidate, content, options)
            .pipe(
              Effect.tapError(() =>
                candidate === lockPath ? Deferred.succeed(contentionObserved, undefined) : Effect.void,
              ),
            ),
      });
      const nativeSystem = yield* SystemInfo;
      const windowsSystem = SystemInfo.of({...nativeSystem, platform: 'win32'});
      const writerFiber = yield* withProductionLogging(
        home,
        {component: 'cli', operation: 'logs'},
        Deferred.succeed(applicationStarted, undefined),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, observedFs),
        Effect.provideService(SystemInfo, windowsSystem),
        Effect.forkChild({startImmediately: true}),
      );
      yield* Deferred.await(contentionObserved);

      yield* TestClock.adjust(releaseAfterMilliseconds);
      if (options.awaitApplicationStartBeforeRelease === true) {
        // Keep the owner locked until the first log write has observed the virtual deadline. Otherwise a busy host can
        // resume the owner before the contender after TestClock's cooperative wake-up and make this boundary racy.
        yield* Deferred.await(applicationStarted);
      }
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(ownerFiber);
      yield* TestClock.adjust(25);
      yield* Fiber.join(writerFiber);

      return parseEntries(yield* fs.readFileString(productionLogPath(path, home)));
    }),
  ).pipe(provideTestLayer(ApplicationLayer));
}

function windowsEntriesAfterTransientLockContention(
  failureCount: number,
  reason: 'Busy' | 'PermissionDenied' | 'Unknown' | 'WouldBlock',
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const {fs, home, path} = yield* ownedTestHome(`windows-transient-contention-${reason}-${failureCount}`);
      const lockPath = path.join(home, 'locks', 'production-log.lock');
      let remainingFailures = failureCount;
      const contendedFs = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (candidate, content, options) =>
          candidate === lockPath && remainingFailures > 0
            ? Effect.sync(() => {
                remainingFailures -= 1;
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    PlatformError.systemError({
                      _tag: reason,
                      cause: reason === 'Unknown' ? {code: 'EPERM'} : undefined,
                      method: 'writeFileString',
                      module: 'FileSystem',
                      pathOrDescriptor: candidate,
                    }),
                  ),
                ),
              )
            : fs.writeFileString(candidate, content, options),
      });
      const nativeSystem = yield* SystemInfo;
      const windowsSystem = SystemInfo.of({...nativeSystem, platform: 'win32'});

      yield* withProductionLogging(home, {component: 'cli', operation: 'logs'}, Effect.void).pipe(
        Effect.provideService(FileSystem.FileSystem, contendedFs),
        Effect.provideService(SystemInfo, windowsSystem),
      );

      return parseEntries(yield* fs.readFileString(productionLogPath(path, home)));
    }),
  ).pipe(provideTestLayer(ApplicationLayer));
}

function productionLogPath(path: Path.Path, home: string): string {
  return path.join(home, 'logs', PRODUCTION_LOG_FILE_NAME);
}

function parseEntries(content: string): readonly ParsedProductionLogEntry[] {
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as ParsedProductionLogEntry);
}
