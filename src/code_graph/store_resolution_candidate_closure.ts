import {Effect} from 'effect';
import type {ProjectResolutionLookupKey} from './incremental_closure.js';
import {compareCodeUnits} from './ordering.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphReference} from './types.js';

/** Two complete scan passes must stay within the 10,000-file incremental attribution-work ceiling. */
export const PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES = 5_000;
/**
 * Pages keep resident memory near 1 MiB; this bound limits aggregate decoded
 * work across each scan pass. Real repositories can produce roughly 8x as
 * many cached-fact bytes as source bytes, so 256 MiB keeps ordinary exported
 * TypeScript edits incremental without making the scan unbounded.
 */
export const PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES = 256 * 1_048_576;
export const PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FILES = 32;
export const PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FACT_BYTES = 1_048_576;
export const PROJECT_RESOLUTION_CANDIDATE_MAX_LOOKUP_KEYS = 4_096;
export const PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS = 10_000;
export const PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES = 8 * 1_048_576;

export type ProjectResolutionCandidateScanFallbackDetail =
  | 'candidate-lookup-keys'
  | 'candidate-reexport-key-bytes'
  | 'candidate-reexports'
  | 'candidate-scan-fact-bytes'
  | 'candidate-scan-files'
  | 'candidate-selected-files';

export interface ProjectResolutionCandidateScanPage {
  readonly factBytes: number;
  readonly files: readonly CodeGraphInventoryFile[];
}

export type ProjectResolutionCandidateScanPlan =
  | {
      readonly factBytes: number;
      readonly files: number;
      readonly mode: 'eligible';
      readonly pages: readonly ProjectResolutionCandidateScanPage[];
    }
  | {
      readonly detail: 'candidate-scan-fact-bytes' | 'candidate-scan-files';
      readonly limit: number;
      readonly mode: 'fallback';
      readonly observed: number;
      readonly reason: 'project-closure-unbounded';
    }
  | {
      readonly mode: 'fallback';
      readonly reason: 'cache-incomplete';
    };

export type ProjectResolutionCandidateClosure =
  | {
      readonly affectedAliasLookupIdentities: ReadonlySet<string>;
      readonly directAliasSymbolConflictIdentities: ReadonlySet<string>;
      readonly factBytes: number;
      readonly lookupKeys: number;
      readonly mode: 'eligible';
      readonly paths: readonly string[];
      readonly reexports: readonly ProjectResolutionReexportKeys[];
      readonly scannedFiles: number;
    }
  | {
      readonly mode: 'fallback';
      readonly reason: 'cache-incomplete';
    }
  | {
      readonly detail: ProjectResolutionCandidateScanFallbackDetail;
      readonly limit: number;
      readonly mode: 'fallback';
      readonly observed: number;
      readonly reason: 'project-closure-unbounded';
    };

export interface ProjectResolutionCandidateFactPage {
  readonly bytesByPath: ReadonlyMap<string, number>;
  readonly facts: ReadonlyMap<string, CodeGraphFileFacts>;
}

export function planProjectResolutionCandidateScan(input: {
  readonly bytesByPath: ReadonlyMap<string, number>;
  readonly files: readonly CodeGraphInventoryFile[];
  readonly maximumFactBytes?: number;
  readonly maximumFiles?: number;
  readonly pageMaximumFactBytes?: number;
  readonly pageMaximumFiles?: number;
}): ProjectResolutionCandidateScanPlan {
  const maximumFiles = input.maximumFiles ?? PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES;
  const maximumFactBytes = input.maximumFactBytes ?? PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES;
  const pageMaximumFiles = input.pageMaximumFiles ?? PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FILES;
  const pageMaximumFactBytes = input.pageMaximumFactBytes ?? PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FACT_BYTES;
  if (
    !isNonNegativeSafeInteger(maximumFiles) ||
    !isNonNegativeSafeInteger(maximumFactBytes) ||
    !isPositiveSafeInteger(pageMaximumFiles) ||
    !isPositiveSafeInteger(pageMaximumFactBytes) ||
    new Set(input.files.map(file => file.path)).size !== input.files.length
  ) {
    return {mode: 'fallback', reason: 'cache-incomplete'};
  }
  if (input.files.length > maximumFiles) {
    return {
      detail: 'candidate-scan-files',
      limit: maximumFiles,
      mode: 'fallback',
      observed: input.files.length,
      reason: 'project-closure-unbounded',
    };
  }
  const ordered = [...input.files].sort((left, right) => compareCodeUnits(left.path, right.path));
  const pages: ProjectResolutionCandidateScanPage[] = [];
  let page: CodeGraphInventoryFile[] = [];
  let pageBytes = 0;
  let factBytes = 0;
  for (const file of ordered) {
    const bytes = input.bytesByPath.get(file.path);
    if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) {
      return {mode: 'fallback', reason: 'cache-incomplete'};
    }
    if (factBytes > maximumFactBytes - bytes) {
      return {
        detail: 'candidate-scan-fact-bytes',
        limit: maximumFactBytes,
        mode: 'fallback',
        observed: factBytes + bytes,
        reason: 'project-closure-unbounded',
      };
    }
    const pageFull = page.length > 0 && (page.length >= pageMaximumFiles || pageBytes > pageMaximumFactBytes - bytes);
    if (pageFull) {
      pages.push({factBytes: pageBytes, files: page});
      page = [];
      pageBytes = 0;
    }
    page.push(file);
    pageBytes += bytes;
    factBytes += bytes;
  }
  if (page.length > 0) pages.push({factBytes: pageBytes, files: page});
  return {factBytes, files: ordered.length, mode: 'eligible', pages};
}

/**
 * Find the complete bounded set of cached base references whose resolver
 * candidates can be affected by changed published lookup keys. The first
 * streaming pass retains only static reexport key mappings; the second retains
 * only matching reference-evidence paths. Each page must already be
 * attributed to immediate repository/workspace lookup keys. Repository facts
 * are never retained between pages.
 */
export const scanProjectResolutionCandidateClosure = Effect.fn('codeGraph.scanProjectResolutionCandidateClosure')(
  function* <E>(input: {
    readonly maximumSelectedFiles: number;
    readonly plan: Extract<ProjectResolutionCandidateScanPlan, {readonly mode: 'eligible'}>;
    readonly initialLookupKeys: readonly ProjectResolutionLookupKey[];
    readonly additionalReexports?: readonly ProjectResolutionReexportKeys[];
    readonly loadPage: (
      files: readonly CodeGraphInventoryFile[],
    ) => Effect.Effect<ProjectResolutionCandidateFactPage, E>;
  }) {
    if (
      input.initialLookupKeys.some(value => !validResolutionLookupKey(value)) ||
      !isNonNegativeSafeInteger(input.maximumSelectedFiles)
    ) {
      return {mode: 'fallback', reason: 'cache-incomplete'} as const;
    }
    const initialLookupKeys = uniqueResolutionLookupKeys(input.initialLookupKeys);
    if (initialLookupKeys.length > PROJECT_RESOLUTION_CANDIDATE_MAX_LOOKUP_KEYS) {
      return unbounded('candidate-lookup-keys', initialLookupKeys.length, PROJECT_RESOLUTION_CANDIDATE_MAX_LOOKUP_KEYS);
    }
    const reexports: ProjectResolutionReexportKeys[] = [];
    const baseReexports: ProjectResolutionReexportKeys[] = [];
    let reexportKeyBytes = 0;
    for (const reexport of input.additionalReexports ?? []) {
      const retained = retainReexport(reexport, reexports.length, reexportKeyBytes);
      if (retained.mode === 'fallback') return retained;
      reexports.push(retained.reexport);
      reexportKeyBytes = retained.totalKeyBytes;
    }
    for (const page of input.plan.pages) {
      const loaded = yield* input.loadPage(page.files);
      if (!completePage(page, loaded)) return {mode: 'fallback', reason: 'cache-incomplete'} as const;
      for (const file of page.files) {
        const facts = loaded.facts.get(file.path)!;
        if (!validFactLookupKeys(facts)) return {mode: 'fallback', reason: 'cache-incomplete'} as const;
        for (const reference of facts.references ?? []) {
          if (!isReexport(reference)) continue;
          const aliases = symbolResolutionLookupKeys(reference.resolutionDomain, reference.aliasLookupKeys ?? []);
          const candidates = resolutionLookupKeys(reference.resolutionDomain, reference.lookupTiers.flat());
          const retained = retainReexport(
            {aliases, candidates, sourcePath: reference.evidencePath},
            reexports.length,
            reexportKeyBytes,
          );
          if (retained.mode === 'fallback') return retained;
          reexports.push(retained.reexport);
          baseReexports.push(retained.reexport);
          reexportKeyBytes = retained.totalKeyBytes;
        }
      }
    }
    const lookupKeys = resolutionCandidateLookupKeyClosure(initialLookupKeys, reexports);
    if (lookupKeys.mode === 'fallback') return lookupKeys;

    const selectedPaths = new Set<string>();
    const allAliasIdentities = new Set(
      reexports.flatMap(reexport =>
        reexport.aliases.map(alias => resolutionLookupKeyIdentity(alias.resolutionDomain, alias.key)),
      ),
    );
    const directAliasSymbolConflictIdentities = new Set<string>();
    for (const page of input.plan.pages) {
      const loaded = yield* input.loadPage(page.files);
      if (!completePage(page, loaded)) return {mode: 'fallback', reason: 'cache-incomplete'} as const;
      for (const file of page.files) {
        const facts = loaded.facts.get(file.path)!;
        if (!validFactLookupKeys(facts)) return {mode: 'fallback', reason: 'cache-incomplete'} as const;
        for (const symbol of facts.symbols) {
          for (const key of symbol.lookupKeys ?? []) {
            const identity = resolutionLookupKeyIdentity(lookupKeyDomain(key, symbol.resolutionDomain), key);
            if (allAliasIdentities.has(identity)) directAliasSymbolConflictIdentities.add(identity);
          }
        }
        if (!facts.references?.some(reference => referenceMatches(reference, lookupKeys.identities))) {
          continue;
        }
        selectedPaths.add(file.path);
        if (selectedPaths.size > input.maximumSelectedFiles) {
          return unbounded('candidate-selected-files', selectedPaths.size, input.maximumSelectedFiles);
        }
      }
    }
    return {
      affectedAliasLookupIdentities: lookupKeys.aliasIdentities,
      directAliasSymbolConflictIdentities,
      factBytes: input.plan.factBytes,
      lookupKeys: lookupKeys.identities.size,
      mode: 'eligible',
      paths: [...selectedPaths].sort(compareCodeUnits),
      reexports: baseReexports,
      scannedFiles: input.plan.files,
    } as const;
  },
);

export type ProjectResolutionReexportKeys = {
  readonly aliases: readonly ProjectResolutionLookupKey[];
  readonly candidates: readonly ProjectResolutionLookupKey[];
  readonly sourcePath: string;
};

export function resolutionCandidateLookupKeyClosure(
  initialLookupKeys: readonly ProjectResolutionLookupKey[],
  reexports: readonly ProjectResolutionReexportKeys[],
  maximumLookupKeys = PROJECT_RESOLUTION_CANDIDATE_MAX_LOOKUP_KEYS,
):
  | {
      readonly aliasIdentities: ReadonlySet<string>;
      readonly identities: ReadonlySet<string>;
      readonly mode: 'eligible';
    }
  | Extract<ProjectResolutionCandidateClosure, {readonly mode: 'fallback'}> {
  if (
    !isNonNegativeSafeInteger(maximumLookupKeys) ||
    initialLookupKeys.some(value => !validResolutionLookupKey(value)) ||
    reexports.some(reexport =>
      [...reexport.aliases, ...reexport.candidates].some(value => !validResolutionLookupKey(value)),
    )
  ) {
    return {mode: 'fallback', reason: 'cache-incomplete'};
  }
  // A reexport is a hyperedge: reaching any candidate reaches every alias.
  // Index candidates to the hyperedge rather than materializing the full
  // candidates*aliases Cartesian product. The encoded-key byte cap alone does
  // not bound that product for one broad reexport.
  const aliasesByReexport: Map<string, ProjectResolutionLookupKey>[] = [];
  const reexportsByCandidate = new Map<string, number[]>();
  for (const reexport of reexports) {
    const resolutionDomain = reexport.candidates[0]?.resolutionDomain;
    if (
      resolutionDomain !== undefined &&
      reexport.aliases.length > 0 &&
      (reexport.aliases.some(alias => alias.resolutionDomain !== resolutionDomain) ||
        reexport.candidates.some(candidate => candidate.resolutionDomain !== resolutionDomain))
    ) {
      return {mode: 'fallback', reason: 'cache-incomplete'};
    }
    const reexportIndex = aliasesByReexport.length;
    const aliases = new Map<string, ProjectResolutionLookupKey>();
    for (const alias of reexport.aliases) {
      aliases.set(resolutionLookupKeyIdentity(alias.resolutionDomain, alias.key), alias);
    }
    aliasesByReexport.push(aliases);
    const candidateIdentities = new Set<string>();
    for (const candidate of reexport.candidates) {
      const candidateIdentity = resolutionLookupKeyIdentity(candidate.resolutionDomain, candidate.key);
      if (candidateIdentities.has(candidateIdentity)) continue;
      candidateIdentities.add(candidateIdentity);
      const indexed = reexportsByCandidate.get(candidateIdentity) ?? [];
      indexed.push(reexportIndex);
      reexportsByCandidate.set(candidateIdentity, indexed);
    }
  }
  const initial = uniqueResolutionLookupKeys(initialLookupKeys);
  const keys = new Map(initial.map(value => [resolutionLookupKeyIdentity(value.resolutionDomain, value.key), value]));
  if (keys.size > maximumLookupKeys) return unbounded('candidate-lookup-keys', keys.size, maximumLookupKeys);
  const queue = [...keys.values()];
  const aliasIdentities = new Set<string>();
  const expandedReexports = new Set<number>();
  for (let offset = 0; offset < queue.length; offset += 1) {
    const current = queue[offset]!;
    for (const reexportIndex of reexportsByCandidate.get(
      resolutionLookupKeyIdentity(current.resolutionDomain, current.key),
    ) ?? []) {
      if (expandedReexports.has(reexportIndex)) continue;
      expandedReexports.add(reexportIndex);
      for (const [identity, alias] of aliasesByReexport[reexportIndex]!) {
        if (keys.has(identity)) continue;
        keys.set(identity, alias);
        aliasIdentities.add(identity);
        if (keys.size > maximumLookupKeys) return unbounded('candidate-lookup-keys', keys.size, maximumLookupKeys);
        queue.push(alias);
      }
    }
  }
  for (const reexport of reexports) {
    for (const alias of reexport.aliases) {
      const identity = resolutionLookupKeyIdentity(alias.resolutionDomain, alias.key);
      if (keys.has(identity)) aliasIdentities.add(identity);
    }
  }
  return {aliasIdentities, identities: new Set(keys.keys()), mode: 'eligible'};
}

function retainReexport(
  reexport: ProjectResolutionReexportKeys,
  retainedCount: number,
  retainedKeyBytes: number,
):
  | {readonly mode: 'eligible'; readonly reexport: ProjectResolutionReexportKeys; readonly totalKeyBytes: number}
  | Extract<ProjectResolutionCandidateClosure, {readonly mode: 'fallback'}> {
  const resolutionDomain = reexport.aliases[0]?.resolutionDomain;
  if (
    retainedCount >= PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS ||
    [...reexport.aliases, ...reexport.candidates].some(value => !validResolutionLookupKey(value)) ||
    resolutionDomain === undefined ||
    reexport.candidates.length === 0 ||
    reexport.sourcePath.length === 0 ||
    reexport.aliases.some(alias => alias.resolutionDomain !== resolutionDomain) ||
    reexport.candidates.some(candidate => candidate.resolutionDomain !== resolutionDomain)
  ) {
    return retainedCount >= PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS
      ? unbounded('candidate-reexports', retainedCount + 1, PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS)
      : {mode: 'fallback', reason: 'cache-incomplete'};
  }
  const retainedBytes = utf8Bytes(
    [...reexport.aliases, ...reexport.candidates].flatMap(value => [value.resolutionDomain, value.key]),
  );
  if (retainedKeyBytes > PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES - retainedBytes) {
    return unbounded(
      'candidate-reexport-key-bytes',
      retainedKeyBytes + retainedBytes,
      PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES,
    );
  }
  return {mode: 'eligible', reexport, totalKeyBytes: retainedKeyBytes + retainedBytes};
}

function completePage(page: ProjectResolutionCandidateScanPage, loaded: ProjectResolutionCandidateFactPage): boolean {
  if (loaded.facts.size !== page.files.length || loaded.bytesByPath.size !== page.files.length) return false;
  let bytes = 0;
  for (const file of page.files) {
    const facts = loaded.facts.get(file.path);
    const factBytes = loaded.bytesByPath.get(file.path);
    if (facts?.path !== file.path || factBytes === undefined || !Number.isSafeInteger(factBytes) || factBytes < 0) {
      return false;
    }
    bytes += factBytes;
  }
  return bytes === page.factBytes;
}

function isReexport(reference: CodeGraphReference): boolean {
  return reference.relation === 'reexports' && (reference.aliasLookupKeys?.length ?? 0) > 0;
}

function referenceMatches(reference: CodeGraphReference, lookupKeyIdentities: ReadonlySet<string>): boolean {
  return reference.lookupTiers.some(tier =>
    tier.some(key => lookupKeyIdentities.has(resolutionLookupKeyIdentity(reference.resolutionDomain, key))),
  );
}

function resolutionLookupKeys(resolutionDomain: string, keys: readonly string[]): ProjectResolutionLookupKey[] {
  return uniqueResolutionLookupKeys(keys.map(key => ({key, resolutionDomain})));
}

function symbolResolutionLookupKeys(
  fallbackResolutionDomain: string,
  keys: readonly string[],
): ProjectResolutionLookupKey[] {
  return uniqueResolutionLookupKeys(
    keys.map(key => ({key, resolutionDomain: lookupKeyDomain(key, fallbackResolutionDomain)})),
  );
}

function lookupKeyDomain(key: string, fallback: string | undefined): string {
  const separator = key.indexOf(':');
  return separator > 0 ? key.slice(0, separator) : (fallback ?? 'generic');
}

function uniqueResolutionLookupKeys(values: readonly ProjectResolutionLookupKey[]): ProjectResolutionLookupKey[] {
  const output = new Map<string, ProjectResolutionLookupKey>();
  for (const value of values) {
    if (value.resolutionDomain.length === 0 || value.key.length === 0) continue;
    output.set(resolutionLookupKeyIdentity(value.resolutionDomain, value.key), value);
  }
  return [...output.values()].sort(
    (left, right) =>
      compareCodeUnits(left.resolutionDomain, right.resolutionDomain) || compareCodeUnits(left.key, right.key),
  );
}

function resolutionLookupKeyIdentity(resolutionDomain: string, key: string): string {
  return `${resolutionDomain}\0${key}`;
}

function validFactLookupKeys(facts: CodeGraphFileFacts): boolean {
  return (facts.references ?? []).every(reference =>
    [...(reference.aliasLookupKeys ?? []), ...reference.lookupTiers.flat()].every(key =>
      validResolutionLookupKey({key, resolutionDomain: reference.resolutionDomain}),
    ),
  );
}

function validResolutionLookupKey(value: {readonly key: string; readonly resolutionDomain?: string}): boolean {
  return (value.resolutionDomain?.length ?? 0) > 0 && value.key.length > 0;
}

function utf8Bytes(values: readonly string[]): number {
  const encoder = new TextEncoder();
  return values.reduce(
    (total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + encoder.encode(value).byteLength),
    0,
  );
}

function unbounded(detail: ProjectResolutionCandidateScanFallbackDetail, observed: number, limit: number) {
  return {detail, limit, mode: 'fallback', observed, reason: 'project-closure-unbounded'} as const;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
