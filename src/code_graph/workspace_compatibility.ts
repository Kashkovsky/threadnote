import type {CodeGraphWorkspace, CodeGraphWorkspaceProject} from './languages/types.js';
import {compareCodeUnits} from './ordering.js';

export type CodeGraphWorkspaceCompatibility =
  | {readonly mode: 'unchanged'}
  | {readonly mode: 'project-closure'; readonly seedProjectIds: readonly string[]}
  | {readonly mode: 'fallback'; readonly reason: 'workspace-changed'};

/**
 * Narrows a semantic workspace transition to stable project identities. Added
 * or removed project boundaries still fail closed because their old and new
 * ownership sets cannot yet share one bounded closure plan.
 */
export function assessCodeGraphWorkspaceCompatibility(
  base: CodeGraphWorkspace,
  current: CodeGraphWorkspace,
): CodeGraphWorkspaceCompatibility {
  if (base.fingerprint === current.fingerprint) return {mode: 'unchanged'};
  const baseProjects = uniqueProjectsById(base.projects);
  const currentProjects = uniqueProjectsById(current.projects);
  if (
    baseProjects === undefined ||
    currentProjects === undefined ||
    baseProjects.size !== currentProjects.size ||
    [...baseProjects.keys()].some(id => !currentProjects.has(id))
  ) {
    return {mode: 'fallback', reason: 'workspace-changed'};
  }
  const seedProjectIds = [...currentProjects]
    .filter(
      ([id, project]) => projectCompatibilitySurface(baseProjects.get(id)!) !== projectCompatibilitySurface(project),
    )
    .map(([id]) => id)
    .sort(compareCodeUnits);
  return seedProjectIds.length > 0
    ? {mode: 'project-closure', seedProjectIds}
    : {mode: 'fallback', reason: 'workspace-changed'};
}

function uniqueProjectsById(
  projects: readonly CodeGraphWorkspaceProject[],
): ReadonlyMap<string, CodeGraphWorkspaceProject> | undefined {
  const output = new Map<string, CodeGraphWorkspaceProject>();
  for (const project of projects) {
    if (output.has(project.id)) return undefined;
    output.set(project.id, project);
  }
  return output;
}

function projectCompatibilitySurface(project: CodeGraphWorkspaceProject): string {
  return JSON.stringify([
    project.id,
    project.workspaceId,
    project.buildSystem,
    project.kind,
    project.provenance,
    project.name,
    project.root,
    project.resolutionDomain,
    project.dependencies,
    project.dependencyDetails.map(dependency => [
      dependency.targetId,
      dependency.provenance,
      dependency.evidence ?? '',
    ]),
    project.languages,
    project.sourceRoots,
    project.workspaceRoots,
    project.diagnostics,
  ]);
}
