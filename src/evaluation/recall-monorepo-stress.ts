import {recallWorkspaceScopeMatches} from '../recall/index_scope.js';
import {
  deduplicateLogicalRecallCandidates,
  rankRecallCandidates,
  recallMemoryContentHash,
  type RankedRecallSet,
  type RecallCandidate,
} from '../recall/rank.js';

const FIXED_NOW = new Date('2026-08-20T00:00:00.000Z');
const FIXED_TIMESTAMP = FIXED_NOW.toISOString();

export interface MonorepoShareRecallStressOptions {
  readonly logicalMemoriesPerPackage: number;
  readonly packages: number;
  /** Number of team-shared copies in addition to each logical memory's personal copy. */
  readonly shareAliasesPerMemory: number;
  readonly seed: number;
  readonly targetPackage: number;
  readonly topK: number;
}

export interface MonorepoShareRecallStressFixture {
  readonly candidates: readonly RecallCandidate[];
  readonly options: MonorepoShareRecallStressOptions;
  readonly query: string;
  readonly relevantMemoryIds: readonly string[];
  readonly targetWorkspaceScope: string;
}

export type MonorepoShareRecallStressMode = 'full-corpus' | 'workspace-prefiltered';

export interface MonorepoShareRecallStressSummary {
  readonly aliasCompressionRate: number;
  readonly duplicateResultCount: number;
  readonly duplicateResultRate: number;
  readonly logicalCandidates: number;
  readonly mode: MonorepoShareRecallStressMode;
  readonly physicalCandidates: number;
  readonly rankedResults: number;
  readonly relevantHitsAtK: number;
  readonly relevantMemories: number;
  readonly relevantRecallAtK: number;
  readonly topK: number;
  readonly topMemoryIds: readonly string[];
}

export function createMonorepoShareRecallStressFixture(
  options: MonorepoShareRecallStressOptions,
): MonorepoShareRecallStressFixture {
  validateOptions(options);
  const width = Math.max(3, String(options.packages - 1).length);
  const candidates: RecallCandidate[] = [];
  const relevantMemoryId = stressMemoryId(options.targetPackage, 0, width);

  for (let packageIndex = 0; packageIndex < options.packages; packageIndex += 1) {
    const workspaceScope = stressWorkspaceScope(packageIndex, width);
    for (let logicalIndex = 0; logicalIndex < options.logicalMemoriesPerPackage; logicalIndex += 1) {
      const memoryId = stressMemoryId(packageIndex, logicalIndex, width);
      const relevant = logicalIndex === 0;
      const topic = relevant ? 'checkout-retry-contract' : `operational-note-${String(logicalIndex).padStart(3, '0')}`;
      const text = relevant
        ? 'Checkout retry contract uses bounded backoff and deterministic jitter.'
        : `Package operational note ${logicalIndex} covers cache lifecycle and logging.`;
      const common: Omit<RecallCandidate, 'authority' | 'uri'> = {
        contentHash: recallMemoryContentHash(text),
        exactTerms: relevant ? ['checkout', 'retry', 'contract'] : ['cache', 'logging'],
        fields: {
          keywords: relevant ? ['bounded checkout retry'] : ['cache lifecycle logging'],
          project: 'monorepo-stress',
          title: relevant ? 'Checkout retry contract' : `Operational note ${logicalIndex}`,
          topic,
          workspaceScope,
        },
        kind: 'durable',
        memoryId,
        status: 'active',
        text,
        timestamp: FIXED_TIMESTAMP,
        trust: 'approved',
      };
      candidates.push({
        ...common,
        authority: 'user_approved',
        uri: personalMemoryUri(packageIndex, logicalIndex, width),
      });
      for (let shareIndex = 0; shareIndex < options.shareAliasesPerMemory; shareIndex += 1) {
        candidates.push({
          ...common,
          authority: 'reviewed_shared',
          uri: sharedMemoryUri(packageIndex, logicalIndex, shareIndex, width),
        });
      }
    }
  }

  return {
    candidates: deterministicShuffle(candidates, options.seed),
    options: {...options},
    query: 'checkout retry contract',
    relevantMemoryIds: [relevantMemoryId],
    targetWorkspaceScope: stressWorkspaceScope(options.targetPackage, width),
  };
}

export function monorepoShareRecallStressCandidates(
  fixture: MonorepoShareRecallStressFixture,
  mode: MonorepoShareRecallStressMode,
): readonly RecallCandidate[] {
  if (mode === 'full-corpus') return fixture.candidates;
  return fixture.candidates.filter(candidate =>
    recallWorkspaceScopeMatches(fixture.targetWorkspaceScope, candidate.fields?.workspaceScope),
  );
}

export function runMonorepoShareRecallStressPass(
  fixture: MonorepoShareRecallStressFixture,
  candidates: readonly RecallCandidate[],
): RankedRecallSet {
  return rankRecallCandidates(fixture.query, candidates, {
    now: FIXED_NOW,
    project: 'monorepo-stress',
    workspaceScope: fixture.targetWorkspaceScope,
  });
}

export function summarizeMonorepoShareRecallStressPass(
  fixture: MonorepoShareRecallStressFixture,
  mode: MonorepoShareRecallStressMode,
  candidates: readonly RecallCandidate[],
  ranked: RankedRecallSet,
): MonorepoShareRecallStressSummary {
  const logicalCandidates = deduplicateLogicalRecallCandidates(candidates).length;
  const resultMemoryIds = ranked.results.flatMap(result =>
    result.candidate.memoryId === undefined ? [] : [result.candidate.memoryId],
  );
  const duplicateResultCount = resultMemoryIds.length - new Set(resultMemoryIds).size;
  const relevant = new Set(fixture.relevantMemoryIds);
  const topMemoryIds = resultMemoryIds.slice(0, fixture.options.topK);
  const relevantHitsAtK = new Set(topMemoryIds.filter(memoryId => relevant.has(memoryId))).size;
  return {
    aliasCompressionRate: candidates.length === 0 ? 0 : (candidates.length - logicalCandidates) / candidates.length,
    duplicateResultCount,
    duplicateResultRate: resultMemoryIds.length === 0 ? 0 : duplicateResultCount / resultMemoryIds.length,
    logicalCandidates,
    mode,
    physicalCandidates: candidates.length,
    rankedResults: ranked.results.length,
    relevantHitsAtK,
    relevantMemories: relevant.size,
    relevantRecallAtK: relevant.size === 0 ? 1 : relevantHitsAtK / relevant.size,
    topK: fixture.options.topK,
    topMemoryIds,
  };
}

function validateOptions(options: MonorepoShareRecallStressOptions): void {
  for (const [name, value] of [
    ['packages', options.packages],
    ['logicalMemoriesPerPackage', options.logicalMemoriesPerPackage],
    ['seed', options.seed],
    ['topK', options.topK],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  if (!Number.isSafeInteger(options.shareAliasesPerMemory) || options.shareAliasesPerMemory < 0) {
    throw new RangeError('shareAliasesPerMemory must be a non-negative integer');
  }
  if (
    !Number.isSafeInteger(options.targetPackage) ||
    options.targetPackage < 0 ||
    options.targetPackage >= options.packages
  ) {
    throw new RangeError('targetPackage must identify one generated package');
  }
}

function stressWorkspaceScope(packageIndex: number, width: number): string {
  return `apps/package-${String(packageIndex).padStart(width, '0')}`;
}

function stressMemoryId(packageIndex: number, logicalIndex: number, width: number): string {
  return `tn_stress_p${String(packageIndex).padStart(width, '0')}_m${String(logicalIndex).padStart(4, '0')}`;
}

function personalMemoryUri(packageIndex: number, logicalIndex: number, width: number): string {
  return `threadnote://user/benchmark/memories/durable/projects/monorepo-stress/package-${String(packageIndex).padStart(width, '0')}-memory-${String(logicalIndex).padStart(4, '0')}.md`;
}

function sharedMemoryUri(packageIndex: number, logicalIndex: number, shareIndex: number, width: number): string {
  return `threadnote://user/benchmark/memories/shared/team-${String(shareIndex).padStart(2, '0')}/durable/projects/monorepo-stress/package-${String(packageIndex).padStart(width, '0')}-memory-${String(logicalIndex).padStart(4, '0')}.md`;
}

function deterministicShuffle<T>(values: readonly T[], seed: number): readonly T[] {
  const shuffled = [...values];
  let state = seed >>> 0;
  const random = (): number => {
    state += 0x6d2b_79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const replacement = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[replacement]] = [shuffled[replacement]!, shuffled[index]!];
  }
  return shuffled;
}
