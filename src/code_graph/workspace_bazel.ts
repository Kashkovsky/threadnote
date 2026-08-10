import {Option} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {
  bazelAttribute,
  bazelLabelPackage,
  canonicalBazelLabel,
  parseBazelSyntax,
  type BazelCall,
} from './languages/bazel/syntax.js';
import type {CodeGraphWorkspace, CodeGraphWorkspaceDependency, CodeGraphWorkspaceProject} from './languages/types.js';
import {compareCodeUnits} from './ordering.js';
import type {CodeGraphInventoryFile} from './types.js';
import {
  basename,
  dirname,
  materializeBuildWorkspaces,
  relativeContainedPath,
  unique,
  workspaceIdentity,
} from './workspace_primitives.js';

interface BazelPackageCandidate {
  readonly dependencyLabels: readonly {readonly evidence: string; readonly label: string}[];
  readonly evidence: string;
  readonly name: string;
  readonly packagePath: string;
  readonly root: string;
  readonly workspaceRoot: string;
}

const BAZEL_WORKSPACE_MARKERS = new Set(['module.bazel', 'workspace', 'workspace.bazel']);
const BAZEL_BUILD_FILES = new Set(['build', 'build.bazel']);
const BAZEL_DEPENDENCY_ATTRIBUTES = new Set([
  'actual',
  'deps',
  'exports',
  'implementation_deps',
  'plugins',
  'runtime_deps',
  'toolchains',
  'tools',
]);

/**
 * Discovers Bazel statically from checked-in Starlark. It deliberately does not invoke Bazel or evaluate macros.
 * Packages from a nested MODULE/WORKSPACE use the nearest marker, while BUILD files without a marker remain
 * integrated into the repository-root Bazel workspace. The resulting Bazel resolution domain can overlap Node,
 * JVM, Swift, and other workspace projects at the same path.
 */
export function discoverBazelWorkspace(files: readonly CodeGraphInventoryFile[]): CodeGraphWorkspace {
  const diagnostics: string[] = [];
  const workspaceMarkers = files
    .filter(file => BAZEL_WORKSPACE_MARKERS.has(basename(file.path).toLowerCase()))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const declaredRoots = new Set(workspaceMarkers.map(file => dirname(file.path)));
  const bazelRcRoots = new Set(
    files.filter(file => basename(file.path).toLowerCase().endsWith('.bazelrc')).map(file => dirname(file.path)),
  );
  const candidates: BazelPackageCandidate[] = files
    .filter(file => BAZEL_BUILD_FILES.has(basename(file.path).toLowerCase()) && file.content !== undefined)
    .sort((left, right) => compareCodeUnits(left.path, right.path))
    .map(file => {
      const root = dirname(file.path);
      const workspaceRoot = nearestBazelWorkspaceRoot(root, declaredRoots, bazelRcRoots);
      const packagePath = relativeContainedPath(workspaceRoot, root) ?? root;
      const syntax = parseBazelSyntax(file.content!);
      if (syntax.bounded) diagnostics.push(`${file.path}: workspace discovery reached its deterministic syntax bound`);
      return {
        dependencyLabels: bazelDependencyLabels(syntax.calls, packagePath, file.path),
        evidence: file.path,
        name: packagePath ? `//${packagePath}` : '//',
        packagePath,
        root,
        workspaceRoot,
      };
    });

  for (const marker of workspaceMarkers) {
    const root = dirname(marker.path);
    if (candidates.some(candidate => candidate.root === root && candidate.workspaceRoot === root)) continue;
    candidates.push({
      dependencyLabels: [],
      evidence: marker.path,
      name: bazelDeclaredWorkspaceName(marker) ?? (root.split('/').at(-1) || 'root'),
      packagePath: '',
      root,
      workspaceRoot: root,
    });
  }
  candidates.sort(
    (left, right) =>
      compareCodeUnits(left.root, right.root) ||
      compareCodeUnits(left.workspaceRoot, right.workspaceRoot) ||
      compareCodeUnits(left.evidence, right.evidence),
  );

  const projectIdByPackage = new Map<string, string>();
  for (const candidate of candidates) {
    projectIdByPackage.set(
      bazelPackageIdentity(candidate.workspaceRoot, candidate.packagePath),
      bazelProjectIdentity(candidate.root),
    );
  }
  const projects = candidates.map(candidate => {
    const id = bazelProjectIdentity(candidate.root);
    const dependencies = new Map<string, CodeGraphWorkspaceDependency>();
    for (const dependency of candidate.dependencyLabels) {
      const parsed = bazelLabelPackage(dependency.label);
      if (Option.isNone(parsed) || parsed.value.external) continue;
      const targetId = projectIdByPackage.get(bazelPackageIdentity(candidate.workspaceRoot, parsed.value.packagePath));
      if (targetId === undefined) {
        diagnostics.push(`${dependency.evidence}: local Bazel package //${parsed.value.packagePath} was not indexed`);
      } else if (targetId !== id) {
        dependencies.set(targetId, {evidence: dependency.evidence, provenance: 'declared', targetId});
      }
    }
    const dependencyDetails = [...dependencies.values()].sort((left, right) =>
      compareCodeUnits(left.targetId, right.targetId),
    );
    return {
      buildSystem: 'bazel',
      dependencies: dependencyDetails.map(dependency => dependency.targetId),
      dependencyDetails,
      diagnostics: [],
      id,
      kind: BAZEL_BUILD_FILES.has(basename(candidate.evidence).toLowerCase()) ? 'package' : 'project',
      languages: ['bazel', 'starlark'],
      name: candidate.name,
      provenance: 'declared',
      resolutionDomain: 'bazel',
      root: candidate.root,
      sourceRoots: [candidate.root],
      workspaceId: workspaceIdentity('bazel', candidate.workspaceRoot),
      workspaceRoots: [candidate.workspaceRoot],
    } satisfies CodeGraphWorkspaceProject;
  });
  const orderedDiagnostics = unique(diagnostics).sort(compareCodeUnits).slice(0, 100);
  const workspaces = materializeBuildWorkspaces(projects, orderedDiagnostics);
  return {
    diagnostics: orderedDiagnostics,
    fingerprint: sha256HexSync(
      JSON.stringify({
        diagnostics: orderedDiagnostics,
        projects: projects.map(project => [
          project.id,
          project.workspaceId,
          project.name,
          project.root,
          project.dependencies,
          project.workspaceRoots,
        ]),
        version: 'bazel-static-workspace-v1',
      }),
    ),
    projects,
    workspaces,
  };
}

function bazelDependencyLabels(
  calls: readonly BazelCall[],
  packagePath: string,
  evidence: string,
): readonly {readonly evidence: string; readonly label: string}[] {
  const output = new Map<string, {readonly evidence: string; readonly label: string}>();
  for (const call of calls) {
    const callee = call.callee.replace(/\s+/gu, '');
    if (callee === 'load') {
      const label = call.strings[0]?.value;
      const canonical = label ? canonicalBazelLabel(label, packagePath) : Option.none();
      if (Option.isSome(canonical)) output.set(canonical.value, {evidence, label: canonical.value});
      continue;
    }
    for (const attribute of call.attributes) {
      if (!BAZEL_DEPENDENCY_ATTRIBUTES.has(attribute.name)) continue;
      for (const literal of attribute.strings) {
        const canonical = canonicalBazelLabel(literal.value, packagePath);
        if (Option.isSome(canonical)) output.set(canonical.value, {evidence, label: canonical.value});
      }
    }
  }
  return [...output.values()].sort((left, right) => compareCodeUnits(left.label, right.label));
}

function bazelDeclaredWorkspaceName(file: CodeGraphInventoryFile): string | undefined {
  if (file.content === undefined) return undefined;
  const expected = basename(file.path).toLowerCase() === 'module.bazel' ? 'module' : 'workspace';
  const declaration = parseBazelSyntax(file.content).calls.find(
    call => call.topLevel && call.callee.replace(/\s+/gu, '') === expected,
  );
  return Option.getOrUndefined(
    Option.flatMap(Option.fromUndefinedOr(declaration), call =>
      Option.flatMap(bazelAttribute(call, 'name'), attribute => Option.fromUndefinedOr(attribute.strings[0]?.value)),
    ),
  );
}

function nearestBazelWorkspaceRoot(
  root: string,
  declaredRoots: ReadonlySet<string>,
  bazelRcRoots: ReadonlySet<string>,
): string {
  let candidate = root;
  for (;;) {
    if (declaredRoots.has(candidate) || bazelRcRoots.has(candidate)) return candidate;
    if (candidate === '') return '';
    const parent = dirname(candidate);
    if (parent === candidate) return '';
    candidate = parent;
  }
}

function bazelPackageIdentity(workspaceRoot: string, packagePath: string): string {
  return `${workspaceRoot}\0${packagePath}`;
}

function bazelProjectIdentity(root: string): string {
  return `cgp_${sha256HexSync(`project-v1\nbazel\n${root}`).slice(0, 32)}`;
}
