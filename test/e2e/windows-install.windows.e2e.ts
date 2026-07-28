import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect, it} from 'vitest';

const execute = promisify(execFile);
const windowsIt = process.platform === 'win32' ? it : it.skip;

windowsIt('PowerShell bootstrap verifies and installs the standalone Bun release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-windows-bootstrap-'));
  const distribution = join(process.cwd(), 'dist');
  const packageManifest = (await Bun.file(join(process.cwd(), 'package.json')).json()) as {readonly version: string};
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const artifactName = `threadnote-windows-${architecture}.tar.gz`;
  const artifact = join(root, artifactName);
  const checksum = `${artifact}.sha256`;
  const installRoot = join(root, 'install');
  const binRoot = join(root, 'bin');
  const userHome = join(root, 'user');
  const powerShellDirectory = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
  await Promise.all([mkdir(installRoot, {recursive: true}), mkdir(binRoot, {recursive: true}), mkdir(userHome)]);

  try {
    await execute('tar.exe', ['-czf', artifact, '-C', distribution, '.']);
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(new Uint8Array(await Bun.file(artifact).arrayBuffer()));
    await writeFile(checksum, `${hasher.digest('hex')}  ${artifactName}\n`);
    const assetRequests: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const name = new URL(request.url).pathname.slice(1);
        if (name === 'releases') {
          return Response.json([
            {
              draft: false,
              immutable: true,
              prerelease: true,
              tag_name: 'v4.0.0-beta.7',
            },
            {
              draft: false,
              immutable: false,
              prerelease: true,
              tag_name: 'v4.0.0-beta.6',
            },
            {
              draft: true,
              immutable: true,
              prerelease: true,
              tag_name: 'v4.0.0-beta.5',
            },
            {
              draft: false,
              immutable: true,
              prerelease: true,
              tag_name: `v${packageManifest.version}`,
            },
          ]);
        }
        assetRequests.push(name);
        if (name === artifactName) return new Response(Bun.file(artifact));
        if (name === `${artifactName}.sha256`) return new Response(Bun.file(checksum));
        return new Response('not found', {status: 404});
      },
    });
    try {
      const installerArguments = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(process.cwd(), 'scripts', 'install.ps1'),
        '-NoStart',
        '-WithHooks',
      ];
      const installEnvironment = {
        ...process.env,
        HOME: userHome,
        LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
        PATH: [powerShellDirectory, join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(delimiter),
        THREADNOTE_BIN_DIR: binRoot,
        THREADNOTE_INSTALL_ROOT: installRoot,
        THREADNOTE_CHANNEL: 'beta',
        THREADNOTE_RELEASE_DOWNLOAD_ROOT: `http://127.0.0.1:${server.port}`,
        THREADNOTE_RELEASE_SOURCE: `http://127.0.0.1:${server.port}/releases`,
        USERPROFILE: userHome,
      };
      for (const rejectedVersion of ['4.0.0-beta.6', '4.0.0-beta.5', '4.0.0-beta.4']) {
        const requestsBefore = assetRequests.length;
        const failure = await execute(join(powerShellDirectory, 'powershell.exe'), installerArguments, {
          env: {...installEnvironment, THREADNOTE_VERSION: rejectedVersion},
          timeout: 60_000,
        }).catch((cause: unknown) => cause);
        expect(
          `${String((failure as {readonly stdout?: unknown}).stdout)}${String((failure as {readonly stderr?: unknown}).stderr)}`,
        ).toContain(`Threadnote ${rejectedVersion} is not a published immutable release.`);
        expect(assetRequests).toHaveLength(requestsBefore);
      }
      const exactFailure = await execute(join(powerShellDirectory, 'powershell.exe'), installerArguments, {
        env: {
          ...installEnvironment,
          THREADNOTE_RELEASE_DOWNLOAD_ROOT: `http://127.0.0.1:${server.port}/missing-assets`,
          THREADNOTE_VERSION: packageManifest.version,
        },
        timeout: 60_000,
      }).catch((cause: unknown) => cause);
      expect(String((exactFailure as {readonly stdout?: unknown}).stdout)).toContain(
        `Downloading Threadnote ${packageManifest.version}`,
      );
      expect(assetRequests.at(-1)).toBe(`missing-assets/${artifactName}`);
      const result = await execute(join(powerShellDirectory, 'powershell.exe'), installerArguments, {
        env: installEnvironment,
        timeout: 600_000,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(`Installed standalone Threadnote ${packageManifest.version}`);
      expect(output).toContain('Wrote command launcher');
      expect(output).toContain('Threadnote is installed');
      expect(output).not.toMatch(/\bnpm\b|Python|OpenViking/i);
      const installedExecutable = join(installRoot, 'versions', packageManifest.version, 'threadnote.exe');
      await expect(stat(installedExecutable)).resolves.toMatchObject({size: expect.any(Number)});
      const version = await execute(installedExecutable, ['--version']);
      expect(version.stdout).toContain(packageManifest.version);
      const launcherVersion = await execute(join(binRoot, 'threadnote.cmd'), ['--version'], {
        env: {
          ...process.env,
          HOME: userHome,
          LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
          THREADNOTE_HOME: join(userHome, '.threadnote'),
          USERPROFILE: userHome,
        },
      });
      expect(launcherVersion.stdout).toContain(packageManifest.version);
      const transport = new StdioClientTransport({
        args: ['/d', '/s', '/c', `""${join(binRoot, 'threadnote-mcp-server.cmd')}""`],
        command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: userHome,
          LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
          THREADNOTE_HOME: join(userHome, '.threadnote'),
          USERPROFILE: userHome,
        } as Record<string, string>,
      });
      const client = new Client({name: 'threadnote-windows-installer-e2e', version: packageManifest.version});
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools.map(tool => tool.name)).toContain('recall_context');
      } finally {
        await client.close();
      }
      expect(
        JSON.parse(await readFile(join(installRoot, 'versions', packageManifest.version, 'release.json'), 'utf8')),
      ).toMatchObject({version: packageManifest.version});
    } finally {
      server.stop(true);
    }
  } finally {
    await rm(root, {force: true, recursive: true});
  }
});
