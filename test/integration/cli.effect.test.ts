import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
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

  it('rejects conflicting explicit update channels before checking npm', async () => {
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
  return execFilePromise(process.execPath, ['--import', 'tsx', 'src/threadnote.ts', ...args], {
    cwd: process.cwd(),
    env: {...process.env, ...environment, NO_COLOR: '1'},
  });
}
