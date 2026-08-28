import {
  platformPathFor,
  runtimeLstat,
  runtimePlatform,
  runtimeReadBoundedStableRegularFile,
  type RuntimeBigIntStats,
} from '../effect/system.js';

export const CODE_GRAPH_GITDIR_BACKLINK_BYTES_LIMIT = 16 * 1_024;

/**
 * Inspect only the bounded `gitdir` backlink inside one matching Git admin entry.
 * `undefined` is fail-closed: the entry, backlink, or their identities were not stable.
 */
export async function observeCodeGraphGitdirBacklinkMatches(
  registryRoot: string,
  adminNameBytes: Uint8Array,
  canonicalWorktreePaths: readonly string[],
): Promise<readonly boolean[] | undefined> {
  try {
    const path = platformPathFor(runtimePlatform);
    const adminName = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(adminNameBytes);
    if (!adminName || path.basename(adminName) !== adminName || adminName === '.' || adminName === '..') {
      return undefined;
    }
    const adminEntry = path.join(registryRoot, adminName);
    if (path.dirname(adminEntry) !== registryRoot) return undefined;
    const entryBefore = await stableDirectory(adminEntry);
    const gitdir = path.join(adminEntry, 'gitdir');
    if (path.dirname(gitdir) !== adminEntry) return undefined;
    const content = await runtimeReadBoundedStableRegularFile(gitdir, CODE_GRAPH_GITDIR_BACKLINK_BYTES_LIMIT);
    const entryAfter = await stableDirectory(adminEntry);
    if (!sameStableDirectory(entryBefore, entryAfter)) return undefined;
    const matches = canonicalWorktreePaths.map(canonicalWorktreePath =>
      codeGraphGitdirBacklinkMatchesCanonicalWorktree(content, canonicalWorktreePath, adminEntry, runtimePlatform),
    );
    return matches.some(match => match === undefined) ? undefined : (matches as readonly boolean[]);
  } catch {
    return undefined;
  }
}

/** Parse Git's LF/CRLF backlink without opening the referenced private path. */
export function codeGraphGitdirBacklinkMatchesCanonicalWorktree(
  content: Uint8Array,
  canonicalWorktreePath: string,
  adminEntry: string,
  platform: NodeJS.Platform,
): boolean | undefined {
  if (content.byteLength === 0 || content.byteLength > CODE_GRAPH_GITDIR_BACKLINK_BYTES_LIMIT) return undefined;
  try {
    const decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(content);
    if (!decoded.endsWith('\n')) return undefined;
    const backlink = decoded.endsWith('\r\n') ? decoded.slice(0, -2) : decoded.slice(0, -1);
    if (!backlink || backlink.includes('\0') || backlink.includes('\r') || backlink.includes('\n')) return undefined;
    const path = platformPathFor(platform);
    if (!path.isAbsolute(canonicalWorktreePath) || !path.isAbsolute(adminEntry)) return undefined;
    const observedPath = path.isAbsolute(backlink) ? path.normalize(backlink) : path.resolve(adminEntry, backlink);
    const observed = comparablePath(observedPath, platform);
    const expected = comparablePath(path.join(canonicalWorktreePath, '.git'), platform);
    return observed === expected;
  } catch {
    return undefined;
  }
}

async function stableDirectory(candidate: string): Promise<RuntimeBigIntStats> {
  const info = await runtimeLstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev === 0n || info.ino === 0n) {
    throw new Error('Git worktree admin entry is not a stable directory.');
  }
  return info;
}

function sameStableDirectory(left: RuntimeBigIntStats, right: RuntimeBigIntStats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function comparablePath(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.normalize('NFC').toLowerCase() : value;
}
