const LINT_TARGETS = ['config/lint', 'scripts', 'src', 'test', 'website/src', 'website/vite.config.ts'];
const LINTABLE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
// Everything through the Workset Search 2.0 release at this commit predates the lint ratchet and remains warning-only.
// Once a configured CI base contains it, that newer base becomes the strict boundary.
const LINT_ADOPTION_BASE = 'ce63d995f5e5685246f6866ab889a54fd70b5322';
const decoder = new TextDecoder();

function gitLines(arguments_: readonly string[], allowFailure = false): readonly string[] {
  const result = Bun.spawnSync({
    cmd: ['git', ...arguments_],
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) {
    if (allowFailure) return [];
    throw new Error(decoder.decode(result.stderr).trim() || `git ${arguments_.join(' ')} failed`);
  }
  return decoder
    .decode(result.stdout)
    .split('\n')
    .map(path => path.trim())
    .filter(Boolean);
}

function gitSucceeds(arguments_: readonly string[]): boolean {
  return (
    Bun.spawnSync({
      cmd: ['git', ...arguments_],
      stderr: 'ignore',
      stdout: 'ignore',
    }).exitCode === 0
  );
}

export function normalizeChangedLintPaths(paths: readonly string[]): readonly string[] {
  return [
    ...new Set(paths.map(path => path.replaceAll('\\', '/')).filter(path => LINTABLE_EXTENSION.test(path))),
  ].sort();
}

async function changedLintFiles(): Promise<readonly string[]> {
  const paths = [
    ...gitLines(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD', '--', ...LINT_TARGETS]),
    ...gitLines(['ls-files', '--others', '--exclude-standard', '--', ...LINT_TARGETS]),
  ];
  const configuredBase = process.env.LINT_BASE;
  const requestedBase = configuredBase && !/^0+$/.test(configuredBase) ? configuredBase : undefined;
  const base =
    requestedBase &&
    gitSucceeds(['cat-file', '-e', `${LINT_ADOPTION_BASE}^{commit}`]) &&
    gitSucceeds(['merge-base', '--is-ancestor', requestedBase, LINT_ADOPTION_BASE])
      ? LINT_ADOPTION_BASE
      : requestedBase;
  if (base) {
    paths.push(...gitLines(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`, '--', ...LINT_TARGETS]));
  }

  const normalized = normalizeChangedLintPaths(paths);
  const existing = await Promise.all(
    normalized.map(async path => ((await Bun.file(path).exists()) ? path : undefined)),
  );
  return existing.filter((path): path is string => path !== undefined);
}

function runOxlint(arguments_: readonly string[]): number {
  const child = Bun.spawnSync({
    cmd: ['bun', '--bun', 'oxlint', ...arguments_],
    stderr: 'inherit',
    stdout: 'inherit',
  });
  return child.exitCode;
}

export async function lint(): Promise<number> {
  const warningExit = runOxlint(LINT_TARGETS);
  if (warningExit !== 0) return warningExit;

  const changed = await changedLintFiles();
  if (changed.length === 0) return 0;
  process.stdout.write(`Strict lint: ${changed.length} changed file${changed.length === 1 ? '' : 's'}\n`);
  return runOxlint(['--config', '.oxlintrc.strict.json', ...changed]);
}

if (import.meta.main) process.exitCode = await lint();
