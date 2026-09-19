import {
  ciLongRunningTestGroups,
  ciRequiredLongRunningTestGroupNames,
  type CiLongRunningTestGroupName,
} from './vitest-plan.js';
import {
  isPurePrivateEvaluationProductCaptureDiff,
  privateEvaluationProductCaptureFocusedTestPath,
} from './private-evaluation-product-capture-scope.js';

export const ciScopeKeys = [
  'actions',
  'build',
  'code',
  'guidance',
  'quality',
  'release',
  'site_check',
  'site_build',
  'windows',
] as const;

export type CiScopeKey = (typeof ciScopeKeys)[number];
export type CiScopes = Readonly<Record<CiScopeKey, boolean>>;

export interface CiScopeClassification {
  readonly changedCount: number;
  readonly invalidPath: boolean;
  readonly paths: readonly string[];
  readonly scopes: CiScopes;
}

export type CiTestSelectionMode = 'full' | 'none' | 'selected';

export interface CiTestPlan {
  readonly standard: {readonly mode: CiTestSelectionMode; readonly paths: readonly string[]};
  readonly long: {readonly mode: CiTestSelectionMode; readonly groups: readonly CiLongRunningTestGroupName[]};
  readonly postgres: {readonly mode: CiTestSelectionMode; readonly paths: readonly string[]};
}

const noScopes = (): Record<CiScopeKey, boolean> => ({
  actions: false,
  build: false,
  code: false,
  guidance: false,
  quality: false,
  release: false,
  site_build: false,
  site_check: false,
  windows: false,
});

const allScopes = (): Record<CiScopeKey, boolean> => ({
  actions: true,
  build: true,
  code: true,
  guidance: true,
  quality: true,
  release: true,
  site_build: true,
  site_check: true,
  windows: true,
});

function selectedScopes(...keys: readonly CiScopeKey[]): Record<CiScopeKey, boolean> {
  const scopes = noScopes();
  for (const key of keys) scopes[key] = true;
  return scopes;
}

function mergeScopes(target: Record<CiScopeKey, boolean>, source: CiScopes): void {
  for (const key of ciScopeKeys) target[key] ||= source[key];
}

function normalizeGitPath(path: string): string | undefined {
  if (path.includes('\\') || path.startsWith('./')) return undefined;
  const normalized = path;
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return normalized;
}

function isDocumentationOnlyPath(path: string): boolean {
  return (
    path === 'LICENSE' ||
    path === 'THIRD_PARTY.md' ||
    path === 'CONTRIBUTION.md' ||
    path === '.gitignore' ||
    path === '.threadnoteignore' ||
    path.startsWith('docs/') ||
    path.startsWith('.github/release-notes/') ||
    (/^[^/]+\.md$/u.test(path) && path !== 'README.md')
  );
}

function isGuidancePath(path: string): boolean {
  return (
    path === 'config/agent-instructions.md' ||
    path === 'docs/agent-instructions.md' ||
    path.startsWith('config/agent-skills/') ||
    path.startsWith('config/agent-profiles/') ||
    path === 'test/unit/agent-instructions.test.ts'
  );
}

function isQualityPath(path: string): boolean {
  return (
    path.startsWith('src/code_graph/') ||
    path.startsWith('src/context_brief/') ||
    path.startsWith('src/crypto/') ||
    path.startsWith('src/effect/ai/') ||
    path.startsWith('src/evaluation/') ||
    path.startsWith('src/models/') ||
    path.startsWith('src/memory/code_citation') ||
    path.startsWith('src/recall/') ||
    path === 'src/effect/command.ts' ||
    path === 'src/effect/digest.ts' ||
    path === 'src/effect/file_lock.ts' ||
    path === 'src/effect/runtime.ts' ||
    path === 'src/effect/system.ts' ||
    path === 'src/search/chunker.ts' ||
    path === 'src/search/vector-index.ts' ||
    path === 'src/search/vector-search.ts' ||
    path === 'src/storage/layout.ts' ||
    path.startsWith('test/evaluation/') ||
    /^test\/(?:integration|unit)\/(?:code-graph|core-embedding|effect-ai|evaluation|manager-graph|model|recall|vector)/u.test(
      path,
    ) ||
    path.startsWith('training/') ||
    /^scripts\/(?:benchmark-(?:code-graph|recall|target|worktree-readiness)|capture-recall|code-graph|evaluate-(?:code-graph|context-brief-citations|recall)|recall-vector-storage-budget|training\/|.*reranker)/u.test(
      path,
    )
  );
}

function isReleaseTestPath(path: string): boolean {
  return (
    path.startsWith('test/e2e/') ||
    /^test\/(?:integration|unit)\/(?:build-code-sanitization|bun-package-contract|command-shim|development-runtime|effect-system|installations|legacy-installation|lifecycle|process-diagnostics|release_notes|update|windows-support)/u.test(
      path,
    ) ||
    path === 'vitest.e2e.config.ts' ||
    path === 'vitest.windows-e2e.config.ts'
  );
}

function scopesForWorkflow(path: string): CiScopes {
  if (path === '.github/workflows/ci.yml') return allScopes();
  if (path === '.github/workflows/pages.yml') {
    return selectedScopes('actions', 'site_check', 'site_build');
  }
  if (path === '.github/workflows/benchmarks.yml' || path === '.github/workflows/production-large-evidence.yml') {
    return selectedScopes('actions', 'quality');
  }
  if (
    path === '.github/workflows/publish.yml' ||
    path === '.github/workflows/publish-release-assets.yml' ||
    path === '.github/workflows/release-evidence.yml'
  ) {
    return selectedScopes('actions', 'release');
  }
  return allScopes();
}

function scopesForScript(path: string): CiScopes {
  if (path === 'scripts/lint-file-length.ts') {
    return selectedScopes('code', 'site_check');
  }
  if (path === 'scripts/site-performance-evidence.ts') {
    return selectedScopes('code', 'site_check', 'site_build');
  }
  if (path.startsWith('scripts/effect/')) {
    return selectedScopes('code', 'quality', 'release', 'windows');
  }
  if (path === 'scripts/generate-code-graph-language-catalog.ts') {
    return selectedScopes('code', 'quality', 'release', 'windows');
  }
  if (isQualityPath(path)) return selectedScopes('code', 'quality');
  if (
    /^scripts\/(?:archive-release|build|check-self-contained|clean|compile-targets|development-runtime|install|install-local-standalone|release-targets|smoke-self-contained)\.(?:plist|ps1|sh|ts)$/u.test(
      path,
    ) ||
    path === 'scripts/macos-entitlements.plist'
  ) {
    return selectedScopes('code', 'release', 'windows');
  }
  return allScopes();
}

function scopesForPath(path: string): CiScopes {
  if (path.startsWith('website/')) return selectedScopes('site_check', 'site_build');
  if (
    path === 'test/unit/website-content.test.ts' ||
    path === 'test/unit/website-release-boundary.test.ts' ||
    path === 'test/unit/website-site-meta.test.ts'
  ) {
    return selectedScopes('site_check', 'site_build');
  }
  if (
    /^test\/evaluation\/candidates\/threadnote-4\.0\.[01]\/benchmarks\/darwin-arm64-m1-max\/(?:code-graph-(?:intellij-(?:analysis-summary|query)|lexical-production-100k|worktree-readiness)-.*\.json)$/u.test(
      path,
    )
  ) {
    return selectedScopes('site_check', 'site_build');
  }
  if (path === 'README.md') return selectedScopes('site_check');
  if (isGuidancePath(path)) return selectedScopes('guidance');
  if (isDocumentationOnlyPath(path)) return noScopes();

  if (path.startsWith('.github/workflows/')) return scopesForWorkflow(path);
  if (path.startsWith('.github/')) return allScopes();
  if (path.startsWith('scripts/')) return scopesForScript(path);
  if (path === 'test/ci/ci-scopes.ts') return allScopes();

  if (path === 'package.json' || path === 'bun.lock' || path === '.npmrc') return allScopes();
  if (path === 'tsconfig.json') return selectedScopes('code', 'release', 'windows');
  if (path === 'vitest.config.ts') return selectedScopes('code');
  if (path === 'vitest.e2e.config.ts' || path === 'vitest.windows-e2e.config.ts') {
    return selectedScopes('code', 'release', 'windows');
  }
  if (
    path === '.oxlintrc.json' ||
    path === '.oxlintrc.strict.json' ||
    path === '.oxlintrc.max-lines.json' ||
    path === '.prettierrc.json' ||
    path === '.prettierignore'
  ) {
    return selectedScopes('code', 'site_check');
  }
  if (path.startsWith('.husky/')) return selectedScopes('code');

  if (path.startsWith('src/')) {
    const scopes = selectedScopes('code', 'release', 'windows');
    if (isQualityPath(path)) scopes.quality = true;
    if (path === 'src/evaluation/benchmark.ts') {
      scopes.site_check = true;
      scopes.site_build = true;
    }
    return scopes;
  }
  if (path.startsWith('assets/') || path.startsWith('config/') || path.startsWith('manager/')) {
    return selectedScopes('code', 'release', 'windows');
  }
  if (path.startsWith('training/')) return selectedScopes('code', 'quality');
  if (path.startsWith('test/')) {
    const scopes = selectedScopes('code');
    if (isQualityPath(path)) scopes.quality = true;
    if (isReleaseTestPath(path)) {
      scopes.release = true;
      scopes.windows = true;
    }
    return scopes;
  }

  return allScopes();
}

export function classifyCiScopes(paths: Iterable<string>): CiScopeClassification {
  const normalizedPaths = new Set<string>();
  const scopes = noScopes();
  let invalidPath = false;

  for (const path of paths) {
    const normalized = normalizeGitPath(path);
    if (!normalized) {
      invalidPath = true;
      continue;
    }
    normalizedPaths.add(normalized);
  }

  const sortedPaths = [...normalizedPaths].sort((left, right) => left.localeCompare(right));
  if (invalidPath || sortedPaths.length === 0)
    return {changedCount: sortedPaths.length, invalidPath, paths: sortedPaths, scopes: allScopes()};

  if (isPurePrivateEvaluationProductCaptureDiff(sortedPaths)) {
    return {changedCount: sortedPaths.length, invalidPath, paths: sortedPaths, scopes: selectedScopes('build', 'code')};
  }

  for (const path of sortedPaths) mergeScopes(scopes, scopesForPath(path));
  return {changedCount: sortedPaths.length, invalidPath, paths: sortedPaths, scopes};
}

export function isOrdinaryCiTestPath(path: string): boolean {
  return /^test\/(?:unit|integration)\/[A-Za-z0-9._-]+\.test\.ts$/u.test(path);
}

function isPostgresTestPath(path: string): boolean {
  return /^test\/integration\/remote-memory-[^/]+\.test\.ts$/u.test(path);
}

function selectedLongGroups(paths: readonly string[]): readonly CiLongRunningTestGroupName[] {
  const changed = new Set(paths);
  return (Object.keys(ciLongRunningTestGroups) as CiLongRunningTestGroupName[]).filter(group =>
    ciLongRunningTestGroups[group].some(path => changed.has(path)),
  );
}

export function selectCiTestPlanForClassification(classification: CiScopeClassification): CiTestPlan {
  const none: CiTestPlan = {
    standard: {mode: 'none', paths: []},
    long: {mode: 'none', groups: []},
    postgres: {mode: 'none', paths: []},
  };
  if (!classification.scopes.code) return none;

  if (!classification.invalidPath && isPurePrivateEvaluationProductCaptureDiff(classification.paths)) {
    return {
      standard: {mode: 'selected', paths: [privateEvaluationProductCaptureFocusedTestPath]},
      long: {mode: 'none', groups: []},
      postgres: {mode: 'none', paths: []},
    };
  }

  const isSelective =
    !classification.invalidPath &&
    classification.paths.length > 0 &&
    classification.paths.every(path => {
      const normalized = normalizeGitPath(path);
      return Boolean(normalized && isOrdinaryCiTestPath(normalized) && scopesForPath(normalized).code);
    });
  if (!isSelective) {
    return {
      standard: {mode: 'full', paths: []},
      long: {mode: 'full', groups: ciRequiredLongRunningTestGroupNames},
      postgres: {mode: 'full', paths: []},
    };
  }

  const longGroups = selectedLongGroups(classification.paths);
  const longPaths = new Set<string>();
  for (const group of longGroups) for (const path of ciLongRunningTestGroups[group]) longPaths.add(path);
  const postgresPaths = classification.paths.filter(isPostgresTestPath);
  const standardPaths = classification.paths.filter(path => !longPaths.has(path));
  return {
    standard: standardPaths.length > 0 ? {mode: 'selected', paths: standardPaths} : {mode: 'none', paths: []},
    long: longGroups.length > 0 ? {mode: 'selected', groups: longGroups} : {mode: 'none', groups: []},
    postgres: postgresPaths.length > 0 ? {mode: 'selected', paths: postgresPaths} : {mode: 'none', paths: []},
  };
}

export function selectCiTestPlan(paths: Iterable<string>): CiTestPlan {
  const inputPaths = [...paths];
  return selectCiTestPlanForClassification(classifyCiScopes(inputPaths));
}

function commitArgument(name: '--base' | '--head'): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

function isCommitId(value: string | undefined): value is string {
  return Boolean(value && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(value) && !/^0+$/u.test(value));
}

function classifyCurrentDiff(
  base: string | undefined,
  head: string | undefined,
): {
  readonly classification: CiScopeClassification;
  readonly reason: string;
} {
  if (!isCommitId(base) || !isCommitId(head)) {
    return {classification: classifyCiScopes([]), reason: 'missing-or-invalid-commit-range'};
  }
  const result = Bun.spawnSync({
    cmd: ['git', 'diff', '--name-only', '-z', '--no-renames', `${base}...${head}`, '--'],
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) {
    return {classification: classifyCiScopes([]), reason: `git-diff-failed-${result.exitCode}`};
  }
  const paths = new TextDecoder().decode(result.stdout).split('\0').filter(Boolean);
  return {classification: classifyCiScopes(paths), reason: paths.length === 0 ? 'empty-diff-fail-safe' : 'classified'};
}

async function writeGitHubOutputs(classification: CiScopeClassification, reason: string): Promise<void> {
  const testPlan = selectCiTestPlanForClassification(classification);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    const lines = [
      ...ciScopeKeys.map(key => `${key}=${String(classification.scopes[key])}`),
      `long_test_groups=${JSON.stringify(testPlan.long.groups)}`,
      `long_test_mode=${testPlan.long.mode}`,
      `standard_test_mode=${testPlan.standard.mode}`,
      `standard_test_paths=${JSON.stringify(testPlan.standard.paths)}`,
      `postgres_test_mode=${testPlan.postgres.mode}`,
      `postgres_test_paths=${JSON.stringify(testPlan.postgres.paths)}`,
      `changed_count=${classification.changedCount}`,
      `reason=${reason}`,
    ];
    await Bun.write(outputPath, `${lines.join('\n')}\n`);
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const enabled = ciScopeKeys.filter(key => classification.scopes[key]);
    await Bun.write(
      summaryPath,
      `### CI scope\n\n- Changed paths: ${classification.changedCount}\n- Reason: \`${reason}\`\n- Enabled: ${
        enabled.length > 0 ? enabled.map(key => `\`${key}\``).join(', ') : 'formatting only'
      }\n`,
    );
  }
}

if (import.meta.main) {
  const {classification, reason} = classifyCurrentDiff(commitArgument('--base'), commitArgument('--head'));
  await writeGitHubOutputs(classification, reason);
  process.stdout.write(
    `${JSON.stringify({changedCount: classification.changedCount, reason, scopes: classification.scopes})}\n`,
  );
}
