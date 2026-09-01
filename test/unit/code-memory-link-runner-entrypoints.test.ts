import {execFile} from '../helpers/node-child-process.js';
import {promisify} from '../helpers/node-util.js';
import {describe, expect, it} from 'vitest';

const execFilePromise = promisify(execFile);

describe('Code Memory Link evidence runner entrypoints', () => {
  it.each([
    ['scripts/describe-code-memory-link-client.ts', [], '--client-command requires a value'],
    ['scripts/run-code-memory-link-calibration-client.ts', [], '--candidate-commit requires a value'],
    ['scripts/run-code-memory-link-agent-trial.ts', [], '--assignment requires a value'],
    [
      'scripts/run-code-memory-link-agent-trial.ts',
      ['--assignment', 'fixture.json', '--approval-commit', 'a'.repeat(40)],
      '--attempts requires a value',
    ],
    ['scripts/run-code-memory-link-dogfood.ts', [], '--approval-commit requires a value'],
    ['scripts/retain-code-memory-link-evidence.ts', [], '--candidate-commit requires a value'],
    ['scripts/verify-code-memory-link-release.ts', [], '--release-descriptor'],
  ])('loads %s before rejecting missing arguments', async (script, args, expected) => {
    const failure = await execFilePromise(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: {...process.env, NO_COLOR: '1'},
      timeout: 30_000,
    }).catch(cause => cause as {readonly stderr?: string; readonly stdout?: string});
    const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;

    expect(output).toContain(expected);
    expect(output).not.toContain('SyntaxError');
    expect(output).not.toContain('Export named');
  });
});
