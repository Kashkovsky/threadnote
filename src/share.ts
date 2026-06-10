import {lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {basename, dirname, join, relative, sep} from 'node:path';
import {uriSegment} from './manifest.js';
import {withIdentity} from './runtime.js';
import type {
  CommandResult,
  ShareAgentArtifactAgent,
  ShareAgentArtifactKind,
  ShareInstallArtifactsOptions,
  ShareInitOptions,
  ShareListArtifactsOptions,
  ShareListOptions,
  SharePublishArtifactOptions,
  SharePublishOptions,
  ShareRenameOptions,
  ShareRemoveOptions,
  ShareSetUrlOptions,
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
  expandPath,
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
  sha256,
  sleep,
} from './utils.js';

const TEAMS_FILE_VERSION = 1;
const SHARED_SEGMENT = 'shared';
const SHAREABLE_MEMORY_KIND_DIRS = ['durable'];
const SHAREABLE_ARTIFACT_DIR = 'agent-artifacts';
const SHAREABLE_TOP_LEVEL_DIRS = [...SHAREABLE_MEMORY_KIND_DIRS, SHAREABLE_ARTIFACT_DIR];
const ARTIFACT_INSTALL_METADATA_VERSION = 1;
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

export interface ShareArtifactMetadata {
  readonly agent: ShareAgentArtifactAgent;
  readonly kind: ShareAgentArtifactKind;
  readonly name: string;
}

export interface ShareArtifactResult {
  readonly artifact: ShareArtifactMetadata;
  readonly gitMessages: readonly string[];
  readonly messages: readonly string[];
  readonly previewContent?: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly targetUri: string;
}

export interface SharedArtifactFile {
  readonly artifact: ShareArtifactMetadata;
  readonly installPath: string;
  readonly sourceRelativePath: string;
  readonly sourcePath: string;
  readonly team: string;
}

export type SharedArtifactInstallStatus =
  | 'current'
  | 'local_modified'
  | 'not_installed'
  | 'remote_changed_and_local_modified'
  | 'update_available';

export interface SharedArtifactSummary extends SharedArtifactFile {
  readonly installStatus: SharedArtifactInstallStatus;
  readonly metadataPath: string;
}

export interface SharedArtifactListResult {
  readonly artifacts: readonly SharedArtifactSummary[];
  readonly syncedTeams: readonly string[];
  readonly team: string;
  readonly warnings: readonly string[];
}

export interface SharedArtifactInstallResult {
  readonly installedCount: number;
  readonly messages: readonly string[];
  readonly syncedTeams: readonly string[];
  readonly team: string;
  readonly warnings: readonly string[];
}

interface SharedArtifactInstallMetadata {
  readonly artifact: ShareArtifactMetadata;
  readonly installedAt: string;
  readonly installedSha256: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly team: string;
  readonly version: number;
}

interface SharedArtifactInstallState {
  readonly existingContent?: string;
  readonly existingSha?: string;
  readonly metadata?: SharedArtifactInstallMetadata;
  readonly sourceContent: string;
  readonly sourceSha: string;
  readonly status: SharedArtifactInstallStatus;
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

export interface ChangedFile {
  readonly path: string;
  readonly relativePath: string;
  readonly status: 'added' | 'removed' | 'modified';
}

export interface SharedMemoryUriParts {
  readonly kind?: 'durable';
  readonly project?: string;
  readonly team: string;
  readonly topic?: string;
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
    console.log(`Ingested ${ingested} shared file(s) into OpenViking.`);
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

  if (!dryRun) {
    const state = autoShareState(config);
    await loadPendingReindexes(config, state);
    const previouslyPending = state.pendingReindexes.get(team.name) ?? [];
    const newChanges =
      beforeRev && afterRev && beforeRev !== afterRev ? await listChangedFiles(worktree, beforeRev, afterRev) : [];
    const combined = mergeChanges(previouslyPending, newChanges);
    if (combined.length === 0) {
      console.log('No upstream changes to reindex.');
    } else {
      const result = await applyAndPersistChanges(config, team.config, state, combined);
      const succeeded = combined.length - result.failed.length;
      console.log(`Reindexed ${succeeded} file change(s) into OpenViking.`);
      if (result.failed.length > 0) {
        console.warn(
          `share sync: ${result.failed.length} file(s) could not be ingested on this run; they are persisted and will be retried on the next sync or agent recall/read.`,
        );
      }
    }
  }

  if (options.push !== false) {
    const pushResult = dryRun
      ? undefined
      : await runCommand(git, ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME], {allowFailure: true});
    if (dryRun) {
      console.log(`Would run: ${formatShellCommand(git, ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME])}`);
    } else if (pushResult && pushResult.exitCode !== 0) {
      throw new Error(
        `git push failed in ${worktree}: ${pushResult.stderr.trim() || pushResult.stdout.trim() || 'unknown error'}`,
      );
    }
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
  if (pendingChanges && pendingChanges.length > 0) {
    await applyAndPersistChanges(config, team.config, state, pendingChanges, {quiet: true});
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
      // Merge with anything still pending from the drain above so a failed
      // drain item doesn't get clobbered when we persist the new changes.
      const stillPending = state.pendingReindexes.get(team.name) ?? [];
      const combined = mergeChanges(stillPending, changes);
      await applyAndPersistChanges(config, team.config, state, combined, {quiet: true});
    }
  }
  return undefined;
}

async function stageShareableChanges(dryRun: boolean, git: string, worktree: string): Promise<void> {
  // Stage repo metadata plus every shareable top-level dir.
  // OpenViking-generated summaries (.abstract.md, .overview.md) are excluded
  // via the repo's .gitignore (ensureSharedGitignore self-heals it on every
  // sync), so they never get staged even by an unscoped `git add`.
  const pathspecs = [':(top)README.md', ':(top).gitignore', ...SHAREABLE_TOP_LEVEL_DIRS.map(dir => `:(top)${dir}`)];
  await maybeRun(dryRun, git, ['-C', worktree, 'add', '--', ...pathspecs], {allowFailure: true});
}

export async function publishShareGitChange(
  worktree: string,
  relativePath: string,
  commitMessage: string,
  options: {
    readonly dryRun?: boolean;
    readonly push?: boolean;
    readonly verb?: 'add' | 'rm';
  } = {},
): Promise<readonly string[]> {
  const dryRun = options.dryRun === true;
  const push = options.push !== false;
  const verb = options.verb ?? 'add';
  const git = await requiredExecutable('git');
  const messages: string[] = [];
  const stageArgs = verb === 'rm' ? ['-C', worktree, 'rm', relativePath] : ['-C', worktree, 'add', '--', relativePath];
  const stageResult = await runGitCommand(dryRun, git, stageArgs, `git ${verb} failed`);
  if (stageResult) {
    messages.push(`git ${verb}: ${stageResult.stdout.trim() || 'ok'}`);
  }

  if (dryRun) {
    console.log(`Would run: ${formatShellCommand(git, ['-C', worktree, 'commit', '-m', commitMessage])}`);
  } else {
    const commitResult = await runCommand(git, ['-C', worktree, 'commit', '-m', commitMessage], {allowFailure: true});
    if (commitResult.exitCode !== 0) {
      const detail = commitResult.stdout.trim() || commitResult.stderr.trim();
      if (/nothing to commit|no changes added/i.test(detail)) {
        messages.push('git commit: nothing to commit (file already in tree)');
      } else {
        throw new Error(`git commit failed: ${detail || 'unknown error'}`);
      }
    } else {
      messages.push(`git commit: ${commitResult.stdout.trim().split('\n').slice(0, 2).join(' ')}`);
    }
  }

  if (!push) {
    messages.push('git push skipped (push=false)');
    return messages;
  }
  const pushResult = await runGitCommand(
    dryRun,
    git,
    ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME],
    'git push failed',
  );
  if (pushResult) {
    messages.push(`git push: ${pushResult.stdout.trim() || pushResult.stderr.trim() || 'ok'}`);
  }
  return messages;
}

async function runGitCommand(
  dryRun: boolean,
  git: string,
  args: readonly string[],
  failureLabel: string,
): Promise<CommandResult | undefined> {
  if (dryRun) {
    console.log(`Would run: ${formatShellCommand(git, args)}`);
    return undefined;
  }
  const result = await runCommand(git, args, {allowFailure: true});
  if (result.exitCode !== 0) {
    throw new Error(`${failureLabel}: ${result.stderr.trim() || result.stdout.trim() || 'unknown error'}`);
  }
  return result;
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

  const worktree = team.config.worktree;
  const relativePath = vikingUriToWorktreeRelative(config, targetUri, team.name);
  const message = options.message ?? `share: publish ${relativePath}`;
  const gitMessages = await publishShareGitChange(worktree, relativePath, message, {
    dryRun,
    push: options.push,
  });
  for (const gitMessage of gitMessages) {
    console.log(gitMessage);
  }
  try {
    await removeMemoryUri(config, ov, sourceUri, dryRun);
  } catch (err: unknown) {
    throw new Error(
      `Published ${sourceUri} -> ${targetUri}, but could not remove the personal source. Retry cleanup later with: threadnote forget ${sourceUri}\n${err instanceof Error ? err.message : String(err)}`,
      {cause: err},
    );
  }
  console.log(`Published ${sourceUri} -> ${targetUri}`);
}

export async function runSharePublishArtifact(
  config: ShareRuntime,
  sourcePath: string,
  options: SharePublishArtifactOptions,
): Promise<void> {
  const result = await shareAgentArtifact(config, sourcePath, options);
  printShareArtifactResult(result, options.preview === true);
}

export async function shareAgentArtifact(
  config: ShareRuntime,
  sourcePath: string,
  options: SharePublishArtifactOptions,
): Promise<ShareArtifactResult> {
  const team = await resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  const preview = options.preview === true;
  const resolvedSourcePath = expandPath(sourcePath);
  if (!(await isRegularFileNoSymlink(resolvedSourcePath))) {
    throw new Error(`Agent artifact source is not a regular file: ${resolvedSourcePath}`);
  }

  const artifact = inferShareArtifact(resolvedSourcePath, options);
  const rawContent = await readFile(resolvedSourcePath, 'utf8');
  if (!rawContent.trim()) {
    throw new Error(`Refusing to share empty agent artifact: ${resolvedSourcePath}`);
  }
  const scrub = applyScrubber(rawContent, {redact: options.redact === true});
  const relativePath = sharedArtifactRelativePath(artifact);
  const targetPath = join(team.config.worktree, ...relativePath.split('/'));
  const targetUri = workfileToVikingUri(config, team.config, targetPath);
  const messages: string[] = [
    `${preview ? 'Previewing' : dryRun ? 'Would share' : 'Sharing'} ${artifact.kind} ${artifact.agent}/${artifact.name}`,
    `Source: ${portablePath(resolvedSourcePath)}`,
    `Destination: ${targetUri}`,
  ];

  if (preview) {
    if (scrub.blocker) {
      messages.push(`PREVIEW BLOCKED: ${scrub.blocker}. Strip the sensitive value or pass --redact.`);
      return {
        artifact,
        gitMessages: [],
        messages,
        sourcePath: resolvedSourcePath,
        targetPath,
        targetUri,
      };
    }
    for (const redaction of scrub.redactions) {
      messages.push(`PREVIEW redact: ${redaction.count}× ${redaction.name}`);
    }
    return {
      artifact,
      gitMessages: [],
      messages,
      previewContent: scrub.cleaned,
      sourcePath: resolvedSourcePath,
      targetPath,
      targetUri,
    };
  }

  if (scrub.blocker) {
    throw new Error(
      `Refusing to share ${resolvedSourcePath}: possible ${scrub.blocker}. Strip the sensitive value or pass --redact for soft-leak patterns.`,
    );
  }
  for (const redaction of scrub.redactions) {
    messages.push(`Redacted ${redaction.count}× ${redaction.name} before sharing.`);
  }
  const content = scrub.cleaned;
  const existingContent = (await readFileIfExists(targetPath)) ?? undefined;
  if (existingContent !== undefined && existingContent !== content && options.force !== true) {
    throw new Error(
      `Shared artifact already exists with different content: ${portablePath(targetPath)}. Pass --force to replace it.`,
    );
  }

  if (dryRun) {
    messages.push(`Would write shared artifact: ${portablePath(targetPath)}`);
  }

  const ov = await openVikingCliForMode(dryRun);
  const ovHasResource = !dryRun && (await vikingResourceExists(ov, config, targetUri));
  await ensureSharedDirectoryChain(config, ov, targetUri, dryRun, {quiet: true});
  await writeMemoryFile(config, ov, targetUri, content, ovHasResource ? 'replace' : 'create', dryRun, {quiet: true});

  const message = options.message ?? `share: publish ${relativePath}`;
  const gitMessages = await publishShareGitChange(team.config.worktree, relativePath, message, {
    dryRun,
    push: options.push,
  });
  return {artifact, gitMessages, messages, sourcePath: resolvedSourcePath, targetPath, targetUri};
}

export async function runShareInstallArtifacts(
  config: ShareRuntime,
  options: ShareInstallArtifactsOptions,
): Promise<void> {
  const result = await installSharedAgentArtifacts(config, options);
  if (result.syncedTeams.length > 0) {
    console.log(`Synced shared teams: ${result.syncedTeams.join(', ')}`);
  }
  for (const warning of result.warnings) {
    console.warn(`Warning: ${warning}`);
  }
  for (const message of result.messages) {
    console.log(message);
  }
}

export async function listSharedAgentArtifacts(
  config: ShareRuntime,
  options: ShareListArtifactsOptions = {},
): Promise<SharedArtifactListResult> {
  const syncResult = await maybeSyncSharedArtifacts(config, options);
  const team = await resolveTeam(config, options.team);
  const artifacts = filterSharedArtifacts(await collectSharedArtifacts(team.config.worktree, team.name), options);
  const summaries: SharedArtifactSummary[] = [];
  for (const artifact of artifacts) {
    summaries.push({
      ...artifact,
      installStatus: await sharedArtifactInstallStatus(artifact),
      metadataPath: sharedArtifactMetadataPath(artifact),
    });
  }
  return {artifacts: summaries, syncedTeams: syncResult.syncedTeams, team: team.name, warnings: syncResult.warnings};
}

export async function installSharedAgentArtifacts(
  config: ShareRuntime,
  options: ShareInstallArtifactsOptions,
): Promise<SharedArtifactInstallResult> {
  const syncResult = await maybeSyncSharedArtifacts(config, options);
  const team = await resolveTeam(config, options.team);
  const dryRun = options.dryRun === true || options.apply !== true;
  const allArtifacts = await collectSharedArtifacts(team.config.worktree, team.name);
  const artifacts = filterSharedArtifacts(allArtifacts, options);
  const messages: string[] = [];
  if (artifacts.length === 0) {
    const filters = sharedArtifactFilterLabel(options);
    if (filters) {
      throw new Error(`No shared agent artifacts found for team "${team.name}" matching ${filters}.`);
    }
    return {
      installedCount: 0,
      messages: [`No shared agent artifacts found for team "${team.name}".`],
      syncedTeams: syncResult.syncedTeams,
      team: team.name,
      warnings: syncResult.warnings,
    };
  }
  if (
    options.name !== undefined &&
    artifacts.length > 1 &&
    (options.agent === undefined || options.kind === undefined)
  ) {
    throw new Error(
      `Shared artifact "${options.name}" is ambiguous. Specify agent and kind. Matches: ${artifacts
        .map(artifact => sharedArtifactLabel(artifact.artifact))
        .join(', ')}`,
    );
  }
  let installedCount = 0;
  for (const artifact of artifacts) {
    const label = sharedArtifactLabel(artifact.artifact);
    const state = await sharedArtifactInstallState(artifact);
    if (dryRun) {
      const verb = sharedArtifactDryRunVerb(state.status, options.force === true);
      const suffix = sharedArtifactDryRunSuffix(state.status, options.force === true);
      messages.push(`${verb} ${label}: ${portablePath(artifact.installPath)}${suffix}`);
      continue;
    }
    if (
      (state.status === 'local_modified' || state.status === 'remote_changed_and_local_modified') &&
      options.force !== true
    ) {
      throw new Error(`Refusing to overwrite ${portablePath(artifact.installPath)}. Pass force=true or --force.`);
    }
    if (state.status === 'current') {
      await writeSharedArtifactMetadata(artifact, state.sourceSha);
      messages.push(`Already installed ${label}: ${portablePath(artifact.installPath)}`);
      continue;
    }
    await ensureDirectory(dirname(artifact.installPath), false);
    await writeFile(artifact.installPath, state.sourceContent, {encoding: 'utf8', mode: 0o600});
    await writeSharedArtifactMetadata(artifact, state.sourceSha);
    installedCount += 1;
    messages.push(
      `${sharedArtifactInstallVerb(state.status, options.force === true)} ${label}: ${portablePath(artifact.installPath)}`,
    );
  }
  return {
    installedCount,
    messages,
    syncedTeams: syncResult.syncedTeams,
    team: team.name,
    warnings: syncResult.warnings,
  };
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

  const worktree = team.config.worktree;
  const relativePath = vikingUriToWorktreeRelative(config, sourceUri, team.name);
  const message = options.message ?? `share: unpublish ${relativePath}`;
  const gitMessages = await publishShareGitChange(worktree, relativePath, message, {
    dryRun,
    push: options.push,
    verb: 'rm',
  });
  for (const gitMessage of gitMessages) {
    console.log(gitMessage);
  }
  try {
    await removeMemoryUri(config, ov, sourceUri, dryRun);
  } catch (err: unknown) {
    throw new Error(
      `Unpublished ${sourceUri} -> ${targetUri}, but could not remove the shared OpenViking source. Retry cleanup later with: threadnote forget ${sourceUri}\n${err instanceof Error ? err.message : String(err)}`,
      {cause: err},
    );
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

export async function runShareRename(config: ShareRuntime, options: ShareRenameOptions): Promise<void> {
  const oldTeam = await resolveTeam(config, options.team);
  const newName = normalizeTeamName(options.to);
  if (newName === oldTeam.name) {
    throw new Error(`Team is already named "${newName}".`);
  }
  const dryRun = options.dryRun === true;
  const teamsFile = await readTeamsFile(config);
  if (teamsFile.teams[newName]) {
    throw new Error(`Team "${newName}" is already configured.`);
  }

  const newWorktree = teamWorktreePath(config, newName);
  const newGitdir = teamGitdirPath(config, newName);
  await assertDestinationAbsent(newWorktree, 'worktree');
  await assertDestinationAbsent(newGitdir, 'gitdir');
  const updatedTeam: ShareTeamConfig = {
    ...oldTeam.config,
    gitdir: newGitdir,
    name: newName,
    worktree: newWorktree,
  };
  const updatedTeams: Record<string, ShareTeamConfig> = {};
  for (const [name, value] of Object.entries(teamsFile.teams)) {
    if (name === oldTeam.name) {
      updatedTeams[newName] = updatedTeam;
    } else {
      updatedTeams[name] = value;
    }
  }
  const updatedFile: ShareTeamsFile = {
    defaultTeam: teamsFile.defaultTeam === oldTeam.name ? newName : teamsFile.defaultTeam,
    teams: updatedTeams,
    version: TEAMS_FILE_VERSION,
  };

  if (dryRun) {
    console.log(`Would rename worktree: ${portablePath(oldTeam.config.worktree)} -> ${portablePath(newWorktree)}`);
    console.log(`Would rename gitdir: ${portablePath(oldTeam.config.gitdir)} -> ${portablePath(newGitdir)}`);
    console.log(`Would update git core.worktree for team "${newName}".`);
    console.log(`Would reindex shared context under team "${newName}" and remove old shared URI tree.`);
    console.log(`Would write teams file: ${teamsFilePath(config)}`);
    return;
  }

  await rename(oldTeam.config.worktree, newWorktree);
  await rename(oldTeam.config.gitdir, newGitdir);
  await writeTeamsFile(config, updatedFile);
  const git = await requiredExecutable('git');
  await runCommand(git, ['-C', newWorktree, 'config', 'core.worktree', newWorktree]);
  const ingested = await ingestWorktreeFiles(config, updatedTeam, 'replace');
  const ov = await openVikingCliForMode(false);
  await removeMemoryUri(
    config,
    ov,
    `viking://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${oldTeam.name}`,
    false,
  );
  console.log(`Renamed shared team "${oldTeam.name}" -> "${newName}".`);
  console.log(`Reindexed ${ingested} shared file(s).`);
}

export async function runShareSetUrl(
  config: ShareRuntime,
  remoteUrl: string,
  options: ShareSetUrlOptions,
): Promise<void> {
  if (!remoteUrl.trim()) {
    throw new Error('Provide a git remote URL.');
  }
  const team = await resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  const git = await requiredExecutable('git');
  if (dryRun) {
    console.log(
      `Would run: ${formatShellCommand(git, ['-C', team.config.worktree, 'remote', 'set-url', DEFAULT_GIT_REMOTE_NAME, remoteUrl])}`,
    );
    console.log(
      `Would run: ${formatShellCommand(git, ['-C', team.config.worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME])}`,
    );
    console.log(`Would write teams file: ${teamsFilePath(config)}`);
    return;
  }
  await runCommand(git, ['-C', team.config.worktree, 'remote', 'set-url', DEFAULT_GIT_REMOTE_NAME, remoteUrl]);
  await runCommand(git, ['-C', team.config.worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME]);
  const teamsFile = await readTeamsFile(config);
  const updatedTeam: ShareTeamConfig = {...team.config, remote: remoteUrl};
  await writeTeamsFile(config, {
    ...teamsFile,
    teams: {...teamsFile.teams, [team.name]: updatedTeam},
  });
  console.log(`Updated shared team "${team.name}" remote: ${remoteUrl}`);
}

export async function runShareRemove(config: ShareRuntime, options: ShareRemoveOptions): Promise<void> {
  const team = await resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  if (options.preserveLocal === true) {
    const preserved = await preserveSharedMemoriesLocally(config, team.config, dryRun);
    console.log(`${dryRun ? 'Would preserve' : 'Preserved'} ${preserved} shared durable memory file(s) locally.`);
  }
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

async function assertDestinationAbsent(path: string, label: string): Promise<void> {
  if (await exists(path)) {
    throw new Error(`Cannot rename share: destination ${label} already exists at ${path}.`);
  }
}

async function preserveSharedMemoriesLocally(
  config: ShareRuntime,
  team: ShareTeamConfig,
  dryRun: boolean,
): Promise<number> {
  const ov = await openVikingCliForMode(dryRun);
  const files = await walkMemoryFiles(team.worktree);
  let preserved = 0;
  for (const file of files) {
    const rel = relative(team.worktree, file).split(sep).join('/');
    if (!rel.startsWith('durable/')) {
      continue;
    }
    const targetUri = `viking://user/${uriSegment(config.user)}/memories/${rel}`;
    const content = await readFile(file, 'utf8');
    if (dryRun) {
      console.log(`Would preserve ${rel} -> ${targetUri}`);
    } else {
      await ensurePersonalDirectoryChain(config, ov, parentUri(targetUri));
      await writeMemoryFile(config, ov, targetUri, content, 'create', false);
    }
    preserved += 1;
  }
  return preserved;
}

async function ensurePersonalDirectoryChain(config: ShareRuntime, ov: string, directoryUri: string): Promise<void> {
  const prefix = 'viking://';
  const parts = directoryUri.startsWith(prefix) ? directoryUri.slice(prefix.length).split('/').filter(Boolean) : [];
  const startIndex = parts[0] === 'user' && parts.length > 2 ? 3 : 1;
  for (let index = startIndex; index <= parts.length; index += 1) {
    const uri = `${prefix}${parts.slice(0, index).join('/')}`;
    const statResult = await runCommand(ov, withIdentity(config, ['stat', uri]), {allowFailure: true});
    if (statResult.exitCode !== 0) {
      await runCommand(
        ov,
        withIdentity(config, ['mkdir', uri, '--description', 'Threadnote lifecycle-aware local memories.']),
      );
    }
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
        if (depth === 0 && !SHAREABLE_TOP_LEVEL_DIRS.includes(entry.name)) {
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
  return sharedTeamNameForUri(config, uri) !== undefined;
}

export function sharedTeamNameForUri(config: ShareRuntime, uri: string): string | undefined {
  const prefix = `viking://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/`;
  if (!uri.startsWith(prefix)) {
    return undefined;
  }
  const [team] = uri.slice(prefix.length).split('/');
  return team || undefined;
}

export function sharedMemoryUriParts(config: ShareRuntime, uri: string): SharedMemoryUriParts | undefined {
  const prefix = `viking://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/`;
  if (!uri.startsWith(prefix)) {
    return undefined;
  }
  const [team, kind, scope, project, ...topicParts] = uri.slice(prefix.length).split('/');
  if (!team) {
    return undefined;
  }
  if (kind !== 'durable' || scope !== 'projects' || !project || topicParts.length === 0) {
    return {team};
  }
  const topicPath = topicParts.join('/');
  return {
    kind,
    project,
    team,
    topic: topicPath.endsWith('.md') ? topicPath.slice(0, -'.md'.length) : topicPath,
  };
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

async function isRegularFileNoSymlink(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile();
  } catch (_err: unknown) {
    return false;
  }
}

function inferShareArtifact(path: string, options: SharePublishArtifactOptions): ShareArtifactMetadata {
  const normalizedPath = path.split(sep).join('/');
  const fileName = basename(path);
  const lowerFileName = fileName.toLowerCase();
  const lowerPath = normalizedPath.toLowerCase();
  const inferredKind: ShareAgentArtifactKind | undefined =
    lowerFileName === 'skill.md'
      ? 'skill'
      : lowerPath.includes('/.claude/commands/') && lowerFileName.endsWith('.md')
        ? 'command'
        : undefined;
  const inferredAgent: ShareAgentArtifactAgent | undefined = lowerPath.includes('/.codex/skills/')
    ? 'codex'
    : lowerPath.includes('/.claude/skills/') || lowerPath.includes('/.claude/commands/')
      ? 'claude'
      : undefined;
  const extensionIndex = fileName.lastIndexOf('.');
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  const inferredName = lowerFileName === 'skill.md' ? basename(dirname(path)) : stem;
  const kind = options.kind ?? inferredKind;
  const agent = options.agent ?? inferredAgent;
  const name = options.name ?? inferredName;

  if (kind !== 'skill' && kind !== 'command') {
    throw new Error('Could not infer artifact kind. Pass --kind skill or --kind command.');
  }
  if (agent !== 'codex' && agent !== 'claude') {
    throw new Error('Could not infer artifact agent. Pass --agent codex or --agent claude.');
  }
  if (kind === 'skill' && lowerFileName !== 'skill.md') {
    throw new Error('Skill artifacts must point at a SKILL.md file.');
  }
  if (kind === 'command' && !lowerFileName.endsWith('.md')) {
    throw new Error('Command artifacts must be Markdown files.');
  }
  if (kind === 'command' && agent !== 'claude') {
    throw new Error('Only Claude command artifacts are supported.');
  }
  if (name.trim().length === 0) {
    throw new Error('Artifact name cannot be empty.');
  }
  return {agent, kind, name: uriSegment(name)};
}

function sharedArtifactRelativePath(artifact: ShareArtifactMetadata): string {
  if (artifact.kind === 'skill') {
    return `${SHAREABLE_ARTIFACT_DIR}/skills/${artifact.agent}/${artifact.name}/SKILL.md`;
  }
  return `${SHAREABLE_ARTIFACT_DIR}/commands/${artifact.agent}/${artifact.name}.md`;
}

function sharedArtifactFromRelativePath(relativePath: string): ShareArtifactMetadata | undefined {
  const parts = relativePath.split('/');
  if (parts[0] !== SHAREABLE_ARTIFACT_DIR) {
    return undefined;
  }
  if (
    parts.length === 5 &&
    parts[1] === 'skills' &&
    (parts[2] === 'codex' || parts[2] === 'claude') &&
    parts[4] === 'SKILL.md'
  ) {
    return {agent: parts[2], kind: 'skill', name: parts[3]};
  }
  if (parts.length === 4 && parts[1] === 'commands' && parts[2] === 'claude' && parts[3].endsWith('.md')) {
    return {agent: 'claude', kind: 'command', name: parts[3].slice(0, -'.md'.length)};
  }
  return undefined;
}

async function collectSharedArtifacts(worktree: string, team: string): Promise<readonly SharedArtifactFile[]> {
  const root = join(worktree, SHAREABLE_ARTIFACT_DIR);
  if (!(await isDirectory(root))) {
    return [];
  }
  const out: SharedArtifactFile[] = [];
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, {withFileTypes: true});
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue;
      }
      const relativePath = relative(worktree, full).split(sep).join('/');
      const artifact = sharedArtifactFromRelativePath(relativePath);
      if (artifact === undefined) {
        continue;
      }
      out.push({
        artifact,
        installPath: sharedArtifactInstallPath(team, artifact),
        sourcePath: full,
        sourceRelativePath: relativePath,
        team,
      });
    }
  }
  await visit(root);
  return out.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

function filterSharedArtifacts(
  artifacts: readonly SharedArtifactFile[],
  options: ShareInstallArtifactsOptions | ShareListArtifactsOptions,
): readonly SharedArtifactFile[] {
  const name = options.name === undefined ? undefined : uriSegment(options.name);
  return artifacts.filter(artifact => {
    if (options.agent !== undefined && artifact.artifact.agent !== options.agent) {
      return false;
    }
    if (options.kind !== undefined && artifact.artifact.kind !== options.kind) {
      return false;
    }
    if (name !== undefined && artifact.artifact.name !== name) {
      return false;
    }
    return true;
  });
}

async function maybeSyncSharedArtifacts(
  config: ShareRuntime,
  options: ShareInstallArtifactsOptions | ShareListArtifactsOptions,
): Promise<AutoShareSyncResult> {
  if (options.sync === false) {
    return {syncedTeams: [], warnings: []};
  }
  return syncSharedReposBeforeAgentRead(config);
}

async function sharedArtifactInstallStatus(artifact: SharedArtifactFile): Promise<SharedArtifactInstallStatus> {
  return (await sharedArtifactInstallState(artifact)).status;
}

async function sharedArtifactInstallState(artifact: SharedArtifactFile): Promise<SharedArtifactInstallState> {
  const sourceContent = await readFile(artifact.sourcePath, 'utf8');
  const sourceSha = sha256(sourceContent);
  const existingContent = (await readFileIfExists(artifact.installPath)) ?? undefined;
  if (existingContent === undefined) {
    return {sourceContent, sourceSha, status: 'not_installed'};
  }
  const existingSha = sha256(existingContent);
  const metadata = await readSharedArtifactMetadata(artifact);
  if (existingSha === sourceSha) {
    return {existingContent, existingSha, metadata, sourceContent, sourceSha, status: 'current'};
  }
  if (metadata === undefined) {
    return {existingContent, existingSha, sourceContent, sourceSha, status: 'local_modified'};
  }
  const remoteChanged = metadata.sourceSha256 !== sourceSha;
  const localChanged = metadata.installedSha256 !== existingSha;
  if (remoteChanged && localChanged) {
    return {
      existingContent,
      existingSha,
      metadata,
      sourceContent,
      sourceSha,
      status: 'remote_changed_and_local_modified',
    };
  }
  if (remoteChanged) {
    return {existingContent, existingSha, metadata, sourceContent, sourceSha, status: 'update_available'};
  }
  return {existingContent, existingSha, metadata, sourceContent, sourceSha, status: 'local_modified'};
}

async function readSharedArtifactMetadata(
  artifact: SharedArtifactFile,
): Promise<SharedArtifactInstallMetadata | undefined> {
  const raw = await readFileIfExists(sharedArtifactMetadataPath(artifact));
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseJsonConfigObject(raw);
  if (parsed === undefined || parsed.version !== ARTIFACT_INSTALL_METADATA_VERSION) {
    return undefined;
  }
  const artifactValue = parsed.artifact;
  if (
    typeof parsed.team !== 'string' ||
    typeof parsed.source !== 'string' ||
    typeof parsed.sourceSha256 !== 'string' ||
    typeof parsed.installedSha256 !== 'string' ||
    typeof parsed.installedAt !== 'string' ||
    typeof artifactValue !== 'object' ||
    artifactValue === null ||
    Array.isArray(artifactValue)
  ) {
    return undefined;
  }
  const metadataArtifact = artifactValue as Partial<ShareArtifactMetadata>;
  if (
    metadataArtifact.agent !== artifact.artifact.agent ||
    metadataArtifact.kind !== artifact.artifact.kind ||
    metadataArtifact.name !== artifact.artifact.name
  ) {
    return undefined;
  }
  return {
    artifact: artifact.artifact,
    installedAt: parsed.installedAt,
    installedSha256: parsed.installedSha256,
    source: parsed.source,
    sourceSha256: parsed.sourceSha256,
    team: parsed.team,
    version: ARTIFACT_INSTALL_METADATA_VERSION,
  };
}

async function writeSharedArtifactMetadata(artifact: SharedArtifactFile, sourceSha: string): Promise<void> {
  const metadata: SharedArtifactInstallMetadata = {
    artifact: artifact.artifact,
    installedAt: new Date().toISOString(),
    installedSha256: sourceSha,
    source: artifact.sourceRelativePath,
    sourceSha256: sourceSha,
    team: artifact.team,
    version: ARTIFACT_INSTALL_METADATA_VERSION,
  };
  const metadataPath = sharedArtifactMetadataPath(artifact);
  await ensureDirectory(dirname(metadataPath), false);
  await writeFile(metadataPath, `${JSON.stringify(metadata, undefined, 2)}\n`, {encoding: 'utf8', mode: 0o600});
}

function sharedArtifactMetadataPath(artifact: SharedArtifactFile): string {
  return `${artifact.installPath}.threadnote-install.json`;
}

function sharedArtifactDryRunVerb(status: SharedArtifactInstallStatus, force: boolean): string {
  switch (status) {
    case 'not_installed':
      return 'Would install';
    case 'current':
      return 'Already installed';
    case 'update_available':
      return 'Would update';
    case 'local_modified':
    case 'remote_changed_and_local_modified':
      return force ? 'Would replace' : 'Would skip modified';
  }
}

function sharedArtifactDryRunSuffix(status: SharedArtifactInstallStatus, force: boolean): string {
  if ((status === 'local_modified' || status === 'remote_changed_and_local_modified') && !force) {
    return ' (pass --force to replace local changes)';
  }
  return '';
}

function sharedArtifactInstallVerb(status: SharedArtifactInstallStatus, force: boolean): string {
  if (force && (status === 'local_modified' || status === 'remote_changed_and_local_modified')) {
    return 'Replaced';
  }
  if (status === 'update_available') {
    return 'Updated';
  }
  return 'Installed';
}

function sharedArtifactFilterLabel(options: ShareInstallArtifactsOptions | ShareListArtifactsOptions): string {
  const filters: string[] = [];
  if (options.kind !== undefined) {
    filters.push(`kind=${options.kind}`);
  }
  if (options.agent !== undefined) {
    filters.push(`agent=${options.agent}`);
  }
  if (options.name !== undefined) {
    filters.push(`name=${uriSegment(options.name)}`);
  }
  return filters.join(', ');
}

function sharedArtifactLabel(artifact: ShareArtifactMetadata): string {
  return `${artifact.kind} ${artifact.agent}/${artifact.name}`;
}

function sharedArtifactInstallPath(team: string, artifact: ShareArtifactMetadata): string {
  if (artifact.kind === 'skill' && artifact.agent === 'codex') {
    return join(homedir(), '.codex', 'skills', 'threadnote', team, artifact.name, 'SKILL.md');
  }
  if (artifact.kind === 'skill' && artifact.agent === 'claude') {
    return join(homedir(), '.claude', 'skills', 'threadnote', team, artifact.name, 'SKILL.md');
  }
  return join(homedir(), '.claude', 'commands', 'threadnote', team, `${artifact.name}.md`);
}

function printShareArtifactResult(result: ShareArtifactResult, preview: boolean): void {
  for (const message of result.messages) {
    console.log(message);
  }
  for (const gitMessage of result.gitMessages) {
    console.log(gitMessage);
  }
  if (preview && result.previewContent !== undefined) {
    console.log('-----BEGIN PREVIEW-----');
    console.log(result.previewContent);
    console.log('-----END PREVIEW-----');
  }
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
      await runCommand(ov, withIdentity(config, ['mkdir', uri, '--description', 'Threadnote shared context.']));
    } else {
      await maybeRun(false, ov, withIdentity(config, ['mkdir', uri, '--description', 'Threadnote shared context.']));
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
    await refreshMemoryIndex(config, ov, uri, options);
  } finally {
    await rm(stagingDir, {force: true, recursive: true});
  }
}

// Busy-retry backoff: read sequentially between attempts (between 0-1, 1-2, ...).
// `ov wait` returns immediately when the queue is already drained, so without an
// explicit sleep the 4 retries would burn in milliseconds. We need real elapsed
// time to give the OV background indexer that's holding the per-URI lock a
// chance to finish — the lock isn't observable via `ov wait`, only by actually
// waiting.
const BUSY_RETRY_BACKOFF_MS: readonly number[] = [2000, 5000, 10000, 20000, 30000];

async function writeOvFileWithRetry(
  config: ShareRuntime,
  ov: string,
  uri: string,
  fromFile: string,
  initialMode: 'create' | 'replace',
  options: {readonly quiet?: boolean} = {},
): Promise<void> {
  const maxAttempts = BUSY_RETRY_BACKOFF_MS.length + 1;
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
    // Resource-busy / being-processed errors mean OV still holds the URI's
    // per-resource lock from a background semantic/embedding indexer (e.g.,
    // a prior share sync that pulled the previous version of the same URI).
    // The lock isn't drained by `ov wait` because the worker has already
    // pulled its task from the queue and is processing — `ov wait` would
    // return immediately. Drain the queue first in case more work is
    // pending, then sleep real time so the indexer has a chance to release.
    // For network-class transients, fall back to the short fixed sleep
    // since `ov wait` would hit the same connectivity issue.
    if (isResourceBusyFailure(result.stderr, result.stdout)) {
      await waitForOvQueue(ov, config, options);
      await sleep(BUSY_RETRY_BACKOFF_MS[attempt] ?? 30000);
    } else {
      await sleep(1000 * (attempt + 1));
    }
  }
}

async function refreshMemoryIndex(
  config: ShareRuntime,
  ov: string,
  uri: string,
  options: {readonly quiet?: boolean} = {},
): Promise<void> {
  const result = await runCommand(
    ov,
    withIdentity(config, ['reindex', uri, '--mode', 'semantic_and_vectors', '--wait', 'true']),
    {allowFailure: true},
  );
  if (result.exitCode === 0) {
    if (options.quiet !== true && result.stdout.trim()) {
      console.log(result.stdout.trim());
    }
    if (options.quiet !== true && result.stderr.trim()) {
      console.error(result.stderr.trim());
    }
    return;
  }
  if (options.quiet !== true) {
    console.error(
      `Memory stored, but index refresh failed for ${uri}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
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

export function isTransientOvFailure(stderr: string, stdout: string): boolean {
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

export function isResourceBusyFailure(stderr: string, stdout: string): boolean {
  const output = `${stderr}\n${stdout}`.toLowerCase();
  return output.includes('resource is busy') || output.includes('resource is being processed');
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
  const maxAttempts = BUSY_RETRY_BACKOFF_MS.length + 1;
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
    if (isResourceBusyFailure(result.stderr, result.stdout)) {
      await waitForOvQueue(ov, config, options);
      await sleep(BUSY_RETRY_BACKOFF_MS[attempt] ?? 30000);
    } else {
      await sleep(1000 * (attempt + 1));
    }
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

interface ApplyChangesResult {
  readonly failed: readonly ChangedFile[];
}

// applyChangesToOpenViking only reflects changes to files under shareable
// top-level directories. For renames that cross those directories
// (e.g., handoffs/x.md -> durable/y.md), listChangedFiles emits a
// 'removed' for the old path and an 'added' for the new path; both are
// processed independently here. The 'removed' entry for a non-shareable path
// is filtered out by the firstSegment check, which is the desired outcome
// because non-shareable files are never reflected into OV's shared subtree.
//
// Per-change failures are non-fatal: we log a warning and continue with the
// other changes, returning the failed list so the caller can re-persist them
// to pendingReindexes for the next sync attempt. A single stuck URI (e.g.,
// OV holding a per-resource lock longer than our retry window) must not
// cause a whole sync to lose all the other files it could have applied.
async function applyChangesToOpenViking(
  config: ShareRuntime,
  team: ShareTeamConfig,
  changes: readonly ChangedFile[],
  options: {readonly quiet?: boolean} = {},
): Promise<ApplyChangesResult> {
  const ov = await openVikingCliForMode(false);
  const failed: ChangedFile[] = [];
  for (const change of changes) {
    if (!change.relativePath.endsWith('.md')) {
      continue;
    }
    const firstSegment = change.relativePath.split('/')[0];
    if (!SHAREABLE_TOP_LEVEL_DIRS.includes(firstSegment)) {
      continue;
    }
    const uri = workfileToVikingUri(config, team, change.path);
    try {
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (options.quiet !== true) {
        console.warn(`share sync: ${uri}: ingest failed — will retry on the next sync. ${message}`);
      }
      failed.push(change);
    }
  }
  return {failed};
}

export function mergeChanges(...lists: ReadonlyArray<readonly ChangedFile[]>): readonly ChangedFile[] {
  const map = new Map<string, ChangedFile>();
  for (const list of lists) {
    for (const change of list) {
      map.set(change.relativePath, change);
    }
  }
  return [...map.values()];
}

async function applyAndPersistChanges(
  config: ShareRuntime,
  team: ShareTeamConfig,
  state: AutoShareState,
  changes: readonly ChangedFile[],
  options: {readonly quiet?: boolean} = {},
): Promise<ApplyChangesResult> {
  if (changes.length === 0) {
    return {failed: []};
  }
  // Persist intent BEFORE applying so a crash mid-apply doesn't lose state.
  state.pendingReindexes.set(team.name, changes);
  await writePendingReindexes(config, state);
  const result = await applyChangesToOpenViking(config, team, changes, options);
  if (result.failed.length > 0) {
    state.pendingReindexes.set(team.name, result.failed);
  } else {
    state.pendingReindexes.delete(team.name);
  }
  await writePendingReindexes(config, state);
  return result;
}
