import {sha256HexSync} from '../crypto/sha256.js';
import {assertSafeShareRelativePath} from '../share/core.js';
import {validatePortableSegment} from '../storage/resource-id.js';
import {remoteMemoryError} from './errors.js';

const GIT_TIMEOUT_MILLISECONDS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const LOCK_WAIT_MILLISECONDS = 10_000;
const LOCK_RETRY_MILLISECONDS = 25;
const COMPOSER_LOCK_NAME = 'threadnote-composer.lock';
const COMPOSER_NAME = 'Threadnote Composer';
const COMPOSER_EMAIL = 'threadnote-composer@invalid';

export interface GitCanonicalMemoryStoreOptions {
  readonly branch?: string;
  readonly push?: boolean;
  readonly remote?: string;
  readonly worktree: string;
}

export interface GitCanonicalCommitInput {
  readonly content: string;
  readonly expectedContentHash?: string;
  readonly message: string;
  readonly path: string;
}

export interface GitCanonicalCommitResult {
  readonly contentHash: string;
  readonly gitCommit: string;
  readonly gitPath: string;
}

export interface GitCanonicalReadInput {
  readonly commit: string;
  readonly path: string;
}

export interface GitCanonicalListedPath {
  readonly blobId: string;
  readonly gitCommit: string;
  readonly gitPath: string;
  readonly kind: 'durable' | 'handoff';
  readonly project: string;
  readonly topic: string;
}

export interface GitCanonicalListedFile extends GitCanonicalListedPath {
  readonly content: string;
  readonly contentHash: string;
}

export function gitCanonicalSharePath(kind: 'durable' | 'handoff', project: string, topic: string): string {
  const projectSegment = validatePortableSegment(project);
  const topicSegment = validatePortableSegment(topic);
  if (kind === 'durable') return `durable/projects/${projectSegment}/${topicSegment}.md`;
  return `handoffs/active/${projectSegment}/${topicSegment}.md`;
}

export function parseGitCanonicalSharePath(
  relativePath: string,
): {readonly kind: 'durable' | 'handoff'; readonly project: string; readonly topic: string} | undefined {
  const segments = relativePath.split('/');
  if (segments.length !== 4 || !segments[3]?.endsWith('.md')) return undefined;
  const topic = segments[3].slice(0, -'.md'.length);
  try {
    const project = validatePortableSegment(segments[2]);
    const parsedTopic = validatePortableSegment(topic);
    if (segments[0] === 'durable' && segments[1] === 'projects') {
      return {kind: 'durable', project, topic: parsedTopic};
    }
    if (segments[0] === 'handoffs' && segments[1] === 'active') {
      return {kind: 'handoff', project, topic: parsedTopic};
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function isAbsoluteGitWorktree(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path);
}

export class GitCanonicalMemoryStore {
  readonly branch: string;
  readonly push: boolean;
  readonly remote: string;
  readonly worktree: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: GitCanonicalMemoryStoreOptions) {
    const worktree = options.worktree.trim();
    if (!worktree || !isAbsoluteGitWorktree(worktree)) {
      throw remoteMemoryError('invalid_request', 'THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE must be an absolute path.');
    }
    this.worktree = worktree.replace(/[\\/]+$/u, '');
    this.branch = requireGitRefName(options.branch?.trim() || 'main', 'THREADNOTE_REMOTE_MEMORY_GIT_BRANCH');
    this.remote = requireGitRefName(options.remote?.trim() || 'origin', 'THREADNOTE_REMOTE_MEMORY_GIT_REMOTE');
    this.push = options.push !== false;
  }

  commit(input: GitCanonicalCommitInput): Promise<GitCanonicalCommitResult> {
    return this.serialize(() => this.commitExclusive(input));
  }

  read(input: GitCanonicalReadInput): Promise<string> {
    return this.serialize(async () => {
      const gitPath = requireSafeGitPath(input.path);
      const commit = requireGitCommit(input.commit);
      const local = await this.git(['show', `${commit}:${gitPath}`], true);
      if (local.exitCode === 0) return local.stdout;
      return this.withLock(async () => {
        await this.refreshExclusive();
        return this.showAtCommit(commit, gitPath);
      });
    });
  }

  listCanonicalPaths(): Promise<readonly GitCanonicalListedPath[]> {
    return this.serialize(() => this.withLock(() => this.listCanonicalPathsExclusive()));
  }

  listBlobIds(commit: string): Promise<ReadonlyMap<string, string>> {
    return this.serialize(() => this.lsTreeBlobsExclusive(requireGitCommit(commit)));
  }

  listCanonicalFiles(): Promise<readonly GitCanonicalListedFile[]> {
    return this.serialize(() =>
      this.withLock(async () => {
        const paths = await this.listCanonicalPathsExclusive();
        const files: GitCanonicalListedFile[] = [];
        for (const path of paths) {
          const content = await this.showAtCommit(path.gitCommit, path.gitPath);
          files.push({...path, content, contentHash: sha256HexSync(content)});
        }
        return files;
      }),
    );
  }

  refresh(): Promise<void> {
    return this.serialize(() => this.withLock(() => this.refreshExclusive()));
  }

  async assertReady(): Promise<void> {
    const version = await runProcess(['git', '--version'], true, 'git');
    if (version.exitCode !== 0) {
      throw remoteMemoryError('service_unavailable', 'git is not available on the composer.');
    }
    const inside = await this.git(['rev-parse', '--is-inside-work-tree'], true);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw remoteMemoryError('service_unavailable', 'THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE is not a git worktree.');
    }
    const writable = await runProcess(['test', '-w', this.worktree], true);
    if (writable.exitCode !== 0) {
      throw remoteMemoryError('service_unavailable', 'THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE is not writable.');
    }
  }

  private serialize<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async commitExclusive(input: GitCanonicalCommitInput): Promise<GitCanonicalCommitResult> {
    const gitPath = requireSafeGitPath(input.path);
    const contentHash = sha256HexSync(input.content);
    return this.withLock(async () => {
      await this.refreshExclusive();
      const currentHash = await this.worktreeFileHash(gitPath);
      if (input.expectedContentHash !== undefined && currentHash !== input.expectedContentHash) {
        throw remoteMemoryError('conflict', 'The shared git memory changed; re-read it and retry.', {
          reason: 'git_cas',
        });
      }
      if (currentHash === contentHash) {
        return {contentHash, gitCommit: await this.headCommit(), gitPath};
      }
      if (input.expectedContentHash === undefined && currentHash !== undefined) {
        throw remoteMemoryError('conflict', 'The shared git memory already exists; re-read it and retry.', {
          reason: 'git_cas',
        });
      }
      await writeContainedWorktreeFile(this.worktree, gitPath, input.content);
      const staged = await this.git(['add', '--', gitPath], true);
      if (staged.exitCode !== 0) {
        throw remoteMemoryError(
          'service_unavailable',
          `git add failed: ${staged.stderr.trim() || staged.stdout.trim() || 'unknown error'}`,
        );
      }
      const committed = await this.git(
        ['-c', `user.name=${COMPOSER_NAME}`, '-c', `user.email=${COMPOSER_EMAIL}`, 'commit', '-m', input.message],
        true,
      );
      if (committed.exitCode !== 0) {
        throw remoteMemoryError(
          'service_unavailable',
          `git commit failed: ${committed.stderr.trim() || committed.stdout.trim() || 'unknown error'}`,
        );
      }
      const gitCommit = await this.headCommit();
      if (!this.push) return {contentHash, gitCommit, gitPath};
      const pushed = await this.git(['push', this.remote, `HEAD:${this.branch}`], true);
      if (pushed.exitCode !== 0) {
        const detail = `${pushed.stderr}\n${pushed.stdout}`.trim();
        const diverged = /non-fast-forward|fetch first|\[rejected\]/i.test(detail);
        if (diverged) {
          await this.reconcileToUpstream();
          throw remoteMemoryError('conflict', 'The shared git memory changed; re-read it and retry.', {
            reason: 'git_push_rejected',
          });
        }
        const fetched = await this.git(['fetch', '--prune', this.remote], true);
        if (fetched.exitCode === 0) {
          const remoteHas = await this.git(
            ['merge-base', '--is-ancestor', gitCommit, `${this.remote}/${this.branch}`],
            true,
          );
          if (remoteHas.exitCode === 0) return {contentHash, gitCommit, gitPath};
        }
        throw remoteMemoryError('service_unavailable', `git push failed: ${detail || 'unknown error'}`);
      }
      return {contentHash, gitCommit, gitPath};
    });
  }

  private async listCanonicalPathsExclusive(): Promise<readonly GitCanonicalListedPath[]> {
    await this.refreshExclusive();
    const gitCommit = await this.headCommit();
    const blobs = await this.lsTreeBlobsExclusive(gitCommit);
    const files: GitCanonicalListedPath[] = [];
    for (const [gitPath, blobId] of blobs) {
      const parsed = parseGitCanonicalSharePath(gitPath);
      if (!parsed) continue;
      files.push({...parsed, blobId, gitCommit, gitPath});
    }
    return files;
  }

  private async lsTreeBlobsExclusive(commit: string): Promise<Map<string, string>> {
    const listed = await this.git(['ls-tree', '-r', '-z', commit], true);
    if (listed.exitCode !== 0) {
      throw remoteMemoryError(
        'service_unavailable',
        `git ls-tree failed: ${listed.stderr.trim() || listed.stdout.trim() || 'unknown error'}`,
      );
    }
    return parseLsTreeBlobs(listed.stdout);
  }

  private async reconcileToUpstream(): Promise<void> {
    const fetched = await this.git(['fetch', '--prune', this.remote], true);
    if (fetched.exitCode !== 0) {
      throw remoteMemoryError(
        'service_unavailable',
        `git fetch failed: ${fetched.stderr.trim() || fetched.stdout.trim() || 'unknown error'}`,
      );
    }
    const reset = await this.git(['reset', '--hard', `${this.remote}/${this.branch}`], true);
    if (reset.exitCode !== 0) {
      throw remoteMemoryError(
        'service_unavailable',
        `git reset failed: ${reset.stderr.trim() || reset.stdout.trim() || 'unknown error'}`,
      );
    }
  }

  private async refreshExclusive(): Promise<void> {
    const fetched = await this.git(['fetch', '--prune', this.remote], true);
    if (fetched.exitCode !== 0) {
      throw remoteMemoryError(
        'service_unavailable',
        `git fetch failed: ${fetched.stderr.trim() || fetched.stdout.trim() || 'unknown error'}`,
      );
    }
    const upstream = `${this.remote}/${this.branch}`;
    const hasUpstream = await this.git(['rev-parse', '--verify', `${upstream}^{commit}`], true);
    if (hasUpstream.exitCode !== 0) return;
    const merged = await this.git(['merge', '--ff-only', upstream], true);
    if (merged.exitCode !== 0) {
      throw remoteMemoryError('conflict', 'The composer git worktree diverged from the memory repository.', {
        reason: 'git_not_fast_forward',
      });
    }
  }

  private async showAtCommit(commit: string, path: string): Promise<string> {
    const gitPath = requireSafeGitPath(path);
    const shown = await this.git(['show', `${requireGitCommit(commit)}:${gitPath}`], true);
    if (shown.exitCode !== 0) {
      throw remoteMemoryError('not_found', 'The git-canonical memory blob was not found.', {
        reason: 'git_missing_blob',
      });
    }
    return shown.stdout;
  }

  private async worktreeFileHash(gitPath: string): Promise<string | undefined> {
    const shown = await this.git(['show', `HEAD:${gitPath}`], true);
    if (shown.exitCode !== 0) return undefined;
    return sha256HexSync(shown.stdout);
  }

  private async headCommit(): Promise<string> {
    const parsed = await this.git(['rev-parse', 'HEAD'], true);
    const commit = parsed.stdout.trim();
    if (parsed.exitCode !== 0 || !/^[0-9a-f]{40,64}$/u.test(commit)) {
      throw remoteMemoryError('service_unavailable', 'The composer git HEAD could not be resolved.');
    }
    return commit;
  }

  private async withLock<A>(operation: () => Promise<A>): Promise<A> {
    const gitDir = await this.absoluteGitDir();
    const lockPath = joinAbsolute(gitDir, COMPOSER_LOCK_NAME);
    await acquireExclusiveLock(lockPath);
    try {
      return await operation();
    } finally {
      await runProcess(['rmdir', lockPath], true);
    }
  }

  private async absoluteGitDir(): Promise<string> {
    const parsed = await this.git(['rev-parse', '--absolute-git-dir'], true);
    const gitDir = parsed.stdout.trim();
    if (parsed.exitCode !== 0 || !gitDir || !isAbsoluteGitWorktree(gitDir)) {
      throw remoteMemoryError('service_unavailable', 'The composer git directory could not be resolved.');
    }
    return gitDir;
  }

  private git(
    args: readonly string[],
    allowFailure = false,
  ): Promise<{readonly exitCode: number; readonly stderr: string; readonly stdout: string}> {
    return runGit(this.worktree, args, allowFailure);
  }
}

async function writeContainedWorktreeFile(worktree: string, relativePath: string, content: string): Promise<void> {
  const safeRelativePath = requireSafeGitPath(relativePath);
  const realWorktree = await realPath(worktree);
  const segments = safeRelativePath.split('/');
  let current = worktree;
  const walked: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    current = joinAbsolute(current, segment);
    walked.push(segment);
    if (await isSymlink(current)) {
      throw remoteMemoryError('invalid_request', 'Refusing to write through a git worktree symbolic link.');
    }
    const created = await runProcess(['mkdir', '-m', '700', current], true);
    if (created.exitCode !== 0 && !(await isDirectory(current))) {
      throw remoteMemoryError('service_unavailable', 'The composer git worktree path could not be created.');
    }
    if ((await realPath(current)) !== joinAbsolute(realWorktree, ...walked)) {
      throw remoteMemoryError('invalid_request', 'Refusing to write through a git worktree path alias.');
    }
  }
  const targetPath = joinAbsolute(worktree, ...segments);
  if (await isSymlink(targetPath)) {
    throw remoteMemoryError('invalid_request', 'Refusing to replace a git worktree symbolic link.');
  }
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await Bun.write(temporaryPath, content);
  const moved = await runProcess(['mv', '-f', temporaryPath, targetPath], true);
  if (moved.exitCode !== 0) {
    await runProcess(['rm', '-f', temporaryPath], true);
    throw remoteMemoryError('service_unavailable', 'The composer git worktree file could not be written.');
  }
}

async function isSymlink(path: string): Promise<boolean> {
  const result = await runProcess(['test', '-L', path], true);
  return result.exitCode === 0;
}

async function isDirectory(path: string): Promise<boolean> {
  const result = await runProcess(['test', '-d', path], true);
  return result.exitCode === 0;
}

async function realPath(path: string): Promise<string> {
  const resolved = await runProcess(['realpath', path], true);
  if (resolved.exitCode !== 0 || !resolved.stdout.trim()) {
    throw remoteMemoryError('service_unavailable', 'The composer git worktree path could not be resolved.');
  }
  return resolved.stdout.trim();
}

async function acquireExclusiveLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MILLISECONDS;
  for (;;) {
    const created = await runProcess(['mkdir', lockPath], true);
    if (created.exitCode === 0) return;
    if (Date.now() >= deadline) {
      throw remoteMemoryError('service_unavailable', 'The composer git worktree is busy.');
    }
    await Bun.sleep(LOCK_RETRY_MILLISECONDS);
  }
}

function parseLsTreeBlobs(stdout: string): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const record of stdout.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(' ');
    const gitPath = record.slice(tab + 1);
    const blobId = meta[2];
    if (meta[1] !== 'blob' || !blobId || !/^[0-9a-f]{40,64}$/u.test(blobId)) continue;
    blobs.set(gitPath, blobId);
  }
  return blobs;
}

function requireGitRefName(value: string, name: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) ||
    value.startsWith('-') ||
    value.includes(':') ||
    value.includes('..')
  ) {
    throw remoteMemoryError('invalid_request', `${name} must be a safe git refname.`);
  }
  return value;
}

function requireSafeGitPath(path: string): string {
  try {
    return assertSafeShareRelativePath(path);
  } catch {
    throw remoteMemoryError('invalid_request', 'The git memory path is outside the share layout.');
  }
}

function requireGitCommit(commit: string): string {
  const value = commit.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(value)) {
    throw remoteMemoryError('invalid_request', 'The git commit pointer is malformed.');
  }
  return value;
}

function joinAbsolute(root: string, ...segments: string[]): string {
  const trimmed = root.replace(/[\\/]+$/u, '');
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  return [trimmed, ...segments].join(separator);
}

function runGit(
  worktree: string,
  args: readonly string[],
  allowFailure: boolean,
): Promise<{readonly exitCode: number; readonly stderr: string; readonly stdout: string}> {
  return runProcess(['git', '-C', worktree, ...args], allowFailure, `git ${args[0] ?? 'command'}`);
}

async function runProcess(
  command: readonly string[],
  allowFailure: boolean,
  label = command[0] ?? 'command',
): Promise<{readonly exitCode: number; readonly stderr: string; readonly stdout: string}> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn({
      cmd: [...command],
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
  } catch {
    throw remoteMemoryError('service_unavailable', `${label} is not available on the composer.`);
  }
  const timeout = setTimeout(() => {
    child.kill();
  }, GIT_TIMEOUT_MILLISECONDS);
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (typeof stdoutStream === 'number' || stdoutStream === undefined) {
    clearTimeout(timeout);
    child.kill();
    throw remoteMemoryError('service_unavailable', `${label} did not expose stdout.`);
  }
  if (typeof stderrStream === 'number' || stderrStream === undefined) {
    clearTimeout(timeout);
    child.kill();
    throw remoteMemoryError('service_unavailable', `${label} did not expose stderr.`);
  }
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedOutput(stdoutStream),
      readBoundedOutput(stderrStream),
      child.exited,
    ]);
    if (!allowFailure && exitCode !== 0) {
      throw remoteMemoryError(
        'service_unavailable',
        `${label} failed: ${(stderr || stdout).trim() || 'unknown error'}`,
      );
    }
    return {exitCode, stderr, stdout};
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const text = await new Response(stream).text();
  if (new TextEncoder().encode(text).byteLength > GIT_MAX_OUTPUT_BYTES) {
    throw remoteMemoryError('service_unavailable', 'Command output exceeded the composer limit.');
  }
  return text;
}
