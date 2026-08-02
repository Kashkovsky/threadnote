import {Effect, Option} from 'effect';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {observeSharedRepositoryHomeLock} from '../../src/effect/share_lock.js';
import {SystemInfo} from '../../src/effect/system.js';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('shared repository lock observation', () => {
  let home: string;
  let lockPath: string;

  beforeEach(async () => {
    home = await mkdtemp('threadnote-shared-lock-observation-');
    lockPath = join(home, 'threadnote', 'shared-repository.lock');
    await mkdir(join(home, 'threadnote'), {recursive: true});
  });

  afterEach(async () => {
    await rm(home, {force: true, recursive: true});
  });

  it('accepts a fresh live lease only when process-start identity matches', async () => {
    await writeOwnerLock(lockPath, 'owner-start');

    await expect(observeWithIdentity(home, Option.some('owner-start'))).resolves.toBe('active');
  });

  it('rejects a fresh lease when the process-start identity mismatches', async () => {
    await writeOwnerLock(lockPath, 'owner-start');

    await expect(observeWithIdentity(home, Option.some('replacement-start'))).resolves.toBe('unhealthy');
  });

  it('rejects a fresh lease when the current process-start identity is unavailable', async () => {
    await writeOwnerLock(lockPath, 'owner-start');

    await expect(observeWithIdentity(home, Option.none())).resolves.toBe('unhealthy');
  });

  it('rejects legacy leases without a process-start identity', async () => {
    await writeFile(lockPath, '43210:legacy-owner\n', {mode: 0o600});

    await expect(observeWithIdentity(home, Option.some('owner-start'))).resolves.toBe('unhealthy');
  });
});

async function writeOwnerLock(path: string, processStartIdentity: string): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({processId: 43_210, processStartIdentity, token: 'owner-token', version: 1})}\n`,
    {mode: 0o600},
  );
}

async function observeWithIdentity(home: string, identity: Option.Option<string>) {
  return runEffect(
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      return yield* observeSharedRepositoryHomeLock(home).pipe(
        Effect.provideService(
          SystemInfo,
          SystemInfo.of({
            ...system,
            isProcessRunning: () => true,
            processStartIdentity: () => Effect.succeed(Option.getOrUndefined(identity)),
          }),
        ),
      );
    }),
  );
}
