import {execFile} from '../helpers/node-child-process.js';
import {promisify} from '../helpers/node-util.js';
import {describe, expect, it} from 'vitest';

const execFilePromise = promisify(execFile);

const RELEASE_TOOL_SCRIPTS = [
  {
    name: 'Stage 3 code-graph gate',
    path: 'scripts/run-code-graph-stage3-gate.ts',
    usage: 'Usage: bun run gate:code-graph:stage3',
  },
  {
    name: 'Threadnote 5 release-readiness capture',
    path: 'scripts/capture-threadnote-5-release-readiness.ts',
    usage: 'Usage: bun run capture:threadnote-5-release-readiness',
  },
  {
    name: 'Threadnote 5 release-readiness evaluation',
    path: 'scripts/evaluate-threadnote-5-release-readiness.ts',
    usage: 'Usage: bun run eval:threadnote-5-release-readiness',
  },
] as const;

describe('release tooling CLI help contract', () => {
  it.each(RELEASE_TOOL_SCRIPTS)('$name prints bounded help without running the operation', async script => {
    const result = await execFilePromise(process.execPath, [script.path, '--help', '--not-an-operation-option'], {
      cwd: process.cwd(),
    });
    expect(result.stdout).toContain(script.usage);
    expect(result.stdout.length).toBeLessThanOrEqual(4_096);
    expect(result.stdout).not.toMatch(/(?:failed|refused|unknown option|Error|Stack trace)/iu);
    expect(result.stderr).toBe('');
  });

  it('enumerates the evaluator-only optional options', async () => {
    const result = await execFilePromise(
      process.execPath,
      ['scripts/evaluate-threadnote-5-release-readiness.ts', '--help'],
      {cwd: process.cwd()},
    );
    expect(result.stdout).toContain('--retained-subsystem-receipts <json>');
    expect(result.stdout).toContain('--baseline-trial-ledger-sha256 <64-hex>');
    expect(result.stdout).toContain('--authority-manifest-sha256 <64-hex>');
  });
});
