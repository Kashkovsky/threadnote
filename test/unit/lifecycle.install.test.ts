import {spawn, type ChildProcess} from 'node:child_process';
import {access, chmod, mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {NodeFileSystem, NodePath} from '@effect/platform-node';
import {Effect, Layer} from 'effect';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  ensureSupportedUvExecutable as ensureSupportedUvExecutablePromise,
  findOpenVikingServerEffect,
  findSupportedUvExecutable,
  getInstallCommands,
  isLlamaWheelArchiveExtractionFailure,
  localEmbedWheelIndexUrl,
  openVikingInstallFailureHelpLines,
  openVikingSourceBuildRetryForArchiveFailure,
  openVikingToolPython,
  resolveOpenVikingInstallCommand,
  stopDetachedOpenVikingServerForLaunchd,
} from '../../src/lifecycle.js';
import {fromPromise} from '../../src/effect/errors.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import type {RuntimeConfig} from '../../src/types.js';

const WHEEL_INDEX_ENV = 'THREADNOTE_LLAMA_WHEEL_INDEX';
const TOOL_PYTHON_ENV = 'THREADNOTE_OPENVIKING_PYTHON';
const TEST_INDEX = 'https://wheels.example/whl/cpu';
const METAL_INDEX = 'https://abetlen.github.io/llama-cpp-python/whl/metal';
const posixIt = process.platform === 'win32' ? it.skip : it;
const originalPath = process.env.PATH;
const childProcesses: ChildProcess[] = [];
const temporaryDirectories: string[] = [];
const ensureSupportedUvExecutable = () =>
  Effect.runPromise(fromPromise('ensure supported uv executable', ensureSupportedUvExecutablePromise));

async function fakeUv(version: string, selfUpdateVersion?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'threadnote-uv-test-'));
  temporaryDirectories.push(directory);
  const executable = join(directory, 'uv');
  const statePath = join(directory, 'version');
  await writeFile(statePath, `${version}\n`);
  await writeFile(
    executable,
    [
      '#!/bin/sh',
      `state=${JSON.stringify(statePath)}`,
      'if [ "$1" = "--version" ]; then',
      '  /bin/cat "$state"',
      '  exit 0',
      'fi',
      ...(selfUpdateVersion
        ? [
            'if [ "$1" = "self" ] && [ "$2" = "update" ]; then',
            `  printf '%s\\n' ${JSON.stringify(selfUpdateVersion)} > "$state"`,
            '  exit 0',
            'fi',
          ]
        : []),
      'exit 1',
      '',
    ].join('\n'),
  );
  await chmod(executable, 0o755);
  return executable;
}

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

afterEach(async () => {
  restoreEnv('PATH', originalPath);
  await Promise.all(childProcesses.splice(0).map(stopChild));
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {force: true, recursive: true})));
});

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 1000)) {
    return;
  }
  child.kill('SIGKILL');
  if (!(await waitForChildExit(child, 1000))) {
    throw new Error(`Could not stop test child ${child.pid ?? '<unknown>'}.`);
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function formatPsStart(date: Date): string {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => String(value).padStart(2, '0'))
    .join(':');
  return `${weekdays[date.getDay()]} ${months[date.getMonth()]} ${String(date.getDate()).padStart(2, ' ')} ${time} ${date.getFullYear()}`;
}

function launchdProcessTestLayer(processStart: string, commands: string | readonly string[], pid: number) {
  let psCalls = 0;
  const executor = Layer.succeed(
    CommandExecutor,
    CommandExecutor.of({
      execute: executable => {
        if (executable === '/bin/ps') {
          const command = typeof commands === 'string' ? commands : (commands[psCalls] ?? commands.at(-1) ?? '');
          psCalls += 1;
          return Effect.succeed({exitCode: 0, stderr: '', stdout: `${processStart} ${command}\n`});
        }
        if (executable === '/usr/sbin/lsof') {
          return Effect.succeed({exitCode: 0, stderr: '', stdout: `p${pid}\n`});
        }
        return Effect.succeed({exitCode: 127, stderr: 'unexpected command', stdout: ''});
      },
    }),
  );
  return Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, executor, SystemInfo.layer);
}

function runtime(): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: '/tmp/threadnote-test',
    agentId: 'threadnote',
    host: '127.0.0.1',
    manifestPath: '/tmp/threadnote-test/seed-manifest.yaml',
    openVikingVersion: '0.4.7',
    port: 1933,
    user: 'denys',
  };
}

const SPEC = 'openviking[local-embed]==0.4.7';
const UV_COMMAND = {
  executable: 'uv',
  args: [
    'tool',
    'install',
    '--system-certs',
    '--python',
    '3.12',
    '--with',
    'pip-system-certs',
    '--extra-index-url',
    METAL_INDEX,
    SPEC,
  ],
};

describe('uv compatibility', () => {
  it('skips an old uv that shadows a compatible candidate later on PATH', async () => {
    const oldUv = await fakeUv('uv 0.10.9');
    const currentUv = await fakeUv('uv 0.11.0');
    process.env.PATH = [join(oldUv, '..'), join(currentUv, '..'), '/usr/bin', '/bin'].join(delimiter);

    expect(await findSupportedUvExecutable()).toBe(currentUv);
    expect(await resolveOpenVikingInstallCommand(UV_COMMAND)).toEqual({...UV_COMMAND, executable: currentUv});
  });

  it('self-updates an old standalone uv before using --system-certs', async () => {
    const uv = await fakeUv('uv 0.10.9', 'uv 0.11.0');
    process.env.PATH = [join(uv, '..'), '/usr/bin', '/bin'].join(delimiter);

    expect(await ensureSupportedUvExecutable()).toBe(uv);
    expect(await findSupportedUvExecutable()).toBe(uv);
  });

  it('reports an actionable error when an old uv cannot be upgraded', async () => {
    const uv = await fakeUv('uv 0.10.9');
    process.env.PATH = [join(uv, '..'), '/usr/bin', '/bin'].join(delimiter);

    await expect(ensureSupportedUvExecutable()).rejects.toThrow(
      'Threadnote requires uv 0.11.0 or newer to use --system-certs',
    );
  });
});

describe('localEmbedWheelIndexUrl', () => {
  const original = process.env[WHEEL_INDEX_ENV];
  afterEach(() => restoreEnv(WHEEL_INDEX_ENV, original));

  it('defaults to the abetlen wheel index', () => {
    delete process.env[WHEEL_INDEX_ENV];
    expect(localEmbedWheelIndexUrl()).toContain('abetlen.github.io/llama-cpp-python/whl/');
  });

  it('honors an override', () => {
    process.env[WHEEL_INDEX_ENV] = TEST_INDEX;
    expect(localEmbedWheelIndexUrl()).toBe(TEST_INDEX);
  });

  it('treats an empty override as disabled', () => {
    process.env[WHEEL_INDEX_ENV] = '   ';
    expect(localEmbedWheelIndexUrl()).toBeUndefined();
  });
});

describe('openVikingToolPython', () => {
  const original = process.env[TOOL_PYTHON_ENV];
  afterEach(() => restoreEnv(TOOL_PYTHON_ENV, original));

  it('defaults to the pinned tool Python', () => {
    delete process.env[TOOL_PYTHON_ENV];
    expect(openVikingToolPython()).toBe('3.12');
  });

  it('honors an override', () => {
    process.env[TOOL_PYTHON_ENV] = '3.11';
    expect(openVikingToolPython()).toBe('3.11');
  });

  it('treats an empty override as no pin', () => {
    process.env[TOOL_PYTHON_ENV] = '';
    expect(openVikingToolPython()).toBeUndefined();
  });
});

describe('OpenViking install failure help', () => {
  const wheelExtractFailure = [
    '  × Failed to download `llama-cpp-python==0.3.31`',
    '  ├─▶ Failed to extract archive: llama_cpp_python-0.3.31-py3-none-macosx_11_0_arm64.whl',
    '  ╰─▶ ZIP file contains trailing contents after the end-of-central-directory record',
  ].join('\n');

  it('detects llama-cpp-python wheel archive extraction failures', () => {
    expect(isLlamaWheelArchiveExtractionFailure(wheelExtractFailure)).toBe(true);
    expect(isLlamaWheelArchiveExtractionFailure('CMake failed while building llama-cpp-python')).toBe(false);
  });

  it('builds an automatic Metal source-build retry for rejected prebuilt wheels', () => {
    const retry = openVikingSourceBuildRetryForArchiveFailure(UV_COMMAND, wheelExtractFailure);
    expect(retry).toBeDefined();
    expect(retry?.env).toEqual({
      CMAKE_ARGS: '-DGGML_METAL=on',
      CMAKE_BUILD_PARALLEL_LEVEL: '2',
    });
    expect(retry?.command.executable).toBe('uv');
    expect(retry?.command.args).not.toContain('--extra-index-url');
    expect(retry?.command.args).not.toContain(METAL_INDEX);
    expect(retry?.command.args).toContain(SPEC);
  });

  it('does not retry source builds for unrelated failures', () => {
    expect(openVikingSourceBuildRetryForArchiveFailure(UV_COMMAND, 'CMake failed')).toBeUndefined();
  });

  it('keeps wheel validation guidance if automatic retry cannot be constructed', () => {
    const command = {executable: 'uv', args: ['tool', 'install', SPEC]};
    const text = openVikingInstallFailureHelpLines(command, wheelExtractFailure).join('\n');
    expect(text).toContain('failed ZIP archive validation');
    expect(text).not.toContain('uv cache clean');
  });

  it('keeps generic compile context for other install failures', () => {
    const text = openVikingInstallFailureHelpLines(UV_COMMAND, 'CMake build failed').join('\n');
    expect(text).toContain('compiles from source when no prebuilt wheel matches');
    expect(text).toContain('package-manager output above contains the underlying build or download error');
    expect(text).not.toContain('uv cache clean');
  });

  it('recognizes an absolute uv executable in install failure guidance', () => {
    const text = openVikingInstallFailureHelpLines({...UV_COMMAND, executable: '/opt/homebrew/bin/uv'}).join('\n');
    expect(text).toContain('If uv could not fetch managed CPython');
  });
});

describe('getInstallCommands', () => {
  const originalIndex = process.env[WHEEL_INDEX_ENV];
  const originalPython = process.env[TOOL_PYTHON_ENV];
  beforeEach(() => {
    process.env[WHEEL_INDEX_ENV] = TEST_INDEX;
    delete process.env[TOOL_PYTHON_ENV];
  });
  afterEach(() => {
    restoreEnv(WHEEL_INDEX_ENV, originalIndex);
    restoreEnv(TOOL_PYTHON_ENV, originalPython);
  });

  it('pins uv to a wheel-supported Python and adds the wheel index', async () => {
    const [command, ...rest] = await getInstallCommands(runtime(), 'uv', false);
    expect(rest).toHaveLength(0);
    expect(command.executable).toBe('uv');
    expect(command.args).toEqual([
      'tool',
      'install',
      '--system-certs',
      '--python',
      '3.12',
      '--with',
      'pip-system-certs',
      '--extra-index-url',
      TEST_INDEX,
      SPEC,
    ]);
  });

  it('appends --force for a uv forced reinstall', async () => {
    const [command] = await getInstallCommands(runtime(), 'uv', true);
    expect(command.args).toContain('--force');
    expect(command.args.indexOf('--force')).toBe(command.args.indexOf(SPEC) - 1);
  });

  it('omits the wheel index for uv when disabled', async () => {
    process.env[WHEEL_INDEX_ENV] = '';
    const [command] = await getInstallCommands(runtime(), 'uv', false);
    expect(command.args).not.toContain('--extra-index-url');
    expect(command.args).toEqual([
      'tool',
      'install',
      '--system-certs',
      '--python',
      '3.12',
      '--with',
      'pip-system-certs',
      SPEC,
    ]);
  });

  it('drops the uv --python pin when disabled', async () => {
    process.env[TOOL_PYTHON_ENV] = '';
    const [command] = await getInstallCommands(runtime(), 'uv', false);
    expect(command.args).not.toContain('--python');
    expect(command.args).toEqual([
      'tool',
      'install',
      '--system-certs',
      '--with',
      'pip-system-certs',
      '--extra-index-url',
      TEST_INDEX,
      SPEC,
    ]);
  });

  it('passes the wheel index to pipx via --pip-args', async () => {
    const [install, inject] = await getInstallCommands(runtime(), 'pipx', false);
    expect(install.executable).toBe('pipx');
    expect(install.args).toEqual(['install', '--pip-args', `--extra-index-url ${TEST_INDEX}`, SPEC]);
    expect(inject.args).toEqual(['inject', 'openviking', 'pip-system-certs']);
  });

  it('adds the wheel index to the pip --user fallback', async () => {
    const [command] = await getInstallCommands(runtime(), 'pip', true);
    expect(command.executable).toMatch(/python3$/);
    expect(command.args).toEqual([
      '-m',
      'pip',
      'install',
      '--user',
      '--upgrade',
      '--force-reinstall',
      '--extra-index-url',
      TEST_INDEX,
      'pip-system-certs',
      SPEC,
    ]);
  });

  posixIt('uses a working python fallback when python3 is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadnote-python-fallback-'));
    temporaryDirectories.push(directory);
    const python = join(directory, 'python');
    await writeFile(python, '#!/bin/sh\nexit 0\n');
    await chmod(python, 0o755);
    process.env.PATH = directory;

    const [command] = await getInstallCommands(runtime(), 'pip', false);

    expect(command.executable).toBe(python);
  });
});

describe('findOpenVikingServerEffect', () => {
  it('interrupts Effect-native uv discovery at the supplied deadline', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-server-discovery-test-'));
    temporaryDirectories.push(home);
    const uv = join(home, 'uv');
    await writeFile(uv, '#!/bin/sh\n');
    await chmod(uv, 0o755);
    process.env.PATH = home;
    const layer = Layer.mergeAll(
      NodeFileSystem.layer,
      NodePath.layer,
      Layer.succeed(
        CommandExecutor,
        CommandExecutor.of({
          execute: () => Effect.never,
        }),
      ),
      SystemInfo.layer,
    );

    await expect(Effect.runPromise(findOpenVikingServerEffect(20).pipe(Effect.provide(layer)))).rejects.toThrow(
      'discovery timed out',
    );
  });
});

describe('stopDetachedOpenVikingServerForLaunchd', () => {
  posixIt('stops an identity-checked process through Effect command services', async () => {
    const config = runtime();
    const home = await mkdtemp(join(tmpdir(), 'threadnote-detached-test-'));
    temporaryDirectories.push(home);
    const server = join(home, 'openviking-server');
    await writeFile(server, `#!${process.execPath}\n`);
    await chmod(server, 0o755);
    process.env.PATH = home;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    childProcesses.push(child);
    const pidPath = join(home, 'openviking-server.pid');
    await writeFile(pidPath, `${child.pid}\n`);
    const current = {...config, agentContextHome: home};
    const processStart = formatPsStart((await stat(pidPath)).mtime);
    const expectedCommand = [
      process.execPath,
      server,
      '--config',
      join(home, 'ov.conf'),
      '--host',
      current.host,
      '--port',
      String(current.port),
    ].join(' ');

    await Effect.runPromise(
      stopDetachedOpenVikingServerForLaunchd(current, false, 2000).pipe(
        Effect.provide(launchdProcessTestLayer(processStart, expectedCommand, child.pid!)),
      ),
    );

    expect(child.signalCode).toBe('SIGTERM');
    await expect(access(pidPath)).rejects.toThrow();
  });

  posixIt('refuses to signal a process when Effect inspection rejects its identity', async () => {
    const config = runtime();
    const home = await mkdtemp(join(tmpdir(), 'threadnote-detached-test-'));
    temporaryDirectories.push(home);
    const server = join(home, 'openviking-server');
    await writeFile(server, `#!${process.execPath}\n`);
    await chmod(server, 0o755);
    process.env.PATH = home;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    childProcesses.push(child);
    const pidPath = join(home, 'openviking-server.pid');
    await writeFile(pidPath, `${child.pid}\n`);
    const processStart = formatPsStart((await stat(pidPath)).mtime);
    const expectedCommand = [
      process.execPath,
      server,
      '--config',
      join(home, 'ov.conf'),
      '--host',
      config.host,
      '--port',
      String(config.port),
    ].join(' ');

    await expect(
      Effect.runPromise(
        stopDetachedOpenVikingServerForLaunchd({...config, agentContextHome: home}, false, 2000).pipe(
          Effect.provide(
            launchdProcessTestLayer(processStart, [expectedCommand, '/usr/bin/unrelated --malicious'], child.pid!),
          ),
        ),
      ),
    ).rejects.toThrow('Refusing to stop process');

    expect(child.exitCode).toBeNull();
  });

  it('removes a malformed pid file without signaling a process', async () => {
    const config = runtime();
    const home = await mkdtemp(join(tmpdir(), 'threadnote-detached-test-'));
    temporaryDirectories.push(home);
    const pidPath = join(home, 'openviking-server.pid');
    await writeFile(pidPath, '');

    const stopped = await Effect.runPromise(
      stopDetachedOpenVikingServerForLaunchd({...config, agentContextHome: home}, false).pipe(
        Effect.provide(ApplicationLayer),
      ),
    );

    expect(stopped).toBe(false);
    await expect(access(pidPath)).rejects.toThrow();
  });

  posixIt('propagates pid file read failures', async () => {
    const config = runtime();
    const home = await mkdtemp(join(tmpdir(), 'threadnote-detached-test-'));
    temporaryDirectories.push(home);
    const pidPath = join(home, 'openviking-server.pid');
    await mkdir(pidPath);

    await expect(
      Effect.runPromise(
        stopDetachedOpenVikingServerForLaunchd({...config, agentContextHome: home}, false).pipe(
          Effect.provide(ApplicationLayer),
        ),
      ),
    ).rejects.toThrow();
  });
});
