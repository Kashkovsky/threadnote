import {Console, Effect, FileSystem, Option, Path, Result} from 'effect';
import {CommandExecutor} from './effect/command.js';
import {SystemInfo} from './effect/system.js';
import {uriSegment} from './manifest.js';
import {canonicalMemoryDocumentContent} from './memory_document.js';
import {ResourceStore} from './effect/resource-store.js';
import {parseResourceId} from './storage/resource-id.js';
import {applyScrubber, credentialScrubberBlocker, SCRUBBER_PATTERNS} from './scrubber.js';
import type {
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
  assertResourceUri,
  ensureDirectory,
  exists,
  expandPath,
  formatShellCommand,
  isDirectory,
  isFile,
  maybeRun,
  parseJsonConfigObject,
  portablePath,
  readFileIfExists,
  removePath,
  requiredExecutable,
  runCommand,
  safeTimestamp,
  sha256,
} from './utils.js';

const NATIVE_RESOURCE_BACKEND = 'threadnote-native';
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
// native canonical store writes these summaries into the worktree; they are gitignored and
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
const AUTO_SHARE_GIT_TIMEOUT_MILLISECONDS = 5_000;
export const SHARED_BACKGROUND_FETCH_INTERVAL_MILLISECONDS = 5 * 60 * 1000;
const SHARE_FETCH_RECEIPT_VERSION = 1;
const SHARE_FETCH_WARNING_MAXIMUM_LENGTH = 1_000;
export const DEFAULT_GIT_REMOTE_NAME = 'origin';

export {applyScrubber, scrubberBlocker} from './scrubber.js';

interface DirectoryEntry {
  readonly name: string;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

interface PathInfo extends DirectoryEntry {
  readonly mtime: Date;
  readonly size: number;
}

const pathJoin = Effect.fn('share.pathJoin')(function* (...parts: readonly string[]) {
  const path = yield* Path.Path;
  return path.join(...parts);
});

const pathDirname = Effect.fn('share.pathDirname')(function* (value: string) {
  const path = yield* Path.Path;
  return path.dirname(value);
});

const pathBasename = Effect.fn('share.pathBasename')(function* (value: string) {
  const path = yield* Path.Path;
  return path.basename(value);
});

const pathIsAbsolute = Effect.fn('share.pathIsAbsolute')(function* (value: string) {
  const path = yield* Path.Path;
  return path.isAbsolute(value);
});

const pathRelative = Effect.fn('share.pathRelative')(function* (from: string, to: string) {
  const path = yield* Path.Path;
  return path.relative(from, to);
});

const pathSeparator = Effect.map(Path.Path, path => path.sep);

function pathInfo(name: string, info: FileSystem.File.Info, symbolicLink: boolean): PathInfo {
  return {
    name,
    isDirectory: () => !symbolicLink && info.type === 'Directory',
    isFile: () => !symbolicLink && info.type === 'File',
    isSymbolicLink: () => symbolicLink,
    mtime: info.mtime._tag === 'Some' ? info.mtime.value : new Date(0),
    size: Number(info.size),
  };
}

const lstat = Effect.fn('share.lstat')(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(target).pipe(Effect.option);
  const info = yield* fs.stat(target);
  const path = yield* Path.Path;
  return pathInfo(path.basename(target), info, link._tag === 'Some');
});

function readFile(target: string): Effect.Effect<Uint8Array, unknown, FileSystem.FileSystem>;
function readFile(target: string, encoding: 'utf8'): Effect.Effect<string, unknown, FileSystem.FileSystem>;
function readFile(
  target: string,
  encoding?: 'utf8',
): Effect.Effect<Uint8Array | string, unknown, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return encoding ? yield* fs.readFileString(target, encoding) : yield* fs.readFile(target);
  });
}

function writeFile(
  target: string,
  content: string | Uint8Array,
  options?: 'utf8' | {readonly encoding?: 'utf8'; readonly mode?: number},
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const normalizedOptions = typeof options === 'string' ? undefined : options;
    if (typeof content === 'string') {
      yield* fs.writeFileString(target, content, normalizedOptions);
    } else {
      yield* fs.writeFile(target, content, normalizedOptions);
    }
  });
}

const mkdir = Effect.fn('share.mkdir')(function* (
  target: string,
  options?: {readonly recursive?: boolean; readonly mode?: number},
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(target, options);
});

function readdir(target: string): Effect.Effect<string[], unknown, FileSystem.FileSystem>;
function readdir(
  target: string,
  options: {readonly withFileTypes: true},
): Effect.Effect<DirectoryEntry[], unknown, FileSystem.FileSystem | Path.Path>;
function readdir(
  target: string,
  options?: {readonly withFileTypes?: boolean},
): Effect.Effect<string[] | DirectoryEntry[], unknown, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs.readDirectory(target);
    if (options?.withFileTypes !== true) {
      return names;
    }
    return yield* Effect.forEach(names, name =>
      lstat(path.join(target, name)).pipe(
        Effect.map(info => ({
          name,
          isDirectory: info.isDirectory,
          isFile: info.isFile,
          isSymbolicLink: info.isSymbolicLink,
        })),
      ),
    );
  });
}

const rename = Effect.fn('share.rename')(function* (from: string, to: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.rename(from, to);
});

const rm = Effect.fn('share.rm')(function* (
  target: string,
  options?: {readonly force?: boolean; readonly recursive?: boolean},
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(target, options);
});

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
  readonly previousRevision?: string;
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
  forceNextCheck: boolean;
  lastCheckedAt: number;
  pendingReindexes: Map<string, readonly ChangedFile[]>;
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

interface ShareFetchReceipt {
  readonly behind: number;
  readonly checkedAt: number;
  readonly remote: string;
  readonly succeeded: boolean;
  readonly team: string;
  readonly version: number;
  readonly warning?: string;
  readonly worktree: string;
}

interface PendingReindexFile {
  readonly teams: Readonly<Record<string, readonly ChangedFile[]>>;
  readonly version: number;
}

export function clearAutoShareStateForTest(): void {
  autoShareStates.clear();
}

export function markSharedAutoSyncDeferred(config: ShareRuntime): void {
  autoShareState(config).forceNextCheck = true;
}

export const runShareInit = Effect.fn('share.runShareInit')(function* (
  config: ShareRuntime,
  remoteUrl: string,
  options: ShareInitOptions,
) {
  if (!remoteUrl.trim()) {
    throw new Error('Provide a git remote URL for the shared memories repo.');
  }
  const dryRun = options.dryRun === true;
  const teamName = normalizeTeamName(options.team);
  const teamsFile = yield* readTeamsFile(config);
  if (teamsFile.teams[teamName]) {
    throw new Error(
      `Team "${teamName}" is already configured (remote ${teamsFile.teams[teamName].remote}). Remove it first with: threadnote share remove --team ${teamName}`,
    );
  }
  const worktree = yield* teamWorktreePath(config, teamName);
  const gitdir = yield* teamGitdirPath(config, teamName);
  yield* assertWorktreeUsable(worktree);
  if (yield* exists(gitdir)) {
    throw new Error(`Gitdir already exists at ${gitdir}; remove it or pick a different team name.`);
  }

  yield* ensureDirectory(yield* pathDirname(worktree), dryRun);
  yield* ensureDirectory(yield* pathDirname(gitdir), dryRun);

  const git = yield* requiredExecutable('git');
  yield* maybeRun(dryRun, git, [
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
    yield* Console.log(`Would write teams file: ${yield* teamsFilePath(config)}`);
    yield* Console.log(`Would set ${teamName} as default? ${updatedTeams.defaultTeam === teamName}`);
  } else {
    yield* writeTeamsFile(config, updatedTeams);
    yield* Console.log(`Configured shared team "${teamName}" -> ${yield* portablePath(worktree)}`);
  }

  if (!dryRun) {
    yield* ensureSharedGitignore(worktree, git, options.push !== false);
    const ingested = yield* ingestWorktreeFiles(config, newConfig, 'create');
    yield* Console.log(`Ingested ${ingested} shared file(s) into native canonical store.`);
  }
});

const SHARED_GITIGNORE_PATTERNS = ['**/.abstract.md', '**/.overview.md'];
const SHARED_GITIGNORE_HEADER = '# Threadnote: ignore native canonical store-generated directory summaries.';

const ensureSharedGitignore = Effect.fn('share.ensureSharedGitignore')(function* (
  worktree: string,
  git: string,
  push: boolean,
) {
  // Idempotently ensure the native canonical store-summary patterns are in the worktree's
  // .gitignore. There's no opt-out: these two patterns describe files that OV
  // writes into every shared directory on every mkdir, are not memories, and
  // would only pollute git history if tracked. Users who insist on tracking
  // them can `git update-index --skip-worktree .gitignore` to suppress this.
  const gitignorePath = yield* pathJoin(worktree, '.gitignore');
  const existing = (yield* readFileIfExists(gitignorePath)) ?? '';
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
  yield* writeFile(gitignorePath, `${existing}${segments.join('')}`, {encoding: 'utf8'});
  yield* Console.log(`Added ${missingPatterns.join(', ')} to ${yield* portablePath(gitignorePath)}`);
  yield* maybeRun(false, git, ['-C', worktree, 'add', '.gitignore']);
  const commitResult = yield* runCommand(
    git,
    ['-C', worktree, 'commit', '-m', 'share: ignore native canonical store directory summaries'],
    {allowFailure: true},
  );
  if (commitResult.exitCode !== 0) {
    const detail = commitResult.stderr.trim() || commitResult.stdout.trim();
    if (!/nothing to commit|no changes added/i.test(detail)) {
      yield* Console.warn(
        `.gitignore housekeeping commit was rejected (${detail || 'unknown'}); it will be retried on the next share sync.`,
      );
      return;
    }
  }
  if (push) {
    yield* maybeRun(false, git, ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME], {allowFailure: true});
  }
});

export const runShareStatus = Effect.fn('share.runShareStatus')(function* (
  config: ShareRuntime,
  options: ShareStatusOptions,
) {
  const team = yield* resolveTeam(config, options.team);
  const git = yield* requiredExecutable('git');
  yield* Console.log(`Team: ${team.name}`);
  yield* Console.log(`Remote: ${team.config.remote}`);
  yield* Console.log(`Worktree: ${yield* portablePath(team.config.worktree)}`);
  yield* Console.log(`Gitdir: ${yield* portablePath(team.config.gitdir)}`);
  yield* maybeRun(options.dryRun === true, git, ['-C', team.config.worktree, 'status', '--short', '--branch']);
  yield* maybeRun(options.dryRun === true, git, ['-C', team.config.worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME], {
    allowFailure: true,
  });
  const ahead = yield* gitOutput(team.config.worktree, ['rev-list', '--count', '@{u}..HEAD'], options.dryRun === true);
  const behind = yield* gitOutput(team.config.worktree, ['rev-list', '--count', 'HEAD..@{u}'], options.dryRun === true);
  if (ahead !== undefined) {
    yield* Console.log(`Ahead of upstream: ${ahead}`);
  }
  if (behind !== undefined) {
    yield* Console.log(`Behind upstream: ${behind}`);
  }
});

export const refreshSharedReposInBackground = Effect.fn('share.refreshSharedReposInBackground')(function* (
  config: ShareRuntime,
  force: boolean,
) {
  return yield* refreshShareUpdateState(config, {force});
});

export const syncSharedReposBeforeAgentRead = Effect.fn('share.syncSharedReposBeforeAgentRead')(function* (
  config: ShareRuntime,
) {
  const state = autoShareState(config);
  return yield* enqueueShareOperation(
    state,
    Effect.fn('share.callback')(function* () {
      yield* loadPendingReindexes(config, state);
      const warnings = yield* refreshShareUpdateStateLocked(config, state, {force: false});
      const syncTeams = new Set([...state.behindTeams, ...state.pendingReindexes.keys()]);
      if (syncTeams.size === 0) {
        return {syncedTeams: [], warnings};
      }

      const syncedTeams: string[] = [];
      const remainingBehind = new Set(state.behindTeams);
      for (const team of syncTeams) {
        const syncResult = yield* Effect.result(runShareSyncQuiet(config, state, {team}));
        if (Result.isSuccess(syncResult)) {
          warnings.push(...syncResult.success.warnings);
          if (syncResult.success.synced) {
            if (remainingBehind.has(team)) yield* recordShareTeamSynced(config, team);
            remainingBehind.delete(team);
            syncedTeams.push(team);
          }
        } else {
          const err = syncResult.failure;
          warnings.push(
            `Auto-sync for shared team "${team}" failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      state.behindTeams = remainingBehind;
      state.lastCheckedAt = Date.now();
      return {syncedTeams, warnings};
    }),
  );
});

function autoShareState(config: ShareRuntime): AutoShareState {
  const key = `${config.agentContextHome}:${config.account}:${config.user}`;
  let state = autoShareStates.get(key);
  if (!state) {
    state = {behindTeams: new Set(), forceNextCheck: false, lastCheckedAt: 0, pendingReindexes: new Map()};
    autoShareStates.set(key, state);
  }
  return state;
}

const pendingReindexesPath = Effect.fn('share.pendingReindexesPath')(function* (config: ShareRuntime) {
  return yield* pathJoin(config.agentContextHome, 'share', 'auto-sync-pending-reindexes.json');
});

const loadPendingReindexes = Effect.fn('share.loadPendingReindexes')(function* (
  config: ShareRuntime,
  state: AutoShareState,
) {
  const raw = yield* readFileIfExists(yield* pendingReindexesPath(config));
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
          previousRevision: typeof entry.previousRevision === 'string' ? entry.previousRevision : undefined,
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
});

const writePendingReindexes = Effect.fn('share.writePendingReindexes')(function* (
  config: ShareRuntime,
  state: AutoShareState,
) {
  const path = yield* pendingReindexesPath(config);
  if (state.pendingReindexes.size === 0) {
    yield* rm(path, {force: true});
    return;
  }
  const contents: PendingReindexFile = {
    teams: Object.fromEntries(state.pendingReindexes),
    version: 1,
  };
  yield* mkdir(yield* pathDirname(path), {recursive: true});
  const system = yield* SystemInfo;
  const tempPath = `${path}.${system.processId}.tmp`;
  yield* writeFile(tempPath, `${JSON.stringify(contents, undefined, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  yield* rename(tempPath, path);
});

const refreshShareUpdateState = Effect.fn('share.refreshShareUpdateState')(function* (
  config: ShareRuntime,
  options: {readonly force: boolean},
) {
  const state = autoShareState(config);
  const warnings = yield* enqueueShareOperation(
    state,
    Effect.fn('share.callback')(function* () {
      return yield* refreshShareUpdateStateLocked(config, state, options);
    }),
  );
  for (const warning of warnings) {
    yield* Console.error(warning);
  }
});

const refreshShareUpdateStateLocked = Effect.fn('share.refreshShareUpdateStateLocked')(function* (
  config: ShareRuntime,
  state: AutoShareState,
  options: {readonly force: boolean},
) {
  const now = Date.now();
  if (
    !options.force &&
    !state.forceNextCheck &&
    state.lastCheckedAt > 0 &&
    now - state.lastCheckedAt < SHARED_BACKGROUND_FETCH_INTERVAL_MILLISECONDS
  ) {
    return [];
  }
  state.forceNextCheck = false;
  return yield* Effect.gen(function* () {
    const statuses = yield* fetchShareUpdateStatuses(config);
    const nextBehindTeams = new Set(state.behindTeams);
    for (const status of statuses) {
      if (!status.warning) {
        if (status.behind > 0) {
          nextBehindTeams.add(status.team);
        } else {
          nextBehindTeams.delete(status.team);
        }
      }
    }
    state.behindTeams = nextBehindTeams;
    return statuses.flatMap(status => (status.warning ? [status.warning] : []));
  }).pipe(Effect.ensuring(Effect.sync(() => (state.lastCheckedAt = Date.now()))));
});

function enqueueShareOperation<A, E, R>(
  _state: AutoShareState,
  action: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return action();
}

const fetchShareUpdateStatuses = Effect.fn('share.fetchShareUpdateStatuses')(function* (config: ShareRuntime) {
  const teamsFile = yield* readTeamsFile(config);
  const teams = Object.entries(teamsFile.teams);
  if (teams.length === 0) {
    return [];
  }
  let git: string | undefined;
  const statuses: ShareUpdateStatus[] = [];
  for (const [name, team] of teams) {
    const receipt = yield* readFreshShareFetchReceipt(config, name, team);
    if (receipt) {
      statuses.push({
        behind: receipt.behind,
        team: name,
        ...(receipt.warning ? {warning: receipt.warning} : {}),
      });
      continue;
    }
    git ??= yield* requiredExecutable('git');
    const fetchResult = yield* runCommand(git, ['-C', team.worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME], {
      allowFailure: true,
      timeoutMs: AUTO_SHARE_GIT_TIMEOUT_MILLISECONDS,
    });
    if (fetchResult.exitCode !== 0) {
      const warning = boundedShareFetchWarning(
        `Auto-sync check for shared team "${name}" failed: ${
          fetchResult.stderr.trim() || fetchResult.stdout.trim() || 'unknown git fetch error'
        }`,
      );
      yield* persistShareFetchReceipt(config, {
        behind: 0,
        checkedAt: Date.now(),
        remote: team.remote,
        succeeded: false,
        team: name,
        version: SHARE_FETCH_RECEIPT_VERSION,
        warning,
        worktree: team.worktree,
      });
      statuses.push({behind: 0, team: name, warning});
      continue;
    }
    const behind = yield* gitOutput(
      team.worktree,
      ['rev-list', '--count', 'HEAD..@{u}'],
      false,
      AUTO_SHARE_GIT_TIMEOUT_MILLISECONDS,
    );
    if (behind === undefined) {
      const warning = `Auto-sync check for shared team "${name}" failed: could not read upstream behind count.`;
      yield* persistShareFetchReceipt(config, {
        behind: 0,
        checkedAt: Date.now(),
        remote: team.remote,
        succeeded: false,
        team: name,
        version: SHARE_FETCH_RECEIPT_VERSION,
        warning,
        worktree: team.worktree,
      });
      statuses.push({behind: 0, team: name, warning});
      continue;
    }
    const behindCount = Number.parseInt(behind, 10) || 0;
    yield* persistShareFetchReceipt(config, {
      behind: behindCount,
      checkedAt: Date.now(),
      remote: team.remote,
      succeeded: true,
      team: name,
      version: SHARE_FETCH_RECEIPT_VERSION,
      worktree: team.worktree,
    });
    statuses.push({behind: behindCount, team: name});
  }
  return statuses;
});

const shareFetchReceiptPath = Effect.fn('share.fetchReceiptPath')(function* (config: ShareRuntime, team: string) {
  return yield* pathJoin(config.agentContextHome, 'share', 'fetch-receipts', `${team}.json`);
});

const readFreshShareFetchReceipt = Effect.fn('share.readFreshFetchReceipt')(function* (
  config: ShareRuntime,
  teamName: string,
  team: ShareTeamConfig,
) {
  const raw = yield* readFileIfExists(yield* shareFetchReceiptPath(config, teamName));
  if (!raw) return undefined;
  return parseFreshShareFetchReceipt(raw, teamName, team, Date.now());
});

const persistShareFetchReceipt = Effect.fn('share.persistFetchReceipt')(function* (
  config: ShareRuntime,
  receipt: ShareFetchReceipt,
) {
  const target = yield* shareFetchReceiptPath(config, receipt.team);
  const parent = yield* pathDirname(target);
  const system = yield* SystemInfo;
  const temporary = `${target}.${system.processId}.tmp`;
  const write = Effect.gen(function* () {
    yield* mkdir(parent, {mode: 0o700, recursive: true});
    yield* writeFile(temporary, `${JSON.stringify(receipt)}\n`, {encoding: 'utf8', mode: 0o600});
    yield* rename(temporary, target);
  }).pipe(Effect.ensuring(rm(temporary, {force: true}).pipe(Effect.catch(() => Effect.void))));
  yield* write.pipe(
    Effect.catch(error =>
      Console.error(
        `Could not persist the shared fetch receipt for team "${receipt.team}"; another process may fetch again: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    ),
  );
});

const recordShareTeamSynced = Effect.fn('share.recordTeamSynced')(function* (config: ShareRuntime, teamName: string) {
  const team = yield* resolveTeam(config, teamName);
  yield* persistShareFetchReceipt(config, {
    behind: 0,
    checkedAt: Date.now(),
    remote: team.config.remote,
    succeeded: true,
    team: team.name,
    version: SHARE_FETCH_RECEIPT_VERSION,
    worktree: team.config.worktree,
  });
});

function parseFreshShareFetchReceipt(
  raw: string,
  teamName: string,
  team: ShareTeamConfig,
  now: number,
): ShareFetchReceipt | undefined {
  const parsed = parseJsonConfigObject(raw);
  if (
    !parsed ||
    parsed.version !== SHARE_FETCH_RECEIPT_VERSION ||
    parsed.team !== teamName ||
    parsed.remote !== team.remote ||
    parsed.worktree !== team.worktree ||
    typeof parsed.behind !== 'number' ||
    !Number.isSafeInteger(parsed.behind) ||
    parsed.behind < 0 ||
    typeof parsed.checkedAt !== 'number' ||
    !Number.isSafeInteger(parsed.checkedAt) ||
    parsed.checkedAt <= 0 ||
    parsed.checkedAt > now ||
    now - parsed.checkedAt >= SHARED_BACKGROUND_FETCH_INTERVAL_MILLISECONDS ||
    typeof parsed.succeeded !== 'boolean' ||
    (parsed.succeeded === false && typeof parsed.warning !== 'string')
  ) {
    return undefined;
  }
  return {
    behind: parsed.behind,
    checkedAt: parsed.checkedAt,
    remote: parsed.remote,
    succeeded: parsed.succeeded,
    team: parsed.team,
    version: parsed.version,
    ...(typeof parsed.warning === 'string' ? {warning: boundedShareFetchWarning(parsed.warning)} : {}),
    worktree: parsed.worktree,
  };
}

function boundedShareFetchWarning(warning: string): string {
  return warning.length <= SHARE_FETCH_WARNING_MAXIMUM_LENGTH
    ? warning
    : `${warning.slice(0, SHARE_FETCH_WARNING_MAXIMUM_LENGTH - 1)}…`;
}

export const runShareSync = Effect.fn('share.runShareSync')(function* (
  config: ShareRuntime,
  options: ShareSyncOptions,
) {
  const teams = yield* teamsForShareQuery(config, options.team);

  if (options.team) {
    const team = teams[0];
    if (!team) {
      throw new Error('No shared teams configured. Run: threadnote share init <remote-url>');
    }
    yield* runShareSyncForTeam(config, team, options);
    return;
  }

  const failures: string[] = [];
  for (const [index, team] of teams.entries()) {
    if (teams.length > 1) {
      yield* Console.log(`Syncing shared team "${team.name}" (${index + 1}/${teams.length})...`);
    }
    const syncResult = yield* Effect.result(runShareSyncForTeam(config, team, options));
    if (Result.isFailure(syncResult)) {
      const error = syncResult.failure;
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
});

const runShareSyncForTeam = Effect.fn('share.runShareSyncForTeam')(function* (
  config: ShareRuntime,
  team: ResolvedTeam,
  options: ShareSyncOptions,
) {
  const dryRun = options.dryRun === true;
  const git = yield* requiredExecutable('git');
  const worktree = team.config.worktree;

  if (!dryRun) {
    // Don't push here — sync's final push step (below) will deliver any
    // .gitignore housekeeping commit, avoiding a double-push round trip.
    yield* ensureSharedGitignore(worktree, git, false);
  }

  if (yield* hasUncommittedChanges(worktree)) {
    if (options.autoCommit === false) {
      throw new Error(
        `Worktree ${worktree} has uncommitted changes. Commit them yourself or rerun without --no-auto-commit.`,
      );
    }
    const message = options.message ?? `share: sync ${new Date().toISOString()}`;
    yield* stageShareableChanges(dryRun, git, worktree);
    const commitResult = yield* maybeRun(dryRun, git, ['-C', worktree, 'commit', '-m', message], {allowFailure: true});
    if (!dryRun && commitResult && commitResult.exitCode !== 0) {
      if (yield* hasUncommittedChanges(worktree)) {
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
    if (!dryRun && (yield* hasUncommittedChanges(worktree))) {
      throw new Error(
        `Worktree ${worktree} still has uncommitted changes after staging Threadnote shareable files. Commit, remove, or ignore the remaining files, then rerun \`threadnote share sync\`.`,
      );
    }
  }

  const beforeRev = yield* gitOutput(worktree, ['rev-parse', 'HEAD'], dryRun);
  yield* maybeRun(dryRun, git, ['-C', worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME]);
  const pullResult = dryRun
    ? undefined
    : yield* runCommand(git, ['-C', worktree, 'rebase', '@{u}'], {allowFailure: true});
  if (dryRun) {
    yield* Console.log(`Would run: ${formatShellCommand(git, ['-C', worktree, 'rebase', '@{u}'])}`);
  } else if (pullResult && pullResult.exitCode !== 0) {
    // Detect mid-rebase state via Git-resolved filesystem markers rather than
    // parsing localized human-readable output.
    if (yield* isShareGitOperationInProgress(git, worktree)) {
      throw new Error(
        `git pull --rebase reported conflicts in ${worktree}. The worktree is in a rebase-in-progress state.\nResolve the conflicts in-place, run \`git -C ${worktree} rebase --continue\` (or --abort), then re-run \`threadnote share sync\`.`,
      );
    }
    throw new Error(
      `git rebase @{u} failed in ${worktree}: ${pullResult.stderr.trim() || pullResult.stdout.trim() || 'unknown error'}`,
    );
  }
  const afterRev = yield* gitOutput(worktree, ['rev-parse', 'HEAD'], dryRun);

  if (!dryRun) {
    const state = autoShareState(config);
    yield* loadPendingReindexes(config, state);
    const previouslyPending = state.pendingReindexes.get(team.name) ?? [];
    const newChanges =
      beforeRev && afterRev && beforeRev !== afterRev ? yield* listChangedFiles(worktree, beforeRev, afterRev) : [];
    const combined = mergeChanges(previouslyPending, newChanges);
    if (combined.length === 0) {
      yield* Console.log('No upstream changes to reindex.');
    } else {
      const result = yield* applyAndPersistChanges(config, team.config, state, combined);
      const succeeded = combined.length - result.failed.length;
      yield* Console.log(`Reindexed ${succeeded} file change(s) into native canonical store.`);
      if (result.failed.length > 0) {
        yield* Console.warn(
          `share sync: ${result.failed.length} file(s) could not be ingested on this run; they are persisted and will be retried on the next sync or agent recall/read.`,
        );
        yield* Console.warn(formatShareConflictNextSteps(team.name, result.failed));
      }
    }
  }

  if (options.push !== false) {
    const pushResult = dryRun
      ? undefined
      : yield* runCommand(git, ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME], {allowFailure: true});
    if (dryRun) {
      yield* Console.log(`Would run: ${formatShellCommand(git, ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME])}`);
    } else if (pushResult && pushResult.exitCode !== 0) {
      throw new Error(
        `git push failed in ${worktree}: ${pushResult.stderr.trim() || pushResult.stdout.trim() || 'unknown error'}`,
      );
    }
  }
});

export const runShareConflicts = Effect.fn('share.runShareConflicts')(function* (
  config: ShareRuntime,
  options: ShareConflictOptions,
) {
  const conflicts = yield* listShareConflicts(config, options);
  if (conflicts.length === 0) {
    const team = options.team ? ` for team "${options.team}"` : '';
    yield* Console.log(`No pending shared memory conflicts${team}.`);
    return;
  }
  yield* Console.log(`Pending shared memory conflicts: ${conflicts.length}`);
  for (const conflict of conflicts) {
    yield* Console.log('');
    yield* Console.log(`${conflict.id}`);
    yield* Console.log(`  uri: ${conflict.uri}`);
    yield* Console.log(`  status: ${conflict.status}`);
    yield* Console.log(`  reason: ${conflict.reason}`);
    yield* Console.log(`  show: threadnote share conflict show ${conflict.id}`);
    yield* Console.log(`  take shared: threadnote share conflict resolve ${conflict.id} --take shared`);
    yield* Console.log(`  take local: threadnote share conflict resolve ${conflict.id} --take local`);
    yield* Console.log(`  merged file: threadnote share conflict resolve ${conflict.id} --from-file merged.md`);
  }
});

export const runShareConflictShow = Effect.fn('share.runShareConflictShow')(function* (
  config: ShareRuntime,
  reference: string,
  options: ShareConflictShowOptions,
) {
  const detail = yield* showShareConflict(config, reference, options);
  yield* Console.log(`Conflict: ${detail.id}`);
  yield* Console.log(`URI: ${detail.uri}`);
  yield* Console.log(`Status: ${detail.status}`);
  yield* Console.log(`Reason: ${detail.reason}`);
  yield* Console.log('');
  yield* Console.log(detail.diff);
  yield* Console.log('');
  yield* Console.log('Resolve:');
  for (const line of detail.resolutionGuidance) {
    yield* Console.log(`  ${line}`);
  }
});

export const runShareConflictResolve = Effect.fn('share.runShareConflictResolve')(function* (
  config: ShareRuntime,
  reference: string,
  options: ShareConflictResolveOptions,
) {
  const result = yield* resolveShareConflict(config, reference, options);
  for (const message of result.messages) {
    yield* Console.log(message);
  }
  if (result.backupPath) {
    yield* Console.log(`Backup: ${yield* portablePath(result.backupPath)}`);
  }
  for (const message of result.gitMessages) {
    yield* Console.log(message);
  }
  yield* Console.log(`Resolved shared memory conflict: ${result.id}`);
});

export const listShareConflicts = Effect.fn('share.listShareConflicts')(function* (
  config: ShareRuntime,
  options: ShareConflictOptions = {},
) {
  const teams = yield* teamsForShareQuery(config, options.team);
  const state = autoShareState(config);
  yield* loadPendingReindexes(config, state);
  const summaries: ShareConflictSummary[] = [];
  for (const team of teams) {
    const pending = state.pendingReindexes.get(team.name) ?? [];
    for (const change of pending) {
      if (!isShareableMemoryChange(change)) {
        continue;
      }
      summaries.push(yield* buildShareConflictSummary(config, team, yield* normalizePendingChange(team, change)));
    }
  }
  return summaries;
});

export const showShareConflict = Effect.fn('share.showShareConflict')(function* (
  config: ShareRuntime,
  reference: string,
  options: ShareConflictShowOptions = {},
) {
  const conflict = yield* readPendingShareConflict(config, reference, options.team);
  const inspected = yield* inspectShareConflict(config, conflict.team, conflict.change);
  return {
    ...inspected,
    diff: formatShareConflictDiff(inspected),
    resolutionGuidance: shareConflictResolutionGuidance(inspected.id),
  };
});

export const resolveShareConflict = Effect.fn('share.resolveShareConflict')(function* (
  config: ShareRuntime,
  reference: string,
  options: ShareConflictResolveOptions,
) {
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
  const conflict = yield* readPendingShareConflict(config, reference, options.team);
  const inspected = yield* inspectShareConflict(config, conflict.team, conflict.change);
  const dryRun = options.dryRun === true;
  const ov = NATIVE_RESOURCE_BACKEND;
  const messages: string[] = [];
  const gitMessages: string[] = [];
  const backupPath = dryRun ? undefined : yield* backupShareConflict(config, inspected);

  if (take === 'shared') {
    if (inspected.status === 'removed') {
      if (inspected.hasLocalContent) {
        yield* removeMemoryUri(config, ov, inspected.uri, dryRun);
        messages.push(`Accepted shared deletion for ${inspected.uri}.`);
      } else {
        messages.push(`Shared deletion was already reflected in native canonical store for ${inspected.uri}.`);
      }
    } else {
      if (inspected.sharedContent === undefined) {
        throw new Error(`Cannot take shared for ${inspected.id}: shared file is missing or not readable.`);
      }
      yield* ensureSharedDirectoryChain(config, ov, inspected.uri, dryRun);
      yield* writeMemoryFile(
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
    const content = yield* conflictResolutionContent(inspected, take, fromFile, mergedContent);
    yield* writeSharedConflictFile(conflict.team, inspected, content, dryRun);
    yield* ensureSharedDirectoryChain(config, ov, inspected.uri, dryRun);
    yield* writeMemoryFile(
      config,
      ov,
      inspected.uri,
      content,
      inspected.hasLocalContent ? 'replace' : 'create',
      dryRun,
    );
    const message = options.message ?? `share: resolve ${inspected.relativePath}`;
    gitMessages.push(
      ...(yield* publishShareGitChange(conflict.team.config.worktree, inspected.relativePath, message, {
        dryRun,
        push: options.push,
      })),
    );
    messages.push(
      take === 'local'
        ? `Published local native canonical store content for ${inspected.uri}.`
        : `Applied merged content for ${inspected.uri}.`,
    );
  }

  if (!dryRun) {
    yield* clearPendingShareConflict(config, conflict.team.name, inspected.relativePath);
  }
  return {backupPath, gitMessages, id: inspected.id, messages, team: inspected.team, uri: inspected.uri};
});

const runShareSyncQuiet = Effect.fn('share.runShareSyncQuiet')(function* (
  config: ShareRuntime,
  state: AutoShareState,
  options: {readonly team: string},
) {
  const team = yield* resolveTeam(config, options.team);
  const git = yield* requiredExecutable('git');
  const worktree = team.config.worktree;

  const pendingChanges = state.pendingReindexes.get(team.name) ?? [];

  if (yield* isShareGitOperationInProgress(git, worktree)) {
    return {
      synced: false,
      warnings: [
        ...pendingMemoryIngestWarnings(state, team.name),
        `Shared team "${team.name}" has a Git operation already in progress; automatic sync left its index and worktree untouched. Finish or abort the operation, then rerun recall/read.`,
      ],
    };
  }

  const ahead = yield* gitOutput(worktree, ['rev-list', '--count', '@{u}..HEAD'], false);
  if (ahead === undefined) {
    return {
      synced: false,
      warnings: [
        ...pendingMemoryIngestWarnings(state, team.name),
        `Shared team "${team.name}" upstream status is unknown; skipped automatic sync. Run \`threadnote share sync --team ${team.name}\` to inspect and resolve it.`,
      ],
    };
  }
  if ((Number.parseInt(ahead, 10) || 0) > 0) {
    return {
      synced: false,
      warnings: [
        ...pendingMemoryIngestWarnings(state, team.name),
        `Shared team "${team.name}" has local commits ahead of upstream; skipped automatic sync. Run \`threadnote share sync --team ${team.name}\` to publish or reconcile them.`,
      ],
    };
  }

  const restoredPaths = yield* restoreTrackedSharedChanges(git, worktree);
  const restoreWarnings =
    restoredPaths.length > 0
      ? [
          `Shared team "${team.name}" restored ${restoredPaths.length} tracked shared file change(s) from git before automatic sync because the remote is authoritative.`,
        ]
      : [];
  if (yield* hasUncommittedChanges(worktree)) {
    return {
      synced: false,
      warnings: [
        ...pendingMemoryIngestWarnings(state, team.name),
        ...restoreWarnings,
        `Shared team "${team.name}" still has untracked or unmanaged changes; Threadnote left them untouched and skipped automatic sync. Run \`threadnote share sync --team ${team.name}\` to inspect and resolve them.`,
      ],
    };
  }

  const beforeRev = yield* gitOutput(worktree, ['rev-parse', 'HEAD'], false);
  const pullResult = yield* runCommand(git, ['-C', worktree, 'rebase', '@{u}'], {allowFailure: true});
  if (pullResult.exitCode !== 0) {
    if (yield* isShareGitOperationInProgress(git, worktree)) {
      throw new Error(
        `Automatic share sync hit git conflicts in ${worktree}. Resolve them in-place, run \`git -C ${worktree} rebase --continue\` (or --abort), then rerun recall/read.`,
      );
    }
    throw new Error(
      `Automatic share sync failed in ${worktree}: ${pullResult.stderr.trim() || pullResult.stdout.trim() || 'unknown error'}`,
    );
  }
  const afterRev = yield* gitOutput(worktree, ['rev-parse', 'HEAD'], false);
  let pulledChanges: readonly ChangedFile[] = [];
  if (beforeRev && afterRev && beforeRev !== afterRev) {
    pulledChanges = yield* listChangedFiles(worktree, beforeRev, afterRev);
  }
  const combined = mergeChanges(pendingChanges, pulledChanges);
  if (combined.length > 0) {
    yield* applyAndPersistChanges(config, team.config, state, combined, {quiet: true});
  }
  return {
    synced: true,
    warnings: [...restoreWarnings, ...pendingMemoryIngestWarnings(state, team.name, true)],
  };
});

function pendingMemoryIngestWarnings(
  state: AutoShareState,
  teamName: string,
  continuedForOtherChanges = false,
): readonly string[] {
  const count = state.pendingReindexes.get(teamName)?.length ?? 0;
  if (count === 0) {
    return [];
  }
  return [
    `Shared team "${teamName}" has ${count} pending shared memory ingest failure(s).${continuedForOtherChanges ? ' Automatic sync continued for other remote changes.' : ''} Run \`threadnote share conflicts --team ${teamName}\` to inspect them.`,
  ];
}

const teamsForShareQuery = Effect.fn('share.teamsForShareQuery')(function* (
  config: ShareRuntime,
  teamName: string | undefined,
) {
  if (teamName) {
    return [yield* resolveTeam(config, teamName)];
  }
  const teams = yield* readTeamsFile(config);
  const entries = Object.entries(teams.teams);
  if (entries.length === 0) {
    throw new Error('No shared teams configured. Run: threadnote share init <remote-url>');
  }
  return entries.map(([name, team]) => ({config: team, name}));
});

const readPendingShareConflict = Effect.fn('share.readPendingShareConflict')(function* (
  config: ShareRuntime,
  reference: string,
  optionTeam: string | undefined,
) {
  const target = yield* parseShareConflictReference(config, reference, optionTeam);
  const state = autoShareState(config);
  yield* loadPendingReindexes(config, state);
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
  return {change: yield* normalizePendingChange(target.team, change), team: target.team};
});

const parseShareConflictReference = Effect.fn('share.parseShareConflictReference')(function* (
  config: ShareRuntime,
  reference: string,
  optionTeam: string | undefined,
) {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new Error('Provide a conflict id, relative path, or threadnote:// shared memory URI.');
  }
  const canonicalReference = canonicalResourceInput(trimmed);
  if (canonicalReference) {
    const teamName = sharedTeamNameForUri(config, canonicalReference);
    if (!teamName) {
      throw new Error(`Shared memory URI does not include a configured team: ${trimmed}`);
    }
    const team = yield* resolveTeam(config, optionTeam ?? teamName);
    return {
      relativePath: assertSafeShareRelativePath(resourceUriToWorktreeRelative(config, canonicalReference, team.name)),
      team,
    };
  }
  const colon = trimmed.indexOf(':');
  if (colon > 0 && !trimmed.slice(0, colon).includes('/')) {
    const team = yield* resolveTeam(config, optionTeam ?? trimmed.slice(0, colon));
    return {relativePath: assertSafeShareRelativePath(trimmed.slice(colon + 1)), team};
  }
  const team = yield* resolveTeam(config, optionTeam);
  return {relativePath: assertSafeShareRelativePath(trimmed), team};
});

function assertSafeShareRelativePath(relativePath: string): string {
  if (
    !relativePath ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.split('/').some(segment => segment === '.' || segment === '..' || segment.length === 0)
  ) {
    throw new Error(`Invalid shared relative path: ${relativePath}`);
  }
  return relativePath;
}

const normalizePendingChange = Effect.fn('share.normalizePendingChange')(function* (
  team: ResolvedTeam,
  change: ChangedFile,
) {
  const relativePath = assertSafeShareRelativePath(change.relativePath);
  return {
    ...change,
    path: yield* pathJoin(team.config.worktree, ...relativePath.split('/')),
    relativePath,
  };
});

function isShareableMemoryChange(change: ChangedFile): boolean {
  const firstSegment = change.relativePath.split('/')[0];
  return change.relativePath.endsWith('.md') && SHAREABLE_MEMORY_KIND_DIRS.includes(firstSegment);
}

const buildShareConflictSummary = Effect.fn('share.buildShareConflictSummary')(function* (
  config: ShareRuntime,
  team: ResolvedTeam,
  change: ChangedFile,
) {
  const inspected = yield* inspectShareConflict(config, team, change);
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
});

const inspectShareConflict = Effect.fn('share.inspectShareConflict')(function* (
  config: ShareRuntime,
  team: ResolvedTeam,
  change: ChangedFile,
) {
  const ov = NATIVE_RESOURCE_BACKEND;
  const uri = yield* workfileToResourceUri(config, team.config, change.path);
  const localContent = yield* readOptionalMemoryContent(config, ov, uri);
  const shared = yield* readOptionalSharedConflictContent(uri, change);
  const previous = yield* readOptionalPreviousConflictContent(team.config.worktree, uri, change);
  return {
    hasLocalContent: localContent !== undefined,
    hasPreviousContent: previous.content !== undefined,
    hasSharedContent: shared.content !== undefined,
    id: conflictId(team.name, change.relativePath),
    localContent,
    previousContent: previous.content,
    reason: shareConflictReason(change, localContent, shared.content, previous.content, shared.error, previous.error),
    relativePath: change.relativePath,
    sharedContent: shared.content,
    status: change.status,
    team: team.name,
    uri,
  };
});

const readOptionalSharedConflictContent = Effect.fn('share.readOptionalSharedConflictContent')(function* (
  uri: string,
  change: ChangedFile,
) {
  const result = yield* Effect.result(
    Effect.gen(function* () {
      if (change.status === 'removed' || !(yield* isRegularFileNoSymlink(change.path))) {
        return {content: undefined, error: undefined};
      }
      return {content: yield* readSharedInboundFileContent(uri, change.path), error: undefined};
    }),
  );
  if (Result.isSuccess(result)) {
    return result.success;
  }
  const err = result.failure;
  return {content: undefined, error: err instanceof Error ? err.message : String(err)};
});

const readOptionalPreviousConflictContent = Effect.fn('share.readOptionalPreviousConflictContent')(function* (
  worktree: string,
  uri: string,
  change: ChangedFile,
) {
  const rawContent =
    change.previousContent ??
    (change.previousRevision
      ? yield* gitFileContent(worktree, change.previousRevision, change.relativePath)
      : undefined);
  if (rawContent === undefined) {
    return {content: undefined, error: undefined};
  }
  const result = yield* Effect.result(prepareSharedInboundContentEffect(uri, rawContent));
  if (Result.isSuccess(result)) {
    return {content: result.success, error: undefined};
  }
  const err = result.failure;
  return {content: undefined, error: err instanceof Error ? err.message : String(err)};
});

const readOptionalMemoryContent = Effect.fn('share.readOptionalMemoryContent')(function* (
  config: ShareRuntime,
  ov: string,
  uri: string,
) {
  if (!(yield* resourceExistsStrict(ov, config, uri))) {
    return undefined;
  }
  return yield* readMemoryContent(config, ov, uri, false);
});

function shareConflictReason(
  change: ChangedFile,
  localContent: string | undefined,
  sharedContent: string | undefined,
  previousContent: string | undefined,
  sharedError: string | undefined,
  previousError: string | undefined,
): string {
  if (sharedError) {
    return `shared file is not readable: ${sharedError}`;
  }
  if (previousError && change.status !== 'added') {
    return `previous shared content is not readable: ${previousError}`;
  }
  if (change.status === 'added') {
    if (localContent === undefined) {
      return 'shared file is pending ingestion into native canonical store';
    }
    if (sharedContent === undefined) {
      return 'shared file is missing or not readable';
    }
    return sharedMemoryContentsEquivalent(localContent, sharedContent)
      ? 'pending replay is already reflected in native canonical store'
      : 'local native canonical store content differs from the newly added shared file';
  }
  if (change.status === 'modified') {
    if (localContent === undefined) {
      return 'native canonical store resource is missing while a shared update is pending';
    }
    if (previousContent === undefined) {
      return 'previous shared content is unavailable, so local edits cannot be distinguished from upstream edits';
    }
    return sharedMemoryContentsEquivalent(localContent, previousContent)
      ? 'shared update is pending ingestion into native canonical store'
      : 'local native canonical store content differs from the previous shared version';
  }
  if (localContent === undefined) {
    return 'shared deletion is already reflected in native canonical store';
  }
  if (previousContent === undefined) {
    return 'previous shared content is unavailable, so local deletion cannot be verified safely';
  }
  return sharedMemoryContentsEquivalent(localContent, previousContent)
    ? 'shared deletion is pending removal from native canonical store'
    : 'local native canonical store content differs from the deleted shared version';
}

const conflictResolutionContent = Effect.fn('share.conflictResolutionContent')(function* (
  conflict: InspectedShareConflict,
  take: ShareConflictTake | undefined,
  fromFile: string | undefined,
  mergedContent: string | undefined,
) {
  const raw =
    fromFile !== undefined
      ? yield* readFile(yield* expandPath(fromFile), 'utf8')
      : mergedContent !== undefined
        ? mergedContent
        : take === 'local'
          ? conflict.localContent
          : undefined;
  if (raw === undefined) {
    throw new Error(`Cannot resolve ${conflict.id}: local native canonical store content is unavailable.`);
  }
  const scrub = applyScrubber(stripPersonalProvenance(raw), {redact: false});
  if (scrub.blocker) {
    throw new Error(
      `Refusing to resolve ${conflict.id}: possible ${scrub.blocker}. Strip the sensitive value before writing it to shared memory.`,
    );
  }
  return scrub.cleaned;
});

const writeSharedConflictFile = Effect.fn('share.writeSharedConflictFile')(function* (
  team: ResolvedTeam,
  conflict: InspectedShareConflict,
  content: string,
  dryRun: boolean,
) {
  const filePath = yield* pathJoin(team.config.worktree, conflict.relativePath);
  if (dryRun) {
    yield* Console.log(`Would write shared file: ${yield* portablePath(filePath)}`);
    return;
  }
  yield* mkdir(yield* pathDirname(filePath), {recursive: true});
  yield* writeFile(filePath, content, 'utf8');
});

const backupShareConflict = Effect.fn('share.backupShareConflict')(function* (
  config: ShareRuntime,
  conflict: InspectedShareConflict,
) {
  const backupDir = yield* pathJoin(
    config.agentContextHome,
    'share',
    'conflict-backups',
    safeTimestamp(),
    conflict.team,
    ...conflict.relativePath.split('/'),
  );
  yield* mkdir(backupDir, {recursive: true});
  const metadata = {
    id: conflict.id,
    reason: conflict.reason,
    relativePath: conflict.relativePath,
    status: conflict.status,
    team: conflict.team,
    uri: conflict.uri,
  };
  yield* writeFile(yield* pathJoin(backupDir, 'metadata.json'), `${JSON.stringify(metadata, undefined, 2)}\n`, 'utf8');
  if (conflict.localContent !== undefined) {
    yield* writeFile(yield* pathJoin(backupDir, 'local.md'), conflict.localContent, 'utf8');
  }
  if (conflict.sharedContent !== undefined) {
    yield* writeFile(yield* pathJoin(backupDir, 'shared.md'), conflict.sharedContent, 'utf8');
  }
  if (conflict.previousContent !== undefined) {
    yield* writeFile(yield* pathJoin(backupDir, 'previous.md'), conflict.previousContent, 'utf8');
  }
  return backupDir;
});

const clearPendingShareConflict = Effect.fn('share.clearPendingShareConflict')(function* (
  config: ShareRuntime,
  teamName: string,
  relativePath: string,
) {
  const state = autoShareState(config);
  yield* loadPendingReindexes(config, state);
  const pending = state.pendingReindexes.get(teamName) ?? [];
  const remaining = pending.filter(change => change.relativePath !== relativePath);
  if (remaining.length > 0) {
    state.pendingReindexes.set(teamName, remaining);
  } else {
    state.pendingReindexes.delete(teamName);
  }
  yield* writePendingReindexes(config, state);
});

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
      formatTwoWayDiff(
        'previous shared',
        conflict.previousContent,
        'local native canonical store',
        conflict.localContent,
      ),
    );
  }
  parts.push(
    formatTwoWayDiff('local native canonical store', conflict.localContent, 'shared file', conflict.sharedContent),
  );
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

const stageShareableChanges = Effect.fn('share.stageShareableChanges')(function* (
  dryRun: boolean,
  git: string,
  worktree: string,
) {
  // Stage repo guidance/metadata plus every shareable top-level dir.
  // native canonical store-generated summaries (.abstract.md, .overview.md) are excluded
  // via the repo's .gitignore (ensureSharedGitignore self-heals it on every
  // sync), so they never get staged even by an unscoped `git add`.
  // First drop any incomplete pack orphaned by a killed publish, so the blanket
  // `git add -A` below never commits a pack index without its manifest.
  yield* removeOrphanPackIndexes(dryRun, git, worktree);
  const pathspecs = yield* existingShareablePathspecs(git, worktree);
  if (pathspecs.length === 0) {
    return;
  }
  yield* maybeRun(dryRun, git, ['-C', worktree, 'add', '-A', '--', ...pathspecs], {allowFailure: true});
});

// A pack whose <name>.pack.md index exists but whose <name>.pack.json manifest
// is missing is an incomplete publish (e.g. interrupted by SIGKILL). Discovery
// already skips such packs; this removes the UNTRACKED leftover before staging so
// `git add -A` cannot commit/push it. Tracked trees are never touched.
const removeOrphanPackIndexes = Effect.fn('share.removeOrphanPackIndexes')(function* (
  dryRun: boolean,
  git: string,
  worktree: string,
) {
  const packsRoot = yield* pathJoin(worktree, SHAREABLE_ARTIFACT_DIR, 'packs');
  if (!(yield* isDirectory(packsRoot))) {
    return;
  }
  for (const agentEntry of yield* readdir(packsRoot, {withFileTypes: true})) {
    if (!agentEntry.isDirectory()) {
      continue;
    }
    const agentDir = yield* pathJoin(packsRoot, agentEntry.name);
    for (const nameEntry of yield* readdir(agentDir, {withFileTypes: true})) {
      if (!nameEntry.isDirectory()) {
        continue;
      }
      const packDir = yield* pathJoin(agentDir, nameEntry.name);
      const indexPath = yield* pathJoin(packDir, `${nameEntry.name}${PACK_INDEX_SUFFIX}`);
      const manifestPath = yield* pathJoin(packDir, `${nameEntry.name}${PACK_MANIFEST_SUFFIX}`);
      if (!(yield* isFile(indexPath)) || (yield* isFile(manifestPath))) {
        continue;
      }
      const indexRelative = (yield* pathRelative(worktree, indexPath)).split(yield* pathSeparator).join('/');
      const tracked = yield* runCommand(git, ['-C', worktree, 'ls-files', '--', indexRelative], {allowFailure: true});
      if (tracked.exitCode === 0 && tracked.stdout.trim().length > 0) {
        continue;
      }
      yield* Console.warn(
        `${dryRun ? 'Would remove' : 'Removing'} incomplete shared pack (missing ${nameEntry.name}${PACK_MANIFEST_SUFFIX}): ${indexRelative}`,
      );
      if (!dryRun) {
        yield* rm(packDir, {force: true, recursive: true});
      }
    }
  }
});

const existingShareablePathspecs = Effect.fn('share.existingShareablePathspecs')(function* (
  git: string,
  worktree: string,
) {
  const rootFiles = yield* Effect.all(
    SHAREABLE_ROOT_FILES.map(
      Effect.fn('share.callback')(function* (file) {
        return (yield* hasWorktreeOrTrackedPath(git, worktree, file)) ? `:(top)${file}` : undefined;
      }),
    ),
  );
  const topLevelDirs = yield* Effect.all(
    SHAREABLE_TOP_LEVEL_DIRS.map(
      Effect.fn('share.callback')(function* (dir) {
        return (yield* hasWorktreeOrTrackedPath(git, worktree, dir)) ? `:(top)${dir}` : undefined;
      }),
    ),
  );
  return [...rootFiles, ...topLevelDirs].filter((pathspec): pathspec is string => pathspec !== undefined);
});

const hasWorktreeOrTrackedPath = Effect.fn('share.hasWorktreeOrTrackedPath')(function* (
  git: string,
  worktree: string,
  relativePath: string,
) {
  if (yield* exists(yield* pathJoin(worktree, relativePath))) {
    return true;
  }
  const result = yield* runCommand(git, ['-C', worktree, 'ls-files', '--', relativePath], {allowFailure: true});
  return result.exitCode === 0 && result.stdout.trim().length > 0;
});

export const publishShareGitChange = Effect.fn('share.publishShareGitChange')(function* (
  worktree: string,
  relativePath: string | readonly string[],
  commitMessage: string,
  options: {
    readonly dryRun?: boolean;
    readonly push?: boolean;
    readonly verb?: 'add' | 'rm';
  } = {},
) {
  const dryRun = options.dryRun === true;
  const push = options.push !== false;
  const verb = options.verb ?? 'add';
  const git = yield* requiredExecutable('git');
  const messages: string[] = [];
  const paths = typeof relativePath === 'string' ? [relativePath] : [...relativePath];
  const stageArgs = verb === 'rm' ? ['-C', worktree, 'rm', '--', ...paths] : ['-C', worktree, 'add', '--', ...paths];
  const stageResult = yield* runGitCommand(dryRun, git, stageArgs, `git ${verb} failed`);
  if (stageResult) {
    messages.push(`git ${verb}: ${stageResult.stdout.trim() || 'ok'}`);
  }

  if (dryRun) {
    yield* Console.log(`Would run: ${formatShellCommand(git, ['-C', worktree, 'commit', '-m', commitMessage])}`);
  } else {
    const commitResult = yield* runCommand(git, ['-C', worktree, 'commit', '-m', commitMessage], {allowFailure: true});
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
  const pushResult = yield* runGitCommand(
    dryRun,
    git,
    ['-C', worktree, 'push', DEFAULT_GIT_REMOTE_NAME],
    'git push failed',
  );
  if (pushResult) {
    messages.push(`git push: ${pushResult.stdout.trim() || pushResult.stderr.trim() || 'ok'}`);
  }
  return messages;
});

export const writeSharedWorktreeFile = Effect.fn('share.writeSharedWorktreeFile')(function* (
  worktree: string,
  relativePath: string,
  content: string,
  dryRun = false,
) {
  const safeRelativePath = assertSafeShareRelativePath(relativePath);
  const targetPath = yield* pathJoin(worktree, ...safeRelativePath.split('/'));
  if (dryRun) {
    yield* Console.log(`Would write shared worktree file: ${targetPath}`);
    return targetPath;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const realWorktree = yield* fs.realPath(worktree);
  let current = path.resolve(worktree);
  for (const segment of safeRelativePath.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    if (Option.isSome(yield* fs.readLink(current).pipe(Effect.option))) {
      return yield* Effect.fail(new Error(`Refusing to write through a shared worktree symbolic link: ${current}`));
    }
    if (yield* fs.exists(current)) {
      const info = yield* fs.stat(current);
      if (info.type !== 'Directory') {
        return yield* Effect.fail(new Error(`Shared worktree parent is not a directory: ${current}`));
      }
    } else {
      yield* fs.makeDirectory(current, {mode: 0o700});
    }
    const expected = path.resolve(realWorktree, path.relative(path.resolve(worktree), current));
    if ((yield* fs.realPath(current)) !== expected) {
      return yield* Effect.fail(new Error(`Refusing to write through a shared worktree path alias: ${current}`));
    }
  }
  if (Option.isSome(yield* fs.readLink(targetPath).pipe(Effect.option))) {
    return yield* Effect.fail(new Error(`Refusing to replace a shared worktree symbolic link: ${targetPath}`));
  }
  const temporaryPath = `${targetPath}.${system.processId}.tmp`;
  yield* fs.writeFileString(temporaryPath, content, {mode: 0o600});
  yield* fs
    .rename(temporaryPath, targetPath)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.catch(() => Effect.void))));
  return targetPath;
});

export function assertSharedWorktreeFileReady(
  worktree: string,
  relativePath: string,
  expectedContent: string | undefined,
  dryRun = false,
): Effect.Effect<void, unknown, CommandExecutor | FileSystem.FileSystem | Path.Path | SystemInfo> {
  return Effect.gen(function* () {
    if (dryRun) return;
    const safeRelativePath = assertSafeShareRelativePath(relativePath);
    const git = yield* requiredExecutable('git');
    const unmerged = yield* runCommand(git, ['-C', worktree, 'ls-files', '-u', '--', safeRelativePath], {
      allowFailure: true,
    });
    if (unmerged.exitCode !== 0) {
      return yield* Effect.fail(
        new Error(
          `Could not verify shared worktree state for ${safeRelativePath}: ${unmerged.stderr.trim() || unmerged.stdout.trim() || 'git ls-files failed'}.`,
        ),
      );
    }
    if (unmerged.stdout.trim().length > 0) {
      return yield* Effect.fail(
        new Error(
          `Refusing to overwrite unmerged shared worktree file: ${safeRelativePath}. Resolve the conflict first.`,
        ),
      );
    }
    const targetPath = yield* pathJoin(worktree, ...safeRelativePath.split('/'));
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(targetPath))) return;
    if (Option.isSome(yield* fs.readLink(targetPath).pipe(Effect.option))) {
      return yield* Effect.fail(new Error(`Refusing to replace a shared worktree symbolic link: ${targetPath}`));
    }
    const info = yield* fs.stat(targetPath);
    if (info.type !== 'File') {
      return yield* Effect.fail(new Error(`Shared worktree target is not a regular file: ${targetPath}`));
    }
    const currentContent = yield* fs.readFileString(targetPath);
    if (
      expectedContent === undefined ||
      canonicalMemoryDocumentContent(currentContent) !== canonicalMemoryDocumentContent(expectedContent)
    ) {
      return yield* Effect.fail(
        new Error(
          `Refusing to overwrite changed shared worktree file: ${safeRelativePath}. Sync or resolve the worktree conflict first.`,
        ),
      );
    }
  });
}

const runGitCommand = Effect.fn('share.runGitCommand')(function* (
  dryRun: boolean,
  git: string,
  args: readonly string[],
  failureLabel: string,
) {
  if (dryRun) {
    yield* Console.log(`Would run: ${formatShellCommand(git, args)}`);
    return undefined;
  }
  const result = yield* runCommand(git, args, {allowFailure: true});
  if (result.exitCode !== 0) {
    throw new Error(`${failureLabel}: ${result.stderr.trim() || result.stdout.trim() || 'unknown error'}`);
  }
  return result;
});

export const runSharePublish = Effect.fn('share.runSharePublish')(function* (
  config: ShareRuntime,
  sourceUri: string,
  options: SharePublishOptions,
) {
  assertResourceUri(sourceUri);
  const team = yield* resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  const preview = options.preview === true;
  if (isInSharedNamespace(config, sourceUri)) {
    throw new Error(`Memory ${sourceUri} is already in the shared namespace.`);
  }
  const ov = NATIVE_RESOURCE_BACKEND;
  const rawContent = yield* readMemoryContent(config, ov, sourceUri, dryRun);
  const stripped = setMemoryVisibility(stripPersonalProvenance(rawContent), 'shared');
  const scrub = applyScrubber(stripped, {redact: options.redact === true});
  const targetUri = sharedUriFor(config, sourceUri, team.name);

  if (preview) {
    yield* Console.log(`PREVIEW source: ${sourceUri}`);
    yield* Console.log(`PREVIEW destination: ${targetUri}`);
    if (scrub.blocker) {
      yield* Console.log(
        `PREVIEW BLOCKED: ${scrub.blocker}. Strip the sensitive value or rerun with --redact for soft-leak patterns.`,
      );
      return;
    }
    for (const redaction of scrub.redactions) {
      yield* Console.log(`PREVIEW redact: ${redaction.count}× ${redaction.name}`);
    }
    yield* Console.log('-----BEGIN PREVIEW-----');
    yield* Console.log(scrub.cleaned);
    yield* Console.log('-----END PREVIEW-----');
    return;
  }

  if (scrub.blocker) {
    throw new Error(
      `Refusing to publish ${sourceUri}: possible ${scrub.blocker}. Strip the sensitive value or pass --redact for soft-leak patterns.`,
    );
  }
  const worktree = team.config.worktree;
  const relativePath = resourceUriToWorktreeRelative(config, targetUri, team.name);
  const message = options.message ?? `share: publish ${relativePath}`;
  const publish = Effect.fn('share.callback')(function* () {
    const currentRawContent = dryRun ? rawContent : yield* readMemoryContent(config, ov, sourceUri, false);
    const currentScrub = applyScrubber(setMemoryVisibility(stripPersonalProvenance(currentRawContent), 'shared'), {
      redact: options.redact === true,
    });
    if (currentScrub.blocker) {
      throw new Error(
        `Refusing to publish ${sourceUri}: possible ${currentScrub.blocker}. Strip the sensitive value or pass --redact for soft-leak patterns.`,
      );
    }
    const existingTarget =
      !dryRun && (yield* resourceExists(ov, config, targetUri))
        ? yield* readMemoryContent(config, ov, targetUri, false)
        : undefined;
    if (
      existingTarget !== undefined &&
      canonicalMemoryDocumentContent(setMemoryVisibility(existingTarget, 'shared')) !==
        canonicalMemoryDocumentContent(currentScrub.cleaned)
    ) {
      throw new Error(
        `Refusing to publish: ${targetUri} already exists with different content. Inspect it via threadnote read and resolve the conflict explicitly.`,
      );
    }
    yield* assertSharedWorktreeFileReady(worktree, relativePath, currentScrub.cleaned, dryRun);
    yield* ensureSharedDirectoryChain(config, ov, targetUri, dryRun);
    yield* writeMemoryFile(
      config,
      ov,
      targetUri,
      currentScrub.cleaned,
      existingTarget === undefined ? 'create' : 'replace',
      dryRun,
    );
    if (!dryRun) {
      const storedTarget = yield* readMemoryContent(config, ov, targetUri, false);
      if (canonicalMemoryDocumentContent(storedTarget) !== canonicalMemoryDocumentContent(currentScrub.cleaned)) {
        throw new Error(`Shared target verification failed after writing ${targetUri}; personal source preserved.`);
      }
    }
    yield* writeSharedWorktreeFile(worktree, relativePath, currentScrub.cleaned, dryRun);
    const gitMessages = yield* publishShareGitChange(worktree, relativePath, message, {
      dryRun,
      push: options.push,
    });
    if (!dryRun) {
      const sourceBeforeRemoval = yield* readMemoryContent(config, ov, sourceUri, false);
      if (sourceBeforeRemoval.trim() !== currentRawContent.trim()) {
        throw new Error(`Memory ${sourceUri} changed during publication; personal source preserved.`);
      }
    }
    yield* removeMemoryUri(config, ov, sourceUri, dryRun);
    return {gitMessages, redactions: currentScrub.redactions};
  });
  const published = yield* publish();
  for (const redaction of published.redactions) {
    yield* Console.log(`Redacted ${redaction.count}× ${redaction.name} before publish.`);
  }
  const gitMessages = published.gitMessages;
  for (const gitMessage of gitMessages) {
    yield* Console.log(gitMessage);
  }
  yield* Console.log(`Published ${sourceUri} -> ${targetUri}`);
});

export const runSharePublishArtifact = Effect.fn('share.runSharePublishArtifact')(function* (
  config: ShareRuntime,
  sourcePath: string,
  options: SharePublishArtifactOptions,
) {
  const result = yield* shareAgentArtifact(config, sourcePath, options);
  yield* printShareArtifactResult(result, options.preview === true);
});

export const shareAgentArtifact = Effect.fn('share.shareAgentArtifact')(function* (
  config: ShareRuntime,
  sourcePath: string,
  options: SharePublishArtifactOptions,
) {
  const team = yield* resolveTeam(config, options.team);
  const resolvedSourcePath = yield* expandPath(sourcePath);
  if (!(yield* isRegularFileNoSymlink(resolvedSourcePath))) {
    throw new Error(`Agent artifact source is not a regular file: ${resolvedSourcePath}`);
  }

  const artifact = yield* inferShareArtifact(resolvedSourcePath, options);
  // A skill carries its whole directory. When companion files sit beside the
  // SKILL.md it is shared as a multi-file bundle; a lone SKILL.md takes the same
  // single-file path as before, byte-for-byte.
  if (artifact.kind === 'skill') {
    const skillDir = yield* pathDirname(resolvedSourcePath);
    const members = yield* collectBundleMemberFiles(skillDir);
    if (members.length > 1) {
      return yield* shareBundleArtifact(config, team, artifact, skillDir, members, options);
    }
  }
  return yield* shareSingleArtifact(config, team, resolvedSourcePath, artifact, options);
});

type ResolvedShareTeam = ResolvedTeam;

const shareSingleArtifact = Effect.fn('share.shareSingleArtifact')(function* (
  config: ShareRuntime,
  team: ResolvedShareTeam,
  resolvedSourcePath: string,
  artifact: ShareArtifactMetadata,
  options: SharePublishArtifactOptions,
) {
  const dryRun = options.dryRun === true;
  const preview = options.preview === true;
  const rawContent = yield* readFile(resolvedSourcePath, 'utf8');
  if (!rawContent.trim()) {
    throw new Error(`Refusing to share empty agent artifact: ${resolvedSourcePath}`);
  }
  const scrub = applyScrubber(rawContent, {redact: options.redact === true});
  const relativePath = sharedArtifactRelativePath(artifact);
  const targetPath = yield* pathJoin(team.config.worktree, ...relativePath.split('/'));
  const targetUri = yield* workfileToResourceUri(config, team.config, targetPath);
  const messages: string[] = [
    `${preview ? 'Previewing' : dryRun ? 'Would share' : 'Sharing'} ${artifact.kind} ${artifact.agent}/${artifact.name}`,
    `Source: ${yield* portablePath(resolvedSourcePath)}`,
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
  const existingContent = (yield* readFileIfExists(targetPath)) ?? undefined;
  if (existingContent !== undefined && existingContent !== content && options.force !== true) {
    throw new Error(
      `Shared artifact already exists with different content: ${yield* portablePath(targetPath)}. Pass --force to replace it.`,
    );
  }

  if (dryRun) {
    messages.push(`Would write shared artifact: ${yield* portablePath(targetPath)}`);
  }

  const ov = NATIVE_RESOURCE_BACKEND;
  const ovHasResource = !dryRun && (yield* resourceExists(ov, config, targetUri));
  yield* ensureSharedDirectoryChain(config, ov, targetUri, dryRun, {quiet: true});
  yield* writeMemoryFile(config, ov, targetUri, content, ovHasResource ? 'replace' : 'create', dryRun, {quiet: true});
  yield* writeSharedWorktreeFile(team.config.worktree, relativePath, content, dryRun);

  const message = options.message ?? `share: publish ${relativePath}`;
  const gitMessages = yield* publishShareGitChange(team.config.worktree, relativePath, message, {
    dryRun,
    push: options.push,
  });
  return {artifact, gitMessages, messages, sourcePath: resolvedSourcePath, targetPath, targetUri};
});

interface PreparedBundleMember {
  readonly binary: boolean;
  readonly blocker?: string;
  readonly content: Uint8Array | string;
  readonly redactions: ReadonlyArray<{readonly count: number; readonly name: string}>;
  readonly relativePath: string;
  readonly sha256: string;
  readonly targetPath: string;
  readonly targetUri: string;
}

const shareBundleArtifact = Effect.fn('share.shareBundleArtifact')(function* (
  config: ShareRuntime,
  team: ResolvedShareTeam,
  artifact: ShareArtifactMetadata,
  skillDir: string,
  members: readonly BundleMemberFile[],
  options: SharePublishArtifactOptions,
) {
  const dryRun = options.dryRun === true;
  const preview = options.preview === true;
  const skillRootRelative = `${SHAREABLE_ARTIFACT_DIR}/skills/${artifact.agent}/${artifact.name}`;
  const skillRootTargetDir = yield* pathJoin(team.config.worktree, ...skillRootRelative.split('/'));
  const skillMdTargetPath = yield* pathJoin(skillRootTargetDir, 'SKILL.md');
  const skillMdTargetUri = yield* workfileToResourceUri(config, team.config, skillMdTargetPath);
  const skillRootTargetUri = parentUri(skillMdTargetUri);
  const skillMdSourcePath = yield* pathJoin(skillDir, 'SKILL.md');

  const prepared = yield* Effect.all(
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
    `Source: ${yield* portablePath(skillDir)}`,
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
    const existing = yield* readFileBytesIfExists(entry.targetPath);
    if (existing !== undefined && (yield* sha256(existing)) !== entry.sha256 && options.force !== true) {
      throw new Error(
        `Shared artifact already exists with different content: ${yield* portablePath(entry.targetPath)}. Pass --force to replace it.`,
      );
    }
  }

  if (dryRun) {
    messages.push(`Would write ${prepared.length} files under ${yield* portablePath(skillRootTargetDir)}`);
    return {
      artifact,
      gitMessages: [],
      messages,
      sourcePath: skillMdSourcePath,
      targetPath: skillMdTargetPath,
      targetUri: skillMdTargetUri,
    };
  }

  // Safety invariant: native canonical store-managed markdown is written first (SKILL.md
  // leading), so a failed OV write never leaves a worktree tree that a later
  // share sync would auto-commit without ingestion. Companion files and the
  // manifest are materialized only after every markdown write succeeds.
  const ov = NATIVE_RESOURCE_BACKEND;
  const markdownMembers = orderSkillMdFirst(prepared.filter(entry => entry.relativePath.endsWith('.md')));
  const otherMembers = prepared.filter(entry => !entry.relativePath.endsWith('.md'));
  for (const entry of markdownMembers) {
    const ovHasResource = yield* resourceExists(ov, config, entry.targetUri);
    yield* ensureSharedDirectoryChain(config, ov, entry.targetUri, dryRun, {quiet: true});
    yield* writeMemoryFile(
      config,
      ov,
      entry.targetUri,
      entry.content as string,
      ovHasResource ? 'replace' : 'create',
      dryRun,
      {quiet: true},
    );
    yield* writeSharedWorktreeFile(
      team.config.worktree,
      `${skillRootRelative}/${entry.relativePath}`,
      entry.content as string,
      dryRun,
    );
  }
  yield* ensureDirectory(skillRootTargetDir, false);
  for (const entry of otherMembers) {
    yield* ensureDirectory(yield* pathDirname(entry.targetPath), false);
    yield* writeFile(entry.targetPath, entry.content, entry.binary ? {mode: 0o600} : {encoding: 'utf8', mode: 0o600});
  }
  yield* writeFile(yield* pathJoin(skillRootTargetDir, BUNDLE_MANIFEST_FILE), buildBundleManifest(artifact, prepared), {
    encoding: 'utf8',
    mode: 0o600,
  });

  const stagedPaths = [
    ...prepared.map(entry => `${skillRootRelative}/${entry.relativePath}`),
    `${skillRootRelative}/${BUNDLE_MANIFEST_FILE}`,
  ];
  const message =
    options.message ?? `share: publish skill ${artifact.agent}/${artifact.name} (${prepared.length} files)`;
  const gitMessages = yield* publishShareGitChange(team.config.worktree, stagedPaths, message, {
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
});

const prepareBundleMember = Effect.fn('share.prepareBundleMember')(function* (
  config: ShareRuntime,
  team: ResolvedShareTeam,
  member: BundleMemberFile,
  skillRootTargetDir: string,
  options: SharePublishArtifactOptions,
) {
  const buffer = yield* readFile(member.absolutePath);
  const targetPath = yield* pathJoin(skillRootTargetDir, ...member.relativePath.split('/'));
  const targetUri = yield* workfileToResourceUri(config, team.config, targetPath);
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
      sha256: yield* sha256(buffer),
      targetPath,
      targetUri,
    };
  }
  const scrub = applyScrubber(new TextDecoder().decode(buffer), {redact: options.redact === true});
  return {
    binary: false,
    blocker: scrub.blocker,
    content: scrub.cleaned,
    redactions: scrub.redactions,
    relativePath: member.relativePath,
    sha256: yield* sha256(scrub.cleaned),
    targetPath,
    targetUri,
  };
});

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

const collectBundleMemberFiles = Effect.fn('share.collectBundleMemberFiles')(function* (skillDir: string) {
  const out: BundleMemberFile[] = [];
  const visit: (dir: string) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> = Effect.fn(
    'share.visit',
  )(function* (dir: string) {
    const entries = yield* readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const full = yield* pathJoin(dir, entry.name);
      if (entry.isDirectory()) {
        if (!BUNDLE_IGNORE_DIR_NAMES.includes(entry.name)) {
          yield* visit(full);
        }
        continue;
      }
      if (!entry.isFile() || isIgnoredBundleFile(entry.name)) {
        continue;
      }
      out.push({
        absolutePath: full,
        relativePath: (yield* pathRelative(skillDir, full)).split(yield* pathSeparator).join('/'),
      });
    }
  });
  yield* visit(skillDir);
  return out.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
});

function isIgnoredBundleFile(name: string): boolean {
  if (name === '.DS_Store' || name === BUNDLE_MANIFEST_FILE || name === BUNDLE_INSTALL_METADATA_FILE) {
    return true;
  }
  if (OV_SUMMARY_FILES.includes(name)) {
    return true;
  }
  return name.endsWith('.log') || name.endsWith('.threadnote-install.json');
}

function isProbablyBinary(buffer: Uint8Array): boolean {
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

function detectBinaryCredential(buffer: Uint8Array): string | undefined {
  return credentialScrubberBlocker(new TextDecoder('latin1').decode(buffer));
}

// Scans binary bytes for a machine-local path that the pack rewriter would
// neutralize in text — a declared repo root, or a home-path soft-leak — so an
// --allow-binary member cannot silently carry one.
function detectBinaryLocalPath(buffer: Uint8Array, rewriteRoots: readonly string[]): string | undefined {
  const latin1 = new TextDecoder('latin1').decode(buffer);
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

const readFileBytesIfExists = Effect.fn('share.readFileBytesIfExists')(function* (path: string) {
  const bytes = yield* readFile(path).pipe(Effect.option);
  return Option.getOrUndefined(bytes);
});

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

export const runSharePublishBundle = Effect.fn('share.runSharePublishBundle')(function* (
  config: ShareRuntime,
  manifestPath: string,
  options: SharePublishArtifactOptions,
) {
  const result = yield* shareBundlePack(config, manifestPath, options);
  yield* printShareArtifactResult(result, options.preview === true);
});

const parsePackManifest = Effect.fn('share.parsePackManifest')(function* (raw: string, manifestPath: string) {
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
    if (!(yield* pathIsAbsolute(rewrite)) || rewrite.split('/').filter(Boolean).length < 2) {
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
  } as PackManifest;
});

// Resolves manifest skill + include entries into a flat, deduplicated member
// list whose relative paths preserve the author's repo layout so relative
// imports and CWD-relative invocations resolve once installed under one root.
const collectPackMembers = Effect.fn('share.collectPackMembers')(function* (
  manifestDir: string,
  manifest: PackManifest,
) {
  const members = new Map<string, BundleMemberFile>();
  const addEntry = Effect.fn('share.callback')(function* (entry: string) {
    const normalized = entry.split('/').filter(Boolean).join('/');
    if (normalized.split('/').includes('..')) {
      throw new Error(`Pack manifest entries must stay within the pack root (got "${entry}").`);
    }
    const absolute = yield* pathJoin(manifestDir, ...normalized.split('/'));
    if (absolute !== manifestDir && !absolute.startsWith(manifestDir + (yield* pathSeparator))) {
      throw new Error(`Pack manifest entry escapes the pack root: ${entry}`);
    }
    if (yield* isDirectory(absolute)) {
      for (const member of yield* collectBundleMemberFiles(absolute)) {
        const relativePath = `${normalized}/${member.relativePath}`;
        members.set(relativePath, {absolutePath: member.absolutePath, relativePath});
      }
      return;
    }
    if (yield* isRegularFileNoSymlink(absolute)) {
      members.set(normalized, {absolutePath: absolute, relativePath: normalized});
      return;
    }
    throw new Error(`Pack manifest references a missing path: ${entry}`);
  });
  for (const skill of manifest.skills) {
    // Accept either a skill directory or a path to its SKILL.md.
    const skillRel = skill.replace(/\/SKILL\.md$/i, '');
    const skillDir = yield* pathJoin(manifestDir, ...skillRel.split('/'));
    if (!(yield* isFile(yield* pathJoin(skillDir, 'SKILL.md')))) {
      throw new Error(`Pack skill "${skill}" must be a directory containing SKILL.md.`);
    }
    yield* addEntry(skillRel);
  }
  for (const include of manifest.include) {
    yield* addEntry(include);
  }
  return [...members.values()].sort((a, b) => compareStrings(a.relativePath, b.relativePath));
});

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

const preparePackMember = Effect.fn('share.preparePackMember')(function* (
  config: ShareRuntime,
  team: ResolvedShareTeam,
  member: BundleMemberFile,
  filesTargetDir: string,
  rewriteRoots: readonly string[],
  options: SharePublishArtifactOptions,
) {
  const buffer = yield* readFile(member.absolutePath);
  const targetPath = yield* pathJoin(filesTargetDir, ...member.relativePath.split('/'));
  const targetUri = yield* workfileToResourceUri(config, team.config, targetPath);
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
      sha256: yield* sha256(buffer),
      targetPath,
      targetUri,
    };
  }
  const text = new TextDecoder().decode(buffer);
  // A member that already contains the reserved token would have it expanded to
  // the installer's absolute path at install — block it as an authoring error.
  if (text.includes(PACK_ROOT_TOKEN)) {
    return {
      binary: false,
      blocker: `contains the reserved ${PACK_ROOT_TOKEN} token`,
      content: text,
      redactions: [],
      relativePath: member.relativePath,
      sha256: yield* sha256(text),
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
    sha256: yield* sha256(scrub.cleaned),
    targetPath,
    targetUri,
  };
});

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

const packSkillName = Effect.fn('share.packSkillName')(function* (skillEntry: string) {
  const trimmed = skillEntry.replace(/\/SKILL\.md$/i, '');
  return yield* pathBasename(trimmed);
});

export const shareBundlePack = Effect.fn('share.shareBundlePack')(function* (
  config: ShareRuntime,
  manifestPath: string,
  options: SharePublishArtifactOptions,
) {
  const team = yield* resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  const preview = options.preview === true;
  const resolvedManifest = yield* expandPath(manifestPath);
  if (!(yield* isRegularFileNoSymlink(resolvedManifest))) {
    throw new Error(`Pack manifest is not a regular file: ${resolvedManifest}`);
  }
  const manifest = yield* parsePackManifest(yield* readFile(resolvedManifest, 'utf8'), resolvedManifest);
  const manifestDir = yield* pathDirname(resolvedManifest);
  const artifact: ShareArtifactMetadata = {agent: manifest.agent, kind: 'pack', name: uriSegment(manifest.name)};
  const skillNames = yield* Effect.all(manifest.skills.map(packSkillName));

  const members = yield* collectPackMembers(manifestDir, manifest);
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
  const filesTargetDir = yield* pathJoin(team.config.worktree, ...filesRelative.split('/'));
  const packRootTargetDir = yield* pathJoin(team.config.worktree, ...packRootRelative.split('/'));
  const indexTargetPath = yield* pathJoin(team.config.worktree, ...indexRelative.split('/'));
  const indexTargetUri = yield* workfileToResourceUri(config, team.config, indexTargetPath);

  const prepared = yield* Effect.all(
    members.map(member => preparePackMember(config, team, member, filesTargetDir, rewriteRoots, options)),
  );
  // Tokenize the generated index + manifest too (not just member files) so an
  // author repo-root path embedded in description/deps is normalized to the
  // portable token rather than leaking or noisily blocking.
  const indexContent = tokenizePackPaths(buildPackIndex(artifact, manifest, skillNames, prepared.length), rewriteRoots);
  const indexScrub = applyScrubber(indexContent, {redact: options.redact === true});

  const messages: string[] = [
    `${preview ? 'Previewing' : dryRun ? 'Would share' : 'Sharing'} pack ${artifact.agent}/${artifact.name} (${prepared.length} files, ${skillNames.length} skills)`,
    `Source: ${yield* portablePath(manifestDir)}`,
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
    const existing = yield* readFileBytesIfExists(entry.targetPath);
    if (existing !== undefined && (yield* sha256(existing)) !== entry.sha256 && options.force !== true) {
      throw new Error(
        `Shared pack file already exists with different content: ${yield* portablePath(entry.targetPath)}. Pass --force to replace it.`,
      );
    }
  }

  if (dryRun) {
    messages.push(`Would write ${prepared.length} files under ${yield* portablePath(packRootTargetDir)}`);
    return {
      artifact,
      gitMessages: [],
      messages,
      sourcePath: resolvedManifest,
      targetPath: indexTargetPath,
      targetUri: indexTargetUri,
    };
  }

  // Safety invariant: native canonical store-managed markdown is written first (the index
  // leads), so a failed OV write never leaves a worktree tree that a later share
  // sync would auto-commit without ingestion.
  const ov = NATIVE_RESOURCE_BACKEND;
  // Restore-capable rollback: before overwriting any resource, snapshot its prior
  // bytes; on a mid-publish failure, undo in reverse — newly-created resources are
  // removed and replaced ones (a --force re-publish) are restored to their prior
  // content. This leaves the previously-published pack intact and nothing
  // inconsistent for a later share sync to auto-commit.
  const rollbacks: Array<
    () => Effect.Effect<void, unknown, CommandExecutor | FileSystem.FileSystem | Path.Path | ResourceStore | SystemInfo>
  > = [];
  const manifestTargetPath = yield* pathJoin(team.config.worktree, ...manifestRelative.split('/'));
  const publishResult = yield* Effect.result(
    Effect.gen(function* () {
      const writeMarkdownMember = Effect.fn('share.callback')(function* (
        uri: string,
        content: string,
        worktreePath: string,
      ) {
        const priorBytes = yield* readFileBytesIfExists(worktreePath);
        const hadResource = yield* resourceExists(ov, config, uri);
        const worktreeRelativePath = (yield* pathRelative(team.config.worktree, worktreePath))
          .split(yield* pathSeparator)
          .join('/');
        yield* ensureSharedDirectoryChain(config, ov, uri, dryRun, {quiet: true});
        yield* writeMemoryFile(config, ov, uri, content, hadResource ? 'replace' : 'create', dryRun, {quiet: true});
        yield* writeSharedWorktreeFile(team.config.worktree, worktreeRelativePath, content, dryRun);
        rollbacks.push(
          Effect.fn('share.callback')(function* () {
            if (priorBytes !== undefined) {
              yield* writeMemoryFile(config, ov, uri, new TextDecoder().decode(priorBytes), 'replace', false, {
                quiet: true,
              });
              yield* writeSharedWorktreeFile(
                team.config.worktree,
                worktreeRelativePath,
                new TextDecoder().decode(priorBytes),
                false,
              );
            } else {
              if (yield* resourceExists(ov, config, uri)) {
                yield* removeMemoryUri(config, ov, uri, false, {quiet: true});
              }
              yield* rm(worktreePath, {force: true});
            }
          }),
        );
      });
      yield* writeMarkdownMember(indexTargetUri, indexScrub.cleaned, indexTargetPath);
      for (const entry of prepared.filter(member => member.relativePath.endsWith('.md'))) {
        yield* writeMarkdownMember(entry.targetUri, entry.content as string, entry.targetPath);
      }
      yield* ensureDirectory(filesTargetDir, false);
      for (const entry of prepared.filter(member => !member.relativePath.endsWith('.md'))) {
        const priorBytes = yield* readFileBytesIfExists(entry.targetPath);
        yield* ensureDirectory(yield* pathDirname(entry.targetPath), false);
        yield* writeFile(
          entry.targetPath,
          entry.content,
          entry.binary ? {mode: 0o600} : {encoding: 'utf8', mode: 0o600},
        );
        rollbacks.push(
          Effect.fn('share.callback')(function* () {
            if (priorBytes !== undefined) {
              yield* writeFile(entry.targetPath, priorBytes, {mode: 0o600});
            } else {
              yield* rm(entry.targetPath, {force: true});
            }
          }),
        );
      }
      yield* ensureDirectory(packRootTargetDir, false);
      const priorManifest = yield* readFileBytesIfExists(manifestTargetPath);
      yield* writeFile(manifestTargetPath, packJson.cleaned, {encoding: 'utf8', mode: 0o600});
      rollbacks.push(
        Effect.fn('share.callback')(function* () {
          if (priorManifest !== undefined) {
            yield* writeFile(manifestTargetPath, priorManifest, {mode: 0o600});
          } else {
            yield* rm(manifestTargetPath, {force: true});
          }
        }),
      );

      // Prune files orphaned by a re-publish (members dropped from the manifest) so
      // stale code is neither carried in the shared repo nor installed by teammates.
      const currentFiles = new Set(prepared.map(entry => `${filesRelative}/${entry.relativePath}`));
      const git = yield* requiredExecutable('git');
      const tracked = yield* runCommand(git, ['-C', team.config.worktree, 'ls-files', '--', filesRelative], {
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
        yield* runCommand(git, ['-C', team.config.worktree, 'rm', '-f', '--ignore-unmatch', '--', stale], {
          allowFailure: true,
        });
        // Nested .md members are OV-ingested, so drop their resource too — keep the
        // native canonical store index and the git tree in lockstep on the publisher's machine.
        // Best-effort: the `git rm` deletion is already staged, so a single OV
        // removal failure must not abort the publish (which would leave a staged
        // deletion behind for a later sync); surface it as a warning instead.
        if (stale.endsWith('.md')) {
          const staleUri = yield* workfileToResourceUri(
            config,
            team.config,
            yield* pathJoin(team.config.worktree, ...stale.split('/')),
          );
          const pruneResult = yield* Effect.result(
            Effect.gen(function* () {
              if (yield* resourceExists(ov, config, staleUri)) {
                yield* removeMemoryUri(config, ov, staleUri, dryRun, {quiet: true});
              }
            }),
          );
          if (Result.isFailure(pruneResult)) {
            const pruneErr = pruneResult.failure;
            messages.push(
              `Warning: could not remove stale native canonical store resource ${staleUri}: ${pruneErr instanceof Error ? pruneErr.message : String(pruneErr)}`,
            );
          }
        }
      }
    }),
  );
  if (Result.isFailure(publishResult)) {
    for (const undo of rollbacks.reverse()) {
      // Best-effort rollback; surface the original failure regardless.
      yield* undo().pipe(Effect.ignore);
    }
    return yield* Effect.fail(publishResult.failure);
  }

  const stagedPaths = [
    indexRelative,
    manifestRelative,
    ...prepared.map(entry => `${filesRelative}/${entry.relativePath}`),
  ];
  const message =
    options.message ?? `share: publish pack ${artifact.agent}/${artifact.name} (${prepared.length} files)`;
  const gitMessages = yield* publishShareGitChange(team.config.worktree, stagedPaths, message, {
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
});

export const runShareInstallArtifacts = Effect.fn('share.runShareInstallArtifacts')(function* (
  config: ShareRuntime,
  options: ShareInstallArtifactsOptions,
) {
  const result = yield* installSharedAgentArtifacts(config, options);
  if (result.syncedTeams.length > 0) {
    yield* Console.log(`Synced shared teams: ${result.syncedTeams.join(', ')}`);
  }
  for (const warning of result.warnings) {
    yield* Console.warn(`Warning: ${warning}`);
  }
  for (const message of result.messages) {
    yield* Console.log(message);
  }
});

export const listSharedAgentArtifacts = Effect.fn('share.listSharedAgentArtifacts')(function* (
  config: ShareRuntime,
  options: ShareListArtifactsOptions = {},
) {
  const syncResult = yield* maybeSyncSharedArtifacts(config, options);
  const team = yield* resolveTeam(config, options.team);
  const artifacts = filterSharedArtifacts(yield* collectSharedArtifacts(team.config.worktree, team.name), options);
  const summaries: SharedArtifactSummary[] = [];
  for (const artifact of artifacts) {
    summaries.push({
      ...artifact,
      installStatus: yield* sharedArtifactInstallStatus(artifact),
      metadataPath: sharedArtifactMetadataPath(artifact),
    });
  }
  return {artifacts: summaries, syncedTeams: syncResult.syncedTeams, team: team.name, warnings: syncResult.warnings};
});

export const installSharedAgentArtifacts = Effect.fn('share.installSharedAgentArtifacts')(function* (
  config: ShareRuntime,
  options: ShareInstallArtifactsOptions,
) {
  const syncResult = yield* maybeSyncSharedArtifacts(config, options);
  const team = yield* resolveTeam(config, options.team);
  const dryRun = options.dryRun === true || options.apply !== true;
  const allArtifacts = yield* collectSharedArtifacts(team.config.worktree, team.name);
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
      installedCount += yield* installBundleArtifact(artifact, options, dryRun, messages);
      continue;
    }
    const label = sharedArtifactLabel(artifact.artifact);
    const state = yield* sharedArtifactInstallState(artifact);
    if (dryRun) {
      const verb = sharedArtifactDryRunVerb(state.status, options.force === true);
      const suffix = sharedArtifactDryRunSuffix(state.status, options.force === true);
      messages.push(`${verb} ${label}: ${yield* portablePath(artifact.installPath)}${suffix}`);
      continue;
    }
    if (
      (state.status === 'local_modified' || state.status === 'remote_changed_and_local_modified') &&
      options.force !== true
    ) {
      throw new Error(
        `Refusing to overwrite ${yield* portablePath(artifact.installPath)}. Pass force=true or --force.`,
      );
    }
    if (state.status === 'current') {
      yield* writeSharedArtifactMetadata(artifact, state.sourceSha);
      messages.push(`Already installed ${label}: ${yield* portablePath(artifact.installPath)}`);
      continue;
    }
    yield* ensureDirectory(yield* pathDirname(artifact.installPath), false);
    yield* writeFile(artifact.installPath, state.sourceContent, {encoding: 'utf8', mode: 0o600});
    yield* writeSharedArtifactMetadata(artifact, state.sourceSha);
    installedCount += 1;
    messages.push(
      `${sharedArtifactInstallVerb(state.status, options.force === true)} ${label}: ${yield* portablePath(artifact.installPath)}`,
    );
  }
  return {
    installedCount,
    messages,
    syncedTeams: syncResult.syncedTeams,
    team: team.name,
    warnings: syncResult.warnings,
  };
});

export const runShareUnpublish = Effect.fn('share.runShareUnpublish')(function* (
  config: ShareRuntime,
  sourceUri: string,
  options: ShareUnpublishOptions,
) {
  assertResourceUri(sourceUri);
  const team = yield* resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  if (!isInTeamNamespace(config, sourceUri, team.name)) {
    throw new Error(`Memory ${sourceUri} is not in team "${team.name}" shared namespace.`);
  }
  const ov = NATIVE_RESOURCE_BACKEND;
  const content = setMemoryVisibility(yield* readMemoryContent(config, ov, sourceUri, dryRun), 'personal');
  const targetUri = personalUriFor(config, sourceUri, team.name);
  if (!dryRun && (yield* resourceExists(ov, config, targetUri))) {
    throw new Error(
      `Refusing to unpublish: a personal memory already exists at ${targetUri}. Move or forget it first, then retry.`,
    );
  }
  yield* writeMemoryFile(config, ov, targetUri, content, 'create', dryRun);

  const worktree = team.config.worktree;
  const relativePath = resourceUriToWorktreeRelative(config, sourceUri, team.name);
  const message = options.message ?? `share: unpublish ${relativePath}`;
  const gitMessages = yield* publishShareGitChange(worktree, relativePath, message, {
    dryRun,
    push: options.push,
    verb: 'rm',
  });
  for (const gitMessage of gitMessages) {
    yield* Console.log(gitMessage);
  }
  const removeResult = yield* Effect.result(removeMemoryUri(config, ov, sourceUri, dryRun));
  if (Result.isFailure(removeResult)) {
    const err = removeResult.failure;
    return yield* Effect.fail(
      new Error(
        `Unpublished ${sourceUri} -> ${targetUri}, but could not remove the shared native canonical store source. Retry cleanup later with: threadnote forget ${sourceUri}\n${err instanceof Error ? err.message : String(err)}`,
        {cause: err},
      ),
    );
  }
  yield* Console.log(`Unpublished ${sourceUri} -> ${targetUri}`);
});

export const runShareList = Effect.fn('share.runShareList')(function* (
  config: ShareRuntime,
  _options: ShareListOptions,
) {
  const teams = yield* readTeamsFile(config);
  const entries = Object.values(teams.teams);
  if (entries.length === 0) {
    yield* Console.log('No shared teams configured. Run: threadnote share init <remote-url>');
    return;
  }
  for (const team of entries) {
    const marker = team.name === teams.defaultTeam ? ' (default)' : '';
    yield* Console.log(`- ${team.name}${marker}`);
    yield* Console.log(`    remote: ${team.remote}`);
    yield* Console.log(`    worktree: ${yield* portablePath(team.worktree)}`);
    yield* Console.log(`    gitdir: ${yield* portablePath(team.gitdir)}`);
    yield* Console.log(`    added: ${team.addedAt}`);
  }
});

export const runShareRename = Effect.fn('share.runShareRename')(function* (
  config: ShareRuntime,
  options: ShareRenameOptions,
) {
  const oldTeam = yield* resolveTeam(config, options.team);
  const newName = normalizeTeamName(options.to);
  if (newName === oldTeam.name) {
    throw new Error(`Team is already named "${newName}".`);
  }
  const dryRun = options.dryRun === true;
  const teamsFile = yield* readTeamsFile(config);
  if (teamsFile.teams[newName]) {
    throw new Error(`Team "${newName}" is already configured.`);
  }

  const newWorktree = yield* teamWorktreePath(config, newName);
  const newGitdir = yield* teamGitdirPath(config, newName);
  yield* assertDestinationAbsent(newWorktree, 'worktree');
  yield* assertDestinationAbsent(newGitdir, 'gitdir');
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
    yield* Console.log(
      `Would rename worktree: ${yield* portablePath(oldTeam.config.worktree)} -> ${yield* portablePath(newWorktree)}`,
    );
    yield* Console.log(
      `Would rename gitdir: ${yield* portablePath(oldTeam.config.gitdir)} -> ${yield* portablePath(newGitdir)}`,
    );
    yield* Console.log(`Would update git core.worktree and the worktree .git pointer for team "${newName}".`);
    yield* Console.log(`Would reindex shared context under team "${newName}" and remove old shared URI tree.`);
    yield* Console.log(`Would write teams file: ${yield* teamsFilePath(config)}`);
    return;
  }

  const git = yield* requiredExecutable('git');
  yield* mkdir(yield* pathDirname(newWorktree), {recursive: true});
  yield* mkdir(yield* pathDirname(newGitdir), {recursive: true});
  // A clone made with --separate-git-dir has a .git file in the worktree that
  // points at the external gitdir. Moving both paths first leaves that pointer
  // aimed at the old location, so `git -C <new-worktree>` can no longer open
  // the repository. Update the gitdir config before moving it, then rewrite
  // the pointer after both renames. Roll back the filesystem pair if any of
  // those steps fail so teams.json never advertises a half-renamed checkout.
  yield* runCommand(git, ['--git-dir', oldTeam.config.gitdir, 'config', 'core.worktree', newWorktree]);
  let movedWorktree = false;
  let movedGitdir = false;
  const renameResult = yield* Effect.result(
    Effect.gen(function* () {
      yield* rename(oldTeam.config.worktree, newWorktree);
      movedWorktree = true;
      yield* rename(oldTeam.config.gitdir, newGitdir);
      movedGitdir = true;
      yield* writeFile(yield* pathJoin(newWorktree, '.git'), `gitdir: ${newGitdir}\n`, 'utf8');
      yield* runCommand(git, ['--git-dir', newGitdir, '--work-tree', newWorktree, 'rev-parse', '--show-toplevel']);
      yield* writeTeamsFile(config, updatedFile);
    }),
  );
  if (Result.isFailure(renameResult)) {
    if (movedGitdir && (yield* exists(newGitdir))) {
      yield* rename(newGitdir, oldTeam.config.gitdir).pipe(Effect.ignore);
    }
    if (movedWorktree && (yield* exists(newWorktree))) {
      yield* writeFile(yield* pathJoin(newWorktree, '.git'), `gitdir: ${oldTeam.config.gitdir}\n`, 'utf8').pipe(
        Effect.ignore,
      );
      yield* rename(newWorktree, oldTeam.config.worktree).pipe(Effect.ignore);
    }
    if (yield* exists(oldTeam.config.gitdir)) {
      yield* runCommand(git, ['--git-dir', oldTeam.config.gitdir, 'config', 'core.worktree', oldTeam.config.worktree], {
        allowFailure: true,
      });
    }
    return yield* Effect.fail(renameResult.failure);
  }
  const ingested = yield* ingestWorktreeFiles(config, updatedTeam, 'replace');
  const ov = NATIVE_RESOURCE_BACKEND;
  yield* removeMemoryUri(
    config,
    ov,
    `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${oldTeam.name}`,
    false,
  );
  yield* Console.log(`Renamed shared team "${oldTeam.name}" -> "${newName}".`);
  yield* Console.log(`Reindexed ${ingested} shared file(s).`);
});

export const runShareSetUrl = Effect.fn('share.runShareSetUrl')(function* (
  config: ShareRuntime,
  remoteUrl: string,
  options: ShareSetUrlOptions,
) {
  if (!remoteUrl.trim()) {
    throw new Error('Provide a git remote URL.');
  }
  const team = yield* resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  const git = yield* requiredExecutable('git');
  if (dryRun) {
    yield* Console.log(
      `Would run: ${formatShellCommand(git, ['-C', team.config.worktree, 'remote', 'set-url', DEFAULT_GIT_REMOTE_NAME, '--', remoteUrl])}`,
    );
    yield* Console.log(
      `Would run: ${formatShellCommand(git, ['-C', team.config.worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME])}`,
    );
    yield* Console.log(`Would write teams file: ${teamsFilePath(config)}`);
    return;
  }
  yield* runCommand(git, ['-C', team.config.worktree, 'remote', 'set-url', DEFAULT_GIT_REMOTE_NAME, '--', remoteUrl]);
  yield* runCommand(git, ['-C', team.config.worktree, 'fetch', DEFAULT_GIT_REMOTE_NAME]);
  const teamsFile = yield* readTeamsFile(config);
  const updatedTeam: ShareTeamConfig = {...team.config, remote: remoteUrl};
  yield* writeTeamsFile(config, {
    ...teamsFile,
    teams: {...teamsFile.teams, [team.name]: updatedTeam},
  });
  yield* Console.log(`Updated shared team "${team.name}" remote: ${remoteUrl}`);
});

export const runShareRemove = Effect.fn('share.runShareRemove')(function* (
  config: ShareRuntime,
  options: ShareRemoveOptions,
) {
  const team = yield* resolveTeam(config, options.team);
  const dryRun = options.dryRun === true;
  if (options.preserveLocal === true) {
    const preserved = yield* preserveSharedMemoriesLocally(config, team.config, dryRun);
    yield* Console.log(
      `${dryRun ? 'Would preserve' : 'Preserved'} ${preserved} shared durable memory file(s) locally.`,
    );
  }
  const teamsFile = yield* readTeamsFile(config);
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
    yield* Console.log(`Would update teams file: ${teamsFilePath(config)}`);
  } else {
    yield* writeTeamsFile(config, updated);
    yield* Console.log(`Removed team "${team.name}" from teams.json.`);
  }
  if (options.keepFiles !== true) {
    yield* removePath(team.config.worktree, 'shared worktree', dryRun);
    yield* removePath(team.config.gitdir, 'shared gitdir', dryRun);
  } else {
    yield* Console.log(
      `Keeping files at ${yield* portablePath(team.config.worktree)} and ${yield* portablePath(team.config.gitdir)}`,
    );
  }
});

const assertDestinationAbsent = Effect.fn('share.assertDestinationAbsent')(function* (path: string, label: string) {
  if (yield* exists(path)) {
    throw new Error(`Cannot rename share: destination ${label} already exists at ${path}.`);
  }
});

const preserveSharedMemoriesLocally = Effect.fn('share.preserveSharedMemoriesLocally')(function* (
  config: ShareRuntime,
  team: ShareTeamConfig,
  dryRun: boolean,
) {
  const ov = NATIVE_RESOURCE_BACKEND;
  const files = yield* walkMemoryFiles(team.worktree);
  let preserved = 0;
  for (const file of files) {
    const rel = (yield* pathRelative(team.worktree, file)).split(yield* pathSeparator).join('/');
    if (!rel.startsWith('durable/')) {
      continue;
    }
    const targetUri = `threadnote://user/${uriSegment(config.user)}/memories/${rel}`;
    const content = yield* readFile(file, 'utf8');
    if (dryRun) {
      yield* Console.log(`Would preserve ${rel} -> ${targetUri}`);
    } else {
      yield* ensurePersonalDirectoryChain(config, ov, parentUri(targetUri));
      yield* writeMemoryFile(config, ov, targetUri, content, 'create', false);
    }
    preserved += 1;
  }
  return preserved;
});

const ensurePersonalDirectoryChain = Effect.fn('share.ensurePersonalDirectoryChain')(function* (
  config: ShareRuntime,
  _ov: string,
  directoryUri: string,
) {
  const store = yield* ResourceStore;
  const prefix = 'threadnote://';
  const parts = directoryUri.startsWith(prefix) ? directoryUri.slice(prefix.length).split('/').filter(Boolean) : [];
  const startIndex = parts[0] === 'user' && parts.length > 2 ? 3 : 1;
  for (let index = startIndex; index <= parts.length; index += 1) {
    const uri = `${prefix}${parts.slice(0, index).join('/')}`;
    yield* store.makeDirectory(resourceStoreLocation(config), uri);
  }
});

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

const teamsFilePath = Effect.fn('share.teamsFilePath')(function* (config: ShareRuntime) {
  return yield* pathJoin(config.agentContextHome, 'share', 'teams.json');
});

const teamWorktreePath = Effect.fn('share.teamWorktreePath')(function* (config: ShareRuntime, team: string) {
  return yield* pathJoin(config.agentContextHome, 'share', 'worktrees', team);
});

const teamGitdirPath = Effect.fn('share.teamGitdirPath')(function* (config: ShareRuntime, team: string) {
  return yield* pathJoin(config.agentContextHome, 'share', 'teams', `${team}.gitdir`);
});

export const readTeamsFile = Effect.fn('share.readTeamsFile')(function* (config: ShareRuntime) {
  const path = yield* teamsFilePath(config);
  const raw = yield* readFileIfExists(path);
  if (!raw) {
    return {teams: {}, version: TEAMS_FILE_VERSION} as ShareTeamsFile;
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
        yield* Console.warn(`Skipping non-object team entry "${name}" in ${path}.`);
        continue;
      }
      const entry = value as Record<string, unknown>;
      if (typeof entry.remote !== 'string' || entry.remote.length === 0) {
        yield* Console.warn(`Skipping team entry "${name}" in ${path}: missing or empty "remote" field.`);
        continue;
      }
      teams[name] = {
        addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : new Date(0).toISOString(),
        gitdir: typeof entry.gitdir === 'string' ? entry.gitdir : yield* teamGitdirPath(config, name),
        name,
        remote: entry.remote,
        worktree: typeof entry.worktree === 'string' ? entry.worktree : yield* teamWorktreePath(config, name),
      };
    }
  }
  const defaultTeam = typeof parsed.defaultTeam === 'string' ? parsed.defaultTeam : undefined;
  return {defaultTeam, teams, version: TEAMS_FILE_VERSION} as ShareTeamsFile;
});

const writeTeamsFile = Effect.fn('share.writeTeamsFile')(function* (config: ShareRuntime, contents: ShareTeamsFile) {
  const path = yield* teamsFilePath(config);
  yield* mkdir(yield* pathDirname(path), {recursive: true});
  const serializable = {
    defaultTeam: contents.defaultTeam,
    teams: contents.teams,
    version: contents.version,
  };
  yield* writeFile(path, `${JSON.stringify(serializable, undefined, 2)}\n`, {encoding: 'utf8', mode: 0o600});
});

export const resolveTeam = Effect.fn('share.resolveTeam')(function* (
  config: ShareRuntime,
  requested: string | undefined,
) {
  const teamsFile = yield* readTeamsFile(config);
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
});

function shouldSetDefault(options: ShareInitOptions, existing: ShareTeamsFile): boolean {
  if (options.setDefault === true) {
    return true;
  }
  return existing.defaultTeam === undefined;
}

const assertWorktreeUsable = Effect.fn('share.assertWorktreeUsable')(function* (worktree: string) {
  if (!(yield* exists(worktree))) {
    return;
  }
  if (!(yield* isDirectory(worktree))) {
    throw new Error(`Cannot use ${worktree} as a worktree: not a directory.`);
  }
  const entries = yield* readdir(worktree);
  if (entries.length > 0) {
    const preview = entries.slice(0, 5).join(', ');
    const suffix = entries.length > 5 ? `, +${entries.length - 5} more` : '';
    throw new Error(
      `Worktree ${worktree} is not empty (contains: ${preview}${suffix}). Move or remove its contents, then retry threadnote share init.`,
    );
  }
});

const ingestWorktreeFiles = Effect.fn('share.ingestWorktreeFiles')(function* (
  config: ShareRuntime,
  team: ShareTeamConfig,
  initialMode: 'create' | 'replace',
) {
  const ov = NATIVE_RESOURCE_BACKEND;
  const files = yield* walkMemoryFiles(team.worktree);
  for (const file of files) {
    const uri = yield* workfileToResourceUri(config, team, file);
    yield* ensureSharedDirectoryChain(config, ov, uri, false);
    yield* ingestSingleFile(ov, config, uri, file, initialMode);
  }
  return files.length;
});

const walkMemoryFiles = Effect.fn('share.walkMemoryFiles')(function* (root: string) {
  const out: string[] = [];
  const visit: (path: string, depth: number) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> =
    Effect.fn('share.visit')(function* (path: string, depth: number) {
      const entriesResult = yield* Effect.result(readdir(path, {withFileTypes: true}));
      if (Result.isFailure(entriesResult)) {
        const err = entriesResult.failure;
        yield* Console.warn(
          `Skipping ${path} during shared-tree walk: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      const entries = entriesResult.success;
      for (const entry of entries) {
        if (entry.name === '.git') {
          continue;
        }
        const full = yield* pathJoin(path, entry.name);
        if (entry.isDirectory()) {
          if (depth === 0 && !SHAREABLE_TOP_LEVEL_DIRS.includes(entry.name)) {
            continue;
          }
          yield* visit(full, depth + 1);
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
    });
  yield* visit(root, 0);
  return out;
});

const workfileToResourceUri = Effect.fn('share.workfileToResourceUri')(function* (
  config: ShareRuntime,
  team: ShareTeamConfig,
  filePath: string,
) {
  const rel = (yield* pathRelative(team.worktree, filePath)).split(yield* pathSeparator).join('/');
  return `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${team.name}/${rel}`;
});

export function isInSharedNamespace(config: ShareRuntime, uri: string): boolean {
  return sharedTeamNameForUri(config, uri) !== undefined;
}

export function sharedTeamNameForUri(config: ShareRuntime, uri: string): string | undefined {
  const canonicalUri = canonicalResourceInput(uri);
  if (!canonicalUri) return undefined;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/`;
  if (!canonicalUri.startsWith(prefix)) {
    return undefined;
  }
  const [team] = canonicalUri.slice(prefix.length).split('/');
  return team || undefined;
}

export function sharedMemoryUriParts(config: ShareRuntime, uri: string): SharedMemoryUriParts | undefined {
  const canonicalUri = canonicalResourceInput(uri);
  if (!canonicalUri) return undefined;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/`;
  if (!canonicalUri.startsWith(prefix)) {
    return undefined;
  }
  const [team, kind, scope, project, ...topicParts] = canonicalUri.slice(prefix.length).split('/');
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
  return (
    canonicalResourceInput(uri)?.startsWith(
      `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${team}/`,
    ) === true
  );
}

export function sharedUriFor(config: ShareRuntime, personalUri: string, team: string): string {
  const canonicalUri = parseResourceId(personalUri).canonicalUri;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/`;
  if (!canonicalUri.startsWith(prefix)) {
    throw new Error(`Refusing to publish memory outside the current user namespace: ${personalUri}`);
  }
  const rest = canonicalUri.slice(prefix.length);
  return `${prefix}${SHARED_SEGMENT}/${team}/${rest}`;
}

function personalUriFor(config: ShareRuntime, sharedUri: string, team: string): string {
  const canonicalUri = parseResourceId(sharedUri).canonicalUri;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${team}/`;
  if (!canonicalUri.startsWith(prefix)) {
    throw new Error(`Refusing to unpublish a URI outside team "${team}" shared namespace: ${sharedUri}`);
  }
  const rest = canonicalUri.slice(prefix.length);
  return `threadnote://user/${uriSegment(config.user)}/memories/${rest}`;
}

export function resourceUriToWorktreeRelative(config: ShareRuntime, uri: string, team: string): string {
  const canonicalUri = parseResourceId(uri).canonicalUri;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/${team}/`;
  if (!canonicalUri.startsWith(prefix)) {
    throw new Error(`URI ${uri} is not inside team "${team}" shared subtree.`);
  }
  return canonicalUri.slice(prefix.length);
}

const isRegularFileNoSymlink = Effect.fn('share.isRegularFileNoSymlink')(function* (path: string) {
  const stat = yield* lstat(path).pipe(Effect.option);
  return Option.isSome(stat) && stat.value.isFile();
});

const inferShareArtifact = Effect.fn('share.inferShareArtifact')(function* (
  path: string,
  options: SharePublishArtifactOptions,
) {
  const normalizedPath = path.split(yield* pathSeparator).join('/');
  const fileName = yield* pathBasename(path);
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
  const inferredName = lowerFileName === 'skill.md' ? yield* pathBasename(yield* pathDirname(path)) : stem;
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
});

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

const collectSharedArtifacts = Effect.fn('share.collectSharedArtifacts')(function* (worktree: string, team: string) {
  const root = yield* pathJoin(worktree, SHAREABLE_ARTIFACT_DIR);
  if (!(yield* isDirectory(root))) {
    return [];
  }
  const out: SharedArtifactFile[] = [];
  const visit: (path: string) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path | SystemInfo> =
    Effect.fn('share.visit')(function* (path: string) {
      const entries = yield* readdir(path, {withFileTypes: true});
      for (const entry of entries) {
        const full = yield* pathJoin(path, entry.name);
        if (entry.isDirectory()) {
          yield* visit(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.md')) {
          continue;
        }
        const relativePath = (yield* pathRelative(worktree, full)).split(yield* pathSeparator).join('/');
        const artifact = sharedArtifactFromRelativePath(relativePath);
        if (artifact === undefined) {
          continue;
        }
        const artifactDir = yield* pathDirname(full);
        // An orphaned pack index without its .pack.json is an incomplete/partial
        // publish; skip it so it neither pollutes the catalog nor breaks discovery.
        if (
          artifact.kind === 'pack' &&
          !(yield* isFile(yield* pathJoin(artifactDir, `${artifact.name}${PACK_MANIFEST_SUFFIX}`)))
        ) {
          yield* Console.warn(
            `Skipping incomplete shared pack (missing ${artifact.name}${PACK_MANIFEST_SUFFIX}): ${relativePath}`,
          );
          continue;
        }
        // Isolate per-artifact discovery failures so one malformed artifact never
        // denies listing/install of the rest of the team's catalog.
        const artifactResult = yield* Effect.result(
          Effect.gen(function* () {
            return {
              artifact,
              installPath: yield* sharedArtifactInstallPath(team, artifact),
              members: yield* collectArtifactMembers(artifact, artifactDir),
              sourcePath: full,
              sourceRelativePath: relativePath,
              team,
            } satisfies SharedArtifactFile;
          }),
        );
        if (Result.isSuccess(artifactResult)) {
          out.push(artifactResult.success);
        } else {
          const err = artifactResult.failure;
          yield* Console.warn(
            `Skipping shared artifact ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });
  yield* visit(root);
  return out.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
});

const collectArtifactMembers = Effect.fn('share.collectArtifactMembers')(function* (
  artifact: ShareArtifactMetadata,
  artifactDir: string,
) {
  if (artifact.kind === 'skill') {
    return yield* collectSharedBundleMembers(artifactDir);
  }
  if (artifact.kind === 'pack') {
    return yield* collectSharedPackMembers(artifact, artifactDir);
  }
  return undefined;
});

// A pack's installable members come from its published .pack.json (the
// authoritative list), so files orphaned in files/ by a removal are not
// installed. Falls back to walking files/ when the manifest is missing.
// A manifest member path must stay within its base directory: the .pack.json /
// bundle manifest is git-carried (not scrubbed), so a malicious or corrupted
// shared repo could otherwise use `..` or an absolute path to read/write outside
// the install root.
const isContainedMemberPath = Effect.fn('share.isContainedMemberPath')(function* (
  baseDir: string,
  relativePath: string,
) {
  if ((yield* pathIsAbsolute(relativePath)) || relativePath.split('/').includes('..')) {
    return false;
  }
  const resolved = yield* pathJoin(baseDir, ...relativePath.split('/'));
  return resolved === baseDir || resolved.startsWith(baseDir + (yield* pathSeparator));
});

const collectSharedPackMembers = Effect.fn('share.collectSharedPackMembers')(function* (
  artifact: ShareArtifactMetadata,
  packDir: string,
) {
  const filesDir = yield* pathJoin(packDir, PACK_FILES_DIR);
  if (!(yield* isDirectory(filesDir))) {
    return [];
  }
  const manifestRaw = yield* readFileIfExists(yield* pathJoin(packDir, `${artifact.name}${PACK_MANIFEST_SUFFIX}`));
  if (manifestRaw !== undefined) {
    const rawMembers = parseJsonConfigObject(manifestRaw)?.members;
    if (Array.isArray(rawMembers)) {
      const fromManifest: BundleMemberFile[] = [];
      for (const entry of rawMembers) {
        const path = (entry as {path?: unknown})?.path;
        if (typeof path === 'string' && path.length > 0) {
          if (!(yield* isContainedMemberPath(filesDir, path))) {
            return yield* Effect.fail(
              new Error(`Refusing pack member with an unsafe path that escapes the pack root: ${path}`),
            );
          }
          fromManifest.push({absolutePath: yield* pathJoin(filesDir, ...path.split('/')), relativePath: path});
        }
      }
      if (fromManifest.length > 0) {
        return fromManifest.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
      }
    }
  }
  return yield* collectBundleMemberFiles(filesDir);
});

// Members of a shared skill directory. Prefers the published manifest as the
// authoritative member list; falls back to walking the directory when it is a
// legacy single-file skill or the manifest is unreadable.
const collectSharedBundleMembers = Effect.fn('share.collectSharedBundleMembers')(function* (skillDir: string) {
  const manifestRaw = yield* readFileIfExists(yield* pathJoin(skillDir, BUNDLE_MANIFEST_FILE));
  if (manifestRaw !== undefined) {
    const parsed = parseJsonConfigObject(manifestRaw);
    const rawMembers = parsed?.members;
    if (Array.isArray(rawMembers)) {
      const fromManifest: BundleMemberFile[] = [];
      for (const entry of rawMembers) {
        const path = (entry as {path?: unknown})?.path;
        if (typeof path === 'string' && path.length > 0) {
          if (!(yield* isContainedMemberPath(skillDir, path))) {
            return yield* Effect.fail(
              new Error(`Refusing skill member with an unsafe path that escapes the skill root: ${path}`),
            );
          }
          fromManifest.push({absolutePath: yield* pathJoin(skillDir, ...path.split('/')), relativePath: path});
        }
      }
      if (fromManifest.length > 0) {
        return fromManifest.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
      }
    }
  }
  return yield* collectBundleMemberFiles(skillDir);
});

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

const maybeSyncSharedArtifacts = Effect.fn('share.maybeSyncSharedArtifacts')(function* (
  config: ShareRuntime,
  options: ShareInstallArtifactsOptions | ShareListArtifactsOptions,
) {
  if (options.sync === false) {
    return {syncedTeams: [], warnings: []};
  }
  return yield* syncSharedReposBeforeAgentRead(config);
});

const sharedArtifactInstallStatus = Effect.fn('share.sharedArtifactInstallStatus')(function* (
  artifact: SharedArtifactFile,
) {
  if (isBundleArtifact(artifact)) {
    return yield* sharedBundleInstallStatus(artifact);
  }
  return (yield* sharedArtifactInstallState(artifact)).status;
});

interface BundleInstallMemberMetadata {
  readonly installedSha256: string;
  readonly sourceSha256: string;
}

const bundleInstallRoot = Effect.fn('share.bundleInstallRoot')(function* (artifact: SharedArtifactFile) {
  // A pack installs as a whole tree, so its installPath is already the root; a
  // skill bundle's installPath is the SKILL.md, so the root is its parent.
  return artifact.artifact.kind === 'pack' ? artifact.installPath : yield* pathDirname(artifact.installPath);
});

const bundleInstallMetadataPath = Effect.fn('share.bundleInstallMetadataPath')(function* (
  artifact: SharedArtifactFile,
) {
  return yield* pathJoin(yield* bundleInstallRoot(artifact), BUNDLE_INSTALL_METADATA_FILE);
});

const readBundleInstallMetadata = Effect.fn('share.readBundleInstallMetadata')(function* (
  artifact: SharedArtifactFile,
) {
  const raw = yield* readFileIfExists(yield* bundleInstallMetadataPath(artifact));
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
});

// Folds per-member 3-way comparison (source vs installed vs recorded) into one
// bundle status. A local edit to one member and an upstream change to a
// different member both surface as remote_changed_and_local_modified so install
// refuses to silently clobber local work.
const sharedBundleInstallStatus = Effect.fn('share.sharedBundleInstallStatus')(function* (
  artifact: SharedArtifactFile,
) {
  const members = artifact.members ?? [];
  const installRoot = yield* bundleInstallRoot(artifact);
  const metadata = yield* readBundleInstallMetadata(artifact);
  // Expected on-disk bytes after the same transform install applies, so the
  // no-metadata fallback can recognize a pristine (token-expanded) install as
  // current instead of misreading it as a local modification.
  const expanded = yield* prepareInstallMembers(members, installRoot, artifact.artifact.kind === 'pack');
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
    const installedBytes = yield* readFileBytesIfExists(
      yield* pathJoin(installRoot, ...member.relativePath.split('/')),
    );
    if (installedBytes === undefined) {
      remoteChanged = true;
      continue;
    }
    installedCount += 1;
    const installedSha = yield* sha256(installedBytes);
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
      const installedBytes = yield* readFileBytesIfExists(yield* pathJoin(installRoot, ...recordedPath.split('/')));
      if (installedBytes !== undefined && (yield* sha256(installedBytes)) !== recorded.installedSha256) {
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
});

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
const prepareInstallMembers = Effect.fn('share.prepareInstallMembers')(function* (
  members: readonly BundleMemberFile[],
  installRoot: string,
  expandTokens: boolean,
) {
  const prepared = yield* Effect.all(
    members.map(
      Effect.fn('share.callback')(function* (member) {
        // A member declared in the manifest but absent from files/ (partial sync /
        // corrupt repo) is skipped rather than crashing the whole list/install.
        const sourceBytes = yield* readFileBytesIfExists(member.absolutePath);
        if (sourceBytes === undefined) {
          return undefined;
        }
        const installedBytes =
          expandTokens && !isProbablyBinary(sourceBytes)
            ? new TextEncoder().encode(expandPackRoot(new TextDecoder().decode(sourceBytes), installRoot))
            : sourceBytes;
        return {
          installedBytes,
          installedSha256: yield* sha256(installedBytes),
          relativePath: member.relativePath,
          sourceSha256: yield* sha256(sourceBytes),
        };
      }),
    ),
  );
  return prepared.filter((member): member is PreparedInstallMember => member !== undefined);
});

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

const installBundleArtifact = Effect.fn('share.installBundleArtifact')(function* (
  artifact: SharedArtifactFile,
  options: ShareInstallArtifactsOptions,
  dryRun: boolean,
  messages: string[],
) {
  const members = artifact.members ?? [];
  const installRoot = yield* bundleInstallRoot(artifact);
  const kindLabel = artifact.artifact.kind === 'pack' ? 'pack' : 'bundle';
  const label = `${sharedArtifactLabel(artifact.artifact)} ${kindLabel} (${members.length} files)`;
  const status = yield* sharedBundleInstallStatus(artifact);
  if (dryRun) {
    const verb = sharedArtifactDryRunVerb(status, options.force === true);
    const suffix = sharedArtifactDryRunSuffix(status, options.force === true);
    messages.push(`${verb} ${label}: ${yield* portablePath(installRoot)}${suffix}`);
    return 0;
  }
  if ((status === 'local_modified' || status === 'remote_changed_and_local_modified') && options.force !== true) {
    throw new Error(`Refusing to overwrite ${yield* portablePath(installRoot)}. Pass force=true or --force.`);
  }
  const prepared = yield* prepareInstallMembers(members, installRoot, artifact.artifact.kind === 'pack');
  // A declared member whose shared source is unreadable (partial sync / corrupt
  // repo) must not silently drop from the install — that would delete the prior
  // installed copy on a routine update. Refuse unless forced.
  if (prepared.length < members.length && options.force !== true) {
    throw new Error(
      `Refusing to install ${yield* portablePath(installRoot)}: ${members.length - prepared.length} declared member(s) are unreadable in the shared pack (the shared worktree may be mid-sync). Retry after sync, or pass force=true / --force.`,
    );
  }
  if (status === 'current') {
    yield* writeFile(yield* bundleInstallMetadataPath(artifact), serializeInstallMetadata(artifact, prepared), {
      mode: 0o600,
    });
    messages.push(`Already installed ${label}: ${yield* portablePath(installRoot)}`);
    yield* surfacePackRequirements(artifact, messages);
    return 0;
  }

  // Materialize into a sibling staging directory, then swap atomically so an
  // interrupted install can never leave a half-written, mixed-version tree.
  const stagingRoot = `${installRoot}.threadnote-staging`;
  yield* rm(stagingRoot, {force: true, recursive: true});
  for (const entry of prepared) {
    const dest = yield* pathJoin(stagingRoot, ...entry.relativePath.split('/'));
    yield* ensureDirectory(yield* pathDirname(dest), false);
    yield* writeFile(dest, entry.installedBytes, {mode: 0o600});
  }
  yield* writeFile(
    yield* pathJoin(stagingRoot, BUNDLE_INSTALL_METADATA_FILE),
    serializeInstallMetadata(artifact, prepared),
    {
      mode: 0o600,
    },
  );
  // Swap via a backup rename so the prior install is never lost: if the final
  // rename fails (or the process dies mid-swap), the old tree is either still in
  // place or recoverable from the backup, never gone with nothing to replace it.
  yield* ensureDirectory(yield* pathDirname(installRoot), false);
  const backupRoot = `${installRoot}.threadnote-old`;
  yield* rm(backupRoot, {force: true, recursive: true});
  const hadPriorInstall = yield* exists(installRoot);
  if (hadPriorInstall) {
    yield* rename(installRoot, backupRoot);
  }
  const swapResult = yield* Effect.result(rename(stagingRoot, installRoot));
  if (Result.isFailure(swapResult)) {
    if (hadPriorInstall) {
      yield* rename(backupRoot, installRoot);
    }
    return yield* Effect.fail(swapResult.failure);
  }
  yield* rm(backupRoot, {force: true, recursive: true});
  messages.push(
    `${sharedArtifactInstallVerb(status, options.force === true)} ${label}: ${yield* portablePath(installRoot)}`,
  );
  yield* surfacePackRequirements(artifact, messages);
  return 1;
});

// Threadnote ships files, not runtimes or MCP servers. After installing a pack,
// surface its declared external dependencies so the teammate knows what they
// must provision before it will actually run.
const surfacePackRequirements = Effect.fn('share.surfacePackRequirements')(function* (
  artifact: SharedArtifactFile,
  messages: string[],
) {
  if (artifact.artifact.kind !== 'pack') {
    return;
  }
  const raw = yield* readFileIfExists(
    yield* pathJoin(yield* pathDirname(artifact.sourcePath), `${artifact.artifact.name}${PACK_MANIFEST_SUFFIX}`),
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
});

const sharedArtifactInstallState = Effect.fn('share.sharedArtifactInstallState')(function* (
  artifact: SharedArtifactFile,
) {
  const sourceContent = yield* readFile(artifact.sourcePath, 'utf8');
  const sourceSha = yield* sha256(sourceContent);
  const existingContent = (yield* readFileIfExists(artifact.installPath)) ?? undefined;
  if (existingContent === undefined) {
    return {sourceContent, sourceSha, status: 'not_installed'} as SharedArtifactInstallState;
  }
  const existingSha = yield* sha256(existingContent);
  const metadata = yield* readSharedArtifactMetadata(artifact);
  if (existingSha === sourceSha) {
    return {
      existingContent,
      existingSha,
      metadata,
      sourceContent,
      sourceSha,
      status: 'current',
    } as SharedArtifactInstallState;
  }
  if (metadata === undefined) {
    return {
      existingContent,
      existingSha,
      sourceContent,
      sourceSha,
      status: 'local_modified',
    } as SharedArtifactInstallState;
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
    } as SharedArtifactInstallState;
  }
  if (remoteChanged) {
    return {
      existingContent,
      existingSha,
      metadata,
      sourceContent,
      sourceSha,
      status: 'update_available',
    } as SharedArtifactInstallState;
  }
  return {
    existingContent,
    existingSha,
    metadata,
    sourceContent,
    sourceSha,
    status: 'local_modified',
  } as SharedArtifactInstallState;
});

const readSharedArtifactMetadata = Effect.fn('share.readSharedArtifactMetadata')(function* (
  artifact: SharedArtifactFile,
) {
  const raw = yield* readFileIfExists(sharedArtifactMetadataPath(artifact));
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
});

const writeSharedArtifactMetadata = Effect.fn('share.writeSharedArtifactMetadata')(function* (
  artifact: SharedArtifactFile,
  sourceSha: string,
) {
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
  yield* ensureDirectory(yield* pathDirname(metadataPath), false);
  yield* writeFile(metadataPath, `${JSON.stringify(metadata, undefined, 2)}\n`, {encoding: 'utf8', mode: 0o600});
});

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

const sharedArtifactInstallPath = Effect.fn('share.sharedArtifactInstallPath')(function* (
  team: string,
  artifact: ShareArtifactMetadata,
) {
  const system = yield* SystemInfo;
  const agentDir = artifact.agent === 'codex' ? '.codex' : '.claude';
  if (artifact.kind === 'pack') {
    // Packs install under a dedicated `threadnote-packs` namespace so a pack and
    // a same-named skill can never share an install root or metadata file. The
    // `threadnote`/`threadnote-packs` segment is Threadnote-controlled, never a
    // user skill name, so the two trees are structurally disjoint.
    return yield* pathJoin(system.homeDirectory, agentDir, 'skills', 'threadnote-packs', team, artifact.name);
  }
  if (artifact.kind === 'skill') {
    return yield* pathJoin(system.homeDirectory, agentDir, 'skills', 'threadnote', team, artifact.name, 'SKILL.md');
  }
  return yield* pathJoin(system.homeDirectory, '.claude', 'commands', 'threadnote', team, `${artifact.name}.md`);
});

const printShareArtifactResult = Effect.fn('share.printShareArtifactResult')(function* (
  result: ShareArtifactResult,
  preview: boolean,
) {
  for (const message of result.messages) {
    yield* Console.log(message);
  }
  for (const gitMessage of result.gitMessages) {
    yield* Console.log(gitMessage);
  }
  if (preview && result.previewContent !== undefined) {
    yield* Console.log('-----BEGIN PREVIEW-----');
    yield* Console.log(result.previewContent);
    yield* Console.log('-----END PREVIEW-----');
  }
});

/**
 * Removes personal lifecycle, candidate, session, evidence, and relation
 * provenance from the header block before a memory is published to a team's
 * shared git repo. Personal threadnote:// URIs do not resolve for teammates, and
 * candidate/session IDs are local workflow state rather than durable knowledge.
 * Defence-in-depth: even if a producer accidentally retains local provenance,
 * it stops here.
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
    if (
      /^(?:archived_from|candidate_id|evidence|references|relation|source_session_id|supersedes):\s/.test(lines[index])
    ) {
      continue;
    }
    cleaned.push(lines[index]);
  }
  for (let index = headerEnd; index < lines.length; index += 1) {
    cleaned.push(lines[index]);
  }
  return cleaned.join('\n');
}

export function setMemoryVisibility(content: string, visibility: 'personal' | 'shared'): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== 'MEMORY' && lines[0]?.trim() !== 'HANDOFF') {
    return content;
  }
  const headerEnd = lines.findIndex(line => line.trim() === '');
  if (headerEnd === -1) {
    return content;
  }
  const visibilityIndex = lines.slice(1, headerEnd).findIndex(line => line.startsWith('visibility:'));
  if (visibilityIndex >= 0) {
    lines[visibilityIndex + 1] = `visibility: ${visibility}`;
    return lines.join('\n');
  }
  let insertionIndex = headerEnd;
  for (let index = 1; index < headerEnd; index += 1) {
    if (/^(?:created_at|timestamp|updated_at):/.test(lines[index] ?? '')) {
      insertionIndex = index + 1;
    }
  }
  lines.splice(insertionIndex, 0, `visibility: ${visibility}`);
  return lines.join('\n');
}

const readMemoryContent = Effect.fn('share.readMemoryContent')(function* (
  config: ShareRuntime,
  _ov: string,
  uri: string,
  dryRun: boolean,
) {
  if (dryRun) {
    yield* Console.log(`Would read native resource: ${uri}`);
    return '<dry-run memory body>';
  }
  const store = yield* ResourceStore;
  const content = yield* store.read(resourceStoreLocation(config), uri);
  if (!content.trim()) {
    throw new Error(`Refusing to publish empty memory at ${uri}`);
  }
  return content;
});

export const ensureSharedDirectoryChain = Effect.fn('share.ensureSharedDirectoryChain')(function* (
  config: ShareRuntime,
  _ov: string,
  memoryUri: string,
  dryRun: boolean,
  options: {readonly quiet?: boolean} = {},
) {
  const directoryUri = parentUri(memoryUri);
  const store = yield* ResourceStore;
  for (const uri of sharedDirectoryChain(config, directoryUri)) {
    if (dryRun) {
      if (options.quiet !== true) {
        yield* Console.log(`Would create native resource directory if missing: ${uri}`);
      }
      continue;
    }
    yield* store.makeDirectory(resourceStoreLocation(config), uri);
  }
});

export function parentUri(uri: string): string {
  const lastSlash = uri.lastIndexOf('/');
  return lastSlash === -1 ? uri : uri.slice(0, lastSlash);
}

export function sharedDirectoryChain(config: ShareRuntime, directoryUri: string): readonly string[] {
  const canonicalUri = parseResourceId(directoryUri).canonicalUri;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/${SHARED_SEGMENT}/`;
  if (!canonicalUri.startsWith(prefix)) {
    return [canonicalUri];
  }
  const parts = canonicalUri.slice(prefix.length).split('/').filter(Boolean);
  const chain: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) {
    chain.push(`${prefix}${parts.slice(0, index).join('/')}`);
  }
  return chain;
}

function canonicalResourceInput(uri: string): string | undefined {
  try {
    return parseResourceId(uri).canonicalUri;
  } catch {
    return undefined;
  }
}

export const writeMemoryFile = Effect.fn('share.writeMemoryFile')(function* (
  config: ShareRuntime,
  _ov: string,
  uri: string,
  content: string,
  initialMode: 'create' | 'replace',
  dryRun: boolean,
  options: {readonly quiet?: boolean} = {},
) {
  if (dryRun) {
    if (options.quiet !== true) {
      yield* Console.log(`Would write native resource: ${uri} --mode ${initialMode}`);
    }
    return;
  }
  const store = yield* ResourceStore;
  yield* store.write(resourceStoreLocation(config), uri, content, {
    mode: initialMode === 'replace' ? 'upsert' : 'create',
  });
});

function resourceStoreLocation(config: ShareRuntime) {
  return {
    account: config.account,
    home: config.agentContextHome,
    user: config.user,
  };
}

const ingestSingleFile = Effect.fn('share.ingestSingleFile')(function* (
  ov: string,
  config: ShareRuntime,
  uri: string,
  filePath: string,
  initialMode: 'create' | 'replace',
  options: {readonly quiet?: boolean} = {},
) {
  const content = yield* readSharedInboundFileContent(uri, filePath);
  yield* writeMemoryFile(config, ov, uri, content, initialMode, false, options);
});

const readSharedInboundFileContent = Effect.fn('share.readSharedInboundFileContent')(function* (
  uri: string,
  filePath: string,
) {
  if (!(yield* isRegularFileNoSymlink(filePath))) {
    return yield* Effect.fail(new Error(`Refusing to ingest non-regular shared file: ${filePath}`));
  }
  return yield* prepareSharedInboundContentEffect(uri, yield* readFile(filePath, 'utf8'));
});

const prepareSharedInboundContentEffect = Effect.fn('share.prepareSharedInboundContent')(function* (
  uri: string,
  rawContent: string,
) {
  return yield* Effect.try({
    catch: error => error,
    try: () => prepareSharedInboundContent(uri, rawContent),
  });
});

function prepareSharedInboundContent(uri: string, rawContent: string): string {
  const stripped = stripPersonalProvenance(canonicalMemoryDocumentContent(rawContent));
  const scrub = applyScrubber(stripped, {redact: false});
  if (scrub.blocker) {
    throw new Error(`Refusing to ingest ${uri}: possible ${scrub.blocker}. Strip the sensitive value upstream first.`);
  }
  return scrub.cleaned;
}

export const removeMemoryUri = Effect.fn('share.removeMemoryUri')(function* (
  config: ShareRuntime,
  _ov: string,
  uri: string,
  dryRun: boolean,
  options: {readonly quiet?: boolean} = {},
) {
  if (dryRun) {
    if (options.quiet !== true) {
      yield* Console.log(`Would remove native resource: ${uri}`);
    }
    return;
  }
  const store = yield* ResourceStore;
  yield* store.remove(resourceStoreLocation(config), uri).pipe(Effect.catchTag('ResourceNotFound', () => Effect.void));
});

export const resourceExists = Effect.fn('share.resourceExists')(function* (
  _ov: string,
  config: ShareRuntime,
  uri: string,
) {
  const store = yield* ResourceStore;
  return yield* store.stat(resourceStoreLocation(config), uri).pipe(
    Effect.as(true),
    Effect.catchTag('ResourceNotFound', () => Effect.succeed(false)),
  );
});

const hasUncommittedChanges = Effect.fn('share.hasUncommittedChanges')(function* (worktree: string) {
  // Read-only check; always run, even in dry-run, so the preamble reflects
  // what a non-dry-run sync would actually have to commit.
  const result = yield* runCommand('git', ['-C', worktree, 'status', '--porcelain'], {allowFailure: true});
  return result.stdout.trim().length > 0;
});

const restoreTrackedSharedChanges = Effect.fn('share.restoreTrackedSharedChanges')(function* (
  git: string,
  worktree: string,
) {
  const pathspecs = yield* existingShareablePathspecs(git, worktree);
  if (pathspecs.length === 0) {
    return [];
  }
  const changed = yield* runCommand(
    git,
    ['-C', worktree, 'diff', '--name-only', '--no-renames', '-z', 'HEAD', '--', ...pathspecs],
    {allowFailure: true},
  );
  if (changed.exitCode !== 0) {
    throw new Error(
      `Could not inspect tracked shared changes in ${worktree}: ${changed.stderr.trim() || changed.stdout.trim() || 'unknown git diff error'}`,
    );
  }
  const relativePaths = [...new Set(changed.stdout.split('\0').filter(Boolean))];
  if (relativePaths.length === 0) {
    return [];
  }
  const restored = yield* runCommand(
    git,
    ['-C', worktree, 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...pathspecs],
    {allowFailure: true},
  );
  if (restored.exitCode !== 0) {
    throw new Error(
      `Could not restore tracked shared changes in ${worktree}: ${restored.stderr.trim() || restored.stdout.trim() || 'unknown git restore error'}`,
    );
  }
  return relativePaths;
});

const SHARE_GIT_OPERATION_MARKERS = [
  'rebase-merge',
  'rebase-apply',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'sequencer',
] as const;

const isShareGitOperationInProgress = Effect.fn('share.isShareGitOperationInProgress')(function* (
  git: string,
  worktree: string,
) {
  const args = ['-C', worktree, 'rev-parse', ...SHARE_GIT_OPERATION_MARKERS.flatMap(marker => ['--git-path', marker])];
  const result = yield* runCommand(git, args, {allowFailure: true});
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new Error(
        `Could not inspect Git operation state in ${worktree}: ${result.stderr.trim() || result.stdout.trim() || 'unknown git rev-parse error'}`,
      ),
    );
  }
  const markerPaths = result.stdout.split(/\r?\n/).filter(Boolean);
  if (markerPaths.length !== SHARE_GIT_OPERATION_MARKERS.length) {
    return yield* Effect.fail(
      new Error(`Could not inspect Git operation state in ${worktree}: git returned incomplete marker paths.`),
    );
  }
  for (const markerPath of markerPaths) {
    const absolutePath = (yield* pathIsAbsolute(markerPath)) ? markerPath : yield* pathJoin(worktree, markerPath);
    if (yield* exists(absolutePath)) {
      return true;
    }
  }
  return false;
});

/** Returns the trimmed stdout of `git -C <worktree> <args>` on success, or `undefined` on dry-run / non-zero exit. */
const gitOutput = Effect.fn('share.gitOutput')(function* (
  worktree: string,
  args: readonly string[],
  dryRun: boolean,
  timeoutMs?: number,
) {
  if (dryRun) {
    return undefined;
  }
  const result = yield* runCommand('git', ['-C', worktree, ...args], {
    allowFailure: true,
    ...(timeoutMs === undefined ? {} : {timeoutMs}),
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.trim();
});

const GIT_MODE_ABSENT = '000000';
// Git records symbolic links as mode 120000.
const GIT_MODE_SYMLINK = '120000';

export const listChangedFiles = Effect.fn('share.listChangedFiles')(function* (
  worktree: string,
  beforeRev: string,
  afterRev: string,
) {
  const result = yield* runCommand('git', ['-C', worktree, 'diff', '--raw', '-z', `${beforeRev}..${afterRev}`], {
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
          path: yield* pathJoin(worktree, oldRel),
          previousRevision: oldMode === GIT_MODE_SYMLINK ? undefined : beforeRev,
          relativePath: oldRel,
          status: 'removed',
        });
      }
      if (newRel && newMode !== GIT_MODE_SYMLINK) {
        changes.push({path: yield* pathJoin(worktree, newRel), relativePath: newRel, status: 'added'});
      }
      index += 2;
      continue;
    }
    const rel = entries[index];
    if (rel) {
      if (head === 'D') {
        changes.push({
          path: yield* pathJoin(worktree, rel),
          previousRevision: oldMode === GIT_MODE_SYMLINK ? undefined : beforeRev,
          relativePath: rel,
          status: 'removed',
        });
      } else if (newMode === GIT_MODE_SYMLINK) {
        if (oldMode !== GIT_MODE_ABSENT) {
          changes.push({
            path: yield* pathJoin(worktree, rel),
            previousRevision: oldMode === GIT_MODE_SYMLINK ? undefined : beforeRev,
            relativePath: rel,
            status: 'removed',
          });
        }
      } else {
        const status = head === 'A' ? 'added' : 'modified';
        changes.push({
          path: yield* pathJoin(worktree, rel),
          previousRevision: oldMode === GIT_MODE_ABSENT || oldMode === GIT_MODE_SYMLINK ? undefined : beforeRev,
          relativePath: rel,
          status,
        });
      }
    }
    index += 1;
  }
  return changes;
});

const gitFileContent = Effect.fn('share.gitFileContent')(function* (
  worktree: string,
  rev: string,
  relativePath: string,
) {
  const result = yield* runCommand('git', ['-C', worktree, 'show', `${rev}:${relativePath}`], {allowFailure: true});
  return result.exitCode === 0 ? result.stdout : undefined;
});

// applyChangesToCanonicalStore only reflects changes to files under shareable
// top-level directories. For renames that cross those directories
// (e.g., handoffs/x.md -> durable/y.md), listChangedFiles emits a
// 'removed' for the old path and an 'added' for the new path; both are
// processed independently here. The 'removed' entry for a non-shareable path
// is filtered out by the firstSegment check, which is the desired outcome
// because non-shareable files are never reflected into the shared subtree.
//
// Per-change failures are non-fatal: we log a warning and continue with the
// other changes, returning the failed list so the caller can re-persist them
// to pendingReindexes for the next sync attempt. A single stuck URI (e.g.,
// a per-resource lock being held longer than our retry window) must not
// cause a whole sync to lose all the other files it could have applied.
const applyChangesToCanonicalStore = Effect.fn('share.applyChangesToCanonicalStore')(function* (
  config: ShareRuntime,
  team: ShareTeamConfig,
  changes: readonly ChangedFile[],
  options: {readonly quiet?: boolean} = {},
) {
  const ov = NATIVE_RESOURCE_BACKEND;
  const failed: ChangedFile[] = [];
  for (const change of changes) {
    if (!isShareableMemoryChange(change)) {
      continue;
    }
    let normalizedChange = change;
    let changeLabel = conflictId(team.name, change.relativePath);
    const applyResult = yield* Effect.result(
      Effect.gen(function* () {
        normalizedChange = yield* normalizePendingChange({config: team, name: team.name}, change);
        const uri = yield* workfileToResourceUri(config, team, normalizedChange.path);
        changeLabel = uri;
        if (normalizedChange.status === 'removed') {
          const currentContent = yield* readExistingMemoryContent(config, ov, uri);
          if (currentContent === undefined) {
            return;
          }
          yield* removeMemoryUri(config, ov, uri, false, options);
          return;
        }
        if (!(yield* isRegularFileNoSymlink(normalizedChange.path))) {
          return;
        }
        // Either 'modified' or 'added' from git's perspective; the file on disk
        // was just rewritten by the pull-rebase and OV's index needs to catch up.
        // Both cases collapse to the same OV-side rule: if the URI already exists,
        // we must write with 'replace' (the create path's retry loop snapshots
        // existedBeforeWrite=true and would burn every attempt against an
        // ALREADY_EXISTS error). 'added' lands here when OV has the URI from an
        // earlier path — a prior share init/sync, or a local publish that wrote
        // the URI before the corresponding upstream commit landed in this clone.
        const content = yield* readSharedInboundFileContent(uri, normalizedChange.path);
        const currentContent = yield* readExistingMemoryContent(config, ov, uri);
        if (currentContent !== undefined) {
          if (
            sharedMemoryContentsEquivalent(currentContent, content) &&
            countManagedMemoryFieldsTrailers(currentContent) <= 1
          ) {
            return;
          }
          if (options.quiet !== true) {
            yield* Console.warn(`share sync: ${uri}: replacing local shared cache content with the remote version.`);
          }
        }
        yield* ensureSharedDirectoryChain(config, ov, uri, false, options);
        const writeMode: 'create' | 'replace' = currentContent !== undefined ? 'replace' : 'create';
        yield* writeMemoryFile(config, ov, uri, content, writeMode, false, options);
      }),
    );
    if (Result.isFailure(applyResult)) {
      const err = applyResult.failure;
      const message = err instanceof Error ? err.message : String(err);
      if (options.quiet !== true) {
        yield* Console.warn(`share sync: ${changeLabel}: ingest failed — will retry on the next sync. ${message}`);
      }
      failed.push(normalizedChange);
    }
  }
  return {failed};
});

const readExistingMemoryContent = Effect.fn('share.readExistingMemoryContent')(function* (
  config: ShareRuntime,
  ov: string,
  uri: string,
) {
  if (!(yield* resourceExistsStrict(ov, config, uri))) {
    return undefined;
  }
  return yield* readMemoryContent(config, ov, uri, false);
});

const resourceExistsStrict = Effect.fn('share.resourceExistsStrict')(function* (
  _ov: string,
  config: ShareRuntime,
  uri: string,
) {
  const store = yield* ResourceStore;
  return yield* store.stat(resourceStoreLocation(config), uri).pipe(
    Effect.as(true),
    Effect.catchTag('ResourceNotFound', () => Effect.succeed(false)),
  );
});

function sharedMemoryContentsEquivalent(left: string, right: string): boolean {
  return normalizeSharedMemoryComparisonContent(left) === normalizeSharedMemoryComparisonContent(right);
}

function normalizeSharedMemoryComparisonContent(content: string): string {
  return canonicalMemoryDocumentContent(content.replace(/\r\n?/g, '\n'));
}

function countManagedMemoryFieldsTrailers(content: string): number {
  return content.match(/<!-- MEMORY_FIELDS\r?\n/g)?.length ?? 0;
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

const applyAndPersistChanges = Effect.fn('share.applyAndPersistChanges')(function* (
  config: ShareRuntime,
  team: ShareTeamConfig,
  state: AutoShareState,
  changes: readonly ChangedFile[],
  options: {readonly quiet?: boolean} = {},
) {
  if (changes.length === 0) {
    return {failed: []};
  }
  // Persist intent BEFORE applying so a crash mid-apply doesn't lose state.
  state.pendingReindexes.set(team.name, changes);
  yield* writePendingReindexes(config, state);
  const result = yield* applyChangesToCanonicalStore(config, team, changes, options);
  if (result.failed.length > 0) {
    const failed = yield* Effect.forEach(result.failed, change =>
      materializePreviousContentForPendingConflict(team.worktree, change),
    );
    state.pendingReindexes.set(team.name, failed);
  } else {
    state.pendingReindexes.delete(team.name);
  }
  yield* writePendingReindexes(config, state);
  return result;
});

const materializePreviousContentForPendingConflict = Effect.fn('share.materializePreviousContentForPendingConflict')(
  function* (worktree: string, change: ChangedFile) {
    if (change.previousContent !== undefined || change.previousRevision === undefined) {
      return change;
    }
    const previousContent = yield* gitFileContent(worktree, change.previousRevision, change.relativePath);
    return previousContent === undefined ? change : {...change, previousContent, previousRevision: undefined};
  },
);
