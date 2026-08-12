import {Console, Effect, FileSystem, Path} from 'effect';
import type {RuntimeConfig, ShareTeamConfig, ShareTeamsFile} from './types.js';
import {runShareInit, runShareSync} from './share.js';
import {normalizeTeamName, readTeamsFile, shareTeamAccess} from './share.js';
import {withSharedRepositoryLock} from './effect/share_lock.js';
import {SystemInfo} from './effect/system.js';
import {canonicalResourceUri} from './storage/resource-id.js';
import {uriSegment} from './mcp_server_common.js';

export const CURSOR_CLOUD_MCP_TOOLSET = 'cursor-cloud' as const;
export const CURSOR_CLOUD_TEAM_ENV = 'THREADNOTE_CURSOR_CLOUD_TEAM';
export const DEFAULT_CURSOR_CLOUD_IDENTITY = 'cursor-cloud';

export class CursorCloudOperationError extends Error {
  readonly _tag = 'CursorCloudOperationError' as const;
}

export interface CursorCloudProfileV1 {
  readonly account: string;
  readonly agentId: string;
  readonly graphMode: 'local-checkout';
  readonly homeDurability: 'ephemeral';
  readonly memoryRoot: string;
  readonly profile: 'shared-read-write';
  readonly provider: 'cursor-cloud';
  readonly team: string;
  readonly user: string;
  readonly version: 1;
}

export interface CursorCloudMcpConfig {
  readonly args: readonly ['-lc', 'exec "$HOME/.local/bin/threadnote" mcp-server'];
  readonly command: '/bin/sh';
  readonly env: Readonly<{
    THREADNOTE_ACCOUNT: string;
    THREADNOTE_AGENT_ID: string;
    THREADNOTE_CURSOR_CLOUD_TEAM: string;
    THREADNOTE_MCP_TOOLSET: typeof CURSOR_CLOUD_MCP_TOOLSET;
    THREADNOTE_USER: string;
  }>;
  readonly type: 'stdio';
}

export interface CursorCloudMemoryScope {
  readonly mode: 'shared-read-write';
  readonly root: string;
  readonly team: string;
}

export interface CursorCloudBootstrapOptions {
  readonly dryRun?: boolean;
  readonly remote: string;
  readonly sync?: boolean;
  readonly team?: string;
}

export type CursorCloudBootstrapPlan =
  | {readonly action: 'initialize'; readonly remote: string; readonly team: string}
  | {readonly action: 'reuse'; readonly remote: string; readonly team: string};

export interface CursorCloudVerifyCheck {
  readonly detail: string;
  readonly name: string;
  readonly status: 'fail' | 'ok' | 'warn';
}

export interface CursorCloudVerifyReceiptV1 {
  readonly checks: readonly CursorCloudVerifyCheck[];
  readonly memoryRoot: string;
  readonly profile: 'shared-read-write';
  readonly provider: 'cursor-cloud';
  readonly status: 'fail' | 'ok';
  readonly team: string;
  readonly version: 1;
}

export function cursorCloudMemoryRoot(user: string, team: string): string {
  return canonicalResourceUri('user', [uriSegment(user), 'memories', 'shared', normalizeTeamName(team)]);
}

export function buildCursorCloudProfile(
  config: Pick<RuntimeConfig, 'account'>,
  options: {readonly agentId?: string; readonly team?: string; readonly user?: string} = {},
): CursorCloudProfileV1 {
  const team = normalizeTeamName(options.team ?? DEFAULT_CURSOR_CLOUD_IDENTITY);
  const user = requiredIdentity(options.user ?? DEFAULT_CURSOR_CLOUD_IDENTITY, 'user');
  const agentId = requiredIdentity(options.agentId ?? DEFAULT_CURSOR_CLOUD_IDENTITY, 'agent id');
  return {
    account: config.account,
    agentId,
    graphMode: 'local-checkout',
    homeDurability: 'ephemeral',
    memoryRoot: cursorCloudMemoryRoot(user, team),
    profile: 'shared-read-write',
    provider: 'cursor-cloud',
    team,
    user,
    version: 1,
  };
}

export function buildCursorCloudMcpConfig(profile: CursorCloudProfileV1): CursorCloudMcpConfig {
  return {
    args: ['-lc', 'exec "$HOME/.local/bin/threadnote" mcp-server'],
    command: '/bin/sh',
    env: {
      THREADNOTE_ACCOUNT: profile.account,
      THREADNOTE_AGENT_ID: profile.agentId,
      THREADNOTE_CURSOR_CLOUD_TEAM: profile.team,
      THREADNOTE_MCP_TOOLSET: CURSOR_CLOUD_MCP_TOOLSET,
      THREADNOTE_USER: profile.user,
    },
    type: 'stdio',
  };
}

export function cursorCloudRuntimeConfig(
  config: RuntimeConfig,
  options: {readonly agentId?: string; readonly user?: string},
): RuntimeConfig {
  const profile = buildCursorCloudProfile(config, options);
  return {...config, agentId: profile.agentId, user: profile.user};
}

export function credentialFreeGitRemote(remote: string): string {
  const normalized = remote.trim();
  const hasForbiddenCharacter = [...normalized].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return /\s/u.test(character) || codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!normalized || hasForbiddenCharacter) {
    throw new CursorCloudOperationError('The Cursor Cloud memory remote must be a non-empty URL without whitespace.');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      throw new CursorCloudOperationError('The Cursor Cloud memory remote must be a valid Git URL.');
    }
    if (parsed.username || parsed.password) {
      throw new CursorCloudOperationError(
        'The Cursor Cloud memory remote must not contain embedded credentials; configure authentication in Cursor or the Git provider.',
      );
    }
  }
  return normalized;
}

export function planCursorCloudBootstrap(
  teamsFile: ShareTeamsFile,
  requestedRemote: string,
  requestedTeam = DEFAULT_CURSOR_CLOUD_IDENTITY,
): CursorCloudBootstrapPlan {
  const team = normalizeTeamName(requestedTeam);
  const remote = credentialFreeGitRemote(requestedRemote);
  const existing = teamsFile.teams[team];
  if (!existing) return {action: 'initialize', remote, team};
  assertEquivalentWritableTeam(existing, remote, team);
  return {action: 'reuse', remote, team};
}

export const resolveCursorCloudMemoryScope = Effect.fn('cursorCloud.resolveMemoryScope')(function* (
  config: RuntimeConfig,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const rawTeam = environment[CURSOR_CLOUD_TEAM_ENV]?.trim();
  if (!rawTeam) {
    throw new CursorCloudOperationError(
      `${CURSOR_CLOUD_TEAM_ENV} is required when ${CURSOR_CLOUD_MCP_TOOLSET} is selected.`,
    );
  }
  const team = normalizeTeamName(rawTeam);
  const teamsFile = yield* readTeamsFile(config);
  const configured = teamsFile.teams[team];
  if (!configured) {
    throw new CursorCloudOperationError(
      `Cursor Cloud memory team "${team}" is not configured. Run threadnote cloud cursor bootstrap first.`,
    );
  }
  if (shareTeamAccess(configured) !== 'read-write') {
    throw new CursorCloudOperationError(
      `Cursor Cloud memory team "${team}" must be read-write before the MCP profile can start.`,
    );
  }
  return {
    mode: 'shared-read-write',
    root: cursorCloudMemoryRoot(config.user, team),
    team,
  } satisfies CursorCloudMemoryScope;
});

export const runCursorCloudConfig = Effect.fn('cursorCloud.config')(function* (
  config: RuntimeConfig,
  options: {readonly agentId?: string; readonly team?: string; readonly user?: string},
) {
  const profile = buildCursorCloudProfile(config, options);
  yield* Console.log(JSON.stringify(buildCursorCloudMcpConfig(profile), undefined, 2));
});

export const runCursorCloudBootstrap = Effect.fn('cursorCloud.bootstrap')(function* (
  config: RuntimeConfig,
  options: CursorCloudBootstrapOptions,
) {
  yield* withSharedRepositoryLock(
    config,
    Effect.gen(function* () {
      const plan = planCursorCloudBootstrap(yield* readTeamsFile(config), options.remote, options.team);
      if (plan.action === 'initialize') {
        yield* runShareInit(config, plan.remote, {
          dryRun: options.dryRun,
          push: true,
          readOnly: false,
          setDefault: true,
          team: plan.team,
        });
      } else {
        yield* Console.log(`Cursor Cloud memory team "${plan.team}" is already configured read-write; reusing it.`);
      }
      if (options.dryRun === true) {
        yield* Console.log('Dry run complete; the memory share was not changed or synchronized.');
      } else if (options.sync !== false) {
        yield* runShareSync(config, {push: true, team: plan.team});
      }
      yield* Console.log(`Cursor Cloud memory root: ${cursorCloudMemoryRoot(config.user, plan.team)}/`);
    }),
  );
});

export const runCursorCloudVerify = Effect.fn('cursorCloud.verify')(function* (
  config: RuntimeConfig,
  options: {readonly cwd: string; readonly json?: boolean; readonly team?: string},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const team = normalizeTeamName(options.team ?? DEFAULT_CURSOR_CLOUD_IDENTITY);
  const memoryRoot = cursorCloudMemoryRoot(config.user, team);
  const teamsFile = yield* readTeamsFile(config);
  const configured = teamsFile.teams[team];
  const checks: CursorCloudVerifyCheck[] = [
    {
      detail:
        system.platform === 'linux' ? 'Linux cloud runtime' : `${system.platform}; production Cursor Cloud uses Linux`,
      name: 'platform',
      status: system.platform === 'linux' ? 'ok' : 'warn',
    },
    {
      detail: (yield* fs.exists(config.agentContextHome)) ? 'initialized' : 'missing',
      name: 'Threadnote home',
      status: (yield* fs.exists(config.agentContextHome)) ? 'ok' : 'fail',
    },
    {
      detail: configured ? 'configured' : 'missing',
      name: 'memory team',
      status: configured ? 'ok' : 'fail',
    },
  ];
  if (configured) checks.push(...(yield* configuredTeamChecks(fs, configured)));
  const cwdIsAbsolute = path.isAbsolute(options.cwd);
  const cwdExists = cwdIsAbsolute && (yield* fs.exists(options.cwd));
  checks.push({
    detail: cwdExists ? 'absolute checkout path exists' : 'expected an existing absolute checkout path',
    name: 'local graph checkout',
    status: cwdExists ? 'ok' : 'fail',
  });
  checks.push({detail: memoryRoot, name: 'exclusive memory root', status: 'ok'});
  const receipt: CursorCloudVerifyReceiptV1 = {
    checks,
    memoryRoot,
    profile: 'shared-read-write',
    provider: 'cursor-cloud',
    status: checks.some(check => check.status === 'fail') ? 'fail' : 'ok',
    team,
    version: 1,
  };
  if (options.json === true) {
    yield* Console.log(JSON.stringify(receipt));
  } else {
    yield* Console.log('Cursor Cloud verification');
    for (const check of checks) yield* Console.log(`${check.status.toUpperCase()} ${check.name}: ${check.detail}`);
    yield* Console.log(`Status: ${receipt.status}`);
  }
  if (receipt.status === 'fail') {
    throw new CursorCloudOperationError('Cursor Cloud verification failed; resolve the failed checks above.');
  }
});

function requiredIdentity(value: string, label: string): string {
  const normalized = uriSegment(value.trim());
  if (!value.trim() || normalized === 'unknown') {
    throw new CursorCloudOperationError(`Cursor Cloud ${label} must contain a portable identifier.`);
  }
  return normalized;
}

function assertEquivalentWritableTeam(existing: ShareTeamConfig, remote: string, team: string): void {
  if (existing.remote.trim() !== remote) {
    throw new CursorCloudOperationError(
      `Cursor Cloud memory team "${team}" already uses a different remote. Review it with threadnote share status before changing configuration.`,
    );
  }
  if (shareTeamAccess(existing) !== 'read-write') {
    throw new CursorCloudOperationError(
      `Cursor Cloud memory team "${team}" is not read-write. Change it explicitly with threadnote share set-access before retrying.`,
    );
  }
}

const configuredTeamChecks = Effect.fn('cursorCloud.configuredTeamChecks')(function* (
  fs: FileSystem.FileSystem,
  configured: ShareTeamConfig,
) {
  const remoteStatus = yield* Effect.try({
    try: () => credentialFreeGitRemote(configured.remote),
    catch: cause => new CursorCloudOperationError('Cursor Cloud Git remote validation failed.', {cause}),
  }).pipe(
    Effect.as('ok' as const),
    Effect.catch(() => Effect.succeed('fail' as const)),
  );
  return [
    {
      detail: shareTeamAccess(configured),
      name: 'share access',
      status: shareTeamAccess(configured) === 'read-write' ? ('ok' as const) : ('fail' as const),
    },
    {
      detail: remoteStatus === 'ok' ? 'credential-free remote' : 'remote contains credentials or is invalid',
      name: 'Git remote',
      status: remoteStatus,
    },
    {
      detail: (yield* fs.exists(configured.worktree)) ? 'present' : 'missing',
      name: 'share worktree',
      status: (yield* fs.exists(configured.worktree)) ? ('ok' as const) : ('fail' as const),
    },
    {
      detail: (yield* fs.exists(configured.gitdir)) ? 'present' : 'missing',
      name: 'share gitdir',
      status: (yield* fs.exists(configured.gitdir)) ? ('ok' as const) : ('fail' as const),
    },
  ] satisfies readonly CursorCloudVerifyCheck[];
});
