import {Effect, Option} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphReference, CodeGraphSymbol} from './types.js';
import type {CodeGraphWorkspace, CodeGraphWorkspaceDetector, CodeGraphWorkspaceProject} from './languages/types.js';

interface ProjectCandidate {
  readonly aliases: readonly string[];
  readonly dependencyAliases: readonly string[];
  readonly languages: readonly string[];
  readonly name: string;
  readonly resolutionDomain: string;
  readonly root: string;
  readonly sourceRoots: readonly string[];
  readonly workspaceRoots: readonly string[];
}

export const manifestWorkspaceDetector: CodeGraphWorkspaceDetector = {
  contextFiles: [],
  detect: files => Effect.succeed(discoverManifestWorkspace(files)),
};

export function discoverManifestWorkspace(files: readonly CodeGraphInventoryFile[]): CodeGraphWorkspace {
  const diagnostics: string[] = [];
  const candidates = [
    ...discoverMavenProjects(files, diagnostics),
    ...discoverGradleProjects(files, diagnostics),
    ...discoverSwiftPackageProjects(files, diagnostics),
    ...discoverXcodeProjects(files, diagnostics),
  ];
  addFallbackProjects(files, candidates);
  const projects = materializeProjects(mergeProjectCandidates(candidates));
  const fingerprint = sha256HexSync(
    [
      'code-graph-workspace-v1',
      ...projects.map(project =>
        [
          project.id,
          project.name,
          project.root,
          project.resolutionDomain,
          project.dependencies.join(','),
          project.sourceRoots.join(','),
          project.workspaceRoots.join(','),
        ].join('\0'),
      ),
      ...diagnostics,
    ].join('\n'),
  );
  return {diagnostics: diagnostics.slice(0, 100), fingerprint, projects};
}

export function mergeCodeGraphWorkspaces(workspaces: readonly CodeGraphWorkspace[]): CodeGraphWorkspace {
  const projects = new Map<string, CodeGraphWorkspaceProject>();
  const diagnostics: string[] = [];
  for (const workspace of workspaces) {
    for (const project of workspace.projects) {
      const existing = projects.get(project.id);
      if (!existing) {
        projects.set(project.id, project);
        continue;
      }
      projects.set(project.id, {
        dependencies: unique([...existing.dependencies, ...project.dependencies]).sort(),
        id: project.id,
        languages: unique([...existing.languages, ...project.languages]).sort(),
        name: preferredProjectName(existing.name, project.name),
        resolutionDomain: project.resolutionDomain,
        root: project.root,
        sourceRoots: unique([...existing.sourceRoots, ...project.sourceRoots]).sort(),
        workspaceRoots: unique([...existing.workspaceRoots, ...project.workspaceRoots]).sort(),
      });
    }
    diagnostics.push(...workspace.diagnostics);
  }
  const orderedProjects = [...projects.values()].sort(
    (left, right) =>
      left.root.localeCompare(right.root) ||
      left.resolutionDomain.localeCompare(right.resolutionDomain) ||
      left.id.localeCompare(right.id),
  );
  const orderedDiagnostics = unique(diagnostics).sort().slice(0, 100);
  return {
    diagnostics: orderedDiagnostics,
    fingerprint: sha256HexSync(
      ['code-graph-workspace-set-v1', ...workspaces.map(workspace => workspace.fingerprint).sort()].join('\n'),
    ),
    projects: orderedProjects,
  };
}

export function createWorkspaceAttributor(
  workspace: CodeGraphWorkspace,
): (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[] {
  const projectsById = new Map(workspace.projects.map(project => [project.id, project]));
  return facts =>
    facts.map(file => {
      const project = projectForPath(workspace.projects, file.path);
      if (Option.isNone(project)) return file;
      return {
        ...file,
        references: file.references?.map(reference => attributeReference(reference, project.value, projectsById)),
        symbols: file.symbols.map(symbol => attributeSymbol(symbol, project.value)),
      };
    });
}

export function projectForPath(
  projects: readonly CodeGraphWorkspaceProject[],
  filePath: string,
): Option.Option<CodeGraphWorkspaceProject> {
  const ranked = projects.flatMap(project => {
    const sourceRoot = project.sourceRoots
      .filter(root => containsPath(root, filePath))
      .sort((left, right) => right.length - left.length)[0];
    if (sourceRoot !== undefined) return [{project, rank: 2, specificity: sourceRoot.length}];
    if (containsPath(project.root, filePath)) return [{project, rank: 1, specificity: project.root.length}];
    return [];
  });
  ranked.sort(
    (left, right) =>
      right.rank - left.rank || right.specificity - left.specificity || left.project.id.localeCompare(right.project.id),
  );
  return Option.fromUndefinedOr(ranked[0]?.project);
}

function discoverMavenProjects(
  files: readonly CodeGraphInventoryFile[],
  diagnostics: string[],
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
      dependencyAliases: dependencies,
      languages: ['java', 'kotlin'],
      name,
      resolutionDomain: 'jvm',
      root,
      sourceRoots: conventionalJvmSourceRoots(root),
      workspaceRoots: [root],
    });
    for (const moduleRoot of moduleRoots) {
      if (!files.some(candidate => candidate.path === joinPath(moduleRoot, 'pom.xml'))) {
        diagnostics.push(`${file.path}: declared Maven module ${moduleRoot} has no indexed pom.xml`);
      }
    }
  }
  return output;
}

function discoverGradleProjects(
  files: readonly CodeGraphInventoryFile[],
  diagnostics: string[],
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
    const modules = ['', ...gradleIncludes(settings.content!)];
    for (const modulePath of modules) {
      const gradlePath = modulePath ? `:${modulePath.split('/').join(':')}` : ':';
      const root = projectDirectories.get(gradlePath) ?? joinPath(workspaceRoot, modulePath);
      coveredBuildRoots.add(root);
      const buildFile = files.find(
        candidate => dirname(candidate.path) === root && /^build\.gradle(?:\.kts)?$/i.test(basename(candidate.path)),
      );
      const dependencyAliases = buildFile?.content ? gradleProjectDependencies(buildFile.content) : [];
      const moduleName = modulePath.split('/').at(-1) || rootName;
      output.push({
        aliases: [gradlePath, moduleName, root],
        dependencyAliases,
        languages: ['java', 'kotlin'],
        name: moduleName,
        resolutionDomain: 'jvm',
        root,
        sourceRoots: conventionalJvmSourceRoots(root),
        workspaceRoots: [workspaceRoot],
      });
    }
    for (const modulePath of gradleIncludes(settings.content!)) {
      const root = projectDirectories.get(`:${modulePath.split('/').join(':')}`) ?? joinPath(workspaceRoot, modulePath);
      if (!files.some(candidate => containsPath(root, candidate.path))) {
        diagnostics.push(`${settings.path}: declared Gradle project ${modulePath} has no indexed files`);
      }
    }
  }
  for (const buildFile of files.filter(candidate => /^build\.gradle(?:\.kts)?$/i.test(basename(candidate.path)))) {
    const root = dirname(buildFile.path);
    if (coveredBuildRoots.has(root)) continue;
    output.push({
      aliases: [root, root.split('/').at(-1) || 'root'],
      dependencyAliases: buildFile.content ? gradleProjectDependencies(buildFile.content) : [],
      languages: ['java', 'kotlin'],
      name: root.split('/').at(-1) || 'root',
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
        dependencyAliases: [],
        languages: ['swift'],
        name: packageName,
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
        dependencyAliases: target.dependencies,
        languages: ['swift'],
        name: target.name,
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
      dependencyAliases: [],
      languages: ['swift'],
      name: targetNames.length === 1 ? targetNames[0]! : projectName,
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
  for (const file of files.filter(candidate => /\.(?:java|kt|kts|swift)$/i.test(candidate.path))) {
    if (candidates.some(candidate => candidate.sourceRoots.some(root => containsPath(root, file.path)))) continue;
    const swift = file.path.toLowerCase().endsWith('.swift');
    const inferred = swift ? inferSwiftRoot(file.path) : inferJvmRoot(file.path);
    if (!inferred) continue;
    candidates.push({
      aliases: [inferred.name, inferred.root],
      dependencyAliases: [],
      languages: swift ? ['swift'] : ['java', 'kotlin'],
      name: inferred.name,
      resolutionDomain: swift ? 'swift' : 'jvm',
      root: inferred.root,
      sourceRoots: [inferred.sourceRoot],
      workspaceRoots: [inferred.root],
    });
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
    merged.set(key, {
      aliases: unique([...existing.aliases, ...candidate.aliases]),
      dependencyAliases: unique([...existing.dependencyAliases, ...candidate.dependencyAliases]),
      languages: unique([...existing.languages, ...candidate.languages]),
      name: preferredProjectName(existing.name, candidate.name),
      resolutionDomain: candidate.resolutionDomain,
      root: candidate.root,
      sourceRoots: unique([...existing.sourceRoots, ...candidate.sourceRoots]).sort(),
      workspaceRoots: unique([...existing.workspaceRoots, ...candidate.workspaceRoots]).sort(),
    });
  }
  return [...merged.values()].sort(
    (left, right) =>
      left.root.localeCompare(right.root) ||
      left.resolutionDomain.localeCompare(right.resolutionDomain) ||
      left.name.localeCompare(right.name),
  );
}

function materializeProjects(candidates: readonly ProjectCandidate[]): readonly CodeGraphWorkspaceProject[] {
  const projectIds = new Map<ProjectCandidate, string>();
  const aliases = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const id = `cgp_${sha256HexSync(`project-v1\n${candidate.resolutionDomain}\n${candidate.root}`).slice(0, 32)}`;
    projectIds.set(candidate, id);
    for (const alias of candidate.aliases) {
      const values = aliases.get(alias) ?? new Set<string>();
      values.add(id);
      aliases.set(alias, values);
    }
  }
  return candidates.map(candidate => {
    const id = projectIds.get(candidate)!;
    const dependencies = new Set<string>();
    for (const alias of candidate.dependencyAliases) {
      const targets = aliases.get(alias);
      if (targets?.size === 1) {
        const target = [...targets][0]!;
        if (target !== id) dependencies.add(target);
      }
    }
    return {
      dependencies: [...dependencies].sort(),
      id,
      languages: [...candidate.languages].sort(),
      name: candidate.name,
      resolutionDomain: candidate.resolutionDomain,
      root: candidate.root,
      sourceRoots: [...candidate.sourceRoots].sort(),
      workspaceRoots: [...candidate.workspaceRoots].sort(),
    };
  });
}

function attributeSymbol(symbol: CodeGraphSymbol, project: CodeGraphWorkspaceProject): CodeGraphSymbol {
  if (symbol.resolutionDomain !== project.resolutionDomain) return symbol;
  return {
    ...symbol,
    lookupKeys: (symbol.lookupKeys ?? []).map(key => scopedLookupKey(key, project)),
    packageName: project.name,
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

function containsPath(root: string, path: string): boolean {
  return root === '' || path === root || path.startsWith(`${root}/`);
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

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function preferredProjectName(left: string, right: string): string {
  if (left === right) return left;
  return left.length < right.length ? left : right;
}
