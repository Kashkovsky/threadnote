import fc from 'fast-check';
import {Effect, FileSystem, Option, Path} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  DEVELOPMENT_INSTALL_RECEIPT_VERSION,
  developmentBuildVersion,
  developmentVersionSourceCommit,
  isDevelopmentBuildVersion,
  parseDevelopmentInstallReceipt,
  readDevelopmentReleaseEvidence,
  readManagedDevelopmentRuntimeEvidence,
  stageAndValidateDevelopmentRelease,
  verifyManagedDevelopmentRuntimeForSource,
  type DevelopmentInstallReceiptV1,
} from '../../scripts/development-runtime.js';
import {
  activateLocalStandaloneRelease,
  parseLocalStandaloneInstallArguments,
} from '../../scripts/install-local-standalone.js';
import {commandLauncherPath, renderCommandShim} from '../../src/command-shim.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {sha256FileHex} from '../../src/effect/digest.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';

const sourceCommitArbitrary = fc
  .array(fc.constantFrom(...'0123456789abcdef'), {maxLength: 40, minLength: 40})
  .map(characters => characters.join(''));

describe('exact-head development runtime', () => {
  it('parses only the explicit developer installer switches', () => {
    expect(parseLocalStandaloneInstallArguments(['--', '--terminate-superseded', '--json'])).toEqual({
      json: true,
      terminateSuperseded: true,
    });
    expect(() => parseLocalStandaloneInstallArguments(['--force'])).toThrow('Unknown local standalone install option');
  });

  it('derives an unambiguous SHA-bound development version for valid release versions', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.nat({max: 999}),
          fc.nat({max: 999}),
          fc.nat({max: 999}),
          fc.option(fc.constantFrom('alpha', 'beta.30', 'rc.1', 'preview-dev.7'), {nil: undefined}),
        ),
        sourceCommitArbitrary,
        ([major, minor, patch, prerelease], sourceCommit) => {
          const base = `${major}.${minor}.${patch}${prerelease === undefined ? '' : `-${prerelease}`}`;
          const version = developmentBuildVersion(base, sourceCommit);

          expect(isDevelopmentBuildVersion(version)).toBe(true);
          expect(Option.getOrUndefined(developmentVersionSourceCommit(version))).toBe(sourceCommit);
          expect(version).toContain(`${prerelease === undefined ? '-' : '.'}local.g${sourceCommit}`);
        },
      ),
      {numRuns: 200},
    );
  });

  it('rejects malformed or dirty provenance receipts', () => {
    const sourceCommit = 'a'.repeat(40);
    const receipt = validReceipt(developmentBuildVersion('4.0.0-beta.30', sourceCommit), sourceCommit);

    expect(Option.isSome(parseDevelopmentInstallReceipt(receipt))).toBe(true);
    expect(Option.isNone(parseDevelopmentInstallReceipt({...receipt, sourceDirty: true}))).toBe(true);
    expect(Option.isNone(parseDevelopmentInstallReceipt({...receipt, executableSha256: 'not-a-digest'}))).toBe(true);
    expect(Option.isNone(parseDevelopmentInstallReceipt({...receipt, sourceCommit: 'short'}))).toBe(true);
  });

  it('validates a managed release without exposing local paths', async () => {
    const evidence = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-runtime-'});
          const sourceCommit = 'b'.repeat(40);
          const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
          const installRoot = path.join(root, 'install');
          const releaseRoot = path.join(installRoot, 'versions', version);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* fs.makeDirectory(releaseRoot, {recursive: true});
          yield* fs.writeFileString(path.join(releaseRoot, executableName), 'exact executable bytes\n');
          const metadata = {
            executable: executableName,
            runtime: 'bun-test',
            target: 'test-target',
            version,
          };
          yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), `${JSON.stringify(metadata)}\n`);
          const receipt = validReceipt(version, sourceCommit, {
            executableSha256: yield* sha256FileHex(path.join(releaseRoot, executableName)),
            releaseMetadataSha256: yield* sha256FileHex(path.join(releaseRoot, 'release.json')),
          });
          yield* fs.writeFileString(path.join(releaseRoot, 'development-install.json'), `${JSON.stringify(receipt)}\n`);
          yield* fs.writeFileString(
            path.join(installRoot, 'active-release.json'),
            `${JSON.stringify({releaseRoot, version})}\n`,
          );
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: installRoot}),
          });
          const commandExecutor = versionCommandExecutor(version);

          return yield* verifyManagedDevelopmentRuntimeForSource(sourceCommit).pipe(
            Effect.provideService(CommandExecutor, commandExecutor),
            Effect.provideService(SystemInfo, testSystem),
          );
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(evidence).toMatchObject({
      runtime: 'bun-test',
      sourceCommit: 'b'.repeat(40),
      target: 'test-target',
    });
    expect(Object.keys(evidence)).not.toContain('releaseRoot');
    expect(Object.keys(evidence)).not.toContain('executable');
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked managed release directory', async () => {
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-release-link-'});
          const sourceCommit = 'd'.repeat(40);
          const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
          const installRoot = path.join(root, 'install');
          const logicalReleaseRoot = path.join(installRoot, 'versions', version);
          const outsideReleaseRoot = path.join(root, 'outside-release');
          yield* fs.makeDirectory(path.dirname(logicalReleaseRoot), {recursive: true});
          yield* fs.makeDirectory(outsideReleaseRoot);
          yield* fs.symlink(outsideReleaseRoot, logicalReleaseRoot);
          yield* fs.writeFileString(
            path.join(installRoot, 'active-release.json'),
            `${JSON.stringify({releaseRoot: logicalReleaseRoot, version})}\n`,
          );
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: installRoot}),
          });

          return yield* readManagedDevelopmentRuntimeEvidence(sourceCommit).pipe(
            Effect.provideService(CommandExecutor, versionCommandExecutor(version)),
            Effect.provideService(SystemInfo, testSystem),
            Effect.flip,
          );
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(String(failure)).toContain('not a canonical release directory');
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked managed versions directory', async () => {
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-versions-link-'});
          const sourceCommit = 'e'.repeat(40);
          const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
          const installRoot = path.join(root, 'install');
          const logicalVersionsRoot = path.join(installRoot, 'versions');
          const outsideVersionsRoot = path.join(root, 'outside-versions');
          const logicalReleaseRoot = path.join(logicalVersionsRoot, version);
          yield* fs.makeDirectory(installRoot, {recursive: true});
          yield* fs.makeDirectory(path.join(outsideVersionsRoot, version), {recursive: true});
          yield* fs.symlink(outsideVersionsRoot, logicalVersionsRoot);
          yield* fs.writeFileString(
            path.join(installRoot, 'active-release.json'),
            `${JSON.stringify({releaseRoot: logicalReleaseRoot, version})}\n`,
          );
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: installRoot}),
          });

          return yield* readManagedDevelopmentRuntimeEvidence(sourceCommit).pipe(
            Effect.provideService(CommandExecutor, versionCommandExecutor(version)),
            Effect.provideService(SystemInfo, testSystem),
            Effect.flip,
          );
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(String(failure)).toContain('versions directory is not canonical');
  });

  it('binds managed provenance to the active pointer version', async () => {
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-version-binding-'});
          const sourceCommit = '1'.repeat(40);
          const pointerVersion = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
          const releaseVersion = developmentBuildVersion('4.0.1-beta.1', sourceCommit);
          const installRoot = path.join(root, 'install');
          const releaseRoot = path.join(installRoot, 'versions', pointerVersion);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeDevelopmentReleaseFixture(
            fs,
            path,
            releaseRoot,
            releaseVersion,
            sourceCommit,
            executableName,
            'mismatched-version',
          );
          yield* fs.writeFileString(
            path.join(installRoot, 'active-release.json'),
            `${JSON.stringify({releaseRoot, version: pointerVersion})}\n`,
          );
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: installRoot}),
          });

          return yield* readManagedDevelopmentRuntimeEvidence(sourceCommit).pipe(
            Effect.provideService(CommandExecutor, versionCommandExecutor(releaseVersion)),
            Effect.provideService(SystemInfo, testSystem),
            Effect.flip,
          );
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(String(failure)).toContain('pointer and release version do not match');
  });

  it('revalidates a reused release under the installation lock before writing launchers', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-reuse-race-'});
          const sourceCommit = 'f'.repeat(40);
          const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
          const installRoot = path.join(root, 'install');
          const binRoot = path.join(root, 'bin');
          const releaseRoot = path.join(installRoot, 'versions', version);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* fs.makeDirectory(releaseRoot, {recursive: true});
          yield* fs.writeFileString(path.join(releaseRoot, executableName), 'reusable executable bytes\n');
          yield* fs.writeFileString(
            path.join(releaseRoot, 'release.json'),
            `${JSON.stringify({executable: executableName, runtime: 'bun-test', target: 'test-target', version})}\n`,
          );
          yield* fs.writeFileString(
            path.join(releaseRoot, 'development-install.json'),
            `${JSON.stringify(
              validReceipt(version, sourceCommit, {
                executableSha256: yield* sha256FileHex(path.join(releaseRoot, executableName)),
                releaseMetadataSha256: yield* sha256FileHex(path.join(releaseRoot, 'release.json')),
              }),
            )}\n`,
          );
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
          });
          const commandExecutor = versionCommandExecutor(version);
          yield* readDevelopmentReleaseEvidence(releaseRoot, sourceCommit).pipe(
            Effect.provideService(CommandExecutor, commandExecutor),
            Effect.provideService(SystemInfo, testSystem),
          );
          // Models a concurrent prune after the optimistic reuse decision but
          // before this installer acquires the mutation lock.
          yield* fs.remove(releaseRoot, {force: true, recursive: true});
          const failure = yield* activateLocalStandaloneRelease({
            commit: sourceCommit,
            executableName,
            releaseRoot,
            reused: true,
            stagedRoot: Option.none(),
            terminateSuperseded: false,
            version,
          }).pipe(
            Effect.provideService(CommandExecutor, commandExecutor),
            Effect.provideService(SystemInfo, testSystem),
            Effect.flip,
          );
          return {
            activePointerExists: yield* fs.exists(path.join(installRoot, 'active-release.json')),
            binRootExists: yield* fs.exists(binRoot),
            failure: String(failure),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.failure).toContain('not reusable');
    expect(result.activePointerExists).toBe(false);
    expect(result.binRootExists).toBe(false);
  });

  it('reuses a valid same-version release that wins while another stage waits for the lock', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-concurrent-stage-'});
          const sourceCommit = '2'.repeat(40);
          const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
          const installRoot = path.join(root, 'install');
          const releaseRoot = path.join(installRoot, 'versions', version);
          const stagedRoot = path.join(installRoot, 'versions', `.${version}.fixture.staging`);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeDevelopmentReleaseFixture(
            fs,
            path,
            releaseRoot,
            version,
            sourceCommit,
            executableName,
            'concurrent-winner',
          );
          yield* writeDevelopmentReleaseFixture(
            fs,
            path,
            stagedRoot,
            version,
            sourceCommit,
            executableName,
            'waiting-stage',
          );
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: path.join(root, 'bin'),
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
          });
          const installed = yield* activateLocalStandaloneRelease({
            commit: sourceCommit,
            executableName,
            releaseRoot,
            reused: false,
            stagedRoot: Option.some(stagedRoot),
            terminateSuperseded: false,
            version,
          }).pipe(
            Effect.provideService(CommandExecutor, versionCommandExecutor(version)),
            Effect.provideService(SystemInfo, testSystem),
          );
          return {
            installed,
            releaseBytes: yield* fs.readFileString(path.join(releaseRoot, executableName)),
            stagedExists: yield* fs.exists(stagedRoot),
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.installed.reused).toBe(true);
    expect(result.releaseBytes).toBe('concurrent-winner\n');
    expect(result.stagedExists).toBe(false);
  });

  it('restores the prior active pointer and launchers when launcher verification fails', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-rollback-'});
          const sourceCommit = '3'.repeat(40);
          const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
          const installRoot = path.join(root, 'install');
          const binRoot = path.join(root, 'bin');
          const releaseRoot = path.join(installRoot, 'versions', version);
          const priorVersion = '4.0.0-beta.29';
          const priorReleaseRoot = path.join(installRoot, 'versions', priorVersion);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* writeDevelopmentReleaseFixture(
            fs,
            path,
            releaseRoot,
            version,
            sourceCommit,
            executableName,
            'new-release',
          );
          yield* fs.makeDirectory(priorReleaseRoot, {recursive: true});
          const priorPointer = `${JSON.stringify({releaseRoot: priorReleaseRoot, version: priorVersion})}\n`;
          yield* fs.writeFileString(path.join(installRoot, 'active-release.json'), priorPointer);
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({
              ...baseSystem.environment(),
              THREADNOTE_BIN_DIR: binRoot,
              THREADNOTE_INSTALL_ROOT: installRoot,
            }),
          });
          const setup = Effect.gen(function* () {
            const cliLauncher = yield* commandLauncherPath('cli');
            const mcpLauncher = yield* commandLauncherPath('mcp');
            const priorCli = yield* renderCommandShim(priorReleaseRoot, 'cli');
            yield* fs.makeDirectory(binRoot, {recursive: true});
            yield* fs.writeFileString(cliLauncher, priorCli, {mode: 0o755});
            yield* fs.writeFileString(mcpLauncher, 'unmanaged launcher\n', {mode: 0o755});
            return {cliLauncher, mcpLauncher, priorCli};
          }).pipe(Effect.provideService(SystemInfo, testSystem));
          const launchers = yield* setup;
          const failure = yield* activateLocalStandaloneRelease({
            commit: sourceCommit,
            executableName,
            releaseRoot,
            reused: true,
            stagedRoot: Option.none(),
            terminateSuperseded: false,
            version,
          }).pipe(
            Effect.provideService(CommandExecutor, versionCommandExecutor(version)),
            Effect.provideService(SystemInfo, testSystem),
            Effect.flip,
          );
          return {
            activePointer: yield* fs.readFileString(path.join(installRoot, 'active-release.json')),
            cli: yield* fs.readFileString(launchers.cliLauncher),
            failure: String(failure),
            mcp: yield* fs.readFileString(launchers.mcpLauncher),
            priorCli: launchers.priorCli,
            priorPointer,
          };
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.failure).toContain('managed mcp launcher did not activate');
    expect(result.activePointer).toBe(result.priorPointer);
    expect(result.cli).toBe(result.priorCli);
    expect(result.mcp).toBe('unmanaged launcher\n');
  });

  it('removes a disposable staging directory when pre-activation validation fails', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseSystem = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-stage-'});
          const sourceCommit = 'c'.repeat(40);
          const version = developmentBuildVersion('4.0.0-beta.30', sourceCommit);
          const distributionRoot = path.join(root, 'dist');
          const stagedRoot = path.join(root, 'versions', `.${version}.fixture.staging`);
          const executableName = baseSystem.platform === 'win32' ? 'threadnote.exe' : 'threadnote';
          yield* fs.makeDirectory(distributionRoot, {recursive: true});
          yield* fs.writeFileString(path.join(distributionRoot, executableName), 'built executable bytes\n');
          yield* fs.writeFileString(
            path.join(distributionRoot, 'release.json'),
            `${JSON.stringify({executable: executableName, runtime: 'bun-test', target: 'test-target', version})}\n`,
          );
          const receipt = validReceipt(version, sourceCommit, {
            // A syntactically valid but intentionally wrong digest forces the
            // validation failure after the stage has been copied and written.
            executableSha256: '0'.repeat(64),
            releaseMetadataSha256: yield* sha256FileHex(path.join(distributionRoot, 'release.json')),
          });
          const testSystem = SystemInfo.of({
            ...baseSystem,
            environment: () => ({...baseSystem.environment(), THREADNOTE_INSTALL_ROOT: path.join(root, 'install')}),
          });

          const failure = yield* stageAndValidateDevelopmentRelease({
            distributionRoot,
            executableName,
            expectedSourceCommit: sourceCommit,
            receipt,
            stagedRoot,
          }).pipe(
            Effect.provideService(CommandExecutor, versionCommandExecutor(version)),
            Effect.provideService(SystemInfo, testSystem),
            Effect.flip,
          );
          return {failure: String(failure), stagedExists: yield* fs.exists(stagedRoot)};
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(result.failure).toContain('failed validation before activation');
    expect(result.stagedExists).toBe(false);
  });
});

function validReceipt(
  version: string,
  sourceCommit: string,
  overrides: Partial<DevelopmentInstallReceiptV1> = {},
): DevelopmentInstallReceiptV1 {
  return {
    builtAt: '2026-08-02T08:00:00.000Z',
    executableSha256: '1'.repeat(64),
    releaseMetadataSha256: '2'.repeat(64),
    runtime: 'bun-test',
    schemaVersion: DEVELOPMENT_INSTALL_RECEIPT_VERSION,
    sourceCommit,
    sourceDirty: false,
    target: 'test-target',
    version,
    ...overrides,
  };
}

function versionCommandExecutor(version: string) {
  return CommandExecutor.of({
    execute: (_executable, arguments_) =>
      Effect.succeed({
        exitCode: 0,
        stderr: '',
        stdout:
          arguments_[0] === 'doctor'
            ? 'Running Threadnote doctor checks.\nSummary: all checks complete.\n'
            : `threadnote v${version}\n`,
      }),
    executeStreaming: () => Effect.die(new Error('Unexpected streaming command')),
  });
}

function writeDevelopmentReleaseFixture(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  releaseRoot: string,
  version: string,
  sourceCommit: string,
  executableName: string,
  executableMarker: string,
) {
  return Effect.gen(function* () {
    yield* fs.makeDirectory(releaseRoot, {recursive: true});
    yield* fs.writeFileString(path.join(releaseRoot, executableName), `${executableMarker}\n`);
    yield* fs.writeFileString(
      path.join(releaseRoot, 'release.json'),
      `${JSON.stringify({executable: executableName, runtime: 'bun-test', target: 'test-target', version})}\n`,
    );
    yield* fs.writeFileString(
      path.join(releaseRoot, 'development-install.json'),
      `${JSON.stringify(
        validReceipt(version, sourceCommit, {
          executableSha256: yield* sha256FileHex(path.join(releaseRoot, executableName)),
          releaseMetadataSha256: yield* sha256FileHex(path.join(releaseRoot, 'release.json')),
        }),
      )}\n`,
    );
  });
}
