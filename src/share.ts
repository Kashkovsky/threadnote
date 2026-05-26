import {mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, sep} from 'node:path';
import {uriSegment} from './manifest.js';
import {withIdentity} from './runtime.js';
import type {
  ShareInitOptions,
  ShareListOptions,
  SharePublishOptions,
  ShareRemoveOptions,
  ShareRuntime,
  ShareStatusOptions,
  ShareSyncOptions,
  ShareTeamConfig,
  ShareTeamsFile,
  ShareUnpublishOptions,
} from './types.js';
import {
  assertVikingUri,
  ensureDirectory,
  exists,
  formatShellCommand,
  isDirectory,
  isFile,
  maybeRun,
  openVikingCliForMode,
  parseJsonConfigObject,
  portablePath,
  readFileIfExists,
  removePath,
  requiredExecutable,
  runCommand,
  sleep,
} from './utils.js';

const TEAMS_FILE_VERSION = 1;
const SHARED_SEGMENT = 'shared';
const SHAREABLE_MEMORY_KIND_DIRS = ['durable'];
const AUTO_SHARE_FETCH_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_GIT_REMOTE_NAME = 'origin';

interface ScrubberPattern {
  readonly name: string;
  // When present, the pattern is redactable: `--redact` (CLI) / `redact: true`
  // (MCP) replaces every match with this string instead of blocking. When
  // absent, the pattern always blocks regardless of --redact.
  readonly placeholder?: string;
  readonly regex: RegExp;
}

const SCRUBBER_PATTERNS: readonly ScrubberPattern[] = [
  // Credentials: never redactable. Blocking is the only safe response —
  // automated redaction risks false negatives that leave material in git.
  {name: 'private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/},
  {name: 'API key (sk-...)', regex: /\bsk-[A-Za-z0-9_-]{16,}/},
  {name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9_]{16,}/},
  {name: 'GitHub fine-grained PAT', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/},
  {name: 'GitLab PAT', regex: /\bglpat-[A-Za-z0-9_-]{20,}/},
  {name: 'bearer token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i},
  // Matches bare JWTs (three base64url segments). May surface a JWE token in
  // legitimate docs; if that becomes noisy we can switch to warn-only.
  {name: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/},
  {name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/},
  // Slack tokens: xoxa/xoxb/xoxc (configuration)/xoxd (legacy user cookie)/
  // xoxe (refresh)/xoxp/xoxr/xoxs, with optional -N- segment for the workspace tier.
  {name: 'Slack token', regex: /\bxox[abcdeprs](?:-\d-)?[A-Za-z0-9._-]{10,}/i},

  // Soft leaks: block by default (so the agent sees them and decides), but
  // allow opt-in redaction so curated memories with incidental matches can
  // ship without a manual rewrite. Local home paths are the recurring
  // real-world leak; the regexes greedily consume the whole path segment
  // (including subdirectories) up to whitespace or common closing punctuation
  // so redaction collapses an entire path to a single placeholder rather than
  // leaving the subpath visible.
  {name: 'macOS home path', placeholder: '<local-path>', regex: /\/Users\/[^\s)>"'`,]+/},
  {name: 'linux home path', placeholder: '<local-path>', regex: /\b\/home\/[^\s)>"'`,]+/},
];

export interface ScrubberResult {
  readonly blocker?: string;
  readonly cleaned: string;
  readonly redactions: ReadonlyArray<{readonly count: number; readonly name: string}>;
}

/**
 * Runs `content` through {@link SCRUBBER_PATTERNS}. Credentials always block;
 * soft-leak patterns block by default and redact only when `redact` is true.
 *
 * On block: `blocker` is set to the first matching pattern name; `cleaned`
 * equals the input. On redact: `cleaned` is the rewritten body with each match
 * replaced by its `placeholder`, and `redactions` lists the pattern names plus
 * match counts so the caller can warn the user about what changed.
 */
export function applyScrubber(content: string, {redact}: {readonly redact: boolean}): ScrubberResult {
  let cleaned = content;
  const redactions: Array<{count: number; name: string}> = [];
  for (const pattern of SCRUBBER_PATTERNS) {
    if (!pattern.regex.test(cleaned)) {
      continue;
    }
    if (!pattern.placeholder || !redact) {
      return {blocker: pattern.name, cleaned: content, redactions: []};
    }
    const flags = pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`;
    const globalRegex = new RegExp(pattern.regex.source, flags);
    const matches = cleaned.match(globalRegex) ?? [];
    cleaned = cleaned.replace(globalRegex, pattern.placeholder);
    redactions.push({count: matches.length, name: pattern.name});
  }
  return {cleaned, redactions};
}

export interface ResolvedTeam {
  readonly config: ShareTeamConfig;
  readonly name: string;
}

interface ChangedFile {
  readonly path: string;
  readonly relativePath: string;
  readonly status: 'added' | 'removed' | 'modified';
}

interface AutoShareState {
  behindTeams: ReadonlySet<string>;
  lastCheckedAt: number;
  operationPromise?: Promise<unknown>;
  pendingReindexes: Map<string, readonly ChangedFile[]>;
  timer?: ReturnType<typeof setInterval>;
}

const autoShareStates = new Map<string, AutoShareState>();

export interface AutoShareSyncResult {
  readonly syncedTeams: readonly string[];
  readonly warnings: readonly string[];
}

interface ShareUpdateStatus {
  readonly behind: number;
  readonly team: string;
  readonly warning?: string;
}

interface PendingReindexFile {
  readonly teams: Readonly<Record<string, readonly ChangedFile[]>>;
  readonly version: number;
}

export function clearAutoShareStateForTest(): void {
  for (const state of autoShareStates.values()) {
    if (state.timer) {
      clearInterval(state.timer);
    }
  }
  autoShareStates.clear();
}

export async function runShareInit(config: ShareRuntime, remoteUrl: string, options: ShareInitOptions): Promise<void> {
  if (!remoteUrl.trim()) {
    throw new Error('Provide a git remote URL for the shared memories repo.');
  }
  const dryRun = options.dryRun === true;
  const teamName = normalizeTeamName(options.team);
  const teamsFile = await readTeamsFile(config);
  if (teamsFile.teams[teamName]) {
    throw new Error(
      `Team "${teamName}" is already configured (remote ${teamsFile.teams[teamName].remote}). Remove it first with: threadnote share remove --team ${teamName}`,
    );
  }
  const worktree = teamWorktreePath(config, teamName);
  const gitdir = teamGitdirPath(config, teamName);
  await assertWorktreeUsable(worktree);
  if (await exists(gitdir)) {
    throw new Error(`Gitdir already exists at ${gitdir}; remove it or pick a different team name.`);
  }

  await ensureDirectory(dirname(worktree), dryRun);
  await ensureDirectory(dirname(gitdir), dryRun);

  const git = await requiredExecutable('git');
  await maybeRun(dryRun, git, ['clone', `--separate-git-dir=${gitdir}`, '--', remoteUrl, worktree]);

  const newConfig: ShareTeamConfig = {
    addedAt: new Date().toISOString(),
    gitdir,
    name: teamName,
    remote: remoteUrl,
    worktree,
  };
  const updatedTeams: ShareTeamsFile = {
    defaultTeam: shouldSetDefault(options, teamsFile) ? teamName : (teamsFile.defaultTeam ?? teamName),
    teams: {...teamsFile.teams, [teamName]: newConfig},
    version: TEAMS_FILE_VERSION,
  };
  if (dryRun) {
    console.log(`Would write teams file: ${teamsFilePath(config)}`);
    console.log(`Would set ${teamName} as default? ${updatedTeams.defaultTeam === teamName}`);
  } else {
    await writeTeamsFile(config, updatedTeams);
    console.log(`Configured shared team "${teamName}" -> ${portablePath(worktree)}`);
  }

  if (!dryRun) {
    await ensureSharedGitignore(worktree, git, options.push !== false);
    const ingested = await ingestWorktreeFiles(config, newConfig, 'create');
    console.log(`Ingested ${ingested} shared memory file(s) into OpenViking.`);
  }
}

const SHARED_GITIGNORE_PATTERNS = ['**/.abstract.md', '**/.overview.md'];
const SHARED_GITIGNORE_HEADER = '# Threadnote: ignore OpenViking-generated directory summaries.';

async function ensureSharedGitignore(worktree: string, git: string, push: boolean): Promise<void> {
  // Idempotently ensure the OpenViking-summary patterns are in the worktree's
  // .gitignore. There's no opt-out: these two patterns describe files that OV
  // writes into every shared directory on every mkdir, are not memories, and
  // would only pollute git history if tracked. Users who insist on tracking
  // them can `git update-index --skip-worktree .gitignore` to suppress this.
  const gitignorePath = join(worktree, '.gitignore');
  const existing = (await readFileIfExists(gitignorePath)) ?? '';
  const lines = existing.split('\n').map(line => line.trim());
  const missingPatterns = SHARED_GITIGNORE_PATTERNS.filter(pattern => !lines.includes(pattern));
  if (missingPatterns.length === 0) {
    return;
  }
  // Reuse the existing header if one is already in the file; only add a fresh
  // header on the first run so repeated calls don't accumulate duplicate
  // comment lines.
  const hasHeader = lines.includes(SHARED_GITIGNORE_HEADER);
  const segments: string[] = [];
  if (existing.length > 0 && !existing.endsWith('\n')) {
    segments.push('\n');
  }
  if (existing.length > 0) {
    segments.push('\n');
  }
  if (!hasHeader) {
    segments.push(SHARED_GITIGNORE_HEADER, '\n');
  }
  segments.push(missingPatterns.join('\n'), '\n');
  await writeFile(gitignorePath, `${existing}${segments.join('')}`, {encoding: 'utf8'});
  console.log(`Added ${missingPatterns.join(', ')} to ${portablePath(gitignorePath)}`);
  await maybeRun(false, git, ['-C', worktree, 'add', '.gitignore']);
  const commitResult = await runCommand(
    git,
    ['-C', worktree, 'commit', '-m', 'share: ignore OpenViking directory summaries'],
    {allowFailure: true},
  );
  if (commitResult.exitCode !== 0) {
    const detail = commitResult.stderr.trim() || commitResult.stdout.trim();
    if (!/nothing to commit|no changes added/i.test(detail)) {
      console.warn(
        `.gitignore housekeeping commit was rejected (${detail || 'unknown'}); it will be retried on the next share sync.`,
      );
      return;
    }
  }
  if (push) {
    await maybeRun(false, git, ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME], {allowFailure: true});
  }
}

export async function runShareStatus(config: ShareRuntime, options: ShareStatusOptions): Promise<void> {
  const team = await resolveTeam(config, options.team);
  const git = await requiredExecutable('git');
  console.log(`Team: ${team.name}`);
  console.log(`Remote: ${team.config.remote}`);
  console.log(`Worktree: ${portablePath(team.config.worktree)}`);
  console.log(`Gitdir: ${portablePath(team.config.gitdir)}`);
  await maybeRun(options.dryRun === true, git, ['-C', team.config.worktree, 'status', '--short', '--branch']);
  await maybeRun(options.dryRun === true, git, ['-C', team.config.worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME], {
    allowFailure: true,
  });
  const ahead = await gitOutput(team.config.worktree, ['rev-list', '--count', '@{u}..HEAD'], options.dryRun === true);
  const behind = await gitOutput(team.config.worktree, ['rev-list', '--count', 'HEAD..@{u}'], options.dryRun === true);
  if (ahead !== undefined) {
    console.log(`Ahead of upstream: ${ahead}`);
  }
  if (behind !== undefined) {
    console.log(`Behind upstream: ${behind}`);
  }
}

export function startShareBackgroundFetch(config: ShareRuntime): void {
  const state = autoShareState(config);
  if (state.timer) {
    return;
  }
  void refreshShareUpdateState(config, {force: true}).catch(err => {
    console.error(`share auto-fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  state.timer = setInterval(() => {
    void refreshShareUpdateState(config, {force: false}).catch(err => {
      console.error(`share auto-fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, AUTO_SHARE_FETCH_INTERVAL_MS);
  state.timer.unref?.();
}

export async function syncSharedReposBeforeAgentRead(config: ShareRuntime): Promise<AutoShareSyncResult> {
  const state = autoShareState(config);
  return enqueueShareOperation(state, async () => {
    await loadPendingReindexes(config, state);
    const warnings = await refreshShareUpdateStateLocked(config, state, {force: false});
    const syncTeams = new Set([...state.behindTeams, ...state.pendingReindexes.keys()]);
    if (syncTeams.size === 0) {
      return {syncedTeams: [], warnings};
    }

    const syncedTeams: string[] = [];
    const remainingBehind = new Set(state.behindTeams);
    for (const team of syncTeams) {
      try {
        const warning = await runShareSyncQuiet(config, state, {team});
        if (warning) {
          warnings.push(warning);
        } else {
          remainingBehind.delete(team);
          syncedTeams.push(team);
        }
      } catch (err: unknown) {
        warnings.push(
          `Auto-sync for shared team "${team}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    state.behindTeams = remainingBehind;
    state.lastCheckedAt = Date.now();
    return {syncedTeams, warnings};
  });
}

function autoShareState(config: ShareRuntime): AutoShareState {
  const key = `${config.agentContextHome}:${config.account}:${config.user}`;
  let state = autoShareStates.get(key);
  if (!state) {
    state = {behindTeams: new Set(), lastCheckedAt: 0, pendingReindexes: new Map()};
    autoShareStates.set(key, state);
  }
  return state;
}

function pendingReindexesPath(config: ShareRuntime): string {
  return join(config.agentContextHome, 'share', 'auto-sync-pending-reindexes.json');
}

async function loadPendingReindexes(config: ShareRuntime, state: AutoShareState): Promise<void> {
  const raw = await readFileIfExists(pendingReindexesPath(config));
  if (!raw) {
    state.pendingReindexes = new Map();
    return;
  }
  const parsed = parseJsonConfigObject(raw);
  if (!parsed || typeof parsed.teams !== 'object' || parsed.teams === null || Array.isArray(parsed.teams)) {
    state.pendingReindexes = new Map();
    return;
  }
  const pending = new Map<string, readonly ChangedFile[]>();
  for (const [team, value] of Object.entries(parsed.teams)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const changes: ChangedFile[] = [];
    for (const item of value) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        continue;
      }
      const entry = item as Record<string, unknown>;
      if (
        typeof entry.path === 'string' &&
        typeof entry.relativePath === 'string' &&
        (entry.status === 'added' || entry.status === 'removed' || entry.status === 'modified')
      ) {
        changes.push({path: entry.path, relativePath: entry.relativePath, status: entry.status});
      }
    }
    if (changes.length > 0) {
      pending.set(team, changes);
    }
  }
  state.pendingReindexes = pending;
}

async function writePendingReindexes(config: ShareRuntime, state: AutoShareState): Promise<void> {
  const path = pendingReindexesPath(config);
  if (state.pendingReindexes.size === 0) {
    await rm(path, {force: true});
    return;
  }
  const contents: PendingReindexFile = {
    teams: Object.fromEntries(state.pendingReindexes),
    version: 1,
  };
  await mkdir(dirname(path), {recursive: true});
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(contents, undefined, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  await rename(tempPath, path);
}

async function refreshShareUpdateState(config: ShareRuntime, options: {readonly force: boolean}): Promise<void> {
  const state = autoShareState(config);
  const warnings = await enqueueShareOperation(state, async () =>
    refreshShareUpdateStateLocked(config, state, options),
  );
  for (const warning of warnings) {
    console.error(warning);
  }
}

async function refreshShareUpdateStateLocked(
  config: ShareRuntime,
  state: AutoShareState,
  options: {readonly force: boolean},
): Promise<string[]> {
  const now = Date.now();
  if (!options.force && state.lastCheckedAt > 0 && now - state.lastCheckedAt < AUTO_SHARE_FETCH_INTERVAL_MS) {
    return [];
  }
  try {
    const statuses = await fetchShareUpdateStatuses(config);
    const nextBehindTeams = new Set(state.behindTeams);
    for (const status of statuses) {
      if (status.warning) {
        continue;
      }
      if (status.behind > 0) {
        nextBehindTeams.add(status.team);
      } else {
        nextBehindTeams.delete(status.team);
      }
    }
    state.behindTeams = nextBehindTeams;
    return statuses.flatMap(status => (status.warning ? [status.warning] : []));
  } finally {
    state.lastCheckedAt = Date.now();
  }
}

function enqueueShareOperation<T>(state: AutoShareState, action: () => Promise<T>): Promise<T> {
  const previous = state.operationPromise ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  state.operationPromise = current.catch(() => undefined);
  return current;
}

async function fetchShareUpdateStatuses(config: ShareRuntime): Promise<readonly ShareUpdateStatus[]> {
  const teamsFile = await readTeamsFile(config);
  const teams = Object.entries(teamsFile.teams);
  if (teams.length === 0) {
    return [];
  }
  const git = await requiredExecutable('git');
  const statuses: ShareUpdateStatus[] = [];
  for (const [name, team] of teams) {
    const fetchResult = await runCommand(git, ['-C', team.worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME], {
      allowFailure: true,
    });
    if (fetchResult.exitCode !== 0) {
      statuses.push({
        behind: 0,
        team: name,
        warning: `Auto-sync check for shared team "${name}" failed: ${fetchResult.stderr.trim() || fetchResult.stdout.trim() || 'unknown git fetch error'}`,
      });
      continue;
    }
    const behind = await gitOutput(team.worktree, ['rev-list', '--count', 'HEAD..@{u}'], false);
    if (behind === undefined) {
      statuses.push({
        behind: 0,
        team: name,
        warning: `Auto-sync check for shared team "${name}" failed: could not read upstream behind count.`,
      });
      continue;
    }
    statuses.push({behind: Number.parseInt(behind, 10) || 0, team: name});
  }
  return statuses;
}

export async function runShareSync(config: ShareRuntime, options: ShareSyncOptions): Promise<void> {
  const team = await resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  const git = await requiredExecutable('git');
  const worktree = team.config.worktree;

  if (!dryRun) {
    // Don't push here — sync's final push step (below) will deliver any
    // .gitignore housekeeping commit, avoiding a double-push round trip.
    await ensureSharedGitignore(worktree, git, false);
  }

  if (await hasUncommittedChanges(worktree)) {
    if (options.autoCommit === false) {
      throw new Error(
        `Worktree ${worktree} has uncommitted changes. Commit them yourself or rerun without --no-auto-commit.`,
      );
    }
    const message = options.message ?? `share: sync ${new Date().toISOString()}`;
    await stageShareableChanges(dryRun, git, worktree);
    await maybeRun(dryRun, git, ['-C', worktree, 'commit', '-m', message], {allowFailure: true});
  }

  const beforeRev = await gitOutput(worktree, ['rev-parse', 'HEAD'], dryRun);
  await maybeRun(dryRun, git, ['-C', worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME]);
  const pullResult = dryRun
    ? undefined
    : await runCommand(git, ['-C', worktree, 'pull', '--rebase', DEFAULT_GIT_REMOTE_NAME], {allowFailure: true});
  if (dryRun) {
    console.log(`Would run: ${formatShellCommand(git, ['-C', worktree, 'pull', '--rebase', DEFAULT_GIT_REMOTE_NAME])}`);
  } else if (pullResult && pullResult.exitCode !== 0) {
    // Detect mid-rebase state via filesystem markers rather than parsing git's
    // output — both because git's English phrasing varies by version and
    // because non-English LC_MESSAGES rewrites the human-readable strings.
    // share teams clone with --separate-git-dir so <worktree>/.git is a gitfile,
    // not a directory; the rebase markers live in the real gitdir.
    if (
      (await exists(join(team.config.gitdir, 'rebase-merge'))) ||
      (await exists(join(team.config.gitdir, 'rebase-apply')))
    ) {
      throw new Error(
        `git pull --rebase reported conflicts in ${worktree}. The worktree is in a rebase-in-progress state.\nResolve the conflicts in-place, run \`git -C ${worktree} rebase --continue\` (or --abort), then re-run \`threadnote share sync\`.`,
      );
    }
    throw new Error(
      `git pull --rebase failed in ${worktree}: ${pullResult.stderr.trim() || pullResult.stdout.trim() || 'unknown error'}`,
    );
  }
  const afterRev = await gitOutput(worktree, ['rev-parse', 'HEAD'], dryRun);

  if (!dryRun && beforeRev && afterRev && beforeRev !== afterRev) {
    const changes = await listChangedFiles(worktree, beforeRev, afterRev);
    await applyChangesToOpenViking(config, team.config, changes);
    console.log(`Reindexed ${changes.length} file change(s) into OpenViking.`);
  } else if (!dryRun) {
    console.log('No upstream changes to reindex.');
  }

  if (options.push !== false) {
    await maybeRun(dryRun, git, ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME], {allowFailure: true});
  }
}

async function runShareSyncQuiet(
  config: ShareRuntime,
  state: AutoShareState,
  options: {readonly team: string},
): Promise<string | undefined> {
  const team = await resolveTeam(config, options.team);
  const git = await requiredExecutable('git');
  const worktree = team.config.worktree;

  const pendingChanges = state.pendingReindexes.get(team.name);
  if (pendingChanges) {
    await applyChangesToOpenViking(config, team.config, pendingChanges, {quiet: true});
    state.pendingReindexes.delete(team.name);
    await writePendingReindexes(config, state);
  }

  if (await hasUncommittedChanges(worktree)) {
    return `Shared team "${team.name}" has uncommitted changes; skipped automatic sync. Run \`threadnote share sync --team ${team.name}\` to publish or resolve them.`;
  }

  const ahead = await gitOutput(worktree, ['rev-list', '--count', '@{u}..HEAD'], false);
  if (ahead === undefined) {
    return `Shared team "${team.name}" upstream status is unknown; skipped automatic sync. Run \`threadnote share sync --team ${team.name}\` to inspect and resolve it.`;
  }
  if ((Number.parseInt(ahead, 10) || 0) > 0) {
    return `Shared team "${team.name}" has local commits ahead of upstream; skipped automatic sync. Run \`threadnote share sync --team ${team.name}\` to publish or reconcile them.`;
  }

  const beforeRev = await gitOutput(worktree, ['rev-parse', 'HEAD'], false);
  const pullResult = await runCommand(git, ['-C', worktree, 'rebase', '@{u}'], {allowFailure: true});
  if (pullResult.exitCode !== 0) {
    if (
      (await exists(join(team.config.gitdir, 'rebase-merge'))) ||
      (await exists(join(team.config.gitdir, 'rebase-apply')))
    ) {
      throw new Error(
        `Automatic share sync hit git conflicts in ${worktree}. Resolve them in-place, run \`git -C ${worktree} rebase --continue\` (or --abort), then rerun recall/read.`,
      );
    }
    throw new Error(
      `Automatic share sync failed in ${worktree}: ${pullResult.stderr.trim() || pullResult.stdout.trim() || 'unknown error'}`,
    );
  }
  const afterRev = await gitOutput(worktree, ['rev-parse', 'HEAD'], false);
  if (beforeRev && afterRev && beforeRev !== afterRev) {
    const changes = await listChangedFiles(worktree, beforeRev, afterRev);
    if (changes.length > 0) {
      state.pendingReindexes.set(team.name, changes);
      await writePendingReindexes(config, state);
      await applyChangesToOpenViking(config, team.config, changes, {quiet: true});
      state.pendingReindexes.delete(team.name);
      await writePendingReindexes(config, state);
    }
  }
  return undefined;
}

async function stageShareableChanges(dryRun: boolean, git: string, worktree: string): Promise<void> {
  // Stage repo metadata (README, .gitignore) plus every shareable kind dir.
  // OpenViking-generated summaries (.abstract.md, .overview.md) are excluded
  // via the repo's .gitignore (ensureSharedGitignore self-heals it on every
  // sync), so they never get staged even by an unscoped `git add`.
  const pathspecs = [':(top)README.md', ':(top).gitignore', ...SHAREABLE_MEMORY_KIND_DIRS.map(dir => `:(top)${dir}`)];
  await maybeRun(dryRun, git, ['-C', worktree, 'add', '--', ...pathspecs], {allowFailure: true});
}

export async function runSharePublish(
  config: ShareRuntime,
  sourceUri: string,
  options: SharePublishOptions,
): Promise<void> {
  assertVikingUri(sourceUri);
  const team = await resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  const preview = options.preview === true;
  if (isInSharedNamespace(config, sourceUri)) {
    throw new Error(`Memory ${sourceUri} is already in the shared namespace.`);
  }
  const ov = await openVikingCliForMode(dryRun);
  const rawContent = await readMemoryContent(config, ov, sourceUri, dryRun);
  const stripped = stripPersonalProvenance(rawContent);
  const scrub = applyScrubber(stripped, {redact: options.redact === true});
  const targetUri = sharedUriFor(config, sourceUri, team.name);

  if (preview) {
    console.log(`PREVIEW source: ${sourceUri}`);
    console.log(`PREVIEW destination: ${targetUri}`);
    if (scrub.blocker) {
      console.log(
        `PREVIEW BLOCKED: ${scrub.blocker}. Strip the sensitive value or rerun with --redact for soft-leak patterns.`,
      );
      return;
    }
    for (const redaction of scrub.redactions) {
      console.log(`PREVIEW redact: ${redaction.count}× ${redaction.name}`);
    }
    console.log('-----BEGIN PREVIEW-----');
    console.log(scrub.cleaned);
    console.log('-----END PREVIEW-----');
    return;
  }

  if (scrub.blocker) {
    throw new Error(
      `Refusing to publish ${sourceUri}: possible ${scrub.blocker}. Strip the sensitive value or pass --redact for soft-leak patterns.`,
    );
  }
  for (const redaction of scrub.redactions) {
    console.log(`Redacted ${redaction.count}× ${redaction.name} before publish.`);
  }
  const content = scrub.cleaned;

  if (!dryRun && (await vikingResourceExists(ov, config, targetUri))) {
    throw new Error(
      `Refusing to publish: ${targetUri} already exists in the shared namespace. Inspect it via threadnote read; if it should be replaced, forget the existing shared copy first.`,
    );
  }
  await ensureSharedDirectoryChain(config, ov, targetUri, dryRun);
  await writeMemoryFile(config, ov, targetUri, content, 'create', dryRun);
  await removeWithRollback(config, ov, sourceUri, targetUri, team.config.worktree, dryRun, 'publish');

  const git = await requiredExecutable('git');
  const worktree = team.config.worktree;
  const relativePath = vikingUriToWorktreeRelative(config, targetUri, team.name);
  const message = options.message ?? `share: publish ${relativePath}`;
  await maybeRun(dryRun, git, ['-C', worktree, 'add', '--', relativePath]);
  await maybeRun(dryRun, git, ['-C', worktree, 'commit', '-m', message], {allowFailure: true});
  if (options.push !== false) {
    const pushResult = dryRun
      ? undefined
      : await runCommand(git, ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME], {allowFailure: true});
    if (dryRun) {
      console.log(`Would run: ${formatShellCommand(git, ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME])}`);
    } else if (pushResult && pushResult.exitCode !== 0) {
      const detail = pushResult.stderr.trim() || pushResult.stdout.trim() || 'unknown error';
      throw new Error(
        `Memory was committed locally but git push failed: ${detail}\nResolve the remote issue (auth, network, branch protection), then run: threadnote share sync`,
      );
    }
  }
  console.log(`Published ${sourceUri} -> ${targetUri}`);
}

export async function runShareUnpublish(
  config: ShareRuntime,
  sourceUri: string,
  options: ShareUnpublishOptions,
): Promise<void> {
  assertVikingUri(sourceUri);
  const team = await resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  if (!isInTeamNamespace(config, sourceUri, team.name)) {
    throw new Error(`Memory ${sourceUri} is not in team "${team.name}" shared namespace.`);
  }
  const ov = await openVikingCliForMode(dryRun);
  const content = await readMemoryContent(config, ov, sourceUri, dryRun);
  const targetUri = personalUriFor(config, sourceUri, team.name);
  if (!dryRun && (await vikingResourceExists(ov, config, targetUri))) {
    throw new Error(
      `Refusing to unpublish: a personal memory already exists at ${targetUri}. Move or forget it first, then retry.`,
    );
  }
  await writeMemoryFile(config, ov, targetUri, content, 'create', dryRun);
  await removeWithRollback(config, ov, sourceUri, targetUri, team.config.worktree, dryRun, 'unpublish');

  const git = await requiredExecutable('git');
  const worktree = team.config.worktree;
  const relativePath = vikingUriToWorktreeRelative(config, sourceUri, team.name);
  const message = options.message ?? `share: unpublish ${relativePath}`;
  await maybeRun(dryRun, git, ['-C', worktree, 'rm', relativePath], {allowFailure: true});
  await maybeRun(dryRun, git, ['-C', worktree, 'commit', '-m', message], {allowFailure: true});
  if (options.push !== false) {
    await maybeRun(dryRun, git, ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME], {allowFailure: true});
  }
  console.log(`Unpublished ${sourceUri} -> ${targetUri}`);
}

export async function runShareList(config: ShareRuntime, _options: ShareListOptions): Promise<void> {
  const teams = await readTeamsFile(config);
  const entries = Object.values(teams.teams);
  if (entries.length === 0) {
    console.log('No shared teams configured. Run: threadnote share init <remote-url>');
    return;
  }
  for (const team of entries) {
    const marker = team.name === teams.defaultTeam ? ' (default)' : '';
    console.log(`- ${team.name}${marker}`);
    console.log(`    remote: ${team.remote}`);
    console.log(`    worktree: ${portablePath(team.worktree)}`);
    console.log(`    gitdir: ${portablePath(team.gitdir)}`);
    console.log(`    added: ${team.addedAt}`);
  }
}

export async function runShareRemove(config: ShareRuntime, options: ShareRemoveOptions): Promise<void> {
  const team = await resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  const teamsFile = await readTeamsFile(config);
  const remaining: Record<string, ShareTeamConfig> = {};
  for (const [name, value] of Object.entries(teamsFile.teams)) {
    if (name !== team.name) {
      remaining[name] = value;
    }
  }
  const remainingNames = Object.keys(remaining);
  const nextDefault = teamsFile.defaultTeam === team.name ? remainingNames[0] : teamsFile.defaultTeam;
  const updated: ShareTeamsFile = {defaultTeam: nextDefault, teams: remaining, version: TEAMS_FILE_VERSION};
  if (dryRun) {
    console.log(`Would update teams file: ${teamsFilePath(config)}`);
  } else {
    await writeTeamsFile(config, updated);
    console.log(`Removed team "${team.name}" from teams.json.`);
  }
  if (options.keepFiles !== true) {
    await removePath(team.config.worktree, 'shared worktree', dryRun);
    await removePath(team.config.gitdir, 'shared gitdir', dryRun);
  } else {
    console.log(`Keeping files at ${portablePath(team.config.worktree)} and ${portablePath(team.config.gitdir)}`);
  }
}

function normalizeTeamName(input: string | undefined): string {
  const candidate = (input ?? 'default').trim();
  if (!candidate) {
    return 'default';
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(candidate) || /^\.+$/.test(candidate)) {
    throw new Error(
      `Invalid team name "${input}". Team names must start with a lowercase letter or digit and contain only [a-z0-9._-]. Single-dot or dot-only names are rejected so they don't collapse to the shared-root or parent directory.`,
    );
  }
  return candidate;
}

function teamsFilePath(config: ShareRuntime): string {
  return join(config.agentContextHome, 'share', 'teams.json');
}

function teamWorktreePath(config: ShareRuntime, team: string): string {
  return join(
    config.agentContextHome,
    'data',
    'viking',
    config.account,
    'user',
    uriSegment(config.user),
    'memories',
    SHARED_SEGMENT,
    team,
  );
}

function teamGitdirPath(config: ShareRuntime, team: string): string {
  return join(config.agentContextHome, 'share', 'teams', `${team}.gitdir`);
}

export async function readTeamsFile(config: ShareRuntime): Promise<ShareTeamsFile> {
  const path = teamsFilePath(config);
  const raw = await readFileIfExists(path);
  if (!raw) {
    return {teams: {}, version: TEAMS_FILE_VERSION};
  }
  const parsed = parseJsonConfigObject(raw);
  if (!parsed) {
    throw new Error(`Could not parse teams file ${path}`);
  }
  if (typeof parsed.version === 'number' && parsed.version > TEAMS_FILE_VERSION) {
    throw new Error(
      `Teams file ${path} was written with version ${parsed.version}; this Threadnote binary understands up to version ${TEAMS_FILE_VERSION}. Upgrade Threadnote (\`threadnote update\`) before continuing.`,
    );
  }
  const teams: Record<string, ShareTeamConfig> = {};
  if (typeof parsed.teams === 'object' && parsed.teams !== null && !Array.isArray(parsed.teams)) {
    for (const [name, value] of Object.entries(parsed.teams)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        console.warn(`Skipping non-object team entry "${name}" in ${path}.`);
        continue;
      }
      const entry = value as Record<string, unknown>;
      if (typeof entry.remote !== 'string' || entry.remote.length === 0) {
        console.warn(`Skipping team entry "${name}" in ${path}: missing or empty "remote" field.`);
        continue;
      }
      teams[name] = {
        addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : new Date(0).toISOString(),
        gitdir: typeof entry.gitdir === 'string' ? entry.gitdir : teamGitdirPath(config, name),
        name,
        remote: entry.remote,
        worktree: typeof entry.worktree === 'string' ? entry.worktree : teamWorktreePath(config, name),
      };
    }
  }
  const defaultTeam = typeof parsed.defaultTeam === 'string' ? parsed.defaultTeam : undefined;
  return {defaultTeam, teams, version: TEAMS_FILE_VERSION};
}

async function writeTeamsFile(config: ShareRuntime, contents: ShareTeamsFile): Promise<void> {
  const path = teamsFilePath(config);
  await mkdir(dirname(path), {recursive: true});
  const serializable = {
    defaultTeam: contents.defaultTeam,
    teams: contents.teams,
    version: contents.version,
  };
  await writeFile(path, `${JSON.stringify(serializable, undefined, 2)}\n`, {encoding: 'utf8', mode: 0o600});
}

export async function resolveTeam(config: ShareRuntime, requested: string | undefined): Promise<ResolvedTeam> {
  const teamsFile = await readTeamsFile(config);
  const entries = Object.entries(teamsFile.teams);
  if (entries.length === 0) {
    throw new Error('No shared teams configured. Run: threadnote share init <remote-url>');
  }
  const wantName = requested ? normalizeTeamName(requested) : (teamsFile.defaultTeam ?? entries[0][0]);
  const found = teamsFile.teams[wantName];
  if (!found) {
    const known = entries.map(([name]) => name).join(', ');
    throw new Error(`Team "${wantName}" is not configured. Known teams: ${known}`);
  }
  return {config: found, name: wantName};
}

function shouldSetDefault(options: ShareInitOptions, existing: ShareTeamsFile): boolean {
  if (options.setDefault === true) {
    return true;
  }
  return existing.defaultTeam === undefined;
}

async function assertWorktreeUsable(worktree: string): Promise<void> {
  if (!(await exists(worktree))) {
    return;
  }
  if (!(await isDirectory(worktree))) {
    throw new Error(`Cannot use ${worktree} as a worktree: not a directory.`);
  }
  const entries = await readdir(worktree);
  if (entries.length > 0) {
    const preview = entries.slice(0, 5).join(', ');
    const suffix = entries.length > 5 ? `, +${entries.length - 5} more` : '';
    throw new Error(
      `Worktree ${worktree} is not empty (contains: ${preview}${suffix}). Move or remove its contents, then retry threadnote share init.`,
    );
  }
}

async function ingestWorktreeFiles(
  config: ShareRuntime,
  team: ShareTeamConfig,
  initialMode: 'create' | 'replace',
): Promise<number> {
  const ov = await openVikingCliForMode(false);
  const files = await walkMemoryFiles(team.worktree);
  for (const file of files) {
    const uri = workfileToVikingUri(config, team, file);
    await ensureSharedDirectoryChain(config, ov, uri, false);
    await ingestSingleFile(ov, config, uri, file, initialMode);
  }
  return files.length;
}

async function walkMemoryFiles(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  async function visit(path: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(path, {withFileTypes: true});
    } catch (err: unknown) {
      console.warn(`Skipping ${path} during shared-tree walk: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') {
        continue;
      }
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0 && !SHAREABLE_MEMORY_KIND_DIRS.includes(entry.name)) {
          continue;
        }
        await visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (depth === 0) {
        continue;
      }
      if (!entry.name.endsWith('.md')) {
        continue;
      }
      out.push(full);
    }
  }
  await visit(root, 0);
  return out;
}

function workfileToVikingUri(config: ShareRuntime, team: ShareTeamConfig, filePath: string): string {
  const rel = relative(team.worktree, filePath).split(sep).join('/');
  return `viking://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${team.name}/${rel}`;
}

export function isInSharedNamespace(config: ShareRuntime, uri: string): boolean {
  return uri.startsWith(`viking://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/`);
}

function isInTeamNamespace(config: ShareRuntime, uri: string, team: string): boolean {
  return uri.startsWith(`viking://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${team}/`);
}

export function sharedUriFor(config: ShareRuntime, personalUri: string, team: string): string {
  const prefix = `viking://user/${uriSegment(config.user)}/memories/`;
  if (!personalUri.startsWith(prefix)) {
    throw new Error(`Refusing to publish memory outside the current user namespace: ${personalUri}`);
  }
  const rest = personalUri.slice(prefix.length);
  return `${prefix}${SHARED_SEGMENT}/${team}/${rest}`;
}

function personalUriFor(config: ShareRuntime, sharedUri: string, team: string): string {
  const prefix = `viking://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${team}/`;
  if (!sharedUri.startsWith(prefix)) {
    throw new Error(`Refusing to unpublish a URI outside team "${team}" shared namespace: ${sharedUri}`);
  }
  const rest = sharedUri.slice(prefix.length);
  return `viking://user/${uriSegment(config.user)}/memories/${rest}`;
}

export function vikingUriToWorktreeRelative(config: ShareRuntime, uri: string, team: string): string {
  const prefix = `viking://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${team}/`;
  if (!uri.startsWith(prefix)) {
    throw new Error(`URI ${uri} is not inside team "${team}" shared subtree.`);
  }
  return uri.slice(prefix.length);
}

export function scrubberBlocker(content: string): string | undefined {
  return applyScrubber(content, {redact: false}).blocker;
}

/**
 * Removes `supersedes:` and `archived_from:` lines from the header block of
 * a memory document before it's published to a team's shared git repo. Those
 * lines point at viking:// URIs that only resolve on the publisher's machine —
 * teammates pull via git and have no way to dereference them — so they are
 * always noise at the publish boundary. They also frequently leak the
 * publisher's personal-namespace path or a stale self-reference (the
 * remember --replace <self> bug fixed in storeMemory). Defence-in-depth: even
 * if a regression re-introduces a supersedes-self line, it stops here.
 *
 * Operates only on the contiguous header block (everything up to the first
 * blank line). Prose mentions of "supersedes:" elsewhere in the body are
 * untouched.
 */
export function stripPersonalProvenance(content: string): string {
  const lines = content.split('\n');
  let headerEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '') {
      headerEnd = index;
      break;
    }
  }
  const cleaned: string[] = [];
  for (let index = 0; index < headerEnd; index += 1) {
    if (/^(?:supersedes|archived_from):\s/.test(lines[index])) {
      continue;
    }
    cleaned.push(lines[index]);
  }
  for (let index = headerEnd; index < lines.length; index += 1) {
    cleaned.push(lines[index]);
  }
  return cleaned.join('\n');
}

async function readMemoryContent(config: ShareRuntime, ov: string, uri: string, dryRun: boolean): Promise<string> {
  const args = withIdentity(config, ['read', uri]);
  if (dryRun) {
    console.log(`Would run: ${formatShellCommand(ov, args)}`);
    return '<dry-run memory body>';
  }
  const result = await runCommand(ov, args);
  if (!result.stdout.trim()) {
    throw new Error(`Refusing to publish empty memory at ${uri}`);
  }
  return result.stdout;
}

export async function ensureSharedDirectoryChain(
  config: ShareRuntime,
  ov: string,
  memoryUri: string,
  dryRun: boolean,
  options: {readonly quiet?: boolean} = {},
): Promise<void> {
  const directoryUri = parentUri(memoryUri);
  for (const uri of sharedDirectoryChain(config, directoryUri)) {
    const args = withIdentity(config, ['stat', uri]);
    if (dryRun) {
      if (options.quiet !== true) {
        console.log(`Would run: ${formatShellCommand(ov, args)}`);
      }
      continue;
    }
    const statResult = await runCommand(ov, args, {allowFailure: true});
    if (statResult.exitCode === 0) {
      continue;
    }
    if (options.quiet === true) {
      await runCommand(ov, withIdentity(config, ['mkdir', uri, '--description', 'Threadnote shared memories.']));
    } else {
      await maybeRun(false, ov, withIdentity(config, ['mkdir', uri, '--description', 'Threadnote shared memories.']));
    }
  }
}

export function parentUri(uri: string): string {
  const lastSlash = uri.lastIndexOf('/');
  return lastSlash === -1 ? uri : uri.slice(0, lastSlash);
}

export function sharedDirectoryChain(config: ShareRuntime, directoryUri: string): readonly string[] {
  const prefix = `viking://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/`;
  if (!directoryUri.startsWith(prefix)) {
    return [directoryUri];
  }
  const parts = directoryUri.slice(prefix.length).split('/').filter(Boolean);
  const chain: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) {
    chain.push(`${prefix}${parts.slice(0, index).join('/')}`);
  }
  return chain;
}

export async function writeMemoryFile(
  config: ShareRuntime,
  ov: string,
  uri: string,
  content: string,
  initialMode: 'create' | 'replace',
  dryRun: boolean,
  options: {readonly quiet?: boolean} = {},
): Promise<void> {
  if (dryRun) {
    const args = withIdentity(config, [
      'write',
      uri,
      '--from-file',
      '<staged temp file>',
      '--mode',
      initialMode,
      '--wait',
      '--timeout',
      '120',
    ]);
    if (options.quiet !== true) {
      console.log(`Would run: ${formatShellCommand(ov, args)}`);
    }
    return;
  }
  // Stage the body in a dedicated temp directory so the memory body never
  // lives at the root of THREADNOTE_HOME, and if the process is killed
  // mid-write the leftover is in /tmp which the OS cleans up routinely.
  // mkdtemp already guarantees a unique parent directory; the inner filename
  // can be fixed.
  const stagingDir = await mkdtemp(join(tmpdir(), 'threadnote-share-'));
  const tempPath = join(stagingDir, 'body.txt');
  try {
    await writeFile(tempPath, content, {encoding: 'utf8', mode: 0o600});
    await writeOvFileWithRetry(config, ov, uri, tempPath, initialMode, options);
  } finally {
    await rm(stagingDir, {force: true, recursive: true});
  }
}

async function writeOvFileWithRetry(
  config: ShareRuntime,
  ov: string,
  uri: string,
  fromFile: string,
  initialMode: 'create' | 'replace',
  options: {readonly quiet?: boolean} = {},
): Promise<void> {
  const maxAttempts = 4;
  // Snapshot existence ONCE before the first attempt so a teammate's
  // concurrent publish landing between attempts can't trick us into flipping
  // to 'replace' and silently overwriting their content. Only an exists-now-
  // but-didn't-exist-before transition can be attributed to our own write.
  const existedBeforeWrite = await vikingResourceExists(ov, config, uri);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const existsNow = attempt === 0 ? existedBeforeWrite : await vikingResourceExists(ov, config, uri);
    const ourWriteLanded = existsNow && !existedBeforeWrite;
    // First attempt honors the caller's intent. If create fails because the
    // target already exists, OV returns a non-transient error and we surface
    // it loudly rather than silently overwriting. The flip to "replace" only
    // happens on retries where the resource appeared between attempts (i.e.,
    // our own previous attempt landed despite a transient post-write error).
    const mode = attempt === 0 ? initialMode : ourWriteLanded ? 'replace' : initialMode;
    const args = withIdentity(config, [
      'write',
      uri,
      '--from-file',
      fromFile,
      '--mode',
      mode,
      '--wait',
      '--timeout',
      '120',
    ]);
    if (options.quiet !== true) {
      console.log(`${attempt === 0 ? 'Running' : 'Retrying'}: ${formatShellCommand(ov, args)}`);
    }
    const result = await runCommand(ov, args, {allowFailure: true});
    if (result.exitCode === 0) {
      if (options.quiet !== true && result.stdout.trim()) {
        console.log(result.stdout.trim());
      }
      if (options.quiet !== true && result.stderr.trim()) {
        console.error(result.stderr.trim());
      }
      return;
    }
    if (
      isTransientOvFailure(result.stderr, result.stdout) &&
      (await vikingResourceExists(ov, config, uri)) &&
      !existedBeforeWrite
    ) {
      // The write succeeded server-side (URI now exists where it didn't before
      // this call started) even though OV returned an error before the --wait
      // completed. Drain the queue and treat the write as durable.
      if (options.quiet !== true) {
        console.log(
          'OpenViking accepted the write but returned an error before the wait completed; draining the queue.',
        );
      }
      await waitForOvQueue(ov, config, options);
      return;
    }
    if (!isTransientOvFailure(result.stderr, result.stdout) || attempt === maxAttempts - 1) {
      throw new Error(`${formatShellCommand(ov, args)} failed: ${result.stderr || result.stdout}`);
    }
    await sleep(1000 * (attempt + 1));
  }
}

async function waitForOvQueue(
  ov: string,
  config: ShareRuntime,
  options: {readonly quiet?: boolean} = {},
): Promise<void> {
  const result = await runCommand(ov, withIdentity(config, ['wait', '--timeout', '120']), {allowFailure: true});
  if (options.quiet !== true && result.stdout.trim()) {
    console.log(result.stdout.trim());
  }
  if (options.quiet !== true && result.stderr.trim()) {
    console.error(result.stderr.trim());
  }
}

function isTransientOvFailure(stderr: string, stdout: string): boolean {
  const output = `${stderr}\n${stdout}`.toLowerCase();
  return (
    output.includes('resource is busy') ||
    output.includes('resource is being processed') ||
    output.includes('network error') ||
    output.includes('error sending request') ||
    output.includes('http request failed') ||
    output.includes('connection refused') ||
    output.includes('connection reset') ||
    output.includes('timed out')
  );
}

async function ingestSingleFile(
  ov: string,
  config: ShareRuntime,
  uri: string,
  filePath: string,
  initialMode: 'create' | 'replace',
  options: {readonly quiet?: boolean} = {},
): Promise<void> {
  const content = await readFile(filePath, 'utf8');
  await writeMemoryFile(config, ov, uri, content, initialMode, false, options);
}

/**
 * Removes `sourceUri` from OpenViking. If removal fails, rolls back the prior
 * write at `rollbackUri` so the system is back to its pre-publish/unpublish
 * state instead of half-published. The `label` controls error wording and
 * whether the worktree file at `rollbackUri` is also deleted (only on the
 * publish path; on unpublish the rollback URI is personal so there is no
 * worktree file to clean).
 *
 * Throws the original source-removal error so callers see what failed.
 */
export async function removeWithRollback(
  config: ShareRuntime,
  ov: string,
  sourceUri: string,
  rollbackUri: string,
  worktree: string,
  dryRun: boolean,
  label: 'publish' | 'unpublish',
): Promise<void> {
  try {
    await removeMemoryUri(config, ov, sourceUri, dryRun);
  } catch (sourceErr: unknown) {
    if (dryRun) {
      throw sourceErr;
    }
    console.error(
      `Source removal failed during ${label}; rolling back ${rollbackUri} so the system is back to the pre-${label} state.`,
    );
    try {
      await removeMemoryUri(config, ov, rollbackUri, false);
    } catch (rollbackErr: unknown) {
      console.error(
        `Rollback of ${rollbackUri} also failed. Manual cleanup needed via: threadnote forget ${rollbackUri}\nRollback error: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
      );
    }
    await bestEffortRemoveWorktreeFile(rollbackUri, worktree, label);
    throw sourceErr;
  }
}

async function bestEffortRemoveWorktreeFile(
  rollbackUri: string,
  worktree: string,
  label: 'publish' | 'unpublish',
): Promise<void> {
  if (label !== 'publish') {
    return;
  }
  const prefix = 'viking://';
  if (!rollbackUri.startsWith(prefix)) {
    return;
  }
  const parts = rollbackUri.slice(prefix.length).split('/');
  const sharedIndex = parts.indexOf('shared');
  if (sharedIndex === -1 || sharedIndex + 2 >= parts.length) {
    return;
  }
  const relative = parts.slice(sharedIndex + 2).join('/');
  if (!relative) {
    return;
  }
  await rm(join(worktree, relative), {force: true});
}

export async function removeMemoryUri(
  config: ShareRuntime,
  ov: string,
  uri: string,
  dryRun: boolean,
  options: {readonly quiet?: boolean} = {},
): Promise<void> {
  const args = withIdentity(config, ['rm', uri]);
  if (dryRun) {
    if (options.quiet !== true) {
      console.log(`Would run: ${formatShellCommand(ov, args)}`);
    }
    return;
  }
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await runCommand(ov, args, {allowFailure: true});
    if (result.exitCode === 0) {
      if (options.quiet !== true && result.stdout.trim()) {
        console.log(result.stdout.trim());
      }
      return;
    }
    if (!isTransientOvFailure(result.stderr, result.stdout) || attempt === maxAttempts - 1) {
      throw new Error(`${formatShellCommand(ov, args)} failed: ${result.stderr || result.stdout}`);
    }
    await sleep(1000 * (attempt + 1));
  }
}

export async function vikingResourceExists(ov: string, config: ShareRuntime, uri: string): Promise<boolean> {
  const result = await runCommand(ov, withIdentity(config, ['stat', uri]), {allowFailure: true});
  return result.exitCode === 0;
}

async function hasUncommittedChanges(worktree: string): Promise<boolean> {
  // Read-only check; always run, even in dry-run, so the preamble reflects
  // what a non-dry-run sync would actually have to commit.
  const result = await runCommand('git', ['-C', worktree, 'status', '--porcelain'], {allowFailure: true});
  return result.stdout.trim().length > 0;
}

/** Returns the trimmed stdout of `git -C <worktree> <args>` on success, or `undefined` on dry-run / non-zero exit. */
async function gitOutput(worktree: string, args: readonly string[], dryRun: boolean): Promise<string | undefined> {
  if (dryRun) {
    return undefined;
  }
  const result = await runCommand('git', ['-C', worktree, ...args], {allowFailure: true});
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.trim();
}

async function listChangedFiles(
  worktree: string,
  beforeRev: string,
  afterRev: string,
): Promise<readonly ChangedFile[]> {
  const result = await runCommand('git', ['-C', worktree, 'diff', '--name-status', '-z', `${beforeRev}..${afterRev}`], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return [];
  }
  const entries = result.stdout.split('\0').filter(part => part.length > 0);
  const changes: ChangedFile[] = [];
  for (let index = 0; index < entries.length; ) {
    const raw = entries[index];
    const head = raw.slice(0, 1);
    if (head === 'R' || head === 'C') {
      const oldRel = entries[index + 1];
      const newRel = entries[index + 2];
      if (oldRel && newRel) {
        changes.push({path: join(worktree, oldRel), relativePath: oldRel, status: 'removed'});
        changes.push({path: join(worktree, newRel), relativePath: newRel, status: 'added'});
      }
      index += 3;
      continue;
    }
    const rel = entries[index + 1];
    if (rel) {
      const status = head === 'A' ? 'added' : head === 'D' ? 'removed' : 'modified';
      changes.push({path: join(worktree, rel), relativePath: rel, status});
    }
    index += 2;
  }
  return changes;
}

// applyChangesToOpenViking only reflects changes to files under the shareable
// kind directories (currently just `durable/`). For renames that cross kind
// directories (e.g., handoffs/x.md -> durable/y.md), listChangedFiles emits a
// 'removed' for the old path and an 'added' for the new path; both are
// processed independently here. The 'removed' entry for a non-shareable kind
// is filtered out by the firstSegment check, which is the desired outcome
// because non-shareable kinds are never reflected into OV's shared subtree.
async function applyChangesToOpenViking(
  config: ShareRuntime,
  team: ShareTeamConfig,
  changes: readonly ChangedFile[],
  options: {readonly quiet?: boolean} = {},
): Promise<void> {
  const ov = await openVikingCliForMode(false);
  for (const change of changes) {
    if (!change.relativePath.endsWith('.md')) {
      continue;
    }
    const firstSegment = change.relativePath.split('/')[0];
    if (!SHAREABLE_MEMORY_KIND_DIRS.includes(firstSegment)) {
      continue;
    }
    const uri = workfileToVikingUri(config, team, change.path);
    if (change.status === 'removed') {
      await removeMemoryUri(config, ov, uri, false, options);
      continue;
    }
    if (!(await isFile(change.path))) {
      continue;
    }
    // Either 'modified' or 'added' from git's perspective; the file on disk
    // was just rewritten by the pull-rebase and OV's index needs to catch up.
    // Both cases collapse to the same OV-side rule: if the URI already exists,
    // we must write with 'replace' (the create path's retry loop snapshots
    // existedBeforeWrite=true and would burn every attempt against an
    // ALREADY_EXISTS error). 'added' lands here when OV has the URI from an
    // earlier path — a prior share init/sync, or a local publish that wrote
    // the URI before the corresponding upstream commit landed in this clone.
    const ovHasResource = await vikingResourceExists(ov, config, uri);
    if (ovHasResource) {
      const reason =
        change.status === 'modified'
          ? 'overwriting local with upstream (local edits to the shared subtree are not preserved across sync)'
          : 'aligning OV to upstream (resource pre-existed in OV, likely from an earlier local publish or sync)';
      if (options.quiet !== true) {
        console.warn(`share sync: ${uri}: ${reason}.`);
      }
    }
    await ensureSharedDirectoryChain(config, ov, uri, false, options);
    const writeMode: 'create' | 'replace' = ovHasResource ? 'replace' : 'create';
    await ingestSingleFile(ov, config, uri, change.path, writeMode, options);
  }
}
