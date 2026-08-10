import {sha256HexSync} from '../crypto/sha256.js';
import type {
  CodeGraphBuildWorkspace,
  CodeGraphWorkspaceBuildSystem,
  CodeGraphWorkspaceComponentKind,
  CodeGraphWorkspaceProject,
  CodeGraphWorkspaceProvenance,
} from './languages/types.js';
import {compareCodeUnits} from './ordering.js';
import type {CodeGraphInventoryFile} from './types.js';

export interface ProjectCandidate {
  readonly aliases: readonly string[];
  readonly buildSystem: CodeGraphWorkspaceBuildSystem;
  readonly dependencyAliases: readonly string[];
  readonly diagnostics: readonly string[];
  readonly evidence?: string;
  /** Optional identity discriminator for multiple typed components at one root. */
  readonly identityKey?: string;
  readonly kind: CodeGraphWorkspaceComponentKind;
  readonly languages: readonly string[];
  readonly name: string;
  readonly provenance: CodeGraphWorkspaceProvenance;
  readonly resolutionDomain: string;
  readonly root: string;
  readonly sourceRoots: readonly string[];
  readonly workspaceRoots: readonly string[];
}

export interface WorkspaceFileIndex {
  readonly buildFileByRoot: ReadonlyMap<string, CodeGraphInventoryFile>;
  readonly fileByPath: ReadonlyMap<string, CodeGraphInventoryFile>;
  readonly sortedPaths: readonly string[];
}

export function basename(path: string): string {
  return path.split('/').at(-1) ?? path;
}

export function dirname(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

export function joinPath(...components: readonly string[]): string {
  return components.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\.\//, '');
}

export function materializeBuildWorkspaces(
  projects: readonly CodeGraphWorkspaceProject[],
  workspaceDiagnostics: readonly string[],
): readonly CodeGraphBuildWorkspace[] {
  const output = new Map<string, CodeGraphBuildWorkspace>();
  for (const project of projects) {
    const root = project.workspaceRoots[0] ?? project.root;
    const existing = output.get(project.workspaceId);
    output.set(project.workspaceId, {
      buildSystem: project.buildSystem,
      diagnostics: unique([...(existing?.diagnostics ?? []), ...project.diagnostics]).sort(compareCodeUnits),
      id: project.workspaceId,
      name: existing?.name ?? root.split('/').at(-1) ?? project.name,
      provenance: existing?.provenance === 'declared' || project.provenance === 'declared' ? 'declared' : 'inferred',
      root,
    });
  }
  const ordered = [...output.values()].sort(
    (left, right) => compareCodeUnits(left.root, right.root) || compareCodeUnits(left.id, right.id),
  );
  if (ordered[0] && workspaceDiagnostics.length > 0) {
    ordered[0] = {
      ...ordered[0],
      diagnostics: unique([...ordered[0].diagnostics, ...workspaceDiagnostics])
        .sort(compareCodeUnits)
        .slice(0, 100),
    };
  }
  return ordered;
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function normalizeContainedPath(root: string, relative: string): string | undefined {
  const output = root ? root.split('/') : [];
  for (const segment of relative.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (output.length === 0) return undefined;
      output.pop();
    } else {
      output.push(segment);
    }
  }
  return output.join('/');
}

export function relativeContainedPath(parent: string, child: string): string | undefined {
  if (parent === '') return child;
  if (child === parent) return '';
  return child.startsWith(`${parent}/`) ? child.slice(parent.length + 1) : undefined;
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function uniqueStrings(values: readonly string[]): string[] {
  return unique(values).sort(compareCodeUnits);
}

export function workspaceIdentity(buildSystem: CodeGraphWorkspaceBuildSystem, root: string): string {
  return `cgw_${sha256HexSync(`workspace-v1\n${buildSystem}\n${root}`).slice(0, 32)}`;
}
