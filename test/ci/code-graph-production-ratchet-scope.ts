export interface CodeGraphProductionRatchetDiff {
  readonly afterPackageJson?: string;
  readonly beforePackageJson?: string;
  readonly changedPaths: Iterable<string>;
}

export interface CodeGraphProductionRatchetScope {
  readonly changedCount: number;
  readonly paths: readonly string[];
  readonly releaseMetadataOnly: boolean;
}

type JsonObject = Readonly<Record<string, unknown>>;

function normalizeGitPath(path: string): string | undefined {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return path;
}

function isReleaseNotePath(path: string): boolean {
  return /^\.github\/release-notes\/v[^/\n\r]+\.md$/u.test(path);
}

function parseJsonObject(source: string | undefined): JsonObject | undefined {
  if (source === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(source);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;

  const leftObject = left as JsonObject;
  const rightObject = right as JsonObject;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(leftObject[key], rightObject[key]))
  );
}

function changesOnlyTopLevelVersion(beforeSource: string | undefined, afterSource: string | undefined): boolean {
  const before = parseJsonObject(beforeSource);
  const after = parseJsonObject(afterSource);
  if (!before || !after) return false;
  if (typeof before.version !== 'string' || typeof after.version !== 'string' || before.version === after.version) {
    return false;
  }

  const beforeKeys = Object.keys(before)
    .filter(key => key !== 'version')
    .sort();
  const afterKeys = Object.keys(after)
    .filter(key => key !== 'version')
    .sort();
  return (
    beforeKeys.length === afterKeys.length &&
    beforeKeys.every((key, index) => key === afterKeys[index] && jsonValuesEqual(before[key], after[key]))
  );
}

export function classifyCodeGraphProductionRatchetScope(
  diff: CodeGraphProductionRatchetDiff,
): CodeGraphProductionRatchetScope {
  const paths = new Set<string>();
  let invalidPath = false;
  for (const path of diff.changedPaths) {
    const normalized = normalizeGitPath(path);
    if (normalized) paths.add(normalized);
    else invalidPath = true;
  }

  const sortedPaths = [...paths].sort();
  const packageChanged = paths.has('package.json');
  const pathsAreReleaseMetadata = sortedPaths.every(path => path === 'package.json' || isReleaseNotePath(path));
  const releaseMetadataOnly =
    !invalidPath &&
    sortedPaths.length > 0 &&
    packageChanged &&
    pathsAreReleaseMetadata &&
    changesOnlyTopLevelVersion(diff.beforePackageJson, diff.afterPackageJson);

  return {changedCount: sortedPaths.length, paths: sortedPaths, releaseMetadataOnly};
}

function commitArgument(name: '--base' | '--head'): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

function isCommitId(value: string | undefined): value is string {
  return Boolean(value && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(value) && !/^0+$/u.test(value));
}

function runGit(arguments_: readonly string[]): {readonly exitCode: number; readonly stdout: Uint8Array} {
  const result = Bun.spawnSync({cmd: ['git', ...arguments_], stderr: 'pipe', stdout: 'pipe'});
  return {exitCode: result.exitCode, stdout: result.stdout};
}

function readGitFile(commit: string, path: string): string | undefined {
  const result = runGit(['show', `${commit}:${path}`]);
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout) : undefined;
}

function classifyCurrentDiff(
  base: string | undefined,
  head: string | undefined,
): {
  readonly reason: string;
  readonly scope: CodeGraphProductionRatchetScope;
} {
  const failSafe = (reason: string): {readonly reason: string; readonly scope: CodeGraphProductionRatchetScope} => ({
    reason,
    scope: classifyCodeGraphProductionRatchetScope({changedPaths: []}),
  });
  if (!isCommitId(base) || !isCommitId(head)) return failSafe('missing-or-invalid-commit-range');

  const mergeBaseResult = runGit(['merge-base', base, head]);
  const mergeBase = new TextDecoder().decode(mergeBaseResult.stdout).trim();
  if (mergeBaseResult.exitCode !== 0 || !isCommitId(mergeBase)) return failSafe('git-merge-base-failed');

  const diffResult = runGit(['diff', '--name-only', '--no-renames', '-z', `${mergeBase}..${head}`, '--']);
  if (diffResult.exitCode !== 0) return failSafe(`git-diff-failed-${diffResult.exitCode}`);
  const changedPaths = new TextDecoder().decode(diffResult.stdout).split('\0').filter(Boolean);
  const scope = classifyCodeGraphProductionRatchetScope({
    afterPackageJson: readGitFile(head, 'package.json'),
    beforePackageJson: readGitFile(mergeBase, 'package.json'),
    changedPaths,
  });
  return {
    reason: scope.releaseMetadataOnly ? 'release-metadata-only' : 'ratchet-relevant-or-ambiguous-diff',
    scope,
  };
}

async function writeGitHubOutput(scope: CodeGraphProductionRatchetScope, reason: string): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    await Bun.write(
      outputPath,
      `release_metadata_only=${String(scope.releaseMetadataOnly)}\nchanged_count=${scope.changedCount}\nreason=${reason}\n`,
    );
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await Bun.write(
      summaryPath,
      `### Code graph production ratchet scope\n\n- Changed paths: ${scope.changedCount}\n- Reason: \`${reason}\`\n- Run benchmark: ${scope.releaseMetadataOnly ? 'no' : 'yes'}\n`,
    );
  }
}

if (import.meta.main) {
  const {reason, scope} = classifyCurrentDiff(commitArgument('--base'), commitArgument('--head'));
  await writeGitHubOutput(scope, reason);
  process.stdout.write(`${JSON.stringify({reason, ...scope})}\n`);
}
