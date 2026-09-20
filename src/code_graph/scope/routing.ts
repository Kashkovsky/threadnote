import {Effect, FileSystem, Path, Schema} from 'effect';
import {readSeedManifest} from '../../manifest.js';
import type {ProjectManifest} from '../../types.js';
import {expandPath} from '../../utils.js';

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
  const configured = manifest.projects.filter(project => project.graph !== undefined);
  if (explicitProject !== undefined) {
    const requested = explicitProject.trim().toLowerCase();
    const project = manifest.projects.find(candidate => candidate.name.toLowerCase() === requested);
    if (project === undefined) {
      return yield* CodeGraphScopeRoutingError.make({
        message: `No configured project named "${explicitProject}" exists.`,
      });
    }
    const path = yield* Path.Path;
    const caller = path.resolve(cwd);
    const projectRoot = yield* expandPath(project.path);
    if (!pathContains(path, projectRoot, caller) && !pathContains(path, caller, projectRoot)) {
      return yield* CodeGraphScopeRoutingError.make({
        message: `Configured project "${project.name}" is outside this cwd. Choose a project in this repository.`,
      });
    }
    return selectedRoute(project);
  }
  const path = yield* Path.Path;
  const caller = path.resolve(cwd);
  const containsCaller = yield* Effect.forEach(configured, project =>
    expandPath(project.path).pipe(Effect.map(root => ({project, selected: pathContains(path, root, caller)}))),
  );
  const matches = containsCaller.filter(candidate => candidate.selected).map(candidate => candidate.project);
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

function pathContains(path: Path.Path, root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function selectedRoute(
  project: Pick<ProjectManifest, 'graph' | 'name' | 'uri'>,
): Extract<CodeGraphScopeRoute, {state: 'selected'}> {
  return {project, state: 'selected'};
}
