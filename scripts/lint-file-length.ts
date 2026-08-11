import {BunRuntime} from '@effect/platform-bun';
import {Console, Effect} from 'effect';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SystemInfo} from '../src/effect/system.js';

export const PRODUCTION_FILE_LINE_LIMIT = 2_000;
export const PRODUCTION_CODE_ROOTS = ['src', 'website/src'] as const;
export const FILE_LENGTH_OXLINT_CONFIG = fileURLToPath(new URL('../.oxlintrc.max-lines.json', import.meta.url));

const CODE_FILE_PATTERN = /\.(?:c|m)?(?:js|jsx|ts|tsx)$/u;
const TEST_FILE_PATTERN = /\.(?:spec|test)\.(?:c|m)?(?:js|jsx|ts|tsx)$/u;
const TEST_DIRECTORY_NAMES = new Set(['__tests__', 'test', 'tests']);

export type FileLengthSeverity = 'error' | 'warn';

export interface ProductionFileLintPartition {
  readonly errorFiles: readonly string[];
  readonly warningFiles: readonly string[];
}

export interface ProductionFileLintPlan extends ProductionFileLintPartition {
  readonly base: string | undefined;
}

export interface OxlintFileLengthRequest {
  readonly configPath: string;
  readonly files: readonly string[];
  readonly repositoryRoot: string;
  readonly severity: FileLengthSeverity;
}

export interface RunProductionFileLengthLintOptions {
  readonly base?: string;
  readonly execute?: (request: OxlintFileLengthRequest) => number;
  readonly repositoryRoot: string;
  readonly roots?: readonly string[];
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeRepositoryPath(path: string): string | undefined {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\/+/, '');
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

function normalizedProductionRoots(roots: readonly string[]): readonly string[] {
  const normalized = roots.map(root => normalizeRepositoryPath(root));
  if (normalized.some(root => root === undefined)) throw new Error('Production lint roots must be repository paths.');
  const validRoots = normalized as string[];
  for (const root of validRoots) {
    if (!(PRODUCTION_CODE_ROOTS as readonly string[]).includes(root)) {
      throw new Error(`Unsupported production lint root: ${root}`);
    }
  }
  return [...new Set(validRoots)].sort(comparePaths);
}

export function isProductionCodePath(path: string, roots: readonly string[] = PRODUCTION_CODE_ROOTS): boolean {
  const normalized = normalizeRepositoryPath(path);
  if (!normalized || !CODE_FILE_PATTERN.test(normalized) || TEST_FILE_PATTERN.test(normalized)) return false;

  const segments = normalized.split('/');
  if (segments.some(segment => TEST_DIRECTORY_NAMES.has(segment))) return false;

  return roots.some(root => normalized === root || normalized.startsWith(`${root}/`));
}

export function partitionProductionCodeFiles(
  files: Iterable<string>,
  changedPaths: Iterable<string>,
  roots: readonly string[] = PRODUCTION_CODE_ROOTS,
): ProductionFileLintPartition {
  const changed = new Set(
    [...changedPaths].map(path => normalizeRepositoryPath(path)).filter((path): path is string => path !== undefined),
  );
  const productionFiles = new Set<string>();
  for (const file of files) {
    const normalized = normalizeRepositoryPath(file);
    if (normalized && isProductionCodePath(normalized, roots)) productionFiles.add(normalized);
  }

  const errorFiles: string[] = [];
  const warningFiles: string[] = [];
  for (const file of [...productionFiles].sort(comparePaths)) {
    (changed.has(file) ? errorFiles : warningFiles).push(file);
  }
  return {errorFiles, warningFiles};
}

function decodeOutput(output: Uint8Array | undefined): string {
  return output ? new TextDecoder().decode(output) : '';
}

function decodeNullSeparated(output: Uint8Array | undefined): readonly string[] {
  return decodeOutput(output).split('\0').filter(Boolean);
}

function runGit(repositoryRoot: string, arguments_: readonly string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync({
    cmd: ['git', ...arguments_],
    cwd: repositoryRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
}

function gitPaths(repositoryRoot: string, arguments_: readonly string[]): readonly string[] {
  const result = runGit(repositoryRoot, arguments_);
  if (result.exitCode !== 0) {
    const detail = decodeOutput(result.stderr).trim();
    throw new Error(`git ${arguments_.join(' ')} failed${detail ? `: ${detail}` : '.'}`);
  }
  return decodeNullSeparated(result.stdout);
}

function commitExists(repositoryRoot: string, reference: string): boolean {
  if (reference.startsWith('-') || reference.includes('\0')) return false;
  return runGit(repositoryRoot, ['rev-parse', '--verify', '--quiet', `${reference}^{commit}`]).exitCode === 0;
}

export function resolveProductionLintBase(repositoryRoot: string, requestedBase?: string): string | undefined {
  const base = requestedBase?.trim();
  if (base) {
    if (!commitExists(repositoryRoot, base)) throw new Error(`Production file lint base is not a commit: ${base}`);
    return base;
  }
  return commitExists(repositoryRoot, 'origin/main') ? 'origin/main' : undefined;
}

export function collectProductionFileLintPlan(
  repositoryRoot: string,
  options: {readonly base?: string; readonly roots?: readonly string[]} = {},
): ProductionFileLintPlan {
  const roots = normalizedProductionRoots(options.roots ?? PRODUCTION_CODE_ROOTS);
  const pathspec = ['--', ...roots];
  const base = resolveProductionLintBase(repositoryRoot, options.base);
  const allFiles = gitPaths(repositoryRoot, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    ...pathspec,
  ]).filter(path => existsSync(join(repositoryRoot, path)));
  const changedPaths = new Set([
    ...gitPaths(repositoryRoot, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', ...pathspec]),
    ...gitPaths(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec]),
  ]);
  if (base) {
    for (const path of gitPaths(repositoryRoot, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      `${base}...HEAD`,
      ...pathspec,
    ])) {
      changedPaths.add(path);
    }
  }
  return {...partitionProductionCodeFiles(allFiles, changedPaths, roots), base};
}

function executeOxlint(request: OxlintFileLengthRequest): number {
  const severityArguments = request.severity === 'error' ? ['--deny', 'max-lines'] : [];
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      '--bun',
      'oxlint',
      `--config=${request.configPath}`,
      '--disable-nested-config',
      '--disable-unicorn-plugin',
      '--disable-oxc-plugin',
      '--disable-typescript-plugin',
      '--no-error-on-unmatched-pattern',
      ...severityArguments,
      ...request.files,
    ],
    cwd: request.repositoryRoot,
    stderr: 'inherit',
    stdout: 'inherit',
  });
  return result.exitCode;
}

export function runProductionFileLengthLint(options: RunProductionFileLengthLintOptions): number {
  const plan = collectProductionFileLintPlan(options.repositoryRoot, {
    base: options.base,
    roots: options.roots,
  });
  const execute = options.execute ?? executeOxlint;
  for (const request of [
    {files: plan.warningFiles, severity: 'warn' as const},
    {files: plan.errorFiles, severity: 'error' as const},
  ]) {
    if (request.files.length === 0) continue;
    const exitCode = execute({
      configPath: FILE_LENGTH_OXLINT_CONFIG,
      files: request.files,
      repositoryRoot: options.repositoryRoot,
      severity: request.severity,
    });
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

function parseArguments(arguments_: readonly string[]): {readonly base?: string; readonly roots: readonly string[]} {
  const roots: string[] = [];
  let base: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--base') {
      base = arguments_[index + 1];
      if (!base) throw new Error('--base requires a Git commit or reference.');
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`Unknown production file lint option: ${argument}`);
    roots.push(argument);
  }
  return {base, roots: normalizedProductionRoots(roots.length === 0 ? PRODUCTION_CODE_ROOTS : roots)};
}

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const outcome = yield* Effect.try({
        try: () => {
          const {base, roots} = parseArguments(Bun.argv.slice(2));
          return runProductionFileLengthLint({
            base: base ?? process.env.THREADNOTE_LINT_BASE,
            repositoryRoot: fileURLToPath(new URL('..', import.meta.url)),
            roots,
          });
        },
        catch: cause => cause,
      }).pipe(
        Effect.match({
          onFailure: cause => ({cause, success: false}) as const,
          onSuccess: exitCode => ({exitCode, success: true}) as const,
        }),
      );
      if (!outcome.success) {
        yield* Console.error(
          `Production file length lint failed: ${outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause)}`,
        );
        system.setExitCode(2);
        return;
      }
      system.setExitCode(outcome.exitCode);
    }).pipe(Effect.provide(SystemInfo.layer)),
  );
}
