import type {GitWorktreeLock} from '../effect/git_worktree_lock.js';
import {assertRemoteMemoryRuntimePrivileges} from '@threadnote/remote-memory/runtime_privileges';
import {remoteMemoryConfigFromEnvironment, redactedRemoteMemoryConfig} from '@threadnote/remote-memory/config';
import {createCursorTokenVerifier} from '@threadnote/remote-memory/cursor_oidc';
import {migrateRemoteMemoryDatabase} from '@threadnote/remote-memory/migrations';
import {createOAuthTokenVerifier} from '@threadnote/remote-memory/oauth';
import {createRemoteMemorySql, PostgresRemoteControlPlane} from '@threadnote/remote-memory/postgres/control_plane';
import {GitCanonicalMemoryStore, ensureLiveGitShareWorktree} from '@threadnote/remote-memory/git/canonical_store';
import {PostgresRemoteMemoryRepository} from '@threadnote/remote-memory/postgres/repository';
import {PostgresRemoteRateLimiter} from '@threadnote/remote-memory/rate_limit';
import {RemoteMemoryIndexer} from '@threadnote/remote-memory/indexer';
import {RemoteHandoffRetentionWorker} from '@threadnote/remote-memory/handoff_retention';
import {
  createRemoteMemoryWorkerHealth,
  remoteMemoryWorkerRowsReady,
  type RemoteMemoryWorkerFailure,
  type RemoteMemoryWorkerHealth,
  type RemoteMemoryWorkerHealthRow,
} from '@threadnote/remote-memory/worker_health';
import {startRemoteMemoryServer} from './server.js';

export interface RemoteMemoryServiceRuntime {
  readonly worktreeLock: GitWorktreeLock;
  readonly error: (message: string) => void;
  readonly executablePath?: string;
  readonly shutdownSignal: () => {readonly dispose: () => void; readonly promise: Promise<string>};
}

export async function runRemoteMemoryService(
  environment: Readonly<Record<string, string | undefined>>,
  runtime: RemoteMemoryServiceRuntime,
): Promise<void> {
  const config = remoteMemoryConfigFromEnvironment(environment);
  const sql = createRemoteMemorySql(config.databaseUrl);
  const controlPlane = new PostgresRemoteControlPlane(sql, {
    ...(config.legacyClientIdCompatibilityUntil === undefined
      ? {}
      : {legacyClientIdCompatibilityUntil: config.legacyClientIdCompatibilityUntil}),
  });
  const workers = new AbortController();
  const workerHealth = createRemoteMemoryWorkerHealth(
    (name, cause) => {
      if (!workers.signal.aborted)
        runtime.error(`Threadnote remote memory ${name} worker failed: ${remoteMemoryFailureClass(cause)}.`);
    },
    () => workers.signal.aborted,
  );
  let workerTasks: readonly Promise<void>[] = [];
  let stopping: Promise<void> | undefined;
  try {
    if (config.autoMigrate) await migrateRemoteMemoryDatabase(sql, {executablePath: runtime.executablePath});
    else await assertRemoteMemoryRuntimePrivileges(sql);
    await assertRuntimeSchemaAccess(sql);
    if (config.canonicalStore === 'git' && config.gitWorktree && config.gitCloneUrl) {
      await ensureLiveGitShareWorktree({
        branch: config.gitBranch,
        cloneUrl: config.gitCloneUrl,
        remoteName: config.gitRemote,
        requireExactRemote: true,
        worktree: config.gitWorktree,
      });
    }
    const gitStore =
      config.canonicalStore === 'git' && config.gitWorktree
        ? new GitCanonicalMemoryStore({
            binding: config.gitBinding,
            expectedRemoteUrl: config.gitCloneUrl,
            branch: config.gitBranch,
            push: config.gitPush,
            remote: config.gitRemote,
            worktree: config.gitWorktree,
            worktreeLock: runtime.worktreeLock,
          })
        : undefined;
    if (gitStore) await gitStore.refresh();
    const server = startRemoteMemoryServer({
      config,
      dependencies: {
        attestations: controlPlane,
        authorization: controlPlane,
        cursorTokens: createCursorTokenVerifier({
          audience: config.attestationAudience,
          issuer: config.cursorIssuer,
          jwksUrl: config.cursorJwksUrl,
        }),
        oauthTokens: createOAuthTokenVerifier({
          audience: config.accessTokenAudience,
          ...(config.accessTokenClientIdClaim === undefined ? {} : {clientIdClaim: config.accessTokenClientIdClaim}),
          issuer: config.accessTokenIssuer,
          jwksUrl: config.accessTokenJwksUrl,
        }),
        readiness: async () => {
          try {
            if (gitStore) await gitStore.assertReady();
            workerHealth.assertReady();
            return remoteMemoryWorkersReady(sql);
          } catch {
            return false;
          }
        },
        rateLimits: new PostgresRemoteRateLimiter(sql, {
          readRequestsPerMinute: config.readRequestsPerMinute,
          writeRequestsPerMinute: config.writeRequestsPerMinute,
        }),
        repository: new PostgresRemoteMemoryRepository(sql, {gitStore}),
      },
    });
    const indexer = new RemoteMemoryIndexer(sql, gitStore);
    const retention = new RemoteHandoffRetentionWorker(sql, {gitStore});
    workerTasks = [indexer.run({signal: workers.signal}), retention.run({signal: workers.signal})];
    workerHealth.supervise('indexer', workerTasks[0]);
    workerHealth.supervise('retention', workerTasks[1]);
    const shutdown = (reason: string) => {
      stopping ??= (async () => {
        runtime.error(`Threadnote remote memory stopping after ${reason}; draining requests.`);
        workers.abort();
        await server.stop(false);
        await Promise.allSettled(workerTasks);
        await controlPlane.close();
      })();
      return stopping;
    };
    runtime.error(`Threadnote remote memory listening on ${server.url.toString()}`);
    runtime.error(JSON.stringify(redactedRemoteMemoryConfig(config)));
    const processSignal = runtime.shutdownSignal();
    try {
      await superviseRemoteMemoryService({
        shutdown,
        signal: processSignal.promise,
        workerHealth,
      });
    } finally {
      processSignal.dispose();
    }
  } catch (cause) {
    workers.abort();
    await Promise.allSettled(workerTasks);
    if (!stopping) await controlPlane.close().catch(() => undefined);
    throw cause;
  }
}

async function assertRuntimeSchemaAccess(sql: ReturnType<typeof createRemoteMemorySql>): Promise<void> {
  await sql`SELECT 1 FROM remote_memory.shares LIMIT 0`;
}

async function remoteMemoryWorkersReady(sql: ReturnType<typeof createRemoteMemorySql>): Promise<boolean> {
  const rows = (await sql.begin(async transaction => {
    await transaction`SELECT set_config('statement_timeout', '2000', true)`;
    await transaction`SELECT set_config('lock_timeout', '1000', true)`;
    await transaction`SELECT set_config('transaction_timeout', '2000', true)`;
    return transaction<RemoteMemoryWorkerHealthRow[]>`
      SELECT worker_name, heartbeat_at, last_success_at, failure_class, oldest_pending_at
      FROM remote_memory.worker_health
      WHERE worker_name IN ('indexer', 'retention')
    `;
  })) as RemoteMemoryWorkerHealthRow[];
  return remoteMemoryWorkerRowsReady(rows);
}

export function remoteMemoryFailureClass(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : 'unknown_error';
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) ? name : 'worker_error';
}

export async function superviseRemoteMemoryService(input: {
  readonly shutdown: (reason: string) => Promise<void>;
  readonly signal: Promise<string>;
  readonly workerHealth: RemoteMemoryWorkerHealth;
}): Promise<void> {
  const outcome = await Promise.race([
    input.signal.then(signal => ({kind: 'signal' as const, signal})),
    input.workerHealth.waitForFailure().then(failure => ({failure, kind: 'worker_failure' as const})),
  ]);
  if (outcome.kind === 'signal') {
    await input.shutdown(outcome.signal);
    return;
  }
  await input.shutdown(`${outcome.failure.name} worker failure`);
  throw workerFailureError(outcome.failure);
}

function workerFailureError(failure: RemoteMemoryWorkerFailure): Error {
  return new Error(`Remote memory ${failure.name} worker failed.`, {cause: failure.cause});
}
