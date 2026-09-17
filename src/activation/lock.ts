import {Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock, type ExclusiveFileLockOptions} from '../effect/file_lock.js';

const ACTIVATION_RECEIPT_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 50,
  staleAfterMilliseconds: 60_000,
  waitTimeoutMilliseconds: 60_000,
} as const;

type ActivationReceiptLockOptions = Pick<ExclusiveFileLockOptions, 'onAcquired' | 'onCompleted' | 'onContention'>;

export function withActivationReceiptLock<A, E, R>(
  agentContextHome: string,
  activationId: string,
  effect: Effect.Effect<A, E, R>,
  options: ActivationReceiptLockOptions = {},
) {
  if (!/^[0-9a-f]{64}$/u.test(activationId)) throw new Error('Activation lock requires a SHA-256 activation ID.');
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockPath = path.join(path.resolve(agentContextHome), 'activation', 'locks', `${activationId}.lock`);
    return yield* withExclusiveFileLock(fs, lockPath, {...ACTIVATION_RECEIPT_LOCK_OPTIONS, ...options}, effect);
  });
}
