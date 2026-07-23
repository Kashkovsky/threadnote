import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {expect as effectExpect, it as effectIt} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect, it} from 'vitest';
import {
  bootoutLaunchAgent,
  bootstrapLaunchAgent,
  isLaunchAgentRunning,
  launchAgentDomainTarget,
  launchAgentServiceTarget,
  parseLaunchAgentStatus,
} from '../../src/launchd.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {SystemInfo} from '../../src/effect/system.js';
import {runEffect} from '../helpers/effect-runtime.js';

const originalPath = process.env.PATH;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {force: true, recursive: true})));
});

async function fakeLaunchctl(): Promise<{executable: string; logPath: string}> {
  const directory = await mkdtemp(join(tmpdir(), 'threadnote-launchctl-test-'));
  temporaryDirectories.push(directory);
  const executable = join(directory, 'launchctl');
  const logPath = join(directory, 'commands.log');
  const statePath = join(directory, 'loaded');
  await writeFile(statePath, '1\n');
  await writeFile(
    executable,
    [
      '#!/bin/sh',
      `log=${JSON.stringify(logPath)}`,
      `state=${JSON.stringify(statePath)}`,
      'printf \'%s\\n\' "$*" >> "$log"',
      'if [ "$1" = "print" ]; then',
      '  if [ "$(/bin/cat "$state")" = "1" ]; then',
      "    printf 'state = running\\npid = 123\\n'",
      '    exit 0',
      '  fi',
      "  printf 'Could not find service\\n' >&2",
      '  exit 113',
      'fi',
      'if [ "$1" = "bootout" ]; then',
      '  printf \'0\\n\' > "$state"',
      'fi',
      '',
    ].join('\n'),
  );
  await chmod(executable, 0o755);
  process.env.PATH = [directory, ...(originalPath ? [originalPath] : [])].join(delimiter);
  return {executable, logPath};
}

describe('macOS LaunchAgent lifecycle', () => {
  it('builds explicit per-user launchctl targets', () => {
    expect(launchAgentDomainTarget(502)).toBe('gui/502');
    expect(launchAgentServiceTarget(502)).toBe('gui/502/io.threadnote.openviking');
  });

  it('uses bootout, enable, and bootstrap for a persistent user agent', async () => {
    const {logPath} = await fakeLaunchctl();
    const plistPath = '/Users/test/Library/LaunchAgents/io.threadnote.openviking.plist';

    await runEffect(bootoutLaunchAgent(false, 502));
    await runEffect(bootstrapLaunchAgent(plistPath, false, 502));

    expect((await readFile(logPath, 'utf8')).trim().split('\n')).toEqual([
      'print gui/502/io.threadnote.openviking',
      'bootout gui/502/io.threadnote.openviking',
      'print gui/502/io.threadnote.openviking',
      'enable gui/502/io.threadnote.openviking',
      `bootstrap gui/502 ${plistPath}`,
    ]);
  });

  it('requires launchctl to report a running process', async () => {
    await fakeLaunchctl();

    expect(await runEffect(isLaunchAgentRunning(502))).toBe(true);
  });

  it('does not treat a loaded job without a running pid as ready', () => {
    expect(parseLaunchAgentStatus('state = running\n', 0)).toEqual({
      loaded: true,
      running: false,
    });
    expect(parseLaunchAgentStatus('state = waiting\nlast exit code = 1\n', 0)).toEqual({
      loaded: true,
      running: false,
    });
    expect(parseLaunchAgentStatus('Could not find service', 113)).toEqual({loaded: false, running: false});
    expect(() => parseLaunchAgentStatus('Not privileged', 1)).toThrow('launchctl print failed');
  });

  effectIt.effect('threads one decreasing timeout through bootout commands', () =>
    Effect.gen(function* () {
      const timeouts: number[] = [];
      let call = 0;
      const executor = Layer.succeed(
        CommandExecutor,
        CommandExecutor.of({
          execute: (_executable, _args, options) =>
            Effect.gen(function* () {
              timeouts.push(options?.timeoutMs ?? -1);
              yield* TestClock.adjust(10);
              call += 1;
              if (call === 1) {
                return {exitCode: 0, stderr: '', stdout: 'state = running\npid = 123\n'};
              }
              if (call === 3) {
                return {exitCode: 113, stderr: 'Could not find service', stdout: ''};
              }
              return {exitCode: 0, stderr: '', stdout: ''};
            }),
        }),
      );

      yield* bootoutLaunchAgent(false, 502, 1000).pipe(Effect.provide(executor), Effect.provide(SystemInfo.layer));

      effectExpect(timeouts).toEqual([1000, 990, 980]);
    }),
  );

  effectIt.effect('threads one decreasing timeout through bootstrap commands', () =>
    Effect.gen(function* () {
      const timeouts: number[] = [];
      const executor = Layer.succeed(
        CommandExecutor,
        CommandExecutor.of({
          execute: (_executable, _args, options) =>
            Effect.gen(function* () {
              timeouts.push(options?.timeoutMs ?? -1);
              yield* TestClock.adjust(10);
              return {exitCode: 0, stderr: '', stdout: ''};
            }),
        }),
      );

      yield* bootstrapLaunchAgent('/tmp/agent.plist', false, 502, 1000).pipe(
        Effect.provide(executor),
        Effect.provide(SystemInfo.layer),
      );

      effectExpect(timeouts).toEqual([1000, 990]);
    }),
  );

  effectIt.effect('fails when bootout leaves the service loaded', () =>
    Effect.gen(function* () {
      const executor = Layer.succeed(
        CommandExecutor,
        CommandExecutor.of({
          execute: (_executable, args) =>
            Effect.succeed(
              args[0] === 'print'
                ? {exitCode: 0, stderr: '', stdout: 'state = running\npid = 123\n'}
                : {exitCode: 0, stderr: '', stdout: ''},
            ),
        }),
      );

      const error = yield* bootoutLaunchAgent(false, 502, 1000).pipe(
        Effect.provide(executor),
        Effect.provide(SystemInfo.layer),
        Effect.flip,
      );

      effectExpect(String(error)).toContain('did not unload');
    }),
  );

  effectIt.effect('treats an absent service as an idempotent bootout success', () =>
    Effect.gen(function* () {
      let calls = 0;
      const executor = Layer.succeed(
        CommandExecutor,
        CommandExecutor.of({
          execute: () => {
            calls += 1;
            return Effect.succeed({exitCode: 113, stderr: 'Could not find service', stdout: ''});
          },
        }),
      );

      yield* bootoutLaunchAgent(false, 502, 1000).pipe(Effect.provide(executor), Effect.provide(SystemInfo.layer));

      effectExpect(calls).toBe(1);
    }),
  );
});
