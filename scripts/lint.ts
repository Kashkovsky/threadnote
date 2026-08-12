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
  return execute([...STRICT_LINT_ARGUMENTS, ...LINT_TARGETS]);
}

if (import.meta.main) {
  try {
    process.exitCode = lint();
  } catch (cause) {
    throw new ScriptError('Could not run the repository lint policy.', {cause});
  }
}
