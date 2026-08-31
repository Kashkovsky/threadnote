import {Effect} from 'effect';
import {createRepositoryFactAttributor} from './extractor.js';
import {finalCodeGraphFactBatches} from './fact_budget.js';
import {
  type ProjectResolutionLookupKey,
  type ProjectResolutionReexportCandidate,
  PROJECT_INCREMENTAL_CLOSURE_MAX_FILES,
  PROJECT_INCREMENTAL_CLOSURE_MAX_SOURCE_BYTES,
} from './incremental_closure.js';
import {assessCodeGraphIncrementalFactBytes, codeGraphIncrementalFactBatchesFitBudget} from './incremental_work.js';
import {cachedFactsMetadata, loadCachedFacts} from './indexer_materialization.js';
import type {IncrementalOverlayPreassessment} from './indexer_types.js';
import type {CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import type {CodeGraphWorkspace} from './languages/types.js';
import type {CodeGraphLayout} from './layout.js';
import {compareCodeUnits} from './ordering.js';
import {type CodeGraphReusableReexport, type CodeGraphReusableReexportSeed, type CodeGraphStoreShape} from './store.js';
import {CODE_GRAPH_RESOLUTION_PASS_MAXIMUM} from './store_resolution.js';
import {
  planProjectResolutionCandidateScan,
  PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES,
  scanProjectResolutionCandidateClosure,
  type ProjectResolutionCandidateClosure,
  type ProjectResolutionCandidateScanPlan,
  type ProjectResolutionReexportKeys,
} from './store_resolution_candidate_closure.js';
import type {
  CodeGraphFileFacts,
  CodeGraphEdge,
  CodeGraphInventoryFile,
  CodeGraphOverlayFallbackBoundary,
  CodeGraphReference,
} from './types.js';
import {createWorkspaceAttributor} from './workspace.js';

export const assessResolutionCandidateIncrementalClosure = Effect.fn(
  'codeGraph.assessResolutionCandidateIncrementalClosure',
)(function* (input: {
  readonly baseAttributionContext?: {
    readonly files: readonly CodeGraphInventoryFile[];
    readonly workspace: CodeGraphWorkspace;
  };
  readonly baseFileSetFingerprint: string;
  readonly baseFiles: readonly CodeGraphInventoryFile[];
  readonly candidateReexports: readonly ProjectResolutionReexportCandidate[];
  readonly committedWorkspace: CodeGraphWorkspace;
  readonly currentChangedFiles: readonly CodeGraphInventoryFile[];
  readonly currentFiles: readonly CodeGraphInventoryFile[];
  readonly currentWorkspace: CodeGraphWorkspace;
  readonly initialLookupKeys: readonly ProjectResolutionLookupKey[];
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly layout: CodeGraphLayout;
  readonly projectCount: number;
  readonly store: CodeGraphStoreShape;
}) {
  if (input.baseFiles.length > PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES) {
    return projectClosureBoundFallback(
      input.currentChangedFiles.length,
      {metric: 'candidate-scan-files', stage: 'resolution-candidate-scan'},
      input.baseFiles.length,
      PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES,
    );
  }
  const metadata = yield* cachedFactsMetadata(
    input.store,
    input.layout.databasePath,
    input.baseFiles,
    input.languagePacks,
  );
  if (metadata.files !== input.baseFiles.length || metadata.bytesByPath.size !== input.baseFiles.length) {
    return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
  }
  const plan = planProjectResolutionCandidateScan({bytesByPath: metadata.bytesByPath, files: input.baseFiles});
  if (plan.mode === 'fallback') return resolutionCandidateScanFallback(plan, input.currentChangedFiles.length);

  const attributeBaseFacts = createFactsAttributor(
    input.baseAttributionContext?.files ?? input.baseFiles,
    input.baseAttributionContext?.workspace ?? input.committedWorkspace,
  );
  const scan = yield* scanProjectResolutionCandidateClosure({
    additionalReexports: input.candidateReexports,
    initialLookupKeys: input.initialLookupKeys,
    maximumSelectedFiles: PROJECT_INCREMENTAL_CLOSURE_MAX_FILES,
    plan,
    loadPage: (files: readonly CodeGraphInventoryFile[]) =>
      loadCachedFacts(input.store, input.layout.databasePath, files, input.languagePacks).pipe(
        Effect.map(loaded => {
          const rawFacts = files.flatMap(file => {
            const facts = loaded.facts.get(file.path);
            return facts === undefined ? [] : [input.languagePacks.postprocessFile(file, facts)];
          });
          return {
            bytesByPath: loaded.bytesByPath,
            facts: new Map(attributeBaseFacts(rawFacts).map(facts => [facts.path, facts])),
          };
        }),
      ),
  });
  if (scan.mode === 'fallback') return resolutionCandidateScanFallback(scan, input.currentChangedFiles.length);

  const selectedPaths = new Set([...scan.paths, ...input.currentChangedFiles.map(file => file.path)]);
  const stagedAliasIdentities = new Set(
    [...scan.reexports.filter(reexport => selectedPaths.has(reexport.sourcePath)), ...input.candidateReexports].flatMap(
      reexport => reexport.aliases.map(alias => `${alias.resolutionDomain}\0${alias.key}`),
    ),
  );
  if ([...scan.directAliasSymbolConflictIdentities].some(identity => stagedAliasIdentities.has(identity))) {
    return {mode: 'fallback', reason: 'project-closure-incomplete'} satisfies IncrementalOverlayPreassessment;
  }

  const currentByPath = new Map(input.currentFiles.map(file => [file.path, file]));
  const selectedFiles = [...selectedPaths]
    .sort(compareCodeUnits)
    .map(path => currentByPath.get(path))
    .filter((file): file is CodeGraphInventoryFile => file !== undefined);
  if (selectedFiles.length !== selectedPaths.size) {
    return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
  }
  return yield* assessSelectedResolutionCandidateClosure({...input, scan, selectedFiles});
});

const assessSelectedResolutionCandidateClosure = Effect.fn('codeGraph.assessSelectedResolutionCandidateClosure')(
  function* (input: {
    readonly baseFileSetFingerprint: string;
    readonly changedFiles?: number;
    readonly committedWorkspace: CodeGraphWorkspace;
    readonly currentChangedFiles: readonly CodeGraphInventoryFile[];
    readonly currentFiles: readonly CodeGraphInventoryFile[];
    readonly currentWorkspace: CodeGraphWorkspace;
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
    readonly layout: CodeGraphLayout;
    readonly projectCount: number;
    readonly scan: Extract<ProjectResolutionCandidateClosure, {readonly mode: 'eligible'}>;
    readonly selectedFiles: readonly CodeGraphInventoryFile[];
    readonly store: CodeGraphStoreShape;
  }) {
    const changedFiles = input.currentChangedFiles.length;
    if (input.selectedFiles.length > PROJECT_INCREMENTAL_CLOSURE_MAX_FILES) {
      return projectClosureBoundFallback(
        changedFiles,
        {metric: 'candidate-selected-files', stage: 'resolution-candidate-rewrite'},
        input.selectedFiles.length,
        PROJECT_INCREMENTAL_CLOSURE_MAX_FILES,
      );
    }
    const sourceBytes = input.selectedFiles.reduce((total, file) => total + file.size, 0);
    if (sourceBytes > PROJECT_INCREMENTAL_CLOSURE_MAX_SOURCE_BYTES) {
      return projectClosureBoundFallback(
        changedFiles,
        {metric: 'source-bytes', stage: 'resolution-candidate-rewrite'},
        sourceBytes,
        PROJECT_INCREMENTAL_CLOSURE_MAX_SOURCE_BYTES,
      );
    }
    const metadata = yield* cachedFactsMetadata(
      input.store,
      input.layout.databasePath,
      input.selectedFiles,
      input.languagePacks,
    );
    if (metadata.files !== input.selectedFiles.length || metadata.bytesByPath.size !== input.selectedFiles.length) {
      return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
    }
    const metadataBudget = assessCodeGraphIncrementalFactBytes({
      aggregateBytes: metadata.bytes,
      factBytes: metadata.bytesByPath.values(),
    });
    if (metadataBudget.mode === 'invalid') {
      return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
    }
    if (metadataBudget.mode === 'exceeded') {
      return projectClosureBoundFallback(
        changedFiles,
        {metric: 'cached-fact-bytes', stage: 'resolution-candidate-rewrite'},
        metadataBudget.observedAtDecision,
        metadataBudget.limit,
      );
    }
    const loaded = yield* loadCachedFacts(
      input.store,
      input.layout.databasePath,
      input.selectedFiles,
      input.languagePacks,
    );
    if (input.selectedFiles.some(file => !loaded.facts.has(file.path))) {
      return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
    }
    const rawFacts = input.selectedFiles.map(file =>
      input.languagePacks.postprocessFile(file, loaded.facts.get(file.path)!),
    );
    const attributedFacts = createFactsAttributor(input.currentFiles, input.currentWorkspace)(rawFacts);
    const facts = enrichResolutionCandidateFacts(
      attributedFacts,
      input.scan.affectedAliasLookupIdentities,
      input.scan.reexports,
      input.scan.directAliasSymbolConflictIdentities,
      new Set(input.selectedFiles.map(file => file.path)),
    );
    if (facts === undefined) {
      return {mode: 'fallback', reason: 'project-closure-incomplete'} satisfies IncrementalOverlayPreassessment;
    }
    if (!codeGraphIncrementalFactBatchesFitBudget(finalCodeGraphFactBatches(facts))) {
      return {mode: 'fallback', reason: 'fact-budget-expanded'} satisfies IncrementalOverlayPreassessment;
    }
    return {
      baseFileSetFingerprint: input.baseFileSetFingerprint,
      closureProjects: input.projectCount,
      committedWorkspace: input.committedWorkspace,
      facts,
      files: input.selectedFiles,
      mode: 'compatible',
      proportionalWork: {
        attributionContextFiles: input.scan.scannedFiles,
        baseFactsLoaded: input.selectedFiles.length,
        inventoryFilesInspected: input.currentFiles.length,
        probedDependencyPaths: 0,
      },
      resolutionClosure: 'project',
    } satisfies IncrementalOverlayPreassessment;
  },
);

function createFactsAttributor(
  files: readonly CodeGraphInventoryFile[],
  workspace: CodeGraphWorkspace,
): (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[] {
  const attributeRepository = createRepositoryFactAttributor(files);
  const attributeWorkspace = createWorkspaceAttributor(workspace);
  return facts => attributeWorkspace(attributeRepository(facts));
}

function resolutionCandidateScanFallback(
  fallback: Extract<
    ProjectResolutionCandidateClosure | ProjectResolutionCandidateScanPlan,
    {readonly mode: 'fallback'}
  >,
  changedFiles: number,
): Extract<IncrementalOverlayPreassessment, {readonly mode: 'fallback'}> {
  if (fallback.reason === 'cache-incomplete') return {mode: 'fallback', reason: 'cache-incomplete'};
  return projectClosureBoundFallback(
    changedFiles,
    {metric: fallback.detail, stage: 'resolution-candidate-scan'},
    fallback.observed,
    fallback.limit,
  );
}

type FallbackBoundaryKind = CodeGraphOverlayFallbackBoundary extends infer Boundary
  ? Boundary extends CodeGraphOverlayFallbackBoundary
    ? Pick<Boundary, 'metric' | 'stage'>
    : never
  : never;

function projectClosureBoundFallback(
  changedFiles: number,
  boundary: FallbackBoundaryKind,
  observedAtDecision: number,
  limit: number,
): Extract<IncrementalOverlayPreassessment, {readonly mode: 'fallback'}> {
  return {
    fallbackBoundary: {changedFiles, limit, observedAtDecision, ...boundary},
    mode: 'fallback',
    reason: 'project-closure-unbounded',
  };
}

export function reusableReexportSeeds(facts: readonly CodeGraphFileFacts[]): readonly CodeGraphReusableReexportSeed[] {
  const seeds = facts.flatMap(file =>
    (file.references ?? []).flatMap(reference =>
      reference.resolutionDomain === 'typescript' && isPersistedReexportEnrichableRelation(reference.relation)
        ? reference.lookupTiers.flatMap(tier => tier.flatMap(parseTypeScriptPathNameLookupKey))
        : [],
    ),
  );
  return uniqueByKey(seeds, seed => `${seed.path}\0${seed.name}`);
}

/**
 * Resolve selected consumers against CURRENT effective reexport provenance
 * before persisted-delta staging. Delta publishes aliases iteratively, so
 * allowing a selected consumer to see a newly staged alias only after its
 * earlier tiers were deleted would diverge from full materialization.
 */
function enrichResolutionCandidateFacts(
  facts: readonly CodeGraphFileFacts[],
  affectedAliasLookupIdentities: ReadonlySet<string>,
  baseReexports: readonly ProjectResolutionReexportKeys[],
  directAliasSymbolConflictIdentities: ReadonlySet<string>,
  selectedPaths: ReadonlySet<string>,
): readonly CodeGraphFileFacts[] | undefined {
  const currentReferences = facts.flatMap(file => file.references ?? []).filter(isStaticReexportReference);
  if (currentReferences.some(reference => reference.resolutionDomain !== 'typescript')) return undefined;
  const currentReexports = currentReferences.map(reexportKeysFromReference);
  const stagedAliasLookupIdentities = new Set(
    currentReexports.flatMap(reexport => reexport.aliases.map(alias => `${alias.resolutionDomain}\0${alias.key}`)),
  );
  const safetyAliasIdentities = new Set([...affectedAliasLookupIdentities, ...stagedAliasLookupIdentities]);
  if (
    facts.some(file =>
      file.symbols.some(symbol =>
        (symbol.lookupKeys ?? []).some(key =>
          safetyAliasIdentities.has(`${lookupKeyDomain(key, symbol.resolutionDomain)}\0${key}`),
        ),
      ),
    )
  ) {
    return undefined;
  }
  const retainedBase = baseReexports.filter(
    reexport =>
      !selectedPaths.has(reexport.sourcePath) &&
      [...reexport.aliases, ...reexport.candidates].every(value => value.resolutionDomain === 'typescript'),
  );
  if (
    assessResolutionCandidateReexportSafety({
      directAliasSymbolConflictIdentities,
      reexports: [...retainedBase, ...currentReexports],
      safetyAliasLookupIdentities: safetyAliasIdentities,
      stagedAliasLookupIdentities,
    }).mode === 'fallback'
  ) {
    return undefined;
  }
  const effective = boundedReusableReexportsFromKeys([...retainedBase, ...currentReexports]);
  return effective === undefined ? undefined : enrichPersistedTypeScriptReexports(facts, effective);
}

function isStaticReexportReference(reference: CodeGraphReference): boolean {
  return reference.relation === 'reexports' && (reference.aliasLookupKeys?.length ?? 0) > 0;
}

function reexportKeysFromReference(reference: CodeGraphReference): ProjectResolutionReexportKeys {
  return {
    aliases: (reference.aliasLookupKeys ?? []).map(key => ({key, resolutionDomain: 'typescript'})),
    candidates: reference.lookupTiers.flatMap(tier =>
      tier.map(key => ({key, resolutionDomain: reference.resolutionDomain})),
    ),
    sourcePath: reference.evidencePath,
  };
}

export type ResolutionCandidateReexportSafety =
  | {readonly mode: 'eligible'; readonly stagedDepthMaximum: number}
  | {
      readonly mode: 'fallback';
      readonly reason:
        | 'alias-cycle'
        | 'direct-symbol-conflict'
        | 'non-functional-alias'
        | 'staged-depth-unbounded'
        | 'unparseable-alias';
    };

export function assessResolutionCandidateReexportSafety(input: {
  readonly directAliasSymbolConflictIdentities: ReadonlySet<string>;
  readonly reexports: readonly ProjectResolutionReexportKeys[];
  readonly safetyAliasLookupIdentities: ReadonlySet<string>;
  readonly stagedAliasLookupIdentities: ReadonlySet<string>;
}): ResolutionCandidateReexportSafety {
  // A reexport describes the Cartesian relation from every alias to every
  // candidate, but safety needs only to distinguish one target from more than
  // one. Retaining that reduced state keeps broad malformed/ambiguous records
  // linear in their encoded keys instead of materializing aliases*candidates.
  const targetByAlias = new Map<string, string | undefined>();
  const rawIdentitiesByAlias = new Map<string, Set<string>>();
  const safetyAliases = new Set<string>();
  const stagedAliases = new Set<string>();
  for (const reexport of input.reexports) {
    const aliases = reexport.aliases.flatMap(alias =>
      parseTypeScriptPathNameLookupKey(alias.key).map(value => ({alias, value})),
    );
    const candidates = reexport.candidates.flatMap(candidate =>
      parseTypeScriptPathNameLookupKey(candidate.key).map(value => ({candidate, value})),
    );
    if (aliases.length === 0 || candidates.length === 0) {
      return {mode: 'fallback', reason: 'unparseable-alias'};
    }
    const candidateIdentities = new Set(
      candidates.map(({candidate, value}) =>
        normalizedResolutionIdentity(candidate.resolutionDomain, value.path, value.name),
      ),
    );
    const candidateTarget = candidateIdentities.size === 1 ? candidateIdentities.values().next().value : undefined;
    for (const {alias, value} of aliases) {
      const aliasIdentity = normalizedResolutionIdentity(alias.resolutionDomain, value.path, value.name);
      const rawIdentity = `${alias.resolutionDomain}\0${alias.key}`;
      if (input.safetyAliasLookupIdentities.has(rawIdentity)) safetyAliases.add(aliasIdentity);
      if (input.stagedAliasLookupIdentities.has(rawIdentity)) stagedAliases.add(aliasIdentity);
      const rawIdentities = rawIdentitiesByAlias.get(aliasIdentity) ?? new Set<string>();
      rawIdentities.add(rawIdentity);
      rawIdentitiesByAlias.set(aliasIdentity, rawIdentities);
      if (!targetByAlias.has(aliasIdentity)) {
        targetByAlias.set(aliasIdentity, candidateTarget);
      } else if (targetByAlias.get(aliasIdentity) !== candidateTarget) {
        targetByAlias.set(aliasIdentity, undefined);
      }
    }
  }
  const completedDepth = new Map<string, number>();
  let stagedDepthMaximum = 0;
  for (const root of safetyAliases) {
    const path: string[] = [];
    const pathAliases = new Set<string>();
    let alias = root;
    let forwardDepth: number | undefined;
    while (forwardDepth === undefined) {
      const completed = completedDepth.get(alias);
      if (completed !== undefined) {
        forwardDepth = completed;
        break;
      }
      if (pathAliases.has(alias)) return {mode: 'fallback', reason: 'alias-cycle'};
      for (const rawIdentity of rawIdentitiesByAlias.get(alias) ?? []) {
        if (input.directAliasSymbolConflictIdentities.has(rawIdentity)) {
          return {mode: 'fallback', reason: 'direct-symbol-conflict'};
        }
      }
      if (!targetByAlias.has(alias)) {
        forwardDepth = 0;
        break;
      }
      const target = targetByAlias.get(alias);
      if (target === undefined) return {mode: 'fallback', reason: 'non-functional-alias'};
      path.push(alias);
      pathAliases.add(alias);
      alias = target;
    }
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const pathAlias = path[index]!;
      forwardDepth += Number(stagedAliases.has(pathAlias));
      completedDepth.set(pathAlias, forwardDepth);
    }
    if (forwardDepth > CODE_GRAPH_RESOLUTION_PASS_MAXIMUM) {
      return {mode: 'fallback', reason: 'staged-depth-unbounded'};
    }
    stagedDepthMaximum = Math.max(stagedDepthMaximum, forwardDepth);
  }
  return {mode: 'eligible', stagedDepthMaximum};
}

function normalizedResolutionIdentity(resolutionDomain: string, path: string, name: string): string {
  return `${resolutionDomain}\0${path}\0${name}`;
}

export const PERSISTED_REEXPORT_PROVENANCE_MAX_ROWS = 40_000;

/**
 * Parse effective reexport provenance without allowing encoded key lists to
 * expand into an unbounded Cartesian product. The row budget conservatively
 * counts per-record unique alias/target pair attempts; duplicates within a
 * record cannot consume memory before the guard is evaluated.
 */
export function boundedReusableReexportsFromKeys(
  reexports: readonly ProjectResolutionReexportKeys[],
  maximumRows = PERSISTED_REEXPORT_PROVENANCE_MAX_ROWS,
): readonly CodeGraphReusableReexport[] | undefined {
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 0) return undefined;
  const output = new Map<string, CodeGraphReusableReexport>();
  let attemptedRows = 0;
  for (const reexport of reexports) {
    const parsed = parsedReusableReexportKeys(reexport);
    if (parsed === undefined) return undefined;
    if (
      parsed.candidates.length > 0 &&
      parsed.aliases.length > Math.floor((maximumRows - attemptedRows) / parsed.candidates.length)
    ) {
      return undefined;
    }
    attemptedRows += parsed.aliases.length * parsed.candidates.length;
    for (const alias of parsed.aliases) {
      for (const candidate of parsed.candidates) {
        const value = {
          importedName: candidate.name,
          localName: alias.name,
          sourcePath: alias.path,
          targetPath: candidate.path,
        };
        const key = reusableReexportKey(value);
        if (!output.has(key)) output.set(key, value);
      }
    }
  }
  return [...output.values()];
}

function parsedReusableReexportKeys(reexport: ProjectResolutionReexportKeys):
  | {
      readonly aliases: readonly CodeGraphReusableReexportSeed[];
      readonly candidates: readonly CodeGraphReusableReexportSeed[];
    }
  | undefined {
  const parsedAliases = reexport.aliases.map(value => parseTypeScriptPathNameLookupKey(value.key));
  const parsedCandidates = reexport.candidates.map(value => parseTypeScriptPathNameLookupKey(value.key));
  if (parsedAliases.some(values => values.length === 0) || parsedCandidates.some(values => values.length === 0)) {
    return undefined;
  }
  return {
    aliases: uniqueByKey(parsedAliases.flat(), reusableReexportSeedKey),
    candidates: uniqueByKey(parsedCandidates.flat(), reusableReexportSeedKey),
  };
}

export function enrichPersistedTypeScriptReexports(
  facts: readonly CodeGraphFileFacts[],
  reexports: readonly CodeGraphReusableReexport[],
): readonly CodeGraphFileFacts[] | undefined {
  if (reexports.length === 0) return facts;
  const provenance = new Map<string, CodeGraphReusableReexport[]>();
  for (const reexport of reexports) {
    const key = `${reexport.sourcePath}\0${reexport.localName}`;
    const values = provenance.get(key) ?? [];
    values.push(reexport);
    provenance.set(key, values);
  }
  const terminalResolver = createPersistedReexportTerminalResolver(provenance);
  const enriched = facts.map(file => {
    if (!file.references) return file;
    return {
      ...file,
      references: file.references.map(reference =>
        enrichPersistedTypeScriptReference(reference, provenance, terminalResolver),
      ),
    };
  });
  return terminalResolver.exhausted() ? undefined : enriched;
}

function enrichPersistedTypeScriptReference(
  reference: CodeGraphReference,
  provenance: ReadonlyMap<string, readonly CodeGraphReusableReexport[]>,
  terminalResolver: PersistedReexportTerminalResolver,
): CodeGraphReference {
  if (reference.resolutionDomain !== 'typescript' || !isPersistedReexportEnrichableRelation(reference.relation)) {
    return reference;
  }
  const parsedTargets = reference.lookupTiers.flatMap(tier => tier.flatMap(parseTypeScriptPathNameLookupTarget));
  if (!parsedTargets.some(target => provenance.has(`${target.path}\0${target.name}`))) return reference;
  return {
    ...reference,
    lookupTiers: reference.lookupTiers
      .map(tier =>
        uniqueStrings(
          tier.flatMap(key => {
            const parsed = parseTypeScriptPathNameLookupTarget(key);
            if (parsed.length === 0) return [key];
            return parsed.flatMap(target =>
              (terminalResolver.resolve(target) ?? []).map(
                terminal =>
                  `${target.lookupPrefix}path:${encodeURIComponent(terminal.path)}:name:${encodeURIComponent(terminal.name)}${target.lookupSuffix}`,
              ),
            );
          }),
        ),
      )
      .filter(tier => tier.length > 0),
  };
}

function isPersistedReexportEnrichableRelation(relation: CodeGraphEdge['relation']): boolean {
  return ['calls', 'constructs', 'exports', 'extends', 'implements', 'overrides', 'references'].includes(relation);
}

const PERSISTED_REEXPORT_ENRICHMENT_MAX_OPERATIONS = PERSISTED_REEXPORT_PROVENANCE_MAX_ROWS;
const PERSISTED_REEXPORT_ENRICHMENT_MAX_TERMINALS = 10_000;

type PersistedReexportTerminalTraversal =
  | {readonly mode: 'complete'; readonly operations: number; readonly targets: readonly CodeGraphReusableReexportSeed[]}
  | {readonly mode: 'fallback'; readonly reason: 'reexport-closure-unbounded'};

interface PersistedReexportTerminalResolver {
  readonly exhausted: () => boolean;
  readonly resolve: (target: CodeGraphReusableReexportSeed) => readonly CodeGraphReusableReexportSeed[] | undefined;
}

function createPersistedReexportTerminalResolver(
  provenance: ReadonlyMap<string, readonly CodeGraphReusableReexport[]>,
): PersistedReexportTerminalResolver {
  const cache = new Map<string, readonly CodeGraphReusableReexportSeed[]>();
  let operationsRemaining = PERSISTED_REEXPORT_ENRICHMENT_MAX_OPERATIONS;
  let traversalExhausted = false;
  return {
    exhausted: () => traversalExhausted,
    resolve: target => {
      const key = reusableReexportSeedKey(target);
      const cached = cache.get(key);
      if (cached) return cached;
      if (traversalExhausted) return undefined;
      const traversal = resolvePersistedReexportTerminals(target, provenance, {
        maxOperations: operationsRemaining,
        maxTerminals: PERSISTED_REEXPORT_ENRICHMENT_MAX_TERMINALS,
      });
      if (traversal.mode === 'fallback') {
        traversalExhausted = true;
        return undefined;
      }
      operationsRemaining -= traversal.operations;
      cache.set(key, traversal.targets);
      return traversal.targets;
    },
  };
}

export function resolvePersistedReexportTerminals(
  target: CodeGraphReusableReexportSeed,
  provenance: ReadonlyMap<string, readonly CodeGraphReusableReexport[]>,
  options: {readonly maxOperations?: number; readonly maxTerminals?: number} = {},
): PersistedReexportTerminalTraversal {
  const maxOperations = options.maxOperations ?? PERSISTED_REEXPORT_ENRICHMENT_MAX_OPERATIONS;
  const maxTerminals = options.maxTerminals ?? PERSISTED_REEXPORT_ENRICHMENT_MAX_TERMINALS;
  if (
    !Number.isSafeInteger(maxOperations) ||
    maxOperations < 0 ||
    !Number.isSafeInteger(maxTerminals) ||
    maxTerminals < 0
  ) {
    return {mode: 'fallback', reason: 'reexport-closure-unbounded'};
  }
  const discovered = new Set([reusableReexportSeedKey(target)]);
  const pending = [target];
  const terminals = new Map<string, CodeGraphReusableReexportSeed>();
  let operations = 0;
  const consumeOperation = (): boolean => {
    if (operations >= maxOperations) return false;
    operations += 1;
    return true;
  };
  while (pending.length > 0) {
    if (!consumeOperation()) return {mode: 'fallback', reason: 'reexport-closure-unbounded'};
    const current = pending.pop()!;
    const next = [...(provenance.get(reusableReexportSeedKey(current)) ?? [])].sort((left, right) =>
      compareCodeUnits(reusableReexportKey(left), reusableReexportKey(right)),
    );
    if (next.length === 0) {
      terminals.set(reusableReexportSeedKey(current), current);
      if (terminals.size > maxTerminals) return {mode: 'fallback', reason: 'reexport-closure-unbounded'};
      continue;
    }
    for (let index = next.length - 1; index >= 0; index -= 1) {
      if (!consumeOperation()) return {mode: 'fallback', reason: 'reexport-closure-unbounded'};
      const reexport = next[index]!;
      const candidate = {name: reexport.importedName, path: reexport.targetPath};
      const key = reusableReexportSeedKey(candidate);
      if (discovered.has(key)) continue;
      discovered.add(key);
      pending.push(candidate);
    }
  }
  if (terminals.size === 0) terminals.set(reusableReexportSeedKey(target), target);
  return {
    mode: 'complete',
    operations,
    targets: [...terminals.values()].sort((left, right) =>
      compareCodeUnits(reusableReexportSeedKey(left), reusableReexportSeedKey(right)),
    ),
  };
}

function reusableReexportSeedKey(value: CodeGraphReusableReexportSeed): string {
  return `${value.path}\0${value.name}`;
}

function reusableReexportKey(value: CodeGraphReusableReexport): string {
  return `${value.sourcePath}\0${value.localName}\0${value.targetPath}\0${value.importedName}`;
}

function lookupKeyDomain(key: string, fallback: string | undefined): string {
  const separator = key.indexOf(':');
  return separator > 0 ? key.slice(0, separator) : (fallback ?? 'generic');
}

function parseTypeScriptPathNameLookupKey(value: string): readonly CodeGraphReusableReexportSeed[] {
  return parseTypeScriptPathNameLookupTarget(value).map(({name, path}) => ({name, path}));
}

interface TypeScriptPathNameLookupTarget extends CodeGraphReusableReexportSeed {
  readonly lookupPrefix: string;
  readonly lookupSuffix: string;
}

function parseTypeScriptPathNameLookupTarget(value: string): readonly TypeScriptPathNameLookupTarget[] {
  const match =
    /^typescript:((?:[^:]+:)?)path:([^:]+):name:([^:]+)(:(?:arity:\d+|implementation|merge-canonical))?$/.exec(value);
  if (!match) return [];
  try {
    return [
      {
        lookupPrefix: `typescript:${match[1]!}`,
        lookupSuffix: match[4] ?? '',
        name: decodeURIComponent(match[3]!),
        path: decodeURIComponent(match[2]!),
      },
    ];
  } catch {
    return [];
  }
}

function uniqueByKey<A>(values: readonly A[], keyOf: (value: A) => string): readonly A[] {
  const output = new Map<string, A>();
  for (const value of values) {
    const key = keyOf(value);
    if (!output.has(key)) output.set(key, value);
  }
  return [...output.values()];
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
