import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codeGraphGitWorktreeAdminNameKeys,
  scanCodeGraphGitWorktreeRegistry,
  type CodeGraphGitWorktreeRegistryRequest,
} from '../../src/code_graph/git_worktree_registration.js';

const CHECKOUT_ID = 'a'.repeat(64);

describe('code graph common-gitdir authority properties', () => {
  it('is deterministic across insertion order and becomes present exactly when the target name is added', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/), {
          maxLength: 12,
          selector: value => value.toLowerCase(),
        }),
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/),
        async (generated, target) => {
          const entries = generated.filter(name => name.toLowerCase() !== target.toLowerCase());
          const first = registryFixture(entries);
          const second = registryFixture([...entries].reverse());
          try {
            const absentFirst = await scanCodeGraphGitWorktreeRegistry(request(first, target));
            const absentSecond = await scanCodeGraphGitWorktreeRegistry(request(second, target));
            expect(absentFirst).toMatchObject({state: 'absent'});
            expect(absentSecond).toMatchObject({state: 'absent'});
            if (absentFirst.state !== 'unknown' && absentSecond.state !== 'unknown') {
              expect(absentFirst.contentDigest).toBe(absentSecond.contentDigest);
            }

            mkdirSync(join(first, 'worktrees', target));
            const present = await scanCodeGraphGitWorktreeRegistry(request(first, target));
            expect(present).toMatchObject({state: 'present'});
          } finally {
            rmSync(first, {force: true, recursive: true});
            rmSync(second, {force: true, recursive: true});
          }
        },
      ),
      {numRuns: 100},
    );
  });
});

function request(common: string, target: string): CodeGraphGitWorktreeRegistryRequest {
  return {
    adminNameKeys: codeGraphGitWorktreeAdminNameKeys(CHECKOUT_ID, target),
    checkoutId: CHECKOUT_ID,
    gitCommonDirectory: common,
    protocol: 1,
  };
}

function registryFixture(entries: readonly string[]): string {
  const common = mkdtempSync(join(tmpdir(), 'threadnote-registration-property-'));
  mkdirSync(join(common, 'worktrees'));
  for (const entry of entries) mkdirSync(join(common, 'worktrees', entry));
  return common;
}
