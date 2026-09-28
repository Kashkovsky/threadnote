export interface LockLease {
  readonly owner: string;
  release(): void;
}

export class FileLock {
  acquire(owner = 'fixture'): LockLease {
    return {
      owner,
      release: () => undefined,
    };
  }
}

export function withExclusiveFileLock<A>(operation: () => A): A {
  const lease = new FileLock().acquire();
  try {
    return operation();
  } finally {
    lease.release();
  }
}
