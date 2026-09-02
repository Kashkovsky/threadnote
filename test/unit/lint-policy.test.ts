import {describe, expect, it} from '@effect/vitest';
import {antipattern} from '@effect/tsgo/oxlint-presets';
import * as FC from 'effect/testing/FastCheck';
import {
  isEffectRuntimeMember,
  isNodeBuiltinSpecifier,
  isNodeEffectPackageSpecifier,
} from '../../config/lint/threadnote-plugin.js';
import {changedTypeScriptLines, LINT_TARGETS, STRICT_LINT_ARGUMENTS, lint} from '../../scripts/lint.js';

describe('lint policy', () => {
  it('enforces every official Effect anti-pattern rule for the full repository', async () => {
    const baseConfig = (await Bun.file(new URL('../../.oxlintrc.json', import.meta.url)).json()) as {
      readonly extends?: readonly string[];
    };
    const strictConfig = (await Bun.file(new URL('../../.oxlintrc.strict.json', import.meta.url)).json()) as {
      readonly rules?: Readonly<Record<string, string>>;
    };
    const antipatternRules = Object.keys(antipattern.rules ?? {});

    expect(baseConfig.extends).toContain('./node_modules/@effect/tsgo/oxlint-presets/antipattern.json');
    expect(antipatternRules.filter(rule => strictConfig.rules?.[rule] !== 'error')).toEqual([]);
    expect(strictConfig.rules?.['effecttsgo/node-builtin-import']).toBe('error');
  });

  it('runs one deterministic full-repository pass that rejects every warning', () => {
    const calls: Array<readonly string[]> = [];
    expect(
      lint(arguments_ => {
        calls.push(arguments_);
        return 0;
      }),
    ).toBe(0);
    expect(calls).toEqual([[...STRICT_LINT_ARGUMENTS, ...LINT_TARGETS]]);
    expect(STRICT_LINT_ARGUMENTS).toContain('--threads=1');
    expect(STRICT_LINT_ARGUMENTS).toContain('--deny-warnings');
    expect(STRICT_LINT_ARGUMENTS).toContain('--report-unused-disable-directives-severity=error');
  });

  it('runs lint first from the Bun pre-commit hook', async () => {
    const hook = await Bun.file(new URL('../../.husky/pre-commit', import.meta.url)).text();
    const packageJson = (await Bun.file(new URL('../../package.json', import.meta.url)).json()) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };

    expect(hook).toContain('bun run precommit');
    expect(packageJson.scripts?.precommit).toMatch(/^bun run lint(?:\s|&&)/);
  });

  it('tracks only added TypeScript lines for the unsafe-assertion regression gate', () => {
    const changed = changedTypeScriptLines(
      [
        'diff --git a/src/example.ts b/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -4,2 +4,3 @@',
        ' keep();',
        '-old();',
        '+next();',
        '+added();',
      ].join('\n'),
    );
    expect([...(changed.get('src/example.ts') ?? [])]).toEqual([5, 6]);
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
});
