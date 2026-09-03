import {Effect, FileSystem, Option, Path} from 'effect';
import {observeRepositoryBranch} from '../code_graph/repository.js';
import {runCommandEffect} from '../effect/command.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {platformPathFor, SystemInfo} from '../effect/system.js';
import type {ProjectManifest} from '../types.js';
import {expandPath, portablePath} from '../utils.js';

const UTF8 = new TextEncoder();
const PATH_BYTES_MAXIMUM = 4_096;

export class ManagerProjectRootError extends Error {
  readonly _tag = 'ManagerProjectRootError' as const;
}

export interface ManagerProjectRootValidation {
  readonly fingerprint: string;
  readonly path: string;
}

export interface ManagerObservedProjectSummary {
  readonly branch?: string;
  readonly branchState: 'current' | 'detached' | 'missing' | 'not-observed';
  readonly folder: string;
  readonly name: string;
  readonly path: string;
}

interface ObservedRoot {
  readonly key: string;
  readonly path: string;
  readonly receipt: string;
}

/**
 * Canonicalize one candidate and reject another manifest project that resolves
 * to the same worktree root. Missing/foreign paths remain byte-preserved.
 */
export const validateManagerProjectRoots = Effect.fn('managerProjectRoots.validate')(function* (
  projects: readonly ProjectManifest[],
  candidate: ProjectManifest,
) {
  return yield* Effect.gen(function* () {
    const candidateRoot = yield* observeRoot(candidate);
    const observed = yield* Effect.forEach(projects, observeCheapRoot, {concurrency: 16});
    const confirmed: ObservedRoot[] = [];
    for (let index = 0; index < observed.length; index += 1) {
      const cheap = observed[index];
      const root = rootsCanCollide(cheap, candidateRoot) ? yield* observeRoot(projects[index]) : cheap;
      confirmed.push(root);
      if (root.key === candidateRoot.key) {
        return yield* Effect.fail(new ManagerProjectRootError('Another manifest project owns this repository root.'));
      }
    }
    return {
      fingerprint: sha256HexSync([...confirmed, candidateRoot].map(root => root.receipt).join('\n')),
      path: candidateRoot.path,
    } satisfies ManagerProjectRootValidation;
  }).pipe(
    Effect.timeoutOrElse({
      duration: 10_000,
      orElse: () => Effect.fail(new ManagerProjectRootError('Project root validation timed out. Retry shortly.')),
    }),
  );
});

export const observeManagerManifestProjects = Effect.fn('managerProjectRoots.observeManifestProjects')(function* (
  projects: readonly ProjectManifest[],
  branchObservationMaximum: number,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  return yield* Effect.forEach(
    projects,
    (project, index) =>
      Effect.gen(function* () {
        if (managerProjectPathIsForeign(project.path, system.platform)) {
          const foreignPath = platformPathFor(system.platform === 'win32' ? 'linux' : 'win32');
          return {
            branchState: 'not-observed' as const,
            folder: foreignPath.basename(project.path) || safeProjectLabel(project.name),
            name: safeProjectLabel(project.name),
            path: safeProjectPath(project.path),
          } satisfies ManagerObservedProjectSummary;
        }
        const localPath = yield* expandPath(project.path);
        const base = {
          folder: path.basename(localPath) || safeProjectLabel(project.name),
          name: safeProjectLabel(project.name),
          path: safeProjectPath(localPath),
        };
        if (index >= branchObservationMaximum) {
          return {...base, branchState: 'not-observed' as const} satisfies ManagerObservedProjectSummary;
        }
        const branch = yield* observeRepositoryBranch(localPath);
        return {
          ...base,
          ...(branch.state === 'current' ? {branch: branch.branch} : {}),
          branchState: branch.state,
        } satisfies ManagerObservedProjectSummary;
      }),
    {concurrency: 16},
  );
});

const observeCheapRoot = Effect.fn('managerProjectRoots.observeCheap')(function* (project: ProjectManifest) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  if (managerProjectPathIsForeign(project.path, system.platform)) return foreignRoot(project.path, system.platform);
  const expanded = yield* expandPath(project.path);
  const info = yield* fs.stat(expanded).pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeed(Option.none()),
    ),
    Effect.mapError(() => new ManagerProjectRootError('A configured project root could not be observed safely.')),
  );
  if (Option.isNone(info)) return yield* missingRoot(fs, path, project.path, expanded, system.platform);
  if (info.value.type !== 'Directory') {
    return yield* Effect.fail(new ManagerProjectRootError('Project path must identify a directory when it exists.'));
  }
  const canonical = yield* fs
    .realPath(expanded)
    .pipe(
      Effect.mapError(() => new ManagerProjectRootError('A configured project root changed while it was observed.')),
    );
  return presentRoot(project.path, canonical, info.value, system.platform);
});

const observeRoot = Effect.fn('managerProjectRoots.observe')(function* (project: ProjectManifest) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const cheap = yield* observeCheapRoot(project);
  if (!cheap.key.startsWith('present:')) return cheap;
  const expanded = yield* expandPath(project.path);
  const result = yield* runCommandEffect(
    'git',
    ['-C', expanded, 'rev-parse', '--path-format=absolute', '--show-toplevel'],
    {allowFailure: true, maxOutputBytes: PATH_BYTES_MAXIMUM, timeoutMs: 5_000},
  ).pipe(Effect.mapError(() => new ManagerProjectRootError('A configured project root could not be observed safely.')));
  if (result.exitCode === 124 || result.exitCode === 127) {
    return yield* Effect.fail(new ManagerProjectRootError('Git could not inspect the configured project root safely.'));
  }
  const rawRoot = result.exitCode === 0 ? result.stdout.replace(/\r?\n$/u, '') : expanded;
  if (
    rawRoot.length === 0 ||
    rawRoot.includes('\n') ||
    rawRoot.includes('\r') ||
    !path.isAbsolute(rawRoot) ||
    UTF8.encode(rawRoot).byteLength > PATH_BYTES_MAXIMUM
  ) {
    return yield* Effect.fail(new ManagerProjectRootError('A configured project root is invalid.'));
  }
  const canonical = yield* fs
    .realPath(rawRoot)
    .pipe(Effect.mapError(() => new ManagerProjectRootError('A configured project root disappeared.')));
  const info = yield* fs
    .stat(canonical)
    .pipe(Effect.mapError(() => new ManagerProjectRootError('A configured project root disappeared.')));
  if (info.type !== 'Directory') {
    return yield* Effect.fail(new ManagerProjectRootError('Project path must identify a repository directory.'));
  }
  const root = presentRoot(project.path, canonical, info, system.platform);
  const storedPath = yield* portablePath(canonical);
  if (!managerProjectStoredPathIsSafe(storedPath)) {
    return yield* Effect.fail(new ManagerProjectRootError('The canonical project root cannot be stored safely.'));
  }
  return {...root, path: storedPath};
});

function rootsCanCollide(left: ObservedRoot, right: ObservedRoot): boolean {
  if (left.key === right.key) return true;
  if (!left.key.startsWith('present:') || !right.key.startsWith('present:')) return false;
  const leftPath = left.key.slice('present:'.length);
  const rightPath = right.key.slice('present:'.length);
  return (
    leftPath.startsWith(`${rightPath}/`) ||
    leftPath.startsWith(`${rightPath}\\`) ||
    rightPath.startsWith(`${leftPath}/`) ||
    rightPath.startsWith(`${leftPath}\\`)
  );
}

function foreignRoot(value: string, platform: NodeJS.Platform): ObservedRoot {
  const foreignPath = platformPathFor(platform === 'win32' ? 'linux' : 'win32');
  const raw = foreignPath.normalize(value);
  const normalized = platform === 'win32' ? raw : raw.toLowerCase();
  return {key: `foreign:${normalized}`, path: value, receipt: `foreign:${normalized}`};
}

const missingRoot = Effect.fn('managerProjectRoots.missing')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  value: string,
  expanded: string,
  platform: NodeJS.Platform,
) {
  let current = expanded;
  const suffix: string[] = [];
  let ancestorInfo: FileSystem.File.Info | undefined;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break;
    const info = yield* fs.stat(current).pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        error => error.reason._tag === 'NotFound',
        () => Effect.succeed(Option.none()),
      ),
      Effect.mapError(() => new ManagerProjectRootError('A configured project ancestor could not be observed safely.')),
    );
    if (Option.isSome(info)) {
      ancestorInfo = info.value;
      break;
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
  if (ancestorInfo === undefined) {
    ancestorInfo = yield* fs
      .stat(current)
      .pipe(
        Effect.mapError(
          () => new ManagerProjectRootError('A configured project ancestor could not be observed safely.'),
        ),
      );
  }
  if (ancestorInfo.type !== 'Directory') {
    return yield* Effect.fail(new ManagerProjectRootError('Project path must identify a directory when it exists.'));
  }
  const realAncestor = yield* fs
    .realPath(current)
    .pipe(
      Effect.mapError(() => new ManagerProjectRootError('A configured project ancestor could not be observed safely.')),
    );
  const canonicalInfo = yield* fs
    .stat(realAncestor)
    .pipe(
      Effect.mapError(
        () => new ManagerProjectRootError('A configured project ancestor changed while it was observed.'),
      ),
    );
  if (canonicalInfo.type !== 'Directory' || fileIdentity(canonicalInfo) !== fileIdentity(ancestorInfo)) {
    return yield* Effect.fail(
      new ManagerProjectRootError('A configured project ancestor changed while it was observed.'),
    );
  }
  const normalized = rootKey(path.join(realAncestor, ...suffix), platform);
  return {
    key: `missing:${normalized}`,
    path: value,
    receipt: `missing:${normalized}:${rootKey(realAncestor, platform)}:${fileIdentity(canonicalInfo)}`,
  } satisfies ObservedRoot;
});

function presentRoot(
  value: string,
  canonical: string,
  info: FileSystem.File.Info,
  platform: NodeJS.Platform,
): ObservedRoot {
  const key = rootKey(canonical, platform);
  return {
    key: `present:${key}`,
    path: value,
    receipt: `present:${key}:${fileIdentity(info)}`,
  };
}

function fileIdentity(info: FileSystem.File.Info): string {
  const inode = Option.getOrUndefined(info.ino);
  return `${String(info.dev)}:${inode === undefined ? 'unknown' : String(inode)}`;
}

function rootKey(value: string, platform: NodeJS.Platform): string {
  const normalized = platformPathFor(platform)
    .normalize(value)
    .replace(/[\\/]+$/u, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function managerProjectPathIsForeign(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? value.startsWith('/')
    : /^[a-z]:[\\/]/iu.test(value) || /^\\\\/u.test(value) || value.startsWith('~\\');
}

function managerProjectStoredPathIsSafe(value: string): boolean {
  if (value.length === 0 || UTF8.encode(value).byteLength > PATH_BYTES_MAXIMUM) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  return true;
}

function safeProjectLabel(value: string): string {
  return (
    value
      .replace(/[\r\n\t\0]/gu, ' ')
      .trim()
      .slice(0, 256) || 'unknown'
  );
}

function safeProjectPath(value: string): string {
  return value
    .replace(/[\r\n\t\0]/gu, ' ')
    .trim()
    .slice(0, PATH_BYTES_MAXIMUM);
}
