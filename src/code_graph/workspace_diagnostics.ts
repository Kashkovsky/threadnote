import type {CodeGraphWorkspaceProject} from './languages/types.js';
import {uniqueStrings} from './workspace_primitives.js';

export const CODE_GRAPH_WORKSPACE_DIAGNOSTIC_LIMIT = 100;
export const CODE_GRAPH_WORKSPACE_DIAGNOSTIC_OVERFLOW =
  'Workspace discovery omitted unattributed diagnostics after its deterministic bound.';

export interface CodeGraphWorkspaceDiagnosticIndex {
  readonly projectsByPrefix: ReadonlyMap<string, readonly CodeGraphWorkspaceProject[]>;
}

export interface CodeGraphWorkspaceDiagnosticResolution {
  readonly diagnostics: readonly string[];
  readonly projects: readonly CodeGraphWorkspaceProject[];
  readonly projectsByDiagnostic: ReadonlyMap<string, readonly CodeGraphWorkspaceProject[]>;
}

export function createCodeGraphWorkspaceDiagnosticIndex(
  projects: readonly CodeGraphWorkspaceProject[],
): CodeGraphWorkspaceDiagnosticIndex {
  const projectsByPrefix = new Map<string, CodeGraphWorkspaceProject[]>();
  for (const project of projects) {
    for (const prefix of uniqueStrings([project.root, ...project.sourceRoots])) {
      const matches = projectsByPrefix.get(prefix);
      if (matches === undefined) projectsByPrefix.set(prefix, [project]);
      else matches.push(project);
    }
  }
  return {projectsByPrefix};
}

export function codeGraphWorkspaceProjectsForDiagnostic(
  index: CodeGraphWorkspaceDiagnosticIndex,
  diagnostic: string,
): readonly CodeGraphWorkspaceProject[] {
  const evidencePath = codeGraphWorkspaceDiagnosticEvidencePath(diagnostic);
  if (evidencePath === undefined) return [];
  for (let prefix = evidencePath; ;) {
    const matches = index.projectsByPrefix.get(prefix);
    if (matches !== undefined) return matches;
    const separator = prefix.lastIndexOf('/');
    if (separator < 0) return index.projectsByPrefix.get('') ?? [];
    prefix = prefix.slice(0, separator);
  }
}

export function resolveCodeGraphWorkspaceDiagnostics(
  projects: readonly CodeGraphWorkspaceProject[],
  diagnostics: readonly string[],
): CodeGraphWorkspaceDiagnosticResolution {
  const orderedDiagnostics = uniqueStrings(diagnostics);
  const index = createCodeGraphWorkspaceDiagnosticIndex(projects);
  const attributed = new Map<string, string[]>();
  const projectsByDiagnostic = new Map<string, readonly CodeGraphWorkspaceProject[]>();
  for (const diagnostic of orderedDiagnostics) {
    const matches = codeGraphWorkspaceProjectsForDiagnostic(index, diagnostic);
    projectsByDiagnostic.set(diagnostic, matches);
    for (const project of matches) {
      const values = attributed.get(project.id) ?? [];
      values.push(diagnostic);
      attributed.set(project.id, values);
    }
  }
  return {
    diagnostics: orderedDiagnostics,
    projects: projects.map(project => ({
      ...project,
      diagnostics: uniqueStrings([...project.diagnostics, ...(attributed.get(project.id) ?? [])]),
    })),
    projectsByDiagnostic,
  };
}

export function boundedCodeGraphWorkspaceDiagnostics(
  resolution: CodeGraphWorkspaceDiagnosticResolution,
): readonly string[] {
  const retained = resolution.diagnostics.slice(0, CODE_GRAPH_WORKSPACE_DIAGNOSTIC_LIMIT);
  const omittedUnattributed = resolution.diagnostics
    .slice(CODE_GRAPH_WORKSPACE_DIAGNOSTIC_LIMIT)
    .some(diagnostic => resolution.projectsByDiagnostic.get(diagnostic)?.length === 0);
  if (!omittedUnattributed) return retained;
  return uniqueStrings([
    ...retained.slice(0, CODE_GRAPH_WORKSPACE_DIAGNOSTIC_LIMIT - 1),
    CODE_GRAPH_WORKSPACE_DIAGNOSTIC_OVERFLOW,
  ]);
}

function codeGraphWorkspaceDiagnosticEvidencePath(diagnostic: string): string | undefined {
  const separator = diagnostic.indexOf(':');
  if (separator <= 0) return undefined;
  const evidencePath = diagnostic.slice(0, separator);
  if (
    evidencePath.startsWith('/') ||
    evidencePath.includes('\\') ||
    evidencePath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  )
    return undefined;
  return evidencePath;
}
