import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {promisify} from 'node:util';
import {expect, it} from 'vitest';

const execute = promisify(execFile);
const windowsIt = process.platform === 'win32' ? it : it.skip;

windowsIt('PowerShell bootstrap installs npm and forwards only native Threadnote options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-windows-bootstrap-'));
  const fakeBin = join(root, 'bin');
  const prefix = join(root, 'prefix');
  const log = join(root, 'calls.log');
  await mkdir(fakeBin, {recursive: true});
  await mkdir(prefix, {recursive: true});
  await writeFile(
    join(fakeBin, 'npm.cmd'),
    '@ECHO off\r\n@ECHO npm %* postinstall=%NODE_LLAMA_CPP_POSTINSTALL%>>"%THREADNOTE_TEST_LOG%"\r\n@if /I "%~1"=="prefix" @ECHO %THREADNOTE_TEST_PREFIX%\r\n',
  );
  await writeFile(
    join(prefix, 'threadnote.cmd'),
    '@ECHO off\r\n@ECHO threadnote %*>>"%THREADNOTE_TEST_LOG%"\r\n@exit /b 0\r\n',
  );
  const powerShellDirectory = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
  try {
    const result = await execute(
      join(powerShellDirectory, 'powershell.exe'),
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(process.cwd(), 'scripts', 'install.ps1'),
        '-DryRun',
        '-NoStart',
        '-WithHooks',
      ],
      {
        env: {
          ...process.env,
          PATH: [fakeBin, powerShellDirectory].join(delimiter),
          THREADNOTE_TEST_LOG: log,
          THREADNOTE_TEST_PREFIX: prefix,
        },
        timeout: 60_000,
      },
    );
    expect(`${result.stdout}${result.stderr}`).toContain('Threadnote is installed');
    const calls = (await readFile(log, 'utf8')).replaceAll('"', '');
    expect(calls).toContain('npm install --global threadnote@latest');
    expect(calls).toContain('postinstall=skip');
    expect(calls).toContain('threadnote install --dry-run --no-start --with-hooks');
    expect(calls).not.toMatch(/python|pip|openviking|package-manager/i);
  } finally {
    await rm(root, {force: true, recursive: true});
  }
});
