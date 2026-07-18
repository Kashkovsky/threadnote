import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  getInstallCommands,
  isLlamaWheelArchiveExtractionFailure,
  localEmbedWheelIndexUrl,
  openVikingInstallFailureHelpLines,
  openVikingSourceBuildRetryForArchiveFailure,
  openVikingToolPython,
} from '../../src/lifecycle.js';
import type {RuntimeConfig} from '../../src/types.js';

const WHEEL_INDEX_ENV = 'THREADNOTE_LLAMA_WHEEL_INDEX';
const TOOL_PYTHON_ENV = 'THREADNOTE_OPENVIKING_PYTHON';
const TEST_INDEX = 'https://wheels.example/whl/cpu';
const METAL_INDEX = 'https://abetlen.github.io/llama-cpp-python/whl/metal';

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
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
    '--system-certs',
    'tool',
    'install',
    '--python',
    '3.12',
    '--with',
    'pip-system-certs',
    '--extra-index-url',
    METAL_INDEX,
    SPEC,
  ],
};

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
      '--system-certs',
      'tool',
      'install',
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
      '--system-certs',
      'tool',
      'install',
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
      '--system-certs',
      'tool',
      'install',
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
