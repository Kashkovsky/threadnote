import {execFileSync} from 'node:child_process';
import {mkdtempSync, renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fc from 'fast-check';
import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_WORKTREE_REGISTRY_LIMITS,
  parseRepositoryWorktreeRegistryOutput,
  repositoryWorktreeRegistry,
  resolveRepositoryIdentity,
} from '../../src/code_graph/repository.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('code graph Git worktree registry', () => {
  it('preserves a registered worktree whose folder is temporarily unavailable', async () => {
    const root = localRepository();
    git(root, ['branch', 'linked']);
    const linked = join(mkdtempSync(join(tmpdir(), 'threadnote-worktree-registry-')), 'linked');
    const unavailable = `${linked}-unavailable`;
    git(root, ['worktree', 'add', linked, 'linked']);
    const [identity, linkedIdentity] = await runEffect(
      Effect.all([resolveRepositoryIdentity(root), resolveRepositoryIdentity(linked)], {concurrency: 2}),
    );

    renameSync(linked, unavailable);
    try {
      const registry = await runEffect(repositoryWorktreeRegistry(identity));

      expect(registry).toContainEqual(
        expect.objectContaining({
          worktreeId: linkedIdentity.worktreeId,
        }),
      );
      expect(registry).toContainEqual(expect.objectContaining({worktreeId: identity.worktreeId}));
    } finally {
      renameSync(unavailable, linked);
      git(root, ['worktree', 'remove', '--force', linked]);
    }
  });

  it('parses locked and prunable registrations without exposing their paths', () => {
    const output = registryOutput([
      {fields: ['HEAD abc', 'branch refs/heads/main'], root: '/checkout/main'},
      {fields: ['HEAD def', 'detached', 'locked offline', 'prunable missing'], root: '/checkout/linked'},
    ]);

    const parsed = parseRepositoryWorktreeRegistryOutput(output, 'linux');

    expect(parsed).toHaveLength(2);
    expect(parsed.map(entry => Object.keys(entry).sort())).toEqual([
      ['locked', 'prunable', 'worktreeId'],
      ['locked', 'prunable', 'worktreeId'],
    ]);
    expect(parsed).toContainEqual(expect.objectContaining({locked: true, prunable: true}));
    expect(JSON.stringify(parsed)).not.toContain('/checkout/');
  });

  it.each([
    ['truncated output', 'worktree /checkout/main\0HEAD abc\0'],
    ['relative path', registryOutput([{fields: ['HEAD abc'], root: 'checkout/main'}])],
    [
      'duplicate path',
      registryOutput([
        {fields: ['HEAD abc'], root: '/checkout/main'},
        {fields: ['HEAD def'], root: '/checkout/main'},
      ]),
    ],
    ['oversized path', registryOutput([{fields: ['HEAD abc'], root: `/checkout/${'a'.repeat(4_097)}`}])],
    [
      'oversized output',
      registryOutput([
        {
          fields: [`unknown ${'a'.repeat(CODE_GRAPH_WORKTREE_REGISTRY_LIMITS.maxOutputBytes)}`],
          root: '/checkout/main',
        },
      ]),
    ],
    [
      'too many records',
      registryOutput(
        Array.from({length: CODE_GRAPH_WORKTREE_REGISTRY_LIMITS.maxRecords + 1}, (_, index) => ({
          fields: ['HEAD abc'],
          root: `/checkout/${index}`,
        })),
      ),
    ],
  ])('rejects %s without returning a partial registry', (_label, output) => {
    expect(() => parseRepositoryWorktreeRegistryOutput(output, 'linux')).toThrow(
      'Git worktree registry output is invalid.',
    );
  });

  it('normalizes Windows registry paths before deriving privacy-safe identities', () => {
    const first = parseRepositoryWorktreeRegistryOutput(
      registryOutput([{fields: ['HEAD abc'], root: 'C:\\checkout\\main\\.'}]),
      'win32',
    );
    const second = parseRepositoryWorktreeRegistryOutput(
      registryOutput([{fields: ['HEAD abc'], root: 'C:\\checkout\\main'}]),
      'win32',
    );

    expect(first).toEqual(second);
  });

  it('round-trips every bounded valid registration without losing flags or determinism', () => {
    const entry = fc.record({
      locked: fc.boolean(),
      name: fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/),
      prunable: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(entry, {
          maxLength: 64,
          minLength: 1,
          selector: value => value.name,
        }),
        entries => {
          const output = registryOutput(
            entries.map(value => ({
              fields: [
                'HEAD abc',
                ...(value.locked ? ['locked reason'] : []),
                ...(value.prunable ? ['prunable reason'] : []),
              ],
              root: `/checkout/${value.name}`,
            })),
          );
          const first = parseRepositoryWorktreeRegistryOutput(output, 'linux');
          const second = parseRepositoryWorktreeRegistryOutput(output, 'linux');

          expect(first).toEqual(second);
          expect(first).toHaveLength(entries.length);
          expect(new Set(first.map(value => value.worktreeId))).toHaveLength(entries.length);
          expect(first.filter(value => value.locked)).toHaveLength(entries.filter(value => value.locked).length);
          expect(first.filter(value => value.prunable)).toHaveLength(entries.filter(value => value.prunable).length);
        },
      ),
      {numRuns: 100},
    );
  });
});

function registryOutput(entries: readonly {readonly fields: readonly string[]; readonly root: string}[]): string {
  return entries.map(entry => [`worktree ${entry.root}`, ...entry.fields].join('\0')).join('\0\0') + '\0\0';
}

function localRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-worktree-registry-root-'));
  git(root, ['init', '-q']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  return root;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}
