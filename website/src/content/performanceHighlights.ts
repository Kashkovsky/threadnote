import intellijAnalysisEvidence from '../../../test/evaluation/candidates/threadnote-4.0.0/benchmarks/darwin-arm64-m1-max/code-graph-intellij-analysis-summary-2026-08-01.json' with {type: 'json'};
import intellijQueryEvidence from '../../../test/evaluation/candidates/threadnote-4.0.0/benchmarks/darwin-arm64-m1-max/code-graph-intellij-query-2026-08-01.json' with {type: 'json'};
import lexicalProductionEvidence from '../../../test/evaluation/candidates/threadnote-4.0.0/benchmarks/darwin-arm64-m1-max/code-graph-lexical-production-100k-2026-08-02.json' with {type: 'json'};
import type {PerformanceControlLanguage} from './performance.js';

const intellijEvidenceCommit = 'b42baea0dfd00d5d9eb38569cce646f26ac16279';
const lexicalEvidenceCommit = '00faf82c0c79141139d8c3181d50956ce7c55c11';
const evidenceDirectory = 'test/evaluation/candidates/threadnote-4.0.0/benchmarks/darwin-arm64-m1-max';

function requireLanguageControl(language: string) {
  const control = intellijQueryEvidence.endToEndResults.mcp.find(candidate => candidate.languageEvidence === language);
  if (!control) throw new Error(`Checked-in performance evidence is missing the ${language} control.`);
  return control;
}

const controlEvidence = {
  java: requireLanguageControl('java'),
  kotlin: requireLanguageControl('kotlin'),
  typescript: requireLanguageControl('typescript'),
  bazel: requireLanguageControl('starlark-bazel'),
} satisfies Record<PerformanceControlLanguage, ReturnType<typeof requireLanguageControl>>;

/**
 * Public, checked-in engineering measurements shown until one comprehensive
 * exact-release artifact is retained. These values are imported from the
 * artifacts themselves so the site cannot silently drift from the evidence.
 */
export const checkedInPerformanceEvidence = {
  measuredAt: intellijQueryEvidence.createdAt,
  source: {
    threadnoteCommit: intellijQueryEvidence.environment.threadnoteBaseCommit,
    threadnoteWorktree: 'development candidate',
    repository: intellijQueryEvidence.fixture.publicRepository,
    repositoryCommit: intellijQueryEvidence.fixture.repositoryCommit,
    runner: `${intellijQueryEvidence.environment.cpu} · ${intellijQueryEvidence.environment.bun}`,
    repositoryCommitUrl: `https://github.com/JetBrains/intellij-community/tree/${intellijQueryEvidence.fixture.repositoryCommit}`,
  },
  scale: {
    indexedFiles: intellijQueryEvidence.fixture.fileCount,
    symbols: intellijQueryEvidence.fixture.symbolCount,
    relationships: intellijQueryEvidence.fixture.edgeCount,
    databaseBytes: intellijQueryEvidence.fixture.databaseBytes,
  },
  query: {
    hotSearchAndAdjacencyMilliseconds: intellijQueryEvidence.queryPlanResults.after.hotCombinedApproximateMilliseconds,
    exactCurrentCliMilliseconds: intellijQueryEvidence.endToEndResults.cli.afterMilliseconds,
    exactCurrentCliSpeedup: intellijQueryEvidence.endToEndResults.cli.speedup,
  },
  analysis: {
    persistedSummaryMinimumMilliseconds:
      intellijAnalysisEvidence.results.persistedExactCurrentStats.analysisDurationMilliseconds[0],
    persistedSummaryMaximumMilliseconds:
      intellijAnalysisEvidence.results.persistedExactCurrentStats.analysisDurationMilliseconds[1],
    legacyMinimumMilliseconds: intellijAnalysisEvidence.results.legacyPagedFallback.reportedWallMillisecondsRange[0],
    legacyMaximumMilliseconds: intellijAnalysisEvidence.results.legacyPagedFallback.reportedWallMillisecondsRange[1],
    durableSummaryBytes: intellijAnalysisEvidence.storage.durableDatabaseByteDelta,
  },
  lexicalStorage: {
    symbols: lexicalProductionEvidence.profile.symbolCount,
    postings: lexicalProductionEvidence.compact.postingRows,
    writeMilliseconds: lexicalProductionEvidence.compact.termWriteMilliseconds,
    queryP50Milliseconds: lexicalProductionEvidence.compact.query.p50Milliseconds,
    allocatedBytes: lexicalProductionEvidence.compact.storage.allocatedBytes,
    storageReductionPercent: lexicalProductionEvidence.reduction.allocatedBytesPercent,
    writeSpeedup: 1 / lexicalProductionEvidence.reduction.compactToLegacyTermWriteRatio,
    parityPassed:
      lexicalProductionEvidence.assertions.canonicalParity &&
      lexicalProductionEvidence.assertions.queryParity &&
      lexicalProductionEvidence.assertions.postingCountParity,
  },
  controls: Object.fromEntries(
    Object.entries(controlEvidence).map(([language, control]) => [
      language,
      {milliseconds: control.elapsedMilliseconds, query: control.query},
    ]),
  ) as Readonly<Record<PerformanceControlLanguage, Readonly<{milliseconds: number; query: string}>>>,
  artifacts: {
    query: `https://github.com/Kashkovsky/threadnote/blob/${intellijEvidenceCommit}/${evidenceDirectory}/code-graph-intellij-query-2026-08-01.json`,
    analysis: `https://github.com/Kashkovsky/threadnote/blob/${intellijEvidenceCommit}/${evidenceDirectory}/code-graph-intellij-analysis-summary-2026-08-01.json`,
    lexicalStorage: `https://github.com/Kashkovsky/threadnote/blob/${lexicalEvidenceCommit}/${evidenceDirectory}/code-graph-lexical-production-100k-2026-08-02.json`,
  },
} as const;
