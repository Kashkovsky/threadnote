import {Effect, Option} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphReference, CodeGraphSymbol} from './types.js';
import type {
  CodeGraphBuildWorkspace,
  CodeGraphWorkspace,
  CodeGraphWorkspaceComponentKind,
  CodeGraphWorkspaceDependency,
  CodeGraphWorkspaceDetector,
  CodeGraphWorkspaceProject,
} from './languages/types.js';
import {compareCodeUnits} from './ordering.js';
import {canonicalCodeGraphMonikers, codeGraphPackageMoniker} from './cross_repository/monikers.js';
import type {CodeGraphExternalDependencyV1, CodeGraphMonikerV1} from './cross_repository/types.js';
import {discoverNodeWorkspaceCandidates} from './workspace_node.js';
import {
  basename,
  dirname,
  joinPath,
  materializeBuildWorkspaces,
  normalizeContainedPath,
  type ProjectCandidate,
  type WorkspaceFileIndex,
  unique,
  uniqueStrings,
  workspaceIdentity,
} from './workspace_primitives.js';

export {discoverBazelWorkspace} from './workspace_bazel.js';

interface WorkspaceProjectPathIndex {
  readonly projectsByRoot: ReadonlyMap<string, readonly CodeGraphWorkspaceProject[]>;
  readonly projectsBySourceRoot: ReadonlyMap<string, readonly CodeGraphWorkspaceProject[]>;
}

const workspaceProjectPathIndexes = new WeakMap<readonly CodeGraphWorkspaceProject[], WorkspaceProjectPathIndex>();

export const CODE_GRAPH_WORKSPACE_MODEL_VERSION = 'code-graph-workspace-set-v2' as const;

export const manifestWorkspaceDetector: CodeGraphWorkspaceDetector = {
  contextFiles: [],
  detect: files => Effect.succeed(discoverManifestWorkspace(files)),
};

export function discoverManifestWorkspace(files: readonly CodeGraphInventoryFile[]): CodeGraphWorkspace {
  const diagnostics: string[] = [];
  const fileIndex = createWorkspaceFileIndex(files);
  const candidates = [
    ...discoverNodeWorkspaceCandidates(files, diagnostics),
    ...discoverMavenProjects(files, diagnostics, fileIndex),
    ...discoverGradleProjects(files, diagnostics, fileIndex),
    ...discoverSwiftPackageProjects(files, diagnostics),
    ...discoverXcodeProjects(files, diagnostics),
  ];
  addFallbackProjects(files, candidates);
  const projects = materializeProjects(mergeProjectCandidates(candidates), diagnostics);
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
          JSON.stringify(project.externalDependencies ?? []),
          JSON.stringify(project.monikers ?? []),
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
        externalDependencies: normalizeExternalDependencies([
          ...(existing.externalDependencies ?? []),
          ...(project.externalDependencies ?? []),
        ]),
        diagnostics: uniqueStrings([...existing.diagnostics, ...project.diagnostics]),
        id: project.id,
        kind: preferred.kind,
        languages: uniqueStrings([...existing.languages, ...project.languages]),
        monikers: canonicalCodeGraphMonikers([...(existing.monikers ?? []), ...(project.monikers ?? [])]),
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
    externalDependencies: normalizeExternalDependencies(project.externalDependencies ?? []),
    diagnostics: uniqueStrings(project.diagnostics),
    languages: uniqueStrings(project.languages),
    monikers: canonicalCodeGraphMonikers(project.monikers ?? []),
    sourceRoots: uniqueStrings(project.sourceRoots),
    workspaceRoots: uniqueStrings(project.workspaceRoots),
  };
}

function normalizeExternalDependencies(
  dependencies: readonly CodeGraphExternalDependencyV1[],
): readonly CodeGraphExternalDependencyV1[] {
  return uniqueBy(
    dependencies,
    dependency =>
      `${dependency.ecosystem}\0${dependency.name}\0${dependency.importAlias}\0${dependency.kind}\0${dependency.versionConstraint}\0${dependency.evidence.path}`,
  ).sort(
    (left, right) =>
      compareCodeUnits(left.ecosystem, right.ecosystem) ||
      compareCodeUnits(left.name, right.name) ||
      compareCodeUnits(left.importAlias, right.importAlias) ||
      compareCodeUnits(left.kind, right.kind) ||
      compareCodeUnits(left.versionConstraint, right.versionConstraint) ||
      compareCodeUnits(left.evidence.path, right.evidence.path),
  );
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
        project.externalDependencies ?? [],
        project.monikers ?? [],
        project.languages,
        project.sourceRoots,
        project.workspaceRoots,
        project.diagnostics,
      ]),
      version: CODE_GRAPH_WORKSPACE_MODEL_VERSION,
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
  const findPackageProject = createWorkspaceProjectLookup(
    workspace.projects.filter(project => project.buildSystem === 'node' || project.buildSystem === 'pnpm'),
  );
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
          Option.match(
            symbol.kind === 'package' && symbol.resolutionDomain === 'workspace'
              ? findPackageProject(file.path)
              : findProject(file.path, symbol.resolutionDomain),
            {
              onNone: () => symbol,
              onSome: project => attributeSymbol(symbol, project),
            },
          ),
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
    const key = candidate.identityKey ?? `${candidate.resolutionDomain}\0${candidate.root}`;
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
      externalDependencies: normalizeExternalDependencies([
        ...(existing.externalDependencies ?? []),
        ...(candidate.externalDependencies ?? []),
      ]),
      ...((preferred.identityKey ?? existing.identityKey ?? candidate.identityKey)
        ? {identityKey: preferred.identityKey ?? existing.identityKey ?? candidate.identityKey}
        : {}),
      kind: preferred.kind,
      languages: unique([...existing.languages, ...candidate.languages]).sort(),
      name: preferredProjectName(existing.name, candidate.name),
      ...(preferred.packageNameSpan === undefined ? {} : {packageNameSpan: preferred.packageNameSpan}),
      ...(preferred.packageNameDeclared === undefined ? {} : {packageNameDeclared: preferred.packageNameDeclared}),
      ...(preferred.packageVersion === undefined ? {} : {packageVersion: preferred.packageVersion}),
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
    const identity = candidate.identityKey ?? `${candidate.resolutionDomain}\n${candidate.root}`;
    const id = `cgp_${sha256HexSync(`project-v1\n${identity}`).slice(0, 32)}`;
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
      } else if (/^(?:nx-project:|nx-target:|tsconfig:)/u.test(alias)) {
        diagnostics.push(
          `${candidate.evidence ?? candidate.root}: declared component dependency ${alias} was not indexed`,
        );
      }
    }
    const externalDependencies = normalizeExternalDependencies(
      (candidate.externalDependencies ?? []).filter(dependency => {
        if (dependency.importAlias !== dependency.name) return true;
        const targets = aliases.get(dependency.name);
        if (targets === undefined || targets.size !== 1) return true;
        return targets.has(id);
      }),
    );
    const monikers: CodeGraphMonikerV1[] = [];
    for (const dependency of externalDependencies) {
      try {
        monikers.push(
          codeGraphPackageMoniker({
            componentId: id,
            dependencyKind: dependency.kind,
            evidence: {
              path: dependency.evidence.path,
              span: dependency.evidence.span ?? {column: 1, endColumn: 1, endLine: 1, line: 1},
            },
            packageName: dependency.name,
            packageVersion: dependency.versionConstraint,
            role: 'import',
          }),
        );
      } catch {
        diagnostics.push(`${dependency.evidence.path}: npm dependency cannot form a package moniker`);
      }
    }
    if ((candidate.buildSystem === 'node' || candidate.buildSystem === 'pnpm') && candidate.packageNameDeclared) {
      try {
        monikers.push(
          codeGraphPackageMoniker({
            componentId: id,
            evidence: {
              path: candidate.evidence ?? `${candidate.root ? `${candidate.root}/` : ''}package.json`,
              span: candidate.packageNameSpan ?? {column: 1, endColumn: 1, endLine: 1, line: 1},
            },
            packageName: candidate.name,
            packageVersion: candidate.packageVersion,
            role: 'export',
          }),
        );
      } catch {
        diagnostics.push(`${candidate.evidence ?? candidate.root}: npm package name cannot form a package moniker`);
      }
    }
    return {
      buildSystem: candidate.buildSystem,
      dependencies: [...dependencies].sort(),
      dependencyDetails: [...dependencies]
        .sort()
        .map(targetId => ({evidence: candidate.evidence, provenance: candidate.provenance, targetId})),
      externalDependencies,
      diagnostics: candidate.diagnostics,
      id,
      kind: candidate.kind,
      languages: [...candidate.languages].sort(),
      monikers: canonicalCodeGraphMonikers(monikers),
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

function attributeSymbol(symbol: CodeGraphSymbol, project: CodeGraphWorkspaceProject): CodeGraphSymbol {
  if (
    symbol.kind === 'package' &&
    symbol.resolutionDomain === 'workspace' &&
    (project.buildSystem === 'node' || project.buildSystem === 'pnpm')
  ) {
    return {...symbol, packageName: project.name};
  }
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
