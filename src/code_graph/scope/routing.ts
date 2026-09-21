import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {readSeedManifest} from '../../manifest.js';
import type {ProjectManifest} from '../../types.js';
import {expandPath} from '../../utils.js';
import {runBinaryCommandEffect} from '../../effect/command.js';
import {resolveRepositoryIdentity} from '../repository.js';

const WORKTREE_LIST_OUTPUT_BYTES_MAXIMUM = 1_048_576;
const WORKTREE_LIST_TIMEOUT_MS = 10_000;
const WORKTREE_ROOT_OUTPUT_BYTES_MAXIMUM = 4_096;

export class CodeGraphScopeRoutingError extends Schema.TaggedError<CodeGraphScopeRoutingError>()(
  'CodeGraphScopeRoutingError',
  {message: Schema.String},
) {}

export type CodeGraphScopeRoute =
  | {readonly project: Pick<ProjectManifest, 'graph' | 'name' | 'uri'>; readonly state: 'selected'}
  | {readonly state: 'full'};

/**
 * Route only a caller that lies in exactly one configured graph project. A
 * root-level caller of a multi-project repository therefore remains explicit
 * rather than silently selecting an arbitrary partial view.
 */
export const resolveCodeGraphScopeRoute = Effect.fn('codeGraph.resolveScopeRoute')(function* (
  manifestPath: string,
  cwd: string,
  explicitProject?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(manifestPath))) return {state: 'full'} as const satisfies CodeGraphScopeRoute;
  const manifest = yield* readSeedManifest(manifestPath).pipe(
    Effect.mapError(() => CodeGraphScopeRoutingError.make({message: 'Configured graph manifest could not be read.'})),
  );
  const path = yield* Path.Path;
  const caller = path.resolve(cwd);
  if (explicitProject !== undefined) {
    const requested = explicitProject.trim().toLowerCase();
    const exactProject = manifest.projects.find(candidate => candidate.name.toLowerCase() === requested);
    const aliasProjects = exactProject === undefined ? graphRootAliasProjects(manifest.projects, requested) : [];
    if (aliasProjects.length > 1) {
      return yield* CodeGraphScopeRoutingError.make({
        message: `Graph root alias "${explicitProject}" belongs to multiple configured projects. Select one of: ${aliasProjects
          .map(project => project.name)
          .sort()
          .join(', ')}.`,
      });
    }
    const project = exactProject ?? aliasProjects[0];
    if (project === undefined) {
      return yield* CodeGraphScopeRoutingError.make({
        message: `No configured project named "${explicitProject}" exists. --project accepts a configured project name or an unambiguous graph root.`,
      });
    }
    const root = yield* expandPath(project.path);
    if (!pathContains(path, root, caller) && !pathContains(path, caller, root)) {
      const [callerIdentity, projectIdentity] = yield* Effect.all([
        resolveRepositoryIdentity(caller),
        resolveRepositoryIdentity(root).pipe(Effect.option),
      ]);
      if (!sameCheckoutRepository(callerIdentity, projectIdentity)) {
        return yield* CodeGraphScopeRoutingError.make({
          message: `Configured project "${project.name}" is outside this cwd. Choose a project in this repository.`,
        });
      }
    }
    return selectedRoute(project);
  }
  const configured = manifest.projects.filter(project => project.graph !== undefined);
  const expanded = yield* Effect.forEach(configured, project =>
    expandPath(project.path).pipe(Effect.map(root => ({project, root}))),
  );
  const localMatches = expanded.filter(candidate => pathContains(path, candidate.root, caller));
  const localGraphRootMatches = localMatches.filter(candidate =>
    candidate.project.graph?.roots.some(root => pathContains(path, path.resolve(candidate.root, root), caller)),
  );
  let matches = (localGraphRootMatches.length > 0 ? localGraphRootMatches : localMatches).map(
    candidate => candidate.project,
  );
  if (matches.length === 0) {
    const worktreeRoots = yield* resolveCheckoutWorktreeRoots(caller).pipe(Effect.option);
    if (Option.isSome(worktreeRoots)) {
      const matchedRoots = new Set(
        expanded
          .filter(candidate => worktreeRoots.value.some(root => pathContains(path, root, candidate.root)))
          .map(candidate => candidate.root),
      );
      const unresolvedRoots = [
        ...new Set(expanded.map(candidate => candidate.root).filter(root => !matchedRoots.has(root))),
      ];
      const resolvedRoots = yield* Effect.forEach(
        unresolvedRoots,
        root =>
          resolveGitWorktreeRoot(root).pipe(
            Effect.map(worktreeRoot => [root, worktreeRoot] as const),
            Effect.option,
          ),
        {concurrency: 4},
      );
      for (const resolved of resolvedRoots) {
        if (Option.isNone(resolved)) continue;
        const [root, worktreeRoot] = resolved.value;
        if (worktreeRoots.value.some(candidate => pathContains(path, candidate, worktreeRoot))) {
          matchedRoots.add(root);
        }
      }
      matches = expanded.filter(candidate => matchedRoots.has(candidate.root)).map(candidate => candidate.project);
    } else {
      const callerIdentity = yield* resolveRepositoryIdentity(caller);
      const roots = [...new Set(expanded.map(candidate => candidate.root))];
      const identities = yield* Effect.forEach(
        roots,
        root =>
          resolveRepositoryIdentity(root).pipe(
            Effect.option,
            Effect.map(identity => [root, identity] as const),
          ),
        {concurrency: 4},
      );
      const byRoot = new Map(identities);
      matches = expanded
        .filter(candidate => sameCheckoutRepository(callerIdentity, byRoot.get(candidate.root) ?? Option.none()))
        .map(candidate => candidate.project);
    }
  }
  if (matches.length === 0) return {state: 'full'} as const satisfies CodeGraphScopeRoute;
  const [project] = matches;
  if (matches.length === 1 && project !== undefined) return selectedRoute(project);
  return yield* CodeGraphScopeRoutingError.make({
    message: `Graph scope is ambiguous for this cwd. Select one of: ${matches
      .map(project => project.name)
      .sort()
      .join(', ')}.`,
  });
});

function sameCheckoutRepository(
  caller: {readonly checkoutId: string; readonly repositoryId: string},
  project: Option.Option<{readonly checkoutId: string; readonly repositoryId: string}>,
): boolean {
  return (
    Option.isSome(project) &&
    project.value.checkoutId === caller.checkoutId &&
    project.value.repositoryId === caller.repositoryId
  );
}

const resolveCheckoutWorktreeRoots = Effect.fn('codeGraph.resolveCheckoutWorktreeRoots')(function* (cwd: string) {
  const path = yield* Path.Path;
  const result = yield* runBinaryCommandEffect('git', ['-C', cwd, 'worktree', 'list', '--porcelain', '-z'], {
    maxOutputBytes: WORKTREE_LIST_OUTPUT_BYTES_MAXIMUM,
    timeoutMs: WORKTREE_LIST_TIMEOUT_MS,
  });
  const roots = parseCheckoutWorktreeRoots(result.stdout);
  if (roots === undefined || roots.some(root => !path.isAbsolute(root))) {
    return yield* CodeGraphScopeRoutingError.make({message: 'Git worktree registry could not be read.'});
  }
  return roots;
});

const resolveGitWorktreeRoot = Effect.fn('codeGraph.resolveGitWorktreeRoot')(function* (cwd: string) {
  const path = yield* Path.Path;
  const result = yield* runBinaryCommandEffect(
    'git',
    ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel'],
    {
      maxOutputBytes: WORKTREE_ROOT_OUTPUT_BYTES_MAXIMUM,
      timeoutMs: WORKTREE_LIST_TIMEOUT_MS,
    },
  );
  const root = parseGitWorktreeRoot(result.stdout);
  if (root === undefined || !path.isAbsolute(root)) {
    return yield* CodeGraphScopeRoutingError.make({message: 'Git worktree root could not be read.'});
  }
  return root;
});

function parseCheckoutWorktreeRoots(output: Uint8Array): readonly string[] | undefined {
  if (output.byteLength === 0 || output.byteLength > WORKTREE_LIST_OUTPUT_BYTES_MAXIMUM) return undefined;
  try {
    const records = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(output).split('\0');
    if (records.pop() !== '') return undefined;
    const roots: string[] = [];
    let expectsWorktree = true;
    for (const record of records) {
      if (record === '') {
        expectsWorktree = true;
      } else if (expectsWorktree) {
        if (!record.startsWith('worktree ') || record.length === 'worktree '.length) return undefined;
        roots.push(record.slice('worktree '.length));
        expectsWorktree = false;
      }
    }
    return roots.length > 0 ? [...new Set(roots)] : undefined;
  } catch {
    return undefined;
  }
}

function parseGitWorktreeRoot(output: Uint8Array): string | undefined {
  if (output.byteLength === 0 || output.byteLength > WORKTREE_ROOT_OUTPUT_BYTES_MAXIMUM) return undefined;
  try {
    const root = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(output);
    return root.endsWith('\n') && !root.slice(0, -1).includes('\n') ? root.slice(0, -1) : undefined;
  } catch {
    return undefined;
  }
}

function pathContains(path: Path.Path, root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function graphRootAliasProjects(projects: readonly ProjectManifest[], requested: string): readonly ProjectManifest[] {
  const normalizedRequested = normalizeGraphRootAlias(requested);
  return projects.filter(project =>
    project.graph?.roots.some(root => {
      const normalizedRoot = normalizeGraphRootAlias(root);
      return normalizedRoot === normalizedRequested || normalizedRoot.split('/').at(-1) === normalizedRequested;
    }),
  );
}

function normalizeGraphRootAlias(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '').toLowerCase();
}

function selectedRoute(
  project: Pick<ProjectManifest, 'graph' | 'name' | 'uri'>,
): Extract<CodeGraphScopeRoute, {state: 'selected'}> {
  return {project, state: 'selected'};
}
