import {describe, expect, it} from '@effect/vitest';
import {antipattern} from '@effect/tsgo/oxlint-presets';
import * as FC from 'effect/testing/FastCheck';
import {
  isEffectRuntimeMember,
  isNodeBuiltinSpecifier,
  isNodeEffectPackageSpecifier,
} from '../../config/lint/threadnote-plugin.js';
import {normalizeChangedLintPaths} from '../../scripts/lint.js';

const portablePath = FC.tuple(
  FC.array(FC.constantFrom('a', 'b', 'c', '-', '_', '/', '\\'), {maxLength: 30}),
  FC.constantFrom('.ts', '.tsx', '.mts', '.js', '.md', '.json'),
).map(([parts, extension]) => `${parts.join('')}${extension}`);

describe('lint policy', () => {
  it('keeps every official Effect anti-pattern rule warning-enabled and strict for changed files', async () => {
    const warningConfig = (await Bun.file(new URL('../../.oxlintrc.json', import.meta.url)).json()) as {
      readonly extends?: readonly string[];
      readonly rules?: Readonly<Record<string, string>>;
    };
    const strictConfig = (await Bun.file(new URL('../../.oxlintrc.strict.json', import.meta.url)).json()) as {
      readonly rules?: Readonly<Record<string, string>>;
    };
    const antipatternRules = Object.keys(antipattern.rules ?? {});

    expect(warningConfig.extends).toContain('./node_modules/@effect/tsgo/oxlint-presets/antipattern.json');
    expect(antipatternRules.filter(rule => strictConfig.rules?.[rule] !== 'error')).toEqual([]);
    expect(warningConfig.rules?.['effecttsgo/node-builtin-import']).toBe('warn');
    expect(strictConfig.rules?.['effecttsgo/node-builtin-import']).toBe('error');
  });

  it('runs lint first from the Bun pre-commit hook', async () => {
    const hook = await Bun.file(new URL('../../.husky/pre-commit', import.meta.url)).text();
    const packageJson = (await Bun.file(new URL('../../package.json', import.meta.url)).json()) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };

    expect(hook).toContain('bun run precommit');
    expect(packageJson.scripts?.precommit).toMatch(/^bun run lint(?:\s|&&)/);
  });

  it.prop('recognizes every explicit node: import as Node-specific', {specifier: FC.string()}, ({specifier}) => {
    expect(isNodeBuiltinSpecifier(`node:${specifier}`)).toBe(true);
  });

  it('recognizes bare built-ins and Effect Node adapters without rejecting ordinary packages', () => {
    expect(isNodeBuiltinSpecifier('fs/promises')).toBe(true);
    expect(isNodeBuiltinSpecifier('node:test/reporters')).toBe(true);
    expect(isNodeBuiltinSpecifier('fs-extra')).toBe(false);
    expect(isNodeEffectPackageSpecifier('@effect/platform-node/NodeRuntime')).toBe(true);
    expect(isNodeEffectPackageSpecifier('@effect/platform-bun/BunRuntime')).toBe(false);
  });

  it('covers Effect execution and runtime construction APIs', () => {
    expect(isEffectRuntimeMember('Effect', 'runPromiseExit')).toBe(true);
    expect(isEffectRuntimeMember('Runtime', 'makeRunMain')).toBe(true);
    expect(isEffectRuntimeMember('ManagedRuntime', 'make')).toBe(true);
    expect(isEffectRuntimeMember('BunRuntime', 'runMain')).toBe(true);
    expect(isEffectRuntimeMember('Effect', 'flatMap')).toBe(false);
  });

  it.prop('normalizes changed paths deterministically and idempotently', {paths: FC.array(portablePath)}, ({paths}) => {
    const once = normalizeChangedLintPaths(paths);
    const twice = normalizeChangedLintPaths(once);
    const expected = [
      ...new Set(paths.map(path => path.replaceAll('\\', '/')).filter(path => /\.(?:[cm]?[jt]sx?)$/.test(path))),
    ].sort();
    expect(twice).toEqual(once);
    expect(once).toEqual(expected);
    expect(once.every(path => !path.includes('\\') && /\.(?:[cm]?[jt]sx?)$/.test(path))).toBe(true);
  });
});
