import {createCursorTokenVerifier} from './cursor_oidc.js';
import {remoteMemoryConfigFromEnvironment, redactedRemoteMemoryConfig} from './config.js';
import {COMPOSER_OAUTH_SCOPES} from './oauth.js';
import {createLocalIdp, COMPOSER_OAUTH_CLIENT_ID, LOCAL_COMPOSER_DEFAULT_LISTEN} from './local_idp.js';
import {remoteMemoryError} from './errors.js';
import {GitCanonicalMemoryStore, ensureLiveGitShareWorktree} from './git_canonical_store.js';
import {migrateRemoteMemoryDatabase} from './migrations.js';
import {createRemoteMemorySql, PostgresRemoteControlPlane} from './postgres_control_plane.js';
import {PostgresRemoteMemoryRepository} from './postgres_repository.js';
import {PostgresRemoteRateLimiter} from './rate_limit.js';
import {RemoteMemoryIndexer} from './indexer.js';
import {RemoteHandoffRetentionWorker} from './handoff_retention.js';
import {startRemoteMemoryServer, type RemoteMemoryServer} from './server.js';
import {
  createRemoteMemoryWorkerHealth,
  remoteMemoryWorkerRowsReady,
  type RemoteMemoryWorkerHealthRow,
} from './worker_health.js';
import {remoteMemoryFailureClass, superviseRemoteMemoryService, type RemoteMemoryServiceRuntime} from './main.js';

export interface ComposerListenAddress {
  readonly hostname: '127.0.0.1';
  readonly port: number;
}

export interface ComposerServeInput {
  readonly databaseUrl: string;
  readonly gitBranch?: string;
  readonly gitCloneUrl: string;
  readonly gitPush?: boolean;
  readonly gitRemoteName?: string;
  readonly gitWorktree: string;
  readonly listen?: string;
  readonly shareId: string;
  readonly subject: string;
  readonly tenantId?: string;
}

export interface ComposerServeReceipt {
  readonly canonicalStore: 'git';
  readonly clientId: string;
  readonly gitWorktree: string;
  readonly issuer: string;
  readonly mcpUrl: string;
  readonly oauth: {
    readonly authorizationServer: string;
    readonly jwks: string;
    readonly scopes: readonly string[];
  };
  readonly shareId: string;
  readonly url: string;
}

export function parseComposerListenAddress(value: string): ComposerListenAddress {
  const match = /^(127\.0\.0\.1|localhost):(\d+)$/u.exec(value.trim());
  const port = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw remoteMemoryError('invalid_request', 'Composer listen must be loopback host:port such as 127.0.0.1:18788.');
  }
  if (port === 8787) {
    throw remoteMemoryError(
      'invalid_request',
      'Composer listen cannot use port 8787; Cursor MCP OAuth uses http://localhost:8787/callback.',
    );
  }
  return {hostname: '127.0.0.1', port};
}

export function composerServeEnvironment(
  input: ComposerServeInput & {readonly listenAddress: ComposerListenAddress},
): Record<string, string> {
  const origin = `http://${input.listenAddress.hostname}:${input.listenAddress.port}`;
  const port = String(input.listenAddress.port);
  const hosts = [...new Set([`${input.listenAddress.hostname}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`])];
  return {
    THREADNOTE_REMOTE_ALLOWED_HOSTS: hosts.join(','),
    THREADNOTE_REMOTE_ALLOWED_ORIGINS: [
      'https://cursor.com',
      'http://127.0.0.1:8787',
      'http://localhost:8787',
      origin,
    ].join(','),
    THREADNOTE_REMOTE_CANONICAL_STORE: 'git',
    THREADNOTE_REMOTE_DATABASE_URL: input.databaseUrl,
    THREADNOTE_REMOTE_ENABLED: 'true',
    THREADNOTE_REMOTE_HOST: input.listenAddress.hostname,
    THREADNOTE_REMOTE_MEMORY_GIT_BRANCH: input.gitBranch?.trim() || 'main',
    THREADNOTE_REMOTE_MEMORY_GIT_PUSH: input.gitPush === true ? 'true' : 'false',
    THREADNOTE_REMOTE_MEMORY_GIT_REMOTE: input.gitRemoteName?.trim() || 'origin',
    THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE: input.gitWorktree,
    THREADNOTE_REMOTE_OAUTH_ISSUER: origin,
    THREADNOTE_REMOTE_OAUTH_JWKS_URL: `${origin}/.well-known/jwks.json`,
    THREADNOTE_REMOTE_PORT: port,
    THREADNOTE_REMOTE_PUBLIC_URL: origin,
  };
}

export async function runComposerServe(
  input: ComposerServeInput,
  runtime: RemoteMemoryServiceRuntime,
): Promise<ComposerServeReceipt> {
  const listenAddress = parseComposerListenAddress(input.listen?.trim() || LOCAL_COMPOSER_DEFAULT_LISTEN);
  const gitWorktree = await ensureLiveGitShareWorktree({
    branch: input.gitBranch,
    cloneUrl: input.gitCloneUrl,
    remoteName: input.gitRemoteName,
    worktree: input.gitWorktree,
  });
  const environment = composerServeEnvironment({...input, gitWorktree, listenAddress});
  const config = remoteMemoryConfigFromEnvironment(environment);
  if (config.canonicalStore !== 'git' || !config.gitWorktree) {
    throw remoteMemoryError(
      'invalid_request',
      'Organization composer serve requires THREADNOTE_REMOTE_CANONICAL_STORE=git.',
    );
  }
  const idp = await createLocalIdp({
    audience: config.accessTokenAudience,
    issuer: config.accessTokenIssuer,
    subject: input.subject,
  });
  const sql = createRemoteMemorySql(config.databaseUrl);
  const controlPlane = new PostgresRemoteControlPlane(sql);
  const workers = new AbortController();
  const workerHealth = createRemoteMemoryWorkerHealth(
    (name, cause) => {
      if (!workers.signal.aborted)
        runtime.error(`Threadnote composer ${name} worker failed: ${remoteMemoryFailureClass(cause)}.`);
    },
    () => workers.signal.aborted,
  );
  let workerTasks: readonly Promise<void>[] = [];
  let stopping: Promise<void> | undefined;
  let server: RemoteMemoryServer | undefined;
  try {
    if (config.autoMigrate) await migrateRemoteMemoryDatabase(sql);
    await sql`SELECT 1 FROM remote_memory.shares LIMIT 0`;
    const gitStore = new GitCanonicalMemoryStore({
      branch: config.gitBranch,
      push: config.gitPush,
      remote: config.gitRemote,
      worktree: config.gitWorktree,
    });
    await gitStore.assertLiveShare();
    await provisionGitTeamShare(controlPlane, {
      issuer: idp.issuer,
      shareId: input.shareId,
      subject: idp.subject,
      tenantId: input.tenantId?.trim() || 'local-org',
    });
    const listening = startRemoteMemoryServer({
      config,
      dependencies: {
        attestations: controlPlane,
        authorization: controlPlane,
        cursorTokens: createCursorTokenVerifier({
          audience: config.attestationAudience,
          issuer: config.cursorIssuer,
          jwksUrl: config.cursorJwksUrl,
        }),
        oauthTokens: idp.verifier(),
        readiness: async () => {
          try {
            await gitStore.assertLiveShare();
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
      localIdp: idp,
    });
    server = listening;
    const indexer = new RemoteMemoryIndexer(sql, gitStore);
    const retention = new RemoteHandoffRetentionWorker(sql, {gitStore});
    workerTasks = [indexer.run({signal: workers.signal}), retention.run({signal: workers.signal})];
    workerHealth.supervise('indexer', workerTasks[0]);
    workerHealth.supervise('retention', workerTasks[1]);
    const receipt: ComposerServeReceipt = {
      canonicalStore: 'git',
      clientId: COMPOSER_OAUTH_CLIENT_ID,
      gitWorktree,
      issuer: idp.issuer,
      mcpUrl: new URL('/mcp', config.publicBaseUrl).toString(),
      oauth: {
        authorizationServer: idp.issuer,
        jwks: `${idp.issuer}/.well-known/jwks.json`,
        scopes: [...COMPOSER_OAUTH_SCOPES],
      },
      shareId: input.shareId,
      url: listening.url.toString(),
    };
    const shutdown = (reason: string) => {
      stopping ??= (async () => {
        runtime.error(`Threadnote composer stopping after ${reason}; draining requests.`);
        workers.abort();
        await listening.stop(false);
        await Promise.allSettled(workerTasks);
        await controlPlane.close();
      })();
      return stopping;
    };
    runtime.error(`Threadnote composer listening on ${receipt.url}`);
    runtime.error(JSON.stringify({...redactedRemoteMemoryConfig(config), ...receipt}));
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
    return receipt;
  } catch (cause) {
    await releaseFailedComposerStart({
      closeControlPlane: () => controlPlane.close(),
      server,
      stopping,
      workerTasks,
      workers,
    });
    throw cause;
  }
}

export async function releaseFailedComposerStart(input: {
  readonly closeControlPlane: () => Promise<void>;
  readonly server?: Pick<RemoteMemoryServer, 'stop'>;
  readonly stopping?: Promise<void>;
  readonly workerTasks: readonly Promise<void>[];
  readonly workers: AbortController;
}): Promise<void> {
  input.workers.abort();
  await Promise.allSettled(input.workerTasks);
  if (input.stopping) return;
  if (input.server) await input.server.stop(true).catch(() => undefined);
  await input.closeControlPlane().catch(() => undefined);
}

export async function provisionGitTeamShare(
  controlPlane: PostgresRemoteControlPlane,
  input: {
    readonly issuer: string;
    readonly shareId: string;
    readonly subject: string;
    readonly tenantId: string;
  },
): Promise<void> {
  await controlPlane.provision({
    capabilities: [...COMPOSER_OAUTH_SCOPES],
    cursorAttestationRequired: false,
    displayName: `Git team share ${input.shareId}`,
    featureFlags: [
      'remote_memory_read',
      'remote_memory_durable_write',
      'remote_memory_handoff_write',
      'remote_memory_ga',
    ],
    issuer: input.issuer,
    policyVersion: 'local-v1',
    principalId: 'local-composer',
    region: 'local',
    shareId: input.shareId,
    sharePolicyVersion: 'local-share-v1',
    subject: input.subject,
    tenantId: input.tenantId,
  });
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
