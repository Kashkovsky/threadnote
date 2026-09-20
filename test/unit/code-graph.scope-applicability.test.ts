import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {fcProp} from '../helpers/fast-check-property.js';
import {assessCodeGraphScopeApplicability, codeGraphScopeAdmitsPath} from '../../src/code_graph/scope_applicability.js';

const scope = {admittedPrefixes: ['apps/a', 'shared/core'], controlPaths: ['package.json']};
const evidence = {
  repositoryId: 'repository',
  worktreeId: 'worktree',
  scopeKey: 'scope',
  definitionDigest: 'definition',
  closureDigest: 'closure',
  inventoryFingerprint: 'inventory',
  overlayFingerprint: undefined,
  extractorSet: 'extractor',
  policyFingerprint: 'policy',
  observedCommit: 'old',
  catalogFingerprint: 'catalog',
};

describe('scoped applicability', () => {
  it('advances observation without a build for unrelated commits and catalog changes', () => {
    expect(
      assessCodeGraphScopeApplicability(evidence, {...evidence, observedCommit: 'new', catalogFingerprint: 'new'}),
    ).toEqual({buildRequired: false, reason: 'equivalent-scope', observedCommit: 'new'});
  });

  it('requires a build when any effective scope evidence changes', () => {
    for (const field of [
      'repositoryId',
      'worktreeId',
      'scopeKey',
      'definitionDigest',
      'closureDigest',
      'inventoryFingerprint',
      'overlayFingerprint',
      'extractorSet',
      'policyFingerprint',
    ] as const) {
      expect(assessCodeGraphScopeApplicability(evidence, {...evidence, [field]: 'changed'}).buildRequired, field).toBe(
        true,
      );
    }
    expect(assessCodeGraphScopeApplicability(undefined, evidence).buildRequired).toBe(true);
  });

  fcProp(
    it,
    'positive scope respects path boundaries and always retains controls',
    {suffix: FC.stringMatching(/^[a-z]{1,12}$/)},
    ({suffix}) => {
      expect(codeGraphScopeAdmitsPath(scope, `apps/a/${suffix}.ts`)).toBe(true);
      expect(codeGraphScopeAdmitsPath(scope, `apps/a${suffix}/index.ts`)).toBe(false);
      expect(codeGraphScopeAdmitsPath(scope, `apps/b/${suffix}.ts`)).toBe(false);
      expect(codeGraphScopeAdmitsPath(scope, 'package.json')).toBe(true);
    },
    {fastCheck: {numRuns: 60}},
  );
});
