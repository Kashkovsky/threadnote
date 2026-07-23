import {Effect, Result} from 'effect';
import {describe, expect, it} from 'vitest';
import {CommandExecutor, runCommandEffect, runStreamingCommandEffect} from '../../src/effect/command.js';

const run = <A, E>(effect: Effect.Effect<A, E, CommandExecutor>) =>
  Effect.runPromise(effect.pipe(Effect.provide(CommandExecutor.layer)));

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
    await expect(
      run(
        runStreamingCommandEffect(process.execPath, ['-e', 'setInterval(() => undefined, 1000)']).pipe(
          Effect.timeout(25),
        ),
      ),
    ).rejects.toThrow();
  });
});
