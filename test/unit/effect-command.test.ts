import {Clock, Effect, Fiber, FileSystem, Path, Result} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  commandEnvironment,
  isOpenVikingCliExecutable,
  runCommandEffect,
  runStreamingCommandEffect,
} from '../../src/effect/command.js';
import {runEffect as run} from '../helpers/effect-runtime.js';

describe('Effect CommandExecutor', () => {
  it('returns captured output for successful commands', async () => {
    const result = await run(runCommandEffect(process.execPath, ['-e', 'process.stdout.write("ok")']));

    expect(result).toEqual({exitCode: 0, stderr: '', stdout: 'ok'});
  });

  it('models non-zero exits in the typed error channel', async () => {
    const result = await run(
      runCommandEffect(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(7)']).pipe(
        Effect.match({onFailure: Result.fail, onSuccess: Result.succeed}),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result) && result.failure._tag === 'CommandFailed') {
      expect(result.failure.exitCode).toBe(7);
      expect(result.failure.stderr).toBe('bad');
    }
  });

  it('redacts sensitive command arguments from typed failures', async () => {
    const secret = 'manager-bearer-token-value';
    const result = await run(
      runCommandEffect(process.execPath, [
        '-e',
        'process.stderr.write(process.argv[1]); process.exit(7)',
        `Authorization: Bearer ${secret}`,
      ]).pipe(Effect.match({onFailure: Result.fail, onSuccess: Result.succeed})),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(JSON.stringify(result.failure)).not.toContain(secret);
      expect(result.failure.message).toContain('[REDACTED]');
    }
  });

  it('models timeouts without throwing an untyped Error', async () => {
    const result = await run(
      runCommandEffect(process.execPath, ['-e', 'setTimeout(() => undefined, 5000)'], {timeoutMs: 25}).pipe(
        Effect.match({onFailure: Result.fail, onSuccess: Result.succeed}),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result) && result.failure._tag === 'CommandTimedOut') {
      expect(result.failure.timeoutMs).toBe(25);
    }
  });

  it('preserves allowFailure compatibility for callers that inspect exit codes', async () => {
    const result = await run(
      runCommandEffect(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)'], {
        allowFailure: true,
      }),
    );

    expect(result).toEqual({exitCode: 3, stderr: 'bad', stdout: ''});
  });

  it('interrupts streaming commands through the command boundary', async () => {
    const childPid = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const pathService = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-streaming-command-'});
          const pidPath = pathService.join(directory, 'child.pid');
          const fiber = yield* runStreamingCommandEffect(process.execPath, [
            '-e',
            'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000)',
            pidPath,
          ]).pipe(Effect.forkScoped);
          const deadline = (yield* Clock.currentTimeMillis) + 5000;
          let pid: number | undefined;
          while ((yield* Clock.currentTimeMillis) < deadline) {
            const content = yield* fs.readFileString(pidPath).pipe(Effect.catch(() => Effect.succeed(undefined)));
            const candidate = Number(content);
            if (Number.isInteger(candidate) && candidate > 0) {
              pid = candidate;
              break;
            }
            yield* Effect.sleep(10);
          }
          if (pid === undefined) {
            return yield* Effect.fail(new Error('Streaming child did not report readiness.'));
          }
          yield* Fiber.interrupt(fiber);
          return pid;
        }),
      ),
    );

    expect(isProcessRunning(childPid)).toBe(false);
  });

  it('supports inherited output for interactive streaming commands', async () => {
    const result = await run(
      runStreamingCommandEffect(process.execPath, ['-e', 'process.exit(0)'], {inheritOutput: true}),
    );

    expect(result).toEqual({exitCode: 0, stderr: '', stdout: ''});
  });

  it('injects Threadnote config paths into OpenViking CLI commands', async () => {
    const result = await run(
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        const threadnoteHome = pathService.join('workspace', 'threadnote home');
        return {
          environment: commandEnvironment(
            pathService.join('tools', 'ov.exe'),
            undefined,
            {PATH: 'tools', THREADNOTE_HOME: threadnoteHome},
            pathService,
          ),
          expectedCliConfig: pathService.join(threadnoteHome, 'ovcli.conf'),
          expectedServerConfig: pathService.join(threadnoteHome, 'ov.conf'),
        };
      }),
    );

    expect(result.environment).toMatchObject({
      OPENVIKING_CLI_CONFIG_FILE: result.expectedCliConfig,
      OPENVIKING_CONFIG_FILE: result.expectedServerConfig,
      PATH: 'tools',
    });
  });

  it('preserves explicit OpenViking config overrides', async () => {
    const environment = await run(
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        return commandEnvironment(
          'openviking',
          {
            OPENVIKING_CLI_CONFIG_FILE: 'custom-cli.json',
            OPENVIKING_CONFIG_FILE: 'custom-server.json',
            THREADNOTE_HOME: 'threadnote-home',
          },
          {},
          pathService,
        );
      }),
    );

    expect(environment).toMatchObject({
      OPENVIKING_CLI_CONFIG_FILE: 'custom-cli.json',
      OPENVIKING_CONFIG_FILE: 'custom-server.json',
    });
    expect(isOpenVikingCliExecutable('C:\\tools\\ov.EXE')).toBe(true);
    expect(isOpenVikingCliExecutable('/tools/openviking')).toBe(true);
    expect(isOpenVikingCliExecutable('/tools/openviking-server')).toBe(false);
  });
});

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    return !(
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      (cause as {readonly code?: unknown}).code === 'ESRCH'
    );
  }
}
