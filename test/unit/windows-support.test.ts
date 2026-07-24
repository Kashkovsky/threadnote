import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {isGitExecutable, resolveCommandInvocation, runCommandEffect} from '../../src/effect/command.js';
import {
  openVikingServerExecutableNames,
  pythonExecutableCandidates,
  quoteWindowsProcessArgument,
  shouldManageCommandShim,
  shouldRepairOpenVikingCliConfig,
  windowsProcessArgumentLine,
} from '../../src/lifecycle.js';
import {runtimeThreadnoteBinPath} from '../../src/update.js';
import {
  executableNames,
  findExecutable,
  findOpenVikingCli,
  pythonUserScriptsCandidateDirs,
  runCommand,
} from '../../src/utils.js';
import {runEffect} from '../helpers/effect-runtime.js';

const windowsIt = process.platform === 'win32' ? it : it.skip;
const posixIt = process.platform === 'win32' ? it.skip : it;

describe('Windows executable discovery', () => {
  it('expands PATHEXT for extensionless commands', () => {
    expect(executableNames('uv', 'win32', '.COM;.EXE;.CMD')).toEqual(['uv.COM', 'uv.EXE', 'uv.CMD', 'uv']);
  });

  it('does not append extensions to an explicit Windows launcher', () => {
    expect(executableNames('threadnote.cmd', 'win32', '.COM;.EXE;.CMD')).toEqual(['threadnote.cmd']);
  });

  it('only accepts native launchers for detached OpenViking servers', () => {
    expect(openVikingServerExecutableNames('win32', '.COM;.EXE;.BAT;.CMD')).toEqual([
      'openviking-server.COM',
      'openviking-server.EXE',
    ]);
  });

  windowsIt('prefers a native cmd launcher over an adjacent POSIX shim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote launcher order '));
    const originalPath = process.env.PATH;
    try {
      await writeFile(join(root, 'threadnote'), '#!/bin/sh\n');
      await writeFile(join(root, 'threadnote.cmd'), '@ECHO off\r\n');
      process.env.PATH = root;
      await expect(runEffect(findExecutable(['threadnote']))).resolves.toBe(join(root, 'threadnote.CMD'));
    } finally {
      process.env.PATH = originalPath;
      await rm(root, {force: true, recursive: true});
    }
  });

  windowsIt('finds an out-of-PATH OpenViking exe launcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote ov launcher '));
    const originalPath = process.env.PATH;
    const originalToolBin = process.env.UV_TOOL_BIN_DIR;
    try {
      await writeFile(join(root, 'ov.exe'), '');
      process.env.PATH = '';
      process.env.UV_TOOL_BIN_DIR = root;
      await expect(runEffect(findOpenVikingCli())).resolves.toBe(join(root, 'ov.EXE'));
    } finally {
      process.env.PATH = originalPath;
      if (originalToolBin === undefined) {
        delete process.env.UV_TOOL_BIN_DIR;
      } else {
        process.env.UV_TOOL_BIN_DIR = originalToolBin;
      }
      await rm(root, {force: true, recursive: true});
    }
  });

  windowsIt('discovers the Python user Scripts directory used by pip --user', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote python user scripts '));
    const fakeBin = join(root, 'bin');
    const userBase = join(root, 'python user base');
    const originalPath = process.env.PATH;
    const originalUserBase = process.env.THREADNOTE_TEST_USER_BASE;
    try {
      await mkdir(fakeBin, {recursive: true});
      await writeFile(join(fakeBin, 'python.cmd'), '@ECHO off\r\n@ECHO %THREADNOTE_TEST_USER_BASE%\r\n');
      process.env.PATH = fakeBin;
      process.env.THREADNOTE_TEST_USER_BASE = userBase;

      await expect(runEffect(pythonUserScriptsCandidateDirs('win32'))).resolves.toEqual([join(userBase, 'Scripts')]);
    } finally {
      process.env.PATH = originalPath;
      if (originalUserBase === undefined) {
        delete process.env.THREADNOTE_TEST_USER_BASE;
      } else {
        process.env.THREADNOTE_TEST_USER_BASE = originalUserBase;
      }
      await rm(root, {force: true, recursive: true});
    }
  });

  posixIt('skips directory shadows while searching PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote executable shadow '));
    const first = join(root, 'first');
    const second = join(root, 'second');
    const originalPath = process.env.PATH;
    try {
      await mkdir(join(first, 'uv'), {recursive: true});
      await mkdir(second, {recursive: true});
      const executable = join(second, 'uv');
      await writeFile(executable, '#!/bin/sh\n');
      await chmod(executable, 0o755);
      process.env.PATH = [first, second].join(delimiter);

      await expect(runEffect(findExecutable(['uv']))).resolves.toBe(executable);
    } finally {
      process.env.PATH = originalPath;
      await rm(root, {force: true, recursive: true});
    }
  });
});

describe('Windows command execution', () => {
  it('routes cmd launchers through ComSpec with escaped arguments', () => {
    expect(
      resolveCommandInvocation(
        'C:\\Program Files\\nodejs\\npm.cmd',
        ['install', 'package with spaces'],
        'win32',
        'C:\\Windows\\System32\\cmd.exe',
      ),
    ).toEqual({
      args: [],
      executable: 'C:\\Program^ Files\\nodejs\\npm.cmd ^"install^" ^"package^ with^ spaces^"',
      shell: 'C:\\Windows\\System32\\cmd.exe',
    });
  });

  it('runs native executables directly', () => {
    expect(resolveCommandInvocation('C:\\Python312\\python.exe', ['--version'], 'win32')).toEqual({
      args: ['--version'],
      executable: 'C:\\Python312\\python.exe',
    });
  });

  it('rejects command separators that cmd.exe cannot safely quote', () => {
    expect(() => resolveCommandInvocation('agent.cmd', ['safe\r\nwhoami'], 'win32')).toThrow(
      /do not accept NUL, CR, or LF/,
    );
  });

  it('recognizes resolved Windows Git launchers for environment sanitization', () => {
    expect(isGitExecutable('C:\\Program Files\\Git\\cmd\\git.EXE')).toBe(true);
    expect(isGitExecutable('C:\\tools\\git.cmd')).toBe(true);
    expect(isGitExecutable('C:\\tools\\not-git.exe')).toBe(false);
  });

  windowsIt('executes an npm-style cmd shim with metacharacters intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote cmd escaping '));
    const bin = join(root, 'node_modules', '.bin');
    const shim = join(bin, 'capture.cmd');
    const script = join(root, 'capture.cjs');
    const output = join(root, 'captured.json');
    const args = ['space value', 'amp&value', 'caret^value', '100%', 'quote"value', 'trailing\\'];
    try {
      await mkdir(bin, {recursive: true});
      await writeFile(
        script,
        "require('node:fs').writeFileSync(process.env.CAPTURE_OUTPUT, JSON.stringify(process.argv.slice(2)))\n",
      );
      await writeFile(shim, '@ECHO off\r\n"%CAPTURE_NODE%" "%CAPTURE_SCRIPT%" %*\r\n');

      const result = await runEffect(
        runCommand(shim, args, {
          env: {
            ...process.env,
            CAPTURE_NODE: process.execPath,
            CAPTURE_OUTPUT: output,
            CAPTURE_SCRIPT: script,
          },
        }),
      );

      expect(result.exitCode).toBe(0);
      await expect(readFile(output, 'utf8').then(value => JSON.parse(value))).resolves.toEqual(args);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  windowsIt(
    'terminates the complete cmd process tree on timeout',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote cmd timeout '));
      const shim = join(root, 'wait.cmd');
      const script = join(root, 'wait.cjs');
      const pidPath = join(root, 'child.pid');
      try {
        await writeFile(
          script,
          "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)\n",
        );
        await writeFile(shim, '@ECHO off\r\n"%TIMEOUT_NODE%" "%TIMEOUT_SCRIPT%" "%TIMEOUT_PID%"\r\n');

        const result = await runEffect(
          runCommandEffect(shim, [], {
            allowFailure: true,
            env: {
              ...process.env,
              TIMEOUT_NODE: process.execPath,
              TIMEOUT_PID: pidPath,
              TIMEOUT_SCRIPT: script,
            },
            timeoutMs: 1000,
          }),
        );
        const childPid = Number(await readFile(pidPath, 'utf8'));

        expect(result.exitCode).toBe(124);
        expect(() => process.kill(childPid, 0)).toThrow();
      } finally {
        await rm(root, {force: true, recursive: true});
      }
    },
    10_000,
  );
});

describe('Windows lifecycle defaults', () => {
  it('quotes detached server arguments using Windows command-line rules', () => {
    expect(quoteWindowsProcessArgument('')).toBe('""');
    expect(quoteWindowsProcessArgument('--config')).toBe('--config');
    expect(quoteWindowsProcessArgument('C:\\agent context\\ov.conf')).toBe('"C:\\agent context\\ov.conf"');
    expect(quoteWindowsProcessArgument('ends with slash \\')).toBe('"ends with slash \\\\"');
    expect(quoteWindowsProcessArgument('quote " value')).toBe('"quote \\" value"');
    expect(windowsProcessArgumentLine(['--config', 'C:\\agent context\\ov.conf', '--name', 'quote " value'])).toBe(
      '--config "C:\\agent context\\ov.conf" --name "quote \\" value"',
    );
  });

  it('uses native Python launcher candidates and preserves npm command wrappers', () => {
    expect(pythonExecutableCandidates('win32')).toEqual(['py', 'python', 'python3']);
    expect(shouldManageCommandShim('win32')).toBe(false);
  });

  it('refreshes only managed local OpenViking CLI configs when runtime overrides change', () => {
    const config = {
      account: 'local',
      agentContextHome: 'C:\\agent context',
      agentId: 'threadnote',
      host: '127.0.0.1',
      manifestPath: 'C:\\agent context\\seed-manifest.yaml',
      openVikingVersion: '0.4.10',
      port: 43127,
      user: 'windows-e2e',
    };
    const managed = JSON.stringify({
      account: 'local',
      agent_id: 'threadnote',
      timeout: 60,
      url: 'http://127.0.0.1:1933',
      user: 'windows-e2e',
    });
    const current = managed.replace(':1933', ':43127');
    const custom = JSON.stringify({
      account: 'local',
      agent_id: 'threadnote',
      api_key: 'managed-elsewhere',
      timeout: 60,
      url: 'https://openviking.example.com',
      user: 'windows-e2e',
    });

    expect(shouldRepairOpenVikingCliConfig(managed, config)).toBe(true);
    expect(shouldRepairOpenVikingCliConfig(current, config)).toBe(false);
    expect(shouldRepairOpenVikingCliConfig(custom, config)).toBe(false);
  });

  it('keeps existing POSIX defaults', () => {
    expect(pythonExecutableCandidates('linux')).toEqual(['python3', 'python']);
    expect(shouldManageCommandShim('linux')).toBe(true);
  });
});

describe('Windows update launcher paths', () => {
  it('resolves npm and bun wrappers from the native global prefix', () => {
    expect(runtimeThreadnoteBinPath('npm', 'C:\\Users\\dev\\AppData\\Roaming\\npm', 'win32')).toBe(
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\threadnote.cmd',
    );
    expect(runtimeThreadnoteBinPath('bun', 'C:\\Users\\dev\\.bun\\bin', 'win32')).toBe(
      'C:\\Users\\dev\\.bun\\bin\\threadnote.cmd',
    );
    expect(runtimeThreadnoteBinPath('deno', 'C:\\Users\\dev\\.deno\\bin', 'win32')).toBe(
      'C:\\Users\\dev\\.deno\\bin\\threadnote.cmd',
    );
  });

  it('keeps the POSIX npm layout', () => {
    expect(runtimeThreadnoteBinPath('npm', '/usr/local', 'linux')).toBe('/usr/local/bin/threadnote');
  });
});
