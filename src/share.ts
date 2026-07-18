import {lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, relative, sep} from 'node:path';
import {TextDecoder} from 'node:util';
import {uriSegment} from './manifest.js';
import {withIdentity} from './runtime.js';
import {applyScrubber, credentialScrubberBlocker, SCRUBBER_PATTERNS} from './scrubber.js';
import type {
  CommandResult,
  ShareAgentArtifactAgent,
  ShareAgentArtifactKind,
  ShareConflictOptions,
  ShareConflictResolveOptions,
  ShareConflictShowOptions,
  ShareConflictTake,
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
  reindexWaitTimeoutMs,
  removePath,
  requiredExecutable,
  runCommand,
  safeTimestamp,
  sha256,
  sleep,
} from './utils.js';

const TEAMS_FILE_VERSION = 1;
const SHARED_SEGMENT = 'shared';
const SHAREABLE_MEMORY_KIND_DIRS = ['durable'];
const SHAREABLE_ARTIFACT_DIR = 'agent-artifacts';
const SHAREABLE_TOP_LEVEL_DIRS = [...SHAREABLE_MEMORY_KIND_DIRS, SHAREABLE_ARTIFACT_DIR];
const SHAREABLE_ROOT_FILES = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'SKILL.md', '.gitignore'];
const ARTIFACT_INSTALL_METADATA_VERSION = 1;
const BUNDLE_MANIFEST_VERSION = 1;
// A shared skill carries its whole directory. These metadata files describe the
// bundle in the team repo (BUNDLE_MANIFEST_FILE) and track a local install
// (BUNDLE_INSTALL_METADATA_FILE); neither is treated as skill content.
const BUNDLE_MANIFEST_FILE = '.threadnote-bundle.json';
const BUNDLE_INSTALL_METADATA_FILE = '.threadnote-bundle-install.json';
// OpenViking writes these summaries into the worktree; they are gitignored and
// must never be packed as skill members.
const OV_SUMMARY_FILES: readonly string[] = ['.abstract.md', '.overview.md'];
// Directories and files that are skill runtime artifacts or local junk, never
// part of a shared skill bundle. `reviews/` and `repos/` are skill scratch dirs.
const BUNDLE_IGNORE_DIR_NAMES: readonly string[] = ['.git', 'node_modules', 'reviews', 'repos'];
// Constellation packs: multiple skills plus shared code that lives outside any
// single skill directory, published together so relative paths resolve once
// installed under one root. Authored from a `threadnote-bundle.json` manifest.
const PACK_INDEX_SUFFIX = '.pack.md';
const PACK_MANIFEST_SUFFIX = '.pack.json';
const PACK_FILES_DIR = 'files';
// Replaced into the author's absolute repo-root references at publish, expanded
// back to the real install directory at install time so hardcoded paths resolve
// on a teammate's machine.
const PACK_ROOT_TOKEN = '${THREADNOTE_PACK_ROOT}';
const AUTO_SHARE_FETCH_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_GIT_REMOTE_NAME = 'origin';

export {applyScrubber, scrubberBlocker} from './scrubber.js';

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
  // Present for skill artifacts: every file in the shared skill directory,
  // relative to it. A length > 1 means this is a multi-file bundle.
  readonly members?: readonly BundleMemberFile[];
  readonly sourceRelativePath: string;
  readonly sourcePath: string;
  readonly team: string;
}

interface BundleMemberFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export type SharedArtifactInstallStatus =
  'current' | 'local_modified' | 'not_installed' | 'remote_changed_and_local_modified' | 'update_available';

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

export interface ResolvedTeam {
  readonly config: ShareTeamConfig;
  readonly name: string;
}

export interface ChangedFile {
  readonly path: string;
  readonly previousContent?: string;
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

export interface ShareConflictSummary {
  readonly hasLocalContent: boolean;
  readonly hasPreviousContent: boolean;
  readonly hasSharedContent: boolean;
  readonly id: string;
  readonly reason: string;
  readonly relativePath: string;
  readonly status: ChangedFile['status'];
  readonly team: string;
  readonly uri: string;
}

export interface ShareConflictDetail extends ShareConflictSummary {
  readonly diff: string;
  readonly localContent?: string;
  readonly previousContent?: string;
  readonly resolutionGuidance: readonly string[];
  readonly sharedContent?: string;
}

export interface ShareConflictResolveResult {
  readonly backupPath?: string;
  readonly gitMessages: readonly string[];
  readonly id: string;
  readonly messages: readonly string[];
  readonly team: string;
  readonly uri: string;
}

type InspectedShareConflict = Omit<ShareConflictDetail, 'diff' | 'resolutionGuidance'>;

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
  await maybeRun(dryRun, git, [
    'clone',
    '-c',
    'core.symlinks=false',
    `--separate-git-dir=${gitdir}`,
    '--',
    remoteUrl,
    worktree,
  ]);

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

export function stopShareBackgroundFetch(config: ShareRuntime): void {
  const key = `${config.agentContextHome}:${config.account}:${config.user}`;
  const state = autoShareStates.get(key);
  if (state?.timer) {
    clearInterval(state.timer);
  }
  autoShareStates.delete(key);
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
        changes.push({
          path: entry.path,
          previousContent: typeof entry.previousContent === 'string' ? entry.previousContent : undefined,
          relativePath: entry.relativePath,
          status: entry.status,
        });
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
  const teams = await teamsForShareQuery(config, options.team);

  if (options.team) {
    const team = teams[0];
    if (!team) {
      throw new Error('No shared teams configured. Run: threadnote share init <remote-url>');
    }
    await runShareSyncForTeam(config, team, options);
    return;
  }

  const failures: string[] = [];
  for (const [index, team] of teams.entries()) {
    if (teams.length > 1) {
      console.log(`Syncing shared team "${team.name}" (${index + 1}/${teams.length})...`);
    }
    try {
      await runShareSyncForTeam(config, team, options);
    } catch (error) {
      failures.push(`${team.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      [`share sync failed for ${failures.length} shared team(s):`, ...failures.map(failure => `- ${failure}`)].join(
        '\n',
      ),
    );
  }
}

async function runShareSyncForTeam(config: ShareRuntime, team: ResolvedTeam, options: ShareSyncOptions): Promise<void> {
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
    const commitResult = await maybeRun(dryRun, git, ['-C', worktree, 'commit', '-m', message], {allowFailure: true});
    if (!dryRun && commitResult && commitResult.exitCode !== 0) {
      if (await hasUncommittedChanges(worktree)) {
        throw new Error(
          `Worktree ${worktree} has uncommitted changes that Threadnote did not auto-commit. Commit, remove, or ignore the remaining files, then rerun \`threadnote share sync\`.\nGit said: ${
            commitResult.stderr.trim() || commitResult.stdout.trim() || 'unknown git commit error'
          }`,
        );
      }
      throw new Error(
        `Could not auto-commit share worktree changes in ${worktree}: ${
          commitResult.stderr.trim() || commitResult.stdout.trim() || 'unknown git commit error'
        }`,
      );
    }
    if (!dryRun && (await hasUncommittedChanges(worktree))) {
      throw new Error(
        `Worktree ${worktree} still has uncommitted changes after staging Threadnote shareable files. Commit, remove, or ignore the remaining files, then rerun \`threadnote share sync\`.`,
      );
    }
  }

  const beforeRev = await gitOutput(worktree, ['rev-parse', 'HEAD'], dryRun);
  await maybeRun(dryRun, git, ['-C', worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME]);
  const pullResult = dryRun
    ? undefined
    : await runCommand(git, ['-C', worktree, 'rebase', '@{u}'], {allowFailure: true});
  if (dryRun) {
    console.log(`Would run: ${formatShellCommand(git, ['-C', worktree, 'rebase', '@{u}'])}`);
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
      `git rebase @{u} failed in ${worktree}: ${pullResult.stderr.trim() || pullResult.stdout.trim() || 'unknown error'}`,
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
        console.warn(formatShareConflictNextSteps(team.name, result.failed));
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

export async function runShareConflicts(config: ShareRuntime, options: ShareConflictOptions): Promise<void> {
  const conflicts = await listShareConflicts(config, options);
  if (conflicts.length === 0) {
    const team = options.team ? ` for team "${options.team}"` : '';
    console.log(`No pending shared memory conflicts${team}.`);
    return;
  }
  console.log(`Pending shared memory conflicts: ${conflicts.length}`);
  for (const conflict of conflicts) {
    console.log('');
    console.log(`${conflict.id}`);
    console.log(`  uri: ${conflict.uri}`);
    console.log(`  status: ${conflict.status}`);
    console.log(`  reason: ${conflict.reason}`);
    console.log(`  show: threadnote share conflict show ${conflict.id}`);
    console.log(`  take shared: threadnote share conflict resolve ${conflict.id} --take shared`);
    console.log(`  take local: threadnote share conflict resolve ${conflict.id} --take local`);
    console.log(`  merged file: threadnote share conflict resolve ${conflict.id} --from-file merged.md`);
  }
}

export async function runShareConflictShow(
  config: ShareRuntime,
  reference: string,
  options: ShareConflictShowOptions,
): Promise<void> {
  const detail = await showShareConflict(config, reference, options);
  console.log(`Conflict: ${detail.id}`);
  console.log(`URI: ${detail.uri}`);
  console.log(`Status: ${detail.status}`);
  console.log(`Reason: ${detail.reason}`);
  console.log('');
  console.log(detail.diff);
  console.log('');
  console.log('Resolve:');
  for (const line of detail.resolutionGuidance) {
    console.log(`  ${line}`);
  }
}

export async function runShareConflictResolve(
  config: ShareRuntime,
  reference: string,
  options: ShareConflictResolveOptions,
): Promise<void> {
  const result = await resolveShareConflict(config, reference, options);
  for (const message of result.messages) {
    console.log(message);
  }
  if (result.backupPath) {
    console.log(`Backup: ${portablePath(result.backupPath)}`);
  }
  for (const message of result.gitMessages) {
    console.log(message);
  }
  console.log(`Resolved shared memory conflict: ${result.id}`);
}

export async function listShareConflicts(
  config: ShareRuntime,
  options: ShareConflictOptions = {},
): Promise<readonly ShareConflictSummary[]> {
  const teams = await teamsForShareQuery(config, options.team);
  const state = autoShareState(config);
  await loadPendingReindexes(config, state);
  const summaries: ShareConflictSummary[] = [];
  for (const team of teams) {
    const pending = state.pendingReindexes.get(team.name) ?? [];
    for (const change of pending) {
      if (!isShareableMemoryChange(change)) {
        continue;
      }
      summaries.push(await buildShareConflictSummary(config, team, normalizePendingChange(team, change)));
    }
  }
  return summaries;
}

export async function showShareConflict(
  config: ShareRuntime,
  reference: string,
  options: ShareConflictShowOptions = {},
): Promise<ShareConflictDetail> {
  const conflict = await readPendingShareConflict(config, reference, options.team);
  const inspected = await inspectShareConflict(config, conflict.team, conflict.change);
  return {
    ...inspected,
    diff: formatShareConflictDiff(inspected),
    resolutionGuidance: shareConflictResolutionGuidance(inspected.id),
  };
}

export async function resolveShareConflict(
  config: ShareRuntime,
  reference: string,
  options: ShareConflictResolveOptions,
): Promise<ShareConflictResolveResult> {
  const fromFile = options.fromFile?.trim();
  const mergedContent = options.mergedContent;
  const rawTake = options.take as string | undefined;
  if (rawTake !== undefined && rawTake !== 'shared' && rawTake !== 'local') {
    throw new Error(`Unsupported --take value "${rawTake}". Expected "shared" or "local".`);
  }
  const take = rawTake as ShareConflictTake | undefined;
  if ((take ? 1 : 0) + (fromFile ? 1 : 0) + (mergedContent !== undefined ? 1 : 0) !== 1) {
    throw new Error(
      'Choose exactly one resolution: --take shared, --take local, --from-file <path>, or mergedContent via MCP.',
    );
  }
  const conflict = await readPendingShareConflict(config, reference, options.team);
  const inspected = await inspectShareConflict(config, conflict.team, conflict.change);
  const dryRun = options.dryRun === true;
  const ov = await openVikingCliForMode(dryRun);
  const messages: string[] = [];
  const gitMessages: string[] = [];
  const backupPath = dryRun ? undefined : await backupShareConflict(config, inspected);

  if (take === 'shared') {
    if (inspected.status === 'removed') {
      if (inspected.hasLocalContent) {
        await removeMemoryUri(config, ov, inspected.uri, dryRun);
        messages.push(`Accepted shared deletion for ${inspected.uri}.`);
      } else {
        messages.push(`Shared deletion was already reflected in OpenViking for ${inspected.uri}.`);
      }
    } else {
      if (inspected.sharedContent === undefined) {
        throw new Error(`Cannot take shared for ${inspected.id}: shared file is missing or not readable.`);
      }
      await ensureSharedDirectoryChain(config, ov, inspected.uri, dryRun);
      await writeMemoryFile(
        config,
        ov,
        inspected.uri,
        inspected.sharedContent,
        inspected.hasLocalContent ? 'replace' : 'create',
        dryRun,
      );
      messages.push(`Accepted shared file content for ${inspected.uri}.`);
    }
  } else {
    const content = await conflictResolutionContent(inspected, take, fromFile, mergedContent);
    await writeSharedConflictFile(conflict.team, inspected, content, dryRun);
    await ensureSharedDirectoryChain(config, ov, inspected.uri, dryRun);
    await writeMemoryFile(config, ov, inspected.uri, content, inspected.hasLocalContent ? 'replace' : 'create', dryRun);
    const message = options.message ?? `share: resolve ${inspected.relativePath}`;
    gitMessages.push(
      ...(await publishShareGitChange(conflict.team.config.worktree, inspected.relativePath, message, {
        dryRun,
        push: options.push,
      })),
    );
    messages.push(
      take === 'local'
        ? `Published local OpenViking content for ${inspected.uri}.`
        : `Applied merged content for ${inspected.uri}.`,
    );
  }

  if (!dryRun) {
    await clearPendingShareConflict(config, conflict.team.name, inspected.relativePath);
  }
  return {backupPath, gitMessages, id: inspected.id, messages, team: inspected.team, uri: inspected.uri};
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
    const result = await applyAndPersistChanges(config, team.config, state, pendingChanges, {quiet: true});
    if (result.failed.length > 0) {
      return `Shared team "${team.name}" has ${result.failed.length} pending shared memory conflict(s). Run \`threadnote share conflicts --team ${team.name}\` to inspect, then \`threadnote share conflict resolve <id> --take shared|local\` or \`--from-file <path>\`.`;
    }
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
      const result = await applyAndPersistChanges(config, team.config, state, combined, {quiet: true});
      if (result.failed.length > 0) {
        return `Shared team "${team.name}" has ${result.failed.length} pending shared memory conflict(s). Run \`threadnote share conflicts --team ${team.name}\` to inspect, then \`threadnote share conflict resolve <id> --take shared|local\` or \`--from-file <path>\`.`;
      }
    }
  }
  return undefined;
}

interface PendingShareConflict {
  readonly change: ChangedFile;
  readonly team: ResolvedTeam;
}

async function teamsForShareQuery(
  config: ShareRuntime,
  teamName: string | undefined,
): Promise<readonly ResolvedTeam[]> {
  if (teamName) {
    return [await resolveTeam(config, teamName)];
  }
  const teams = await readTeamsFile(config);
  const entries = Object.entries(teams.teams);
  if (entries.length === 0) {
    throw new Error('No shared teams configured. Run: threadnote share init <remote-url>');
  }
  return entries.map(([name, team]) => ({config: team, name}));
}

async function readPendingShareConflict(
  config: ShareRuntime,
  reference: string,
  optionTeam: string | undefined,
): Promise<PendingShareConflict> {
  const target = await parseShareConflictReference(config, reference, optionTeam);
  const state = autoShareState(config);
  await loadPendingReindexes(config, state);
  const pending = state.pendingReindexes.get(target.team.name) ?? [];
  const change = pending.find(candidate => candidate.relativePath === target.relativePath);
  if (!change) {
    const available = pending
      .filter(isShareableMemoryChange)
      .map(candidate => conflictId(target.team.name, candidate.relativePath));
    throw new Error(
      [
        `No pending shared memory conflict found for ${conflictId(target.team.name, target.relativePath)}.`,
        available.length > 0
          ? `Pending conflicts for this team:\n${available.map(id => `- ${id}`).join('\n')}`
          : `No pending conflicts for team "${target.team.name}".`,
      ].join('\n'),
    );
  }
  return {change: normalizePendingChange(target.team, change), team: target.team};
}

async function parseShareConflictReference(
  config: ShareRuntime,
  reference: string,
  optionTeam: string | undefined,
): Promise<{readonly relativePath: string; readonly team: ResolvedTeam}> {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new Error('Provide a conflict id, relative path, or viking:// shared memory URI.');
  }
  if (trimmed.startsWith('viking://')) {
    const teamName = sharedTeamNameForUri(config, trimmed);
    if (!teamName) {
      throw new Error(`Shared memory URI does not include a configured team: ${trimmed}`);
    }
    const team = await resolveTeam(config, optionTeam ?? teamName);
    return {relativePath: assertSafeShareRelativePath(vikingUriToWorktreeRelative(config, trimmed, team.name)), team};
  }
  const colon = trimmed.indexOf(':');
  if (colon > 0 && !trimmed.slice(0, colon).includes('/')) {
    const team = await resolveTeam(config, optionTeam ?? trimmed.slice(0, colon));
    return {relativePath: assertSafeShareRelativePath(trimmed.slice(colon + 1)), team};
  }
  const team = await resolveTeam(config, optionTeam);
  return {relativePath: assertSafeShareRelativePath(trimmed), team};
}

function assertSafeShareRelativePath(relativePath: string): string {
  if (
    !relativePath ||
    relativePath.startsWith('/') ||
    relativePath.split('/').some(segment => segment === '..' || segment.length === 0)
  ) {
    throw new Error(`Invalid shared relative path: ${relativePath}`);
  }
  return relativePath;
}

function normalizePendingChange(team: ResolvedTeam, change: ChangedFile): ChangedFile {
  return {...change, path: join(team.config.worktree, change.relativePath)};
}

function isShareableMemoryChange(change: ChangedFile): boolean {
  const firstSegment = change.relativePath.split('/')[0];
  return change.relativePath.endsWith('.md') && SHAREABLE_MEMORY_KIND_DIRS.includes(firstSegment);
}

async function buildShareConflictSummary(
  config: ShareRuntime,
  team: ResolvedTeam,
  change: ChangedFile,
): Promise<ShareConflictSummary> {
  const inspected = await inspectShareConflict(config, team, change);
  return {
    hasLocalContent: inspected.hasLocalContent,
    hasPreviousContent: inspected.hasPreviousContent,
    hasSharedContent: inspected.hasSharedContent,
    id: inspected.id,
    reason: inspected.reason,
    relativePath: inspected.relativePath,
    status: inspected.status,
    team: inspected.team,
    uri: inspected.uri,
  };
}

async function inspectShareConflict(
  config: ShareRuntime,
  team: ResolvedTeam,
  change: ChangedFile,
): Promise<InspectedShareConflict> {
  const ov = await openVikingCliForMode(false);
  const uri = workfileToVikingUri(config, team.config, change.path);
  const localContent = await readOptionalMemoryContent(config, ov, uri);
  const shared = await readOptionalSharedConflictContent(uri, change);
  const previousContent =
    change.previousContent === undefined ? undefined : prepareSharedInboundContent(uri, change.previousContent);
  return {
    hasLocalContent: localContent !== undefined,
    hasPreviousContent: previousContent !== undefined,
    hasSharedContent: shared.content !== undefined,
    id: conflictId(team.name, change.relativePath),
    localContent,
    previousContent,
    reason: shareConflictReason(change, localContent, shared.content, previousContent, shared.error),
    relativePath: change.relativePath,
    sharedContent: shared.content,
    status: change.status,
    team: team.name,
    uri,
  };
}

async function readOptionalSharedConflictContent(
  uri: string,
  change: ChangedFile,
): Promise<{readonly content?: string; readonly error?: string}> {
  try {
    if (change.status === 'removed' || !(await isRegularFileNoSymlink(change.path))) {
      return {};
    }
    return {content: await readSharedInboundFileContent(uri, change.path)};
  } catch (err: unknown) {
    return {error: err instanceof Error ? err.message : String(err)};
  }
}

async function readOptionalMemoryContent(config: ShareRuntime, ov: string, uri: string): Promise<string | undefined> {
  if (!(await vikingResourceExists(ov, config, uri))) {
    return undefined;
  }
  return readMemoryContent(config, ov, uri, false);
}

function shareConflictReason(
  change: ChangedFile,
  localContent: string | undefined,
  sharedContent: string | undefined,
  previousContent: string | undefined,
  sharedError: string | undefined,
): string {
  if (sharedError) {
    return `shared file is not readable: ${sharedError}`;
  }
  if (change.status === 'added') {
    if (localContent === undefined) {
      return 'shared file is pending ingestion into OpenViking';
    }
    if (sharedContent === undefined) {
      return 'shared file is missing or not readable';
    }
    return sharedMemoryContentsEquivalent(localContent, sharedContent)
      ? 'pending replay is already reflected in OpenViking'
      : 'local OpenViking content differs from the newly added shared file';
  }
  if (change.status === 'modified') {
    if (localContent === undefined) {
      return 'OpenViking resource is missing while a shared update is pending';
    }
    if (previousContent === undefined) {
      return 'previous shared content is unavailable, so local edits cannot be distinguished from upstream edits';
    }
    return sharedMemoryContentsEquivalent(localContent, previousContent)
      ? 'shared update is pending ingestion into OpenViking'
      : 'local OpenViking content differs from the previous shared version';
  }
  if (localContent === undefined) {
    return 'shared deletion is already reflected in OpenViking';
  }
  if (previousContent === undefined) {
    return 'previous shared content is unavailable, so local deletion cannot be verified safely';
  }
  return sharedMemoryContentsEquivalent(localContent, previousContent)
    ? 'shared deletion is pending removal from OpenViking'
    : 'local OpenViking content differs from the deleted shared version';
}

async function conflictResolutionContent(
  conflict: InspectedShareConflict,
  take: ShareConflictTake | undefined,
  fromFile: string | undefined,
  mergedContent: string | undefined,
): Promise<string> {
  const raw =
    fromFile !== undefined
      ? await readFile(expandPath(fromFile), 'utf8')
      : mergedContent !== undefined
        ? mergedContent
        : take === 'local'
          ? conflict.localContent
          : undefined;
  if (raw === undefined) {
    throw new Error(`Cannot resolve ${conflict.id}: local OpenViking content is unavailable.`);
  }
  const scrub = applyScrubber(stripPersonalProvenance(raw), {redact: false});
  if (scrub.blocker) {
    throw new Error(
      `Refusing to resolve ${conflict.id}: possible ${scrub.blocker}. Strip the sensitive value before writing it to shared memory.`,
    );
  }
  return scrub.cleaned;
}

async function writeSharedConflictFile(
  team: ResolvedTeam,
  conflict: InspectedShareConflict,
  content: string,
  dryRun: boolean,
): Promise<void> {
  const filePath = join(team.config.worktree, conflict.relativePath);
  if (dryRun) {
    console.log(`Would write shared file: ${portablePath(filePath)}`);
    return;
  }
  await mkdir(dirname(filePath), {recursive: true});
  await writeFile(filePath, content, 'utf8');
}

async function backupShareConflict(config: ShareRuntime, conflict: InspectedShareConflict): Promise<string> {
  const backupDir = join(
    config.agentContextHome,
    'share',
    'conflict-backups',
    safeTimestamp(),
    conflict.team,
    ...conflict.relativePath.split('/'),
  );
  await mkdir(backupDir, {recursive: true});
  const metadata = {
    id: conflict.id,
    reason: conflict.reason,
    relativePath: conflict.relativePath,
    status: conflict.status,
    team: conflict.team,
    uri: conflict.uri,
  };
  await writeFile(join(backupDir, 'metadata.json'), `${JSON.stringify(metadata, undefined, 2)}\n`, 'utf8');
  if (conflict.localContent !== undefined) {
    await writeFile(join(backupDir, 'local.md'), conflict.localContent, 'utf8');
  }
  if (conflict.sharedContent !== undefined) {
    await writeFile(join(backupDir, 'shared.md'), conflict.sharedContent, 'utf8');
  }
  if (conflict.previousContent !== undefined) {
    await writeFile(join(backupDir, 'previous.md'), conflict.previousContent, 'utf8');
  }
  return backupDir;
}

async function clearPendingShareConflict(config: ShareRuntime, teamName: string, relativePath: string): Promise<void> {
  const state = autoShareState(config);
  await loadPendingReindexes(config, state);
  const pending = state.pendingReindexes.get(teamName) ?? [];
  const remaining = pending.filter(change => change.relativePath !== relativePath);
  if (remaining.length > 0) {
    state.pendingReindexes.set(teamName, remaining);
  } else {
    state.pendingReindexes.delete(teamName);
  }
  await writePendingReindexes(config, state);
}

function conflictId(team: string, relativePath: string): string {
  return `${team}:${relativePath}`;
}

function shareConflictResolutionGuidance(id: string): readonly string[] {
  return [
    `threadnote share conflict resolve ${id} --take shared`,
    `threadnote share conflict resolve ${id} --take local`,
    `threadnote share conflict resolve ${id} --from-file merged.md`,
  ];
}

function formatShareConflictNextSteps(teamName: string, changes: readonly ChangedFile[]): string {
  const ids = changes.filter(isShareableMemoryChange).map(change => conflictId(teamName, change.relativePath));
  if (ids.length === 0) {
    return `Run \`threadnote share conflicts --team ${teamName}\` to inspect pending reindexes.`;
  }
  return [
    `Resolve pending shared memory conflicts with:`,
    `  threadnote share conflicts --team ${teamName}`,
    ...ids.flatMap(id => [
      `  threadnote share conflict show ${id}`,
      `  threadnote share conflict resolve ${id} --take shared`,
      `  threadnote share conflict resolve ${id} --take local`,
      `  threadnote share conflict resolve ${id} --from-file merged.md`,
    ]),
  ].join('\n');
}

function formatShareConflictDiff(conflict: InspectedShareConflict): string {
  const parts: string[] = [];
  if (conflict.previousContent !== undefined) {
    parts.push(
      formatTwoWayDiff('previous shared', conflict.previousContent, 'local OpenViking', conflict.localContent),
    );
  }
  parts.push(formatTwoWayDiff('local OpenViking', conflict.localContent, 'shared file', conflict.sharedContent));
  return parts.join('\n\n');
}

function formatTwoWayDiff(
  leftLabel: string,
  leftContent: string | undefined,
  rightLabel: string,
  rightContent: string | undefined,
): string {
  if (leftContent === undefined && rightContent === undefined) {
    return `${leftLabel} and ${rightLabel} are both unavailable.`;
  }
  if (leftContent === rightContent) {
    return `${leftLabel} and ${rightLabel} are identical.`;
  }
  const leftLines = splitDiffLines(leftContent);
  const rightLines = splitDiffLines(rightContent);
  const lines = [`--- ${leftLabel}`, `+++ ${rightLabel}`];
  for (const line of leftLines) {
    lines.push(`-${line}`);
  }
  for (const line of rightLines) {
    lines.push(`+${line}`);
  }
  return lines.join('\n');
}

function splitDiffLines(content: string | undefined): readonly string[] {
  if (content === undefined) {
    return ['<missing>'];
  }
  const lines = content.split(/\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1);
  }
  return lines;
}

async function stageShareableChanges(dryRun: boolean, git: string, worktree: string): Promise<void> {
  // Stage repo guidance/metadata plus every shareable top-level dir.
  // OpenViking-generated summaries (.abstract.md, .overview.md) are excluded
  // via the repo's .gitignore (ensureSharedGitignore self-heals it on every
  // sync), so they never get staged even by an unscoped `git add`.
  // First drop any incomplete pack orphaned by a killed publish, so the blanket
  // `git add -A` below never commits a pack index without its manifest.
  await removeOrphanPackIndexes(dryRun, git, worktree);
  const pathspecs = await existingShareablePathspecs(git, worktree);
  if (pathspecs.length === 0) {
    return;
  }
  await maybeRun(dryRun, git, ['-C', worktree, 'add', '-A', '--', ...pathspecs], {allowFailure: true});
}

// A pack whose <name>.pack.md index exists but whose <name>.pack.json manifest
// is missing is an incomplete publish (e.g. interrupted by SIGKILL). Discovery
// already skips such packs; this removes the UNTRACKED leftover before staging so
// `git add -A` cannot commit/push it. Tracked trees are never touched.
async function removeOrphanPackIndexes(dryRun: boolean, git: string, worktree: string): Promise<void> {
  const packsRoot = join(worktree, SHAREABLE_ARTIFACT_DIR, 'packs');
  if (!(await isDirectory(packsRoot))) {
    return;
  }
  for (const agentEntry of await readdir(packsRoot, {withFileTypes: true})) {
    if (!agentEntry.isDirectory()) {
      continue;
    }
    const agentDir = join(packsRoot, agentEntry.name);
    for (const nameEntry of await readdir(agentDir, {withFileTypes: true})) {
      if (!nameEntry.isDirectory()) {
        continue;
      }
      const packDir = join(agentDir, nameEntry.name);
      const indexPath = join(packDir, `${nameEntry.name}${PACK_INDEX_SUFFIX}`);
      const manifestPath = join(packDir, `${nameEntry.name}${PACK_MANIFEST_SUFFIX}`);
      if (!(await isFile(indexPath)) || (await isFile(manifestPath))) {
        continue;
      }
      const indexRelative = relative(worktree, indexPath).split(sep).join('/');
      const tracked = await runCommand(git, ['-C', worktree, 'ls-files', '--', indexRelative], {allowFailure: true});
      if (tracked.exitCode === 0 && tracked.stdout.trim().length > 0) {
        continue;
      }
      console.warn(
        `${dryRun ? 'Would remove' : 'Removing'} incomplete shared pack (missing ${nameEntry.name}${PACK_MANIFEST_SUFFIX}): ${indexRelative}`,
      );
      if (!dryRun) {
        await rm(packDir, {force: true, recursive: true});
      }
    }
  }
}

async function existingShareablePathspecs(git: string, worktree: string): Promise<readonly string[]> {
  const rootFiles = await Promise.all(
    SHAREABLE_ROOT_FILES.map(async file =>
      (await hasWorktreeOrTrackedPath(git, worktree, file)) ? `:(top)${file}` : undefined,
    ),
  );
  const topLevelDirs = await Promise.all(
    SHAREABLE_TOP_LEVEL_DIRS.map(async dir =>
      (await hasWorktreeOrTrackedPath(git, worktree, dir)) ? `:(top)${dir}` : undefined,
    ),
  );
  return [...rootFiles, ...topLevelDirs].filter((pathspec): pathspec is string => pathspec !== undefined);
}

async function hasWorktreeOrTrackedPath(git: string, worktree: string, relativePath: string): Promise<boolean> {
  if (await exists(join(worktree, relativePath))) {
    return true;
  }
  const result = await runCommand(git, ['-C', worktree, 'ls-files', '--', relativePath], {allowFailure: true});
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

export async function publishShareGitChange(
  worktree: string,
  relativePath: string | readonly string[],
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
  const paths = typeof relativePath === 'string' ? [relativePath] : [...relativePath];
  const stageArgs = verb === 'rm' ? ['-C', worktree, 'rm', '--', ...paths] : ['-C', worktree, 'add', '--', ...paths];
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
  const resolvedSourcePath = expandPath(sourcePath);
  if (!(await isRegularFileNoSymlink(resolvedSourcePath))) {
    throw new Error(`Agent artifact source is not a regular file: ${resolvedSourcePath}`);
  }

  const artifact = inferShareArtifact(resolvedSourcePath, options);
  // A skill carries its whole directory. When companion files sit beside the
  // SKILL.md it is shared as a multi-file bundle; a lone SKILL.md takes the same
  // single-file path as before, byte-for-byte.
  if (artifact.kind === 'skill') {
    const skillDir = dirname(resolvedSourcePath);
    const members = await collectBundleMemberFiles(skillDir);
    if (members.length > 1) {
      return shareBundleArtifact(config, team, artifact, skillDir, members, options);
    }
  }
  return shareSingleArtifact(config, team, resolvedSourcePath, artifact, options);
}

type ResolvedShareTeam = Awaited<ReturnType<typeof resolveTeam>>;

async function shareSingleArtifact(
  config: ShareRuntime,
  team: ResolvedShareTeam,
  resolvedSourcePath: string,
  artifact: ShareArtifactMetadata,
  options: SharePublishArtifactOptions,
): Promise<ShareArtifactResult> {
  const dryRun = options.dryRun === true;
  const preview = options.preview === true;
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

interface PreparedBundleMember {
  readonly binary: boolean;
  readonly blocker?: string;
  readonly content: Buffer | string;
  readonly redactions: ReadonlyArray<{readonly count: number; readonly name: string}>;
  readonly relativePath: string;
  readonly sha256: string;
  readonly targetPath: string;
  readonly targetUri: string;
}

async function shareBundleArtifact(
  config: ShareRuntime,
  team: ResolvedShareTeam,
  artifact: ShareArtifactMetadata,
  skillDir: string,
  members: readonly BundleMemberFile[],
  options: SharePublishArtifactOptions,
): Promise<ShareArtifactResult> {
  const dryRun = options.dryRun === true;
  const preview = options.preview === true;
  const skillRootRelative = `${SHAREABLE_ARTIFACT_DIR}/skills/${artifact.agent}/${artifact.name}`;
  const skillRootTargetDir = join(team.config.worktree, ...skillRootRelative.split('/'));
  const skillMdTargetPath = join(skillRootTargetDir, 'SKILL.md');
  const skillMdTargetUri = workfileToVikingUri(config, team.config, skillMdTargetPath);
  const skillRootTargetUri = parentUri(skillMdTargetUri);
  const skillMdSourcePath = join(skillDir, 'SKILL.md');

  const prepared = await Promise.all(
    members.map(member => prepareBundleMember(config, team, member, skillRootTargetDir, options)),
  );
  const skillMd = prepared.find(entry => entry.relativePath === 'SKILL.md');
  if (skillMd === undefined) {
    throw new Error(`Skill bundle ${artifact.agent}/${artifact.name} is missing SKILL.md.`);
  }
  if (!skillMd.binary && typeof skillMd.content === 'string' && !skillMd.content.trim()) {
    throw new Error(`Refusing to share empty agent artifact: ${skillMdSourcePath}`);
  }

  const messages: string[] = [
    `${preview ? 'Previewing' : dryRun ? 'Would share' : 'Sharing'} skill ${artifact.agent}/${artifact.name} bundle (${prepared.length} files)`,
    `Source: ${portablePath(skillDir)}`,
    `Destination: ${skillRootTargetUri}/`,
  ];

  const blockers = prepared.filter(entry => entry.blocker !== undefined);
  if (preview) {
    for (const entry of prepared) {
      const flags = entry.binary ? ['binary'] : [];
      for (const redaction of entry.redactions) {
        flags.push(`redact ${redaction.count}× ${redaction.name}`);
      }
      const note = entry.blocker !== undefined ? ` BLOCKED: ${entry.blocker}` : '';
      messages.push(`  ${entry.relativePath}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}${note}`);
    }
    return {
      artifact,
      gitMessages: [],
      messages,
      previewContent: skillMd.binary ? undefined : (skillMd.content as string),
      sourcePath: skillMdSourcePath,
      targetPath: skillMdTargetPath,
      targetUri: skillMdTargetUri,
    };
  }

  if (blockers.length > 0) {
    throw new Error(
      `Refusing to share skill ${artifact.agent}/${artifact.name}: ${blockers
        .map(entry => `${entry.relativePath} (${entry.blocker})`)
        .join('; ')}. Strip the value, pass --redact for local paths, or --allow-binary for binary files.`,
    );
  }
  for (const entry of prepared) {
    for (const redaction of entry.redactions) {
      messages.push(`Redacted ${redaction.count}× ${redaction.name} in ${entry.relativePath} before sharing.`);
    }
  }

  for (const entry of prepared) {
    const existing = await readFileBytesIfExists(entry.targetPath);
    if (existing !== undefined && sha256(existing) !== entry.sha256 && options.force !== true) {
      throw new Error(
        `Shared artifact already exists with different content: ${portablePath(entry.targetPath)}. Pass --force to replace it.`,
      );
    }
  }

  if (dryRun) {
    messages.push(`Would write ${prepared.length} files under ${portablePath(skillRootTargetDir)}`);
    return {
      artifact,
      gitMessages: [],
      messages,
      sourcePath: skillMdSourcePath,
      targetPath: skillMdTargetPath,
      targetUri: skillMdTargetUri,
    };
  }

  // Safety invariant: OpenViking-managed markdown is written first (SKILL.md
  // leading), so a failed OV write never leaves a worktree tree that a later
  // share sync would auto-commit without ingestion. Companion files and the
  // manifest are materialized only after every markdown write succeeds.
  const ov = await openVikingCliForMode(dryRun);
  const markdownMembers = orderSkillMdFirst(prepared.filter(entry => entry.relativePath.endsWith('.md')));
  const otherMembers = prepared.filter(entry => !entry.relativePath.endsWith('.md'));
  for (const entry of markdownMembers) {
    const ovHasResource = await vikingResourceExists(ov, config, entry.targetUri);
    await ensureSharedDirectoryChain(config, ov, entry.targetUri, dryRun, {quiet: true});
    await writeMemoryFile(
      config,
      ov,
      entry.targetUri,
      entry.content as string,
      ovHasResource ? 'replace' : 'create',
      dryRun,
      {quiet: true},
    );
  }
  await ensureDirectory(skillRootTargetDir, false);
  for (const entry of otherMembers) {
    await ensureDirectory(dirname(entry.targetPath), false);
    await writeFile(entry.targetPath, entry.content, entry.binary ? {mode: 0o600} : {encoding: 'utf8', mode: 0o600});
  }
  await writeFile(join(skillRootTargetDir, BUNDLE_MANIFEST_FILE), buildBundleManifest(artifact, prepared), {
    encoding: 'utf8',
    mode: 0o600,
  });

  const stagedPaths = [
    ...prepared.map(entry => `${skillRootRelative}/${entry.relativePath}`),
    `${skillRootRelative}/${BUNDLE_MANIFEST_FILE}`,
  ];
  const message =
    options.message ?? `share: publish skill ${artifact.agent}/${artifact.name} (${prepared.length} files)`;
  const gitMessages = await publishShareGitChange(team.config.worktree, stagedPaths, message, {
    dryRun,
    push: options.push,
  });
  return {
    artifact,
    gitMessages,
    messages,
    sourcePath: skillMdSourcePath,
    targetPath: skillMdTargetPath,
    targetUri: skillMdTargetUri,
  };
}

async function prepareBundleMember(
  config: ShareRuntime,
  team: ResolvedShareTeam,
  member: BundleMemberFile,
  skillRootTargetDir: string,
  options: SharePublishArtifactOptions,
): Promise<PreparedBundleMember> {
  const buffer = await readFile(member.absolutePath);
  const targetPath = join(skillRootTargetDir, ...member.relativePath.split('/'));
  const targetUri = workfileToVikingUri(config, team.config, targetPath);
  if (isProbablyBinary(buffer)) {
    const credential = detectBinaryCredential(buffer);
    const blocker =
      credential !== undefined
        ? `possible ${credential} embedded in binary file`
        : options.allowBinary === true
          ? undefined
          : 'binary file (pass --allow-binary to include it unscanned)';
    return {
      binary: true,
      blocker,
      content: buffer,
      redactions: [],
      relativePath: member.relativePath,
      sha256: sha256(buffer),
      targetPath,
      targetUri,
    };
  }
  const scrub = applyScrubber(buffer.toString('utf8'), {redact: options.redact === true});
  return {
    binary: false,
    blocker: scrub.blocker,
    content: scrub.cleaned,
    redactions: scrub.redactions,
    relativePath: member.relativePath,
    sha256: sha256(scrub.cleaned),
    targetPath,
    targetUri,
  };
}

function orderSkillMdFirst(entries: readonly PreparedBundleMember[]): readonly PreparedBundleMember[] {
  return [...entries].sort((a, b) => {
    if (a.relativePath === 'SKILL.md') {
      return -1;
    }
    if (b.relativePath === 'SKILL.md') {
      return 1;
    }
    return compareStrings(a.relativePath, b.relativePath);
  });
}

function buildBundleManifest(artifact: ShareArtifactMetadata, prepared: readonly PreparedBundleMember[]): string {
  const manifest = {
    artifact,
    members: prepared
      .map(entry => ({binary: entry.binary, path: entry.relativePath, sha256: entry.sha256}))
      .sort((a, b) => compareStrings(a.path, b.path)),
    version: BUNDLE_MANIFEST_VERSION,
  };
  return `${JSON.stringify(manifest, undefined, 2)}\n`;
}

async function collectBundleMemberFiles(skillDir: string): Promise<readonly BundleMemberFile[]> {
  const out: BundleMemberFile[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!BUNDLE_IGNORE_DIR_NAMES.includes(entry.name)) {
          await visit(full);
        }
        continue;
      }
      if (!entry.isFile() || isIgnoredBundleFile(entry.name)) {
        continue;
      }
      out.push({absolutePath: full, relativePath: relative(skillDir, full).split(sep).join('/')});
    }
  }
  await visit(skillDir);
  return out.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
}

function isIgnoredBundleFile(name: string): boolean {
  if (name === '.DS_Store' || name === BUNDLE_MANIFEST_FILE || name === BUNDLE_INSTALL_METADATA_FILE) {
    return true;
  }
  if (OV_SUMMARY_FILES.includes(name)) {
    return true;
  }
  return name.endsWith('.log') || name.endsWith('.threadnote-install.json');
}

function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return true;
  }
  try {
    new TextDecoder('utf-8', {fatal: true}).decode(buffer);
    return false;
  } catch (_err: unknown) {
    return true;
  }
}

function detectBinaryCredential(buffer: Buffer): string | undefined {
  return credentialScrubberBlocker(buffer.toString('latin1'));
}

// Scans binary bytes for a machine-local path that the pack rewriter would
// neutralize in text — a declared repo root, or a home-path soft-leak — so an
// --allow-binary member cannot silently carry one.
function detectBinaryLocalPath(buffer: Buffer, rewriteRoots: readonly string[]): string | undefined {
  const latin1 = buffer.toString('latin1');
  for (const root of rewriteRoots) {
    if (root.length > 0 && latin1.includes(root)) {
      return 'machine-local path';
    }
  }
  for (const pattern of SCRUBBER_PATTERNS) {
    if (pattern.placeholder !== undefined && pattern.regex.test(latin1)) {
      return pattern.name;
    }
  }
  return undefined;
}

async function readFileBytesIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (_err: unknown) {
    return undefined;
  }
}

function isBundleArtifact(artifact: SharedArtifactFile): boolean {
  if (artifact.artifact.kind === 'pack') {
    return true;
  }
  return artifact.members !== undefined && artifact.members.length > 1;
}

// Locale-independent ordering so manifests and git diffs are reproducible
// across machines regardless of the host locale.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface PackManifest {
  readonly agent: ShareAgentArtifactAgent;
  readonly deps: {
    readonly cli: readonly string[];
    readonly mcp: readonly string[];
    readonly os: readonly string[];
    readonly runtime: readonly string[];
  };
  readonly description?: string;
  readonly include: readonly string[];
  readonly name: string;
  readonly pathRewrites: readonly string[];
  readonly skills: readonly string[];
}

export async function runSharePublishBundle(
  config: ShareRuntime,
  manifestPath: string,
  options: SharePublishArtifactOptions,
): Promise<void> {
  const result = await shareBundlePack(config, manifestPath, options);
  printShareArtifactResult(result, options.preview === true);
}

function parsePackManifest(raw: string, manifestPath: string): PackManifest {
  const parsed = parseJsonConfigObject(raw);
  if (parsed === undefined) {
    throw new Error(`Invalid pack manifest (not a JSON object): ${manifestPath}`);
  }
  const name = parsed.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error(`Pack manifest must set a non-empty "name": ${manifestPath}`);
  }
  const agent = parsed.agent;
  if (agent !== 'codex' && agent !== 'claude') {
    throw new Error(`Pack manifest "agent" must be "codex" or "claude": ${manifestPath}`);
  }
  const stringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const skills = stringArray(parsed.skills);
  if (skills.length === 0) {
    throw new Error(`Pack manifest must list at least one skill in "skills": ${manifestPath}`);
  }
  const depsValue = (parsed.deps ?? {}) as Record<string, unknown>;
  const pathRewrites = Array.isArray(parsed.pathRewrites)
    ? parsed.pathRewrites
        .map(entry => (typeof entry === 'string' ? entry : (entry as {from?: unknown})?.from))
        .filter((item): item is string => typeof item === 'string')
        // Strip trailing slashes so a declared "/repo/" still matches a bare
        // "/repo" reference (otherwise the slash-suffixed root never appears and
        // the path leaks past tokenize + the residual check).
        .map(rewrite => rewrite.replace(/\/+$/, ''))
    : [];
  // pathRewrites are matched as whole repo-root prefixes; a short or relative
  // value would corrupt unrelated content via substring replacement.
  for (const rewrite of pathRewrites) {
    if (!isAbsolute(rewrite) || rewrite.split('/').filter(Boolean).length < 2) {
      throw new Error(
        `Pack manifest pathRewrites entry must be an absolute repo-root path (got "${rewrite}"): ${manifestPath}`,
      );
    }
  }
  return {
    agent,
    deps: {
      cli: stringArray(depsValue.cli),
      mcp: stringArray(depsValue.mcp),
      os: stringArray(depsValue.os),
      runtime: stringArray(depsValue.runtime),
    },
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    include: stringArray(parsed.include),
    name,
    pathRewrites,
    skills,
  };
}

// Resolves manifest skill + include entries into a flat, deduplicated member
// list whose relative paths preserve the author's repo layout so relative
// imports and CWD-relative invocations resolve once installed under one root.
async function collectPackMembers(manifestDir: string, manifest: PackManifest): Promise<readonly BundleMemberFile[]> {
  const members = new Map<string, BundleMemberFile>();
  const addEntry = async (entry: string): Promise<void> => {
    const normalized = entry.split('/').filter(Boolean).join('/');
    if (normalized.split('/').includes('..')) {
      throw new Error(`Pack manifest entries must stay within the pack root (got "${entry}").`);
    }
    const absolute = join(manifestDir, ...normalized.split('/'));
    if (absolute !== manifestDir && !absolute.startsWith(manifestDir + sep)) {
      throw new Error(`Pack manifest entry escapes the pack root: ${entry}`);
    }
    if (await isDirectory(absolute)) {
      for (const member of await collectBundleMemberFiles(absolute)) {
        const relativePath = `${normalized}/${member.relativePath}`;
        members.set(relativePath, {absolutePath: member.absolutePath, relativePath});
      }
      return;
    }
    if (await isRegularFileNoSymlink(absolute)) {
      members.set(normalized, {absolutePath: absolute, relativePath: normalized});
      return;
    }
    throw new Error(`Pack manifest references a missing path: ${entry}`);
  };
  for (const skill of manifest.skills) {
    // Accept either a skill directory or a path to its SKILL.md.
    const skillRel = skill.replace(/\/SKILL\.md$/i, '');
    const skillDir = join(manifestDir, ...skillRel.split('/'));
    if (!(await isFile(join(skillDir, 'SKILL.md')))) {
      throw new Error(`Pack skill "${skill}" must be a directory containing SKILL.md.`);
    }
    await addEntry(skillRel);
  }
  for (const include of manifest.include) {
    await addEntry(include);
  }
  return [...members.values()].sort((a, b) => compareStrings(a.relativePath, b.relativePath));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replaces each repo-root prefix with the portable token, anchored on BOTH
// sides to a path boundary: the left lookbehind stops a root from matching when
// it is embedded as a path-segment suffix of a longer path (e.g. inside
// "/backup/Users/alice/reviewer"); the right lookahead stops it from matching a
// longer token ("/repo" must not rewrite inside "/repository") and accepts the
// common path terminators (`/ \\ " ' ` whitespace ) , > : ] } ; =`).
function tokenizePackPaths(text: string, rewriteRoots: readonly string[]): string {
  let out = text;
  for (const root of rewriteRoots) {
    if (root.length > 0) {
      out = out.replace(
        new RegExp(`(?<![A-Za-z0-9/._~-])${escapeRegExp(root)}(?=[/\\\\]|["'\`\\s),>:\\]};=]|$)`, 'g'),
        PACK_ROOT_TOKEN,
      );
    }
  }
  return out;
}

// A declared rewrite root still present after tokenization (e.g. followed by a
// non-boundary char like '-' so the prefix wasn't rewritten) is a residual
// machine-local path. Text members rely on this to match the substring check
// detectBinaryLocalPath already applies to binary members.
function residualRewriteRoot(content: string, rewriteRoots: readonly string[]): string | undefined {
  return rewriteRoots.find(root => root.length > 0 && content.includes(root));
}

// Absolute path prefixes that are portable across machines (system/tool paths),
// so a surviving reference to them is not flagged as a machine-local leak.
const PORTABLE_PATH_PREFIXES: readonly string[] = [
  '/usr/',
  '/bin/',
  '/sbin/',
  '/lib/',
  '/lib64/',
  '/etc/',
  '/opt/homebrew/',
  '/tmp/',
  '/var/',
  '/private/var/',
  '/dev/',
  '/proc/',
  '/run/',
  '/sys/',
  '/Library/',
  '/System/',
  '/Applications/',
];

// Best-effort detector of machine-local absolute paths that tokenization and the
// scrubber do not catch (anything that isn't /Users, /home, a rewrite root, or a
// portable system prefix). Advisory only — used to WARN, never to block, because
// many absolute paths (/usr/bin, /bin/sh) are legitimately portable.
function unportableAbsolutePaths(content: string): readonly string[] {
  // Drop the portable pack-root token (and the path that follows it) so paths
  // anchored to the install root are not mistaken for machine-local leaks.
  const scan = content.split(`${PACK_ROOT_TOKEN}/`).join('').split(PACK_ROOT_TOKEN).join('');
  const found = new Set<string>();
  for (const path of scan.match(/(?<![A-Za-z0-9._~$-])\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g) ?? []) {
    if (!PORTABLE_PATH_PREFIXES.some(prefix => path.startsWith(prefix))) {
      found.add(path);
    }
  }
  for (const path of scan.match(/[A-Za-z]:\\[^\s"']+/g) ?? []) {
    found.add(path);
  }
  return [...found].sort((a, b) => compareStrings(a, b));
}

async function preparePackMember(
  config: ShareRuntime,
  team: ResolvedShareTeam,
  member: BundleMemberFile,
  filesTargetDir: string,
  rewriteRoots: readonly string[],
  options: SharePublishArtifactOptions,
): Promise<PreparedBundleMember> {
  const buffer = await readFile(member.absolutePath);
  const targetPath = join(filesTargetDir, ...member.relativePath.split('/'));
  const targetUri = workfileToVikingUri(config, team.config, targetPath);
  if (isProbablyBinary(buffer)) {
    // Binary members cannot be tokenized or scrubbed, so an embedded credential
    // or machine-local path can never be neutralized — block rather than ship it
    // silently, even with --allow-binary.
    const credential = detectBinaryCredential(buffer);
    const localPath = credential === undefined ? detectBinaryLocalPath(buffer, rewriteRoots) : undefined;
    let blocker: string | undefined;
    if (credential !== undefined) {
      blocker = `possible ${credential} embedded in binary file`;
    } else if (options.allowBinary !== true) {
      blocker = 'binary file (pass --allow-binary to include it unscanned)';
    } else if (localPath !== undefined) {
      blocker = `possible ${localPath} embedded in binary file (cannot be rewritten)`;
    }
    return {
      binary: true,
      blocker,
      content: buffer,
      redactions: [],
      relativePath: member.relativePath,
      sha256: sha256(buffer),
      targetPath,
      targetUri,
    };
  }
  const text = buffer.toString('utf8');
  // A member that already contains the reserved token would have it expanded to
  // the installer's absolute path at install — block it as an authoring error.
  if (text.includes(PACK_ROOT_TOKEN)) {
    return {
      binary: false,
      blocker: `contains the reserved ${PACK_ROOT_TOKEN} token`,
      content: text,
      redactions: [],
      relativePath: member.relativePath,
      sha256: sha256(text),
      targetPath,
      targetUri,
    };
  }
  // Rewrite hardcoded repo-root paths to the portable token BEFORE scrubbing.
  // The residual net is PARTIAL: a surviving declared/auto rewrite root
  // (residualRewriteRoot) and /Users or /home paths (scrubber) block the publish,
  // but other machine-local absolute paths (/opt, /srv, /Volumes, Windows C:\\)
  // are NOT auto-detected — authors must declare them in pathRewrites or strip
  // them. See docs/share.md and the known-limitations follow-up.
  const tokenized = tokenizePackPaths(text, rewriteRoots);
  // Honor --redact only for prose (.md). Redacting a soft-leak path inside an
  // executable member would silently rewrite it to <local-path> and break the
  // file at runtime, so code members always block on a residual path instead.
  const isMarkdown = member.relativePath.toLowerCase().endsWith('.md');
  const scrub = applyScrubber(tokenized, {redact: isMarkdown && options.redact === true});
  const residual = residualRewriteRoot(scrub.cleaned, rewriteRoots);
  const blocker =
    scrub.blocker ?? (residual !== undefined ? `machine-local path "${residual}" not rewritten` : undefined);
  return {
    binary: false,
    blocker,
    content: scrub.cleaned,
    redactions: scrub.redactions,
    relativePath: member.relativePath,
    sha256: sha256(scrub.cleaned),
    targetPath,
    targetUri,
  };
}

function buildPackIndex(
  artifact: ShareArtifactMetadata,
  manifest: PackManifest,
  skillNames: readonly string[],
  memberCount: number,
): string {
  const lines = [
    '---',
    `name: ${artifact.name}`,
    `agent: ${artifact.agent}`,
    'kind: pack',
    `skills: [${skillNames.join(', ')}]`,
    '---',
    '',
    `# ${artifact.name} (skill pack)`,
    '',
    manifest.description ??
      `A Threadnote skill pack bundling ${skillNames.length} skill(s) and their shared support files (${memberCount} files total).`,
    '',
    '## Skills',
    ...skillNames.map(skill => `- ${skill}`),
    '',
    '## Requirements',
    'Threadnote installs files only. Ensure these exist on the target machine before running:',
  ];
  if (manifest.deps.runtime.length > 0) {
    lines.push(`- runtime: ${manifest.deps.runtime.join(', ')}`);
  }
  if (manifest.deps.cli.length > 0) {
    lines.push(`- CLI: ${manifest.deps.cli.join(', ')}`);
  }
  if (manifest.deps.os.length > 0) {
    lines.push(`- OS: ${manifest.deps.os.join(', ')}`);
  }
  if (manifest.deps.mcp.length > 0) {
    lines.push(`- MCP (configure separately): ${manifest.deps.mcp.join(', ')}`);
  }
  lines.push('', `Install: threadnote share install-artifacts --kind pack --name ${artifact.name} --apply`, '');
  return lines.join('\n');
}

function buildPackManifestJson(
  artifact: ShareArtifactMetadata,
  manifest: PackManifest,
  prepared: readonly PreparedBundleMember[],
): string {
  const data = {
    artifact,
    deps: manifest.deps,
    members: prepared
      .map(entry => ({binary: entry.binary, path: entry.relativePath, sha256: entry.sha256}))
      .sort((a, b) => compareStrings(a.path, b.path)),
    version: BUNDLE_MANIFEST_VERSION,
  };
  return `${JSON.stringify(data, undefined, 2)}\n`;
}

function packSkillName(skillEntry: string): string {
  const trimmed = skillEntry.replace(/\/SKILL\.md$/i, '');
  return basename(trimmed);
}

export async function shareBundlePack(
  config: ShareRuntime,
  manifestPath: string,
  options: SharePublishArtifactOptions,
): Promise<ShareArtifactResult> {
  const team = await resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  const preview = options.preview === true;
  const resolvedManifest = expandPath(manifestPath);
  if (!(await isRegularFileNoSymlink(resolvedManifest))) {
    throw new Error(`Pack manifest is not a regular file: ${resolvedManifest}`);
  }
  const manifest = parsePackManifest(await readFile(resolvedManifest, 'utf8'), resolvedManifest);
  const manifestDir = dirname(resolvedManifest);
  const artifact: ShareArtifactMetadata = {agent: manifest.agent, kind: 'pack', name: uriSegment(manifest.name)};
  const skillNames = manifest.skills.map(packSkillName);

  const members = await collectPackMembers(manifestDir, manifest);
  // Auto-derive the manifest dir as a rewrite root only when it is a plausible
  // repo root (>= 2 path segments); a short top-level dir like /tmp would
  // substring-corrupt unrelated paths. Declared pathRewrites are already guarded.
  const autoRoots = manifestDir.split('/').filter(Boolean).length >= 2 ? [manifestDir] : [];
  // Longest-first so a nested declared root rewrites before its parent.
  const rewriteRoots = [...new Set([...autoRoots, ...manifest.pathRewrites])].sort((a, b) => b.length - a.length);

  const packRootRelative = `${SHAREABLE_ARTIFACT_DIR}/packs/${artifact.agent}/${artifact.name}`;
  const filesRelative = `${packRootRelative}/${PACK_FILES_DIR}`;
  const indexRelative = `${packRootRelative}/${artifact.name}${PACK_INDEX_SUFFIX}`;
  const manifestRelative = `${packRootRelative}/${artifact.name}${PACK_MANIFEST_SUFFIX}`;
  const filesTargetDir = join(team.config.worktree, ...filesRelative.split('/'));
  const packRootTargetDir = join(team.config.worktree, ...packRootRelative.split('/'));
  const indexTargetPath = join(team.config.worktree, ...indexRelative.split('/'));
  const indexTargetUri = workfileToVikingUri(config, team.config, indexTargetPath);

  const prepared = await Promise.all(
    members.map(member => preparePackMember(config, team, member, filesTargetDir, rewriteRoots, options)),
  );
  // Tokenize the generated index + manifest too (not just member files) so an
  // author repo-root path embedded in description/deps is normalized to the
  // portable token rather than leaking or noisily blocking.
  const indexContent = tokenizePackPaths(buildPackIndex(artifact, manifest, skillNames, prepared.length), rewriteRoots);
  const indexScrub = applyScrubber(indexContent, {redact: options.redact === true});

  const messages: string[] = [
    `${preview ? 'Previewing' : dryRun ? 'Would share' : 'Sharing'} pack ${artifact.agent}/${artifact.name} (${prepared.length} files, ${skillNames.length} skills)`,
    `Source: ${portablePath(manifestDir)}`,
    `Destination: ${indexTargetUri}`,
  ];

  const blockers = prepared.filter(entry => entry.blocker !== undefined);
  if (preview) {
    for (const entry of prepared) {
      const flags = entry.binary ? ['binary'] : [];
      for (const redaction of entry.redactions) {
        flags.push(`redact ${redaction.count}× ${redaction.name}`);
      }
      const note = entry.blocker !== undefined ? ` BLOCKED: ${entry.blocker}` : '';
      messages.push(`  ${entry.relativePath}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}${note}`);
    }
    return {
      artifact,
      gitMessages: [],
      messages,
      previewContent: indexScrub.cleaned,
      sourcePath: resolvedManifest,
      targetPath: indexTargetPath,
      targetUri: indexTargetUri,
    };
  }

  const indexResidual = residualRewriteRoot(indexScrub.cleaned, rewriteRoots);
  if (indexScrub.blocker !== undefined || indexResidual !== undefined) {
    throw new Error(
      `Refusing to share pack ${artifact.agent}/${artifact.name}: index ${indexScrub.blocker ?? `machine-local path "${indexResidual}" not rewritten`}.`,
    );
  }
  if (blockers.length > 0) {
    throw new Error(
      `Refusing to share pack ${artifact.agent}/${artifact.name}: ${blockers
        .map(entry => `${entry.relativePath} (${entry.blocker})`)
        .join('; ')}. Strip the value, pass --redact for local paths, or --allow-binary for binary files.`,
    );
  }
  // The generated .pack.json is shared text too — tokenize then route it through
  // the scrubber so no field can leak a secret or local path past the chokepoint.
  const packJson = applyScrubber(tokenizePackPaths(buildPackManifestJson(artifact, manifest, prepared), rewriteRoots), {
    redact: options.redact === true,
  });
  const packJsonResidual = residualRewriteRoot(packJson.cleaned, rewriteRoots);
  if (packJson.blocker !== undefined || packJsonResidual !== undefined) {
    throw new Error(
      `Refusing to share pack ${artifact.agent}/${artifact.name}: manifest ${packJson.blocker ?? `machine-local path "${packJsonResidual}" not rewritten`}.`,
    );
  }
  for (const entry of prepared) {
    for (const redaction of entry.redactions) {
      messages.push(`Redacted ${redaction.count}× ${redaction.name} in ${entry.relativePath} before sharing.`);
    }
  }
  // Advisory: surface machine-local absolute paths the rewriter/scrubber cannot
  // auto-detect (e.g. /opt, /srv, /Volumes, Windows C:\) so the author can add a
  // pathRewrite or strip them. Non-blocking — many absolute paths are portable.
  const unportable = new Set<string>();
  for (const entry of prepared) {
    if (!entry.binary && typeof entry.content === 'string') {
      for (const path of unportableAbsolutePaths(entry.content)) {
        unportable.add(`${entry.relativePath}: ${path}`);
      }
    }
  }
  for (const path of unportableAbsolutePaths(indexScrub.cleaned)) {
    unportable.add(`${artifact.name}${PACK_INDEX_SUFFIX}: ${path}`);
  }
  for (const path of unportableAbsolutePaths(packJson.cleaned)) {
    unportable.add(`${artifact.name}${PACK_MANIFEST_SUFFIX}: ${path}`);
  }
  if (unportable.size > 0) {
    messages.push(
      `Warning: possible machine-local absolute path(s) that will not resolve on a teammate's machine (declare in pathRewrites or strip if not portable): ${[...unportable].join('; ')}`,
    );
  }
  for (const entry of prepared) {
    const existing = await readFileBytesIfExists(entry.targetPath);
    if (existing !== undefined && sha256(existing) !== entry.sha256 && options.force !== true) {
      throw new Error(
        `Shared pack file already exists with different content: ${portablePath(entry.targetPath)}. Pass --force to replace it.`,
      );
    }
  }

  if (dryRun) {
    messages.push(`Would write ${prepared.length} files under ${portablePath(packRootTargetDir)}`);
    return {
      artifact,
      gitMessages: [],
      messages,
      sourcePath: resolvedManifest,
      targetPath: indexTargetPath,
      targetUri: indexTargetUri,
    };
  }

  // Safety invariant: OpenViking-managed markdown is written first (the index
  // leads), so a failed OV write never leaves a worktree tree that a later share
  // sync would auto-commit without ingestion.
  const ov = await openVikingCliForMode(dryRun);
  // Restore-capable rollback: before overwriting any resource, snapshot its prior
  // bytes; on a mid-publish failure, undo in reverse — newly-created resources are
  // removed and replaced ones (a --force re-publish) are restored to their prior
  // content. This leaves the previously-published pack intact and nothing
  // inconsistent for a later share sync to auto-commit.
  const rollbacks: Array<() => Promise<void>> = [];
  const manifestTargetPath = join(team.config.worktree, ...manifestRelative.split('/'));
  try {
    const writeMarkdownMember = async (uri: string, content: string, worktreePath: string): Promise<void> => {
      const priorBytes = await readFileBytesIfExists(worktreePath);
      const hadResource = await vikingResourceExists(ov, config, uri);
      await ensureSharedDirectoryChain(config, ov, uri, dryRun, {quiet: true});
      await writeMemoryFile(config, ov, uri, content, hadResource ? 'replace' : 'create', dryRun, {quiet: true});
      rollbacks.push(async () => {
        if (priorBytes !== undefined) {
          await writeMemoryFile(config, ov, uri, priorBytes.toString('utf8'), 'replace', false, {quiet: true});
        } else if (await vikingResourceExists(ov, config, uri)) {
          await removeMemoryUri(config, ov, uri, false, {quiet: true});
        }
      });
    };
    await writeMarkdownMember(indexTargetUri, indexScrub.cleaned, indexTargetPath);
    for (const entry of prepared.filter(member => member.relativePath.endsWith('.md'))) {
      await writeMarkdownMember(entry.targetUri, entry.content as string, entry.targetPath);
    }
    await ensureDirectory(filesTargetDir, false);
    for (const entry of prepared.filter(member => !member.relativePath.endsWith('.md'))) {
      const priorBytes = await readFileBytesIfExists(entry.targetPath);
      await ensureDirectory(dirname(entry.targetPath), false);
      await writeFile(entry.targetPath, entry.content, entry.binary ? {mode: 0o600} : {encoding: 'utf8', mode: 0o600});
      rollbacks.push(async () => {
        if (priorBytes !== undefined) {
          await writeFile(entry.targetPath, priorBytes, {mode: 0o600});
        } else {
          await rm(entry.targetPath, {force: true});
        }
      });
    }
    await ensureDirectory(packRootTargetDir, false);
    const priorManifest = await readFileBytesIfExists(manifestTargetPath);
    await writeFile(manifestTargetPath, packJson.cleaned, {encoding: 'utf8', mode: 0o600});
    rollbacks.push(async () => {
      if (priorManifest !== undefined) {
        await writeFile(manifestTargetPath, priorManifest, {mode: 0o600});
      } else {
        await rm(manifestTargetPath, {force: true});
      }
    });

    // Prune files orphaned by a re-publish (members dropped from the manifest) so
    // stale code is neither carried in the shared repo nor installed by teammates.
    const currentFiles = new Set(prepared.map(entry => `${filesRelative}/${entry.relativePath}`));
    const git = await requiredExecutable('git');
    const tracked = await runCommand(git, ['-C', team.config.worktree, 'ls-files', '--', filesRelative], {
      allowFailure: true,
    });
    const stalePaths =
      tracked.exitCode === 0
        ? tracked.stdout
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !currentFiles.has(line))
        : [];
    for (const stale of stalePaths) {
      await runCommand(git, ['-C', team.config.worktree, 'rm', '-f', '--ignore-unmatch', '--', stale], {
        allowFailure: true,
      });
      // Nested .md members are OV-ingested, so drop their resource too — keep the
      // OpenViking index and the git tree in lockstep on the publisher's machine.
      // Best-effort: the `git rm` deletion is already staged, so a single OV
      // removal failure must not abort the publish (which would leave a staged
      // deletion behind for a later sync); surface it as a warning instead.
      if (stale.endsWith('.md')) {
        const staleUri = workfileToVikingUri(config, team.config, join(team.config.worktree, ...stale.split('/')));
        try {
          if (await vikingResourceExists(ov, config, staleUri)) {
            await removeMemoryUri(config, ov, staleUri, dryRun, {quiet: true});
          }
        } catch (pruneErr: unknown) {
          messages.push(
            `Warning: could not remove stale OpenViking resource ${staleUri}: ${pruneErr instanceof Error ? pruneErr.message : String(pruneErr)}`,
          );
        }
      }
    }
  } catch (publishErr: unknown) {
    for (const undo of rollbacks.reverse()) {
      try {
        await undo();
      } catch (_cleanupErr: unknown) {
        // Best-effort rollback; surface the original failure regardless.
      }
    }
    throw publishErr;
  }

  const stagedPaths = [
    indexRelative,
    manifestRelative,
    ...prepared.map(entry => `${filesRelative}/${entry.relativePath}`),
  ];
  const message =
    options.message ?? `share: publish pack ${artifact.agent}/${artifact.name} (${prepared.length} files)`;
  const gitMessages = await publishShareGitChange(team.config.worktree, stagedPaths, message, {
    dryRun,
    push: options.push,
  });
  return {
    artifact,
    gitMessages,
    messages,
    sourcePath: resolvedManifest,
    targetPath: indexTargetPath,
    targetUri: indexTargetUri,
  };
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
    if (isBundleArtifact(artifact)) {
      installedCount += await installBundleArtifact(artifact, options, dryRun, messages);
      continue;
    }
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
    console.log(`Would update git core.worktree and the worktree .git pointer for team "${newName}".`);
    console.log(`Would reindex shared context under team "${newName}" and remove old shared URI tree.`);
    console.log(`Would write teams file: ${teamsFilePath(config)}`);
    return;
  }

  const git = await requiredExecutable('git');
  // A clone made with --separate-git-dir has a .git file in the worktree that
  // points at the external gitdir. Moving both paths first leaves that pointer
  // aimed at the old location, so `git -C <new-worktree>` can no longer open
  // the repository. Update the gitdir config before moving it, then rewrite
  // the pointer after both renames. Roll back the filesystem pair if any of
  // those steps fail so teams.json never advertises a half-renamed checkout.
  await runCommand(git, ['--git-dir', oldTeam.config.gitdir, 'config', 'core.worktree', newWorktree]);
  let movedWorktree = false;
  let movedGitdir = false;
  try {
    await rename(oldTeam.config.worktree, newWorktree);
    movedWorktree = true;
    await rename(oldTeam.config.gitdir, newGitdir);
    movedGitdir = true;
    await writeFile(join(newWorktree, '.git'), `gitdir: ${newGitdir}\n`, 'utf8');
    await runCommand(git, ['--git-dir', newGitdir, '--work-tree', newWorktree, 'rev-parse', '--show-toplevel']);
    await writeTeamsFile(config, updatedFile);
  } catch (cause: unknown) {
    if (movedGitdir && (await exists(newGitdir))) {
      await rename(newGitdir, oldTeam.config.gitdir).catch(() => undefined);
    }
    if (movedWorktree && (await exists(newWorktree))) {
      await writeFile(join(newWorktree, '.git'), `gitdir: ${oldTeam.config.gitdir}\n`, 'utf8').catch(() => undefined);
      await rename(newWorktree, oldTeam.config.worktree).catch(() => undefined);
    }
    if (await exists(oldTeam.config.gitdir)) {
      await runCommand(git, ['--git-dir', oldTeam.config.gitdir, 'config', 'core.worktree', oldTeam.config.worktree], {
        allowFailure: true,
      });
    }
    throw cause;
  }
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
      `Would run: ${formatShellCommand(git, ['-C', team.config.worktree, 'remote', 'set-url', DEFAULT_GIT_REMOTE_NAME, '--', remoteUrl])}`,
    );
    console.log(
      `Would run: ${formatShellCommand(git, ['-C', team.config.worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME])}`,
    );
    console.log(`Would write teams file: ${teamsFilePath(config)}`);
    return;
  }
  await runCommand(git, ['-C', team.config.worktree, 'remote', 'set-url', DEFAULT_GIT_REMOTE_NAME, '--', remoteUrl]);
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
      if (!entry.name.endsWith('.md') || OV_SUMMARY_FILES.includes(entry.name)) {
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
  if (
    parts.length === 5 &&
    parts[1] === 'packs' &&
    (parts[2] === 'codex' || parts[2] === 'claude') &&
    parts[4] === `${parts[3]}${PACK_INDEX_SUFFIX}`
  ) {
    return {agent: parts[2], kind: 'pack', name: parts[3]};
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
      const artifactDir = dirname(full);
      // An orphaned pack index without its .pack.json is an incomplete/partial
      // publish; skip it so it neither pollutes the catalog nor breaks discovery.
      if (artifact.kind === 'pack' && !(await isFile(join(artifactDir, `${artifact.name}${PACK_MANIFEST_SUFFIX}`)))) {
        console.warn(
          `Skipping incomplete shared pack (missing ${artifact.name}${PACK_MANIFEST_SUFFIX}): ${relativePath}`,
        );
        continue;
      }
      // Isolate per-artifact discovery failures so one malformed artifact never
      // denies listing/install of the rest of the team's catalog.
      try {
        out.push({
          artifact,
          installPath: sharedArtifactInstallPath(team, artifact),
          members: await collectArtifactMembers(artifact, artifactDir),
          sourcePath: full,
          sourceRelativePath: relativePath,
          team,
        });
      } catch (err: unknown) {
        console.warn(`Skipping shared artifact ${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  await visit(root);
  return out.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

async function collectArtifactMembers(
  artifact: ShareArtifactMetadata,
  artifactDir: string,
): Promise<readonly BundleMemberFile[] | undefined> {
  if (artifact.kind === 'skill') {
    return collectSharedBundleMembers(artifactDir);
  }
  if (artifact.kind === 'pack') {
    return collectSharedPackMembers(artifact, artifactDir);
  }
  return undefined;
}

// A pack's installable members come from its published .pack.json (the
// authoritative list), so files orphaned in files/ by a removal are not
// installed. Falls back to walking files/ when the manifest is missing.
// A manifest member path must stay within its base directory: the .pack.json /
// bundle manifest is git-carried (not scrubbed), so a malicious or corrupted
// shared repo could otherwise use `..` or an absolute path to read/write outside
// the install root.
function isContainedMemberPath(baseDir: string, relativePath: string): boolean {
  if (isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
    return false;
  }
  const resolved = join(baseDir, ...relativePath.split('/'));
  return resolved === baseDir || resolved.startsWith(baseDir + sep);
}

async function collectSharedPackMembers(
  artifact: ShareArtifactMetadata,
  packDir: string,
): Promise<readonly BundleMemberFile[]> {
  const filesDir = join(packDir, PACK_FILES_DIR);
  if (!(await isDirectory(filesDir))) {
    return [];
  }
  const manifestRaw = await readFileIfExists(join(packDir, `${artifact.name}${PACK_MANIFEST_SUFFIX}`));
  if (manifestRaw !== undefined) {
    const rawMembers = parseJsonConfigObject(manifestRaw)?.members;
    if (Array.isArray(rawMembers)) {
      const fromManifest: BundleMemberFile[] = [];
      for (const entry of rawMembers) {
        const path = (entry as {path?: unknown})?.path;
        if (typeof path === 'string' && path.length > 0) {
          if (!isContainedMemberPath(filesDir, path)) {
            throw new Error(`Refusing pack member with an unsafe path that escapes the pack root: ${path}`);
          }
          fromManifest.push({absolutePath: join(filesDir, ...path.split('/')), relativePath: path});
        }
      }
      if (fromManifest.length > 0) {
        return fromManifest.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
      }
    }
  }
  return collectBundleMemberFiles(filesDir);
}

// Members of a shared skill directory. Prefers the published manifest as the
// authoritative member list; falls back to walking the directory when it is a
// legacy single-file skill or the manifest is unreadable.
async function collectSharedBundleMembers(skillDir: string): Promise<readonly BundleMemberFile[]> {
  const manifestRaw = await readFileIfExists(join(skillDir, BUNDLE_MANIFEST_FILE));
  if (manifestRaw !== undefined) {
    const parsed = parseJsonConfigObject(manifestRaw);
    const rawMembers = parsed?.members;
    if (Array.isArray(rawMembers)) {
      const fromManifest: BundleMemberFile[] = [];
      for (const entry of rawMembers) {
        const path = (entry as {path?: unknown})?.path;
        if (typeof path === 'string' && path.length > 0) {
          if (!isContainedMemberPath(skillDir, path)) {
            throw new Error(`Refusing skill member with an unsafe path that escapes the skill root: ${path}`);
          }
          fromManifest.push({absolutePath: join(skillDir, ...path.split('/')), relativePath: path});
        }
      }
      if (fromManifest.length > 0) {
        return fromManifest.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
      }
    }
  }
  return collectBundleMemberFiles(skillDir);
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
  if (isBundleArtifact(artifact)) {
    return sharedBundleInstallStatus(artifact);
  }
  return (await sharedArtifactInstallState(artifact)).status;
}

interface BundleInstallMemberMetadata {
  readonly installedSha256: string;
  readonly sourceSha256: string;
}

function bundleInstallRoot(artifact: SharedArtifactFile): string {
  // A pack installs as a whole tree, so its installPath is already the root; a
  // skill bundle's installPath is the SKILL.md, so the root is its parent.
  return artifact.artifact.kind === 'pack' ? artifact.installPath : dirname(artifact.installPath);
}

function bundleInstallMetadataPath(artifact: SharedArtifactFile): string {
  return join(bundleInstallRoot(artifact), BUNDLE_INSTALL_METADATA_FILE);
}

async function readBundleInstallMetadata(
  artifact: SharedArtifactFile,
): Promise<Map<string, BundleInstallMemberMetadata> | undefined> {
  const raw = await readFileIfExists(bundleInstallMetadataPath(artifact));
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseJsonConfigObject(raw);
  if (parsed === undefined || parsed.version !== ARTIFACT_INSTALL_METADATA_VERSION || !Array.isArray(parsed.members)) {
    return undefined;
  }
  // Only trust metadata this artifact wrote for itself; a file left by a
  // different artifact sharing the install root must not be read as our state.
  const recordedArtifact = parsed.artifact as Partial<ShareArtifactMetadata> | undefined;
  if (
    recordedArtifact?.agent !== artifact.artifact.agent ||
    recordedArtifact?.kind !== artifact.artifact.kind ||
    recordedArtifact?.name !== artifact.artifact.name ||
    parsed.team !== artifact.team
  ) {
    return undefined;
  }
  const map = new Map<string, BundleInstallMemberMetadata>();
  for (const entry of parsed.members) {
    const path = (entry as {path?: unknown})?.path;
    const sourceSha256 = (entry as {sourceSha256?: unknown})?.sourceSha256;
    const installedSha256 = (entry as {installedSha256?: unknown})?.installedSha256;
    if (typeof path === 'string' && typeof sourceSha256 === 'string' && typeof installedSha256 === 'string') {
      map.set(path, {installedSha256, sourceSha256});
    }
  }
  return map;
}

// Folds per-member 3-way comparison (source vs installed vs recorded) into one
// bundle status. A local edit to one member and an upstream change to a
// different member both surface as remote_changed_and_local_modified so install
// refuses to silently clobber local work.
async function sharedBundleInstallStatus(artifact: SharedArtifactFile): Promise<SharedArtifactInstallStatus> {
  const members = artifact.members ?? [];
  const installRoot = bundleInstallRoot(artifact);
  const metadata = await readBundleInstallMetadata(artifact);
  // Expected on-disk bytes after the same transform install applies, so the
  // no-metadata fallback can recognize a pristine (token-expanded) install as
  // current instead of misreading it as a local modification.
  const expanded = await prepareInstallMembers(members, installRoot, artifact.artifact.kind === 'pack');
  const expectedByPath = new Map(expanded.map(entry => [entry.relativePath, entry]));
  let installedCount = 0;
  let localChanged = false;
  let remoteChanged = false;
  const memberPaths = new Set<string>();
  for (const member of members) {
    memberPaths.add(member.relativePath);
    const expected = expectedByPath.get(member.relativePath);
    if (expected === undefined) {
      // Shared source is missing (partial sync / corrupt repo): not pristine, so
      // surface it as an available update rather than crashing the whole listing.
      remoteChanged = true;
      continue;
    }
    const installedBytes = await readFileBytesIfExists(join(installRoot, ...member.relativePath.split('/')));
    if (installedBytes === undefined) {
      remoteChanged = true;
      continue;
    }
    installedCount += 1;
    const installedSha = sha256(installedBytes);
    const recorded = metadata?.get(member.relativePath);
    if (recorded === undefined) {
      // No recorded baseline (sidecar lost or a future-version sidecar): a byte
      // mismatch is ambiguous (local edit vs upstream change). Treat it as a
      // local modification — like the single-file path — so install blocks until
      // --force rather than silently clobbering possible local work. A pristine
      // install still matches expected.installedSha256, so it stays `current`.
      if (installedSha !== expected?.installedSha256) {
        localChanged = true;
      }
      continue;
    }
    if (installedSha !== recorded.installedSha256) {
      localChanged = true;
    }
    if (expected?.sourceSha256 !== recorded.sourceSha256) {
      remoteChanged = true;
    }
  }
  if (metadata !== undefined) {
    for (const [recordedPath, recorded] of metadata) {
      if (memberPaths.has(recordedPath)) {
        continue;
      }
      remoteChanged = true;
      // The member was dropped upstream; if the user edited the now-orphaned
      // local copy, flag it so the install refuses to delete it without --force.
      const installedBytes = await readFileBytesIfExists(join(installRoot, ...recordedPath.split('/')));
      if (installedBytes !== undefined && sha256(installedBytes) !== recorded.installedSha256) {
        localChanged = true;
      }
    }
  }
  if (installedCount === 0 && metadata === undefined) {
    return 'not_installed';
  }
  if (localChanged && remoteChanged) {
    return 'remote_changed_and_local_modified';
  }
  if (remoteChanged) {
    return 'update_available';
  }
  if (localChanged) {
    return 'local_modified';
  }
  return 'current';
}

interface PreparedInstallMember {
  readonly installedBytes: Buffer;
  readonly installedSha256: string;
  readonly relativePath: string;
  readonly sourceSha256: string;
}

function expandPackRoot(text: string, installRoot: string): string {
  return text.split(PACK_ROOT_TOKEN).join(installRoot);
}

// Resolves what each member will actually look like on disk. Pack-root token
// expansion applies ONLY to packs (the kinds that tokenize at publish); skill
// bundles are copied byte-for-byte so a literal token in skill content is never
// rewritten. installedSha256 is the on-disk sha (post-expansion), sourceSha256
// the shared-repo sha — the split keeps update vs local-edit detection correct
// even when expansion changes the bytes.
async function prepareInstallMembers(
  members: readonly BundleMemberFile[],
  installRoot: string,
  expandTokens: boolean,
): Promise<readonly PreparedInstallMember[]> {
  const prepared = await Promise.all(
    members.map(async (member): Promise<PreparedInstallMember | undefined> => {
      // A member declared in the manifest but absent from files/ (partial sync /
      // corrupt repo) is skipped rather than crashing the whole list/install.
      const sourceBytes = await readFileBytesIfExists(member.absolutePath);
      if (sourceBytes === undefined) {
        return undefined;
      }
      const installedBytes =
        expandTokens && !isProbablyBinary(sourceBytes)
          ? Buffer.from(expandPackRoot(sourceBytes.toString('utf8'), installRoot), 'utf8')
          : sourceBytes;
      return {
        installedBytes,
        installedSha256: sha256(installedBytes),
        relativePath: member.relativePath,
        sourceSha256: sha256(sourceBytes),
      };
    }),
  );
  return prepared.filter((member): member is PreparedInstallMember => member !== undefined);
}

function serializeInstallMetadata(artifact: SharedArtifactFile, prepared: readonly PreparedInstallMember[]): string {
  const metadata = {
    artifact: artifact.artifact,
    installedAt: new Date().toISOString(),
    members: prepared
      .map(entry => ({
        installedSha256: entry.installedSha256,
        path: entry.relativePath,
        sourceSha256: entry.sourceSha256,
      }))
      .sort((a, b) => compareStrings(a.path, b.path)),
    team: artifact.team,
    version: ARTIFACT_INSTALL_METADATA_VERSION,
  };
  return `${JSON.stringify(metadata, undefined, 2)}\n`;
}

async function installBundleArtifact(
  artifact: SharedArtifactFile,
  options: ShareInstallArtifactsOptions,
  dryRun: boolean,
  messages: string[],
): Promise<number> {
  const members = artifact.members ?? [];
  const installRoot = bundleInstallRoot(artifact);
  const kindLabel = artifact.artifact.kind === 'pack' ? 'pack' : 'bundle';
  const label = `${sharedArtifactLabel(artifact.artifact)} ${kindLabel} (${members.length} files)`;
  const status = await sharedBundleInstallStatus(artifact);
  if (dryRun) {
    const verb = sharedArtifactDryRunVerb(status, options.force === true);
    const suffix = sharedArtifactDryRunSuffix(status, options.force === true);
    messages.push(`${verb} ${label}: ${portablePath(installRoot)}${suffix}`);
    return 0;
  }
  if ((status === 'local_modified' || status === 'remote_changed_and_local_modified') && options.force !== true) {
    throw new Error(`Refusing to overwrite ${portablePath(installRoot)}. Pass force=true or --force.`);
  }
  const prepared = await prepareInstallMembers(members, installRoot, artifact.artifact.kind === 'pack');
  // A declared member whose shared source is unreadable (partial sync / corrupt
  // repo) must not silently drop from the install — that would delete the prior
  // installed copy on a routine update. Refuse unless forced.
  if (prepared.length < members.length && options.force !== true) {
    throw new Error(
      `Refusing to install ${portablePath(installRoot)}: ${members.length - prepared.length} declared member(s) are unreadable in the shared pack (the shared worktree may be mid-sync). Retry after sync, or pass force=true / --force.`,
    );
  }
  if (status === 'current') {
    await writeFile(bundleInstallMetadataPath(artifact), serializeInstallMetadata(artifact, prepared), {mode: 0o600});
    messages.push(`Already installed ${label}: ${portablePath(installRoot)}`);
    await surfacePackRequirements(artifact, messages);
    return 0;
  }

  // Materialize into a sibling staging directory, then swap atomically so an
  // interrupted install can never leave a half-written, mixed-version tree.
  const stagingRoot = `${installRoot}.threadnote-staging`;
  await rm(stagingRoot, {force: true, recursive: true});
  for (const entry of prepared) {
    const dest = join(stagingRoot, ...entry.relativePath.split('/'));
    await ensureDirectory(dirname(dest), false);
    await writeFile(dest, entry.installedBytes, {mode: 0o600});
  }
  await writeFile(join(stagingRoot, BUNDLE_INSTALL_METADATA_FILE), serializeInstallMetadata(artifact, prepared), {
    mode: 0o600,
  });
  // Swap via a backup rename so the prior install is never lost: if the final
  // rename fails (or the process dies mid-swap), the old tree is either still in
  // place or recoverable from the backup, never gone with nothing to replace it.
  await ensureDirectory(dirname(installRoot), false);
  const backupRoot = `${installRoot}.threadnote-old`;
  await rm(backupRoot, {force: true, recursive: true});
  const hadPriorInstall = await exists(installRoot);
  if (hadPriorInstall) {
    await rename(installRoot, backupRoot);
  }
  try {
    await rename(stagingRoot, installRoot);
  } catch (swapErr: unknown) {
    if (hadPriorInstall) {
      await rename(backupRoot, installRoot);
    }
    throw swapErr;
  }
  await rm(backupRoot, {force: true, recursive: true});
  messages.push(`${sharedArtifactInstallVerb(status, options.force === true)} ${label}: ${portablePath(installRoot)}`);
  await surfacePackRequirements(artifact, messages);
  return 1;
}

// Threadnote ships files, not runtimes or MCP servers. After installing a pack,
// surface its declared external dependencies so the teammate knows what they
// must provision before it will actually run.
async function surfacePackRequirements(artifact: SharedArtifactFile, messages: string[]): Promise<void> {
  if (artifact.artifact.kind !== 'pack') {
    return;
  }
  const raw = await readFileIfExists(
    join(dirname(artifact.sourcePath), `${artifact.artifact.name}${PACK_MANIFEST_SUFFIX}`),
  );
  if (raw === undefined) {
    return;
  }
  const deps = parseJsonConfigObject(raw)?.deps;
  if (deps === undefined || typeof deps !== 'object') {
    return;
  }
  const stringList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const depsRecord = deps as Record<string, unknown>;
  const tooling = [...stringList(depsRecord.runtime), ...stringList(depsRecord.cli), ...stringList(depsRecord.os)];
  const mcp = stringList(depsRecord.mcp);
  if (tooling.length > 0) {
    messages.push(`This pack will NOT run until these exist (Threadnote installs files only): ${tooling.join(', ')}.`);
  }
  if (mcp.length > 0) {
    messages.push(`Configure these MCP server(s) separately: ${mcp.join(', ')}.`);
  }
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
  const agentDir = artifact.agent === 'codex' ? '.codex' : '.claude';
  if (artifact.kind === 'pack') {
    // Packs install under a dedicated `threadnote-packs` namespace so a pack and
    // a same-named skill can never share an install root or metadata file. The
    // `threadnote`/`threadnote-packs` segment is Threadnote-controlled, never a
    // user skill name, so the two trees are structurally disjoint.
    return join(homedir(), agentDir, 'skills', 'threadnote-packs', team, artifact.name);
  }
  if (artifact.kind === 'skill') {
    return join(homedir(), agentDir, 'skills', 'threadnote', team, artifact.name, 'SKILL.md');
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
    if (/^(?:supersedes|archived_from|references):\s/.test(lines[index])) {
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
  // This runs after a successful file write. OpenViking's semantic memory
  // reindex path expects a directory URI, but vectors_only supports memory
  // files and refreshes the leaf recall records without poisoning the queue.
  // `ov reindex` has no --timeout and --wait true blocks on the whole queue,
  // so a stuck/poisoned semantic queue would otherwise hang this inline call
  // for the full 10-min command timeout; reindexWaitTimeoutMs bounds it (the
  // write already succeeded, so a timed-out refresh only defers freshness).
  const result = await runCommand(
    ov,
    withIdentity(config, ['reindex', uri, '--mode', 'vectors_only', '--wait', 'true']),
    {allowFailure: true, timeoutMs: reindexWaitTimeoutMs()},
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
  const content = await readSharedInboundFileContent(uri, filePath);
  await writeMemoryFile(config, ov, uri, content, initialMode, false, options);
}

async function readSharedInboundFileContent(uri: string, filePath: string): Promise<string> {
  if (!(await isRegularFileNoSymlink(filePath))) {
    throw new Error(`Refusing to ingest non-regular shared file: ${filePath}`);
  }
  return prepareSharedInboundContent(uri, await readFile(filePath, 'utf8'));
}

function prepareSharedInboundContent(uri: string, rawContent: string): string {
  const stripped = stripPersonalProvenance(rawContent);
  const scrub = applyScrubber(stripped, {redact: false});
  if (scrub.blocker) {
    throw new Error(`Refusing to ingest ${uri}: possible ${scrub.blocker}. Strip the sensitive value upstream first.`);
  }
  return scrub.cleaned;
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

const GIT_MODE_ABSENT = '000000';
// Git records symbolic links as mode 120000.
const GIT_MODE_SYMLINK = '120000';

export async function listChangedFiles(
  worktree: string,
  beforeRev: string,
  afterRev: string,
): Promise<readonly ChangedFile[]> {
  const result = await runCommand('git', ['-C', worktree, 'diff', '--raw', '-z', `${beforeRev}..${afterRev}`], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return [];
  }
  const entries = result.stdout.split('\0').filter(part => part.length > 0);
  const changes: ChangedFile[] = [];
  for (let index = 0; index < entries.length;) {
    const raw = entries[index++];
    const match = raw.match(/^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*/);
    if (!match) {
      continue;
    }
    const [, oldMode, newMode, head] = match;
    if (head === 'R' || head === 'C') {
      const oldRel = entries[index];
      const newRel = entries[index + 1];
      if (oldRel) {
        changes.push({
          path: join(worktree, oldRel),
          previousContent: oldMode === GIT_MODE_SYMLINK ? undefined : await gitFileContent(worktree, beforeRev, oldRel),
          relativePath: oldRel,
          status: 'removed',
        });
      }
      if (newRel && newMode !== GIT_MODE_SYMLINK) {
        changes.push({path: join(worktree, newRel), relativePath: newRel, status: 'added'});
      }
      index += 2;
      continue;
    }
    const rel = entries[index];
    if (rel) {
      if (head === 'D') {
        changes.push({
          path: join(worktree, rel),
          previousContent: oldMode === GIT_MODE_SYMLINK ? undefined : await gitFileContent(worktree, beforeRev, rel),
          relativePath: rel,
          status: 'removed',
        });
      } else if (newMode === GIT_MODE_SYMLINK) {
        if (oldMode !== GIT_MODE_ABSENT) {
          changes.push({
            path: join(worktree, rel),
            previousContent: oldMode === GIT_MODE_SYMLINK ? undefined : await gitFileContent(worktree, beforeRev, rel),
            relativePath: rel,
            status: 'removed',
          });
        }
      } else {
        const status = head === 'A' ? 'added' : 'modified';
        changes.push({
          path: join(worktree, rel),
          previousContent:
            oldMode === GIT_MODE_ABSENT || oldMode === GIT_MODE_SYMLINK
              ? undefined
              : await gitFileContent(worktree, beforeRev, rel),
          relativePath: rel,
          status,
        });
      }
    }
    index += 1;
  }
  return changes;
}

async function gitFileContent(worktree: string, rev: string, relativePath: string): Promise<string | undefined> {
  const result = await runCommand('git', ['-C', worktree, 'show', `${rev}:${relativePath}`], {allowFailure: true});
  return result.exitCode === 0 ? result.stdout : undefined;
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
        const currentContent = await readExistingMemoryContent(config, ov, uri);
        if (currentContent === undefined) {
          continue;
        }
        assertInboundPreviousContentMatches(change, uri, currentContent);
        await removeMemoryUri(config, ov, uri, false, options);
        continue;
      }
      if (!(await isRegularFileNoSymlink(change.path))) {
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
      const content = await readSharedInboundFileContent(uri, change.path);
      const currentContent = await readExistingMemoryContent(config, ov, uri);
      if (currentContent !== undefined) {
        if (change.status === 'added') {
          if (sharedMemoryContentsEquivalent(currentContent, content)) {
            continue;
          }
          throw new Error(
            `Refusing to ingest newly added shared file over existing local OpenViking resource ${uri}; inspect and resolve the local edit first.`,
          );
        }
        assertInboundPreviousContentMatches(change, uri, currentContent);
        const reason =
          change.status === 'modified'
            ? 'updating from upstream after verifying local content matches the previous shared version'
            : 'aligning OV to upstream (resource pre-existed in OV, likely from an earlier local publish or sync)';
        if (options.quiet !== true) {
          console.warn(`share sync: ${uri}: ${reason}.`);
        }
      }
      await ensureSharedDirectoryChain(config, ov, uri, false, options);
      const writeMode: 'create' | 'replace' = currentContent !== undefined ? 'replace' : 'create';
      await writeMemoryFile(config, ov, uri, content, writeMode, false, options);
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

async function readExistingMemoryContent(config: ShareRuntime, ov: string, uri: string): Promise<string | undefined> {
  if (!(await vikingResourceExists(ov, config, uri))) {
    return undefined;
  }
  return readMemoryContent(config, ov, uri, false);
}

function assertInboundPreviousContentMatches(change: ChangedFile, uri: string, currentContent: string): void {
  if (change.previousContent === undefined) {
    throw new Error(
      `Refusing to apply inbound shared change for ${uri}: previous shared content is unavailable, so local edits cannot be distinguished from upstream edits.`,
    );
  }
  const expectedContent = prepareSharedInboundContent(uri, change.previousContent);
  if (!sharedMemoryContentsEquivalent(currentContent, expectedContent)) {
    throw new Error(
      `Refusing to apply inbound shared change for ${uri}: local OpenViking content differs from the previous shared version. Inspect and resolve the local edit first.`,
    );
  }
}

function sharedMemoryContentsEquivalent(left: string, right: string): boolean {
  return normalizeSharedMemoryComparisonContent(left) === normalizeSharedMemoryComparisonContent(right);
}

function normalizeSharedMemoryComparisonContent(content: string): string {
  return content.replace(/\r\n?/g, '\n').replace(/\n$/, '');
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
