import {access, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NodeFileSystem} from '@effect/platform-node';
import {expect, it} from '@effect/vitest';
import {Effect, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import {describe} from 'vitest';
import {
  activateLaunchAgent,
  isExpectedLaunchdProcessCommand,
  launchAgentHealthIsStable,
  stageLaunchAgentPlist,
  waitForLaunchAgentHealthWithEffects,
  type LaunchAgentActivationEffects,
  type LaunchAgentHealthEffects,
} from '../../src/lifecycle.js';
import type {RuntimeConfig} from '../../src/types.js';

function runtime(): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: '/tmp/threadnote-launchd-test',
    agentId: 'threadnote',
    host: '127.0.0.1',
    manifestPath: '/tmp/threadnote-launchd-test/seed-manifest.yaml',
    openVikingVersion: '0.4.10',
    port: 1933,
    user: 'denys',
  };
}

function activationEffects(
  events: string[],
  overrides: Partial<LaunchAgentActivationEffects> = {},
): LaunchAgentActivationEffects {
  const record = <A>(event: string, value: A): Effect.Effect<A> =>
    Effect.sync(() => {
      events.push(event);
      return value;
    });
  return {
    bootout: () => record('bootout', true),
    bootstrap: () => record('bootstrap', undefined),
    isPortOpen: () => record('port', false),
    stagePlist: () =>
      record('stage', {
        hadPrevious: false,
        commit: record('commit', undefined),
        release: record('release', undefined),
        rollback: record('rollback', undefined),
      }),
    stopDetached: () => record('stop-detached', false),
    restartDetached: () => record('restart-detached', undefined),
    waitForHealth: () => record('health', 'healthy'),
    waitForShutdown: () => record('shutdown', true),
    ...overrides,
  };
}

describe('activateLaunchAgent', () => {
  it.effect('moves a loaded detached server to launchd before accepting health', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const health = yield* activateLaunchAgent(
        runtime(),
        '/tmp/threadnote.plist',
        '<plist/>',
        60_000,
        activationEffects(events),
      );

      expect(health).toBe('healthy');
      expect(events).toEqual([
        'stage',
        'bootout',
        'stop-detached',
        'shutdown',
        'port',
        'commit',
        'bootstrap',
        'health',
        'release',
      ]);
    }),
  );

  it.effect('refuses to bootstrap while another healthy server remains', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const effects = activationEffects(events, {
        waitForShutdown: () =>
          Effect.sync(() => {
            events.push('shutdown');
            return false;
          }),
      });

      const error = yield* activateLaunchAgent(runtime(), '/tmp/threadnote.plist', '<plist/>', 60_000, effects).pipe(
        Effect.flip,
      );
      expect(String(error)).toContain('still running outside Threadnote');
      expect(events).toEqual(['stage', 'bootout', 'stop-detached', 'shutdown', 'rollback', 'bootstrap', 'release']);
    }),
  );

  it.effect('refuses to bootstrap while the configured port remains occupied', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const effects = activationEffects(events, {
        isPortOpen: () =>
          Effect.sync(() => {
            events.push('port');
            return true;
          }),
      });

      const error = yield* activateLaunchAgent(runtime(), '/tmp/threadnote.plist', '<plist/>', 60_000, effects).pipe(
        Effect.flip,
      );
      expect(String(error)).toContain('Port 127.0.0.1:1933 is still in use');
      expect(events).toEqual([
        'stage',
        'bootout',
        'stop-detached',
        'shutdown',
        'port',
        'rollback',
        'bootstrap',
        'release',
      ]);
    }),
  );

  it.effect('passes one decreasing timeout budget through activation', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const timeouts: number[] = [];
      const timed = <A>(event: string, timeoutMs: number, value: A) =>
        Effect.gen(function* () {
          timeouts.push(timeoutMs);
          events.push(event);
          yield* TestClock.adjust(10);
          return value;
        });
      const effects = activationEffects(events, {
        bootout: timeoutMs => timed('bootout', timeoutMs, true),
        bootstrap: (_plistPath, timeoutMs) => timed('bootstrap', timeoutMs, undefined),
        stopDetached: (_config, timeoutMs) => timed('stop-detached', timeoutMs, false),
        waitForShutdown: (_config, timeoutMs) => timed('shutdown', timeoutMs, true),
        isPortOpen: (_config, timeoutMs) => timed('port', timeoutMs, false),
        waitForHealth: (_config, timeoutMs) => timed('health', timeoutMs, 'healthy'),
      });

      yield* activateLaunchAgent(runtime(), '/tmp/threadnote.plist', '<plist/>', 1000, effects);

      expect(timeouts).toHaveLength(6);
      expect(timeouts.every(timeoutMs => timeoutMs > 0 && timeoutMs <= 1000)).toBe(true);
      expect(timeouts.every((timeoutMs, index) => index === 0 || timeoutMs < timeouts[index - 1]!)).toBe(true);
      expect(events).toEqual([
        'stage',
        'bootout',
        'stop-detached',
        'shutdown',
        'port',
        'commit',
        'bootstrap',
        'health',
        'release',
      ]);
    }),
  );

  it.effect('enforces the outer deadline and does not start the next activation boundary', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const effects = activationEffects(events, {
        bootout: () =>
          Effect.gen(function* () {
            events.push('bootout');
            yield* Effect.never;
            return true;
          }),
      });
      const fiber = yield* activateLaunchAgent(runtime(), '/tmp/threadnote.plist', '<plist/>', 1000, effects).pipe(
        Effect.flip,
        Effect.forkChild,
      );

      yield* TestClock.adjust(1000);

      expect(String(yield* Fiber.join(fiber))).toContain('timed out');
      expect(events).toEqual(['stage', 'bootout', 'rollback', 'release']);
    }),
  );

  it.effect('rolls back the staged plist and restores the previous service after bootstrap fails', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const record = (event: string) =>
        Effect.sync(() => {
          events.push(event);
        });
      const effects = activationEffects(events, {
        bootstrap: () => record('bootstrap').pipe(Effect.andThen(Effect.fail(new Error('bootstrap failed')))),
        stagePlist: () =>
          Effect.succeed({
            hadPrevious: true,
            commit: record('commit'),
            release: record('release'),
            rollback: record('rollback'),
          }),
      });

      const error = yield* activateLaunchAgent(runtime(), '/tmp/threadnote.plist', '<plist/>', 60_000, effects).pipe(
        Effect.flip,
      );

      expect(String(error)).toContain('bootstrap failed');
      expect(events).toEqual([
        'bootout',
        'stop-detached',
        'shutdown',
        'port',
        'commit',
        'bootstrap',
        'bootout',
        'rollback',
        'bootstrap',
        'release',
      ]);
    }),
  );

  it.effect('does not start a previously unloaded launch agent during recovery', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const effects = activationEffects(events, {
        bootout: () =>
          Effect.sync(() => {
            events.push('bootout');
            return events.filter(event => event === 'bootout').length > 1;
          }),
        bootstrap: () => Effect.fail(new Error('bootstrap failed')),
      });

      yield* activateLaunchAgent(runtime(), '/tmp/threadnote.plist', '<plist/>', 60_000, effects).pipe(Effect.flip);

      expect(events).toEqual([
        'stage',
        'bootout',
        'stop-detached',
        'shutdown',
        'port',
        'commit',
        'bootout',
        'rollback',
        'release',
      ]);
    }),
  );

  it.effect('restarts a detached server that the failed migration stopped', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const effects = activationEffects(events, {
        bootout: () =>
          Effect.sync(() => {
            events.push('bootout');
            return false;
          }),
        bootstrap: () => Effect.fail(new Error('bootstrap failed')),
        stopDetached: () =>
          Effect.sync(() => {
            events.push('stop-detached');
            return true;
          }),
      });

      yield* activateLaunchAgent(runtime(), '/tmp/threadnote.plist', '<plist/>', 60_000, effects).pipe(Effect.flip);

      expect(events).toContain('restart-detached');
      expect(events).not.toContain('bootstrap');
    }),
  );

  it.effect('surfaces recovery failure together with the activation failure', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const effects = activationEffects(events, {
        bootstrap: () => Effect.fail(new Error('bootstrap failed')),
        stagePlist: () =>
          Effect.succeed({
            hadPrevious: true,
            commit: Effect.void,
            release: Effect.void,
            rollback: Effect.fail(new Error('rollback failed')),
          }),
      });

      const error = yield* activateLaunchAgent(runtime(), '/tmp/threadnote.plist', '<plist/>', 60_000, effects).pipe(
        Effect.flip,
      );

      expect(String(error)).toContain('bootstrap failed');
      expect(String(error)).toContain('rollback failed');
    }),
  );

  it.effect('bounds stalled recovery with a separate cleanup timeout', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const effects = activationEffects(events, {
        bootstrap: () => Effect.fail(new Error('bootstrap failed')),
        stagePlist: () =>
          Effect.succeed({
            hadPrevious: true,
            commit: Effect.void,
            release: Effect.void,
            rollback: Effect.never,
          }),
      });
      const fiber = yield* activateLaunchAgent(runtime(), '/tmp/threadnote.plist', '<plist/>', 60_000, effects).pipe(
        Effect.flip,
        Effect.forkChild,
      );

      yield* TestClock.adjust(2000);

      expect(String(yield* Fiber.join(fiber))).toContain('recovery timed out');
    }),
  );
});

describe('stageLaunchAgentPlist', () => {
  it('atomically commits and restores a mode-0600 staged plist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadnote-plist-test-'));
    const plistPath = join(directory, 'agent.plist');
    const stagePath = `${plistPath}.threadnote-stage-${process.pid}`;
    await writeFile(plistPath, 'previous');
    try {
      const transaction = await Effect.runPromise(
        stageLaunchAgentPlist(plistPath, 'replacement').pipe(Effect.provide(NodeFileSystem.layer)),
      );
      expect((await stat(stagePath)).mode & 0o777).toBe(0o600);
      await Effect.runPromise(transaction.commit);
      expect(await readFile(plistPath, 'utf8')).toBe('replacement');
      await Effect.runPromise(transaction.rollback);
      expect(await readFile(plistPath, 'utf8')).toBe('previous');
      await Effect.runPromise(transaction.release);
      await expect(access(`${plistPath}.threadnote-lock`)).rejects.toThrow();
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  it('refuses to overwrite a concurrent destination edit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadnote-plist-test-'));
    const plistPath = join(directory, 'agent.plist');
    await writeFile(plistPath, 'previous');
    try {
      const transaction = await Effect.runPromise(
        stageLaunchAgentPlist(plistPath, 'replacement').pipe(Effect.provide(NodeFileSystem.layer)),
      );
      await writeFile(plistPath, 'external edit');

      await expect(Effect.runPromise(transaction.commit)).rejects.toThrow('changed while activation was staged');
      expect(await readFile(plistPath, 'utf8')).toBe('external edit');
      await expect(Effect.runPromise(transaction.rollback)).rejects.toThrow(
        'changed before activation could roll back',
      );
      expect(await readFile(plistPath, 'utf8')).toBe('external edit');
      await Effect.runPromise(transaction.release);
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });
});

describe('launchAgentHealthIsStable', () => {
  it('requires the same running launchd pid before and after health responds', () => {
    expect(
      launchAgentHealthIsStable({loaded: true, pid: 42, running: true}, 'healthy', {
        loaded: true,
        pid: 42,
        running: true,
      }),
    ).toBe(true);
    expect(
      launchAgentHealthIsStable({loaded: true, pid: 42, running: true}, 'healthy', {
        loaded: true,
        pid: 43,
        running: true,
      }),
    ).toBe(false);
  });
});

describe('isExpectedLaunchdProcessCommand', () => {
  const server = '/Users/test/.local/bin/openviking-server';
  const interpreter = '/usr/bin/python3';
  const args = ['--config', '/Users/test/.openviking/ov.conf', '--host', '127.0.0.1', '--port', '1933'];

  it('accepts only a direct command or its verified shebang interpreter', () => {
    const direct = [server, ...args].join(' ');

    expect(isExpectedLaunchdProcessCommand(direct, server, args, interpreter)).toBe(true);
    expect(isExpectedLaunchdProcessCommand(`${interpreter} ${direct}`, server, args, interpreter)).toBe(true);
    expect(isExpectedLaunchdProcessCommand(`/usr/bin/ruby ${direct}`, server, args, interpreter)).toBe(false);
  });

  it('rejects an unrelated process padded with the expected arguments', () => {
    const direct = [server, ...args].join(' ');

    expect(isExpectedLaunchdProcessCommand(`/usr/bin/node -e malicious 1933 ${direct}`, server, args)).toBe(false);
  });
});

describe('waitForLaunchAgentHealth', () => {
  it.effect('retries a pid change and requires the launchd pid to own the port', () =>
    Effect.gen(function* () {
      const timeouts: number[] = [];
      const statuses = [
        {loaded: true, pid: 42, running: true},
        {loaded: true, pid: 43, running: true},
        {loaded: true, pid: 43, running: true},
        {loaded: true, pid: 43, running: true},
      ];
      const effects: LaunchAgentHealthEffects = {
        ownsPort: (_pid, _config, timeoutMs) =>
          Effect.gen(function* () {
            timeouts.push(timeoutMs);
            yield* Effect.sleep(10);
            return true;
          }),
        readHealth: (_config, timeoutMs) =>
          Effect.gen(function* () {
            timeouts.push(timeoutMs);
            yield* Effect.sleep(10);
            return 'healthy';
          }),
        readStatus: timeoutMs =>
          Effect.gen(function* () {
            timeouts.push(timeoutMs);
            yield* Effect.sleep(10);
            return statuses.shift() ?? {loaded: true, pid: 43, running: true};
          }),
      };
      const fiber = yield* waitForLaunchAgentHealthWithEffects(runtime(), 2000, 'waiting', effects).pipe(
        Effect.forkChild,
      );

      yield* TestClock.adjust(1000);

      expect(yield* Fiber.join(fiber)).toBe('healthy');
      expect(timeouts).toHaveLength(10);
      expect(timeouts.every(timeoutMs => timeoutMs > 0 && timeoutMs <= 1000)).toBe(true);
      expect(timeouts.every((timeoutMs, index) => index === 0 || timeoutMs <= timeouts[index - 1]!)).toBe(true);
    }),
  );

  it.effect('retries healthy responses until the launchd pid owns the port before and after the request', () =>
    Effect.gen(function* () {
      let ownershipChecks = 0;
      let healthChecks = 0;
      const effects: LaunchAgentHealthEffects = {
        ownsPort: () => Effect.succeed(++ownershipChecks > 1),
        readHealth: () =>
          Effect.sync(() => {
            healthChecks += 1;
            return 'healthy';
          }),
        readStatus: () => Effect.succeed({loaded: true, pid: 42, running: true}),
      };
      const fiber = yield* waitForLaunchAgentHealthWithEffects(runtime(), 2000, 'waiting', effects).pipe(
        Effect.forkChild,
      );

      yield* TestClock.adjust(500);

      expect(yield* Fiber.join(fiber)).toBe('healthy');
      expect(ownershipChecks).toBe(3);
      expect(healthChecks).toBe(1);
    }),
  );

  it.effect('stops polling when the deadline expires', () =>
    Effect.gen(function* () {
      const effects: LaunchAgentHealthEffects = {
        ownsPort: () => Effect.succeed(false),
        readHealth: () => Effect.succeed(undefined),
        readStatus: () => Effect.succeed({loaded: true, running: false}),
      };
      const fiber = yield* waitForLaunchAgentHealthWithEffects(runtime(), 1000, 'waiting', effects).pipe(
        Effect.forkChild,
      );

      yield* TestClock.adjust(1000);

      expect(yield* Fiber.join(fiber)).toBeUndefined();
    }),
  );
});
