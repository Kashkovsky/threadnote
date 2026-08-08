import {Effect, FileSystem, Path} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {runCommandEffect} from '../effect/command.js';
import {SystemInfo} from '../effect/system.js';
import {CodeGraphRepositoryError, type RepositoryIdentity, type RepositoryIdentityExpectation} from './types.js';

const IDENTITY_FORMAT_VERSION = 1;

export const resolveRepositoryIdentity = Effect.fn('codeGraph.resolveRepositoryIdentity')(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const rootResult = yield* runGit(cwd, ['rev-parse', '--show-toplevel']).pipe(
    Effect.mapError(cause => new CodeGraphRepositoryError(`Not a Git repository: ${cause.message}`)),
  );
  const repoRoot = yield* fs.realPath(rootResult.stdout.trim());
  const [commonResult, formatResult, commitResult, ignoreCaseResult, remoteResult] = yield* Effect.all(
    [
      runGit(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      runGit(repoRoot, ['rev-parse', '--show-object-format']),
      runGit(repoRoot, ['rev-parse', 'HEAD'], true),
      runGit(repoRoot, ['config', '--bool', 'core.ignorecase'], true),
      runGit(repoRoot, ['remote', 'get-url', 'origin'], true),
    ],
    {concurrency: 5},
  );
  const commonRaw = commonResult.stdout.trim();
  const commonAbsolute = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repoRoot, commonRaw);
  const gitCommonDirectory = yield* fs.realPath(commonAbsolute);
  const objectFormat = formatResult.stdout.trim();
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    return yield* Effect.fail(new CodeGraphRepositoryError(`Unsupported Git object format: ${objectFormat}`));
  }
  const remoteIdentity =
    remoteResult.exitCode === 0 ? normalizeCredentialFreeRemote(remoteResult.stdout.trim()) : undefined;
  const repositorySource = remoteIdentity ?? `local:${normalizeLocalIdentity(gitCommonDirectory, system.platform)}`;
  const headCommit = commitResult.exitCode === 0 ? commitResult.stdout.trim() : zeroObjectId(objectFormat);
  const displayName = repositoryDisplayName(remoteIdentity, repoRoot);
  return {
    caseMode:
      ignoreCaseResult.exitCode === 0 && ignoreCaseResult.stdout.trim().toLowerCase() === 'true'
        ? 'insensitive'
        : 'sensitive',
    checkoutId: checkoutIdForGitCommonDirectory(gitCommonDirectory),
    displayName,
    gitCommonDirectory,
    headCommit,
    objectFormat,
    remoteIdentity,
    repoRoot,
    repositoryId: sha256HexSync(`repository-v${IDENTITY_FORMAT_VERSION}\n${repositorySource}`),
    worktreeId: worktreeIdForRoot(repoRoot),
  } satisfies RepositoryIdentity;
});

export const repositoryWorktreeIds = Effect.fn('codeGraph.repositoryWorktreeIds')(function* (
  identity: RepositoryIdentity,
) {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* runCommandEffect('git', ['-C', identity.repoRoot, 'worktree', 'list', '--porcelain', '-z'], {
    maxOutputBytes: 0,
    timeoutMs: 0,
  });
  const roots = result.stdout.split('\0\0').flatMap(record => {
    const field = record.split('\0').find(value => value.startsWith('worktree '));
    return field ? [field.slice('worktree '.length)] : [];
  });
  const ids = new Set<string>([identity.worktreeId]);
  for (const root of roots) {
    if (!(yield* fs.exists(root))) continue;
    const canonical = yield* fs.realPath(root).pipe(Effect.option);
    if (canonical._tag === 'Some') ids.add(worktreeIdForRoot(canonical.value));
  }
  return ids;
});

export const repositoryChangesSince = Effect.fn('codeGraph.repositoryChangesSince')(function* (
  cwd: string,
  base: string,
) {
  const verified = yield* runCommandEffect(
    'git',
    ['-C', cwd, 'rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
    {
      maxOutputBytes: 1_024,
      timeoutMs: 30_000,
    },
  );
  const objectId = verified.stdout.trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(objectId)) {
    return yield* Effect.fail(new Error(`Git resolved ${base} to an invalid object ID.`));
  }
  const [tracked, untracked] = yield* Effect.all(
    [
      runCommandEffect('git', ['-C', cwd, 'diff', '--name-only', '-z', objectId, '--'], {
        maxOutputBytes: 0,
        timeoutMs: 0,
      }),
      runCommandEffect('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard', '-z'], {
        maxOutputBytes: 0,
        timeoutMs: 0,
      }),
    ],
    {concurrency: 2},
  );
  const paths = [...new Set(`${tracked.stdout}\0${untracked.stdout}`.split('\0').filter(Boolean))].sort();
  if (paths.length === 0) return yield* Effect.fail(new Error(`No changed paths found relative to ${base}.`));
  return {baseCommit: objectId, paths};
});

export function worktreeIdForRoot(repoRoot: string): string {
  return sha256HexSync(`worktree-v${IDENTITY_FORMAT_VERSION}\n${repoRoot}`);
}

function checkoutIdForGitCommonDirectory(gitCommonDirectory: string): string {
  return sha256HexSync(`checkout-v${IDENTITY_FORMAT_VERSION}\n${gitCommonDirectory}`);
}

export function repositoryIdentityMatchesExpectation(
  identity: RepositoryIdentityExpectation,
  expected: RepositoryIdentityExpectation,
): boolean {
  return (
    identity.checkoutId === expected.checkoutId &&
    identity.repositoryId === expected.repositoryId &&
    identity.worktreeId === expected.worktreeId
  );
}

function runGit(cwd: string, args: readonly string[], allowFailure = false) {
  return runCommandEffect('git', ['-C', cwd, ...args], {
    allowFailure,
    maxOutputBytes: 2 * 1_048_576,
    timeoutMs: 30_000,
  });
}

export function normalizeCredentialFreeRemote(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0') || /[\r\n]/.test(trimmed)) return undefined;
  const scp = trimmed.includes('://') ? undefined : /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(trimmed);
  if (scp && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return normalizeRemoteParts(scp[1]!, scp[2]!);
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'file:') return undefined;
    return normalizeRemoteParts(url.hostname, url.pathname);
  } catch {
    return undefined;
  }
}

function normalizeRemoteParts(host: string, pathname: string): string | undefined {
  const safeHost = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const safePath = pathname
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!safeHost || !safePath || safePath.includes('..')) return undefined;
  return `${safeHost}/${safePath}`;
}

function normalizeLocalIdentity(value: string, platform: NodeJS.Platform): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function repositoryDisplayName(remoteIdentity: string | undefined, repoRoot: string): string {
  const source = remoteIdentity ?? repoRoot.replaceAll('\\', '/');
  const parts = source.split('/').filter(Boolean);
  return (remoteIdentity ? parts.slice(-2).join('/') : parts.at(-1)) || 'repository';
}

function zeroObjectId(format: 'sha1' | 'sha256'): string {
  return '0'.repeat(format === 'sha256' ? 64 : 40);
}
