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
  {
    name: 'Threadnote 5 independent observer authority',
    path: 'scripts/assemble-threadnote-5-observer-authority.ts',
    usage: 'Usage: bun run assemble:threadnote-5-observer-authority',
  },
] as const;

const FOLLOW_UP_RELEASE_TOOL_SCRIPTS = [
  {
    name: 'Threadnote 5 release-readiness receipt verification',
    path: 'scripts/verify-threadnote-5-release-readiness-receipts.ts',
    usage: 'Usage: bun run verify:threadnote-5-release-readiness-receipts -- [options]',
  },
  {
    name: 'Code-graph heavy-tail benchmark',
    path: 'scripts/benchmark-code-graph-heavy-tail.ts',
    usage: 'Usage: bun run bench:code-graph:heavy-tail -- [options]',
  },
  {
    name: 'Context Brief citation benchmark',
    path: 'scripts/benchmark-context-brief-citations.ts',
    usage: 'Usage: bun run bench:context-brief-citations -- [options]',
  },
  {
    name: 'Code-memory-link scale benchmark',
    path: 'scripts/benchmark-code-memory-link-scale.ts',
    usage: 'Usage: bun run bench:code-memory-link-scale -- [options]',
  },
  {
    name: 'Memory-connections scale benchmark',
    path: 'scripts/benchmark-memory-connections-scale.ts',
    usage: 'Usage: bun run bench:memory-connections-scale -- [options]',
  },
] as const;

const HELP_FLAGS = ['--help', '-h'] as const;

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

  it.each(FOLLOW_UP_RELEASE_TOOL_SCRIPTS)('$name prints bounded help without running the operation', async script => {
    for (const helpFlag of HELP_FLAGS) {
      const result = await execFilePromise(process.execPath, [script.path, helpFlag, '--not-an-operation-option'], {
        cwd: process.cwd(),
      });
      expect(result.stdout).toContain(script.usage);
      expect(result.stdout.length).toBeLessThanOrEqual(4_096);
      expect(result.stdout).not.toMatch(/(?:failed|refused|unknown option|Error|Stack trace)/iu);
      expect(result.stderr).toBe('');
    }
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

  it('documents the heavy-tail child output option', async () => {
    const result = await execFilePromise(process.execPath, ['scripts/benchmark-code-graph-heavy-tail.ts', '--help'], {
      cwd: process.cwd(),
    });
    expect(result.stdout).toContain(
      'Child options: --child --repository <path> --home <path> --profile-file <json> --output <json>',
    );
  });

  it('enumerates the complete observer-authority mode contract', async () => {
    const result = await execFilePromise(
      process.execPath,
      ['scripts/assemble-threadnote-5-observer-authority.ts', '--help'],
      {cwd: process.cwd()},
    );
    expect(result.stdout).toContain('Preview: --preview');
    expect(result.stdout).toContain('Assemble: --assemble');
    expect(result.stdout).toContain('Verify: --verify --bundle <json>');
    expect(result.stdout).toContain('--manifest-sha256 <64-lowercase-hex>');
    expect(result.stdout).toContain('--review-artifact-set-sha256 <64-lowercase-hex>');
    expect(result.stdout).toContain('--binding-sha256 <64-lowercase-hex>');
    expect(result.stdout).not.toContain('--output');
    expect(result.stdout).not.toContain('--binding-output');
  });
});
