import type {CodeGraphInventoryFile} from './types.js';
import {compareCodeUnits} from './ordering.js';
import type {CodeGraphExternalDependencyKind, CodeGraphExternalDependencyV1} from './cross_repository/types.js';
import {normalizeNpmPackageName} from './cross_repository/monikers.js';
import {Predicate} from 'effect';
import {createSourceLineIndex, sourceSpan, type SourceLineIndex} from './languages/source_line_index.js';
import {
  basename,
  dirname,
  joinPath,
  messageOf,
  normalizeContainedPath,
  relativeContainedPath,
  type ProjectCandidate,
  uniqueStrings,
} from './workspace_primitives.js';

interface NodePackageManifest {
  readonly dependencyAliases: readonly string[];
  readonly externalDependencies: readonly CodeGraphExternalDependencyV1[];
  readonly file: CodeGraphInventoryFile;
  readonly name: string;
  readonly nameDeclared: boolean;
  readonly nameSpan: ReturnType<typeof sourceSpan>;
  readonly root: string;
  readonly version?: string;
  readonly workspacePatterns: readonly string[];
}

interface ParsedTsconfig {
  readonly dependencyAliases: readonly string[];
  readonly diagnostics: readonly string[];
  readonly file: CodeGraphInventoryFile;
  readonly root: string;
  readonly sourceRoots: readonly string[];
}

interface NxProjectManifest {
  readonly dependencyNames: readonly string[];
  readonly diagnostics: string[];
  readonly file: CodeGraphInventoryFile;
  readonly name: string;
  readonly root: string;
  readonly sourceRoots: readonly string[];
  readonly targets: readonly NxTargetManifest[];
  readonly workspaceRoot: string;
}

interface NxTargetManifest {
  readonly dependencyAliases: readonly string[];
  readonly name: string;
}

interface NodeWorkspaceMatch {
  readonly buildSystem: 'node' | 'pnpm';
  readonly root: string;
}

const MAX_NODE_EXTERNAL_DEPENDENCIES_PER_MANIFEST = 20_000;

/**
 * Parses package, pnpm, Nx, and TypeScript manifests once into typed component
 * candidates. Ancestor lookups are bounded by path depth and never scan the
 * package catalog for each manifest.
 */
export function discoverNodeWorkspaceCandidates(
  files: readonly CodeGraphInventoryFile[],
  diagnostics: string[],
): readonly ProjectCandidate[] {
  const orderedFiles = [...files].sort((left, right) => compareCodeUnits(left.path, right.path));
  const manifests = parsePackageManifests(orderedFiles, diagnostics);
  const manifestsByRoot = new Map(manifests.map(manifest => [manifest.root, manifest]));
  const pnpmPatterns = parsePnpmWorkspaces(orderedFiles);
  const nxRoots = new Set(
    orderedFiles.filter(file => basename(file.path).toLowerCase() === 'nx.json').map(file => dirname(file.path)),
  );
  const tsconfigs = parseTsconfigs(orderedFiles, diagnostics);
  const tsconfigsByPath = new Map(tsconfigs.map(config => [config.file.path, config]));

  const packageCandidates = manifests.map(manifest => {
    const match = nearestNodeWorkspace(manifest.root, manifestsByRoot, pnpmPatterns);
    const workspaceRoot = match?.root ?? manifest.root;
    const tsconfig = tsconfigsByPath.get(joinPath(manifest.root, 'tsconfig.json'));
    const referenceRoots = (tsconfig?.dependencyAliases ?? []).map(alias => dirname(alias.slice('tsconfig:'.length)));
    const referencedPackageNames = referenceRoots.flatMap(referenceRoot => {
      const target = manifestsByRoot.get(referenceRoot);
      return target ? [target.name] : [];
    });
    return {
      aliases: uniqueStrings([manifest.name, manifest.root]),
      buildSystem: match?.buildSystem ?? 'node',
      dependencyAliases: uniqueStrings([...manifest.dependencyAliases, ...referenceRoots, ...referencedPackageNames]),
      diagnostics: [],
      evidence: manifest.file.path,
      externalDependencies: manifest.externalDependencies,
      kind: 'package',
      languages: ['javascript', 'typescript'],
      name: manifest.name,
      packageNameSpan: manifest.nameSpan,
      packageNameDeclared: manifest.nameDeclared,
      ...(manifest.version === undefined ? {} : {packageVersion: manifest.version}),
      provenance: 'declared',
      resolutionDomain: 'typescript',
      root: manifest.root,
      sourceRoots: [manifest.root],
      workspaceRoots: [workspaceRoot],
    } satisfies ProjectCandidate;
  });

  const declaredWorkspaceRoots = new Set([
    ...packageCandidates.flatMap(candidate => candidate.workspaceRoots),
    ...pnpmPatterns.keys(),
    ...nxRoots,
  ]);
  const tsconfigCandidates = tsconfigs.map(config => {
    const workspaceRoot = nearestAncestor(config.root, declaredWorkspaceRoots) ?? config.root;
    const candidateDiagnostics = [...config.diagnostics];
    for (const alias of config.dependencyAliases) {
      if (!tsconfigsByPath.has(alias.slice('tsconfig:'.length))) {
        candidateDiagnostics.push(
          `${config.file.path}: TypeScript project reference ${alias.slice('tsconfig:'.length)} was not indexed`,
        );
      }
    }
    return {
      aliases: [`tsconfig:${config.file.path}`],
      buildSystem: 'typescript',
      dependencyAliases: config.dependencyAliases,
      diagnostics: uniqueStrings(candidateDiagnostics),
      evidence: config.file.path,
      identityKey: `tsconfig:${config.file.path}`,
      kind: 'project',
      languages: ['javascript', 'typescript'],
      name: tsconfigName(config.file.path),
      provenance: 'declared',
      resolutionDomain: 'typescript-config',
      root: config.root,
      sourceRoots: config.sourceRoots,
      workspaceRoots: [workspaceRoot],
    } satisfies ProjectCandidate;
  });
  const nxCandidates = discoverNxProjects(orderedFiles, nxRoots, declaredWorkspaceRoots, diagnostics);
  return [...packageCandidates, ...tsconfigCandidates, ...nxCandidates];
}

function parsePackageManifests(
  files: readonly CodeGraphInventoryFile[],
  diagnostics: string[],
): readonly NodePackageManifest[] {
  return files
    .filter(file => basename(file.path).toLowerCase() === 'package.json' && file.content !== undefined)
    .flatMap(file => {
      const manifest = parseJsonObject(file, 'package manifest', diagnostics);
      if (!manifest) return [];
      const root = dirname(file.path);
      const declaredName = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : undefined;
      let name = declaredName ?? (root.split('/').at(-1) || 'root');
      if (declaredName !== undefined) {
        try {
          name = normalizeNpmPackageName(declaredName);
        } catch {
          // Retain the workspace component even when its registry identity is
          // invalid; materialization will omit only the unsafe export moniker.
        }
      }
      const lineIndex = createSourceLineIndex(file.content!);
      const stringTokens = jsonStringTokens(file.content!);
      const externalDependencies = packageDependencies(
        manifest,
        file,
        diagnostics,
        jsonDependencySpans(file.content!, stringTokens, lineIndex),
      );
      return [
        {
          dependencyAliases: externalDependencies
            .filter(dependency => dependency.importAlias === dependency.name)
            .map(dependency => dependency.name),
          externalDependencies,
          file,
          name,
          nameDeclared: declaredName !== undefined,
          nameSpan: jsonPropertySpan(file, 'name', declaredName ?? name, stringTokens, lineIndex),
          root,
          ...(typeof manifest.version === 'string' && manifest.version.trim()
            ? {version: manifest.version.trim()}
            : {}),
          workspacePatterns: packageWorkspacePatterns(manifest),
        },
      ];
    });
}

function parsePnpmWorkspaces(files: readonly CodeGraphInventoryFile[]): ReadonlyMap<string, readonly string[]> {
  const output = new Map<string, readonly string[]>();
  for (const file of files) {
    if (basename(file.path).toLowerCase() !== 'pnpm-workspace.yaml' || file.content === undefined) continue;
    output.set(dirname(file.path), pnpmWorkspacePatterns(file.content));
  }
  return output;
}

function parseTsconfigs(files: readonly CodeGraphInventoryFile[], diagnostics: string[]): readonly ParsedTsconfig[] {
  return files
    .filter(file => /^tsconfig(?:\.[^/]+)?\.json$/iu.test(basename(file.path)) && file.content !== undefined)
    .flatMap(file => {
      const parsed = parseJsonObject(file, 'TypeScript config', diagnostics, true);
      if (!parsed) return [];
      const root = dirname(file.path);
      const configDiagnostics: string[] = [];
      return [
        {
          dependencyAliases: typescriptReferencePaths(root, parsed).map(path => `tsconfig:${path}`),
          diagnostics: configDiagnostics,
          file,
          root,
          sourceRoots: typescriptSourceRoots(root, parsed, file.path, configDiagnostics),
        },
      ];
    });
}

function discoverNxProjects(
  files: readonly CodeGraphInventoryFile[],
  nxRoots: ReadonlySet<string>,
  declaredWorkspaceRoots: ReadonlySet<string>,
  diagnostics: string[],
): readonly ProjectCandidate[] {
  const projects: NxProjectManifest[] = files
    .filter(file => basename(file.path).toLowerCase() === 'project.json' && file.content !== undefined)
    .flatMap(file => {
      const parsed = parseJsonObject(file, 'Nx project manifest', diagnostics, true);
      if (!parsed) return [];
      const fileRoot = dirname(file.path);
      const workspaceRoot =
        nearestAncestor(fileRoot, nxRoots) ?? nearestAncestor(fileRoot, declaredWorkspaceRoots) ?? fileRoot;
      const projectDiagnostics: string[] = [];
      const root =
        nxDeclaredPath(parsed.root, workspaceRoot, fileRoot, file.path, 'root', projectDiagnostics) ?? fileRoot;
      const sourceRoot =
        nxDeclaredPath(parsed.sourceRoot, workspaceRoot, root, file.path, 'sourceRoot', projectDiagnostics) ?? root;
      const name =
        typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : root.split('/').at(-1) || 'root';
      const dependencyNames = stringArray(parsed.implicitDependencies).filter(value => !value.startsWith('!'));
      return [
        {
          dependencyNames,
          diagnostics: projectDiagnostics,
          file,
          name,
          root,
          sourceRoots: uniqueStrings([sourceRoot]),
          targets: parseNxTargets(parsed.targets, name, dependencyNames, file.path, projectDiagnostics),
          workspaceRoot,
        },
      ];
    });
  const names = new Set(projects.map(project => project.name));
  for (const project of projects) {
    for (const dependency of project.dependencyNames) {
      if (!names.has(dependency)) {
        project.diagnostics.push(`${project.file.path}: Nx dependency ${dependency} was not indexed`);
      }
    }
  }
  return projects.flatMap(
    project =>
      [
        {
          aliases: [`nx-project:${project.name}`],
          buildSystem: 'nx',
          dependencyAliases: project.dependencyNames.map(nxProjectAlias),
          diagnostics: uniqueStrings(project.diagnostics),
          evidence: project.file.path,
          identityKey: `nx-project:${project.name}:${project.root}`,
          kind: 'project',
          languages: ['javascript', 'typescript'],
          name: project.name,
          provenance: 'declared',
          resolutionDomain: 'nx',
          root: project.root,
          sourceRoots: project.sourceRoots,
          workspaceRoots: [project.workspaceRoot],
        },
        ...project.targets.map(
          target =>
            ({
              aliases: [nxTargetAlias(project.name, target.name)],
              buildSystem: 'nx',
              dependencyAliases: uniqueStrings([nxProjectAlias(project.name), ...target.dependencyAliases]),
              diagnostics: [],
              evidence: project.file.path,
              identityKey: `nx-target:${project.name}:${target.name}:${project.root}`,
              kind: 'target',
              languages: ['javascript', 'typescript'],
              name: `${project.name}:${target.name}`,
              provenance: 'declared',
              resolutionDomain: 'nx',
              root: project.root,
              sourceRoots: project.sourceRoots,
              workspaceRoots: [project.workspaceRoot],
            }) satisfies ProjectCandidate,
        ),
      ] satisfies readonly ProjectCandidate[],
  );
}

function parseNxTargets(
  value: unknown,
  projectName: string,
  projectDependencies: readonly string[],
  evidence: string,
  diagnostics: string[],
): readonly NxTargetManifest[] {
  if (value === undefined) return [];
  if (!Predicate.isObject(value)) {
    diagnostics.push(`${evidence}: Nx targets must be an object`);
    return [];
  }
  return Object.entries(value)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([name, target]) => ({
      dependencyAliases: nxDependsOnAliases(
        Predicate.isObject(target) ? target.dependsOn : undefined,
        projectName,
        projectDependencies,
      ),
      name,
    }));
}

function nxDependsOnAliases(
  value: unknown,
  projectName: string,
  projectDependencies: readonly string[],
): readonly string[] {
  if (!Array.isArray(value)) return [];
  const aliases: string[] = [];
  for (const dependency of value) {
    if (typeof dependency === 'string') {
      if (dependency.startsWith('^')) {
        aliases.push(...projectDependencies.map(name => nxTargetAlias(name, dependency.slice(1))));
      } else {
        const [project, target] = splitNxTarget(dependency, projectName);
        aliases.push(nxTargetAlias(project, target));
      }
      continue;
    }
    if (!Predicate.isObject(dependency)) continue;
    const record = dependency;
    const target = record.target;
    if (typeof target !== 'string' || !target) continue;
    const projects = stringArray(record.projects);
    const targetProjects =
      record.dependencies === true ? projectDependencies : projects.length > 0 ? projects : [projectName];
    aliases.push(...targetProjects.map(project => nxTargetAlias(project, target)));
  }
  return uniqueStrings(aliases);
}

function splitNxTarget(value: string, defaultProject: string): readonly [string, string] {
  const separator = value.lastIndexOf(':');
  return separator <= 0 ? [defaultProject, value] : [value.slice(0, separator), value.slice(separator + 1)];
}

function nxProjectAlias(name: string): string {
  return `nx-project:${name}`;
}

function nxTargetAlias(project: string, target: string): string {
  return `nx-target:${project}:${target}`;
}

function nxDeclaredPath(
  value: unknown,
  workspaceRoot: string,
  fallbackRoot: string,
  evidence: string,
  field: string,
  diagnostics: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    diagnostics.push(`${evidence}: Nx ${field} must be a string`);
    return undefined;
  }
  const normalized = normalizeContainedPath(workspaceRoot, value);
  if (normalized === undefined || relativeContainedPath(workspaceRoot, normalized) === undefined) {
    diagnostics.push(`${evidence}: Nx ${field} escapes its workspace`);
    return fallbackRoot;
  }
  return normalized;
}

function nearestNodeWorkspace(
  packageRoot: string,
  manifestsByRoot: ReadonlyMap<string, NodePackageManifest>,
  pnpmPatterns: ReadonlyMap<string, readonly string[]>,
): NodeWorkspaceMatch | undefined {
  if (pnpmPatterns.has(packageRoot)) return {buildSystem: 'pnpm', root: packageRoot};
  if ((manifestsByRoot.get(packageRoot)?.workspacePatterns.length ?? 0) > 0) {
    return {buildSystem: 'node', root: packageRoot};
  }
  let candidateRoot = dirname(packageRoot);
  while (candidateRoot !== packageRoot) {
    const relative = relativeContainedPath(candidateRoot, packageRoot);
    if (relative !== undefined && relative !== '') {
      const pnpm = pnpmPatterns.get(candidateRoot) ?? [];
      if (workspacePatternsInclude(pnpm, relative)) return {buildSystem: 'pnpm', root: candidateRoot};
      const manifestPatterns = manifestsByRoot.get(candidateRoot)?.workspacePatterns ?? [];
      if (workspacePatternsInclude(manifestPatterns, relative)) return {buildSystem: 'node', root: candidateRoot};
    }
    if (candidateRoot === '') return undefined;
    const parent = dirname(candidateRoot);
    if (parent === candidateRoot) return undefined;
    candidateRoot = parent;
  }
  return undefined;
}

function nearestAncestor(path: string, roots: ReadonlySet<string>): string | undefined {
  let candidate = path;
  for (;;) {
    if (roots.has(candidate)) return candidate;
    if (candidate === '') return undefined;
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

function packageDependencies(
  manifest: Record<string, unknown>,
  file: CodeGraphInventoryFile,
  diagnostics: string[],
  spans: ReadonlyMap<string, ReturnType<typeof sourceSpan>>,
): readonly CodeGraphExternalDependencyV1[] {
  const sections = [
    ['dependencies', 'runtime'],
    ['devDependencies', 'development'],
    ['optionalDependencies', 'optional'],
    ['peerDependencies', 'peer'],
  ] as const satisfies readonly (readonly [string, CodeGraphExternalDependencyKind])[];
  const output: CodeGraphExternalDependencyV1[] = [];
  for (const [section, kind] of sections) {
    const dependencies = manifest[section];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const [rawName, rawConstraint] of Object.entries(dependencies)) {
      if (typeof rawConstraint !== 'string' || !rawConstraint.trim() || rawConstraint.trim().length > 8_192) continue;
      try {
        const declaration = npmDependencyDeclaration(rawName, rawConstraint);
        output.push({
          ecosystem: 'npm',
          evidence: {
            path: file.path,
            span: spans.get(`${section}\0${rawName}`) ?? {column: 1, endColumn: 1, endLine: 1, line: 1},
          },
          importAlias: declaration.importAlias,
          kind,
          name: declaration.name,
          versionConstraint: declaration.versionConstraint,
        });
      } catch {
        // Invalid registry names remain ordinary unresolved graph text; they
        // cannot become authoritative cross-repository package declarations.
      }
    }
  }
  const ordered = output.sort(
    (left, right) =>
      compareCodeUnits(left.name, right.name) ||
      compareCodeUnits(left.importAlias, right.importAlias) ||
      compareCodeUnits(left.kind, right.kind) ||
      compareCodeUnits(left.versionConstraint, right.versionConstraint),
  );
  if (ordered.length > MAX_NODE_EXTERNAL_DEPENDENCIES_PER_MANIFEST) {
    diagnostics.push(
      `${file.path}: npm external dependency declarations exceeded ${MAX_NODE_EXTERNAL_DEPENDENCIES_PER_MANIFEST} entries and were truncated`,
    );
  }
  return ordered.slice(0, MAX_NODE_EXTERNAL_DEPENDENCIES_PER_MANIFEST);
}

function npmDependencyDeclaration(
  rawName: string,
  rawConstraint: string,
): {readonly importAlias: string; readonly name: string; readonly versionConstraint: string} {
  const importAlias = normalizeNpmPackageName(rawName);
  const constraint = rawConstraint.normalize('NFKC').trim();
  if (!constraint.startsWith('npm:')) {
    return {importAlias, name: importAlias, versionConstraint: constraint};
  }
  const target = constraint.slice('npm:'.length).trim();
  const packageSeparator = target.startsWith('@')
    ? target.indexOf('@', target.indexOf('/') + 1)
    : target.lastIndexOf('@');
  const packageName = packageSeparator > 0 ? target.slice(0, packageSeparator) : target;
  const versionConstraint = packageSeparator > 0 ? target.slice(packageSeparator + 1).trim() : '*';
  if (!versionConstraint) throw new Error('npm alias version constraint is empty');
  return {
    importAlias,
    name: normalizeNpmPackageName(packageName),
    versionConstraint,
  };
}

function jsonPropertySpan(
  file: CodeGraphInventoryFile,
  property: string,
  fallback: string,
  tokens: readonly JsonStringToken[],
  lineIndex: SourceLineIndex,
): ReturnType<typeof sourceSpan> {
  const content = file.content!;
  const keyIndex = lastJsonTokenIndex(tokens, token => token.depth === 1 && token.key && token.value === property);
  const value = keyIndex >= 0 ? tokens[keyIndex + 1] : undefined;
  if (value && !value.key && value.depth === 1 && value.value === fallback) {
    return sourceSpan(lineIndex, value.start, value.end);
  }
  return sourceSpan(lineIndex, 0, Math.min(content.length, JSON.stringify(fallback).length));
}

interface JsonStringToken {
  readonly depth: number;
  readonly end: number;
  readonly key: boolean;
  readonly start: number;
  readonly value: string;
}

function jsonStringTokens(content: string): readonly JsonStringToken[] {
  const output: JsonStringToken[] = [];
  let depth = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '{') {
      depth += 1;
      continue;
    }
    if (character === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (character !== '"') continue;
    const end = jsonStringEnd(content, index);
    const raw = content.slice(index, end);
    const value = JSON.parse(raw) as unknown;
    if (typeof value === 'string') {
      output.push({
        depth,
        end,
        key: content[nextNonWhitespace(content, end)] === ':',
        start: index,
        value,
      });
    }
    index = end - 1;
  }
  return output;
}

function jsonDependencySpans(
  content: string,
  tokens: readonly JsonStringToken[],
  lineIndex: SourceLineIndex,
): ReadonlyMap<string, ReturnType<typeof sourceSpan>> {
  const output = new Map<string, ReturnType<typeof sourceSpan>>();
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const sectionIndex = lastJsonTokenIndex(tokens, token => token.depth === 1 && token.key && token.value === section);
    if (sectionIndex < 0) continue;
    const sectionToken = tokens[sectionIndex];
    const colon = nextNonWhitespace(content, sectionToken.end);
    const objectStart = nextNonWhitespace(content, colon + 1);
    if (content[objectStart] !== '{') continue;
    const objectEnd = jsonObjectEnd(content, objectStart);
    for (let index = sectionIndex + 1; index < tokens.length; index += 1) {
      const key = tokens[index];
      if (key.start >= objectEnd) break;
      if (key.depth !== 2 || !key.key) continue;
      const value = tokens[index + 1];
      if (!value || value.start >= objectEnd || value.depth !== 2 || value.key) continue;
      output.set(`${section}\0${key.value}`, sourceSpan(lineIndex, key.start, value.end));
    }
  }
  return output;
}

function jsonStringEnd(content: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') return index + 1;
  }
  return content.length;
}

function jsonObjectEnd(content: string, start: number): number {
  let depth = 0;
  for (let index = start; index < content.length; index += 1) {
    if (content[index] === '"') {
      index = jsonStringEnd(content, index) - 1;
      continue;
    }
    if (content[index] === '{') depth += 1;
    else if (content[index] === '}' && --depth === 0) return index;
  }
  return content.length;
}

function nextNonWhitespace(content: string, start: number): number {
  let index = start;
  while (index < content.length && /\s/u.test(content[index])) index += 1;
  return index;
}

function lastJsonTokenIndex(
  tokens: readonly JsonStringToken[],
  predicate: (token: JsonStringToken) => boolean,
): number {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (predicate(tokens[index])) return index;
  }
  return -1;
}

function packageWorkspacePatterns(manifest: Record<string, unknown>): readonly string[] {
  const workspaces = manifest.workspaces;
  if (Array.isArray(workspaces)) return workspaces.filter((value): value is string => typeof value === 'string');
  if (!Predicate.isObject(workspaces)) return [];
  const packages = workspaces.packages;
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
  return uniqueStrings(patterns);
}

function typescriptReferencePaths(root: string, config: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(config.references)) return [];
  return uniqueStrings(
    config.references.flatMap(reference => {
      if (!Predicate.isObject(reference)) return [];
      const value = reference.path;
      if (typeof value !== 'string') return [];
      const normalized = normalizeContainedPath(root, value);
      if (normalized === undefined) return [];
      return [/\.json$/iu.test(normalized) ? normalized : joinPath(normalized, 'tsconfig.json')];
    }),
  );
}

function typescriptSourceRoots(
  root: string,
  config: Record<string, unknown>,
  evidence: string,
  diagnostics: string[],
): readonly string[] {
  const compilerOptions = Predicate.isObject(config.compilerOptions) ? config.compilerOptions : {};
  const declared = [
    ...(typeof compilerOptions.rootDir === 'string' ? [compilerOptions.rootDir] : []),
    ...stringArray(compilerOptions.rootDirs),
    ...stringArray(config.include).map(staticPatternRoot),
  ];
  const output = declared.flatMap(value => {
    const normalized = normalizeContainedPath(root, value);
    if (normalized === undefined) {
      diagnostics.push(`${evidence}: TypeScript source root ${value} escapes the repository`);
      return [];
    }
    return [normalized];
  });
  return uniqueStrings(output.length > 0 ? output : [root]);
}

function staticPatternRoot(pattern: string): string {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  const glob = normalized.search(/[?*[{]/u);
  const prefix = (glob < 0 ? normalized : normalized.slice(0, glob)).replace(/\/+$/u, '');
  return /\.[^/]+$/u.test(prefix) ? dirname(prefix) : prefix || '.';
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

function parseJsonObject(
  file: CodeGraphInventoryFile,
  label: string,
  diagnostics: string[],
  jsonc = false,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(jsonc ? stripJsonCommentsAndTrailingCommas(file.content!) : file.content!);
    if (!Predicate.isObject(parsed)) {
      diagnostics.push(`${file.path}: ${label} is not an object`);
      return undefined;
    }
    return parsed;
  } catch (cause) {
    diagnostics.push(`${file.path}: invalid ${label} (${messageOf(cause)})`);
    return undefined;
  }
}

function stripJsonCommentsAndTrailingCommas(content: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
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

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function tsconfigName(path: string): string {
  const root = dirname(path);
  return root ? `${root.split('/').at(-1)}:${basename(path)}` : basename(path);
}
