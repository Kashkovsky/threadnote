import {execFile} from '../helpers/node-child-process.js';
import {mkdir, mkdtemp, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {promisify} from '../helpers/node-util.js';
import {describe, expect, it} from 'vitest';

const execFilePromise = promisify(execFile);

describe('code graph CLI project selection', () => {
  it('parses --project on scoped graph commands', async () => {
    for (const command of [
      'inventory',
      'index',
      'status',
      'query',
      'node',
      'neighbors',
      'explain',
      'path',
      'impact',
      'watch',
      'analyze',
    ]) {
      const help = await runCli(['graph', command, '--help']);
      expect(help.stdout, command).toContain('--project string');
    }
  });

  it('uses an explicit project to resolve an ambiguous cwd and retains named full-graph projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-graph-cli-project-'));
    const home = join(root, '.threadnote-home');
    const manifest = join(home, 'seed-manifest.yaml');
    try {
      for (const name of ['a', 'b']) {
        await mkdir(join(root, 'apps', name), {recursive: true});
        await writeFile(join(root, 'apps', name, 'package.json'), JSON.stringify({name: `@fixture/${name}`}));
        await writeFile(join(root, 'apps', name, 'index.ts'), `export const ${name} = '${name}';\n`);
      }
      await writeFile(join(root, 'package.json'), JSON.stringify({private: true, workspaces: ['apps/*']}));
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);
      await mkdir(home, {recursive: true});
      await writeFile(
        manifest,
        [
          'version: 1',
          'projects:',
          '  - name: a',
          `    path: ${root}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/a',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/a]',
          '  - name: b',
          `    path: ${root}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/b',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/b]',
          '  - name: full',
          `    path: ${root}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/full',
          '',
        ].join('\n'),
      );
      const base = ['--home', home, '--manifest', manifest, '--cwd', root];
      const ambiguous = await runCli(['graph', 'index', ...base, '--no-vectors']).catch(asProcessError);
      expect(ambiguous).toMatchObject({code: 1});
      expect(String(ambiguous.stderr)).toContain('Graph scope is ambiguous');

      const indexed = await runCli(['graph', 'index', ...base, '--project', 'a', '--no-vectors', '--json']);
      expect(JSON.parse(indexed.stdout)).toMatchObject({
        snapshot: {scopeId: expect.stringMatching(/^code-graph-scope:/)},
      });

      const status = JSON.parse((await runCli(['graph', 'status', ...base, '--project', 'a', '--json'])).stdout);
      expect(status).toMatchObject({projectCoverage: {kind: 'project', project: 'a'}});

      const query = JSON.parse(
        (await runCli(['graph', 'query', ...base, '--project', 'a', '--query', 'a', '--json'])).stdout,
      );
      expect(query).toMatchObject({projectCoverage: {project: 'a'}});

      const inventory = JSON.parse((await runCli(['graph', 'inventory', ...base, '--project', 'a', '--json'])).stdout);
      expect(inventory.totals.repository.files).toBeLessThan(5);

      const full = JSON.parse(
        (await runCli(['graph', 'index', ...base, '--project', 'full', '--no-vectors', '--json'])).stdout,
      );
      expect(full.snapshot.scopeId).toBeUndefined();

      const unknown = await runCli(['graph', 'status', ...base, '--project', 'missing']).catch(asProcessError);
      expect(unknown).toMatchObject({code: 1});
      expect(String(unknown.stderr)).toContain('No configured project named "missing" exists.');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 60_000);

  it('selects a configured project by checkout identity from a linked worktree', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'threadnote-graph-cli-linked-project-'));
    const root = join(fixture, 'repository');
    const linked = join(fixture, 'linked');
    const home = join(fixture, '.threadnote-home');
    const manifest = join(home, 'seed-manifest.yaml');
    try {
      await mkdir(join(root, 'apps', 'web'), {recursive: true});
      await writeFile(join(root, 'package.json'), JSON.stringify({private: true, workspaces: ['apps/*']}));
      await writeFile(join(root, 'apps', 'web', 'package.json'), JSON.stringify({name: '@fixture/web'}));
      await writeFile(join(root, 'apps', 'web', 'index.ts'), 'export const web = true;\n');
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', '.']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);
      await execFilePromise('git', ['-C', root, 'worktree', 'add', '--detach', linked, 'HEAD']);
      await mkdir(home, {recursive: true});
      await writeFile(
        manifest,
        [
          'version: 1',
          'projects:',
          '  - name: web',
          `    path: ${root}`,
          '    seed: []',
          '    uri: threadnote://resources/repos/web',
          '    graph:',
          '      closure: dependencies',
          '      roots: [apps/web]',
          '',
        ].join('\n'),
      );
      const base = ['--home', home, '--manifest', manifest, '--cwd', linked];
      const indexed = JSON.parse((await runCli(['graph', 'index', ...base, '--no-vectors', '--json'])).stdout);
      expect(indexed).toMatchObject({snapshot: {scopeId: expect.stringMatching(/^code-graph-scope:/u)}});
      const status = JSON.parse((await runCli(['graph', 'status', ...base, '--json'])).stdout);
      expect(status).toMatchObject({projectCoverage: {kind: 'project', project: 'web'}});
      const automaticQuery = JSON.parse((await runCli(['graph', 'query', ...base, '--query', 'web', '--json'])).stdout);
      expect(automaticQuery).toMatchObject({projectCoverage: {kind: 'project', project: 'web'}});
      const explicitStatus = JSON.parse(
        (await runCli(['graph', 'status', ...base, '--project', 'web', '--json'])).stdout,
      );
      expect(explicitStatus).toMatchObject({projectCoverage: {kind: 'project', project: 'web'}});
    } finally {
      await rm(fixture, {force: true, recursive: true});
    }
  }, 60_000);
});

function asProcessError(cause: unknown): NodeJS.ErrnoException & {stderr?: string} {
  return cause as NodeJS.ErrnoException & {stderr?: string};
}

function runCli(args: readonly string[]) {
  return execFilePromise(process.execPath, [join(process.cwd(), 'src', 'standalone.ts'), ...args], {
    cwd: process.cwd(),
    maxBuffer: 8 * 1024 * 1024,
  });
}
