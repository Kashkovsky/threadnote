import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  commandShimCheck,
  ensureSupportedUvExecutable,
  findSupportedUvExecutable,
  getInstallCommands,
  isLlamaWheelArchiveExtractionFailure,
  localEmbedWheelIndexUrl,
  openVikingInstallFailureHelpLines,
  openVikingSourceBuildRetryForArchiveFailure,
  openVikingToolPython,
  resolveOpenVikingInstallCommand,
} from '../../src/lifecycle.js';
import type {RuntimeConfig} from '../../src/types.js';

const WHEEL_INDEX_ENV = 'THREADNOTE_LLAMA_WHEEL_INDEX';
const TOOL_PYTHON_ENV = 'THREADNOTE_OPENVIKING_PYTHON';
const TEST_INDEX = 'https://wheels.example/whl/cpu';
const METAL_INDEX = 'https://abetlen.github.io/llama-cpp-python/whl/metal';
const originalPath = process.env.PATH;
const originalAppManaged = process.env.THREADNOTE_APP_MANAGED;
const originalBinDir = process.env.THREADNOTE_BIN_DIR;
const temporaryDirectories: string[] = [];

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
  restoreEnv('THREADNOTE_APP_MANAGED', originalAppManaged);
  restoreEnv('THREADNOTE_BIN_DIR', originalBinDir);
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {force: true, recursive: true})));
});

describe('app-managed launcher', () => {
  it('accepts the executable installed by the macOS app', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'threadnote-app-launcher-'));
    temporaryDirectories.push(directory);
    const launcher = join(directory, 'threadnote');
    await writeFile(launcher, 'app launcher');
    await chmod(launcher, 0o755);
    process.env.THREADNOTE_APP_MANAGED = '1';
    process.env.THREADNOTE_BIN_DIR = directory;

    await expect(commandShimCheck()).resolves.toEqual({
      name: 'threadnote launcher',
      status: 'ok',
      detail: `${launcher} (app-managed)`,
    });
  });
});

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
    expect(command.executable).toBe('python3');
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
});
