import {ScriptError} from './effect/errors.js';

export const LINT_TARGETS = ['config/lint', 'scripts', 'src', 'test', 'website/src', 'website/vite.config.ts'] as const;

export const STRICT_LINT_ARGUMENTS = [
  '--config',
  '.oxlintrc.strict.json',
  '--threads=1',
  '--deny-warnings',
  '--report-unused-disable-directives-severity=error',
  '--ignore-pattern',
  'test/evaluation/fixtures/**/repository/**',
] as const;

const UNSAFE_TYPE_ASSERTION_RULE = 'typescript/no-unsafe-type-assertion';
const TYPE_SCRIPT_SOURCE = /\.(?:cts|mts|ts|tsx)$/u;

export function changedTypeScriptLines(diff: string): ReadonlyMap<string, ReadonlySet<number>> {
  const changed = new Map<string, Set<number>>();
  let path: string | undefined;
  let line = 0;
  for (const diffLine of diff.split('\n')) {
    if (diffLine.startsWith('+++ b/')) {
      path = diffLine.slice('+++ b/'.length);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(diffLine);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!path || !TYPE_SCRIPT_SOURCE.test(path) || line === 0) continue;
    if (diffLine.startsWith('+')) {
      const lines = changed.get(path) ?? new Set<number>();
      lines.add(line);
      changed.set(path, lines);
      line += 1;
    } else if (!diffLine.startsWith('-')) {
      line += 1;
    }
  }
  return changed;
}

function gitOutput(arguments_: readonly string[]): string | undefined {
  const child = Bun.spawnSync({cmd: ['git', ...arguments_], stderr: 'ignore', stdout: 'pipe'});
  return child.exitCode === 0 ? new TextDecoder().decode(child.stdout) : undefined;
}

function unsafeTypeAssertionDiagnostics(changed: ReadonlyMap<string, ReadonlySet<number>>): readonly string[] {
  if (changed.size === 0) return [];
  const child = Bun.spawnSync({
    cmd: [
      'bun',
      '--bun',
      'oxlint',
      ...STRICT_LINT_ARGUMENTS,
      '-D',
      UNSAFE_TYPE_ASSERTION_RULE,
      '--format',
      'unix',
      ...changed.keys(),
    ],
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const output = `${new TextDecoder().decode(child.stdout)}${new TextDecoder().decode(child.stderr)}`;
  return output.split('\n').filter(diagnostic => {
    const match = /^(.*):(\d+):(\d+): error typescript\(no-unsafe-type-assertion\):/u.exec(diagnostic);
    if (!match) return false;
    return changed.get(match[1])?.has(Number(match[2])) === true;
  });
}

/** Reject unsafe type assertions on every new or modified TypeScript source line. */
export function lintUnsafeTypeAssertions(): number {
  const base = gitOutput(['merge-base', 'HEAD', 'origin/main']) ?? gitOutput(['rev-parse', 'HEAD']);
  if (!base) return 0;
  const diff = gitOutput(['diff', '--no-ext-diff', '--unified=0', base, '--', ...LINT_TARGETS]);
  if (diff === undefined) return 0;
  const diagnostics = unsafeTypeAssertionDiagnostics(changedTypeScriptLines(diff));
  if (diagnostics.length === 0) return 0;
  console.error(diagnostics.join('\n'));
  return 1;
}

function runOxlint(arguments_: readonly string[]): number {
  const child = Bun.spawnSync({
    cmd: ['bun', '--bun', 'oxlint', ...arguments_],
    stderr: 'inherit',
    stdout: 'inherit',
  });
  return child.exitCode;
}

/** Run one deterministic, full-repository lint policy with no warning-only grandfathering. */
export function lint(execute: (arguments_: readonly string[]) => number = runOxlint): number {
  const lintExitCode = execute([...STRICT_LINT_ARGUMENTS, ...LINT_TARGETS]);
  return lintExitCode === 0 ? lintUnsafeTypeAssertions() : lintExitCode;
}

if (import.meta.main) {
  try {
    process.exitCode = lint();
  } catch (cause) {
    throw new ScriptError('Could not run the repository lint policy.', {cause});
  }
}
