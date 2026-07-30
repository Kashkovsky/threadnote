import {Effect, FileSystem, Path} from 'effect';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {sha256FileHex} from '../../src/effect/digest.js';
import {HttpService} from '../../src/effect/http.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import type {RuntimeConfig} from '../../src/types.js';

vi.mock('../../src/utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils.js')>();
  return {
    ...actual,
    currentPackageVersion: vi.fn(() => Effect.succeed('4.0.0')),
  };
});

import {
  fetchLatestVersion,
  parseReleaseChecksum,
  promoteReleaseDirectory,
  releaseArtifactName,
  requiresFreshStandaloneInstall,
  requestedUpdateChannel,
  resolveReleaseSource,
  runPostUpdate,
  runUpdate,
  verifyOfficialPlatformSignature,
} from '../../src/update.js';
import * as utils from '../../src/utils.js';

const OFFICIAL_RELEASE_SOURCE = 'https://api.github.com/repos/Kashkovsky/threadnote/releases?per_page=100';
const RELEASE_VERSION = '4.0.0';

beforeEach(() => {
  vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(RELEASE_VERSION));
});

describe('standalone release selection', () => {
  it('resolves explicit channels and rejects conflicting flags', () => {
    expect(requestedUpdateChannel({})).toBeUndefined();
    expect(requestedUpdateChannel({beta: true})).toBe('beta');
    expect(requestedUpdateChannel({stable: true})).toBe('latest');
    expect(() => requestedUpdateChannel({beta: true, stable: true})).toThrow(/either --beta or --stable/);
  });

  it('requires a fresh install before the standalone 4.x updater boundary', () => {
    expect(requiresFreshStandaloneInstall('3.0.5')).toBe(true);
    expect(requiresFreshStandaloneInstall('4.0.0-beta.1')).toBe(false);
  });

  it('selects stable and beta GitHub releases while ignoring drafts and mutable releases', async () => {
    const releases = [
      releaseResponse('4.1.0-beta.2', true),
      releaseResponse('4.0.1', false),
      {...releaseResponse('9.0.0', false), draft: true},
      {...releaseResponse('8.0.0', false), immutable: false},
      releaseResponse('4.1.0-beta.1', true),
    ];
    const http = HttpService.of({
      downloadToFile: () => Effect.die('not used'),
      getJson: () => Effect.succeed({body: releases, status: 200}),
      getStatus: () => Effect.succeed(200),
      getText: () => Effect.die('not used'),
    });

    const [stable, beta] = await Effect.runPromise(
      Effect.all([
        fetchLatestVersion(OFFICIAL_RELEASE_SOURCE, 'latest'),
        fetchLatestVersion(OFFICIAL_RELEASE_SOURCE, 'beta'),
      ]).pipe(Effect.provideService(HttpService, http)),
    );

    expect(stable).toBe('4.0.1');
    expect(beta).toBe('4.1.0-beta.2');
  });

  it('requires HTTPS and explicit trust for custom release sources', () => {
    expect(resolveReleaseSource(undefined, false, {})).toBe(OFFICIAL_RELEASE_SOURCE);
    expect(() => resolveReleaseSource('http://mirror.example/releases', true, {})).toThrow(/must use https/);
    expect(resolveReleaseSource('http://127.0.0.1:4312/releases', true, {})).toBe('http://127.0.0.1:4312/releases');
    expect(() => resolveReleaseSource('https://mirror.example/releases', false, {})).toThrow(
      /Refusing custom release source/,
    );
    expect(resolveReleaseSource('https://mirror.example/releases', true, {})).toBe('https://mirror.example/releases');
    expect(
      resolveReleaseSource(undefined, false, {
        THREADNOTE_ALLOW_UNTRUSTED_RELEASE_SOURCE: 'yes',
        THREADNOTE_RELEASE_SOURCE: 'https://mirror.example/releases',
      }),
    ).toBe('https://mirror.example/releases');
  });

  it('validates checksum documents and target names', () => {
    const artifact = 'threadnote-darwin-arm64.tar.gz';
    const checksum = 'a'.repeat(64);
    expect(parseReleaseChecksum(`${checksum}  ${artifact}\n`, artifact)).toBe(checksum);
    expect(() => parseReleaseChecksum(`${checksum}  another.tar.gz\n`, artifact)).toThrow(/Invalid checksum/);
    expect(() => parseReleaseChecksum('not-a-checksum', artifact)).toThrow(/Invalid checksum/);
    expect(releaseArtifactName({architecture: 'aarch64', platform: 'darwin'})).toBe(artifact);
    expect(() => releaseArtifactName({architecture: 'riscv64', platform: 'linux'})).toThrow(
      /No standalone Threadnote artifact/,
    );
  });

  it('verifies every nested Mach-O runtime file on macOS independent of the test host', async () => {
    const commands = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const releaseRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-signature-test-'});
          const executable = path.join(releaseRoot, 'threadnote');
          const nativeLibrary = path.join(releaseRoot, 'runtime', 'nested', 'libfixture.so');
          const ordinaryFile = path.join(releaseRoot, 'runtime', 'nested', 'metadata.txt');
          yield* fs.makeDirectory(path.dirname(nativeLibrary), {recursive: true});
          yield* fs.writeFileString(executable, 'executable fixture\n');
          yield* fs.writeFileString(nativeLibrary, 'native fixture\n');
          yield* fs.writeFileString(ordinaryFile, 'ordinary fixture\n');
          const recorded: string[] = [];
          const commandExecutor = CommandExecutor.of({
            execute: (command, args) =>
              Effect.sync(() => {
                recorded.push([command, ...args].join(' '));
                return {
                  exitCode: 0,
                  stderr: '',
                  stdout:
                    command === 'file' && args.at(-1) === nativeLibrary ? 'Mach-O 64-bit bundle\n' : 'ASCII text\n',
                };
              }),
            executeStreaming: () => Effect.die('not used'),
          });
          const darwinSystem = SystemInfo.of({
            ...baseSystem,
            architecture: 'arm64',
            platform: 'darwin',
          });
          yield* verifyOfficialPlatformSignature(fs, path, releaseRoot, OFFICIAL_RELEASE_SOURCE, darwinSystem).pipe(
            Effect.provideService(CommandExecutor, commandExecutor),
          );
          return recorded;
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    const codesignCommands = commands.filter(command => command.startsWith('codesign '));
    expect(commands.join('\n')).toContain('file --brief');
    expect(codesignCommands.join('\n')).toContain('libfixture.so');
    expect(codesignCommands.join('\n')).toContain('threadnote');
    expect(codesignCommands.join('\n')).not.toContain('metadata.txt');
    expect(commands.join('\n')).not.toContain('spctl');
  });
});

describe('standalone updater', () => {
  it('installs a verified archive atomically and points stable launchers at the versioned release', async () => {
    vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('4.0.0-beta.7'));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-update-test-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const binRoot = path.join(temporaryRoot, 'bin');
          const config = runtimeConfig(path.join(temporaryRoot, 'home'));
          const artifactName = releaseArtifactName(baseSystem);
          const archivePath = path.join(temporaryRoot, artifactName);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          const releaseRoot = path.join(installRoot, 'versions', RELEASE_VERSION);
          yield* fs.makeDirectory(releaseRoot, {recursive: true});
          yield* fs.writeFileString(path.join(releaseRoot, 'corrupt.txt'), 'untrusted prior contents\n');
          yield* writeReleaseArchive(archivePath, artifactName, executableName, RELEASE_VERSION);
          const checksum = yield* sha256FileHex(archivePath);
          const release = releaseResponse(RELEASE_VERSION, false, artifactName);
          const http = updateHttpService(fs, archivePath, checksum, artifactName, [release]);
          const signatureCommands: string[] = [];
          const commandExecutor = CommandExecutor.of({
            execute: (executable, args) =>
              Effect.sync(() => {
                signatureCommands.push([executable, ...args].join(' '));
                return {
                  exitCode: 0,
                  stderr: '',
                  stdout: executable === 'file' && args.at(-1)?.endsWith('.so') ? 'Mach-O 64-bit bundle\n' : '',
                };
              }),
            executeStreaming: () => Effect.die('not used'),
          });
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              LOCALAPPDATA: path.join(temporaryRoot, 'local-app-data'),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
            homeDirectory: path.join(temporaryRoot, 'user-home'),
          });

          const captured = yield* captureConsole(
            runUpdate(config, {
              postUpdate: false,
              repair: false,
              stable: true,
              yes: true,
            }).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(HttpService, http),
              Effect.provideService(SystemInfo, testSystem),
            ),
          );

          const launcher = path.join(binRoot, baseSystem.platform === 'win32' ? 'threadnote.cmd' : 'threadnote');
          const mcpLauncher = path.join(
            binRoot,
            baseSystem.platform === 'win32' ? 'threadnote-mcp-server.cmd' : 'threadnote-mcp-server',
          );
          return {
            captured,
            activeRelease: yield* fs.readFileString(path.join(installRoot, 'active-release.json')),
            corruptContentsExist: yield* fs.exists(path.join(releaseRoot, 'corrupt.txt')),
            grammarAssetsExist: yield* fs.exists(
              path.join(releaseRoot, 'assets', 'code-graph', 'grammars', 'swift.wasm'),
            ),
            executableExists: yield* fs.exists(path.join(releaseRoot, executableName)),
            launcher: yield* fs.readFileString(launcher),
            mcpLauncher: yield* fs.readFileString(mcpLauncher),
            platform: baseSystem.platform,
            releaseMetadata: yield* fs.readFileString(path.join(releaseRoot, 'release.json')),
            signatureCommands,
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.executableExists).toBe(true);
    expect(result.grammarAssetsExist).toBe(true);
    expect(result.corruptContentsExist).toBe(false);
    expect(JSON.parse(result.activeRelease)).toMatchObject({version: RELEASE_VERSION});
    expect(JSON.parse(result.releaseMetadata)).toMatchObject({version: RELEASE_VERSION});
    expect(result.launcher).toContain(`versions/${RELEASE_VERSION}/threadnote`.replaceAll('/', pathSeparator()));
    expect(result.mcpLauncher).toContain('mcp-server');
    if (result.platform === 'darwin') {
      expect(result.signatureCommands.join('\n')).toContain('codesign --verify --strict --verbose=2');
      expect(result.signatureCommands.join('\n')).toContain('libfixture.so');
      expect(result.signatureCommands.join('\n')).not.toContain('spctl');
    }
    if (result.platform === 'win32') expect(result.signatureCommands.join('\n')).toContain('Get-AuthenticodeSignature');
    if (result.platform === 'linux') expect(result.signatureCommands).toHaveLength(0);
    expect(result.captured.output).toContain(`Installed standalone Threadnote ${RELEASE_VERSION}`);
    expect(result.captured.output).toContain('Update complete.');
  });

  it('rejects a checksum mismatch before promoting or rewriting launchers', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-update-checksum-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const binRoot = path.join(temporaryRoot, 'bin');
          const config = runtimeConfig(path.join(temporaryRoot, 'home'));
          const artifactName = releaseArtifactName(baseSystem);
          const archivePath = path.join(temporaryRoot, artifactName);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeReleaseArchive(archivePath, artifactName, executableName, RELEASE_VERSION);
          const release = releaseResponse(RELEASE_VERSION, false, artifactName);
          const http = updateHttpService(fs, archivePath, '0'.repeat(64), artifactName, [release]);
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
          });

          const failure = yield* runUpdate(config, {
            allowUntrustedSource: true,
            force: true,
            postUpdate: false,
            repair: false,
            source: 'http://127.0.0.1:4312/releases',
          }).pipe(Effect.provideService(HttpService, http), Effect.provideService(SystemInfo, testSystem), Effect.flip);
          const releaseRoot = path.join(installRoot, 'versions', RELEASE_VERSION);
          return {
            activeReleaseExists: yield* fs.exists(path.join(installRoot, 'active-release.json')),
            cliLauncherExists: yield* fs.exists(
              path.join(binRoot, baseSystem.platform === 'win32' ? 'threadnote.cmd' : 'threadnote'),
            ),
            failure,
            mcpLauncherExists: yield* fs.exists(
              path.join(
                binRoot,
                baseSystem.platform === 'win32' ? 'threadnote-mcp-server.cmd' : 'threadnote-mcp-server',
              ),
            ),
            releaseExists: yield* fs.exists(releaseRoot),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(String(result.failure)).toMatch(/Checksum mismatch/);
    expect(result).toMatchObject({
      activeReleaseExists: false,
      cliLauncherExists: false,
      mcpLauncherExists: false,
      releaseExists: false,
    });
  });

  it('rejects an archive whose bundled code graph grammar does not match its signed manifest', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-update-grammar-checksum-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const binRoot = path.join(temporaryRoot, 'bin');
          const config = runtimeConfig(path.join(temporaryRoot, 'home'));
          const artifactName = releaseArtifactName(baseSystem);
          const archivePath = path.join(temporaryRoot, artifactName);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeReleaseArchive(archivePath, artifactName, executableName, RELEASE_VERSION, {
            tamperCodeGraphAsset: true,
          });
          const checksum = yield* sha256FileHex(archivePath);
          const release = releaseResponse(RELEASE_VERSION, false, artifactName);
          const http = updateHttpService(fs, archivePath, checksum, artifactName, [release]);
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
          });

          const failure = yield* runUpdate(config, {
            allowUntrustedSource: true,
            force: true,
            postUpdate: false,
            repair: false,
            source: 'http://127.0.0.1:4312/releases',
          }).pipe(Effect.provideService(HttpService, http), Effect.provideService(SystemInfo, testSystem), Effect.flip);
          return {
            failure,
            releaseExists: yield* fs.exists(path.join(installRoot, 'versions', RELEASE_VERSION)),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(String(result.failure)).toMatch(/Code graph asset checksum validation failed for grammars\/java\.wasm/);
    expect(result.releaseExists).toBe(false);
  });

  it('restores an existing release when atomic promotion fails', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-update-rollback-'});
          const releaseRoot = path.join(temporaryRoot, 'versions', RELEASE_VERSION);
          const missingStagedRoot = path.join(temporaryRoot, 'missing-staged-release');
          const marker = path.join(releaseRoot, 'existing-release.txt');
          yield* fs.makeDirectory(releaseRoot, {recursive: true});
          yield* fs.writeFileString(marker, 'keep this release\n');

          const failure = yield* promoteReleaseDirectory(
            fs,
            path,
            missingStagedRoot,
            releaseRoot,
            true,
            system.processId,
          ).pipe(Effect.flip);
          const backupRoot = path.join(
            path.dirname(releaseRoot),
            `.${path.basename(releaseRoot)}.${system.processId}.backup`,
          );
          return {
            backupExists: yield* fs.exists(backupRoot),
            failure,
            marker: yield* fs.readFileString(marker),
            releaseExists: yield* fs.exists(releaseRoot),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.releaseExists).toBe(true);
    expect(result.marker).toBe('keep this release\n');
    expect(result.backupExists).toBe(false);
    expect(String(result.failure)).toMatch(/missing-staged-release/);
  });

  it('runs applicable post-update work before repairing the promoted release', async () => {
    vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('4.0.0-beta.7'));
    const captured = await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        const release = releaseResponse(RELEASE_VERSION, false, releaseArtifactName(system));
        const http = HttpService.of({
          downloadToFile: () => Effect.die('dry run does not download'),
          getJson: () => Effect.succeed({body: [release], status: 200}),
          getStatus: () => Effect.succeed(200),
          getText: () => Effect.die('dry run does not download checksums'),
        });
        return yield* captureConsole(
          runUpdate(runtimeConfig('/tmp/threadnote-update-order'), {
            dryRun: true,
            stable: true,
            yes: true,
          }).pipe(Effect.provideService(HttpService, http)),
        );
      }).pipe(Effect.provide(ApplicationLayer)),
    );

    const postUpdate = captured.output.indexOf('post-update --from-version');
    const repair = captured.output.indexOf('repair --no-post-update');
    expect(postUpdate).toBeGreaterThan(0);
    expect(repair).toBeGreaterThan(postUpdate);
  });

  it('refuses to execute an in-place Threadnote 3 to 4 transition', async () => {
    vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed('3.0.5'));
    let downloadAttempted = false;
    const http = HttpService.of({
      downloadToFile: () => {
        downloadAttempted = true;
        return Effect.die('must not download');
      },
      getJson: () => Effect.succeed({body: [releaseResponse(RELEASE_VERSION, false)], status: 200}),
      getStatus: () => Effect.succeed(200),
      getText: () => Effect.die('must not download checksums'),
    });

    await expect(
      Effect.runPromise(
        runUpdate(runtimeConfig('/tmp/threadnote-fresh-install-boundary'), {
          stable: true,
        }).pipe(Effect.provideService(HttpService, http), Effect.provide(ApplicationLayer)),
      ),
    ).rejects.toThrow(/cannot update across the standalone-runtime boundary.*Install Threadnote 4 fresh/);
    expect(downloadAttempted).toBe(false);
  });
});

describe('post-update validation', () => {
  it('requires both version boundaries', async () => {
    const config = runtimeConfig('/tmp/threadnote-post-update-validation');
    await expect(Effect.runPromise(runPostUpdate(config, {}).pipe(Effect.provide(ApplicationLayer)))).rejects.toThrow(
      /Provide --from-version and --to-version/,
    );
  });
});

function releaseResponse(version: string, prerelease: boolean, artifactName = 'threadnote-darwin-arm64.tar.gz') {
  return {
    assets: [
      {
        browser_download_url: `https://github.com/Kashkovsky/threadnote/releases/download/v${version}/${artifactName}`,
        name: artifactName,
      },
      {
        browser_download_url: `https://github.com/Kashkovsky/threadnote/releases/download/v${version}/${artifactName}.sha256`,
        name: `${artifactName}.sha256`,
      },
    ],
    draft: false,
    immutable: true,
    prerelease,
    tag_name: `v${version}`,
  };
}

function runtimeConfig(home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'update-test',
  };
}

function updateHttpService(
  fs: FileSystem.FileSystem,
  archivePath: string,
  checksum: string,
  artifactName: string,
  releases: readonly unknown[],
) {
  return HttpService.of({
    downloadToFile: (_url, destination) =>
      fs.copyFile(archivePath, destination).pipe(Effect.orDie, Effect.as({resumed: false, status: 200})),
    getJson: () => Effect.succeed({body: releases, status: 200}),
    getStatus: () => Effect.succeed(200),
    getText: () => Effect.succeed({body: `${checksum}  ${artifactName}\n`, status: 200}),
  });
}

function writeReleaseArchive(
  archivePath: string,
  _artifactName: string,
  executableName: string,
  version: string,
  options: {readonly tamperCodeGraphAsset?: boolean} = {},
) {
  return Effect.tryPromise({
    try: async () => {
      const assetPaths = [
        'manifest.json',
        'runtime/web-tree-sitter.wasm',
        'grammars/java.wasm',
        'grammars/kotlin.wasm',
        'grammars/swift.wasm',
        'licenses/tree-sitter-java.LICENSE',
        'licenses/tree-sitter-kotlin.LICENSE',
        'licenses/tree-sitter-swift.LICENSE',
        'licenses/web-tree-sitter.LICENSE',
      ] as const;
      const assets = Object.fromEntries(
        await Promise.all(
          assetPaths.map(async asset => [
            `assets/code-graph/${asset}`,
            await Bun.file(`assets/code-graph/${asset}`).bytes(),
          ]),
        ),
      );
      if (options.tamperCodeGraphAsset) {
        assets['assets/code-graph/grammars/java.wasm'] = new TextEncoder().encode('tampered grammar');
      }
      return Bun.Archive.write(
        archivePath,
        {
          ...assets,
          [executableName]: '#!/usr/bin/env sh\nexit 0\n',
          'release.json': `${JSON.stringify({
            codeGraphAssets: {
              manifest: 'assets/code-graph/manifest.json',
              version: 1,
            },
            executable: executableName,
            nativeRuntime: 'runtime/node-llama-cpp.js',
            nativeRuntimePackage: '@node-llama-cpp/test',
            runtime: `bun-${Bun.version}`,
            target: `bun-${process.platform}-${process.arch}`,
            version,
          })}\n`,
          'runtime/node-llama-cpp.js': 'export const smoke = true;\n',
          'runtime/native/libfixture.so': 'fixture native payload\n',
          'runtime/native/.keep': '',
        },
        {compress: 'gzip'},
      );
    },
    catch: cause => new Error('Could not create updater fixture archive.', {cause}),
  });
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}
