import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import type {CodeGraphWorkspace, CodeGraphWorkspaceProject} from '../../src/code_graph/languages/types.js';
import {assessCodeGraphWorkspaceCompatibility} from '../../src/code_graph/workspace_compatibility.js';

describe('code graph workspace compatibility properties', () => {
  it('seeds only projects whose semantic workspace surface changed', () => {
    fc.assert(
      fc.property(fc.integer({max: 12, min: 2}), fc.nat(), (projectCount, salt) => {
        const projects = Array.from({length: projectCount}, (_, index) => project(index));
        const changedIndex = salt % projectCount;
        const dependencyIndex = (changedIndex + 1) % projectCount;
        const changed = projects.map((value, index) =>
          index === changedIndex
            ? {
                ...value,
                dependencies: [projects[dependencyIndex]!.id],
                dependencyDetails: [
                  {
                    evidence: `${value.root}/BUILD.bazel`,
                    provenance: 'declared' as const,
                    targetId: projects[dependencyIndex]!.id,
                  },
                ],
              }
            : value,
        );

        expect(
          assessCodeGraphWorkspaceCompatibility(workspace('base', projects), workspace('current', changed)),
        ).toEqual({mode: 'project-closure', seedProjectIds: [projects[changedIndex]!.id]});
      }),
      {numRuns: 100},
    );
  });

  it('fails closed when project ownership is added or removed', () => {
    fc.assert(
      fc.property(fc.integer({max: 12, min: 1}), projectCount => {
        const projects = Array.from({length: projectCount}, (_, index) => project(index));
        expect(
          assessCodeGraphWorkspaceCompatibility(workspace('base', projects), workspace('current', projects.slice(1))),
        ).toEqual({mode: 'fallback', reason: 'workspace-changed'});
      }),
      {numRuns: 50},
    );
  });
});

function project(index: number): CodeGraphWorkspaceProject {
  const root = `apps/bazel-${index}`;
  return {
    buildSystem: 'bazel',
    dependencies: [],
    dependencyDetails: [],
    diagnostics: [],
    id: `project-${index}`,
    kind: 'package',
    languages: ['bazel', 'starlark'],
    name: `//app-${index}`,
    provenance: 'declared',
    resolutionDomain: 'bazel',
    root,
    sourceRoots: [root],
    workspaceId: `workspace-${index}`,
    workspaceRoots: [root],
  };
}

function workspace(fingerprint: string, projects: readonly CodeGraphWorkspaceProject[]): CodeGraphWorkspace {
  return {diagnostics: [], fingerprint, projects, workspaces: []};
}
