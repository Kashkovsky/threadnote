import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {describe, expect, it} from 'vitest';

const execFilePromise = promisify(execFile);

describe('Effect CLI', () => {
  it('renders the command tree without collapsing long names into descriptions', async () => {
    const result = await runCli(['--help']);
    expect(result.stdout).toContain('migrate-projects    Move memories');
    expect(result.stdout).not.toContain('migrate-project-namesMove');
  });

  it('retains the historical migrate-project-names command', async () => {
    const result = await runCli(['migrate-project-names', '--help']);
    expect(result.stdout).toContain('threadnote migrate-project-names [flags]');
  });

  it('exposes explicit beta and stable update channels', async () => {
    const result = await runCli(['update', '--help']);
    expect(result.stdout).toContain('--beta');
    expect(result.stdout).toContain('--stable');
  });

  it('exposes local AI model installation and switching commands', async () => {
    const install = await runCli(['local-ai', 'install', '--help']);
    const switching = await runCli(['local-ai', 'model', 'switch', '--help']);

    expect(install.stdout).toContain('--model string');
    expect(install.stdout).toContain('gemma-4-E4B-it-Q4_0');
    expect(install.stdout).not.toContain('LFM2.5-350M');
    expect(switching.stdout).toContain('threadnote local-ai model switch [flags]');
    expect(switching.stdout).toContain('--model string');
  });

  it('exposes code graph search as a dedicated command family', async () => {
    const graph = await runCli(['graph', '--help']);
    const query = await runCli(['graph', 'query', '--help']);
    const node = await runCli(['graph', 'node', '--help']);
    const neighbors = await runCli(['graph', 'neighbors', '--help']);
    const analyze = await runCli(['graph', 'analyze', '--help']);
    const exportHelp = await runCli(['graph', 'export', '--help']);
    const purge = await runCli(['graph', 'purge', '--help']);

    expect(graph.stdout).toContain('status');
    expect(graph.stdout).toContain('index');
    expect(graph.stdout).toContain('explain');
    expect(graph.stdout).toContain('node');
    expect(graph.stdout).toContain('neighbors');
    expect(graph.stdout).toContain('path');
    expect(graph.stdout).toContain('impact');
    expect(graph.stdout).toContain('communities');
    expect(graph.stdout).toContain('community');
    expect(graph.stdout).toContain('groups');
    expect(graph.stdout).toContain('report');
    expect(query.stdout).toContain('--query string');
    expect(query.stdout).toContain('--cwd string');
    expect(node.stdout).toContain('--node-id string');
    expect(neighbors.stdout).toContain('--node-id string');
    expect(neighbors.stdout).toContain('--direction choice');
    expect(neighbors.stdout).toContain('choices: both, incoming, outgoing');
    expect(neighbors.stdout).toContain('--depth integer');
    expect(analyze.stdout).toContain('--view choice');
    expect(analyze.stdout).toContain(
      'choices: stats, communities, community, groups, hubs, surprises, confidence, full',
    );
    expect(analyze.stdout).toContain('--community-id string');
    const community = await runCli(['graph', 'community', '--help']);
    expect(community.stdout).toContain('--community-id string');
    expect(community.stdout).toContain('--member-limit integer');
    expect(exportHelp.stdout).toContain('--format choice');
    expect(exportHelp.stdout).toContain('choices: json, graphml, html, svg');
    expect(exportHelp.stdout).toContain('--node-limit string');
    expect(exportHelp.stdout).toContain('--edge-limit string');
    expect(purge.stdout).toContain('--obsolete');
  });

  it('keeps graph index JSON parseable while streaming structured progress to stderr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-json-progress-'));
    const home = join(root, '.threadnote-test-home');
    try {
      await writeFile(join(root, 'package.json'), '{"name":"json-progress"}\n');
      await writeFile(join(root, 'index.ts'), 'export function indexedSymbol(): number { return 1; }\n');
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

      const result = await runCli(['graph', 'index', '--home', home, '--cwd', root, '--json']);
      const summary = JSON.parse(result.stdout) as {readonly snapshot?: {readonly fileCount?: number}};
      const progress = result.stderr
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as {readonly phase?: string; readonly type?: string});

      expect(summary.snapshot?.fileCount).toBe(2);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every(event => event.type === 'code-graph-progress')).toBe(true);
      expect(progress.some(event => event.phase === 'scanning')).toBe(true);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('returns a ready stale graph immediately after the checked-out commit changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-stale-query-'));
    const home = join(root, '.threadnote-test-home');
    try {
      await writeFile(join(root, 'package.json'), '{"name":"stale-query"}\n');
      await writeFile(join(root, 'index.ts'), 'export function indexedBeforePull(): number { return 1; }\n');
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
        'indexed commit',
      ]);
      const indexedCommit = (await execFilePromise('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
      await runCli(['graph', 'index', '--home', home, '--cwd', root, '--json']);

      await writeFile(join(root, 'after-pull.ts'), 'export function addedAfterPull(): number { return 2; }\n');
      await execFilePromise('git', ['-C', root, 'add', 'after-pull.ts']);
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'simulated pull',
      ]);

      const result = await runCli([
        'graph',
        'query',
        '--home',
        home,
        '--cwd',
        root,
        '--query',
        'indexedBeforePull',
        '--node-limit',
        '1',
        '--depth',
        '0',
        '--edge-limit',
        '1',
        '--json',
      ]);
      const graph = JSON.parse(result.stdout) as {
        readonly freshness?: string;
        readonly nodes?: readonly {readonly name?: string}[];
        readonly snapshot?: {readonly commit?: string};
      };

      expect(graph.freshness).toBe('stale');
      expect(graph.snapshot?.commit).toBe(indexedCommit);
      expect(graph.nodes?.some(node => node.name === 'indexedBeforePull')).toBe(true);
      expect(result.stderr).toBe('');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 30_000);

  it('drains graph query JSON larger than the platform pipe buffer before exiting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-large-output-'));
    const home = join(root, '.threadnote-test-home');
    try {
      const declarations = Array.from({length: 80}, (_, index) => {
        const name = `pipedOutputSymbol${'x'.repeat(1_500)}${index.toString().padStart(3, '0')}`;
        return `export const ${name} = ${index};`;
      }).join('\n');
      await writeFile(join(root, 'package.json'), '{"name":"large-piped-output"}\n');
      await writeFile(join(root, 'symbols.ts'), `${declarations}\n`);
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

      await runCli(['graph', 'index', '--home', home, '--cwd', root, '--json']);

      const result = await runCliThroughJsonPipe([
        'graph',
        'query',
        '--home',
        home,
        '--cwd',
        root,
        '--query',
        'pipedOutputSymbol',
        '--depth',
        '0',
        '--edge-limit',
        '1',
        '--node-limit',
        '200',
        '--json',
      ]);

      expect(result.bytes).toBeGreaterThan(65_536);
      expect(result.nodeCount).toBeGreaterThan(0);
      expect(result.allNamesMatched).toBe(true);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 30_000);

  it('drains a large final payload before one-shot runtime teardown', async () => {
    const startedAt = performance.now();
    const child = Bun.spawn([process.execPath, 'test/fixtures/cli-output-exit-race.ts'], {
      cwd: process.cwd(),
      lazy: true,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    await Bun.sleep(250);
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(450);
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(65_536);
    expect((JSON.parse(stdout) as {readonly value?: string}).value).toHaveLength(128 * 1024);
  });

  it('drains large generic CLI output through the application-wide safety net', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-large-generic-output-'));
    const memoryText = `generic-output-start\n${'x'.repeat(128 * 1024)}\ngeneric-output-end`;
    try {
      const result = await runCliThroughTextPipe(
        [
          'remember',
          '--home',
          home,
          '--dry-run',
          '--stdin',
          '--project',
          'threadnote',
          '--topic',
          'generic-cli-output',
        ],
        memoryText,
      );

      expect(result.bytes).toBeGreaterThan(65_536);
      expect(result.hasStart).toBe(true);
      expect(result.hasEnd).toBe(true);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('includes eligible untracked files in Git-base impact analysis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-'));
    const home = join(root, '.threadnote-test-home');
    try {
      await writeFile(join(root, 'tracked.ts'), 'export function trackedSymbol(): number { return 1; }\n');
      await execFilePromise('git', ['-C', root, 'init', '-q']);
      await execFilePromise('git', ['-C', root, 'add', 'tracked.ts']);
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
      await writeFile(join(root, 'untracked.ts'), 'export function untrackedSymbol(): number { return 2; }\n');

      const result = await runCli([
        'graph',
        'impact',
        '--home',
        home,
        '--cwd',
        root,
        '--base',
        'HEAD',
        '--depth',
        '0',
        '--edge-limit',
        '1',
        '--node-limit',
        '20',
        '--json',
      ]);

      expect(result.stdout).toContain('"path":"untracked.ts"');
      expect(result.stdout).toContain('"name":"untrackedSymbol"');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('recovers committed deletions from the exact CLI impact base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-deleted-base-'));
    const home = join(root, '.threadnote-test-home');
    try {
      await writeFile(join(root, 'package.json'), '{"name":"deleted-base"}\n');
      await writeFile(join(root, 'dependency.ts'), 'export function deletedDependency(): number { return 1; }\n');
      await writeFile(
        join(root, 'consumer.ts'),
        "import {deletedDependency} from './dependency.js';\n" +
          'export function survivingConsumer(): number { return deletedDependency(); }\n',
      );
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
        'base',
      ]);
      const base = (await execFilePromise('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
      await rm(join(root, 'dependency.ts'));
      await execFilePromise('git', [
        '-C',
        root,
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qam',
        'delete dependency',
      ]);

      const result = await runCli([
        'graph',
        'impact',
        '--home',
        home,
        '--cwd',
        root,
        '--base',
        base,
        '--depth',
        '1',
        '--json',
      ]);

      expect(result.stdout).toContain('"name":"survivingConsumer"');
      expect(result.stdout).toContain('deleted path(s) from base snapshot');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('refreshes stale query and explain reads in separate one-shot CLI processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-graph-freshness-'));
    const home = join(root, '.threadnote-test-home');
    try {
      await writeFile(join(root, 'package.json'), '{"name":"graph-freshness"}\n');
      await writeFile(join(root, 'index.ts'), 'export function firstGraphSymbol(): number { return 1; }\n');
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

      const first = await runCli([
        'graph',
        'query',
        '--home',
        home,
        '--cwd',
        root,
        '--query',
        'firstGraphSymbol',
        '--json',
      ]);
      expect(first.stdout).toContain('"name":"firstGraphSymbol"');

      await writeFile(join(root, 'index.ts'), 'export function queryRefreshSymbol(): number { return 2; }\n');
      const query = await runCli([
        'graph',
        'query',
        '--home',
        home,
        '--cwd',
        root,
        '--query',
        'queryRefreshSymbol',
        '--json',
      ]);
      expect(query.stdout).toContain('"freshness":"current"');
      expect(query.stdout).toContain('"name":"queryRefreshSymbol"');

      await writeFile(join(root, 'index.ts'), 'export function explainRefreshSymbol(): number { return 3; }\n');
      const explain = await runCli([
        'graph',
        'explain',
        '--home',
        home,
        '--cwd',
        root,
        '--symbol',
        'explainRefreshSymbol',
        '--json',
      ]);
      expect(explain.stdout).toContain('"freshness":"current"');
      expect(explain.stdout).toContain('"name":"explainRefreshSymbol"');
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 30_000);

  it('rejects conflicting explicit update channels before checking GitHub', async () => {
    await expect(runCli(['update', '--beta', '--stable', '--check'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Choose either --beta or --stable'),
    });
  });

  it('accepts shared runtime flags after the subcommand', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-'));
    try {
      const result = await runCli([
        'remember',
        '--home',
        home,
        '--dry-run',
        '--text',
        'CLI Effect composition',
        '--project',
        'threadnote',
        '--topic',
        'effect-cli',
      ]);
      expect(result.stdout).toContain('project: threadnote');
      expect(result.stdout).toContain('topic: effect-cli');
      expect(result.stdout).toContain('CLI Effect composition');
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('accepts explicit caller workspace context for recall', async () => {
    const result = await runCli([
      'recall',
      '--dry-run',
      '--caller-cwd',
      process.cwd(),
      '--query',
      'current repo latest handoff',
    ]);

    expect(result.stdout).toContain('current repo latest handoff');
    expect(result.stdout).toContain('threadnote');
    expect(result.stdout).toContain('threadnote://user/');
  });

  it('rejects retired daemon port flags', async () => {
    await expect(runCli(['--port', '70000', 'doctor', '--dry-run'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Unrecognized flag: --port'),
    });
  });

  it('does not revive daemon networking through legacy environment variables', async () => {
    const result = await runCli(['start', '--dry-run'], {
      THREADNOTE_HOST: '127.0.0.2',
      THREADNOTE_PORT: '24567',
    });

    expect(result.stdout).toContain('no daemon would be started');
    expect(result.stdout).not.toContain('127.0.0.2');
    expect(result.stdout).not.toContain('24567');
  });

  it('preserves dash-prefixed and equals-containing string values', async () => {
    const result = await runCli([
      'handoff',
      '--dry-run',
      '--project',
      'threadnote',
      '--topic',
      'cli-values',
      '--blockers',
      '- none',
      '--task=review=polish',
    ]);

    expect(result.stdout).toContain('blockers:\n- none');
    expect(result.stdout).toContain('task: review=polish');
  });

  it('renders expected Effect failures without a fiber dump', async () => {
    const error = await runCli(['remember', '--dry-run', '--text', '   ']).catch(
      cause => cause as NodeJS.ErrnoException,
    );

    expect(error).toMatchObject({code: 1});
    expect(String((error as NodeJS.ErrnoException & {stderr?: string}).stderr)).toContain(
      'Provide memory text with --text or --stdin.',
    );
    expect(String((error as NodeJS.ErrnoException & {stderr?: string}).stderr)).not.toContain('FiberFailure');
  });

  it('returns a non-zero exit code for an unknown subcommand', async () => {
    await expect(runCli(['definitely-not-a-command'])).rejects.toMatchObject({code: 1});
  });
});

function runCli(args: readonly string[], environment: NodeJS.ProcessEnv = {}) {
  return execFilePromise(process.execPath, ['src/standalone.ts', ...args], {
    cwd: process.cwd(),
    env: {...process.env, ...environment, NO_COLOR: '1'},
  });
}

async function runCliThroughJsonPipe(args: readonly string[]) {
  return (await runCliThroughPlatformPipe(args, 'json')) as {
    readonly allNamesMatched: boolean;
    readonly bytes: number;
    readonly nodeCount: number;
  };
}

async function runCliThroughTextPipe(args: readonly string[], input: string) {
  return (await runCliThroughPlatformPipe(args, 'text', input)) as {
    readonly bytes: number;
    readonly hasEnd: boolean;
    readonly hasStart: boolean;
  };
}

async function runCliThroughPlatformPipe(
  args: readonly string[],
  mode: 'json' | 'text',
  input?: string,
): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-effect-cli-platform-pipe-'));
  try {
    const windows = process.platform === 'win32';
    const scriptPath = join(root, windows ? 'pipeline.cmd' : 'pipeline.sh');
    const inputPath = join(root, 'input.txt');
    if (input !== undefined) await writeFile(inputPath, input);
    const quote = (value: string): string =>
      windows ? `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"` : `'${value.replaceAll("'", `'\\''`)}'`;
    const producer = [process.execPath, 'src/standalone.ts', ...args].map(quote).join(' ');
    const consumer = [process.execPath, 'test/fixtures/cli-output-consumer.ts', mode].map(quote).join(' ');
    const pipeline = `${producer}${input === undefined ? '' : ` < ${quote(inputPath)}`} | ${consumer}`;
    await writeFile(scriptPath, windows ? `@echo off\r\n${pipeline}\r\n` : `set -eu\n${pipeline}\n`);

    const shell = windows
      ? [process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe', '/d', '/s', '/c', scriptPath]
      : ['/bin/sh', scriptPath];
    const child = Bun.spawn(shell, {
      cwd: process.cwd(),
      env: {...process.env, NO_COLOR: '1'},
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`CLI ${mode} platform pipe failed with ${exitCode}.\n${stderr}`);
    }
    return JSON.parse(stdout);
  } finally {
    await rm(root, {force: true, recursive: true});
  }
}
