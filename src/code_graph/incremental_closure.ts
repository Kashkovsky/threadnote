import type {CodeGraphWorkspaceProject} from './languages/types.js';
import {compareCodeUnits} from './ordering.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSymbol} from './types.js';

export const PROJECT_INCREMENTAL_CLOSURE_MAX_FILES = 128;
export const PROJECT_INCREMENTAL_CLOSURE_MAX_SOURCE_BYTES = 16 * 1_048_576;
export const PROJECT_INCREMENTAL_CLOSURE_MAX_CACHED_FACT_BYTES = 8 * 1_048_576;

export type ProjectIncrementalClosureFallbackReason =
  'cache-incomplete' | 'project-closure-incomplete' | 'project-closure-unbounded';

export type ProjectIncrementalClosurePlan =
  | {
      readonly affectedPaths: readonly string[];
      readonly cachedFactBytes: number;
      readonly mode: 'eligible';
      readonly planningOperations: {
        readonly dependencyEdges: number;
        readonly pathOwnershipChecks: number;
      };
      readonly projectIds: readonly string[];
      readonly sourceBytes: number;
    }
  | {
      readonly mode: 'fallback';
      readonly reason: ProjectIncrementalClosureFallbackReason;
    };

export interface ProjectIncrementalClosureInput {
  readonly cachedFactBytesByPath: ReadonlyMap<string, number>;
  readonly files: readonly Pick<CodeGraphInventoryFile, 'path' | 'size'>[];
  readonly maxCachedFactBytes?: number;
  readonly maxFiles?: number;
  readonly maxSourceBytes?: number;
  readonly modifiedPaths: readonly string[];
  readonly projects: readonly CodeGraphWorkspaceProject[];
  readonly seedProjectIds: readonly string[];
  readonly workspaceDiagnostics: readonly string[];
}

export type ProjectIncrementalClosureSelectionInput = Omit<
  ProjectIncrementalClosureInput,
  'cachedFactBytesByPath' | 'maxCachedFactBytes'
>;

export type ProjectIncrementalClosureSelection =
  | Omit<Extract<ProjectIncrementalClosurePlan, {readonly mode: 'eligible'}>, 'cachedFactBytes'>
  | Extract<ProjectIncrementalClosurePlan, {readonly mode: 'fallback'}>;

export type ProjectClosureSeedAssessment =
  | {
      readonly mode: 'eligible';
      readonly planningOperations: {
        readonly ownershipChecks: number;
        readonly pathIndexProjects: number;
      };
      readonly seedProjectIds: readonly string[];
    }
  | {
      readonly mode: 'fallback';
      readonly reason: 'dynamic-aliases' | 'project-closure-incomplete' | 'resolution-surface-changed';
    };

export function planProjectIncrementalClosure(input: ProjectIncrementalClosureInput): ProjectIncrementalClosurePlan {
  const selection = selectProjectIncrementalClosure(input);
  if (selection.mode === 'fallback') return selection;
  const maxCachedFactBytes = input.maxCachedFactBytes ?? PROJECT_INCREMENTAL_CLOSURE_MAX_CACHED_FACT_BYTES;
  let cachedFactBytes = 0;
  for (const path of selection.affectedPaths) {
    const factBytes = input.cachedFactBytesByPath.get(path);
    if (factBytes === undefined || !Number.isSafeInteger(factBytes) || factBytes < 0) {
      return {mode: 'fallback', reason: 'cache-incomplete'};
    }
    cachedFactBytes = saturatingAdd(cachedFactBytes, factBytes);
    if (cachedFactBytes > maxCachedFactBytes) return unboundedPlan();
  }
  return {...selection, cachedFactBytes};
}

/**
 * Plans the smallest project-local resolution closure that contains every seed.
 * The planner consumes metadata only: parser facts are decoded after this result
 * has proven the existing single-batch materialization bounds.
 */
export function selectProjectIncrementalClosure(
  input: ProjectIncrementalClosureSelectionInput,
): ProjectIncrementalClosureSelection {
  if (input.workspaceDiagnostics.length > 0) return incompletePlan();
  const projectsById = new Map<string, CodeGraphWorkspaceProject>();
  for (const project of input.projects) {
    if (projectsById.has(project.id)) return incompletePlan();
    projectsById.set(project.id, project);
  }
  if (!hasCompleteDeclaredDependencyModel(input.projects, projectsById)) return incompletePlan();

  const seedProjectIds = uniqueSorted(input.seedProjectIds);
  if (seedProjectIds.length === 0 || seedProjectIds.some(id => !projectsById.has(id))) return incompletePlan();
  const reverseDependencies = new Map<string, string[]>();
  let dependencyEdges = 0;
  for (const project of input.projects) {
    for (const dependencyId of project.dependencies) {
      dependencyEdges += 1;
      const dependency = projectsById.get(dependencyId)!;
      if (dependency.resolutionDomain !== project.resolutionDomain) continue;
      const dependents = reverseDependencies.get(dependencyId);
      if (dependents) dependents.push(project.id);
      else reverseDependencies.set(dependencyId, [project.id]);
    }
  }
  for (const dependents of reverseDependencies.values()) dependents.sort(compareCodeUnits);

  const closure = new Set(seedProjectIds);
  const queue = [...seedProjectIds];
  for (let offset = 0; offset < queue.length; offset += 1) {
    for (const dependentId of reverseDependencies.get(queue[offset]!) ?? []) {
      if (closure.has(dependentId)) continue;
      closure.add(dependentId);
      queue.push(dependentId);
    }
  }
  const projectIds = [...closure].sort(compareCodeUnits);
  if (
    projectIds.some(id => {
      const project = projectsById.get(id)!;
      return project.provenance !== 'declared' || project.buildSystem === 'inferred' || project.diagnostics.length > 0;
    })
  ) {
    return incompletePlan();
  }

  const indexesByDomain = projectPathIndexesByDomain(input.projects);
  const affected = new Set(input.modifiedPaths);
  let pathOwnershipChecks = 0;
  for (const file of input.files) {
    for (const [domain, indexes] of indexesByDomain) {
      pathOwnershipChecks += 1;
      const owner = nearestProject(indexes, file.path);
      if (owner.mode === 'ambiguous') return incompletePlan();
      if (owner.projectId !== undefined && closure.has(owner.projectId)) {
        const project = projectsById.get(owner.projectId);
        if (
          !project ||
          project.resolutionDomain !== domain ||
          project.provenance !== 'declared' ||
          project.buildSystem === 'inferred' ||
          project.diagnostics.length > 0
        ) {
          return incompletePlan();
        }
        affected.add(file.path);
      }
    }
  }

  const filesByPath = new Map(input.files.map(file => [file.path, file]));
  const affectedPaths = [...affected].sort(compareCodeUnits);
  if (affectedPaths.some(path => !filesByPath.has(path))) return incompletePlan();
  const maxFiles = input.maxFiles ?? PROJECT_INCREMENTAL_CLOSURE_MAX_FILES;
  const maxSourceBytes = input.maxSourceBytes ?? PROJECT_INCREMENTAL_CLOSURE_MAX_SOURCE_BYTES;
  if (affectedPaths.length > maxFiles) return unboundedPlan();

  let sourceBytes = 0;
  for (const path of affectedPaths) {
    const size = filesByPath.get(path)!.size;
    if (!Number.isSafeInteger(size) || size < 0) return incompletePlan();
    sourceBytes = saturatingAdd(sourceBytes, size);
    if (sourceBytes > maxSourceBytes) return unboundedPlan();
  }
  return {
    affectedPaths,
    mode: 'eligible',
    planningOperations: {dependencyEdges, pathOwnershipChecks},
    projectIds,
    sourceBytes,
  };
}

/**
 * Determines whether changed facts may expand from the changed-file resolver to
 * project closure. Global symbol identity is immutable; only arity and lookup
 * keys owned by one declared project may differ. Static reexports seed their
 * owning project, while every other alias form fails closed.
 */
export function assessProjectClosureSeeds(input: {
  readonly committedFacts: readonly CodeGraphFileFacts[];
  readonly effectiveFacts: readonly CodeGraphFileFacts[];
  readonly projects: readonly CodeGraphWorkspaceProject[];
}): ProjectClosureSeedAssessment {
  const projectsById = new Map<string, CodeGraphWorkspaceProject>();
  for (const project of input.projects) {
    if (projectsById.has(project.id)) return incompleteSeeds();
    projectsById.set(project.id, project);
  }
  if (!hasCompleteDeclaredDependencyModel(input.projects, projectsById)) return incompleteSeeds();
  const indexesByDomain = projectPathIndexesByDomain(input.projects);
  let ownershipChecks = 0;

  const committedByPath = uniqueFactsByPath(input.committedFacts);
  const effectiveByPath = uniqueFactsByPath(input.effectiveFacts);
  if (
    committedByPath === undefined ||
    effectiveByPath === undefined ||
    committedByPath.size !== effectiveByPath.size ||
    [...committedByPath.keys()].some(path => !effectiveByPath.has(path))
  ) {
    return {mode: 'fallback', reason: 'resolution-surface-changed'};
  }

  const seeds = new Set<string>();
  for (const facts of [...input.committedFacts, ...input.effectiveFacts]) {
    for (const reference of facts.references ?? []) {
      if ((reference.aliasLookupKeys?.length ?? 0) === 0) continue;
      ownershipChecks += 1;
      const project = declaredProjectForPath(
        projectsById,
        indexesByDomain,
        reference.evidencePath,
        reference.resolutionDomain,
      );
      if (
        reference.relation !== 'reexports' ||
        project.mode !== 'unique' ||
        !reference.aliasLookupKeys!.every(key => isOwnedLookupKey(key, project.project))
      ) {
        return {
          mode: 'fallback',
          reason: reference.relation === 'reexports' ? 'project-closure-incomplete' : 'dynamic-aliases',
        };
      }
      seeds.add(project.project.id);
    }
  }

  const committedSymbols = uniqueSymbols(input.committedFacts.flatMap(file => file.symbols));
  const effectiveSymbols = uniqueSymbols(input.effectiveFacts.flatMap(file => file.symbols));
  if (
    committedSymbols === undefined ||
    effectiveSymbols === undefined ||
    committedSymbols.size !== effectiveSymbols.size ||
    [...committedSymbols.keys()].some(id => !effectiveSymbols.has(id))
  ) {
    return {mode: 'fallback', reason: 'resolution-surface-changed'};
  }
  for (const [id, left] of committedSymbols) {
    const right = effectiveSymbols.get(id)!;
    if (!hasSameGlobalSymbolSurface(left, right)) {
      return {mode: 'fallback', reason: 'resolution-surface-changed'};
    }
    const arityChanged = left.arity !== right.arity;
    const lookupChanged = !sameStrings(left.lookupKeys ?? [], right.lookupKeys ?? []);
    if (!arityChanged && !lookupChanged) continue;
    ownershipChecks += 1;
    const project = declaredProjectForPath(projectsById, indexesByDomain, right.path, right.resolutionDomain);
    if (
      project.mode !== 'unique' ||
      left.resolutionScopeId !== project.project.id ||
      right.resolutionScopeId !== project.project.id
    ) {
      return {mode: 'fallback', reason: 'project-closure-incomplete'};
    }
    if (lookupChanged) {
      const leftGlobal = (left.lookupKeys ?? []).filter(key => !isOwnedLookupKey(key, project.project));
      const rightGlobal = (right.lookupKeys ?? []).filter(key => !isOwnedLookupKey(key, project.project));
      if (!sameStrings(leftGlobal, rightGlobal)) {
        return {mode: 'fallback', reason: 'resolution-surface-changed'};
      }
    }
    seeds.add(project.project.id);
  }
  return {
    mode: 'eligible',
    planningOperations: {ownershipChecks, pathIndexProjects: input.projects.length},
    seedProjectIds: [...seeds].sort(compareCodeUnits),
  };
}

interface ProjectPathIndexes {
  readonly roots: ReadonlyMap<string, readonly string[]>;
  readonly sourceRoots: ReadonlyMap<string, readonly string[]>;
}

function projectPathIndexesByDomain(
  projects: readonly CodeGraphWorkspaceProject[],
): ReadonlyMap<string, ProjectPathIndexes> {
  const indexesByDomain = new Map<
    string,
    {readonly roots: Map<string, string[]>; readonly sourceRoots: Map<string, string[]>}
  >();
  const add = (index: Map<string, string[]>, root: string, id: string) => {
    const values = index.get(root);
    if (values) {
      if (!values.includes(id)) values.push(id);
    } else index.set(root, [id]);
  };
  for (const project of projects) {
    let indexes = indexesByDomain.get(project.resolutionDomain);
    if (!indexes) {
      indexes = {roots: new Map(), sourceRoots: new Map()};
      indexesByDomain.set(project.resolutionDomain, indexes);
    }
    add(indexes.roots, project.root, project.id);
    for (const root of project.sourceRoots) add(indexes.sourceRoots, root, project.id);
  }
  for (const indexes of indexesByDomain.values()) {
    for (const values of [...indexes.roots.values(), ...indexes.sourceRoots.values()]) values.sort(compareCodeUnits);
  }
  return indexesByDomain;
}

function nearestProject(
  indexes: ProjectPathIndexes,
  path: string,
): {readonly mode: 'ambiguous' | 'unique'; readonly projectId?: string} {
  const source = nearestPrefix(indexes.sourceRoots, path);
  if (source !== undefined) return source.length === 1 ? {mode: 'unique', projectId: source[0]} : {mode: 'ambiguous'};
  const root = nearestPrefix(indexes.roots, path);
  if (root !== undefined) return root.length === 1 ? {mode: 'unique', projectId: root[0]} : {mode: 'ambiguous'};
  return {mode: 'unique'};
}

function nearestPrefix(index: ReadonlyMap<string, readonly string[]>, path: string): readonly string[] | undefined {
  let prefix = path;
  for (;;) {
    const values = index.get(prefix);
    if (values !== undefined) return values;
    const separator = prefix.lastIndexOf('/');
    if (separator < 0) return index.get('');
    prefix = prefix.slice(0, separator);
  }
}

function declaredProjectForPath(
  projectsById: ReadonlyMap<string, CodeGraphWorkspaceProject>,
  indexesByDomain: ReadonlyMap<string, ProjectPathIndexes>,
  path: string,
  resolutionDomain: string | undefined,
): {readonly mode: 'incomplete'} | {readonly mode: 'unique'; readonly project: CodeGraphWorkspaceProject} {
  if (resolutionDomain === undefined) return {mode: 'incomplete'};
  const indexes = indexesByDomain.get(resolutionDomain);
  if (!indexes) return {mode: 'incomplete'};
  const owner = nearestProject(indexes, path);
  if (owner.mode !== 'unique' || owner.projectId === undefined) return {mode: 'incomplete'};
  const project = projectsById.get(owner.projectId);
  if (
    !project ||
    project.provenance !== 'declared' ||
    project.buildSystem === 'inferred' ||
    project.diagnostics.length > 0
  ) {
    return {mode: 'incomplete'};
  }
  return {mode: 'unique', project};
}

function hasCompleteDeclaredDependencyModel(
  projects: readonly CodeGraphWorkspaceProject[],
  projectsById: ReadonlyMap<string, CodeGraphWorkspaceProject>,
): boolean {
  for (const project of projects) {
    const dependencies = new Set(project.dependencies);
    const detailedTargets = new Set(project.dependencyDetails.map(dependency => dependency.targetId));
    if (
      dependencies.size !== project.dependencies.length ||
      detailedTargets.size !== project.dependencyDetails.length ||
      !sameStrings([...dependencies], [...detailedTargets]) ||
      project.dependencyDetails.some(dependency => dependency.provenance !== 'declared') ||
      [...dependencies].some(id => !projectsById.has(id))
    ) {
      return false;
    }
  }
  return true;
}

function hasSameGlobalSymbolSurface(left: CodeGraphSymbol, right: CodeGraphSymbol): boolean {
  return (
    left.id === right.id &&
    left.exported === right.exported &&
    left.kind === right.kind &&
    left.language === right.language &&
    left.name === right.name &&
    left.packageName === right.packageName &&
    left.path === right.path &&
    left.qualifiedName === right.qualifiedName &&
    left.resolutionDomain === right.resolutionDomain &&
    left.resolutionScopeId === right.resolutionScopeId
  );
}

function isOwnedLookupKey(key: string, project: CodeGraphWorkspaceProject): boolean {
  return key.startsWith(`${project.resolutionDomain}:${project.id}:`);
}

function uniqueFactsByPath(facts: readonly CodeGraphFileFacts[]): ReadonlyMap<string, CodeGraphFileFacts> | undefined {
  const output = new Map<string, CodeGraphFileFacts>();
  for (const fact of facts) {
    if (output.has(fact.path)) return undefined;
    output.set(fact.path, fact);
  }
  return output;
}

function uniqueSymbols(symbols: readonly CodeGraphSymbol[]): ReadonlyMap<string, CodeGraphSymbol> | undefined {
  const output = new Map<string, CodeGraphSymbol>();
  for (const symbol of symbols) {
    if (output.has(symbol.id)) return undefined;
    output.set(symbol.id, symbol);
  }
  return output;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = uniqueSorted(left);
  const normalizedRight = uniqueSorted(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function incompletePlan(): Extract<ProjectIncrementalClosurePlan, {readonly mode: 'fallback'}> {
  return {mode: 'fallback', reason: 'project-closure-incomplete'};
}

function unboundedPlan(): Extract<ProjectIncrementalClosurePlan, {readonly mode: 'fallback'}> {
  return {mode: 'fallback', reason: 'project-closure-unbounded'};
}

function incompleteSeeds(): Extract<ProjectClosureSeedAssessment, {readonly mode: 'fallback'}> {
  return {mode: 'fallback', reason: 'project-closure-incomplete'};
}
