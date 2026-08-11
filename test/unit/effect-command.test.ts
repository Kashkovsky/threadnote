import {TestError} from '../helpers/test-error.js';
import {Clock, Effect, Fiber, FileSystem, Path, Result} from 'effect';
import {describe, expect, it} from 'vitest';
import {runBinaryCommandEffect, runCommandEffect, runStreamingCommandEffect} from '../../src/effect/command.js';
import {runEffect as run} from '../helpers/effect-runtime.js';

describe('Effect CommandExecutor', () => {
  it('returns captured output for successful commands', async () => {
    const result = await run(runCommandEffect(process.execPath, ['-e', 'process.stdout.write("ok")']));

    expect(result).toEqual({exitCode: 0, stderr: '', stdout: 'ok'});
  });

  it('collects chunked binary output without changing byte order', async () => {
    const result = await run(
      runBinaryCommandEffect(process.execPath, [
        '-e',
        'for (let index = 0; index < 1024; index += 1) process.stdout.write(Buffer.alloc(4096, index % 251))',
      ]),
    );

    expect(result.stdout.byteLength).toBe(4 * 1_048_576);
    expect(result.stdout[0]).toBe(0);
    expect(result.stdout[4096]).toBe(1);
    expect(result.stdout.at(-1)).toBe(1023 % 251);
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
            'require("../helpers/node-fs.js").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000)',
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
            return yield* Effect.fail(new TestError('Streaming child did not report readiness.'));
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
