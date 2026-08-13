import {remoteMemoryConfigFromEnvironment, redactedRemoteMemoryConfig} from './config.js';
import {createCursorTokenVerifier} from './cursor_oidc.js';
import {migrateRemoteMemoryDatabase} from './migrations.js';
import {createOAuthTokenVerifier} from './oauth.js';
import {createRemoteMemorySql, PostgresRemoteControlPlane} from './postgres_control_plane.js';
import {PostgresRemoteMemoryRepository} from './postgres_repository.js';
import {PostgresRemoteRateLimiter} from './rate_limit.js';
import {RemoteMemoryIndexer} from './indexer.js';
import {RemoteHandoffRetentionWorker} from './handoff_retention.js';
import {
  createRemoteMemoryWorkerHealth,
  remoteMemoryWorkerRowsReady,
  type RemoteMemoryWorkerFailure,
  type RemoteMemoryWorkerHealth,
  type RemoteMemoryWorkerHealthRow,
} from './worker_health.js';
import {startRemoteMemoryServer} from './server.js';

export async function runRemoteMemoryService(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const config = remoteMemoryConfigFromEnvironment(environment);
  const sql = createRemoteMemorySql(config.databaseUrl);
  const controlPlane = new PostgresRemoteControlPlane(sql);
  const workers = new AbortController();
  const workerHealth = createRemoteMemoryWorkerHealth(
    (name, cause) => {
      if (!workers.signal.aborted)
        console.error(`Threadnote remote memory ${name} worker failed: ${safeErrorClass(cause)}.`);
    },
    () => workers.signal.aborted,
  );
  let workerTasks: readonly Promise<void>[] = [];
  let stopping: Promise<void> | undefined;
  try {
    if (config.autoMigrate) await migrateRemoteMemoryDatabase(sql);
    await assertRuntimeSchemaAccess(sql);
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
          issuer: config.accessTokenIssuer,
          jwksUrl: config.accessTokenJwksUrl,
        }),
        readiness: async () => {
          try {
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
        repository: new PostgresRemoteMemoryRepository(sql),
      },
    });
    const indexer = new RemoteMemoryIndexer(sql);
    const retention = new RemoteHandoffRetentionWorker(sql);
    workerTasks = [indexer.run({signal: workers.signal}), retention.run({signal: workers.signal})];
    const indexerTask = workerTasks[0];
    const retentionTask = workerTasks[1];
    if (!indexerTask || !retentionTask) throw new Error('Remote memory workers did not initialize.');
    workerHealth.supervise('indexer', indexerTask);
    workerHealth.supervise('retention', retentionTask);
    const shutdown = (reason: string) => {
      stopping ??= (async () => {
        console.error(`Threadnote remote memory stopping after ${reason}; draining requests.`);
        workers.abort();
        await server.stop(false);
        await Promise.allSettled(workerTasks);
        await controlPlane.close();
      })();
      return stopping;
    };
    console.error(`Threadnote remote memory listening on ${server.url.toString()}`);
    console.error(JSON.stringify(redactedRemoteMemoryConfig(config)));
    const processSignal = waitForProcessSignal();
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

function safeErrorClass(cause: unknown): string {
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

function waitForProcessSignal(): {readonly dispose: () => void; readonly promise: Promise<string>} {
  let resolveSignal: ((signal: string) => void) | undefined;
  const promise = new Promise<string>(resolve => {
    resolveSignal = resolve;
  });
  const onSigint = () => resolveSignal?.('SIGINT');
  const onSigterm = () => resolveSignal?.('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return {
    dispose: () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    },
    promise,
  };
}

if (import.meta.main) {
  runRemoteMemoryService().catch(cause => {
    console.error(`Remote memory service failed: ${safeErrorClass(cause)}.`);
    process.exitCode = 1;
  });
}
