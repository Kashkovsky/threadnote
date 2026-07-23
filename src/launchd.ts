import {Clock, Effect, Path} from 'effect';
import {LAUNCHD_LABEL} from './constants.js';
import {maybeRunEffect, runCommandEffect} from './effect/command.js';
import {applicationError} from './effect/errors.js';
import {SystemInfo} from './effect/system.js';

export interface LaunchAgentStatus {
  readonly loaded: boolean;
  readonly pid?: number;
  readonly running: boolean;
}

export const launchAgentPath = Effect.fn('launchd.launchAgentPath')(function* () {
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  return pathService.join(system.homeDirectory, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
});

export function launchAgentDomainTarget(uid: number): string {
  return `gui/${uid}`;
}

export function launchAgentServiceTarget(uid: number): string {
  return `${launchAgentDomainTarget(uid)}/${LAUNCHD_LABEL}`;
}

export const bootoutLaunchAgent = Effect.fn('bootoutLaunchAgent')(function* (
  dryRun: boolean,
  uid?: number,
  timeoutMs?: number,
) {
  const resolvedUid = yield* resolveUserId(uid);
  const serviceTarget = launchAgentServiceTarget(resolvedUid);
  if (dryRun) {
    yield* maybeRunEffect(true, 'launchctl', ['bootout', serviceTarget]);
    return true;
  }

  const deadline = yield* deadlineFromTimeout(timeoutMs);
  if (!(yield* readLaunchAgentStatus(resolvedUid, yield* remainingTimeout(deadline))).loaded) {
    return false;
  }
  yield* maybeRunEffect(false, 'launchctl', ['bootout', serviceTarget], {
    timeoutMs: yield* remainingTimeout(deadline),
  });
  if ((yield* readLaunchAgentStatus(resolvedUid, yield* remainingTimeout(deadline))).loaded) {
    return yield* Effect.fail(new Error(`launchctl bootout did not unload ${serviceTarget}.`));
  }
  return true;
});

export const bootstrapLaunchAgent = Effect.fn('bootstrapLaunchAgent')(function* (
  plistPath: string,
  dryRun: boolean,
  uid?: number,
  timeoutMs?: number,
) {
  const resolvedUid = yield* resolveUserId(uid);
  const domainTarget = launchAgentDomainTarget(resolvedUid);
  const serviceTarget = launchAgentServiceTarget(resolvedUid);
  const deadline = yield* deadlineFromTimeout(timeoutMs);
  yield* maybeRunEffect(dryRun, 'launchctl', ['enable', serviceTarget], {
    timeoutMs: yield* remainingTimeout(deadline),
  });
  yield* maybeRunEffect(dryRun, 'launchctl', ['bootstrap', domainTarget, plistPath], {
    timeoutMs: yield* remainingTimeout(deadline),
  });
});

export const readLaunchAgentStatus = Effect.fn('readLaunchAgentStatus')(function* (uid?: number, timeoutMs?: number) {
  const resolvedUid = yield* resolveUserId(uid);
  const result = yield* runCommandEffect('launchctl', ['print', launchAgentServiceTarget(resolvedUid)], {
    allowFailure: true,
    ...(timeoutMs !== undefined ? {timeoutMs} : {}),
  });
  return yield* Effect.try({
    try: () => parseLaunchAgentStatus(`${result.stdout}\n${result.stderr}`, result.exitCode),
    catch: cause => applicationError('read launchd service status', cause),
  });
});

export function parseLaunchAgentStatus(output: string, exitCode: number): LaunchAgentStatus {
  if (exitCode !== 0) {
    if (exitCode === 113 && output.includes('Could not find service')) {
      return {loaded: false, running: false};
    }
    throw new Error(`launchctl print failed with exit code ${exitCode}: ${output.trim()}`);
  }
  const pidMatch = output.match(/^\s*pid = (\d+)\s*$/m);
  const pid = pidMatch ? Number(pidMatch[1]) : undefined;
  return {
    loaded: true,
    ...(pid !== undefined ? {pid} : {}),
    running: /^\s*state = running\s*$/m.test(output) && pid !== undefined,
  };
}

export const isLaunchAgentRunning = Effect.fn('isLaunchAgentRunning')(function* (uid?: number) {
  return (yield* readLaunchAgentStatus(uid)).running;
});

const resolveUserId = Effect.fn('resolveLaunchdUserId')(function* (uid?: number) {
  if (uid !== undefined) {
    return uid;
  }
  const system = yield* SystemInfo;
  return system.userId === undefined
    ? yield* Effect.fail(applicationError('resolve current user id for launchd', new Error('User id is unavailable.')))
    : system.userId;
});

const deadlineFromTimeout = Effect.fn('launchdDeadlineFromTimeout')(function* (timeoutMs?: number) {
  if (timeoutMs === undefined) {
    return undefined;
  }
  return (yield* Clock.currentTimeMillis) + timeoutMs;
});

const remainingTimeout = Effect.fn('launchdRemainingTimeout')(function* (deadline?: number) {
  if (deadline === undefined) {
    return undefined;
  }
  const remaining = deadline - (yield* Clock.currentTimeMillis);
  if (remaining <= 0) {
    return yield* Effect.fail(new Error('launchctl operation timed out.'));
  }
  return remaining;
});
