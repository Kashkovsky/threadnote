import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join} from 'node:path';
import {promisify} from 'node:util';
import {Effect} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {
  cleanupStaleNvmThreadnoteInstallations,
  isSupportedNodeVersion,
  unsupportedNodeVersionMessage,
} from '../../src/node-runtime.js';

const execute = promisify(execFile);
const roots: string[] = [];
const posixIt = process.platform === 'win32' ? it.skip : it;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {force: true, recursive: true})));
});

describe('Node runtime compatibility', () => {
  it('matches the exact dependency-supported release lines', () => {
    for (const version of ['22.22.2', '22.99.0', '24.15.0', '24.18.0', '26.0.0', '27.1.0']) {
      expect(isSupportedNodeVersion(version), version).toBe(true);
    }
    for (const version of ['22.21.1', '22.22.0', '22.22.1', '23.99.0', '24.14.9', '25.9.0', 'invalid']) {
      expect(isSupportedNodeVersion(version), version).toBe(false);
    }
  });

  it('provides manager-specific recovery without claiming to mutate Node', () => {
    const nvmMessage = unsupportedNodeVersionMessage('22.21.1', {
      environment: () => ({NVM_DIR: '/tmp/nvm'}),
      executablePath: '/tmp/nvm/versions/node/v22.21.1/bin/node',
      platform: 'darwin',
    });
    expect(nvmMessage).toContain('nvm install 24');
    expect(nvmMessage).toContain('THREADNOTE_PACKAGE=threadnote@beta');
    expect(
      unsupportedNodeVersionMessage('22.21.1', {
        environment: () => ({}),
        executablePath: '/opt/homebrew/Cellar/node/22.21.1/bin/node',
        platform: 'darwin',
      }),
    ).toContain('brew upgrade node');
    expect(
      unsupportedNodeVersionMessage('22.21.1', {
        environment: () => ({}),
        executablePath: 'C:\\Program Files\\nodejs\\node.exe',
        platform: 'win32',
      }),
    ).toContain('winget upgrade --id OpenJS.NodeJS.LTS');
  });

  it('discovers only verified stale Threadnote packages in nvm during a dry run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-node-cleanup-'));
    roots.push(root);
    const versions = join(root, 'versions', 'node');
    const stalePackage = join(versions, 'v22.21.1', 'lib', 'node_modules', 'threadnote');
    const unrelatedPackage = join(versions, 'v20.0.0', 'lib', 'node_modules', 'threadnote');
    const currentPackage = join(versions, `v${process.versions.node}`, 'lib', 'node_modules', 'threadnote');
    await mkdir(stalePackage, {recursive: true});
    await mkdir(unrelatedPackage, {recursive: true});
    await mkdir(currentPackage, {recursive: true});
    await writeFile(join(stalePackage, 'package.json'), '{"name":"threadnote","version":"3.0.3"}\n');
    await writeFile(join(unrelatedPackage, 'package.json'), '{"name":"not-threadnote","version":"1.0.0"}\n');
    await writeFile(join(currentPackage, 'package.json'), '{"name":"threadnote","version":"4.0.0-beta.4"}\n');
    const system = await Effect.runPromise(SystemInfo.pipe(Effect.provide(ApplicationLayer)));
    const testSystem = SystemInfo.of({
      ...system,
      environment: () => ({...system.environment(), NVM_DIR: root}),
    });

    const result = await Effect.runPromise(
      captureConsole(cleanupStaleNvmThreadnoteInstallations({dryRun: true})).pipe(
        Effect.provideService(SystemInfo, testSystem),
        Effect.provide(ApplicationLayer),
      ),
    );

    expect(result.output).toContain('Would remove stale Threadnote 3.0.3 from nvm Node 22.21.1.');
    expect(result.output).not.toContain('not-threadnote');
    expect(result.output).not.toContain(`nvm Node ${process.versions.node}`);
  });

  posixIt('does not follow a package symlink outside its nvm version boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-node-cleanup-boundary-'));
    roots.push(root);
    const versionRoot = join(root, 'versions', 'node', 'v22.21.1');
    const packageParent = join(versionRoot, 'lib', 'node_modules');
    const outsidePackage = join(root, 'outside', 'threadnote');
    await mkdir(packageParent, {recursive: true});
    await mkdir(outsidePackage, {recursive: true});
    await writeFile(join(outsidePackage, 'package.json'), '{"name":"threadnote","version":"9.9.9"}\n');
    await symlink(outsidePackage, join(packageParent, 'threadnote'));
    const system = await Effect.runPromise(SystemInfo.pipe(Effect.provide(ApplicationLayer)));
    const testSystem = SystemInfo.of({
      ...system,
      environment: () => ({...system.environment(), NVM_DIR: root}),
    });

    const result = await Effect.runPromise(
      captureConsole(cleanupStaleNvmThreadnoteInstallations({dryRun: true})).pipe(
        Effect.provideService(SystemInfo, testSystem),
        Effect.provide(ApplicationLayer),
      ),
    );

    expect(result.output).not.toContain('9.9.9');
    await expect(readFile(join(outsidePackage, 'package.json'), 'utf8')).resolves.toContain('"threadnote"');
  });

  posixIt('uninstalls a verified stale package through its owning nvm Node runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-node-cleanup-apply-'));
    roots.push(root);
    const versionRoot = join(root, 'versions', 'node', 'v22.21.1');
    const stalePackage = join(versionRoot, 'lib', 'node_modules', 'threadnote');
    const node = join(versionRoot, 'bin', 'node');
    const npmCli = join(versionRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await mkdir(stalePackage, {recursive: true});
    await mkdir(dirname(node), {recursive: true});
    await mkdir(dirname(npmCli), {recursive: true});
    await writeFile(join(stalePackage, 'package.json'), '{"name":"threadnote","version":"3.0.3"}\n');
    await writeFile(
      node,
      '#!/bin/sh\nroot="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nprintf \'%s\\n\' "$*" > "$root/cleanup.args"\nrm -f "$root/lib/node_modules/threadnote/package.json"\n',
    );
    await writeFile(npmCli, '// fixture\n');
    await chmod(node, 0o755);
    const system = await Effect.runPromise(SystemInfo.pipe(Effect.provide(ApplicationLayer)));
    const testSystem = SystemInfo.of({
      ...system,
      environment: () => ({...system.environment(), NVM_DIR: root}),
    });

    const result = await Effect.runPromise(
      captureConsole(cleanupStaleNvmThreadnoteInstallations({dryRun: false})).pipe(
        Effect.provideService(SystemInfo, testSystem),
        Effect.provide(ApplicationLayer),
      ),
    );

    expect(result.output).toContain('Removed stale Threadnote 3.0.3 from nvm Node 22.21.1.');
    expect(await readFile(join(versionRoot, 'cleanup.args'), 'utf8')).toContain(
      `uninstall --global --prefix ${versionRoot} threadnote --ignore-scripts`,
    );
    await expect(readFile(join(stalePackage, 'package.json'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  posixIt('bootstrap rejects unsupported Node before invoking npm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-node-preflight-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const calls = join(root, 'calls.log');
    await mkdir(bin, {recursive: true});
    await writeFile(join(bin, 'node'), '#!/bin/sh\nif [ "$1" = "-p" ]; then echo 22.21.1; exit 0; fi\nexit 1\n');
    await writeFile(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\n`);
    await chmod(join(bin, 'node'), 0o755);
    await chmod(join(bin, 'npm'), 0o755);

    await expect(
      execute('/bin/sh', [join(process.cwd(), 'scripts', 'install.sh')], {
        env: {
          ...process.env,
          HOME: root,
          PATH: [bin, '/usr/bin', '/bin'].join(delimiter),
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('requires Node ^22.22.2 || ^24.15.0 || >=26.0.0'),
    });
    await expect(readFile(calls, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });
});
