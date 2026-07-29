import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {
  PRODUCTION_LOG_FILE_NAME,
  productionLogSupportExcerpt,
  runProductionLogs,
  withProductionLogging,
} from '../../src/effect/production_log.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import type {RuntimeConfig} from '../../src/types.js';
import {captureConsole} from '../../src/effect/console.js';
import {SystemInfo} from '../../src/effect/system.js';

interface ParsedProductionLogEntry {
  readonly component: string;
  readonly errorType?: string;
  readonly event: string;
  readonly invocationId: string;
  readonly operation: string;
  readonly outcome?: string;
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
    ).pipe(Effect.provide(ApplicationLayer)),
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
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  effectIt.effect('blocks credential-shaped failure types and throwing diagnostic getters', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {fs, home, path} = yield* ownedTestHome('unsafe-error-types');
        const secretType = 'sk-1234567890abcdefghijkl';
        const secretNamedFailure = new Error('private');
        secretNamedFailure.name = secretType;
        const taggedFailure = {_tag: secretType};
        const throwingFailure = new Proxy(
          {},
          {
            get: () => {
              throw new Error('diagnostic getter should not escape');
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
    ).pipe(Effect.provide(ApplicationLayer)),
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
    ).pipe(Effect.provide(ApplicationLayer)),
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
    ).pipe(Effect.provide(ApplicationLayer)),
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
    ).pipe(Effect.provide(ApplicationLayer)),
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
    ).pipe(Effect.provide(ApplicationLayer)),
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
    ).pipe(Effect.provide(ApplicationLayer)),
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
    ).pipe(Effect.provide(ApplicationLayer)),
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
    ).pipe(Effect.provide(ApplicationLayer)),
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
    ).pipe(Effect.provide(ApplicationLayer)),
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
    ).pipe(Effect.provide(ApplicationLayer)),
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
