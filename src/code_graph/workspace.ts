import {Effect, Option} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphReference, CodeGraphSymbol} from './types.js';
import type {
  CodeGraphBuildWorkspace,
  CodeGraphWorkspace,
  CodeGraphWorkspaceBuildSystem,
  CodeGraphWorkspaceComponentKind,
  CodeGraphWorkspaceDependency,
  CodeGraphWorkspaceDetector,
  CodeGraphWorkspaceProject,
  CodeGraphWorkspaceProvenance,
} from './languages/types.js';
import {compareCodeUnits} from './ordering.js';
import {
  bazelAttribute,
  bazelLabelPackage,
  canonicalBazelLabel,
  parseBazelSyntax,
  type BazelCall,
} from './languages/bazel/syntax.js';

interface ProjectCandidate {
  readonly aliases: readonly string[];
  readonly buildSystem: CodeGraphWorkspaceBuildSystem;
  readonly dependencyAliases: readonly string[];
  readonly diagnostics: readonly string[];
  readonly evidence?: string;
  readonly kind: CodeGraphWorkspaceComponentKind;
  readonly languages: readonly string[];
  readonly name: string;
  readonly provenance: CodeGraphWorkspaceProvenance;
  readonly resolutionDomain: string;
  readonly root: string;
  readonly sourceRoots: readonly string[];
  readonly workspaceRoots: readonly string[];
}

interface WorkspaceFileIndex {
  readonly buildFileByRoot: ReadonlyMap<string, CodeGraphInventoryFile>;
  readonly fileByPath: ReadonlyMap<string, CodeGraphInventoryFile>;
  readonly sortedPaths: readonly string[];
}

interface WorkspaceProjectPathIndex {
  readonly projectsByRoot: ReadonlyMap<string, readonly CodeGraphWorkspaceProject[]>;
  readonly projectsBySourceRoot: ReadonlyMap<string, readonly CodeGraphWorkspaceProject[]>;
}

const workspaceProjectPathIndexes = new WeakMap<readonly CodeGraphWorkspaceProject[], WorkspaceProjectPathIndex>();

export const manifestWorkspaceDetector: CodeGraphWorkspaceDetector = {
  contextFiles: [],
  detect: files => Effect.succeed(discoverManifestWorkspace(files)),
};

export function discoverManifestWorkspace(files: readonly CodeGraphInventoryFile[]): CodeGraphWorkspace {
  const diagnostics: string[] = [];
  const fileIndex = createWorkspaceFileIndex(files);
  const candidates = [
    ...discoverNodeProjects(files, diagnostics, fileIndex),
    ...discoverMavenProjects(files, diagnostics, fileIndex),
    ...discoverGradleProjects(files, diagnostics, fileIndex),
    ...discoverSwiftPackageProjects(files, diagnostics),
    ...discoverXcodeProjects(files, diagnostics),
  ];
  addFallbackProjects(files, candidates);
  const projects = materializeProjects(mergeProjectCandidates(candidates), diagnostics);
  diagnoseNxProjectBoundaries(files, projects, diagnostics);
  const orderedDiagnostics = uniqueStrings(diagnostics).slice(0, 100);
  const fingerprint = sha256HexSync(
    [
      'code-graph-workspace-v1',
      ...projects.map(project =>
        [
          project.id,
          project.workspaceId,
          project.buildSystem,
          project.kind,
          project.provenance,
          project.name,
          project.root,
          project.resolutionDomain,
          project.dependencies.join(','),
          project.sourceRoots.join(','),
          project.workspaceRoots.join(','),
          project.diagnostics.join(','),
        ].join('\0'),
      ),
      ...orderedDiagnostics,
    ].join('\n'),
  );
  return {
    diagnostics: orderedDiagnostics,
    fingerprint,
    projects,
    workspaces: materializeBuildWorkspaces(projects, orderedDiagnostics),
  };
}

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
      const dependencyLabels = bazelDependencyLabels(syntax.calls, packagePath, file.path);
      return {
        dependencyLabels,
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
    const name = bazelDeclaredWorkspaceName(marker) ?? (root.split('/').at(-1) || 'root');
    candidates.push({
      dependencyLabels: [],
      evidence: marker.path,
      name,
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

interface NodePackageManifest {
  readonly dependencyAliases: readonly string[];
  readonly file: CodeGraphInventoryFile;
  readonly name: string;
  readonly root: string;
  readonly workspacePatterns: readonly string[];
}

function discoverNodeProjects(
  files: readonly CodeGraphInventoryFile[],
  diagnostics: string[],
  fileIndex: WorkspaceFileIndex,
): readonly ProjectCandidate[] {
  const manifests = files
    .filter(candidate => basename(candidate.path).toLowerCase() === 'package.json' && candidate.content !== undefined)
    .flatMap(file => {
      try {
        const parsed: unknown = JSON.parse(file.content!);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          diagnostics.push(`${file.path}: package manifest is not an object`);
          return [];
        }
        const manifest = parsed as Record<string, unknown>;
        const root = dirname(file.path);
        const name =
          typeof manifest.name === 'string' && manifest.name.trim()
            ? manifest.name.trim()
            : root.split('/').at(-1) || 'root';
        return [
          {
            dependencyAliases: packageDependencyNames(manifest),
            file,
            name,
            root,
            workspacePatterns: packageWorkspacePatterns(manifest),
          } satisfies NodePackageManifest,
        ];
      } catch (cause) {
        diagnostics.push(`${file.path}: invalid package.json (${messageOf(cause)})`);
        return [];
      }
    })
    .sort((left, right) => compareCodeUnits(left.root, right.root));
  const pnpmPatterns = new Map<string, readonly string[]>();
  for (const file of files.filter(candidate => basename(candidate.path).toLowerCase() === 'pnpm-workspace.yaml')) {
    if (file.content !== undefined) pnpmPatterns.set(dirname(file.path), pnpmWorkspacePatterns(file.content));
  }
  const manifestsByRoot = new Map(manifests.map(manifest => [manifest.root, manifest]));
  return manifests.map(manifest => {
    const declaringWorkspaceRoot = nearestNodeWorkspaceRoot(manifest.root, manifestsByRoot, pnpmPatterns);
    const workspaceRoot = declaringWorkspaceRoot ?? manifest.root;
    const tsconfig = fileIndex.fileByPath.get(joinPath(manifest.root, 'tsconfig.json'));
    const referenceRoots = tsconfig?.content ? typescriptReferenceRoots(manifest.root, tsconfig.content) : [];
    const referencedPackageNames = referenceRoots.flatMap(referenceRoot => {
      const target = manifestsByRoot.get(referenceRoot);
      return target ? [target.name] : [];
    });
    return {
      aliases: unique([manifest.name, manifest.root, ...referenceRoots]),
      buildSystem: 'node',
      dependencyAliases: unique([...manifest.dependencyAliases, ...referenceRoots, ...referencedPackageNames]),
      diagnostics: [],
      evidence: manifest.file.path,
      kind: 'package',
      languages: ['javascript', 'typescript'],
      name: manifest.name,
      provenance: 'declared',
      resolutionDomain: 'typescript',
      root: manifest.root,
      sourceRoots: [manifest.root],
      workspaceRoots: [workspaceRoot],
    } satisfies ProjectCandidate;
  });
}

function nearestNodeWorkspaceRoot(
  packageRoot: string,
  manifestsByRoot: ReadonlyMap<string, NodePackageManifest>,
  pnpmPatterns: ReadonlyMap<string, readonly string[]>,
): string | undefined {
  let candidateRoot = dirname(packageRoot);
  while (candidateRoot !== packageRoot) {
    const relative = relativeContainedPath(candidateRoot, packageRoot);
    if (relative !== undefined && relative !== '') {
      const manifestPatterns = manifestsByRoot.get(candidateRoot)?.workspacePatterns ?? [];
      const pnpm = pnpmPatterns.get(candidateRoot) ?? [];
      if (workspacePatternsInclude(manifestPatterns, relative) || workspacePatternsInclude(pnpm, relative)) {
        return candidateRoot;
      }
    }
    if (candidateRoot === '') return undefined;
    const parent = dirname(candidateRoot);
    if (parent === candidateRoot) return undefined;
    candidateRoot = parent;
  }
  return undefined;
}

function packageDependencyNames(manifest: Record<string, unknown>): readonly string[] {
  return unique(
    ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(section => {
      const dependencies = manifest[section];
      return dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)
        ? Object.keys(dependencies)
        : [];
    }),
  ).sort(compareCodeUnits);
}

function packageWorkspacePatterns(manifest: Record<string, unknown>): readonly string[] {
  const workspaces = manifest.workspaces;
  if (Array.isArray(workspaces)) return workspaces.filter((value): value is string => typeof value === 'string');
  if (!workspaces || typeof workspaces !== 'object') return [];
  const packages = (workspaces as Record<string, unknown>).packages;
  return Array.isArray(packages) ? packages.filter((value): value is string => typeof value === 'string') : [];
}

function pnpmWorkspacePatterns(content: string): readonly string[] {
  const patterns: string[] = [];
  let packages = false;
  for (const rawLine of content.split(/\r?\n/)) {
    if (/^\s*packages\s*:/.test(rawLine)) {
      packages = true;
      continue;
    }
    if (packages && /^\S/.test(rawLine)) break;
    if (!packages) continue;
    const match = /^\s*-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(rawLine);
    if (match?.[1]) patterns.push(match[1].trim());
  }
  return unique(patterns).sort(compareCodeUnits);
}

function typescriptReferenceRoots(root: string, content: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(stripJsonCommentsAndTrailingCommas(content));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const references = (parsed as Record<string, unknown>).references;
    if (!Array.isArray(references)) return [];
    return unique(
      references.flatMap(reference => {
        if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return [];
        const value = (reference as Record<string, unknown>).path;
        if (typeof value !== 'string') return [];
        const normalized = normalizeContainedPath(root, value.replace(/(?:\/tsconfig(?:\.json)?)$/i, ''));
        return normalized === undefined ? [] : [normalized];
      }),
    ).sort(compareCodeUnits);
  } catch {
    return [];
  }
}

function workspacePatternsInclude(patterns: readonly string[], relative: string): boolean {
  const included = patterns.some(
    pattern => !pattern.trim().startsWith('!') && workspacePatternMatches(pattern, relative),
  );
  const excluded = patterns.some(pattern => {
    const normalized = pattern.trim();
    return normalized.startsWith('!') && workspacePatternMatches(normalized.slice(1), relative);
  });
  return included && !excluded;
}

function relativeContainedPath(parent: string, child: string): string | undefined {
  if (parent === '') return child;
  if (child === parent) return '';
  return child.startsWith(`${parent}/`) ? child.slice(parent.length + 1) : undefined;
}

function workspacePatternMatches(pattern: string, relative: string): boolean {
  const normalized = pattern.trim().replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized) return false;
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
    .replaceAll('\u0000', '.*');
  return new RegExp(`^${escaped}$`).test(relative);
}

function stripJsonCommentsAndTrailingCommas(content: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    const next = content[index + 1];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    if (character === ',') {
      let lookahead = index + 1;
      while (/\s/.test(content[lookahead] ?? '')) lookahead += 1;
      if (content[lookahead] === '}' || content[lookahead] === ']') continue;
    }
    output += character;
  }
  return output;
}

export function mergeCodeGraphWorkspaces(workspaces: readonly CodeGraphWorkspace[]): CodeGraphWorkspace {
  const projects = new Map<string, CodeGraphWorkspaceProject>();
  const diagnostics: string[] = [];
  for (const workspace of workspaces) {
    for (const inputProject of workspace.projects) {
      const project = normalizeWorkspaceProject(inputProject);
      const existing = projects.get(project.id);
      if (!existing) {
        projects.set(project.id, project);
        continue;
      }
      const preferred = preferredWorkspaceProject(existing, project);
      projects.set(project.id, {
        buildSystem: preferred.buildSystem,
        dependencies: uniqueStrings([...existing.dependencies, ...project.dependencies]),
        dependencyDetails: normalizeWorkspaceDependencies([
          ...existing.dependencyDetails,
          ...project.dependencyDetails,
        ]),
        diagnostics: uniqueStrings([...existing.diagnostics, ...project.diagnostics]),
        id: project.id,
        kind: preferred.kind,
        languages: uniqueStrings([...existing.languages, ...project.languages]),
        name: preferredProjectName(existing.name, project.name),
        provenance: existing.provenance === 'declared' || project.provenance === 'declared' ? 'declared' : 'inferred',
        resolutionDomain: preferred.resolutionDomain,
        root: preferred.root,
        sourceRoots: uniqueStrings([...existing.sourceRoots, ...project.sourceRoots]),
        workspaceId: preferred.workspaceId,
        workspaceRoots: uniqueStrings([...existing.workspaceRoots, ...project.workspaceRoots]),
      });
    }
    diagnostics.push(...workspace.diagnostics);
  }
  const orderedProjects = [...projects.values()].sort(
    (left, right) =>
      compareCodeUnits(left.root, right.root) ||
      compareCodeUnits(left.resolutionDomain, right.resolutionDomain) ||
      compareCodeUnits(left.id, right.id),
  );
  const orderedDiagnostics = uniqueStrings(diagnostics).slice(0, 100);
  const buildWorkspaces = materializeBuildWorkspaces(orderedProjects, orderedDiagnostics);
  return {
    diagnostics: orderedDiagnostics,
    fingerprint: mergedWorkspaceFingerprint(orderedProjects, orderedDiagnostics, buildWorkspaces),
    projects: orderedProjects,
    workspaces: buildWorkspaces,
  };
}

function normalizeWorkspaceProject(project: CodeGraphWorkspaceProject): CodeGraphWorkspaceProject {
  return {
    ...project,
    dependencies: uniqueStrings(project.dependencies),
    dependencyDetails: normalizeWorkspaceDependencies(project.dependencyDetails),
    diagnostics: uniqueStrings(project.diagnostics),
    languages: uniqueStrings(project.languages),
    sourceRoots: uniqueStrings(project.sourceRoots),
    workspaceRoots: uniqueStrings(project.workspaceRoots),
  };
}

function normalizeWorkspaceDependencies(
  dependencies: readonly CodeGraphWorkspaceDependency[],
): readonly CodeGraphWorkspaceDependency[] {
  return uniqueBy(
    dependencies,
    dependency => `${dependency.targetId}\0${dependency.provenance}\0${dependency.evidence ?? ''}`,
  ).sort(
    (left, right) =>
      compareCodeUnits(left.targetId, right.targetId) ||
      compareCodeUnits(left.provenance, right.provenance) ||
      compareCodeUnits(left.evidence ?? '', right.evidence ?? ''),
  );
}

function preferredWorkspaceProject(
  left: CodeGraphWorkspaceProject,
  right: CodeGraphWorkspaceProject,
): CodeGraphWorkspaceProject {
  return compareWorkspaceProjectPrecedence(left, right) <= 0 ? left : right;
}

function compareWorkspaceProjectPrecedence(left: CodeGraphWorkspaceProject, right: CodeGraphWorkspaceProject): number {
  return (
    Number(right.provenance === 'declared') - Number(left.provenance === 'declared') ||
    Number(left.buildSystem === 'inferred') - Number(right.buildSystem === 'inferred') ||
    componentKindRank(left.kind) - componentKindRank(right.kind) ||
    compareCodeUnits(left.kind, right.kind) ||
    compareCodeUnits(left.buildSystem, right.buildSystem) ||
    compareCodeUnits(left.workspaceId, right.workspaceId) ||
    compareCodeUnits(left.resolutionDomain, right.resolutionDomain) ||
    compareCodeUnits(left.root, right.root) ||
    compareCodeUnits(left.name, right.name)
  );
}

function mergedWorkspaceFingerprint(
  projects: readonly CodeGraphWorkspaceProject[],
  diagnostics: readonly string[],
  workspaces: readonly CodeGraphBuildWorkspace[],
): string {
  return sha256HexSync(
    JSON.stringify({
      diagnostics,
      projects: projects.map(project => [
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
      ]),
      version: 'code-graph-workspace-set-v2',
      workspaces: workspaces.map(workspace => [
        workspace.id,
        workspace.buildSystem,
        workspace.provenance,
        workspace.name,
        workspace.root,
        workspace.diagnostics,
      ]),
    }),
  );
}

export function createWorkspaceAttributor(
  workspace: CodeGraphWorkspace,
): (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[] {
  const projectsById = new Map(workspace.projects.map(project => [project.id, project]));
  const findProject = createWorkspaceProjectLookup(workspace.projects);
  return facts =>
    facts.map(file => {
      return {
        ...file,
        references: file.references?.map(reference =>
          Option.match(findProject(file.path, reference.resolutionDomain), {
            onNone: () => reference,
            onSome: project => attributeReference(reference, project, projectsById),
          }),
        ),
        symbols: file.symbols.map(symbol =>
          Option.match(findProject(file.path, symbol.resolutionDomain), {
            onNone: () => symbol,
            onSome: project => attributeSymbol(symbol, project),
          }),
        ),
      };
    });
}

export function projectForPath(
  projects: readonly CodeGraphWorkspaceProject[],
  filePath: string,
  resolutionDomain?: string,
): Option.Option<CodeGraphWorkspaceProject> {
  return createWorkspaceProjectLookup(projects)(filePath, resolutionDomain);
}

export function createWorkspaceProjectLookup(
  projects: readonly CodeGraphWorkspaceProject[],
): (filePath: string, resolutionDomain?: string) => Option.Option<CodeGraphWorkspaceProject> {
  const index = workspaceProjectPathIndexes.get(projects) ?? createWorkspaceProjectPathIndex(projects);
  if (!workspaceProjectPathIndexes.has(projects)) workspaceProjectPathIndexes.set(projects, index);
  return (filePath, resolutionDomain) =>
    Option.fromUndefinedOr(
      nearestPrefixProject(index.projectsBySourceRoot, filePath, resolutionDomain) ??
        nearestPrefixProject(index.projectsByRoot, filePath, resolutionDomain),
    );
}

function discoverMavenProjects(
  files: readonly CodeGraphInventoryFile[],
  diagnostics: string[],
  fileIndex: WorkspaceFileIndex,
): readonly ProjectCandidate[] {
  const output: ProjectCandidate[] = [];
  for (const file of files.filter(candidate => basename(candidate.path) === 'pom.xml')) {
    if (file.content === undefined) continue;
    const root = dirname(file.path);
    const projectXml = file.content.replace(/<parent\b[\s\S]*?<\/parent>/i, '');
    const group = xmlTag(projectXml, 'groupId');
    const artifact = xmlTag(projectXml, 'artifactId') ?? (root.split('/').at(-1) || 'root');
    const name = group ? `${group}:${artifact}` : artifact;
    const moduleRoots = xmlTags(file.content, 'module').flatMap(module => {
      const normalized = normalizeContainedPath(root, module);
      return normalized === undefined ? [] : [normalized];
    });
    const dependencies = [...file.content.matchAll(/<dependency\b[\s\S]*?<\/dependency>/gi)].flatMap(match => {
      const dependencyGroup = xmlTag(match[0], 'groupId');
      const dependencyArtifact = xmlTag(match[0], 'artifactId');
      return dependencyArtifact
        ? [dependencyGroup ? `${dependencyGroup}:${dependencyArtifact}` : dependencyArtifact]
        : [];
    });
    output.push({
      aliases: [name, artifact, root],
      buildSystem: 'maven',
      dependencyAliases: dependencies,
      diagnostics: [],
      evidence: file.path,
      kind: 'module',
      languages: ['java', 'kotlin'],
      name,
      provenance: 'declared',
      resolutionDomain: 'jvm',
      root,
      sourceRoots: conventionalJvmSourceRoots(root),
      workspaceRoots: [root],
    });
    for (const moduleRoot of moduleRoots) {
      if (!fileIndex.fileByPath.has(joinPath(moduleRoot, 'pom.xml'))) {
        diagnostics.push(`${file.path}: declared Maven module ${moduleRoot} has no indexed pom.xml`);
      }
    }
  }
  return output;
}

function discoverGradleProjects(
  files: readonly CodeGraphInventoryFile[],
  diagnostics: string[],
  fileIndex: WorkspaceFileIndex,
): readonly ProjectCandidate[] {
  const output: ProjectCandidate[] = [];
  const settingsFiles = files
    .filter(candidate => /^(?:settings\.gradle(?:\.kts)?)$/i.test(basename(candidate.path)))
    .filter(file => file.content !== undefined);
  const coveredBuildRoots = new Set<string>();
  for (const settings of settingsFiles) {
    const workspaceRoot = dirname(settings.path);
    const rootName =
      /\brootProject\.name\s*=\s*["']([^"']+)["']/.exec(settings.content!)?.[1] ??
      (workspaceRoot.split('/').at(-1) || 'root');
    const projectDirectories = gradleProjectDirectories(settings.content!, workspaceRoot);
    const includedModules = gradleIncludes(settings.content!);
    const modules = ['', ...includedModules];
    for (const modulePath of modules) {
      const gradlePath = modulePath ? `:${modulePath.split('/').join(':')}` : ':';
      const root = projectDirectories.get(gradlePath) ?? joinPath(workspaceRoot, modulePath);
      coveredBuildRoots.add(root);
      const buildFile = fileIndex.buildFileByRoot.get(root);
      const dependencyAliases = buildFile?.content ? gradleProjectDependencies(buildFile.content) : [];
      const moduleName = modulePath.split('/').at(-1) || rootName;
      output.push({
        aliases: [gradlePath, moduleName, root],
        buildSystem: 'gradle',
        dependencyAliases,
        diagnostics: [],
        evidence: settings.path,
        kind: modulePath ? 'module' : 'project',
        languages: ['java', 'kotlin'],
        name: moduleName,
        provenance: 'declared',
        resolutionDomain: 'jvm',
        root,
        sourceRoots: conventionalJvmSourceRoots(root),
        workspaceRoots: [workspaceRoot],
      });
    }
    for (const modulePath of includedModules) {
      const root = projectDirectories.get(`:${modulePath.split('/').join(':')}`) ?? joinPath(workspaceRoot, modulePath);
      if (!hasIndexedPathWithin(fileIndex.sortedPaths, root)) {
        diagnostics.push(`${settings.path}: declared Gradle project ${modulePath} has no indexed files`);
      }
    }
  }
  for (const buildFile of files.filter(candidate => /^build\.gradle(?:\.kts)?$/i.test(basename(candidate.path)))) {
    const root = dirname(buildFile.path);
    if (coveredBuildRoots.has(root)) continue;
    output.push({
      aliases: [root, root.split('/').at(-1) || 'root'],
      buildSystem: 'gradle',
      dependencyAliases: buildFile.content ? gradleProjectDependencies(buildFile.content) : [],
      diagnostics: [],
      evidence: buildFile.path,
      kind: 'project',
      languages: ['java', 'kotlin'],
      name: root.split('/').at(-1) || 'root',
      provenance: 'declared',
      resolutionDomain: 'jvm',
      root,
      sourceRoots: conventionalJvmSourceRoots(root),
      workspaceRoots: [root],
    });
  }
  return output;
}

function discoverSwiftPackageProjects(
  files: readonly CodeGraphInventoryFile[],
  diagnostics: string[],
): readonly ProjectCandidate[] {
  const output: ProjectCandidate[] = [];
  for (const file of files.filter(candidate => basename(candidate.path).toLowerCase() === 'package.swift')) {
    if (file.content === undefined) continue;
    const packageRoot = dirname(file.path);
    const packageName =
      /\bPackage\s*\(\s*name\s*:\s*"([^"]+)"/m.exec(file.content)?.[1] ?? (packageRoot.split('/').at(-1) || 'Package');
    const targets = swiftTargets(file.content);
    if (targets.length === 0) {
      output.push({
        aliases: [packageName, packageRoot],
        buildSystem: 'swiftpm',
        dependencyAliases: [],
        diagnostics: [`${file.path}: targets could not be proven statically`],
        evidence: file.path,
        kind: 'package',
        languages: ['swift'],
        name: packageName,
        provenance: 'declared',
        resolutionDomain: 'swift',
        root: packageRoot,
        sourceRoots: [joinPath(packageRoot, 'Sources')],
        workspaceRoots: [packageRoot],
      });
      diagnostics.push(`${file.path}: SwiftPM targets could not be proven statically; using the package source root`);
      continue;
    }
    for (const target of targets) {
      const sourceRoot = normalizeContainedPath(
        packageRoot,
        target.path ?? `${target.test ? 'Tests' : 'Sources'}/${target.name}`,
      );
      if (sourceRoot === undefined) {
        diagnostics.push(`${file.path}: Swift target ${target.name} declares a path outside the package`);
        continue;
      }
      output.push({
        aliases: [target.name, sourceRoot],
        buildSystem: 'swiftpm',
        dependencyAliases: target.dependencies,
        diagnostics: [],
        evidence: file.path,
        kind: 'target',
        languages: ['swift'],
        name: target.name,
        provenance: 'declared',
        resolutionDomain: 'swift',
        root: sourceRoot,
        sourceRoots: [sourceRoot],
        workspaceRoots: [packageRoot],
      });
    }
  }
  return output;
}

function discoverXcodeProjects(
  files: readonly CodeGraphInventoryFile[],
  diagnostics: string[],
): readonly ProjectCandidate[] {
  const output: ProjectCandidate[] = [];
  for (const file of files.filter(candidate => /\.xcodeproj\/project\.pbxproj$/i.test(candidate.path))) {
    const projectBundle = dirname(file.path);
    const root = dirname(projectBundle);
    const projectName = basename(projectBundle).replace(/\.xcodeproj$/i, '');
    const targetNames = file.content
      ? [...file.content.matchAll(/isa\s*=\s*PBXNativeTarget;[\s\S]*?\bname\s*=\s*"?([^";\n]+)"?;/g)].map(match =>
          match[1]!.trim(),
        )
      : [];
    output.push({
      aliases: [projectName, root, ...targetNames],
      buildSystem: 'xcode',
      dependencyAliases: [],
      diagnostics: targetNames.length > 1 ? [`${file.path}: multiple targets share a conservative project scope`] : [],
      evidence: file.path,
      kind: 'project',
      languages: ['swift'],
      name: targetNames.length === 1 ? targetNames[0]! : projectName,
      provenance: 'declared',
      resolutionDomain: 'swift',
      root,
      sourceRoots: [root],
      workspaceRoots: [root],
    });
    if (targetNames.length > 1) {
      diagnostics.push(
        `${file.path}: multiple Xcode targets share a conservative project scope because source membership was incomplete`,
      );
    }
  }
  return output;
}

function addFallbackProjects(files: readonly CodeGraphInventoryFile[], candidates: ProjectCandidate[]): void {
  const coveredSourceRoots = createPathPrefixSet(candidates.flatMap(candidate => candidate.sourceRoots));
  for (const file of files.filter(candidate => /\.(?:java|kt|kts|swift)$/i.test(candidate.path))) {
    if (coveredSourceRoots.hasPrefix(file.path)) continue;
    const swift = file.path.toLowerCase().endsWith('.swift');
    const inferred = swift ? inferSwiftRoot(file.path) : inferJvmRoot(file.path);
    if (!inferred) continue;
    candidates.push({
      aliases: [inferred.name, inferred.root],
      buildSystem: 'inferred',
      dependencyAliases: [],
      diagnostics: [],
      kind: 'project',
      languages: swift ? ['swift'] : ['java', 'kotlin'],
      name: inferred.name,
      provenance: 'inferred',
      resolutionDomain: swift ? 'swift' : 'jvm',
      root: inferred.root,
      sourceRoots: [inferred.sourceRoot],
      workspaceRoots: [inferred.root],
    });
    coveredSourceRoots.add(inferred.sourceRoot);
  }
}

function mergeProjectCandidates(candidates: readonly ProjectCandidate[]): readonly ProjectCandidate[] {
  const merged = new Map<string, ProjectCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.resolutionDomain}\0${candidate.root}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    const preferred = preferredProjectCandidate(existing, candidate);
    merged.set(key, {
      aliases: unique([...existing.aliases, ...candidate.aliases]).sort(),
      buildSystem: preferred.buildSystem,
      dependencyAliases: unique([...existing.dependencyAliases, ...candidate.dependencyAliases]).sort(),
      diagnostics: unique([...existing.diagnostics, ...candidate.diagnostics]).sort(),
      evidence: preferred.evidence ?? existing.evidence ?? candidate.evidence,
      kind: preferred.kind,
      languages: unique([...existing.languages, ...candidate.languages]).sort(),
      name: preferredProjectName(existing.name, candidate.name),
      provenance: existing.provenance === 'declared' || candidate.provenance === 'declared' ? 'declared' : 'inferred',
      resolutionDomain: preferred.resolutionDomain,
      root: preferred.root,
      sourceRoots: unique([...existing.sourceRoots, ...candidate.sourceRoots]).sort(),
      workspaceRoots: unique([...existing.workspaceRoots, ...candidate.workspaceRoots]).sort(),
    });
  }
  return [...merged.values()].sort(
    (left, right) =>
      compareCodeUnits(left.root, right.root) ||
      compareCodeUnits(left.resolutionDomain, right.resolutionDomain) ||
      compareCodeUnits(left.name, right.name),
  );
}

function preferredProjectCandidate(left: ProjectCandidate, right: ProjectCandidate): ProjectCandidate {
  return compareProjectCandidatePrecedence(left, right) <= 0 ? left : right;
}

function compareProjectCandidatePrecedence(left: ProjectCandidate, right: ProjectCandidate): number {
  return (
    Number(right.provenance === 'declared') - Number(left.provenance === 'declared') ||
    evidenceDistance(left.root, left.evidence) - evidenceDistance(right.root, right.evidence) ||
    Number(left.buildSystem === 'inferred') - Number(right.buildSystem === 'inferred') ||
    componentKindRank(left.kind) - componentKindRank(right.kind) ||
    compareCodeUnits(left.kind, right.kind) ||
    compareCodeUnits(left.buildSystem, right.buildSystem) ||
    compareCodeUnits(left.evidence ?? '\uffff', right.evidence ?? '\uffff') ||
    compareCodeUnits(left.name, right.name)
  );
}

function evidenceDistance(root: string, evidence: string | undefined): number {
  if (!evidence) return Number.MAX_SAFE_INTEGER;
  const evidenceRoot = dirname(evidence);
  if (root === evidenceRoot) return 0;
  if (evidenceRoot === '') return root === '' ? 0 : root.split('/').length;
  if (!root.startsWith(`${evidenceRoot}/`)) return Number.MAX_SAFE_INTEGER;
  return root.slice(evidenceRoot.length + 1).split('/').length;
}

function componentKindRank(kind: CodeGraphWorkspaceComponentKind): number {
  switch (kind) {
    case 'project':
    case 'package':
      return 0;
    case 'module':
    case 'target':
      return 1;
  }
}

function materializeProjects(
  candidates: readonly ProjectCandidate[],
  diagnostics: string[],
): readonly CodeGraphWorkspaceProject[] {
  const projectIds = new Map<ProjectCandidate, string>();
  const candidatesById = new Map<string, ProjectCandidate>();
  const aliases = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const id = `cgp_${sha256HexSync(`project-v1\n${candidate.resolutionDomain}\n${candidate.root}`).slice(0, 32)}`;
    projectIds.set(candidate, id);
    candidatesById.set(id, candidate);
    for (const alias of candidate.aliases) {
      const values = aliases.get(alias) ?? new Set<string>();
      values.add(id);
      aliases.set(alias, values);
    }
  }
  return candidates.map(candidate => {
    const id = projectIds.get(candidate)!;
    const dependencies = new Set<string>();
    for (const alias of uniqueStrings(candidate.dependencyAliases)) {
      const targets = aliases.get(alias);
      if (targets?.size === 1) {
        const target = [...targets][0]!;
        if (target !== id) dependencies.add(target);
      } else if (targets && targets.size > 1) {
        const qualifier = [...targets].every(target => candidatesById.get(target)?.provenance === 'declared')
          ? 'declared '
          : '';
        diagnostics.push(
          `${candidate.evidence ?? candidate.root}: local dependency alias ${alias} matched multiple ${qualifier}projects`,
        );
      }
    }
    return {
      buildSystem: candidate.buildSystem,
      dependencies: [...dependencies].sort(),
      dependencyDetails: [...dependencies]
        .sort()
        .map(targetId => ({evidence: candidate.evidence, provenance: candidate.provenance, targetId})),
      diagnostics: candidate.diagnostics,
      id,
      kind: candidate.kind,
      languages: [...candidate.languages].sort(),
      name: candidate.name,
      provenance: candidate.provenance,
      resolutionDomain: candidate.resolutionDomain,
      root: candidate.root,
      sourceRoots: [...candidate.sourceRoots].sort(),
      workspaceId: workspaceIdentity(candidate.buildSystem, candidate.workspaceRoots[0] ?? candidate.root),
      workspaceRoots: [...candidate.workspaceRoots].sort(),
    };
  });
}

function diagnoseNxProjectBoundaries(
  files: readonly CodeGraphInventoryFile[],
  projects: readonly CodeGraphWorkspaceProject[],
  diagnostics: string[],
): void {
  const declaredProjectsByRoot = new Map<string, number>();
  for (const project of projects) {
    if (project.provenance !== 'declared') continue;
    declaredProjectsByRoot.set(project.root, (declaredProjectsByRoot.get(project.root) ?? 0) + 1);
  }
  for (const file of files
    .filter(candidate => basename(candidate.path).toLowerCase() === 'project.json')
    .sort((left, right) => compareCodeUnits(left.path, right.path))) {
    const root = dirname(file.path);
    if (declaredProjectsByRoot.get(root) !== 1) {
      diagnostics.push(`${file.path}: Nx project boundary is not reconciled to exactly one declared package root`);
    }
  }
}

function attributeSymbol(symbol: CodeGraphSymbol, project: CodeGraphWorkspaceProject): CodeGraphSymbol {
  if (symbol.resolutionDomain !== project.resolutionDomain) return symbol;
  return {
    ...symbol,
    lookupKeys: (symbol.lookupKeys ?? []).map(key => scopedLookupKey(key, project)),
    packageName: project.name,
    resolutionScopeId: project.id,
  };
}

function attributeReference(
  reference: CodeGraphReference,
  project: CodeGraphWorkspaceProject,
  projectsById: ReadonlyMap<string, CodeGraphWorkspaceProject>,
): CodeGraphReference {
  if (reference.resolutionDomain !== project.resolutionDomain) return reference;
  const lookupTiers: Array<readonly string[]> = [];
  for (const tier of reference.lookupTiers) {
    lookupTiers.push(tier.map(key => scopedLookupKey(key, project)));
    const dependencyKeys = project.dependencies.flatMap(dependencyId => {
      const dependency = projectsById.get(dependencyId);
      return dependency?.resolutionDomain === project.resolutionDomain
        ? tier.map(key => scopedLookupKey(key, dependency))
        : [];
    });
    if (dependencyKeys.length > 0) lookupTiers.push(unique(dependencyKeys));
  }
  return {
    ...reference,
    aliasLookupKeys: reference.aliasLookupKeys?.map(key => scopedLookupKey(key, project)),
    lookupTiers,
  };
}

function scopedLookupKey(key: string, project: CodeGraphWorkspaceProject): string {
  const prefix = `${project.resolutionDomain}:`;
  return key.startsWith(prefix) ? `${prefix}${project.id}:${key.slice(prefix.length)}` : key;
}

function createWorkspaceFileIndex(files: readonly CodeGraphInventoryFile[]): WorkspaceFileIndex {
  const buildFileByRoot = new Map<string, CodeGraphInventoryFile>();
  const fileByPath = new Map<string, CodeGraphInventoryFile>();
  for (const file of files) {
    fileByPath.set(file.path, file);
    if (/^build\.gradle(?:\.kts)?$/i.test(basename(file.path)) && !buildFileByRoot.has(dirname(file.path))) {
      buildFileByRoot.set(dirname(file.path), file);
    }
  }
  return {
    buildFileByRoot,
    fileByPath,
    sortedPaths: [...fileByPath.keys()].sort(),
  };
}

function createWorkspaceProjectPathIndex(projects: readonly CodeGraphWorkspaceProject[]): WorkspaceProjectPathIndex {
  const projectsByRoot = new Map<string, CodeGraphWorkspaceProject[]>();
  const projectsBySourceRoot = new Map<string, CodeGraphWorkspaceProject[]>();
  const add = (target: Map<string, CodeGraphWorkspaceProject[]>, root: string, project: CodeGraphWorkspaceProject) => {
    const existing = target.get(root);
    if (existing) {
      if (!existing.some(candidate => candidate.id === project.id)) existing.push(project);
    } else {
      target.set(root, [project]);
    }
  };
  for (const project of projects) {
    add(projectsByRoot, project.root, project);
    for (const sourceRoot of project.sourceRoots) add(projectsBySourceRoot, sourceRoot, project);
  }
  for (const candidates of [...projectsByRoot.values(), ...projectsBySourceRoot.values()]) {
    candidates.sort((left, right) => compareCodeUnits(left.id, right.id));
  }
  return {projectsByRoot, projectsBySourceRoot};
}

function nearestPrefixProject(
  projectsByPrefix: ReadonlyMap<string, readonly CodeGraphWorkspaceProject[]>,
  filePath: string,
  resolutionDomain?: string,
): CodeGraphWorkspaceProject | undefined {
  let prefix = filePath;
  for (;;) {
    const candidates = projectsByPrefix.get(prefix) ?? [];
    const project =
      resolutionDomain === undefined
        ? candidates[0]
        : candidates.find(candidate => candidate.resolutionDomain === resolutionDomain);
    if (project) return project;
    const separator = prefix.lastIndexOf('/');
    if (separator < 0) {
      const roots = projectsByPrefix.get('') ?? [];
      return resolutionDomain === undefined
        ? roots[0]
        : roots.find(candidate => candidate.resolutionDomain === resolutionDomain);
    }
    prefix = prefix.slice(0, separator);
  }
}

function hasIndexedPathWithin(sortedPaths: readonly string[], root: string): boolean {
  if (root === '') return sortedPaths.length > 0;
  let lower = 0;
  let upper = sortedPaths.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (sortedPaths[middle]! < root) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  const candidate = sortedPaths[lower];
  return candidate === root || candidate?.startsWith(`${root}/`) === true;
}

function createPathPrefixSet(initial: readonly string[]): {
  readonly add: (root: string) => void;
  readonly hasPrefix: (path: string) => boolean;
} {
  const roots = new Set(initial);
  return {
    add: root => {
      roots.add(root);
    },
    hasPrefix: path => {
      let prefix = path;
      for (;;) {
        if (roots.has(prefix)) return true;
        const separator = prefix.lastIndexOf('/');
        if (separator < 0) return roots.has('');
        prefix = prefix.slice(0, separator);
      }
    },
  };
}

function conventionalJvmSourceRoots(root: string): readonly string[] {
  return [
    'src/main/java',
    'src/main/kotlin',
    'src/test/java',
    'src/test/kotlin',
    'src/androidTest/java',
    'src/androidTest/kotlin',
    'src/commonMain/kotlin',
    'src/commonTest/kotlin',
    'src/jvmMain/kotlin',
    'src/jvmTest/kotlin',
    'src/iosMain/kotlin',
    'src/iosTest/kotlin',
  ].map(source => joinPath(root, source));
}

function gradleIncludes(content: string): readonly string[] {
  const output = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    if (!/^\s*include\b/.test(line)) continue;
    for (const match of line.matchAll(/["'](:[^"']+)["']/g)) {
      const path = match[1]!.replace(/^:/, '').replaceAll(':', '/');
      if (path) output.add(path);
    }
  }
  return [...output].sort();
}

function gradleProjectDirectories(content: string, root: string): ReadonlyMap<string, string> {
  const output = new Map<string, string>();
  for (const match of content.matchAll(
    /project\s*\(\s*["'](:[^"']+)["']\s*\)\.projectDir\s*=\s*(?:file\s*\(\s*)?["']([^"']+)["']/g,
  )) {
    const normalized = normalizeContainedPath(root, match[2]!);
    if (normalized !== undefined) output.set(match[1]!, normalized);
  }
  return output;
}

function gradleProjectDependencies(content: string): readonly string[] {
  return unique(
    [...content.matchAll(/\bproject\s*\(\s*(?:path\s*:\s*)?["'](:[^"']+)["']\s*\)/g)].map(match => match[1]!),
  );
}

function swiftTargets(content: string): readonly {
  readonly dependencies: readonly string[];
  readonly name: string;
  readonly path?: string;
  readonly test: boolean;
}[] {
  const starts = [...content.matchAll(/\.(target|executableTarget|testTarget)\s*\(\s*name\s*:\s*"([^"]+)"/g)];
  return starts.map((match, index) => {
    const body = content.slice(match.index, starts[index + 1]?.index ?? content.length);
    const path = /\bpath\s*:\s*"([^"]+)"/.exec(body)?.[1];
    const dependencyBlock = /\bdependencies\s*:\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? '';
    const dependencies = unique([...dependencyBlock.matchAll(/"([^"]+)"/g)].map(value => value[1]!));
    return {
      dependencies,
      name: match[2]!,
      path,
      test: match[1] === 'testTarget',
    };
  });
}

function inferJvmRoot(
  path: string,
): {readonly name: string; readonly root: string; readonly sourceRoot: string} | undefined {
  const match = /^(.*?)(?:\/)?src\/(?:[^/]+\/)?(?:java|kotlin)\//.exec(path);
  if (!match) return undefined;
  const root = match[1]!.replace(/\/$/, '');
  const sourceRoot = path.slice(0, match[0].length - 1);
  return {name: root.split('/').at(-1) || 'root', root, sourceRoot};
}

function inferSwiftRoot(
  path: string,
): {readonly name: string; readonly root: string; readonly sourceRoot: string} | undefined {
  const match = /^(.*?)(?:\/)?(?:Sources|Tests)\/([^/]+)\//.exec(path);
  if (!match) return undefined;
  const sourceRoot = path.slice(0, match[0].length - 1);
  return {name: match[2]!, root: sourceRoot, sourceRoot};
}

function xmlTag(content: string, tag: string): string | undefined {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*</${tag}>`, 'i').exec(content)?.[1]?.trim();
}

function xmlTags(content: string, tag: string): readonly string[] {
  return [...content.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*</${tag}>`, 'gi'))].map(match =>
    match[1]!.trim(),
  );
}

function normalizeContainedPath(root: string, relative: string): string | undefined {
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

function dirname(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function joinPath(...components: readonly string[]): string {
  return components.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\.\//, '');
}

function workspaceIdentity(buildSystem: CodeGraphWorkspaceBuildSystem, root: string): string {
  return `cgw_${sha256HexSync(`workspace-v1\n${buildSystem}\n${root}`).slice(0, 32)}`;
}

function materializeBuildWorkspaces(
  projects: readonly CodeGraphWorkspaceProject[],
  workspaceDiagnostics: readonly string[],
): readonly CodeGraphBuildWorkspace[] {
  const output = new Map<string, CodeGraphBuildWorkspace>();
  for (const project of projects) {
    const root = project.workspaceRoots[0] ?? project.root;
    const existing = output.get(project.workspaceId);
    output.set(project.workspaceId, {
      buildSystem: project.buildSystem,
      diagnostics: unique([...(existing?.diagnostics ?? []), ...project.diagnostics]).sort(),
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
        .sort()
        .slice(0, 100),
    };
  }
  return ordered;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function uniqueStrings(values: readonly string[]): string[] {
  return unique(values).sort(compareCodeUnits);
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const output = new Map<string, T>();
  for (const value of values) output.set(key(value), value);
  return [...output.values()];
}

function preferredProjectName(left: string, right: string): string {
  if (left === right) return left;
  return left.length === right.length
    ? compareCodeUnits(left, right) <= 0
      ? left
      : right
    : left.length < right.length
      ? left
      : right;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
