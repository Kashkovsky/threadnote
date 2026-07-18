import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {platform, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const constants = await readFile(resolve(root, 'src', 'constants.ts'), 'utf8');
const version = /DEFAULT_OPENVIKING_VERSION\s*=\s*'([^']+)'/.exec(constants)?.[1];
if (!version) throw new Error('Could not read DEFAULT_OPENVIKING_VERSION from src/constants.ts.');

const installed = await readInstalledCliVersion();
const installedVersion = installed.version;
const serverInstalled = spawnSync('openviking-server', ['--version'], {encoding: 'utf8'});
const installedServerVersion = /openviking-server\s+(\S+)/.exec(
  `${serverInstalled.stdout}${serverInstalled.stderr}`,
)?.[1];
if (
  installed.status === 0 &&
  serverInstalled.status === 0 &&
  installedVersion === version &&
  installedServerVersion === version
) {
  console.log(`OpenViking ${version} is already installed for local-bin E2E.`);
  process.exit(0);
}

const uv = spawnSync('uv', ['--version'], {encoding: 'utf8'});
if (uv.status !== 0) {
  throw new Error('uv is required. Install uv, then rerun npm run test:e2e:install-openviking.');
}

const wheelIndex = `https://abetlen.github.io/llama-cpp-python/whl/${platform() === 'darwin' ? 'metal' : 'cpu'}`;
const args = [
  'tool',
  'install',
  '--system-certs',
  '--python',
  '3.12',
  '--refresh-package',
  'llama-cpp-python',
  '--with',
  'pip-system-certs',
  '--extra-index-url',
  wheelIndex,
  ...(installed.status === 0 ? ['--force'] : []),
  `openviking[local-embed]==${version}`,
];
console.log(`Installing pinned OpenViking ${version} for local-bin E2E...`);
let result = spawnSync('uv', args, {cwd: root, stdio: 'inherit'});
if (result.status !== 0) {
  console.warn('The prebuilt llama-cpp-python wheel failed; retrying with a local source build.');
  console.warn('This fallback can take 10-20 minutes.');
  const sourceArgs = args.filter((arg, index) => {
    const previous = args[index - 1];
    return (
      arg !== '--extra-index-url' &&
      previous !== '--extra-index-url' &&
      arg !== '--refresh-package' &&
      previous !== '--refresh-package'
    );
  });
  result = spawnSync('uv', sourceArgs, {
    cwd: root,
    env: {
      ...process.env,
      ...(platform() === 'darwin' ? {CMAKE_ARGS: '-DGGML_METAL=on'} : {}),
      CMAKE_BUILD_PARALLEL_LEVEL: '2',
    },
    stdio: 'inherit',
  });
}
if (result.status !== 0) process.exit(result.status ?? 1);

const verified = await readInstalledCliVersion();
const verifiedVersion = verified.version;
const verifiedServer = spawnSync('openviking-server', ['--version'], {encoding: 'utf8'});
const verifiedServerVersion = /openviking-server\s+(\S+)/.exec(`${verifiedServer.stdout}${verifiedServer.stderr}`)?.[1];
if (
  verified.status !== 0 ||
  verifiedServer.status !== 0 ||
  verifiedVersion !== version ||
  verifiedServerVersion !== version
) {
  throw new Error(
    `Expected OpenViking CLI/server ${version} after installation, got CLI ${verifiedVersion ?? 'unavailable'} and server ${verifiedServerVersion ?? 'unavailable'}.`,
  );
}
console.log(`OpenViking ${version} is ready for local-bin E2E.`);

async function readInstalledCliVersion() {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-e2e-ov-version-'));
  try {
    const env = {...process.env, HOME: home, USERPROFILE: home};
    const language = spawnSync('ov', ['language', 'en'], {encoding: 'utf8', env});
    if (language.status !== 0) return {status: language.status, version: undefined};
    const result = spawnSync('ov', ['--version'], {encoding: 'utf8', env});
    const parsed = /^\s*openviking(?:\s+CLI)?\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/im.exec(
      `${result.stdout}\n${result.stderr}`,
    )?.[1];
    return {status: result.status, version: parsed};
  } finally {
    await rm(home, {force: true, recursive: true});
  }
}
