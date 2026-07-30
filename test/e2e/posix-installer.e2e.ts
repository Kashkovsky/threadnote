import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, rm, stat, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect, it} from 'vitest';

const execute = promisify(execFile);
const posixIt = process.platform === 'win32' ? it.skip : it;

posixIt('POSIX bootstrap verifies and installs the standalone Bun release without Node or Bun in PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-posix-bootstrap-'));
  const packageManifest = (await Bun.file(join(process.cwd(), 'package.json')).json()) as {readonly version: string};
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const artifactName = `threadnote-${platform}-${architecture}.tar.gz`;
  const artifact = join(root, artifactName);
  const checksum = `${artifact}.sha256`;
  const installRoot = join(root, 'install');
  const binRoot = join(root, 'bin');
  const userHome = join(root, 'user');
  await Promise.all([mkdir(installRoot, {recursive: true}), mkdir(binRoot, {recursive: true}), mkdir(userHome)]);

  try {
    await execute(process.execPath, [join(process.cwd(), 'scripts', 'archive-release.ts')], {
      env: {
        ...process.env,
        THREADNOTE_ARTIFACTS_ROOT: root,
        THREADNOTE_RELEASE_TARGET: `${platform}-${architecture}`,
      },
    });
    const unsafeParentArtifact = join(root, 'unsafe-parent.tar.gz');
    const unsafeLinkArtifact = join(root, 'unsafe-link.tar.gz');
    await Promise.all([
      writeTarGzipFixture(unsafeParentArtifact, {
        contents: 'must not escape\n',
        name: '../threadnote-parent-escape.txt',
        type: 'file',
      }),
      writeTarGzipFixture(unsafeLinkArtifact, {
        linkName: '../../threadnote-link-escape.txt',
        name: 'runtime/escape',
        type: 'symlink',
      }),
    ]);
    const [unsafeParentChecksum, unsafeLinkChecksum] = await Promise.all([
      checksumDocument(unsafeParentArtifact, artifactName),
      checksumDocument(unsafeLinkArtifact, artifactName),
    ]);
    const officialToolsRoot = join(root, 'official-tools');
    const officialInstallRoot = join(root, 'official-install');
    const officialBinRoot = join(root, 'official-bin');
    const officialUserHome = join(root, 'official-user');
    const officialArtifactName = 'threadnote-darwin-arm64.tar.gz';
    const officialChecksum = join(root, `${officialArtifactName}.sha256`);
    const officialReleases = join(root, 'official-releases.json');
    const signatureLog = join(root, 'official-signatures.log');
    const checksumHex = (await readFile(checksum, 'utf8')).trim().split(/\s+/, 1)[0];
    await Promise.all([
      mkdir(officialToolsRoot),
      mkdir(officialInstallRoot),
      mkdir(officialBinRoot),
      mkdir(officialUserHome),
      Bun.write(officialChecksum, `${checksumHex}  ${officialArtifactName}\n`),
      Bun.write(
        officialReleases,
        `${JSON.stringify([
          {
            draft: false,
            immutable: true,
            prerelease: true,
            tag_name: `v${packageManifest.version}`,
          },
        ])}\n`,
      ),
    ]);
    const fakeTools = {
      codesign: `#!/bin/sh
set -eu
printf 'codesign %s\\n' "$*" >> "$THREADNOTE_TEST_SIGNATURE_LOG"
`,
      curl: `#!/bin/sh
set -eu
destination=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      shift
      destination="$1"
      ;;
    http://*|https://*)
      url="$1"
      ;;
  esac
  shift
done
if [ -z "$destination" ]; then
  exec /bin/cat "$THREADNOTE_TEST_RELEASES"
fi
case "$url" in
  *.sha256)
    exec /bin/cp "$THREADNOTE_TEST_CHECKSUM" "$destination"
    ;;
  *)
    exec /bin/cp "$THREADNOTE_TEST_ARTIFACT" "$destination"
    ;;
esac
`,
      file: `#!/bin/sh
set -eu
case "$1" in
  *.so) printf '%s\\n' 'Mach-O 64-bit bundle' ;;
  *) printf '%s\\n' 'data' ;;
esac
`,
      uname: `#!/bin/sh
set -eu
case "$1" in
  -s) printf '%s\\n' Darwin ;;
  -m) printf '%s\\n' arm64 ;;
  *) exit 2 ;;
esac
`,
    } as const;
    await Promise.all(
      Object.entries(fakeTools).map(async ([name, contents]) => {
        const file = join(officialToolsRoot, name);
        await Bun.write(file, contents);
        await chmod(file, 0o755);
      }),
    );
    const officialInstall = await execute(
      'sh',
      [join(process.cwd(), 'scripts', 'install.sh'), '--beta', '--no-start'],
      {
        env: {
          HOME: officialUserHome,
          PATH: `${officialToolsRoot}:/usr/bin:/bin:/usr/sbin:/sbin`,
          THREADNOTE_BIN_DIR: officialBinRoot,
          THREADNOTE_INSTALL_ROOT: officialInstallRoot,
          THREADNOTE_TEST_ARTIFACT: artifact,
          THREADNOTE_TEST_CHECKSUM: officialChecksum,
          THREADNOTE_TEST_RELEASES: officialReleases,
          THREADNOTE_TEST_SIGNATURE_LOG: signatureLog,
          USER: 'standalone-installer-e2e',
          USERPROFILE: officialUserHome,
        },
        timeout: 600_000,
      },
    );
    expect(`${officialInstall.stdout}${officialInstall.stderr}`).toContain(
      `Installed standalone Threadnote ${packageManifest.version}`,
    );
    const signatureCommands = await readFile(signatureLog, 'utf8');
    expect(signatureCommands).toMatch(/codesign .*\.so(?:\s|$)/);
    expect(signatureCommands).toMatch(/codesign .*threadnote(?:\s|$)/);
    expect(signatureCommands).not.toContain('spctl');

    const assetRequests: string[] = [];
    let transientArchiveFailures = 2;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const name = new URL(request.url).pathname.slice(1);
        if (name === 'releases') {
          const origin = new URL(request.url).origin;
          return new Response(
            JSON.stringify(
              [
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
                  assets: [
                    {
                      browser_download_url: `${origin}/${artifactName}`,
                      name: artifactName,
                    },
                    {
                      browser_download_url: `${origin}/${artifactName}.sha256`,
                      name: `${artifactName}.sha256`,
                    },
                  ],
                  draft: false,
                  immutable: true,
                  prerelease: true,
                  tag_name: `v${packageManifest.version}`,
                },
              ],
              null,
              2,
            ),
            {headers: {'content-type': 'application/json'}},
          );
        }
        assetRequests.push(name);
        if (name === `unsafe-parent/${artifactName}`) return new Response(Bun.file(unsafeParentArtifact));
        if (name === `unsafe-parent/${artifactName}.sha256`) return new Response(unsafeParentChecksum);
        if (name === `unsafe-link/${artifactName}`) return new Response(Bun.file(unsafeLinkArtifact));
        if (name === `unsafe-link/${artifactName}.sha256`) return new Response(unsafeLinkChecksum);
        if (name === artifactName && transientArchiveFailures > 0) {
          transientArchiveFailures -= 1;
          return new Response('retry this request', {status: 503});
        }
        if (name === artifactName) return new Response(Bun.file(artifact));
        if (name === `${artifactName}.sha256`) return new Response(Bun.file(checksum));
        return new Response('not found', {status: 404});
      },
    });
    try {
      const installEnvironment = {
        HOME: userHome,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        THREADNOTE_BIN_DIR: binRoot,
        THREADNOTE_INSTALL_ROOT: installRoot,
        THREADNOTE_RELEASE_DOWNLOAD_ROOT: `http://127.0.0.1:${server.port}`,
        THREADNOTE_RELEASE_SOURCE: `http://127.0.0.1:${server.port}/releases`,
        USER: 'standalone-installer-e2e',
        USERPROFILE: userHome,
      };
      for (const rejectedVersion of ['4.0.0-beta.6', '4.0.0-beta.5', '4.0.0-beta.4']) {
        const requestsBefore = assetRequests.length;
        const failure = await execute('sh', [join(process.cwd(), 'scripts', 'install.sh'), '--no-start'], {
          env: {...installEnvironment, THREADNOTE_VERSION: rejectedVersion},
          timeout: 60_000,
        }).catch((cause: unknown) => cause);
        expect(String((failure as {readonly stderr?: unknown}).stderr)).toContain(
          `Threadnote ${rejectedVersion} is not a published immutable release.`,
        );
        expect(assetRequests).toHaveLength(requestsBefore);
      }
      const exactFailure = await execute('sh', [join(process.cwd(), 'scripts', 'install.sh'), '--no-start'], {
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
      for (const unsafeFixture of [
        {message: 'entry path escapes the extraction root', route: 'unsafe-parent'},
        {message: 'unsupported entry type l', route: 'unsafe-link'},
      ]) {
        const unsafeFailure = await execute('sh', [join(process.cwd(), 'scripts', 'install.sh'), '--no-start'], {
          env: {
            ...installEnvironment,
            THREADNOTE_RELEASE_DOWNLOAD_ROOT: `http://127.0.0.1:${server.port}/${unsafeFixture.route}`,
            THREADNOTE_VERSION: packageManifest.version,
          },
          timeout: 60_000,
        }).catch((cause: unknown) => cause);
        expect(
          `${String((unsafeFailure as {readonly stdout?: unknown}).stdout)}${String(
            (unsafeFailure as {readonly stderr?: unknown}).stderr,
          )}`,
        ).toContain(unsafeFixture.message);
      }
      await expect(stat(join(installRoot, 'versions', 'threadnote-parent-escape.txt'))).rejects.toThrow();
      await expect(stat(join(installRoot, 'versions', 'threadnote-link-escape.txt'))).rejects.toThrow();
      const installationLock = join(installRoot, '.installation.lock');
      await Bun.write(installationLock, '');
      const staleInstallationLockDate = new Date(Date.now() - 120_000);
      await utimes(installationLock, staleInstallationLockDate, staleInstallationLockDate);
      const archiveRequestsBeforeInstall = assetRequests.filter(name => name === artifactName).length;
      const result = await execute('sh', [join(process.cwd(), 'scripts', 'install.sh'), '--beta', '--no-start'], {
        env: installEnvironment,
        timeout: 600_000,
      }).catch((cause: unknown) => {
        const output =
          typeof cause === 'object' && cause !== null
            ? `${'stdout' in cause ? String(cause.stdout) : ''}${'stderr' in cause ? String(cause.stderr) : ''}`
            : '';
        throw new Error(`POSIX bootstrap failed:\n${output}`, {cause});
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(`Installed standalone Threadnote ${packageManifest.version}`);
      expect(output).toContain('Wrote command launcher');
      expect(output).toContain('Threadnote is installed');
      expect(output).not.toMatch(/\bnpm\b|Python|OpenViking/i);
      expect(assetRequests.filter(name => name === artifactName)).toHaveLength(archiveRequestsBeforeInstall + 3);
      const installedExecutable = join(installRoot, 'versions', packageManifest.version, 'threadnote');
      await expect(stat(installedExecutable)).resolves.toMatchObject({size: expect.any(Number)});
      await chmod(installedExecutable, 0o755);
      const version = await execute(installedExecutable, ['--version']);
      expect(version.stdout).toContain(packageManifest.version);
      const launcherVersion = await execute(join(binRoot, 'threadnote'), ['--version'], {
        env: {
          HOME: userHome,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          THREADNOTE_HOME: join(userHome, '.threadnote'),
          USER: 'standalone-installer-e2e',
          USERPROFILE: userHome,
        },
      });
      expect(launcherVersion.stdout).toContain(packageManifest.version);
      const versionsRoot = join(installRoot, 'versions');
      const releaseRoot = join(versionsRoot, packageManifest.version);
      const promotionBackup = join(versionsRoot, `.${packageManifest.version}.promotion-backup`);
      const promotionJournal = join(versionsRoot, `.${packageManifest.version}.promotion.json`);
      const recoverySentinel = join(releaseRoot, 'promotion-recovery-sentinel.txt');
      await Bun.write(recoverySentinel, 'preserve the previous release\n');
      await Bun.write(
        installationLock,
        `${JSON.stringify({
          processId: 2_147_483_647,
          processStartIdentity: 'linux:stale-installer-fixture',
          token: 'stale-ts-lock',
          version: 1,
        })}\n`,
      );
      const interruptedPromotion = await execute(
        'sh',
        [join(process.cwd(), 'scripts', 'install.sh'), '--beta', '--no-start'],
        {
          env: {
            ...installEnvironment,
            THREADNOTE_INSTALLER_FAIL_AFTER_PROMOTION_STEP: 'previous-backed-up',
          },
          timeout: 600_000,
        },
      ).catch((cause: unknown) => cause);
      expect(
        `${String((interruptedPromotion as {readonly stdout?: unknown}).stdout)}${String(
          (interruptedPromotion as {readonly stderr?: unknown}).stderr,
        )}`,
      ).toContain('Injected installer interruption after promotion step: previous-backed-up');
      await expect(stat(releaseRoot)).rejects.toThrow();
      await expect(readFile(join(promotionBackup, 'promotion-recovery-sentinel.txt'), 'utf8')).resolves.toBe(
        'preserve the previous release\n',
      );

      const recoveredPromotion = await execute(
        'sh',
        [join(process.cwd(), 'scripts', 'install.sh'), '--beta', '--no-start'],
        {
          env: {
            ...installEnvironment,
            THREADNOTE_INSTALLER_FAIL_AFTER_PROMOTION_STEP: 'journaled',
          },
          timeout: 600_000,
        },
      ).catch((cause: unknown) => cause);
      expect(
        `${String((recoveredPromotion as {readonly stdout?: unknown}).stdout)}${String(
          (recoveredPromotion as {readonly stderr?: unknown}).stderr,
        )}`,
      ).toContain('Injected installer interruption after promotion step: journaled');
      await expect(readFile(recoverySentinel, 'utf8')).resolves.toBe('preserve the previous release\n');
      await expect(stat(promotionBackup)).rejects.toThrow();
      await expect(stat(promotionJournal)).resolves.toMatchObject({size: expect.any(Number)});

      const update = await execute(
        join(binRoot, 'threadnote'),
        [
          '--home',
          join(userHome, '.threadnote'),
          'update',
          '--force',
          '--beta',
          '--source',
          `http://127.0.0.1:${server.port}/releases`,
          '--allow-untrusted-source',
          '--no-repair',
          '--no-post-update',
        ],
        {
          env: {
            HOME: userHome,
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            THREADNOTE_HOME: join(userHome, '.threadnote'),
            USER: 'standalone-installer-e2e',
            USERPROFILE: userHome,
          },
          timeout: 600_000,
        },
      );
      expect(`${update.stdout}${update.stderr}`).toContain(
        `Installed standalone Threadnote ${packageManifest.version}`,
      );
      await expect(stat(promotionBackup)).rejects.toThrow();
      await expect(stat(promotionJournal)).rejects.toThrow();
      const transport = new StdioClientTransport({
        args: [],
        command: join(binRoot, 'threadnote-mcp-server'),
        cwd: process.cwd(),
        env: {
          HOME: userHome,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          THREADNOTE_HOME: join(userHome, '.threadnote'),
          USER: 'standalone-installer-e2e',
          USERPROFILE: userHome,
        },
      });
      const client = new Client({name: 'threadnote-posix-installer-e2e', version: packageManifest.version});
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

interface TarFixtureEntry {
  readonly contents?: string;
  readonly linkName?: string;
  readonly name: string;
  readonly type: 'file' | 'symlink';
}

async function writeTarGzipFixture(file: string, entry: TarFixtureEntry): Promise<void> {
  const encoder = new TextEncoder();
  const contents = entry.type === 'file' ? encoder.encode(entry.contents ?? '') : new Uint8Array();
  const header = new Uint8Array(512);
  writeTarText(header, 0, 100, entry.name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, contents.byteLength);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  writeTarText(header, 156, 1, entry.type === 'symlink' ? '2' : '0');
  if (entry.linkName) writeTarText(header, 157, 100, entry.linkName);
  writeTarText(header, 257, 6, 'ustar');
  writeTarText(header, 263, 2, '00');
  writeTarText(header, 265, 32, 'threadnote');
  writeTarText(header, 297, 32, 'threadnote');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  const checksumText = checksum.toString(8).padStart(6, '0');
  writeTarText(header, 148, 6, checksumText);
  header[154] = 0;
  header[155] = 0x20;
  const paddedSize = Math.ceil(contents.byteLength / 512) * 512;
  const archive = new Uint8Array(512 + paddedSize + 1024);
  archive.set(header, 0);
  archive.set(contents, 512);
  await Bun.write(file, Bun.gzipSync(archive));
}

function writeTarText(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) throw new Error(`Tar fixture field is too long: ${value}`);
  target.set(bytes, offset);
}

function writeTarOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  writeTarText(target, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

async function checksumDocument(file: string, artifactName: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(new Uint8Array(await Bun.file(file).arrayBuffer()));
  return `${hasher.digest('hex')}  ${artifactName}\n`;
}
