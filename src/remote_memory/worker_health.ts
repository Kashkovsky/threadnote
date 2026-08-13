export type RemoteMemoryWorkerName = 'indexer' | 'retention';

export interface RemoteMemoryWorkerHealthRow {
  readonly failure_class: string | null;
  readonly heartbeat_at: Date;
  readonly last_success_at: Date | null;
  readonly oldest_pending_at: Date | null;
  readonly worker_name: string;
}

export interface RemoteMemoryWorkerHealth {
  readonly assertReady: () => void;
  readonly supervise: (name: RemoteMemoryWorkerName, task: Promise<void>) => void;
  readonly waitForFailure: () => Promise<RemoteMemoryWorkerFailure>;
}

export interface RemoteMemoryWorkerFailure {
  readonly cause: unknown;
  readonly name: RemoteMemoryWorkerName;
}

/**
 * A worker must run until shutdown. Rejection and unexpected successful exit
 * both fail this process's readiness; a different replica cannot mask it by
 * updating the shared heartbeat row.
 */
export function createRemoteMemoryWorkerHealth(
  onFailure: (name: RemoteMemoryWorkerName, cause: unknown) => void,
  isStopping: () => boolean = () => false,
): RemoteMemoryWorkerHealth {
  let failure: RemoteMemoryWorkerFailure | undefined;
  let resolveFailure: ((value: RemoteMemoryWorkerFailure) => void) | undefined;
  const failurePromise = new Promise<RemoteMemoryWorkerFailure>(resolve => {
    resolveFailure = resolve;
  });
  const fail = (name: RemoteMemoryWorkerName, cause: unknown) => {
    if (isStopping() || failure) return;
    failure = {cause, name};
    onFailure(name, cause);
    resolveFailure?.(failure);
  };
  return {
    assertReady: () => {
      if (failure) throw new Error(`Remote memory ${failure.name} worker is unavailable.`);
    },
    supervise: (name, task) => {
      void task.then(
        () => fail(name, new Error('Remote memory worker exited before shutdown.')),
        cause => fail(name, cause),
      );
    },
    waitForFailure: () => failurePromise,
  };
}

/** Two fixed database rows make this readiness decision constant-time. */
export function remoteMemoryWorkerRowsReady(rows: readonly RemoteMemoryWorkerHealthRow[], now = new Date()): boolean {
  const expected = new Set<RemoteMemoryWorkerName>(['indexer', 'retention']);
  const maximumHeartbeatAge = 2 * 60_000;
  const maximumIndexLagAge = 5 * 60_000;
  if (rows.length !== expected.size) return false;
  for (const row of rows) {
    if (row.worker_name !== 'indexer' && row.worker_name !== 'retention') return false;
    if (!expected.delete(row.worker_name) || !row.last_success_at || row.failure_class) return false;
    if (now.getTime() - row.heartbeat_at.getTime() > maximumHeartbeatAge) return false;
    if (
      row.worker_name === 'indexer' &&
      row.oldest_pending_at &&
      now.getTime() - row.oldest_pending_at.getTime() > maximumIndexLagAge
    ) {
      return false;
    }
  }
  return expected.size === 0;
}
