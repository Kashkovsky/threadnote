import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {ciScopeKeys, classifyCiScopes, type CiScopeKey} from '../ci/ci-scopes.js';

const pathSegment = FC.stringMatching(/^[a-z][a-z0-9_-]{0,20}$/u);
const websitePath = FC.array(pathSegment, {maxLength: 5, minLength: 1}).map(parts => `website/${parts.join('/')}.tsx`);
const documentationPath = FC.oneof(
  FC.array(pathSegment, {maxLength: 5, minLength: 1}).map(parts => `docs/${parts.join('/')}.md`),
  pathSegment.map(segment => `${segment}.md`),
);
const knownPath = FC.oneof(
  websitePath,
  documentationPath,
  pathSegment.map(segment => `src/${segment}.ts`),
  pathSegment.map(segment => `test/unit/${segment}.test.ts`),
  pathSegment.map(segment => `scripts/${segment}.ts`),
  FC.constantFrom('README.md', 'package.json', '.github/workflows/pages.yml', '.github/workflows/ci.yml'),
);

function enabledScopes(paths: readonly string[]): readonly CiScopeKey[] {
  const classification = classifyCiScopes(paths);
  return ciScopeKeys.filter(key => classification.scopes[key]);
}

describe('CI changed-path scope properties', () => {
  it.prop(
    'is invariant to path order and duplicates',
    {paths: FC.array(knownPath, {maxLength: 40, minLength: 1})},
    ({paths}) => {
      const expected = classifyCiScopes(paths);
      const reordered = classifyCiScopes([...paths].reverse());
      const duplicated = classifyCiScopes([...paths, ...paths]);

      expect(reordered).toEqual(expected);
      expect(duplicated).toEqual(expected);
    },
    {fastCheck: {numRuns: 300}},
  );

  it.prop(
    'never disables a scope when another changed path is added',
    {paths: FC.array(knownPath, {maxLength: 30, minLength: 1}), extra: knownPath},
    ({paths, extra}) => {
      const before = classifyCiScopes(paths).scopes;
      const after = classifyCiScopes([...paths, extra]).scopes;

      for (const key of ciScopeKeys) {
        if (before[key]) expect(after[key]).toBe(true);
      }
    },
    {fastCheck: {numRuns: 300}},
  );

  it.prop(
    'isolates pure website changes from runtime, release, Windows, and quality work',
    {paths: FC.array(websitePath, {maxLength: 30, minLength: 1})},
    ({paths}) => {
      expect(enabledScopes(paths)).toEqual(['site_check', 'site_build']);
    },
    {fastCheck: {numRuns: 250}},
  );

  it.prop(
    'keeps pure documentation changes on the formatting-only lane',
    {paths: FC.array(documentationPath, {maxLength: 30, minLength: 1})},
    ({paths}) => {
      expect(enabledScopes(paths)).toEqual([]);
    },
    {fastCheck: {numRuns: 250}},
  );

  it.prop(
    'fails safe for paths outside the classified repository surface',
    {segment: pathSegment},
    ({segment}) => {
      expect(enabledScopes([`unclassified-${segment}/payload.bin`])).toEqual(ciScopeKeys);
    },
    {fastCheck: {numRuns: 200}},
  );

  it('fails safe for empty, invalid, and parent-traversing path inventories', () => {
    for (const paths of [[], [''], ['../website/index.html'], ['/website/index.html']]) {
      expect(enabledScopes(paths)).toEqual(ciScopeKeys);
    }
  });

  it('maps representative repository paths to the expected expensive scopes', () => {
    expect(enabledScopes(['test/unit/utils.test.ts'])).toEqual(['code']);
    expect(enabledScopes(['src/installations.ts'])).toEqual(['code', 'release', 'windows']);
    expect(enabledScopes(['src/recall/index.ts'])).toEqual(['code', 'quality', 'release', 'windows']);
    expect(enabledScopes(['src/context_brief/citation_validation.ts'])).toEqual([
      'code',
      'quality',
      'release',
      'windows',
    ]);
    expect(enabledScopes(['src/memory_code_citation_capture.ts'])).toEqual(['code', 'quality', 'release', 'windows']);
    expect(enabledScopes(['.github/workflows/pages.yml'])).toEqual(['actions', 'site_check', 'site_build']);
    expect(enabledScopes(['README.md'])).toEqual(['site_check']);
    expect(enabledScopes(['test/ci/ci-scopes.ts'])).toEqual(ciScopeKeys);
    expect(enabledScopes(['scripts/benchmark-worktree-readiness.ts'])).toEqual(['code', 'quality']);
    expect(enabledScopes(['scripts/evaluate-context-brief-citations-runtime.ts'])).toEqual(['code', 'quality']);
    expect(enabledScopes(['scripts/lint-file-length.ts'])).toEqual(['code', 'site_check']);
    expect(enabledScopes(['.oxlintrc.max-lines.json'])).toEqual(['code', 'site_check']);
    expect(enabledScopes(['scripts/release-targets.ts'])).toEqual(['code', 'release', 'windows']);
    expect(enabledScopes(['scripts/effect/script.ts'])).toEqual(['code', 'quality', 'release', 'windows']);
  });
});
