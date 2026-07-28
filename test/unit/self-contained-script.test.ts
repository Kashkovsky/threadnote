import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';

const execute = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, {force: true, recursive: true})));
});

describe('self-contained package check', () => {
  it('runs npm through the active Node runtime when PATH has no npm shim', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'threadnote-self-contained-check-'));
    temporaryRoots.push(temporaryRoot);
    const fakeNpmCli = join(temporaryRoot, 'npm-cli.cjs');
    await writeFile(
      fakeNpmCli,
      `process.stdout.write(JSON.stringify([{files: [
        {path: "bin/node-warning-filter.cjs"},
        {path: "scripts/check-node-version.cjs"}
      ]}]))\n`,
      'utf8',
    );

    const result = await execute(process.execPath, [join(process.cwd(), 'scripts', 'check-self-contained.mjs')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: temporaryRoot,
        npm_execpath: fakeNpmCli,
      },
      timeout: 10_000,
    });

    expect(result.stdout).toContain('Self-contained source and package checks passed.');
  });
});
