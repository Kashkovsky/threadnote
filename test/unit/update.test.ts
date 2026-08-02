import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Crypto, Effect, FileSystem, Path} from 'effect';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {sha256FileHex} from '../../src/effect/digest.js';
import {HttpService} from '../../src/effect/http.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {activateStandaloneRelease} from '../../src/installations.js';
import {migrateThreadnoteStorageLayout} from '../../src/migration/layout.js';
import type {RuntimeConfig} from '../../src/types.js';

vi.mock('../../src/utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils.js')>();
  return {
    ...actual,
    currentPackageVersion: vi.fn(() => Effect.succeed('4.0.0')),
    toolRoot: vi.fn(actual.toolRoot),
  };
});

import {
  fetchLatestVersion,
  maybeRunPostUpdateAfterRepair,
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
const defaultToolRootImplementation = vi.mocked(utils.toolRoot).getMockImplementation();
let isolatedInstallationRoot: string | undefined;
let previousInstallationRoot: string | undefined;

beforeEach(async () => {
  previousInstallationRoot = process.env.THREADNOTE_INSTALL_ROOT;
  isolatedInstallationRoot = await mkdtemp(join(tmpdir(), 'threadnote-update-installation-'));
  process.env.THREADNOTE_INSTALL_ROOT = isolatedInstallationRoot;
  vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(RELEASE_VERSION));
  if (defaultToolRootImplementation) {
    vi.mocked(utils.toolRoot).mockImplementation(defaultToolRootImplementation);
  }
});

afterEach(async () => {
  if (isolatedInstallationRoot) await rm(isolatedInstallationRoot, {force: true, recursive: true});
  if (previousInstallationRoot === undefined) delete process.env.THREADNOTE_INSTALL_ROOT;
  else process.env.THREADNOTE_INSTALL_ROOT = previousInstallationRoot;
  isolatedInstallationRoot = undefined;
  previousInstallationRoot = undefined;
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
  it('updates the active installation when a newer local development binary invokes the updater', async () => {
    const activeVersion = '4.0.0-beta.19';
    const latestVersion = '4.0.0-beta.30';
    vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(latestVersion));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-local-update-test-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const binRoot = path.join(temporaryRoot, 'bin');
          const oldReleaseRoot = path.join(installRoot, 'versions', activeVersion);
          yield* fs.makeDirectory(oldReleaseRoot, {recursive: true});
          yield* fs.writeFileString(
            path.join(oldReleaseRoot, 'release.json'),
            `${JSON.stringify({version: activeVersion})}\n`,
          );
          const artifactName = releaseArtifactName(baseSystem);
          const archivePath = path.join(temporaryRoot, artifactName);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeReleaseArchive(archivePath, artifactName, executableName, latestVersion);
          const checksum = yield* sha256FileHex(archivePath);
          const http = updateHttpService(fs, archivePath, checksum, artifactName, [
            releaseResponse(latestVersion, true, artifactName),
          ]);
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
          });
          yield* activateStandaloneRelease(oldReleaseRoot, false).pipe(Effect.provideService(SystemInfo, testSystem));

          const captured = yield* captureConsole(
            runUpdate(runtimeConfig(path.join(temporaryRoot, 'home')), {
              allowUntrustedSource: true,
              beta: true,
              postUpdate: false,
              repair: false,
              source: 'http://127.0.0.1:4312/releases',
            }).pipe(Effect.provideService(HttpService, http), Effect.provideService(SystemInfo, testSystem)),
          );
          const launcher = path.join(binRoot, baseSystem.platform === 'win32' ? 'threadnote.cmd' : 'threadnote');
          return {
            active: JSON.parse(yield* fs.readFileString(path.join(installRoot, 'active-release.json'))) as {
              version: string;
            },
            captured,
            launcher: yield* fs.readFileString(launcher),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.captured.output).toContain(`Current version: ${activeVersion}`);
    expect(result.captured.output).toContain(`Installed standalone Threadnote ${latestVersion}`);
    expect(result.active.version).toBe(latestVersion);
    expect(result.launcher).toContain(latestVersion);
  });

  it('repairs a managed launcher when the active installation is already current', async () => {
    const latestVersion = '4.0.0-beta.30';
    vi.mocked(utils.currentPackageVersion).mockReturnValue(Effect.succeed(latestVersion));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-launcher-repair-test-'});
          const installRoot = path.join(temporaryRoot, 'install');
          const binRoot = path.join(temporaryRoot, 'bin');
          const releaseRoot = path.join(installRoot, 'versions', latestVersion);
          yield* fs.makeDirectory(releaseRoot, {recursive: true});
          yield* fs.writeFileString(
            path.join(releaseRoot, 'release.json'),
            `${JSON.stringify({version: latestVersion})}\n`,
          );
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
          });
          yield* activateStandaloneRelease(releaseRoot, false).pipe(Effect.provideService(SystemInfo, testSystem));
          const launcher = path.join(binRoot, baseSystem.platform === 'win32' ? 'threadnote.cmd' : 'threadnote');
          yield* fs.makeDirectory(binRoot, {recursive: true});
          yield* fs.writeFileString(
            launcher,
            baseSystem.platform === 'win32'
              ? '@echo off\r\nrem Generated by threadnote\r\nold-release\\threadnote.exe %*\r\n'
              : '#!/usr/bin/env sh\n# Generated by threadnote\nexec old-release/threadnote "$@"\n',
          );
          const http = HttpService.of({
            downloadToFile: () => Effect.die('up-to-date repair must not download'),
            getJson: () => Effect.succeed({body: [releaseResponse(latestVersion, true)], status: 200}),
            getStatus: () => Effect.die('not used'),
            getText: () => Effect.die('not used'),
          });
          const captured = yield* captureConsole(
            runUpdate(runtimeConfig(path.join(temporaryRoot, 'home')), {beta: true}).pipe(
              Effect.provideService(HttpService, http),
              Effect.provideService(SystemInfo, testSystem),
            ),
          );
          return {captured, launcher: yield* fs.readFileString(launcher)};
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.captured.output).toContain('Threadnote is up to date.');
    expect(result.captured.output).toContain('Wrote command launcher:');
    expect(result.launcher).toContain(latestVersion);
    expect(result.launcher).not.toContain('old-release');
  });

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

  it('is silent for fresh homes in interactive and non-interactive post-update and repair paths', async () => {
    const outputs = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-fresh-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, '.threadnote');
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [
            fixtureMigration('legacy-home-import', {requiresLegacyHomeMigration: true}),
            fixtureMigration('home-recovery', {requiresPendingHomeMigration: true}),
          ]);
          yield* Effect.sync(() => {
            vi.mocked(utils.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () => Effect.die('fresh homes must not run migrations'),
          });
          const outputs: string[] = [];
          for (const interactive of [false, true]) {
            const system = SystemInfo.of({
              ...baseSystem,
              homeDirectory: temporaryRoot,
              stdinIsTTY: interactive,
              stdoutIsTTY: interactive,
            });
            const postUpdate = yield* captureConsole(
              runPostUpdate(runtimeConfig(home), {
                fromVersion: '0.0.0',
                toVersion: RELEASE_VERSION,
              }).pipe(
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(SystemInfo, system),
              ),
            );
            const repairFallback = yield* captureConsole(
              maybeRunPostUpdateAfterRepair(runtimeConfig(home), {dryRun: false}).pipe(
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(SystemInfo, system),
              ),
            );
            outputs.push(postUpdate.output, repairFallback.output);
          }
          return outputs;
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(outputs).toEqual(['', '', '', '']);
  });

  it('keeps the shipped beta migration catalog silent for a fresh current home', async () => {
    const outputs = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-catalog-fresh-'});
          const home = path.join(temporaryRoot, '.threadnote');
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () => Effect.die('fresh homes must not run shipped migrations'),
          });
          const outputs: string[] = [];
          for (const interactive of [false, true]) {
            const system = SystemInfo.of({
              ...baseSystem,
              homeDirectory: temporaryRoot,
              stdinIsTTY: interactive,
              stdoutIsTTY: interactive,
            });
            const captured = yield* captureConsole(
              runPostUpdate(runtimeConfig(home), {
                fromVersion: '4.0.0-beta.29',
                toVersion: '4.0.0-beta.30',
              }).pipe(
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(SystemInfo, system),
              ),
            );
            outputs.push(captured.output);
          }
          return outputs;
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(outputs).toEqual(['', '']);
  });

  it('does not announce an action when migration evidence disappears at the locked recheck', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-drift-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, '.threadnote');
          const legacyLayout = path.join(home, 'data', 'viking');
          yield* fs.makeDirectory(legacyLayout, {recursive: true});
          yield* fs.writeFileString(path.join(legacyLayout, 'memory.md'), '# Material beta memory\n');
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [
            fixtureMigration('home-recovery', {requiresPendingHomeMigration: true}),
          ]);
          yield* Effect.sync(() => {
            vi.mocked(utils.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });
          let evidenceChecks = 0;
          const flappingFileSystem = FileSystem.FileSystem.of({
            ...fs,
            exists: target =>
              target === legacyLayout
                ? Effect.sync(() => {
                    evidenceChecks += 1;
                    return evidenceChecks === 1;
                  })
                : fs.exists(target),
          });
          const system = SystemInfo.of({
            ...baseSystem,
            homeDirectory: temporaryRoot,
            stdinIsTTY: false,
            stdoutIsTTY: false,
          });
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () => Effect.die('disappeared evidence must not execute'),
          });
          const captured = yield* captureConsole(
            runPostUpdate(runtimeConfig(home), {
              fromVersion: '4.0.0-beta.1',
              toVersion: RELEASE_VERSION,
            }).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(FileSystem.FileSystem, flappingFileSystem),
              Effect.provideService(SystemInfo, system),
            ),
          );
          return {evidenceChecks, output: captured.output};
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toEqual({evidenceChecks: 2, output: ''});
  });

  it('retries evidence-backed beta-layout recovery until it materially completes', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-beta-layout-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, '.threadnote');
          const betaMemory = path.join(home, 'data', 'viking', 'local', 'memory.md');
          yield* fs.makeDirectory(path.dirname(betaMemory), {recursive: true});
          yield* fs.writeFileString(betaMemory, '# Beta memory\n');
          yield* fs.writeFileString(
            path.join(home, 'post-update-state.json'),
            `${JSON.stringify({handledMigrationIds: ['home-recovery']})}\n`,
          );
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [
            fixtureMigration('legacy-home-import', {requiresLegacyHomeMigration: true}),
            fixtureMigration('home-recovery', {requiresPendingHomeMigration: true}),
          ]);
          yield* Effect.sync(() => {
            vi.mocked(utils.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });
          const attempts: string[] = [];
          let materialize = false;
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: (_executable, args) =>
              Effect.gen(function* () {
                attempts.push(args[0] ?? '');
                if (materialize) {
                  yield* fs.remove(path.join(home, 'data', 'viking'), {recursive: true});
                  yield* fs.writeFileString(
                    path.join(home, 'layout.json'),
                    `${JSON.stringify({createdBy: 'threadnote', version: 2})}\n`,
                  );
                }
                return {exitCode: 0, stderr: '', stdout: ''};
              }).pipe(Effect.orDie),
          });
          const system = SystemInfo.of({
            ...baseSystem,
            homeDirectory: temporaryRoot,
            stdinIsTTY: false,
            stdoutIsTTY: false,
          });
          const run = () =>
            captureConsole(
              runPostUpdate(runtimeConfig(home), {
                fromVersion: '4.0.0-beta.1',
                toVersion: RELEASE_VERSION,
                yes: true,
              }).pipe(
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(SystemInfo, system),
              ),
            );
          const noOpFailure = yield* run().pipe(Effect.flip);
          materialize = true;
          const first = yield* run();
          const second = yield* run();
          return {attempts, first: first.output, noOpFailure: String(noOpFailure), second: second.output};
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.attempts).toEqual(['home-recovery', 'home-recovery']);
    expect(result.noOpFailure).toContain('filesystem requirements remain pending');
    expect(result.first).toContain('Post-update actions are available.');
    expect(result.second).toBe('');
  });

  it('keeps authoritative home recovery eligible after its introduction version until it completes', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const crypto = yield* Crypto.Crypto;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-deferred-home-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, '.threadnote');
          const betaMemory = path.join(home, 'data', 'viking', 'local', 'memory.md');
          yield* fs.makeDirectory(path.dirname(betaMemory), {recursive: true});
          yield* fs.writeFileString(betaMemory, '# Deferred beta memory\n');
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [
            fixtureMigration('home-recovery', {requiresPendingHomeMigration: true}),
          ]);
          yield* Effect.sync(() => {
            vi.mocked(utils.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });
          const system = SystemInfo.of({
            ...baseSystem,
            homeDirectory: temporaryRoot,
            stdinIsTTY: false,
            stdoutIsTTY: false,
          });
          let executions = 0;
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () =>
              Effect.gen(function* () {
                executions += 1;
                yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(SystemInfo, system),
                );
                return {exitCode: 0, stderr: '', stdout: ''};
              }).pipe(Effect.orDie),
          });
          const run = () =>
            captureConsole(
              runPostUpdate(runtimeConfig(home), {
                fromVersion: '4.0.0',
                toVersion: '4.0.1',
                yes: true,
              }).pipe(
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(SystemInfo, system),
              ),
            );
          const first = yield* run();
          const second = yield* run();
          return {executions, first: first.output, second: second.output};
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toEqual({
      executions: 1,
      first: expect.stringContaining('Post-update actions are available.'),
      second: '',
    });
  });

  it('recovers beta data after an older repair already wrote the current layout marker', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const crypto = yield* Crypto.Crypto;
          const baseSystem = yield* SystemInfo;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-repair-marker-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, '.threadnote');
          const betaMemory = path.join(home, 'data', 'viking', 'local', 'memory.md');
          yield* fs.makeDirectory(path.dirname(betaMemory), {recursive: true});
          yield* fs.writeFileString(betaMemory, '# Preserved beta memory\n');
          yield* fs.writeFileString(path.join(home, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [
            fixtureMigration('home-recovery', {requiresPendingHomeMigration: true}),
          ]);
          yield* Effect.sync(() => {
            vi.mocked(utils.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });
          const system = SystemInfo.of({
            ...baseSystem,
            homeDirectory: temporaryRoot,
            stdinIsTTY: false,
            stdoutIsTTY: false,
          });
          let executions = 0;
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () =>
              Effect.gen(function* () {
                executions += 1;
                yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(SystemInfo, system),
                );
                return {exitCode: 0, stderr: '', stdout: ''};
              }).pipe(Effect.orDie),
          });
          const run = () =>
            captureConsole(
              runPostUpdate(runtimeConfig(home), {
                fromVersion: '4.0.0-beta.1',
                toVersion: RELEASE_VERSION,
                yes: true,
              }).pipe(
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(SystemInfo, system),
              ),
            );
          const first = yield* run();
          const second = yield* run();
          return {
            executions,
            first: first.output,
            memory: yield* fs.readFileString(path.join(home, 'data', 'local', 'memory.md')),
            second: second.output,
            sourceExists: yield* fs.exists(path.join(home, 'data', 'viking')),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toEqual({
      executions: 1,
      first: expect.stringContaining('Post-update actions are available.'),
      memory: '# Preserved beta memory\n',
      second: '',
      sourceExists: false,
    });
  });

  it('checkpoints each successful migration before a later migration fails', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-checkpoint-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, 'home');
          const config = runtimeConfig(home);
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [
            fixtureMigration('fixture-one'),
            fixtureMigration('fixture-two'),
          ]);
          yield* fs.makeDirectory(home, {recursive: true});
          yield* fs.writeFileString(
            path.join(home, '.post-update-state.json.00000000-0000-4000-8000-000000000000.tmp'),
            'interrupted write\n',
          );
          yield* Effect.sync(() => {
            vi.mocked(utils.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });

          let failSecond = true;
          const attempts: string[] = [];
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: (_executable, args) =>
              Effect.sync(() => {
                attempts.push(args[0] ?? '');
                return {
                  exitCode: failSecond && args[0] === 'fixture-two' ? 1 : 0,
                  stderr: '',
                  stdout: '',
                };
              }),
          });
          const firstFailure = yield* runPostUpdate(config, {
            fromVersion: '3.9.0',
            toVersion: RELEASE_VERSION,
            yes: true,
          }).pipe(Effect.provideService(CommandExecutor, commandExecutor), Effect.flip);
          const firstState = JSON.parse(yield* fs.readFileString(path.join(home, 'post-update-state.json'))) as {
            handledMigrationIds: string[];
          };
          const temporaryStateFiles = (yield* fs.readDirectory(home)).filter(name =>
            /^\.post-update-state\.json\..+\.tmp$/.test(name),
          );

          failSecond = false;
          attempts.length = 0;
          yield* runPostUpdate(config, {
            fromVersion: '3.9.0',
            toVersion: RELEASE_VERSION,
            yes: true,
          }).pipe(Effect.provideService(CommandExecutor, commandExecutor));
          const finalState = JSON.parse(yield* fs.readFileString(path.join(home, 'post-update-state.json'))) as {
            handledMigrationIds: string[];
          };
          return {
            finalState,
            firstFailure: String(firstFailure),
            firstState,
            retryAttempts: [...attempts],
            temporaryStateFiles,
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toEqual({
      finalState: {handledMigrationIds: ['fixture-one', 'fixture-two']},
      firstFailure: expect.stringContaining('exited with 1'),
      firstState: {handledMigrationIds: ['fixture-one']},
      retryAttempts: ['fixture-two'],
      temporaryStateFiles: [],
    });
  });

  it('serializes concurrent post-update runs so a migration executes once', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-concurrent-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, 'home');
          const config = runtimeConfig(home);
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [fixtureMigration('fixture-once')]);
          yield* Effect.sync(() => {
            vi.mocked(utils.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });

          let executions = 0;
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () =>
              Effect.gen(function* () {
                executions += 1;
                yield* Effect.sleep(75);
                return {exitCode: 0, stderr: '', stdout: ''};
              }),
          });
          const run = runPostUpdate(config, {
            fromVersion: '3.9.0',
            toVersion: RELEASE_VERSION,
            yes: true,
          }).pipe(Effect.provideService(CommandExecutor, commandExecutor));
          yield* Effect.all([run, run], {concurrency: 2});
          return {
            executions,
            state: JSON.parse(yield* fs.readFileString(path.join(home, 'post-update-state.json'))),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toEqual({
      executions: 1,
      state: {handledMigrationIds: ['fixture-once']},
    });
  });

  it('preserves corrupt post-update state instead of silently rerunning migrations', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-post-update-corrupt-'});
          const fixtureRoot = path.join(temporaryRoot, 'tool');
          const home = path.join(temporaryRoot, 'home');
          const statePath = path.join(home, 'post-update-state.json');
          const config = runtimeConfig(home);
          yield* writePostUpdateFixture(fs, path, fixtureRoot, [fixtureMigration('must-not-run')]);
          yield* fs.makeDirectory(home, {recursive: true});
          yield* fs.writeFileString(statePath, '{"handledMigrationIds": [');
          yield* Effect.sync(() => {
            vi.mocked(utils.toolRoot).mockImplementation(() => Effect.succeed(fixtureRoot));
          });
          const commandExecutor = CommandExecutor.of({
            execute: () => Effect.die('not used'),
            executeStreaming: () => Effect.die('must not run a migration with corrupt state'),
          });
          const failure = yield* runPostUpdate(config, {
            fromVersion: '3.9.0',
            toVersion: RELEASE_VERSION,
            yes: true,
          }).pipe(Effect.provideService(CommandExecutor, commandExecutor), Effect.flip);
          return {
            failure: String(failure),
            state: yield* fs.readFileString(statePath),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result).toEqual({
      failure: expect.stringContaining('Post-update state is invalid and was preserved'),
      state: '{"handledMigrationIds": [',
    });
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

function fixtureMigration(
  id: string,
  requirements: {
    readonly requiresLegacyHomeMigration?: boolean;
    readonly requiresPendingHomeMigration?: boolean;
  } = {},
) {
  return {
    commandArgs: [id],
    description: [`Run ${id}.`],
    id,
    instructions: [`Finished ${id}.`],
    introducedIn: RELEASE_VERSION,
    ...requirements,
    title: id,
  };
}

function writePostUpdateFixture(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  migrations: readonly ReturnType<typeof fixtureMigration>[],
) {
  const configRoot = path.join(root, 'config');
  return fs
    .makeDirectory(configRoot, {recursive: true})
    .pipe(
      Effect.andThen(
        fs.writeFileString(
          path.join(configRoot, 'post-update-migrations.json'),
          `${JSON.stringify({migrations, version: 1}, undefined, 2)}\n`,
        ),
      ),
    );
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
      const manifest = JSON.parse(await Bun.file('assets/code-graph/manifest.json').text()) as {
        readonly grammars: Readonly<
          Record<
            string,
            {
              readonly builderLicense?: string;
              readonly license: string;
              readonly licensePackagePath?: string;
              readonly packagePath?: string;
              readonly path: string;
            }
          >
        >;
      };
      const grammarMetadata = Object.values(manifest.grammars);
      const assetPaths = [
        'manifest.json',
        'runtime/web-tree-sitter.wasm',
        'licenses/web-tree-sitter.LICENSE',
        ...grammarMetadata.map(asset => asset.path),
        ...grammarMetadata.map(asset => asset.license),
        ...grammarMetadata.flatMap(asset => (asset.builderLicense ? [asset.builderLicense] : [])),
      ].filter((value, index, values) => values.indexOf(value) === index);
      const assets = Object.fromEntries(
        await Promise.all(
          assetPaths.map(async asset => [
            `assets/code-graph/${asset}`,
            await codeGraphFixtureAsset(asset, grammarMetadata),
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

async function codeGraphFixtureAsset(
  asset: string,
  grammars: readonly {
    readonly license: string;
    readonly licensePackagePath?: string;
    readonly packagePath?: string;
    readonly path: string;
  }[],
): Promise<Uint8Array> {
  const bundled = Bun.file(`assets/code-graph/${asset}`);
  if (await bundled.exists()) return bundled.bytes();
  const grammar = grammars.find(value => value.path === asset);
  if (grammar?.packagePath) return Bun.file(grammar.packagePath).bytes();
  const license = grammars.find(value => value.license === asset);
  if (license?.licensePackagePath) return Bun.file(license.licensePackagePath).bytes();
  throw new Error(`Missing code graph fixture asset: ${asset}`);
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}
